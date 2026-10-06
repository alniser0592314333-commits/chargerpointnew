
import { describe, test, expect, beforeEach, vi as jest } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { SyncEngine, MockServerSyncTransport } from '../infrastructure/sync/syncEngine';
import { FinalUseCases } from '../application/useCases';
import { AuthorizationContext } from '../application/authContext';
import { ID } from '../types/common';

describe('Architectural Verification: Restore & Reset Generation', () => {
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
    
    // Mock repoContext and useCases
    const mockRepo: any = {
      customerRepo: { save: (c: any) => localDb.set('customers', c.id, c), findById: (id: string) => localDb.get('customers', id) },
      dayRepo: { save: (d: any) => localDb.set('businessDays', d.id, d), findById: (id: string) => localDb.get('businessDays', id), isClosed: () => false },
      deviceRepo: { save: (d: any) => localDb.set('deviceTypes', d.id, d), findById: (id: string) => localDb.get('deviceTypes', id), findAll: () => localDb.list('deviceTypes') },
      commandRepo: { 
        record: (id: ID, type: string, payload: any, expectedVersion?: number) => {
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
             expectedVersion,
             createdAt: new Date().toISOString(),
             deviceId: 'device-1',
             actorAdminId: 'admin-1',
             status: gen === -1 ? 'PENDING_RECONCILIATION' : 'pending',
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

  test('Verification Scenario 1: Restore (gen 1) -> Reconcile (gen 9) -> Mutate', async () => {
    jest.spyOn(transport, 'pullChanges').mockResolvedValue({ changes: [], latestSequence: 100, serverResetGeneration: 9 });
    await localDb.setSyncState({ table: 'global', resetGeneration: 1, status: 'RECONCILIATION_REQUIRED' } as any);
    const customerId = 'c1';
    await useCases.createCustomer(adminAuth, 'Test', '123', 0, false, customerId);
    await syncEngine.synchronize();
    const cmd = (await localDb.listOutbox()).find(o => o.commandType === 'CREATE_CUSTOMER');
    expect(cmd).toBeUndefined();
    const history = await localDb.getHistoryByCommandId(customerId);
    expect(['SUCCESS', 'SUCCEEDED']).toContain(history?.state);
  });

  test('Verification Scenario 2: Device Type Reorder', async () => {
    const dev1 = { id: 'd1', name: 'S', sortOrder: 0, version: 1 };
    await localDb.set('deviceTypes', dev1.id, dev1);
    await useCases.reorderDeviceTypes(adminAuth, [{ id: 'd1', sortOrder: 1 }]);
    const outbox = await localDb.listOutbox();
    expect(outbox.filter(o => o.commandType === 'UPDATE_DEVICE_TYPE').length).toBe(1);
  });

  test('Verification Scenario 3: Version Conflict', async () => {
    const customerId = 'cust-1';
    await localDb.set('customers', customerId, { id: customerId, name: 'Old', version: 5 });
    await localDb.setSyncState({ table: 'global', resetGeneration: 9, status: 'READY' } as any);

    await useCases.createCustomer(adminAuth, 'New Name', '123', 5, false, customerId);

    jest.spyOn(transport, 'pushCommand').mockResolvedValue({ success: false, code: 'VERSION_CONFLICT' });
    await syncEngine.synchronize();

    const cmd = (await localDb.listOutbox()).find(o => o.commandType === 'CREATE_CUSTOMER');
    expect(cmd?.status).toBe('conflict');
  });

  test('Verification Scenario 4: Successful Sync (Version match)', async () => {
    const customerId = 'cust-2';
    await localDb.set('customers', customerId, { id: customerId, name: 'Current', version: 5 });
    await useCases.createCustomer(adminAuth, 'New', '123', 5, false, customerId);
    jest.spyOn(transport, 'pushCommand').mockResolvedValue({ success: true });
    await syncEngine.synchronize();
    const active = await localDb.listOutbox();
    expect(active).toHaveLength(0);
  });

  test('Verification Scenario 5: Command ID consistency', async () => {
    await localDb.setSyncState({ table: 'global', resetGeneration: 1, status: 'RECONCILIATION_REQUIRED' } as any);
    const cmdId = 'id-1';
    await useCases.createCustomer(adminAuth, 'Test', '123', 0, false, cmdId);
    jest.spyOn(transport, 'pullChanges').mockResolvedValue({ changes: [], latestSequence: 0, serverResetGeneration: 9 });
    await syncEngine.synchronize();
    const cmd = (await localDb.listOutbox()).find(o => o.commandId === cmdId);
    expect(cmd).toBeUndefined();
    const history = await localDb.getHistoryByCommandId(cmdId);
    expect(['SUCCESS', 'SUCCEEDED']).toContain(history?.state);
  });

  test('Verification Scenario 6: Stale command rejection', async () => {
    const cmdId = 'stale-1';
    await localDb.saveOutbox({ commandId: cmdId, commandType: 'TEST', status: 'pending', resetGeneration: 1 } as any);
    jest.spyOn(transport, 'pushCommand').mockResolvedValue({ success: false, postgresSqlstate: 'P0002' });
    await syncEngine.synchronize();
    expect((await localDb.listOutbox())[0].status).toBe('rejected');
  });
});
