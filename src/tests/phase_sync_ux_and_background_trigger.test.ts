import { describe, it, expect, beforeEach, vi, type MockInstance } from 'vitest';
import {
  addNewCustomer,
  globalSyncEngine,
  resetStoreMemory,
  clearAllOperationalData,
  refreshStoreFromRemote,
} from '../components/pages/dayOrdersStore';
import { localDb } from '../infrastructure/localDb/localDb';
import { globalSyncBridge } from '../infrastructure/sync/syncBridge';
import { initializeCanonicalSyncState } from './utils/testSetup';

describe('SYNC UX + BACKGROUND SYNC — TARGETED FIX AUDIT', () => {
  beforeEach(async () => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
    await clearAllOperationalData();
    await initializeCanonicalSyncState();
    resetStoreMemory();
    vi.restoreAllMocks();
  });

  describe('Part A & I & J — CREATE_CUSTOMER Background Sync Trigger', () => {
    it('should queue CREATE_CUSTOMER and trigger non-blocking globalSyncEngine.synchronize', async () => {
      const syncSpy = vi.spyOn(globalSyncEngine, 'synchronize').mockImplementation(async () => {
        return { pushed: 0, pulled: 0 };
      });

      // 1. Create customer
      const cust = await addNewCustomer('عميل فحص الخلفية', '0599000111');
      expect(cust.id).toBeDefined();

      // 2. Verify local customer exists
      const localCust = await localDb.get('customers', cust.id) as any;
      expect(localCust).toBeDefined();
      expect(localCust.name).toBe('عميل فحص الخلفية');

      // 3. Verify Outbox command exists
      const outboxList = await localDb.listOutbox();
      expect(outboxList.length).toBe(1);
      expect(outboxList[0].commandType).toBe('CREATE_CUSTOMER');
      expect(outboxList[0].commandId).toBe(cust.id);
      expect(outboxList[0].status).toBe('pending'); // No manual override of state

      // 4. Verify background sync is triggered
      expect(syncSpy).toHaveBeenCalledTimes(1);
    });

    it('must never duplicate command in outbox on background sync trigger', async () => {
      vi.spyOn(globalSyncEngine, 'synchronize').mockResolvedValue({ pushed: 0, pulled: 0 });

      await addNewCustomer('عميل فريد', '0599111222');
      const firstOutboxList = await localDb.listOutbox();
      expect(firstOutboxList.length).toBe(1);

      await globalSyncEngine.synchronize();

      const secondOutboxList = await localDb.listOutbox();
      expect(secondOutboxList.length).toBe(1); // Still exactly 1
    });
  });

  describe('Part B — Background Failure Safety', () => {
    it('should safely preserve outbox item and local state when background sync fails', async () => {
      // Mock synchronize to fail
      vi.spyOn(globalSyncEngine, 'synchronize').mockRejectedValue(new Error('Network disconnected'));

      const cust = await addNewCustomer('عميل غير متصل', '0599000222');

      // Local customer must survive
      const localCust = await localDb.get('customers', cust.id);
      expect(localCust).toBeDefined();

      // Outbox must remain pending/available
      const outboxItem = await localDb.getOutbox(cust.id);
      expect(outboxItem).toBeDefined();
      expect(outboxItem?.status).toBe('pending'); // Stays pending, no data loss
    });
  });

  describe('Part H — Manual Sync Now Regression', () => {
    it('should continue executing manual sync correctly', async () => {
      const resumeSpy = vi.spyOn(globalSyncEngine, 'resumePendingOutbox').mockResolvedValue(0);
      const syncSpy = vi.spyOn(globalSyncEngine, 'synchronize').mockResolvedValue({ pushed: 1, pulled: 0 });

      await globalSyncBridge.requestManualSync();

      expect(resumeSpy).toHaveBeenCalledTimes(1);
      expect(syncSpy).toHaveBeenCalledTimes(1);
    });
  });
});
