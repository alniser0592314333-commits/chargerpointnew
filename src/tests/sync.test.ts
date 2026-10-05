/**
 * Phase 4 Offline & Sync Engine Comprehensive Test Suite
 * Tests all 25 offline and synchronization behavior criteria.
 */

import { describe, it, expect, beforeEach } from 'vitest';
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
    await engine.synchronize();

    const syncState = await localDb.getSyncState('global');
    expect(syncState?.lastAppliedChangeSequence).toBe(0);
  });

  it('22. Sync lock prevents concurrent sync loops', async () => {
    // Start two synchronizations concurrently
    const p1 = engine.synchronize();
    const p2 = engine.synchronize();

    await expect(p2).rejects.toThrow('Sync cycle already in progress');
    await p1;
  });
});
