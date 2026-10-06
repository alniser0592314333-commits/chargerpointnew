import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  SyncEngine,
  ServerSyncTransport,
  SyncCommandRequest,
  SyncCommandResponse,
  SyncPullResponse,
  syncEventEmitter,
  SyncEvent,
  extractCommandDependencies,
  detectCycles,
  sortReadyCommands,
} from '../infrastructure/sync/syncEngine';
import { initializeCanonicalSyncState } from './utils/testSetup';

describe('Phase B.3: Real Dependency-Aware Outbox Scheduler + BLOCKED -> READY', () => {
  beforeEach(async () => {
    await localDb.clear();
    await initializeCanonicalSyncState();
  });

  // TEST 1 — DEPENDENCY ORDER
  it('TEST 1 — DEPENDENCY ORDER: Prerequisite executes before dependent command regardless of queuing order', async () => {
    const executedOrder: string[] = [];

    const transport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        executedOrder.push(req.commandId);
        return { success: true, serverVersion: 1, rpcReached: true };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({
        changes: [],
        latestSequence: cursor,
        serverResetGeneration: 1,
      }),
    };

    const engine = new SyncEngine(transport);

    // Queue dependent command FIRST
    await engine.queueCommand(
      'cmd_order_1',
      'CREATE_ORDER',
      'orders',
      'ord_1',
      { customerId: 'cust_1' },
      'dev_1',
      'admin_1',
      undefined,
      { dependencyCommandId: 'cmd_cust_1' }
    );

    // Queue prerequisite command SECOND
    await engine.queueCommand(
      'cmd_cust_1',
      'CREATE_CUSTOMER',
      'customers',
      'cust_1',
      { name: 'John Doe' },
      'dev_1',
      'admin_1'
    );

    const result = await engine.synchronize();
    expect(result.pushed).toBe(2);

    // Prerequisite cmd_cust_1 MUST execute before dependent cmd_order_1
    expect(executedOrder).toEqual(['cmd_cust_1', 'cmd_order_1']);

    const historyCust = await localDb.getHistoryByCommandId('cmd_cust_1');
    const historyOrder = await localDb.getHistoryByCommandId('cmd_order_1');
    expect(historyCust?.state).toBe('SUCCESS');
    expect(historyOrder?.state).toBe('SUCCESS');
  });

  // TEST 2 — DEPENDENCY ORDER OVERRIDES PRIORITY
  it('TEST 2 — DEPENDENCY ORDER OVERRIDES PRIORITY: Low-priority prerequisite executes before high-priority dependent', async () => {
    const executedOrder: string[] = [];

    const transport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        executedOrder.push(req.commandId);
        return { success: true, serverVersion: 1, rpcReached: true };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({
        changes: [],
        latestSequence: cursor,
        serverResetGeneration: 1,
      }),
    };

    const engine = new SyncEngine(transport);

    // Dependent command has VERY HIGH priority (100), but depends on cmd_prereq
    await engine.queueCommand(
      'cmd_high_priority_dependent',
      'CREATE_ORDER',
      'orders',
      'ord_99',
      { total: 500 },
      'dev_1',
      'admin_1',
      undefined,
      { priority: 100, dependencyCommandId: 'cmd_low_priority_prereq' }
    );

    // Prerequisite command has LOW priority (1)
    await engine.queueCommand(
      'cmd_low_priority_prereq',
      'CREATE_DAY',
      'business_days',
      'day_1',
      { date: '2026-10-01' },
      'dev_1',
      'admin_1',
      undefined,
      { priority: 1 }
    );

    await engine.synchronize();

    // Invariant: DEPENDENCY ORDER OVERRIDES PRIORITY
    expect(executedOrder).toEqual(['cmd_low_priority_prereq', 'cmd_high_priority_dependent']);
  });

  // TEST 3 — PRIORITY AMONG READY COMMANDS
  it('TEST 3 — PRIORITY AMONG READY COMMANDS: Ready commands execute in order of priority descending, then FIFO', async () => {
    const executedOrder: string[] = [];

    const transport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        executedOrder.push(req.commandId);
        return { success: true, serverVersion: 1, rpcReached: true };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({
        changes: [],
        latestSequence: cursor,
        serverResetGeneration: 1,
      }),
    };

    const engine = new SyncEngine(transport);

    // Queue 4 independent, ready commands with different priorities
    await engine.queueCommand('cmd_pri_5_first', 'TEST', 'test', 't1', {}, 'dev_1', 'admin_1', undefined, { priority: 5 });
    await engine.queueCommand('cmd_pri_20', 'TEST', 'test', 't2', {}, 'dev_1', 'admin_1', undefined, { priority: 20 });
    await engine.queueCommand('cmd_pri_10', 'TEST', 'test', 't3', {}, 'dev_1', 'admin_1', undefined, { priority: 10 });
    await engine.queueCommand('cmd_pri_5_second', 'TEST', 'test', 't4', {}, 'dev_1', 'admin_1', undefined, { priority: 5 });

    await engine.synchronize();

    // Expected order: 20 -> 10 -> 5 (first) -> 5 (second)
    expect(executedOrder).toEqual([
      'cmd_pri_20',
      'cmd_pri_10',
      'cmd_pri_5_first',
      'cmd_pri_5_second',
    ]);
  });

  // TEST 4 — MULTI-DEPENDENCY (JOIN)
  it('TEST 4 — MULTI-DEPENDENCY: Command with multiple prerequisites waits until ALL prerequisites succeed', async () => {
    const executedOrder: string[] = [];

    const transport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        executedOrder.push(req.commandId);
        return { success: true, serverVersion: 1, rpcReached: true };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({
        changes: [],
        latestSequence: cursor,
        serverResetGeneration: 1,
      }),
    };

    const engine = new SyncEngine(transport);

    // cmd_order depends on BOTH cmd_day AND cmd_cust
    await engine.queueCommand(
      'cmd_order',
      'CREATE_ORDER',
      'orders',
      'ord_join',
      { dayId: 'day_1', customerId: 'cust_1' },
      'dev_1',
      'admin_1',
      undefined,
      { dependencies: ['cmd_day', 'cmd_cust'] }
    );

    await engine.queueCommand('cmd_day', 'CREATE_DAY', 'business_days', 'day_1', {}, 'dev_1', 'admin_1', undefined, { priority: 2 });
    await engine.queueCommand('cmd_cust', 'CREATE_CUSTOMER', 'customers', 'cust_1', {}, 'dev_1', 'admin_1', undefined, { priority: 10 });

    await engine.synchronize();

    // Both prerequisites must execute before cmd_order
    expect(executedOrder.indexOf('cmd_day')).toBeLessThan(executedOrder.indexOf('cmd_order'));
    expect(executedOrder.indexOf('cmd_cust')).toBeLessThan(executedOrder.indexOf('cmd_order'));
    expect(executedOrder[2]).toBe('cmd_order');
  });

  // TEST 5 — DEEP DEPENDENCY CHAIN
  it('TEST 5 — DEEP DEPENDENCY CHAIN: Chain of 4 commands executes in strict topological order', async () => {
    const executedOrder: string[] = [];

    const transport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        executedOrder.push(req.commandId);
        return { success: true, serverVersion: 1, rpcReached: true };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({
        changes: [],
        latestSequence: cursor,
        serverResetGeneration: 1,
      }),
    };

    const engine = new SyncEngine(transport);

    // Queue in reverse order: D -> C -> B -> A
    await engine.queueCommand('cmd_D', 'ADD_ORDER_ITEM', 'order_items', 'it_1', {}, 'dev_1', 'admin_1', undefined, {
      dependencyCommandId: 'cmd_C',
    });
    await engine.queueCommand('cmd_C', 'CREATE_ORDER', 'orders', 'ord_1', {}, 'dev_1', 'admin_1', undefined, {
      dependencyCommandId: 'cmd_B',
    });
    await engine.queueCommand('cmd_B', 'CREATE_CUSTOMER', 'customers', 'cust_1', {}, 'dev_1', 'admin_1', undefined, {
      dependencyCommandId: 'cmd_A',
    });
    await engine.queueCommand('cmd_A', 'CREATE_DAY', 'business_days', 'day_1', {}, 'dev_1', 'admin_1');

    await engine.synchronize();

    expect(executedOrder).toEqual(['cmd_A', 'cmd_B', 'cmd_C', 'cmd_D']);
  });

  // TEST 6 — BLOCKED -> READY LIFECYCLE & EVENTS
  it('TEST 6 — BLOCKED -> READY LIFECYCLE & EVENTS: Verifies command_blocked, command_unblocked, and status transitions', async () => {
    const events: SyncEvent[] = [];
    const unsubscribe = syncEventEmitter.subscribe((event) => {
      events.push(event);
    });

    const transport: ServerSyncTransport = {
      pushCommand: async (): Promise<SyncCommandResponse> => ({
        success: true,
        serverVersion: 1,
        rpcReached: true,
      }),
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({
        changes: [],
        latestSequence: cursor,
        serverResetGeneration: 1,
      }),
    };

    const engine = new SyncEngine(transport);

    // Queue dependent command
    await engine.queueCommand(
      'cmd_dep_lifecycle',
      'CREATE_ORDER',
      'orders',
      'ord_lc',
      {},
      'dev_1',
      'admin_1',
      undefined,
      { dependencyCommandId: 'cmd_prereq_lifecycle' }
    );

    // Queue prerequisite
    await engine.queueCommand(
      'cmd_prereq_lifecycle',
      'CREATE_DAY',
      'business_days',
      'day_lc',
      {},
      'dev_1',
      'admin_1'
    );

    await engine.synchronize();
    unsubscribe();

    // Verify events include command_blocked for cmd_dep_lifecycle
    const blockedEvent = events.find(
      (e) => e.type === 'command_blocked' && e.commandId === 'cmd_dep_lifecycle'
    );
    expect(blockedEvent).toBeDefined();

    // Verify events include command_unblocked for cmd_dep_lifecycle
    const unblockedEvent = events.find(
      (e) => e.type === 'command_unblocked' && e.commandId === 'cmd_dep_lifecycle'
    );
    expect(unblockedEvent).toBeDefined();

    // Verify command_status_changed includes READY
    const readyStatusEvent = events.find(
      (e) =>
        e.type === 'command_status_changed' &&
        e.commandId === 'cmd_dep_lifecycle' &&
        (e as any).newState === 'READY'
    );
    expect(readyStatusEvent).toBeDefined();

    // Verify final states in localDb
    const outboxDep = (await localDb.listOutbox()).find((o) => o.commandId === 'cmd_dep_lifecycle');
    // Successful commands are removed from the active outbox after server acceptance.
    expect(outboxDep).toBeUndefined();

    const historyDep = await localDb.getHistoryByCommandId('cmd_dep_lifecycle');
    expect(historyDep?.state).toBe('SUCCESS');
  });

  // TEST 7 — DEPENDENCY FAILURE PREVENTS EXECUTION
  it('TEST 7 — DEPENDENCY FAILURE PREVENTS EXECUTION: If prerequisite fails, dependent stays BLOCKED and is never dispatched', async () => {
    const pushedCommandIds: string[] = [];

    const transport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        pushedCommandIds.push(req.commandId);
        if (req.commandId === 'cmd_prereq_fail') {
          return {
            success: false,
            error: 'Database constraint violation: duplicate key',
            code: 'DATABASE_CONSTRAINT',
            postgresSqlstate: '23505',
            rpcReached: true,
          };
        }
        return { success: true, serverVersion: 1, rpcReached: true };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({
        changes: [],
        latestSequence: cursor,
        serverResetGeneration: 1,
      }),
    };

    const engine = new SyncEngine(transport);

    await engine.queueCommand(
      'cmd_dependent_blocked',
      'CREATE_ORDER',
      'orders',
      'ord_blk',
      {},
      'dev_1',
      'admin_1',
      undefined,
      { dependencyCommandId: 'cmd_prereq_fail' }
    );

    await engine.queueCommand(
      'cmd_prereq_fail',
      'CREATE_DAY',
      'business_days',
      'day_fail',
      {},
      'dev_1',
      'admin_1'
    );

    const result = await engine.synchronize();
    expect(result.pushed).toBe(0);

    // cmd_dependent_blocked was NEVER sent to transport
    expect(pushedCommandIds).toEqual(['cmd_prereq_fail']);

    // cmd_dependent_blocked must remain BLOCKED
    const outboxDep = (await localDb.listOutbox()).find((o) => o.commandId === 'cmd_dependent_blocked');
    expect(outboxDep?.status).toBe('blocked');

    const historyDep = await localDb.getHistoryByCommandId('cmd_dependent_blocked');
    expect(historyDep?.state).toBe('BLOCKED');
  });

  // TEST 8 — CYCLE DETECTION
  it('TEST 8 — CYCLE DETECTION: Dependency cycles are detected, marked BLOCKED, and avoid infinite loops', async () => {
    const pushedCommandIds: string[] = [];

    const transport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        pushedCommandIds.push(req.commandId);
        return { success: true, serverVersion: 1, rpcReached: true };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({
        changes: [],
        latestSequence: cursor,
        serverResetGeneration: 1,
      }),
    };

    const engine = new SyncEngine(transport);

    // Circular dependency: A -> B and B -> A
    await engine.queueCommand('cmd_cycle_A', 'TYPE_A', 'type_a', 'a1', {}, 'dev_1', 'admin_1', undefined, {
      dependencyCommandId: 'cmd_cycle_B',
    });
    await engine.queueCommand('cmd_cycle_B', 'TYPE_B', 'type_b', 'b1', {}, 'dev_1', 'admin_1', undefined, {
      dependencyCommandId: 'cmd_cycle_A',
    });

    // Also add an independent valid command to ensure it can still execute
    await engine.queueCommand('cmd_independent', 'INDEPENDENT', 'ind', 'i1', {}, 'dev_1', 'admin_1');

    // Run synchronize: must complete cleanly without hanging
    const result = await engine.synchronize();
    expect(result.pushed).toBe(1);

    // Only cmd_independent should have been pushed
    expect(pushedCommandIds).toEqual(['cmd_independent']);

    // Both cycle commands must be marked blocked
    const outboxA = (await localDb.listOutbox()).find((o) => o.commandId === 'cmd_cycle_A');
    const outboxB = (await localDb.listOutbox()).find((o) => o.commandId === 'cmd_cycle_B');
    expect(outboxA?.status).toBe('blocked');
    expect(outboxB?.status).toBe('blocked');
    expect(outboxA?.lastError).toContain('Circular dependency');
    expect(outboxB?.lastError).toContain('Circular dependency');

    const historyA = await localDb.getHistoryByCommandId('cmd_cycle_A');
    const historyB = await localDb.getHistoryByCommandId('cmd_cycle_B');
    expect(historyA?.state).toBe('BLOCKED');
    expect(historyB?.state).toBe('BLOCKED');
  });

  // TEST 9 — DOMAIN ENTITY IMPLICIT DEPENDENCIES
  it('TEST 9 — DOMAIN ENTITY IMPLICIT DEPENDENCIES: Implicitly infers entity dependencies from payload references', async () => {
    const executedOrder: string[] = [];

    const transport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        executedOrder.push(req.commandId);
        return { success: true, serverVersion: 1, rpcReached: true };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({
        changes: [],
        latestSequence: cursor,
        serverResetGeneration: 1,
      }),
    };

    const engine = new SyncEngine(transport);

    // Queue in reverse order with domain entity references in payloads:
    // ADD_ORDER_ITEM (orderId: 'ord_10', deviceTypeId: 'dev_10')
    // CREATE_ORDER (dayId: 'day_10', customerId: 'cust_10')
    // CREATE_DEVICE_TYPE (aggregateId: 'dev_10')
    // CREATE_CUSTOMER (aggregateId: 'cust_10')
    // CREATE_DAY (aggregateId: 'day_10')

    await engine.queueCommand(
      'cmd_item_10',
      'ADD_ORDER_ITEM',
      'order_items',
      'item_10',
      { orderId: 'ord_10', deviceTypeId: 'dev_10' },
      'dev_1',
      'admin_1'
    );

    await engine.queueCommand(
      'cmd_order_10',
      'CREATE_ORDER',
      'orders',
      'ord_10',
      { dayId: 'day_10', customerId: 'cust_10' },
      'dev_1',
      'admin_1'
    );

    await engine.queueCommand(
      'cmd_dev_10',
      'CREATE_DEVICE_TYPE',
      'device_types',
      'dev_10',
      { name: 'Screen' },
      'dev_1',
      'admin_1'
    );

    await engine.queueCommand(
      'cmd_cust_10',
      'CREATE_CUSTOMER',
      'customers',
      'cust_10',
      { name: 'Sara' },
      'dev_1',
      'admin_1'
    );

    await engine.queueCommand(
      'cmd_day_10',
      'CREATE_DAY',
      'business_days',
      'day_10',
      { date: '2026-10-10' },
      'dev_1',
      'admin_1'
    );

    const result = await engine.synchronize();
    expect(result.pushed).toBe(5);

    // cmd_order_10 MUST execute after cmd_day_10 and cmd_cust_10
    expect(executedOrder.indexOf('cmd_day_10')).toBeLessThan(executedOrder.indexOf('cmd_order_10'));
    expect(executedOrder.indexOf('cmd_cust_10')).toBeLessThan(executedOrder.indexOf('cmd_order_10'));

    // cmd_item_10 MUST execute after cmd_order_10 and cmd_dev_10
    expect(executedOrder.indexOf('cmd_order_10')).toBeLessThan(executedOrder.indexOf('cmd_item_10'));
    expect(executedOrder.indexOf('cmd_dev_10')).toBeLessThan(executedOrder.indexOf('cmd_item_10'));
  });

  // TEST A — OPEN_DAY active and accepted
  it('TEST A — OPEN_DAY active and accepted: CREATE_ORDER becomes READY when OPEN_DAY is accepted in outbox', async () => {
    const dayId = 'day_test_a';
    const cmdDay = 'cmd_day_a';
    const cmdOrder = 'cmd_order_a';

    const dayRecord = {
      commandId: cmdDay,
      commandType: 'OPEN_DAY',
      aggregateType: 'business_days',
      aggregateId: dayId,
      payload: { id: dayId, date: '2026-10-01' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'accepted' as const,
      retryCount: 0,
    };
    await localDb.saveOutbox(dayRecord);

    const orderRecord = {
      commandId: cmdOrder,
      commandType: 'CREATE_ORDER',
      aggregateType: 'orders',
      aggregateId: 'ord_a',
      payload: { id: 'ord_a', dayId, customerId: 'cust_a' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending' as const,
      retryCount: 0,
    };
    await localDb.saveOutbox(orderRecord);

    const scheduler = new (await import('../infrastructure/sync/outboxScheduler')).OutboxScheduler();
    const result = await scheduler.schedule([orderRecord], [dayRecord, orderRecord]);

    expect(result.ready.map((r) => r.commandId)).toContain(cmdOrder);
    expect(result.blocked.has(cmdOrder)).toBe(false);
  });

  // TEST B — OPEN_DAY pending
  it('TEST B — OPEN_DAY pending: CREATE_ORDER remains BLOCKED while OPEN_DAY is active and pending', async () => {
    const dayId = 'day_test_b';
    const cmdDay = 'cmd_day_b';
    const cmdOrder = 'cmd_order_b';

    const dayRecord = {
      commandId: cmdDay,
      commandType: 'OPEN_DAY',
      aggregateType: 'business_days',
      aggregateId: dayId,
      payload: { id: dayId, date: '2026-10-01' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending' as const,
      retryCount: 0,
    };
    await localDb.saveOutbox(dayRecord);

    const orderRecord = {
      commandId: cmdOrder,
      commandType: 'CREATE_ORDER',
      aggregateType: 'orders',
      aggregateId: 'ord_b',
      payload: { id: 'ord_b', dayId, customerId: 'cust_b' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending' as const,
      retryCount: 0,
    };
    await localDb.saveOutbox(orderRecord);

    const scheduler = new (await import('../infrastructure/sync/outboxScheduler')).OutboxScheduler();
    const result = await scheduler.schedule([orderRecord], [dayRecord, orderRecord]);

    expect(result.ready.map((r) => r.commandId)).not.toContain(cmdOrder);
    expect(result.blocked.has(cmdOrder)).toBe(true);
    expect(result.blocked.get(cmdOrder)?.unsatisfiedDependencies).toContain(cmdDay);
  });

  // TEST C — OPEN_DAY failed in history
  it('TEST C — OPEN_DAY failed in history: CREATE_ORDER is BLOCKED and never pushed when OPEN_DAY failed in history', async () => {
    const dayId = 'day_test_c';
    const cmdDay = 'cmd_day_c';
    const cmdOrder = 'cmd_order_c';

    // OPEN_DAY is NOT in allOutbox, but recorded in syncHistory as FAILED
    await localDb.saveHistory({
      historyId: cmdDay,
      commandId: cmdDay,
      commandType: 'OPEN_DAY',
      entityType: 'business_days',
      entityId: dayId,
      state: 'FAILED',
      errorMessage: 'Simulated failure',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attemptCount: 1,
    });

    const orderRecord = {
      commandId: cmdOrder,
      commandType: 'CREATE_ORDER',
      aggregateType: 'orders',
      aggregateId: 'ord_c',
      payload: { id: 'ord_c', dayId, customerId: 'cust_c' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending' as const,
      retryCount: 0,
    };
    await localDb.saveOutbox(orderRecord);

    const scheduler = new (await import('../infrastructure/sync/outboxScheduler')).OutboxScheduler();
    const result = await scheduler.schedule(
      [orderRecord],
      [orderRecord],
      (id) => localDb.getHistoryByCommandId(id)
    );

    expect(result.ready.map((r) => r.commandId)).not.toContain(cmdOrder);
    expect(result.blocked.has(cmdOrder)).toBe(true);
  });

  // TEST D — OPEN_DAY success in history
  it('TEST D — OPEN_DAY success in history: CREATE_ORDER becomes READY when OPEN_DAY succeeded in history and is absent from outbox', async () => {
    const dayId = 'day_test_d';
    const cmdDay = 'cmd_day_d';
    const cmdOrder = 'cmd_order_d';

    // OPEN_DAY is NOT in outbox, but in syncHistory as SUCCESS
    await localDb.saveHistory({
      historyId: cmdDay,
      commandId: cmdDay,
      commandType: 'OPEN_DAY',
      entityType: 'business_days',
      entityId: dayId,
      state: 'SUCCESS',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attemptCount: 1,
    });

    const orderRecord = {
      commandId: cmdOrder,
      commandType: 'CREATE_ORDER',
      aggregateType: 'orders',
      aggregateId: 'ord_d',
      payload: { id: 'ord_d', dayId, customerId: 'cust_d' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending' as const,
      retryCount: 0,
    };
    await localDb.saveOutbox(orderRecord);

    const scheduler = new (await import('../infrastructure/sync/outboxScheduler')).OutboxScheduler();
    const result = await scheduler.schedule(
      [orderRecord],
      [orderRecord],
      (id) => localDb.getHistoryByCommandId(id)
    );

    expect(result.ready.map((r) => r.commandId)).toContain(cmdOrder);
    expect(result.blocked.has(cmdOrder)).toBe(false);
  });

  // TEST E — OPEN_DAY missing everywhere
  it('TEST E — OPEN_DAY missing everywhere: CREATE_ORDER is BLOCKED when OPEN_DAY is missing from outbox and history', async () => {
    const dayId = 'day_missing_everywhere';
    const cmdOrder = 'cmd_order_e';

    const orderRecord = {
      commandId: cmdOrder,
      commandType: 'CREATE_ORDER',
      aggregateType: 'orders',
      aggregateId: 'ord_e',
      payload: { id: 'ord_e', dayId, customerId: 'cust_e' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending' as const,
      retryCount: 0,
    };
    await localDb.saveOutbox(orderRecord);

    const scheduler = new (await import('../infrastructure/sync/outboxScheduler')).OutboxScheduler();
    const result = await scheduler.schedule(
      [orderRecord],
      [orderRecord],
      (id) => localDb.getHistoryByCommandId(id)
    );

    // Invariant: missing prerequisite MUST be BLOCKED, never READY
    expect(result.ready.map((r) => r.commandId)).not.toContain(cmdOrder);
    expect(result.blocked.has(cmdOrder)).toBe(true);
    expect(result.blocked.get(cmdOrder)?.unsatisfiedDependencies).toContain(dayId);
  });

  // TEST F — failed JWT scenario
  it('TEST F — failed JWT scenario: OPEN_DAY fails with HTTP 401 JWT expired -> CREATE_ORDER remains BLOCKED and never reaches REMOTE_EXECUTION', async () => {
    const pushedCommandIds: string[] = [];
    const dayId = 'day_jwt_fail';

    const transport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        pushedCommandIds.push(req.commandId);
        if (req.commandType === 'OPEN_DAY') {
          return {
            success: false,
            error: 'JWT expired',
            code: 'AUTH_REQUIRED',
            httpStatus: 401,
            rpcReached: true,
          };
        }
        return { success: true, serverVersion: 1, rpcReached: true };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({
        changes: [],
        latestSequence: cursor,
        serverResetGeneration: 1,
      }),
    };

    const engine = new SyncEngine(transport);

    // Queue OPEN_DAY and CREATE_ORDER
    await engine.queueCommand(
      'cmd_open_day_jwt',
      'OPEN_DAY',
      'business_days',
      dayId,
      { id: dayId, date: '2026-10-20' },
      'dev_1',
      'admin_1'
    );

    await engine.queueCommand(
      'cmd_create_order_jwt',
      'CREATE_ORDER',
      'orders',
      'ord_jwt_1',
      { id: 'ord_jwt_1', dayId, customerId: 'cust_jwt' },
      'dev_1',
      'admin_1'
    );

    // First synchronization: OPEN_DAY fails with 401
    await engine.synchronize();

    // OPEN_DAY was pushed and failed; CREATE_ORDER must NEVER have been pushed
    expect(pushedCommandIds).toEqual(['cmd_open_day_jwt']);

    const historyOrder = await localDb.getHistoryByCommandId('cmd_create_order_jwt');
    expect(historyOrder?.state).toBe('BLOCKED');

    // Run synchronization again: CREATE_ORDER must still remain BLOCKED and not pushed
    await engine.synchronize();
    expect(pushedCommandIds).not.toContain('cmd_create_order_jwt');
    const historyOrderAfter = await localDb.getHistoryByCommandId('cmd_create_order_jwt');
    expect(historyOrderAfter?.state).toBe('BLOCKED');
  });

  // TEST G — dependency identity
  it('TEST G — dependency identity: CREATE_ORDER.payload.dayId matches OPEN_DAY.aggregateId while commandId values remain distinct', async () => {
    const dayId = 'day_identity_test_uuid';
    const dayCmdId = 'cmd_open_day_unique_1';
    const orderCmdId = 'cmd_create_order_unique_2';

    const dayRecord = {
      commandId: dayCmdId,
      commandType: 'OPEN_DAY',
      aggregateType: 'business_days',
      aggregateId: dayId,
      payload: { id: dayId, date: '2026-10-01' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending' as const,
      retryCount: 0,
    };

    const orderRecord = {
      commandId: orderCmdId,
      commandType: 'CREATE_ORDER',
      aggregateType: 'orders',
      aggregateId: 'ord_unique_id',
      payload: { id: 'ord_unique_id', dayId, customerId: 'cust_g' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending' as const,
      retryCount: 0,
    };

    expect(orderRecord.payload.dayId).toBe(dayRecord.aggregateId);
    expect(orderRecord.commandId).not.toBe(dayRecord.commandId);

    const deps = extractCommandDependencies(orderRecord, [dayRecord, orderRecord]);
    expect(deps).toContain(dayCmdId);
  });

  // TEST H — customer dependency
  it('TEST H — customer dependency: CREATE_ORDER customer dependency semantics are preserved', async () => {
    const custId = 'cust_test_h';
    const custCmdId = 'cmd_cust_h';
    const orderCmdId = 'cmd_order_h';
    const dayId = 'day_test_h';

    // When CREATE_CUSTOMER is in outbox pending, CREATE_ORDER is BLOCKED
    const custRecord = {
      commandId: custCmdId,
      commandType: 'CREATE_CUSTOMER',
      aggregateType: 'customers',
      aggregateId: custId,
      payload: { id: custId, name: 'Alice' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending' as 'pending' | 'accepted',
      retryCount: 0,
    };

    // OPEN_DAY is accepted in history
    await localDb.saveHistory({
      historyId: 'cmd_day_h',
      commandId: 'cmd_day_h',
      commandType: 'OPEN_DAY',
      entityType: 'business_days',
      entityId: dayId,
      state: 'SUCCESS',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attemptCount: 1,
    });

    const orderRecord = {
      commandId: orderCmdId,
      commandType: 'CREATE_ORDER',
      aggregateType: 'orders',
      aggregateId: 'ord_h',
      payload: { id: 'ord_h', dayId, customerId: custId },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending' as const,
      retryCount: 0,
    };

    const scheduler = new (await import('../infrastructure/sync/outboxScheduler')).OutboxScheduler();
    const resultBlocked = await scheduler.schedule(
      [orderRecord],
      [custRecord, orderRecord],
      (id) => localDb.getHistoryByCommandId(id)
    );

    expect(resultBlocked.ready.map((r) => r.commandId)).not.toContain(orderCmdId);
    expect(resultBlocked.blocked.has(orderCmdId)).toBe(true);

    // When CREATE_CUSTOMER becomes accepted, CREATE_ORDER becomes READY
    custRecord.status = 'accepted';
    const resultReady = await scheduler.schedule(
      [orderRecord],
      [custRecord, orderRecord],
      (id) => localDb.getHistoryByCommandId(id)
    );

    expect(resultReady.ready.map((r) => r.commandId)).toContain(orderCmdId);
    expect(resultReady.blocked.has(orderCmdId)).toBe(false);
  });
});
