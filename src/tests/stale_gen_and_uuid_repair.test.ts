/**
 * Stale Outbox Generation & UUID Fallback Removal Regression Test Suite
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  repoContext,
  getDeviceTypesOptions,
  resetStoreMemory,
  setRuntimeBinVerifier,
  createOrderWithPhase5Engine,
  phase5UseCases,
} from '../components/pages/dayOrdersStore';
import { SyncEngine, ServerSyncTransport, SyncCommandRequest, SyncCommandResponse } from '../infrastructure/sync/syncEngine';

const adminAuth = {
  getAuth: () => ({ id: 'admin-1', username: 'admin', role: 'ADMIN', isSuperAdmin: true }),
  requireAuth: () => ({ id: 'admin-1', username: 'admin', role: 'ADMIN', isSuperAdmin: true }),
  assertPermission: () => {},
  verifyBin: async () => {},
};

describe('Stale Outbox Generation & UUID Fallback Repair Suite', () => {
  beforeEach(async () => {
    await localDb.clear();
    resetStoreMemory();
    setRuntimeBinVerifier((bin) => bin === '1234');
  });

  it('Test A: Existing pending stale command (gen 1) is quarantined as RESET_GENERATION_MISMATCH when server is gen 12', async () => {
    // 1. Established syncState gen 12
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 10,
      lastPulledAt: new Date().toISOString(),
      resetGeneration: 12,
      status: 'READY',
      reconciliationRequired: false,
    });

    // 2. Seed stale outbox command with gen 1 and status 'pending'
    const cmdId = 'stale-cmd-1';
    await localDb.saveOutbox({
      commandId: cmdId,
      commandType: 'CREATE_CUSTOMER',
      aggregateType: 'customers',
      aggregateId: 'cust-stale-1',
      payload: { id: 'cust-stale-1', name: 'Stale Customer' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev-1',
      actorAdminId: 'admin-1',
      status: 'pending',
      retryCount: 0,
      resetGeneration: 1,
    });

    // 3. Mock transport with serverResetGeneration = 12
    const pushedRequests: SyncCommandRequest[] = [];
    const mockTransport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        pushedRequests.push(req);
        return { success: true, rpcReached: true, serverVersion: 1 };
      },
      pullChanges: async () => {
        return {
          changes: [],
          latestSequence: 10,
          serverResetGeneration: 12,
        };
      },
    };

    const engine = new SyncEngine(mockTransport);

    // 4. Run synchronization
    await engine.synchronize();

    // 5. Verify stale command was NOT dispatched to server
    expect(pushedRequests.length).toBe(0);

    // 6. Verify stale command was quarantined in outbox
    const quarantinedCmd = await localDb.getOutbox(cmdId);
    expect(quarantinedCmd?.status).toBe('rejected');
    expect(quarantinedCmd?.lastError).toBe('RESET_GENERATION_MISMATCH');

    // 7. Verify syncHistory marked as FAILED_PERMANENT
    const history = await localDb.getHistoryByCommandId(cmdId);
    expect(history?.state).toBe('FAILED_PERMANENT');
    expect(history?.errorMessage).toBe('RESET_GENERATION_MISMATCH');
    expect(history?.retryEligible).toBe(false);
  });

  it('Test B: Existing syncing stale command (gen 1) is safely quarantined before dispatch', async () => {
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 10,
      lastPulledAt: new Date().toISOString(),
      resetGeneration: 12,
      status: 'READY',
      reconciliationRequired: false,
    });

    const cmdId = 'stale-syncing-cmd';
    await localDb.saveOutbox({
      commandId: cmdId,
      commandType: 'OPEN_DAY',
      aggregateType: 'business_days',
      aggregateId: 'day-stale',
      payload: { businessDate: '2026-10-10' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev-1',
      actorAdminId: 'admin-1',
      status: 'syncing',
      retryCount: 1,
      resetGeneration: 1,
    });

    const pushedRequests: SyncCommandRequest[] = [];
    const mockTransport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest) => {
        pushedRequests.push(req);
        return { success: true };
      },
      pullChanges: async () => ({ changes: [], latestSequence: 102, serverResetGeneration: 12 }),
    };

    const engine = new SyncEngine(mockTransport);
    await engine.synchronize();

    expect(pushedRequests.length).toBe(0);
    const quarantined = await localDb.getOutbox(cmdId);
    expect(quarantined?.status).toBe('rejected');
    expect(quarantined?.lastError).toBe('RESET_GENERATION_MISMATCH');
  });

  it('Test F: Empty Device Type repository returns empty array and injects NO dev-* demo records into IndexedDB', async () => {
    // 1. Ensure localDb deviceTypes store is empty
    const devicesBefore = await localDb.list('deviceTypes');
    expect(devicesBefore.length).toBe(0);

    // 2. Call getDeviceTypesOptions
    const options = await getDeviceTypesOptions('ar');
    expect(options).toEqual([]);

    // 3. Verify no dev-* records were injected into IndexedDB
    const devicesAfter = await localDb.list('deviceTypes');
    expect(devicesAfter.length).toBe(0);
  });

  it('Test J: SyncEngine quarantines command with non-UUID legacy identifier (dev-1) and prevents dispatch to transport', async () => {
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 10,
      lastPulledAt: new Date().toISOString(),
      resetGeneration: 12,
      status: 'READY',
      reconciliationRequired: false,
    });

    const cmdId = 'legacy-payload-cmd';
    await localDb.saveOutbox({
      commandId: cmdId,
      commandType: 'DELIVER_ORDER_ITEM',
      aggregateType: 'order_items',
      aggregateId: 'dev-1',
      payload: { orderItemId: 'dev-1', bin: '1234' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev-1',
      actorAdminId: 'admin-1',
      status: 'pending',
      retryCount: 0,
      resetGeneration: 12,
    });

    const pushedRequests: SyncCommandRequest[] = [];
    const mockTransport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest) => {
        pushedRequests.push(req);
        return { success: true };
      },
      pullChanges: async () => ({ changes: [], latestSequence: 102, serverResetGeneration: 12 }),
    };

    const engine = new SyncEngine(mockTransport);
    await engine.synchronize();

    expect(pushedRequests.length).toBe(0);
    const quarantined = await localDb.getOutbox(cmdId);
    expect(quarantined?.status).toBe('rejected');
    expect(quarantined?.lastError).toBe('INVALID_UUID_IDENTIFIER');
  });

  it('Test K: Transport pull failure halts synchronization and prevents command dispatch', async () => {
    // 1. Established syncState
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 10,
      lastPulledAt: new Date().toISOString(),
      resetGeneration: 13,
      status: 'READY',
    } as any);

    const cmdId = 'should-not-dispatch';
    await localDb.saveOutbox({
      commandId: cmdId,
      commandType: 'CREATE_CUSTOMER',
      aggregateType: 'customers',
      aggregateId: 'cust-1',
      payload: { id: 'cust-1' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev-1',
      actorAdminId: 'admin-1',
      status: 'pending',
      resetGeneration: 13,
    } as any);

    // 2. Mock transport to fail pullChanges
    const pushedRequests: SyncCommandRequest[] = [];
    const mockTransport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest) => {
        pushedRequests.push(req);
        return { success: true };
      },
      pullChanges: async () => { throw new Error('Network failure'); },
    };

    const engine = new SyncEngine(mockTransport);

    // 3. Run synchronization - should halt
    await engine.synchronize();

    // 4. Verify no command was dispatched
    expect(pushedRequests.length).toBe(0);
    const cmd = await localDb.getOutbox(cmdId);
    expect(cmd?.status).toBe('pending'); // Still pending
  });

  it('Test L: Stale command (gen 13) is quarantined when server is gen 14', async () => {
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 10,
      lastPulledAt: new Date().toISOString(),
      resetGeneration: 13,
      status: 'READY',
    } as any);

    const cmdId = 'stale-cmd-13';
    await localDb.saveOutbox({
      commandId: cmdId,
      commandType: 'OPEN_DAY',
      aggregateType: 'business_days',
      aggregateId: 'day-1',
      payload: { businessDate: '2026-10-10' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev-1',
      actorAdminId: 'admin-1',
      status: 'pending',
      resetGeneration: 13,
    } as any);

    const pushedRequests: SyncCommandRequest[] = [];
    const mockTransport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest) => {
        pushedRequests.push(req);
        return { success: true };
      },
      pullChanges: async () => ({ changes: [], latestSequence: 104, serverResetGeneration: 14 }),
    };

    const engine = new SyncEngine(mockTransport);
    await engine.synchronize();

    expect(pushedRequests.length).toBe(0);
    const quarantined = await localDb.getOutbox(cmdId);
    expect(quarantined?.status).toBe('rejected');
    expect(quarantined?.lastError).toBe('RESET_GENERATION_MISMATCH');
  });

  it('Test M: New command (gen 14) succeeds when server is gen 14', async () => {
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 10,
      lastPulledAt: new Date().toISOString(),
      resetGeneration: 13,
      status: 'READY',
    } as any);

    const cmdId = 'fresh-cmd-14';
    await localDb.saveOutbox({
      commandId: cmdId,
      commandType: 'OPEN_DAY',
      aggregateType: 'business_days',
      aggregateId: 'day-1',
      payload: { businessDate: '2026-10-10' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev-1',
      actorAdminId: 'admin-1',
      status: 'pending',
      resetGeneration: 14,
    } as any);

    const pushedRequests: SyncCommandRequest[] = [];
    const mockTransport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest) => {
        pushedRequests.push(req);
        return { success: true };
      },
      pullChanges: async () => ({ changes: [], latestSequence: 104, serverResetGeneration: 14 }),
    };

    const engine = new SyncEngine(mockTransport);
    await engine.synchronize();

    expect(pushedRequests.length).toBe(1);
    expect(pushedRequests[0].resetGeneration).toBe(14);
  });
});
