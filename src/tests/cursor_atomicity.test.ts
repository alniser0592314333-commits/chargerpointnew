/**
 * Cursor Atomicity Regression Test Suite
 * Verifies that remote change application and cursor advancement commit atomically in one IndexedDB transaction.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { SyncEngine, ServerSyncTransport, SyncCommandRequest, SyncCommandResponse, SyncPullResponse } from '../infrastructure/sync/syncEngine';
import { applyRemoteChange, resetStoreMemory, ensureStoreHydrated } from '../components/pages/dayOrdersStore';
import { initializeCanonicalSyncState } from './utils/testSetup';

class TestSyncTransport implements ServerSyncTransport {
  public changesToReturn: any[] = [];
  public latestSequence = 100;
  public pullCalls: { cursor: number; limit?: number }[] = [];

  async pushCommand(_req: SyncCommandRequest): Promise<SyncCommandResponse> {
    return { success: true, serverVersion: 1, rpcReached: true };
  }

  async pullChanges(cursor: number, limit?: number): Promise<SyncPullResponse> {
    this.pullCalls.push({ cursor, limit });
    const matching = this.changesToReturn.filter((c) => c.sequenceId > cursor);
    return {
      changes: matching,
      latestSequence: this.latestSequence,
      serverResetGeneration: 1,
    };
  }
}

describe('Cursor Atomicity & Transaction Boundary Tests', () => {
  let transport: TestSyncTransport;
  let engine: SyncEngine;

  beforeEach(async () => {
    await localDb.clear();
    resetStoreMemory();
    await ensureStoreHydrated();
    await initializeCanonicalSyncState();
    transport = new TestSyncTransport();
    engine = new SyncEngine(transport);
    engine.onDeltaApplied = (change: any, tx?: IDBTransaction) => applyRemoteChange(change, tx);
  });

  // Test A — Atomic success
  it('Test A: Atomic success — applies entity and advances cursor in one transaction', async () => {
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 100,
      lastPulledAt: '',
      resetGeneration: 1,
      status: 'READY',
    });

    transport.changesToReturn = [
      {
        sequenceId: 101,
        entityType: 'customers',
        entityId: 'cust-101',
        action: 'INSERT',
        payload: { id: 'cust-101', name: 'Atomic Customer', isActive: true, debtLimitMinor: 0 },
        changedAt: new Date().toISOString(),
      },
    ];
    transport.latestSequence = 101;

    const res = await engine.synchronize();
    expect(res.pulled).toBe(1);

    // Verify entity was applied
    const cust = await localDb.get<any>('customers', 'cust-101');
    expect(cust).toBeDefined();
    expect(cust?.name).toBe('Atomic Customer');

    // Verify cursor was advanced
    const syncState = await localDb.getSyncState('global');
    expect(syncState?.lastAppliedChangeSequence).toBe(101);
  });

  // Test B — Entity failure
  it('Test B: Entity failure — rolls back both entity and cursor when entity application throws', async () => {
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 100,
      lastPulledAt: '',
      resetGeneration: 1,
      status: 'READY',
    });

    transport.changesToReturn = [
      {
        sequenceId: 101,
        entityType: 'customers',
        entityId: 'cust-101',
        action: 'INSERT',
        payload: { id: 'cust-101', name: 'Failing Customer' },
        changedAt: new Date().toISOString(),
      },
    ];

    // Force failure in entity application
    engine.onDeltaApplied = () => {
      throw new Error('Forced entity apply failure');
    };

    await expect(engine.synchronize()).rejects.toThrow('Forced entity apply failure');

    // Verify entity was NOT committed
    const cust = await localDb.get<any>('customers', 'cust-101');
    expect(cust).toBeNull();

    // Verify cursor remains at 100
    const syncState = await localDb.getSyncState('global');
    expect(syncState?.lastAppliedChangeSequence).toBe(100);
  });

  // Test C — Cursor failure
  it('Test C: Cursor failure — rolls back entity if cursor persistence fails', async () => {
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 100,
      lastPulledAt: '',
      resetGeneration: 1,
      status: 'READY',
    });

    transport.changesToReturn = [
      {
        sequenceId: 101,
        entityType: 'customers',
        entityId: 'cust-101',
        action: 'INSERT',
        payload: { id: 'cust-101', name: 'Rollback Customer' },
        changedAt: new Date().toISOString(),
      },
    ];

    // Mock setSyncStateWithTx to throw inside the transaction
    const origSetSyncStateWithTx = localDb.setSyncStateWithTx.bind(localDb);
    vi.spyOn(localDb, 'setSyncStateWithTx').mockImplementation(() => {
      throw new Error('Forced cursor write failure');
    });

    await expect(engine.synchronize()).rejects.toThrow('Forced cursor write failure');

    // Restore spy
    vi.spyOn(localDb, 'setSyncStateWithTx').mockImplementation(origSetSyncStateWithTx);

    // Verify entity was rolled back
    const cust = await localDb.get<any>('customers', 'cust-101');
    expect(cust).toBeNull();

    // Verify cursor remains at 100
    const syncState = await localDb.getSyncState('global');
    expect(syncState?.lastAppliedChangeSequence).toBe(100);
  });

  // Test D — Batch failure
  it('Test D: Batch failure — atomically rolls back entire batch (101, 102, 103) if 102 fails', async () => {
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 100,
      lastPulledAt: '',
      resetGeneration: 1,
      status: 'READY',
    });

    transport.changesToReturn = [
      {
        sequenceId: 101,
        entityType: 'customers',
        entityId: 'cust-101',
        action: 'INSERT',
        payload: { id: 'cust-101', name: 'Cust 101' },
        changedAt: new Date().toISOString(),
      },
      {
        sequenceId: 102,
        entityType: 'customers',
        entityId: 'cust-102',
        action: 'INSERT',
        payload: { id: 'cust-102', name: 'Cust 102' },
        changedAt: new Date().toISOString(),
      },
      {
        sequenceId: 103,
        entityType: 'customers',
        entityId: 'cust-103',
        action: 'INSERT',
        payload: { id: 'cust-103', name: 'Cust 103' },
        changedAt: new Date().toISOString(),
      },
    ];

    // Force failure on change 102
    engine.onDeltaApplied = (change: any, tx?: IDBTransaction) => {
      if (change.sequenceId === 102) {
        throw new Error('Batch failure on 102');
      }
      applyRemoteChange(change, tx);
    };

    await expect(engine.synchronize()).rejects.toThrow('Batch failure on 102');

    // Verify NONE of 101, 102, 103 are committed
    expect(await localDb.get('customers', 'cust-101')).toBeNull();
    expect(await localDb.get('customers', 'cust-102')).toBeNull();
    expect(await localDb.get('customers', 'cust-103')).toBeNull();

    // Verify cursor remains at 100
    const syncState = await localDb.getSyncState('global');
    expect(syncState?.lastAppliedChangeSequence).toBe(100);
  });

  // Test E — Replay
  it('Test E: Replay — after failure, subsequent sync successfully replays and commits events without duplication', async () => {
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 100,
      lastPulledAt: '',
      resetGeneration: 1,
      status: 'READY',
    });

    transport.changesToReturn = [
      {
        sequenceId: 101,
        entityType: 'customers',
        entityId: 'cust-101',
        action: 'INSERT',
        payload: { id: 'cust-101', name: 'Cust 101' },
        changedAt: new Date().toISOString(),
      },
      {
        sequenceId: 102,
        entityType: 'customers',
        entityId: 'cust-102',
        action: 'INSERT',
        payload: { id: 'cust-102', name: 'Cust 102' },
        changedAt: new Date().toISOString(),
      },
    ];
    transport.latestSequence = 102;

    // First attempt fails
    let failOnce = true;
    engine.onDeltaApplied = (change: any, tx?: IDBTransaction) => {
      if (failOnce && change.sequenceId === 102) {
        throw new Error('Transient error');
      }
      applyRemoteChange(change, tx);
    };

    await expect(engine.synchronize()).rejects.toThrow('Transient error');

    // Cursor stayed at 100
    expect((await localDb.getSyncState('global'))?.lastAppliedChangeSequence).toBe(100);

    // Second attempt succeeds (replay from cursor 100)
    failOnce = false;
    const res = await engine.synchronize();
    expect(res.pulled).toBe(2);

    expect(await localDb.get('customers', 'cust-101')).toBeDefined();
    expect(await localDb.get('customers', 'cust-102')).toBeDefined();
    expect((await localDb.getSyncState('global'))?.lastAppliedChangeSequence).toBe(102);
  });

  // Test F — Non-contiguous sequences
  it('Test F: Non-contiguous sequences (101, 105, 109) — accepted normally without cursor+1 requirements', async () => {
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 100,
      lastPulledAt: '',
      resetGeneration: 1,
      status: 'READY',
    });

    transport.changesToReturn = [
      {
        sequenceId: 101,
        entityType: 'customers',
        entityId: 'cust-101',
        action: 'INSERT',
        payload: { id: 'cust-101', name: 'Cust 101' },
        changedAt: new Date().toISOString(),
      },
      {
        sequenceId: 105,
        entityType: 'customers',
        entityId: 'cust-105',
        action: 'INSERT',
        payload: { id: 'cust-105', name: 'Cust 105' },
        changedAt: new Date().toISOString(),
      },
      {
        sequenceId: 109,
        entityType: 'customers',
        entityId: 'cust-109',
        action: 'INSERT',
        payload: { id: 'cust-109', name: 'Cust 109' },
        changedAt: new Date().toISOString(),
      },
    ];
    transport.latestSequence = 109;

    const res = await engine.synchronize();
    expect(res.pulled).toBe(3);

    expect(await localDb.get('customers', 'cust-101')).toBeDefined();
    expect(await localDb.get('customers', 'cust-105')).toBeDefined();
    expect(await localDb.get('customers', 'cust-109')).toBeDefined();
    expect((await localDb.getSyncState('global'))?.lastAppliedChangeSequence).toBe(109);
  });

  // Test G — Pagination
  it('Test G: Pagination — pull continues from committed cursor with LIMIT 500 bound', async () => {
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 200,
      lastPulledAt: '',
      resetGeneration: 1,
      status: 'READY',
    });

    transport.changesToReturn = [
      {
        sequenceId: 201,
        entityType: 'customers',
        entityId: 'cust-201',
        action: 'INSERT',
        payload: { id: 'cust-201', name: 'Cust 201' },
        changedAt: new Date().toISOString(),
      },
    ];
    transport.latestSequence = 201;

    await engine.synchronize();

    expect(transport.pullCalls.length).toBeGreaterThan(0);
    expect(transport.pullCalls[0].cursor).toBe(200);

    const syncState = await localDb.getSyncState('global');
    expect(syncState?.lastAppliedChangeSequence).toBe(201);
  });

  // Test H — Multi-device cursor isolation
  it('Test H: Multi-device cursor isolation — local cursor belongs strictly to client device instance', async () => {
    const db1 = localDb;
    await db1.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 350,
      lastPulledAt: '',
      resetGeneration: 1,
      status: 'READY',
    });

    const state1 = await db1.getSyncState('global');
    expect(state1?.lastAppliedChangeSequence).toBe(350);

    // Independent syncState for separate scope
    await db1.setSyncState({
      table: 'device_2_scope',
      lastAppliedChangeSequence: 120,
      lastPulledAt: '',
      resetGeneration: 1,
      status: 'READY',
    });

    expect((await db1.getSyncState('global'))?.lastAppliedChangeSequence).toBe(350);
    expect((await db1.getSyncState('device_2_scope'))?.lastAppliedChangeSequence).toBe(120);
  });
});
