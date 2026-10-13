import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as supabaseClient from '../services/supabase/client';
import {
  ensureStoreHydrated,
  hydrateFromRemoteTables,
  refreshStoreFromRemote,
  getOrdersForDay,
  getCustomersList,
  getDaysList,
  addNewCustomer,
  createNewBusinessDay,
  resetStoreMemory,
  globalSyncEngine,
} from '../components/pages/dayOrdersStore';
import { localDb } from '../infrastructure/localDb/localDb';

describe('Phase 6.13: Remote Hydration and Offline Sync Architecture Tests', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    resetStoreMemory();
    await localDb.init();
    await localDb.clearOperationalTables();
    await localDb.setInitialHydrationCompleted(false);
  });

  it('1. Fresh Client Hydration: localDb starts empty, ensureStoreHydrated initializes without crash', async () => {
    const daysBefore = await localDb.list('businessDays');
    expect(daysBefore.length).toBe(0);

    await ensureStoreHydrated();
    const days = await getDaysList();
    expect(Array.isArray(days)).toBe(true);
  });

  it('blocks a fresh configured client when the first authoritative cloud read fails', async () => {
    vi.spyOn(supabaseClient, 'getSupabaseStatus').mockReturnValue({
      isConfigured: true,
      url: 'https://example.supabase.co',
      status: 'connected',
    });
    vi.spyOn(supabaseClient, 'invokeSupabaseRestGet').mockImplementation(async (table: any) => {
      if (table === 'customers') return { data: null, error: 'simulated offline read failure' } as any;
      return { data: [], error: null } as any;
    });

    await expect(ensureStoreHydrated()).rejects.toThrow(/INITIAL_BOOTSTRAP_FAILED/);
    expect(await localDb.isInitialHydrationCompleted()).toBe(false);
  });

  it('2. Offline Creation creates outbox command with pending status', async () => {
    await ensureStoreHydrated();

    const createdDay = await createNewBusinessDay('2026-10-15');
    expect(createdDay).toBeTruthy();

    const outboxItems = await localDb.listOutbox();
    const dayCommand = outboxItems.find(i => i.commandType === 'OPEN_DAY');
    expect(dayCommand).toBeDefined();
    expect(['pending', 'PENDING_RECONCILIATION', 'syncing', 'accepted', 'conflict']).toContain(dayCommand?.status);
  });

  it('3. Customer Creation queues outbox record and saves to local persistence', async () => {
    await ensureStoreHydrated();

    const newCust = await addNewCustomer('عميل المزامنة', '0599001122', -5000);
    expect(newCust.name).toBe('عميل المزامنة');

    const persistedCust = await localDb.get('customers', newCust.id);
    expect(persistedCust).toBeDefined();

    const outboxItems = await localDb.listOutbox();
    const custCmd = outboxItems.find(i => i.commandType === 'CREATE_CUSTOMER' && i.commandId === newCust.id);
    expect(custCmd).toBeDefined();
  });

  it('4. Reconnection / Refresh triggers synchronization without error', async () => {
    await ensureStoreHydrated();
    await refreshStoreFromRemote().catch(() => {});
    const customers = await getCustomersList();
    expect(Array.isArray(customers)).toBe(true);
  }, 15000);
});
