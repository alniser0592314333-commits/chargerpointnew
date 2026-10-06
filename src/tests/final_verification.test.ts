
import { describe, test, expect, beforeEach, vi as jest } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { SyncEngine, MockServerSyncTransport } from '../infrastructure/sync/syncEngine';
import { FinalUseCases } from '../application/useCases';
import { AuthorizationContext } from '../application/authContext';
import { ID } from '../types/common';

describe('Final Real-World Verification', () => {
  let syncEngine: SyncEngine;
  let transport: MockServerSyncTransport;
  let useCases: any;
  const adminAuth = new AuthorizationContext(
    { 
      id: 'admin-1', 
      username: 'admin', 
      fullName: 'Admin User',
      role: 'SUPER_ADMIN', 
      permissions: ['settings:manage', 'customers:create', 'devices:manage', 'orders:create'],
      isSuperAdmin: true
    },
    async () => true
  );

  beforeEach(async () => {
    await localDb.init();
    await localDb.clear();
    transport = new MockServerSyncTransport();
    syncEngine = new SyncEngine(transport);
    
    // Mock repoContext to match dayOrdersStore behavior
    const mockRepo: any = {
      customerRepo: { 
        save: (c: any) => localDb.set('customers', c.id, c), 
        findById: (id: string) => localDb.get('customers', id),
        getBalance: () => 0
      },
      dayRepo: { 
        save: (d: any) => localDb.set('businessDays', d.id, d), 
        findById: (id: string) => localDb.get('businessDays', id), 
        isClosed: () => false 
      },
      deviceRepo: { 
        save: (d: any) => localDb.set('deviceTypes', d.id, d), 
        findById: (id: string) => localDb.get('deviceTypes', id), 
        findAll: () => localDb.list('deviceTypes') 
      },
      commandRepo: { 
        record: (id: ID, type: string, payload: any) => {
           // Simulate getCurrentSyncGeneration implementation
           const syncState = localDb.getSyncStateSync('global');
           let gen = syncState?.resetGeneration ?? 1;
           if (syncState?.status === 'RECONCILIATION_REQUIRED' || syncState?.reconciliationRequired) {
             gen = -1;
           }
           
           const record: any = {
             commandId: id,
             commandType: type,
             aggregateType: 'TEST',
             aggregateId: id,
             payload: { ...(payload || {}), resetGeneration: gen },
             createdAt: new Date().toISOString(),
             deviceId: 'device-1',
             actorAdminId: 'admin-1',
             status: 'pending',
             retryCount: 0,
             resetGeneration: gen,
           };
           (localDb as any).memoryOutbox.set(id, record);
        },
        get: () => null
      },
      transactionManager: { runInTransaction: (work: any) => work(mockRepo) }
    };
    useCases = new FinalUseCases(mockRepo);
  });

  test('Closing Test 1: Mutation during RECONCILIATION_REQUIRED', async () => {
    console.log('1. Simulating Restore (gen 1) -> RECONCILIATION_REQUIRED');
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 0,
      lastPulledAt: '',
      resetGeneration: 1,
      status: 'RECONCILIATION_REQUIRED'
    });

    console.log('2. Performing Mutation (Create Device Type) while status=RECONCILIATION_REQUIRED');
    const deviceId = '00000000-0000-4000-a000-000000000111';
    await useCases.createDeviceType(adminAuth, 'New Device', 'smartphone', 5000, true);
    
    // Mutation is recorded but command is gen -1
    const device = await localDb.get('deviceTypes', deviceId);
    expect(device).toBeDefined();
    
    const outboxBefore = await localDb.listOutbox();
    const cmd = outboxBefore.find(o => o.commandType === 'CREATE_DEVICE_TYPE');
    expect(cmd).toBeDefined();
    expect(cmd?.resetGeneration).toBe(-1);
    expect(cmd?.status).toBe('pending');

    console.log('3. Completing Reconciliation Handshake (Server Gen 9)');
    jest.spyOn(transport, 'pullChanges').mockResolvedValue({
      changes: [],
      latestSequence: 0,
      serverResetGeneration: 9
    });
    
    await syncEngine.synchronize();

    console.log('4. Checking Outbox status after reconciliation');
    const outboxAfter = await localDb.listOutbox();
    const cmdAfter = outboxAfter.find(o => o.commandType === 'CREATE_DEVICE_TYPE');
    
    // CURRENT BEHAVIOR: It is rejected
    console.log(`Command status: ${cmdAfter?.status}, resetGeneration: ${cmdAfter?.resetGeneration}`);
    expect(cmdAfter).toBeUndefined();
    const historyAfter = await localDb.getHistoryByCommandId(cmd!.commandId);
    expect(['SUCCESS', 'SUCCEEDED']).toContain(historyAfter?.state);
    
    console.log('5. Verifying Local DB (Mutation NOT lost)');
    const deviceStillExists = await localDb.get('deviceTypes', deviceId);
    expect(deviceStillExists).toBeDefined();
  });

  test('Closing Test 2: Mutation AFTER Reconciliation', async () => {
    console.log('1. Completing Handshake (Server Gen 9)');
    jest.spyOn(transport, 'pullChanges').mockResolvedValue({
      changes: [],
      latestSequence: 0,
      serverResetGeneration: 9
    });
    await syncEngine.synchronize();
    
    const state = await localDb.getSyncState('global');
    expect(state?.resetGeneration).toBe(9);
    expect(state?.status).toBe('READY');

    console.log('2. Creating Customer');
    const customerId = '00000000-0000-4000-a000-000000000222';
    await useCases.createCustomer(adminAuth, 'Verification Customer', '999', 0, false, customerId);
    
    const cmd = (await localDb.listOutbox()).find(o => o.commandType === 'CREATE_CUSTOMER');
    expect(cmd?.resetGeneration).toBe(9);
    expect(cmd?.status).toBe('pending');

    console.log('3. Syncing to Server');
    const pushSpy = jest.spyOn(transport, 'pushCommand').mockResolvedValue({ success: true, rpcReached: true });
    await syncEngine.synchronize();
    
    expect(pushSpy).toHaveBeenCalledWith(expect.objectContaining({
      commandType: 'CREATE_CUSTOMER',
      resetGeneration: 9
    }));
    
    const cmdFinal = (await localDb.listOutbox()).find(o => o.commandType === 'CREATE_CUSTOMER');
    expect(cmdFinal).toBeUndefined();
    const historyFinal = await localDb.getHistoryByCommandId(cmd!.commandId);
    expect(['SUCCESS', 'SUCCEEDED']).toContain(historyFinal?.state);
  });
});
