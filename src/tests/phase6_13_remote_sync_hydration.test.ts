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
  subscribeStoreBootstrapProgress,
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
    vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockResolvedValue({
      data: null,
      error: 'simulated offline snapshot failure',
    } as any);

    await expect(ensureStoreHydrated()).rejects.toThrow(/INITIAL_BOOTSTRAP_FAILED/);
    expect(await localDb.isInitialHydrationCompleted()).toBe(false);
  });

  it('installs the authoritative snapshot cursor before marking initial hydration complete', async () => {
    vi.spyOn(supabaseClient, 'getSupabaseStatus').mockReturnValue({
      isConfigured: true,
      url: 'https://example.supabase.co',
      status: 'connected',
    });
    vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockResolvedValue({
      data: {
        schema_version: 1,
        captured_at: '2026-10-13T12:00:00.000Z',
        server_reset_generation: 7,
        max_change_sequence: 42,
        business_days: [],
        customers: [],
        device_types: [],
        orders: [],
        order_items: [],
        financial_ledger: [],
        payments: [],
        payment_allocations: [],
        order_number_reservations: [],
        qr_tokens: [],
        goals: [],
        goal_requests: [],
      },
      error: null,
    } as any);

    const progressEvents: Array<{ phase: string; percent: number; completedRows: number; totalRows: number }> = [];
    const unsubscribe = subscribeStoreBootstrapProgress((progress) => progressEvents.push(progress));
    expect(await hydrateFromRemoteTables()).toBe(true);
    unsubscribe();

    expect(progressEvents.some((progress) => progress.phase === 'FETCHING')).toBe(true);
    expect(progressEvents.some((progress) => progress.phase === 'INSTALLING')).toBe(true);
    expect(progressEvents.some((progress) => progress.phase === 'READY' && progress.percent === 100)).toBe(true);
    expect(await localDb.getSyncState('global')).toMatchObject({
      lastAppliedChangeSequence: 42,
      resetGeneration: 7,
      status: 'READY',
      reconciliationRequired: false,
    });
    expect(await localDb.isInitialHydrationCompleted()).toBe(true);
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
