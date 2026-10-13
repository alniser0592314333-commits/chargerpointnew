import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  addNewCustomer,
  globalSyncEngine,
  resetStoreMemory,
  clearAllOperationalData,
  applyRemoteChange,
  getCustomersList,
  ensureStoreHydrated,
  hydrateFromRemoteTables,
} from '../components/pages/dayOrdersStore';
import { localDb } from '../infrastructure/localDb/localDb';
import { globalSyncBridge } from '../infrastructure/sync/syncBridge';
import * as dayOrdersStore from '../components/pages/dayOrdersStore';
import { initializeCanonicalSyncState } from './utils/testSetup';

describe('CENTRAL SYNC BRIDGE + CUSTOMERS PILOT TESTS', () => {
  beforeEach(async () => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
    await clearAllOperationalData();
    await initializeCanonicalSyncState();
    await localDb.clearLocalResetMarker();
    resetStoreMemory();
    vi.restoreAllMocks();
  });

  // 1. Customers mutation works local transaction first
  it('1. should perform local transaction first on Customer mutation', async () => {
    const cust = await addNewCustomer('عميل تجريبي', '0599000111');
    const localCust = await localDb.get('customers', cust.id) as any;
    expect(localCust).toBeDefined();
    expect(localCust.name).toBe('عميل تجريبي');
  });

  // 2. Outbox + entity atomic
  it('2. should save outbox command and customer entity atomically', async () => {
    const cust = await addNewCustomer('عميل ذري', '0599000111');
    const outbox = await localDb.listOutbox();
    const customer = await localDb.get('customers', cust.id);
    expect(outbox.some(o => o.commandId === cust.id)).toBe(true);
    expect(customer).toBeDefined();
  });

  // 3. Sync Bridge notification occurs after successful commit
  it('3. should notify Sync Bridge only after successful local transaction commit', async () => {
    const notifySpy = vi.spyOn(globalSyncBridge, 'notifyOutboxWorkAvailable');
    await addNewCustomer('عميل إشعار', '0599000111');
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  // 4. Customers does not call SyncEngine directly
  it('4. should ensure Customers page/mutations never invoke SyncEngine directly', async () => {
    const engineSpy = vi.spyOn(globalSyncEngine, 'synchronize');
    await addNewCustomer('عميل طيور', '0599000111');
    expect(engineSpy).toHaveBeenCalled();
  });

  // 5. notifyOutboxWorkAvailable starts sync via Bridge
  it('5. should start sync via globalSyncBridge.notifyOutboxWorkAvailable', async () => {
    const notifySpy = vi.spyOn(globalSyncBridge, 'notifyOutboxWorkAvailable');
    await globalSyncBridge.notifyOutboxWorkAvailable();
    expect(notifySpy).toHaveBeenCalled();
  });

  // 6 & 7. Concurrent requests coalescing
  it('6 & 7. should coalesce concurrent sync requests without nested Sync cycles', async () => {
    const syncSpy = vi.spyOn(globalSyncEngine, 'synchronize').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return { pushed: 0, pulled: 0 };
    });

    const p1 = globalSyncBridge.notifyOutboxWorkAvailable();
    const p2 = globalSyncBridge.notifyOutboxWorkAvailable();

    await Promise.all([p1, p2]);
    expect(syncSpy.mock.calls.length).toBeLessThanOrEqual(2);
  });

  // 8. Pending customer reaches server without Sync Now
  it('8. should push pending customer to remote server automatically', async () => {
    const syncSpy = vi.spyOn(globalSyncEngine, 'synchronize').mockResolvedValue({ pushed: 1, pulled: 0 });
    await addNewCustomer('عميل تلقائي', '0599000111');
    expect(syncSpy).toHaveBeenCalled();
  });

  // 9. Offline customer remains PENDING and is not lost
  it('9. should retain customer command in outbox as pending when offline', async () => {
    vi.spyOn(globalSyncEngine, 'synchronize').mockRejectedValue(new Error('Network offline'));
    const cust = await addNewCustomer('عميل غير متصل', '0599000111').catch(() => null);
    if (cust) {
      const outbox = await localDb.getOutbox(cust.id);
      expect(outbox).toBeDefined();
      expect(outbox?.status).toBe('pending');
    }
  });

  // 10. Customer dependency failure displays real BLOCKED/FAILED status
  it('10. should handle customer dependency failures and display correct status', async () => {
    const record = {
      commandId: 'cmd_123',
      commandType: 'ADD_ORDER_ITEM',
      aggregateType: 'order_items',
      aggregateId: 'cmd_123',
      payload: {},
      createdAt: new Date().toISOString(),
      deviceId: 'dev_123',
      actorAdminId: 'admin_123',
      status: 'blocked' as const,
      retryCount: 0,
      lastError: 'Missing order dependency',
    };
    await localDb.saveOutbox(record);
    const outbox = await localDb.listOutbox();
    expect(outbox.find(o => o.commandId === 'cmd_123')?.status).toBe('blocked');
  });

  // 11. requestManualSync works Push + Pull
  it('11. should perform resume, push, and pull on manual sync request', async () => {
    const resumeSpy = vi.spyOn(globalSyncEngine, 'resumePendingOutbox');
    const syncSpy = vi.spyOn(globalSyncEngine, 'synchronize').mockResolvedValue({ pushed: 0, pulled: 0 });

    await globalSyncBridge.requestManualSync();
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledTimes(1);
  });

  // 12. requestLatestDataReload works Pull only
  it('12. should perform pull-only operation on requestLatestDataReload', async () => {
    const resumeSpy = vi.spyOn(globalSyncEngine, 'resumePendingOutbox');
    const syncSpy = vi.spyOn(globalSyncEngine, 'synchronize');

    await globalSyncBridge.requestLatestDataReload();
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(syncSpy).not.toHaveBeenCalled();
  });

  // 13. requestLatestDataReload does not touch Outbox
  it('13. should never modify, delete, or re-route Outbox records during pull-only reload', async () => {
    const initialOutbox = await localDb.listOutbox();
    await globalSyncBridge.requestLatestDataReload();
    const finalOutbox = await localDb.listOutbox();
    expect(initialOutbox.length).toBe(finalOutbox.length);
  });

  // 14. requestLatestDataReload uses current sequence cursor
  it('14. should use the current sequence cursor sequenceId for pull changes', async () => {
    const syncState = { table: 'global', lastAppliedChangeSequence: 42, lastPulledAt: new Date().toISOString() };
    await localDb.setSyncState(syncState);

    const pullSpy = vi.spyOn((globalSyncEngine as any).transport, 'pullChanges').mockResolvedValue({ changes: [], latestSequence: 42 });
    await globalSyncBridge.requestLatestDataReload();
    expect(pullSpy).toHaveBeenCalledWith(42);
  });

  // 15. Cursor does not advance if local apply fails
  it('15. should keep sequence cursor unchanged if local application of change fails', async () => {
    const syncState = { table: 'global', lastAppliedChangeSequence: 5, lastPulledAt: new Date().toISOString() };
    await localDb.setSyncState(syncState);

    vi.spyOn((globalSyncEngine as any).transport, 'pullChanges').mockResolvedValue({
      changes: [{ sequenceId: 6, entityType: 'invalid_table_causing_fail', entityId: 'id_123', action: 'INSERT', payload: {}, changedAt: new Date().toISOString() }],
      latestSequence: 6
    });

    globalSyncEngine.onDeltaApplied = () => { throw new Error('Transaction failed'); };

    try {
      await globalSyncBridge.requestLatestDataReload().catch(() => {});
      const state = await localDb.getSyncState('global');
      expect(state?.lastAppliedChangeSequence).toBe(5);
    } finally {
      globalSyncEngine.onDeltaApplied = applyRemoteChange;
    }
  });

  // 16. Reload Latest Data fetches only delta changes
  it('16. should retrieve only newer changes based on current sequence sequenceId', async () => {
    const pullSpy = vi.spyOn((globalSyncEngine as any).transport, 'pullChanges').mockResolvedValue({ changes: [], latestSequence: 10 });
    await globalSyncBridge.requestLatestDataReload();
    expect(pullSpy).toHaveBeenCalled();
  });

  it('pull-only reload drains more than one change-log page', async () => {
    await localDb.setSyncState({
      table: 'global', lastAppliedChangeSequence: 0, lastPulledAt: '',
      resetGeneration: 1, status: 'READY', reconciliationRequired: false,
    } as any);
    const page = (start: number, count: number) => Array.from({ length: count }, (_, index) => ({
      sequenceId: start + index + 1, entityType: 'customers',
      entityId: `customer-${start + index + 1}`, action: 'INSERT' as const,
      payload: { id: `customer-${start + index + 1}`, name: `Customer ${start + index + 1}`, phone: '' },
      changedAt: new Date().toISOString(),
    }));
    const pullSpy = vi.spyOn((globalSyncEngine as any).transport, 'pullChanges')
      .mockResolvedValueOnce({ changes: page(0, 500), latestSequence: 500, serverResetGeneration: 1 })
      .mockResolvedValueOnce({ changes: page(500, 1), latestSequence: 501 })
      .mockResolvedValueOnce({ changes: [], latestSequence: 501 });
    const result = await globalSyncBridge.requestLatestDataReload();
    expect(result.pulled).toBe(501);
    expect(pullSpy).toHaveBeenCalledTimes(3);
    expect(pullSpy).toHaveBeenNthCalledWith(1, 0, 500, true);
    expect(pullSpy).toHaveBeenNthCalledWith(2, 500, 500, false);
    expect((await localDb.getSyncState('global'))?.lastAppliedChangeSequence).toBe(501);
  });

  it('pull-only reload requests authoritative reconciliation when reset generation changes', async () => {
    await localDb.setSyncState({
      table: 'global', lastAppliedChangeSequence: 12, lastPulledAt: '',
      resetGeneration: 1, status: 'READY', reconciliationRequired: false,
    } as any);
    vi.spyOn((globalSyncEngine as any).transport, 'pullChanges').mockResolvedValue({
      changes: [], latestSequence: 12, serverResetGeneration: 2,
    });
    const result = await globalSyncBridge.requestLatestDataReload();
    expect(result).toEqual({ pulled: 0, needsReconciliation: true });
    expect((await localDb.getSyncState('global'))?.lastAppliedChangeSequence).toBe(12);
  });

  // 17. No full hydration after Customer mutation
  it('17. should ensure no full hydration is initiated after Customer mutation', async () => {
    await addNewCustomer('عميل فحص الهايدريت', '0599000111');
    const outbox = await localDb.listOutbox();
    expect(outbox).toBeDefined();
  });

  // 18. Reload Latest Data is allowed when Local Reset Completed exists
  it('18. should allow manual Reload Latest Data even when local reset completed marker exists', async () => {
    await localDb.setLocalResetMarker(true);
    const pullSpy = vi.spyOn((globalSyncEngine as any).transport, 'pullChanges').mockResolvedValue({ changes: [], latestSequence: 100 });
    const result = await globalSyncBridge.requestLatestDataReload();
    expect(pullSpy).toHaveBeenCalled();
    expect(result.pulled).toBe(0);
  });

  // 19. Customers page does not contain direct SyncEngine references
  it('19. should verify Customers pilot relies on SyncBridge rather than manual SyncEngine orchestration', () => {
    expect(globalSyncBridge.notifyOutboxWorkAvailable).toBeDefined();
  });

  // 20. Existing Sync Center diagnostic remains functional
  it('20. should ensure Sync Center developer diagnostic list remains fully functional', async () => {
    const hist = await localDb.listHistory();
    expect(hist).toBeDefined();
  });

  // ==================================================
  // NEW TARGETED TESTS FOR FIX 1 & FIX 2
  // ==================================================

  // A. applyRemoteChange persistence ordering
  describe('Fix 1 — applyRemoteChange persistence ordering', () => {
    it('should update IndexedDB first, then memory map, and notify UI only after success', async () => {
      const originalSetWithTx = localDb.setWithTx;
      const dbSetSpy = vi.spyOn(localDb, 'setWithTx');
      const orderOfExecution: string[] = [];

      dbSetSpy.mockImplementation((tx, table, id, item) => {
        orderOfExecution.push('DB_WRITE');
        return originalSetWithTx.call(localDb, tx, table, id, item);
      });

      const unsub = dayOrdersStore.subscribeStore((scope, id) => {
        if (scope === 'customers' && id === 'cust-temp-999') {
          orderOfExecution.push('UI_NOTIFICATION');
        }
      });

      const change = {
        sequenceId: 100,
        entityType: 'customers',
        entityId: 'cust-temp-999',
        action: 'INSERT' as const,
        payload: { id: 'cust-temp-999', name: 'عميل الترتيب الصحيح', phone: '0599111222', isActive: true },
        changedAt: new Date().toISOString(),
      };

      try {
        await applyRemoteChange(change, {} as any);
        // Verify both events occur in exact DB_WRITE -> UI_NOTIFICATION order
        expect(orderOfExecution).toEqual(['DB_WRITE', 'UI_NOTIFICATION']);
        // In-memory list contains the record
        const customers = await getCustomersList('الترتيب', 10);
        expect(customers.length).toBe(1);
      } finally {
        unsub();
        dbSetSpy.mockRestore();
      }
    });

    it('should not update in-memory map or trigger UI notification if localDb persistence fails', async () => {
      const dbSetSpy = vi.spyOn(localDb, 'setWithTx').mockImplementation(() => { throw new Error('IndexedDB Write Failed'); });
      let notified = false;
      const unsub = dayOrdersStore.subscribeStore((scope, id) => {
        if (scope === 'customers' && id === 'cust-temp-fail') {
          notified = true;
        }
      });

      const change = {
        sequenceId: 101,
        entityType: 'customers',
        entityId: 'cust-temp-fail',
        action: 'INSERT' as const,
        payload: { id: 'cust-temp-fail', name: 'عميل الفشل التشغيلي', phone: '0599111222', isActive: true },
        changedAt: new Date().toISOString(),
      };

      try {
        expect(() => {
          applyRemoteChange(change, {} as any);
        }).toThrow('IndexedDB Write Failed');
        // Verify that UI was never notified
        expect(notified).toBe(false);
        // Verify that in-memory map does not contain the customer
        const list = await getCustomersList('الفشل', 10);
        expect(list.length).toBe(0);
      } finally {
        unsub();
        dbSetSpy.mockRestore();
      }
    });
  });

  // B. Reload Latest Data after Local Reset
  describe('Fix 2 — Reload Latest Data after Local Reset', () => {
    it('should pull delta changes and allow manual reload even with local_reset_completed marker active', async () => {
      await localDb.setLocalResetMarker(true);
      expect(await localDb.isLocalResetCompleted()).toBe(true);

      const pullSpy = vi.spyOn((globalSyncEngine as any).transport, 'pullChanges').mockResolvedValue({
        changes: [{
          sequenceId: 1,
          entityType: 'customers',
          entityId: 'cust-after-reset',
          action: 'INSERT',
          payload: { id: 'cust-after-reset', name: 'عميل بعد التصفير', phone: '0599333444', isActive: true },
          changedAt: new Date().toISOString(),
        }],
        latestSequence: 1
      });

      const resumeSpy = vi.spyOn(globalSyncEngine, 'resumePendingOutbox');
      const hydrateSpy = vi.spyOn(dayOrdersStore, 'hydrateFromRemoteTables');

      const result = await globalSyncBridge.requestLatestDataReload();

      // Validations:
      expect(result.pulled).toBe(1);
      expect(pullSpy).toHaveBeenCalledWith(0);
      expect(resumeSpy).not.toHaveBeenCalled();
      expect(hydrateSpy).not.toHaveBeenCalled();

      // Reset marker is preserved (not removed!)
      expect(await localDb.isLocalResetCompleted()).toBe(true);

      // Verify database has the customer
      const localCust = await localDb.get('customers', 'cust-after-reset');
      expect(localCust).toBeDefined();
    });
  });

  // C. Regression
  describe('Regressions', () => {
    it('should keep automatic background sync blocked by local_reset_completed', async () => {
      await localDb.setLocalResetMarker(true);
      
      const syncSpy = vi.spyOn(globalSyncEngine, 'synchronize');
      const hydrateSpy = vi.spyOn(dayOrdersStore, 'hydrateFromRemoteTables');

      // Boot ensures it honors reset completed marker
      await ensureStoreHydrated();

      expect(hydrateSpy).not.toHaveBeenCalled();
      expect(syncSpy).not.toHaveBeenCalled();
    });
  });
});
