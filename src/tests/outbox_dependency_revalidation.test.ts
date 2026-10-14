import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { initializeCanonicalSyncState } from './utils/testSetup';
import {
  SyncEngine,
  ServerSyncTransport,
  MockServerSyncTransport,
  SyncCommandRequest,
  SyncCommandResponse,
  SyncPullResponse,
  OutboxScheduler,
} from '../infrastructure/sync/syncEngine';

describe('Outbox Dependency Revalidation & Automated Unblocking (Phase 2)', () => {
  beforeEach(async () => {
    await localDb.clear();
    await initializeCanonicalSyncState();
  });

  // Test A — Basic cold-start rehydration
  it('Test A — Basic cold-start rehydration: Parent and child commands survive restart and maintain dependency links', async () => {
    const transport1 = new SyncEngine(new MockServerSyncTransport());
    await transport1.queueCommand('cmd_p1', 'CREATE_ORDER', 'orders', 'ord_1', { customerId: 'cust_1' }, 'dev_1', 'admin_1');
    await transport1.queueCommand('cmd_c1', 'ADD_ORDER_ITEM', 'order_items', 'item_1', { orderId: 'ord_1' }, 'dev_1', 'admin_1', undefined, {
      dependencyCommandId: 'cmd_p1',
    });

    // Simulate complete application restart / re-initialization
    const transport2 = new SyncEngine(new MockServerSyncTransport());
    const outboxItems = await localDb.listOutbox();
    expect(outboxItems).toHaveLength(2);

    const scheduler = new OutboxScheduler();
    const result = await scheduler.schedule(outboxItems, outboxItems, async (id) => localDb.getHistoryByCommandId(id));

    expect(result.ready.map((r) => r.commandId)).toEqual(['cmd_p1']);
    expect(result.blocked.has('cmd_c1')).toBe(true);
  });

  // Test B — Parent succeeds after restart
  it('Test B — Parent succeeds after restart: Child automatically unblocks and executes when parent succeeds', async () => {
    const executed: string[] = [];
    const transport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        executed.push(req.commandId);
        return { success: true, serverVersion: 1, rpcReached: true };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({ changes: [], latestSequence: cursor, serverResetGeneration: 1 }),
    };

    const engine1 = new SyncEngine(transport);
    await engine1.queueCommand('cmd_parent', 'CREATE_ORDER', 'orders', 'ord_1', {}, 'dev_1', 'admin_1');
    await engine1.queueCommand('cmd_child', 'ADD_ORDER_ITEM', 'order_items', 'item_1', { orderId: 'ord_1' }, 'dev_1', 'admin_1', undefined, {
      dependencyCommandId: 'cmd_parent',
    });

    // Simulate restart
    const engine2 = new SyncEngine(transport);
    await engine2.resumePendingOutbox();
    const syncRes = await engine2.synchronize();

    expect(syncRes.pushed).toBe(2);
    expect(executed).toEqual(['cmd_parent', 'cmd_child']);

    const hParent = await localDb.getHistoryByCommandId('cmd_parent');
    const hChild = await localDb.getHistoryByCommandId('cmd_child');
    expect(hParent?.state).toBe('SUCCESS');
    expect(hChild?.state).toBe('SUCCESS');
  });

  // Test C — Retryable parent failure
  it('Test C — Retryable parent failure: Child remains blocked until parent successfully retries', async () => {
    let parentAttempts = 0;
    const executed: string[] = [];

    const transport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        if (req.commandId === 'cmd_parent' && parentAttempts === 0) {
          parentAttempts++;
          return { success: false, error: 'Temporary network failure', errorClass: 'NETWORK', httpStatus: 503, rpcReached: true };
        }
        executed.push(req.commandId);
        return { success: true, serverVersion: 1, rpcReached: true };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({ changes: [], latestSequence: cursor, serverResetGeneration: 1 }),
    };

    const engine1 = new SyncEngine(transport);
    await engine1.queueCommand('cmd_parent', 'CREATE_ORDER', 'orders', 'ord_1', {}, 'dev_1', 'admin_1');
    await engine1.queueCommand('cmd_child', 'ADD_ORDER_ITEM', 'order_items', 'item_1', { orderId: 'ord_1' }, 'dev_1', 'admin_1', undefined, {
      dependencyCommandId: 'cmd_parent',
    });

    // First sync attempt: parent fails retryable, child should not execute
    let syncRes = await engine1.synchronize();
    expect(syncRes.pushed).toBe(0);
    expect(executed).toEqual([]);

    // Simulate restart
    const engine2 = new SyncEngine(transport);
    await engine2.resumePendingOutbox();
    syncRes = await engine2.synchronize();

    expect(syncRes.pushed).toBe(2);
    expect(executed).toEqual(['cmd_parent', 'cmd_child']);
  });

  // Test D — Permanent parent failure
  it('Test D — Permanent parent failure: Child remains blocked when parent fails permanently', async () => {
    const executed: string[] = [];
    const transport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        if (req.commandId === 'cmd_parent') {
          return { success: false, error: 'Validation failed', code: 'VALIDATION_ERROR', errorClass: 'VALIDATION', httpStatus: 400, rpcReached: true };
        }
        executed.push(req.commandId);
        return { success: true, serverVersion: 1, rpcReached: true };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({ changes: [], latestSequence: cursor, serverResetGeneration: 1 }),
    };

    const engine1 = new SyncEngine(transport);
    await engine1.queueCommand('cmd_parent', 'CREATE_ORDER', 'orders', 'ord_1', {}, 'dev_1', 'admin_1');
    await engine1.queueCommand('cmd_child', 'ADD_ORDER_ITEM', 'order_items', 'item_1', { orderId: 'ord_1' }, 'dev_1', 'admin_1', undefined, {
      dependencyCommandId: 'cmd_parent',
    });

    await engine1.synchronize();

    // Simulate restart
    const engine2 = new SyncEngine(transport);
    await engine2.resumePendingOutbox();
    await engine2.synchronize();

    expect(executed).toEqual([]);
    const hParent = await localDb.getHistoryByCommandId('cmd_parent');
    const hChild = await localDb.getHistoryByCommandId('cmd_child');
    expect(hParent?.state).toBe('FAILED');
    expect(hChild?.state).not.toBe('SUCCESS');
  });

  // Test E — Conflict
  it('Test E — Conflict: Child remains blocked on conflict, executes after conflict is resolved', async () => {
    let hasConflict = true;
    const executed: string[] = [];

    const transport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        if (req.commandId === 'cmd_parent' && hasConflict) {
          return { success: false, error: 'Version Conflict', errorClass: 'CONFLICT', httpStatus: 409, rpcReached: true };
        }
        executed.push(req.commandId);
        return { success: true, serverVersion: 1, rpcReached: true };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({ changes: [], latestSequence: cursor, serverResetGeneration: 1 }),
    };

    const engine1 = new SyncEngine(transport);
    await engine1.queueCommand('cmd_parent', 'CREATE_ORDER', 'orders', 'ord_1', {}, 'dev_1', 'admin_1');
    await engine1.queueCommand('cmd_child', 'ADD_ORDER_ITEM', 'order_items', 'item_1', { orderId: 'ord_1' }, 'dev_1', 'admin_1', undefined, {
      dependencyCommandId: 'cmd_parent',
    });

    await engine1.synchronize();
    expect(executed).toEqual([]);

    // Resolve conflict by allowing success on retry
    hasConflict = false;
    const engine2 = new SyncEngine(transport);
    await engine2.resumePendingOutbox();
    await engine2.synchronize();

    expect(executed).toEqual(['cmd_parent', 'cmd_child']);
  });

  // Test F — Unrelated command isolation
  it('Test F — Unrelated command isolation: Independent command executes even if parent chain fails', async () => {
    const executed: string[] = [];
    const transport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        if (req.commandId === 'cmd_a') {
          return { success: false, error: 'Permanent error', code: 'VALIDATION_ERROR', errorClass: 'VALIDATION', httpStatus: 400, rpcReached: true };
        }
        executed.push(req.commandId);
        return { success: true, serverVersion: 1, rpcReached: true };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({ changes: [], latestSequence: cursor, serverResetGeneration: 1 }),
    };

    const engine = new SyncEngine(transport);
    await engine.queueCommand('cmd_a', 'CREATE_ORDER', 'orders', 'ord_1', {}, 'dev_1', 'admin_1');
    await engine.queueCommand('cmd_b', 'ADD_ORDER_ITEM', 'order_items', 'item_1', { orderId: 'ord_1' }, 'dev_1', 'admin_1', undefined, {
      dependencyCommandId: 'cmd_a',
    });
    await engine.queueCommand('cmd_c', 'CREATE_CUSTOMER', 'customers', 'cust_2', {}, 'dev_1', 'admin_1');

    await engine.synchronize();

    // A fails, B is blocked, C succeeds independently
    expect(executed).toEqual(['cmd_c']);
    const hA = await localDb.getHistoryByCommandId('cmd_a');
    const hB = await localDb.getHistoryByCommandId('cmd_b');
    const hC = await localDb.getHistoryByCommandId('cmd_c');

    expect(hA?.state).toBe('FAILED');
    expect(hB?.state).not.toBe('SUCCESS');
    expect(hC?.state).toBe('SUCCESS');
  });

  // Test G — Idempotent revalidation
  it('Test G — Idempotent revalidation: Running scheduler/revalidation multiple times produces identical results', async () => {
    const engine = new SyncEngine(new MockServerSyncTransport());
    await engine.queueCommand('cmd_p', 'CREATE_ORDER', 'orders', 'ord_1', {}, 'dev_1', 'admin_1');
    await engine.queueCommand('cmd_c', 'ADD_ORDER_ITEM', 'order_items', 'item_1', { orderId: 'ord_1' }, 'dev_1', 'admin_1', undefined, {
      dependencyCommandId: 'cmd_p',
    });

    const outbox = await localDb.listOutbox();
    const scheduler = new OutboxScheduler();

    const res1 = await scheduler.schedule(outbox, outbox, async (id) => localDb.getHistoryByCommandId(id));
    const res2 = await scheduler.schedule(outbox, outbox, async (id) => localDb.getHistoryByCommandId(id));

    expect(res1.ready.map(r => r.commandId)).toEqual(res2.ready.map(r => r.commandId));
    expect(Array.from(res1.blocked.keys())).toEqual(Array.from(res2.blocked.keys()));
  });

  // Test H — Realistic multi-level chain
  it('Test H — Realistic multi-level chain: CREATE_ORDER → ADD_ORDER_ITEM → CREATE_PAYMENT → PAYMENT_ALLOCATION', async () => {
    const executed: string[] = [];
    const transport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        executed.push(req.commandId);
        return { success: true, serverVersion: 1, rpcReached: true };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({ changes: [], latestSequence: cursor, serverResetGeneration: 1 }),
    };

    const engine = new SyncEngine(transport);
    await engine.queueCommand('cmd_1', 'CREATE_ORDER', 'orders', 'ord_1', {}, 'dev_1', 'admin_1');
    await engine.queueCommand('cmd_2', 'ADD_ORDER_ITEM', 'order_items', 'item_1', { orderId: 'ord_1' }, 'dev_1', 'admin_1', undefined, {
      dependencyCommandId: 'cmd_1',
    });
    await engine.queueCommand('cmd_3', 'CREATE_PAYMENT', 'payments', 'pay_1', { orderId: 'ord_1' }, 'dev_1', 'admin_1', undefined, {
      dependencyCommandId: 'cmd_2',
    });
    await engine.queueCommand('cmd_4', 'PAYMENT_ALLOCATION', 'payment_allocations', 'alloc_1', { paymentId: 'pay_1' }, 'dev_1', 'admin_1', undefined, {
      dependencyCommandId: 'cmd_3',
    });

    await engine.synchronize();
    expect(executed).toEqual(['cmd_1', 'cmd_2', 'cmd_3', 'cmd_4']);
  });

  it('does not block goal updates when the referenced goal already exists locally', async () => {
    const goalId = 'goal-existing-local';
    const engine = new SyncEngine(new MockServerSyncTransport());
    await localDb.set('goals', goalId, {
      id: goalId,
      customerId: 'customer-existing-local',
      status: 'ACTIVE',
      targetQuantity: 10,
      currentProgress: 1,
    });
    await engine.queueCommand(
      'cmd_goal_update_existing',
      'UPDATE_GOAL_PROGRESS',
      'goals',
      goalId,
      { goalId, customerId: 'customer-existing-local', progress: 2 },
      'dev_1',
      'admin_1',
    );

    const outbox = await localDb.listOutbox();
    const result = await new OutboxScheduler().schedule(
      outbox,
      outbox,
      async (id) => localDb.getHistoryByCommandId(id),
    );

    expect(result.ready.map((item) => item.commandId)).toContain('cmd_goal_update_existing');
    expect(result.blocked.has('cmd_goal_update_existing')).toBe(false);
  });

  it('does not block goal-request decisions when the referenced request exists locally', async () => {
    const requestId = 'goal-request-existing-local';
    const engine = new SyncEngine(new MockServerSyncTransport());
    await localDb.set('goalRequests', requestId, {
      id: requestId,
      customerId: 'customer-existing-local',
      status: 'PENDING',
    });
    await engine.queueCommand(
      'cmd_approve_existing_request',
      'APPROVE_GOAL_REQUEST',
      'goal_requests',
      requestId,
      { requestId, customerId: 'customer-existing-local' },
      'dev_1',
      'admin_1',
    );

    const outbox = await localDb.listOutbox();
    const result = await new OutboxScheduler().schedule(
      outbox,
      outbox,
      async (id) => localDb.getHistoryByCommandId(id),
    );

    expect(result.ready.map((item) => item.commandId)).toContain('cmd_approve_existing_request');
    expect(result.blocked.has('cmd_approve_existing_request')).toBe(false);
  });

  // Test I — Offline/Online transition
  it('Test I — Offline/Online transition: Multiple transitions maintain strict dependency ordering without duplication', async () => {
    const executed: string[] = [];
    let isOnline = false;

    const transport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        if (!isOnline) {
          return { success: false, error: 'Offline network error', errorClass: 'NETWORK', httpStatus: 503, rpcReached: false };
        }
        executed.push(req.commandId);
        return { success: true, serverVersion: 1, rpcReached: true };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({ changes: [], latestSequence: cursor, serverResetGeneration: 1 }),
    };

    const engine = new SyncEngine(transport);
    await engine.queueCommand('cmd_x1', 'CREATE_ORDER', 'orders', 'ord_x', {}, 'dev_1', 'admin_1');
    await engine.queueCommand('cmd_x2', 'ADD_ORDER_ITEM', 'order_items', 'item_x', { orderId: 'ord_x' }, 'dev_1', 'admin_1', undefined, {
      dependencyCommandId: 'cmd_x1',
    });

    // 1. Attempt while offline
    isOnline = false;
    await engine.synchronize();
    expect(executed).toEqual([]);

    // 2. Go online
    isOnline = true;
    await engine.synchronize();
    expect(executed).toEqual(['cmd_x1', 'cmd_x2']);

    // 3. Go offline again, queue more
    isOnline = false;
    await engine.queueCommand('cmd_x3', 'CREATE_PAYMENT', 'payments', 'pay_x', {}, 'dev_1', 'admin_1', undefined, {
      dependencyCommandId: 'cmd_x2',
    });
    await engine.synchronize();

    // 4. Go online again
    isOnline = true;
    const engine3 = new SyncEngine(transport);
    await engine3.resumePendingOutbox();
    await engine3.synchronize();

    expect(executed).toEqual(['cmd_x1', 'cmd_x2', 'cmd_x3']);
  });
  it('does not block day renumbering on unrelated commands that share the day aggregate', async () => {
    const dayId = 'day-renumber-existing';
    const engine = new SyncEngine(new MockServerSyncTransport());

    await localDb.set('businessDays', dayId, {
      id: dayId,
      date: '2026-10-14',
      status: 'OPEN',
    });

    // A pending CLOSE_DAY mutates the day but is not a prerequisite for
    // renumbering an already-existing day.
    await engine.queueCommand(
      'cmd_close_day_pending',
      'CLOSE_DAY',
      'business_days',
      dayId,
      { id: dayId, dayId },
      'dev_1',
      'admin_1',
    );
    await engine.queueCommand(
      'cmd_renumber_existing_day',
      'RENUMBER_DAY_ORDERS',
      'orders',
      dayId,
      { id: dayId, dayId, changes: [{ id: 'order-1', oldNumber: 2, newNumber: 1 }] },
      'dev_1',
      'admin_1',
    );

    const outbox = await localDb.listOutbox();
    const result = await new OutboxScheduler().schedule(
      outbox,
      outbox,
      async (id) => localDb.getHistoryByCommandId(id),
    );

    expect(result.ready.map((item) => item.commandId)).toContain('cmd_renumber_existing_day');
    expect(result.blocked.has('cmd_renumber_existing_day')).toBe(false);
  });

  it('still blocks day renumbering behind a pending OPEN_DAY creator command', async () => {
    const dayId = 'day-renumber-not-yet-created';
    const engine = new SyncEngine(new MockServerSyncTransport());

    await engine.queueCommand(
      'cmd_open_day_pending',
      'OPEN_DAY',
      'business_days',
      dayId,
      { id: dayId, dayId },
      'dev_1',
      'admin_1',
    );
    await engine.queueCommand(
      'cmd_renumber_waits_for_open',
      'RENUMBER_DAY_ORDERS',
      'orders',
      dayId,
      { id: dayId, dayId, changes: [{ id: 'order-1', oldNumber: 2, newNumber: 1 }] },
      'dev_1',
      'admin_1',
    );

    const outbox = await localDb.listOutbox();
    const result = await new OutboxScheduler().schedule(
      outbox,
      outbox,
      async (id) => localDb.getHistoryByCommandId(id),
    );

    expect(result.blocked.get('cmd_renumber_waits_for_open')?.unsatisfiedDependencies).toContain('cmd_open_day_pending');
  });

  it('does not treat failed historical renumbering as a missing day-creation dependency', async () => {
    const dayId = 'day-renumber-existing';
    const engine = new SyncEngine(new MockServerSyncTransport());

    await localDb.set('businessDays', dayId, {
      id: dayId,
      date: '2026-10-14',
      status: 'OPEN',
    });
    await localDb.saveHistory({
      historyId: 'history_old_renumber',
      commandId: 'cmd_old_renumber_failed',
      commandType: 'RENUMBER_DAY_ORDERS',
      entityType: 'orders',
      entityId: dayId,
      state: 'FAILED_PERMANENT',
      createdAt: '2026-10-14T09:52:43.660Z',
      updatedAt: '2026-10-14T09:52:44.229Z',
      attemptCount: 1,
      errorClass: 'UNKNOWN',
      errorMessage: 'Unknown Canonical Command Type: RENUMBER_DAY_ORDERS',
      failureStage: 'RPC',
      rpcReached: true,
      retryEligible: false,
    });

    await engine.queueCommand(
      'cmd_new_renumber_after_server_fix',
      'RENUMBER_DAY_ORDERS',
      'orders',
      dayId,
      { id: dayId, dayId, changes: [{ id: 'order-1', oldNumber: 2, newNumber: 1 }] },
      'dev_1',
      'admin_1',
    );

    const outbox = await localDb.listOutbox();
    const result = await new OutboxScheduler().schedule(
      outbox,
      outbox,
      async (id) => localDb.getHistoryByCommandId(id),
    );

    expect(result.ready.map((item) => item.commandId)).toContain('cmd_new_renumber_after_server_fix');
    expect(result.blocked.has('cmd_new_renumber_after_server_fix')).toBe(false);
  });

});
