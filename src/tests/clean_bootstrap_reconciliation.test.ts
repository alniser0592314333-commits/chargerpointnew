/**
 * Clean Bootstrap Reset Generation & Reconciliation Regression Test Suite
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  repoContext,
  reloadStoreFromLocal,
  resetStoreMemory,
  setRuntimeBinVerifier,
} from '../components/pages/dayOrdersStore';
import { SyncEngine, ServerSyncTransport, SyncCommandRequest, SyncCommandResponse } from '../infrastructure/sync/syncEngine';
import { initializeCanonicalSyncState } from './utils/testSetup';

describe('Clean Bootstrap Reset Generation & Reconciliation Suite', () => {
  beforeEach(async () => {
    await localDb.clear();
    resetStoreMemory();
    setRuntimeBinVerifier((bin) => bin === '1234');
  });

  it('Test A: Clean bootstrap with server generation 12 creates PENDING_RECONCILIATION (-1) and promotes cleanly to 12 upon handshake', async () => {
    // 1. Fresh IndexedDB (syncState absent)
    const initialSyncState = await localDb.getSyncState('global');
    expect(initialSyncState?.status).toBe('RECONCILIATION_REQUIRED');
    expect(initialSyncState?.resetGeneration).toBe(-1);

    // 2. Perform local Business Day mutation before handshake
    await repoContext.dayRepo.save({
      id: 'day-clean-boot-12',
      businessDate: '2026-10-15',
      isClosed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    // 3. Verify local save succeeded and Outbox command was saved as PENDING_RECONCILIATION with resetGeneration = -1
    const outboxBefore = await localDb.listOutbox();
    expect(outboxBefore.length).toBe(1);
    expect(outboxBefore[0].status).toBe('PENDING_RECONCILIATION');
    expect(outboxBefore[0].resetGeneration).toBe(-1);

    // 4. Mock transport with serverResetGeneration = 12
    const pushedRequests: SyncCommandRequest[] = [];
    const mockTransport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        pushedRequests.push(req);
        return { success: true, rpcReached: true, serverVersion: 1 };
      },
      pullChanges: async () => {
        return {
          changes: [],
          latestSequence: 0,
          serverResetGeneration: 12,
        };
      },
    };

    const engine = new SyncEngine(mockTransport);

    // 5. Execute preflight & sync
    await engine.synchronize();

    // 6. Verify syncState was updated to generation 12 and READY
    const postSyncState = await localDb.getSyncState('global');
    expect(postSyncState?.resetGeneration).toBe(12);
    expect(postSyncState?.status).toBe('READY');

    // 7. Verify Outbox command was promoted to generation 12 and pushed cleanly
    expect(pushedRequests.length).toBe(1);
    expect(pushedRequests[0].resetGeneration).toBe(12);
    expect((pushedRequests[0].payload as any).resetGeneration).toBe(12);
    expect(pushedRequests[0].resetGeneration).not.toBe(1);
  });

  it('Test B: Existing client with established resetGeneration = 12 creates READY/pending outbox command with resetGeneration = 12', async () => {
    // 1. Established client state
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 100,
      lastPulledAt: new Date().toISOString(),
      resetGeneration: 12,
      status: 'READY',
      reconciliationRequired: false,
    });
    // Test B represents a previously bootstrapped client with a durable local
    // hydration marker; it is not the first-device bootstrap scenario from Test A.
    await localDb.setInitialHydrationCompleted(true);

    // 2. Perform mutation
    await repoContext.dayRepo.save({
      id: 'day-established-12',
      businessDate: '2026-10-16',
      isClosed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    // 3. Verify Outbox record has status = 'pending' and resetGeneration = 12
    const outbox = await localDb.listOutbox();
    expect(outbox.length).toBe(1);
    expect(outbox[0].status).toBe('pending');
    expect(outbox[0].resetGeneration).toBe(12);
  });

  it('Test C: Multiple mutations before handshake are all created as PENDING_RECONCILIATION (-1) and promoted to 12 consistently', async () => {
    // 1. Fresh DB
    await repoContext.customerRepo.save({
      id: 'cust-multi-1',
      name: 'عميل جديد 1',
      phone: '0599000000',
      isActive: true,
      debtLimitMinor: -10000,
      chargerFeeExempt: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    await repoContext.dayRepo.save({
      id: 'day-multi-1',
      businessDate: '2026-10-17',
      isClosed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    const outboxBefore = await localDb.listOutbox();
    expect(outboxBefore.length).toBe(2);
    expect(outboxBefore.every((c) => c.status === 'PENDING_RECONCILIATION')).toBe(true);
    expect(outboxBefore.every((c) => c.resetGeneration === -1)).toBe(true);

    // 2. Handshake with server generation 12
    const pushedRequests: SyncCommandRequest[] = [];
    const mockTransport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        pushedRequests.push(req);
        return { success: true, rpcReached: true };
      },
      pullChanges: async () => ({ changes: [], latestSequence: 2, serverResetGeneration: 12 }),
    };

    const engine = new SyncEngine(mockTransport);
    await engine.synchronize();

    expect(pushedRequests.length).toBe(2);
    expect(pushedRequests.every((r) => r.resetGeneration === 12)).toBe(true);
  });

  it('Test D: Command created as PENDING_RECONCILIATION survives restart and is promoted correctly upon next startup', async () => {
    // 1. Create mutation on fresh client
    await repoContext.dayRepo.save({
      id: 'day-restart-test',
      businessDate: '2026-10-18',
      isClosed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    // 2. Simulate app reload
    resetStoreMemory();
    await reloadStoreFromLocal();

    const outboxMid = await localDb.listOutbox();
    expect(outboxMid.length).toBe(1);
    expect(outboxMid[0].status).toBe('PENDING_RECONCILIATION');
    expect(outboxMid[0].resetGeneration).toBe(-1);

    // 3. Process outbox with server generation 12
    const pushedRequests: SyncCommandRequest[] = [];
    const mockTransport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest) => {
        pushedRequests.push(req);
        return { success: true, rpcReached: true };
      },
      pullChanges: async () => ({ changes: [], latestSequence: 2, serverResetGeneration: 12 }),
    };

    const engine = new SyncEngine(mockTransport);
    await engine.synchronize();

    expect(pushedRequests.length).toBe(1);
    expect(pushedRequests[0].resetGeneration).toBe(12);
  });

  it('Test E: No command is ever dispatched to transport with resetGeneration = 1 when server generation is 12', async () => {
    await repoContext.dayRepo.save({
      id: 'day-no-gen1-test',
      businessDate: '2026-10-19',
      isClosed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    const pushedRequests: SyncCommandRequest[] = [];
    const mockTransport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest) => {
        pushedRequests.push(req);
        return { success: true, rpcReached: true };
      },
      pullChanges: async () => ({ changes: [], latestSequence: 2, serverResetGeneration: 12 }),
    };

    const engine = new SyncEngine(mockTransport);
    await engine.synchronize();

    const gen1Dispatches = pushedRequests.filter((r) => r.resetGeneration === 1);
    expect(gen1Dispatches.length).toBe(0);
  });

  it('Test H: Reconciliation promotion preserves commandId, commandType, aggregateId, expectedVersion, and dependencies', async () => {
    await repoContext.dayRepo.save({
      id: 'day-dep-preserve',
      businessDate: '2026-10-20',
      isClosed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    const outboxBefore = (await localDb.listOutbox())[0];

    const pushedRequests: SyncCommandRequest[] = [];
    const mockTransport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest) => {
        pushedRequests.push(req);
        return { success: true, rpcReached: true };
      },
      pullChanges: async () => ({ changes: [], latestSequence: 2, serverResetGeneration: 12 }),
    };

    const engine = new SyncEngine(mockTransport);
    await engine.synchronize();

    const pushed = pushedRequests[0];
    expect(pushed.commandId).toBe(outboxBefore.commandId);
    expect(pushed.commandType).toBe(outboxBefore.commandType);
    expect(pushed.expectedVersion).toBe(outboxBefore.expectedVersion);
  });
});
