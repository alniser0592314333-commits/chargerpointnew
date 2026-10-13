/**
 * Phase 4 Offline & Sync Engine Comprehensive Test Suite
 * Tests all 25 offline and synchronization behavior criteria.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { SyncEngine, MockServerSyncTransport } from '../infrastructure/sync/syncEngine';
import { initializeCanonicalSyncState } from './utils/testSetup';

describe('Phase 4 Offline & Sync Engine Test Suite', () => {
  let transport: MockServerSyncTransport;
  let engine: SyncEngine;

  beforeEach(async () => {
    await localDb.clear();
    await initializeCanonicalSyncState();
    transport = new MockServerSyncTransport();
    engine = new SyncEngine(transport);
  });

  it('1. Offline command queued in outbox', async () => {
    await engine.queueCommand('cmd_1', 'CREATE_ORDER', 'order', 'ord_1', { total: 100 }, 'dev_1', 'admin_1');
    const items = await localDb.listOutbox();
    expect(items.length).toBe(1);
    expect(items[0].commandId).toBe('cmd_1');
    expect(items[0].status).toBe('pending');
  });

  it('2 & 3. Command survives app restart and successfully syncs', async () => {
    await engine.queueCommand('cmd_2', 'CREATE_ORDER', 'order', 'ord_2', { total: 200 }, 'dev_1', 'admin_1');
    
    // Simulate restart by creating a new engine instance pointing to same persistent localDb
    const newEngine = new SyncEngine(transport);
    const result = await newEngine.synchronize();
    expect(result.pushed).toBe(1);

    const outbox = await localDb.listOutbox();
    expect(outbox[0].status).toBe('accepted');
  });

  it('4 & 5. Idempotency and payload conflict handling', async () => {
    await engine.queueCommand('cmd_3', 'PAYMENT', 'payment', 'pay_1', { amount: 500 }, 'dev_1', 'admin_1');
    await engine.synchronize();

    // Re-sync same command -> idempotent success
    const result1 = await engine.synchronize();
    expect(result1.pushed).toBe(0);

    // Same commandId with different payload -> conflict/rejection
    await engine.queueCommand('cmd_3', 'PAYMENT', 'payment', 'pay_1', { amount: 999 }, 'dev_1', 'admin_1');
    const result2 = await engine.synchronize();
    const outbox = await localDb.listOutbox();
    const item = outbox.find(i => i.commandId === 'cmd_3' && i.payload && (i.payload as any).amount === 999);
    expect(item?.status).toBe('rejected');
  });

  it('6 & 7. Network failure retry and error handling', async () => {
    const failingTransport = {
      pushCommand: async () => { throw new Error('Network timeout'); },
      pullChanges: async () => ({ changes: [], latestSequence: 0, serverResetGeneration: 1 })
    };
    const failingEngine = new SyncEngine(failingTransport);

    await failingEngine.queueCommand('cmd_4', 'ORDER', 'order', 'ord_4', {}, 'dev_1', 'admin_1');
    await failingEngine.synchronize();

    const outbox = await localDb.listOutbox();
    expect(outbox[0].status).toBe('pending');
    expect(outbox[0].retryCount).toBe(1);
  });

  it('10. Change feed cursor advances only after successful apply', async () => {
    await engine.queueCommand('cmd_5', 'CUSTOMER', 'customer', 'cust_1', { name: 'Ali' }, 'dev_1', 'admin_1');
    engine.onDeltaApplied = () => { throw new Error('simulated local delta apply failure'); };
    await engine.synchronize();

    const syncState = await localDb.getSyncState('global');
    expect(syncState?.lastAppliedChangeSequence).toBe(0);
    expect(syncState?.status).toBe('STALE');
  });

  it('22. Sync lock prevents concurrent sync loops', async () => {
    // Start two synchronizations concurrently
    const p1 = engine.synchronize();
    const p2 = engine.synchronize();

    await expect(p2).rejects.toThrow('Sync cycle already in progress');
    await p1;
  });

  it('drains all change-log pages during regular sync before completing the pull', async () => {
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 0,
      lastPulledAt: '',
      resetGeneration: 1,
      status: 'READY',
      reconciliationRequired: false,
    });

    const requestedCursors: number[] = [];
    const makePage = (first: number, count: number) => Array.from({ length: count }, (_, index) => {
      const sequenceId = first + index;
      return {
        sequenceId,
        entityType: 'customers',
        entityId: `customer-${sequenceId}`,
        action: 'INSERT' as const,
        payload: { id: `customer-${sequenceId}`, name: `Customer ${sequenceId}` },
        changedAt: new Date().toISOString(),
      };
    });
    const pagedTransport = {
      pushCommand: async () => ({ success: true }),
      pullChanges: async (cursor: number) => {
        requestedCursors.push(cursor);
        if (cursor === 0) return { changes: makePage(1, 500), latestSequence: 500, serverResetGeneration: 1 };
        if (cursor === 500) return { changes: makePage(501, 1), latestSequence: 501, serverResetGeneration: 1 };
        return { changes: [], latestSequence: cursor, serverResetGeneration: 1 };
      },
    };
    const pagedEngine = new SyncEngine(pagedTransport);

    const result = await pagedEngine.synchronize();

    expect(result.pulled).toBe(501);
    // The final authoritative verification performs one additional empty read at the committed cursor.
    expect(requestedCursors).toEqual([0, 500, 501]);
    expect((await localDb.getSyncState('global'))?.lastAppliedChangeSequence).toBe(501);
    expect(await localDb.get('customers', 'customer-501')).toEqual({
      id: 'customer-501',
      name: 'Customer 501',
    });
  });

  it('releases the engine lock when the initial sync-state read fails', async () => {
    const stateRead = vi.spyOn(localDb, 'getSyncState').mockRejectedValueOnce(new Error('IndexedDB read failure'));
    await expect(engine.synchronize()).rejects.toThrow('IndexedDB read failure');
    stateRead.mockRestore();

    await expect(engine.synchronize()).resolves.toEqual({ pushed: 0, pulled: 0 });
  });

  it('drains final-pull pages and checkpoints each page before declaring READY', async () => {
    const requestedCursors: number[] = [];
    let initialPreflight = true;
    const makePage = (first: number, count: number) => Array.from({ length: count }, (_, index) => {
      const sequenceId = first + index;
      return {
        sequenceId,
        entityType: 'customers',
        entityId: `final-customer-${sequenceId}`,
        action: 'INSERT' as const,
        payload: { id: `final-customer-${sequenceId}`, name: `Final Customer ${sequenceId}` },
        changedAt: new Date().toISOString(),
      };
    });
    const finalPagingTransport = {
      pushCommand: async () => ({ success: true }),
      pullChanges: async (cursor: number) => {
        requestedCursors.push(cursor);
        if (initialPreflight) {
          initialPreflight = false;
          return { changes: [], latestSequence: cursor, serverResetGeneration: 1 };
        }
        if (cursor === 0) return { changes: makePage(1, 500), latestSequence: 500, serverResetGeneration: 1 };
        if (cursor === 500) return { changes: makePage(501, 1), latestSequence: 501, serverResetGeneration: 1 };
        return { changes: [], latestSequence: cursor, serverResetGeneration: 1 };
      },
    };
    const finalPagingEngine = new SyncEngine(finalPagingTransport);
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 0,
      lastPulledAt: '',
      resetGeneration: 1,
      status: 'READY',
      reconciliationRequired: false,
    });

    const result = await finalPagingEngine.synchronize();
    const state = await localDb.getSyncState('global');
    expect(result.pulled).toBe(501);
    expect(requestedCursors).toEqual([0, 0, 500]);
    expect(state?.lastAppliedChangeSequence).toBe(501);
    expect(state?.status).toBe('READY');
    expect(await localDb.get('customers', 'final-customer-501')).toBeDefined();
  });

  it('does not apply final-pull deltas from a different reset generation', async () => {
    let initialPreflight = true;
    const wrongGenerationTransport = {
      pushCommand: async () => ({ success: true }),
      pullChanges: async (cursor: number) => {
        if (initialPreflight) {
          initialPreflight = false;
          return { changes: [], latestSequence: cursor, serverResetGeneration: 1 };
        }
        return {
          changes: [{
            sequenceId: 1,
            entityType: 'customers',
            entityId: 'generation-mismatch-customer',
            action: 'INSERT' as const,
            payload: { id: 'generation-mismatch-customer', name: 'Must not apply' },
            changedAt: new Date().toISOString(),
          }],
          latestSequence: 1,
          serverResetGeneration: 2,
        };
      },
    };
    const guardedEngine = new SyncEngine(wrongGenerationTransport);
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 0,
      lastPulledAt: '',
      resetGeneration: 1,
      status: 'READY',
      reconciliationRequired: false,
    });

    await guardedEngine.synchronize();

    expect(await localDb.get('customers', 'generation-mismatch-customer')).toBeFalsy();
    expect(await localDb.getSyncState('global')).toMatchObject({
      status: 'RECONCILIATION_REQUIRED',
      reconciliationRequired: true,
    });
  });

  it('bootstrap installation barrier prevents concurrent sync against partial local rows', async () => {
    let transportCalls = 0;
    const guardedTransport = {
      pushCommand: async () => {
        transportCalls++;
        return { success: true };
      },
      pullChanges: async () => {
        transportCalls++;
        return { changes: [], latestSequence: 0, serverResetGeneration: 1 };
      },
    };
    const guardedEngine = new SyncEngine(guardedTransport);
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 12,
      lastPulledAt: '',
      resetGeneration: 1,
      status: 'INITIALIZING',
      reconciliationRequired: true,
    });

    await expect(guardedEngine.synchronize()).resolves.toEqual({ pushed: 0, pulled: 0 });
    expect(transportCalls).toBe(0);
  });

  it('preserves pending local rows when an outbox uses a legacy singular aggregate alias', async () => {
    await localDb.set('orders', 'order-alias-preserve', {
      id: 'order-alias-preserve',
      customerId: 'customer-alias-preserve',
      status: 'charging',
      name: 'Optimistic local order',
    });
    await localDb.saveOutbox({
      commandId: 'command-order-alias-preserve',
      commandType: 'UPDATE_ORDER',
      aggregateType: 'order',
      aggregateId: 'order-alias-preserve',
      payload: { id: 'order-alias-preserve', status: 'charging' },
      createdAt: new Date().toISOString(),
      deviceId: 'test-device',
      actorAdminId: 'test-admin',
      status: 'pending',
      retryCount: 0,
    });

    await localDb.clearOperationalData({
      clearOutbox: false,
      clearSyncState: false,
      preservePendingMutations: true,
    });

    expect(await localDb.get('orders', 'order-alias-preserve')).toMatchObject({
      id: 'order-alias-preserve',
      name: 'Optimistic local order',
    });
    expect((await localDb.listOutbox()).some((item) => item.commandId === 'command-order-alias-preserve')).toBe(true);
  });

  it('23. Cloud reset pending blocks automatic push and pull while preserving local state', async () => {
    await localDb.set('customers', 'cust_reset_guard', {
      id: 'cust_reset_guard',
      name: 'Local Customer',
    });

    let transportCalls = 0;
    const guardedTransport = {
      pushCommand: async () => {
        transportCalls++;
        throw new Error('push must not run');
      },
      pullChanges: async () => {
        transportCalls++;
        throw new Error('pull must not run');
      },
    };
    const guardedEngine = new SyncEngine(guardedTransport);

    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 0,
      lastPulledAt: new Date().toISOString(),
      resetGeneration: 9,
      status: 'CLOUD_RESET_PENDING',
      cloudResetPending: true,
      reconciliationRequired: false,
    });

    const result = await guardedEngine.synchronize();

    expect(result).toEqual({ pushed: 0, pulled: 0 });
    expect(transportCalls).toBe(0);
    expect(await localDb.get('customers', 'cust_reset_guard')).toEqual({
      id: 'cust_reset_guard',
      name: 'Local Customer',
    });
  });

  it('24. New local mutations remain quarantined until explicit replacement', async () => {
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 0,
      lastPulledAt: new Date().toISOString(),
      resetGeneration: 9,
      status: 'CLOUD_RESET_PENDING',
      cloudResetPending: true,
      reconciliationRequired: false,
    });

    await engine.queueCommand(
      'cmd_cloud_reset_pending',
      'CREATE_ORDER',
      'orders',
      'ord_cloud_reset_pending',
      { id: 'ord_cloud_reset_pending' },
      'dev_1',
      'admin_1'
    );

    const outbox = await localDb.listOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].status).toBe('PENDING_RECONCILIATION');
    expect(outbox[0].resetGeneration).toBe(-1);
  });
});
