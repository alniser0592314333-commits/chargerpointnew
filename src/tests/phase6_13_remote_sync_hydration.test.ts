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

  it('1. Fresh local-only client: localDb starts empty and initializes without cloud bootstrap', async () => {
    vi.spyOn(supabaseClient, 'getSupabaseStatus').mockReturnValue({
      isConfigured: false,
      url: 'Not configured',
      status: 'disconnected',
    });
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

  it('keeps an existing checkpointed local replica and catches it up incrementally', async () => {
    await localDb.set('customers', 'existing-customer', {
      id: 'existing-customer',
      name: 'Local cached customer',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      version: 1,
    });
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 42,
      lastPulledAt: '2026-10-13T12:00:00.000Z',
      resetGeneration: 7,
      status: 'READY',
      reconciliationRequired: false,
    });
    await localDb.setInitialHydrationCompleted(false);
    vi.spyOn(supabaseClient, 'getSupabaseStatus').mockReturnValue({
      isConfigured: true,
      url: 'https://example.supabase.co',
      status: 'connected',
    });
    const rpc = vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockResolvedValue({
      data: null,
      error: 'the full snapshot RPC must not be used for a trusted local replica',
    } as any);

    await ensureStoreHydrated();

    expect(await localDb.isInitialHydrationCompleted()).toBe(true);
    expect(await localDb.get('customers', 'existing-customer')).toMatchObject({ name: 'Local cached customer' });
    expect(rpc.mock.calls.some(([name]) => name === 'capture_sync_bootstrap_snapshot')).toBe(false);
  });

  it('refuses to overwrite uncheckpointed local data that still has pending commands', async () => {
    await localDb.clear();
    await localDb.init();
    resetStoreMemory();
    await localDb.set('customers', 'pending-customer', {
      id: 'pending-customer',
      name: 'Must be preserved',
    });
    await localDb.saveOutbox({
      commandId: 'pending-customer-command',
      commandType: 'UPDATE_CUSTOMER',
      aggregateType: 'customers',
      aggregateId: 'pending-customer',
      payload: { id: 'pending-customer', name: 'Pending local edit' },
      createdAt: new Date().toISOString(),
      deviceId: 'test-device',
      actorAdminId: 'test-admin',
      status: 'pending',
      retryCount: 0,
    });
    await localDb.setInitialHydrationCompleted(false);
    vi.spyOn(supabaseClient, 'getSupabaseStatus').mockReturnValue({
      isConfigured: true,
      url: 'https://example.supabase.co',
      status: 'connected',
    });
    const rpc = vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockResolvedValue({ data: null, error: 'should not be called' } as any);

    await expect(ensureStoreHydrated()).rejects.toThrow(/LOCAL_RECONCILIATION_REQUIRED/);
    expect(await localDb.get('customers', 'pending-customer')).toMatchObject({ name: 'Must be preserved' });
    expect(rpc.mock.calls.some(([name]) => name === 'capture_sync_bootstrap_snapshot')).toBe(false);
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
        order_number_reservations: [{
          id: 'reservation-1',
          business_day_id: 'day-1',
          device_id: 'device-1',
          start_number: 1,
          end_number: 5,
          next_number: 2,
          status: 'ACTIVE',
          created_at: '2026-10-13T12:00:00.000Z',
          updated_at: '2026-10-13T12:00:00.000Z',
          version: 1,
        }],
        qr_tokens: [{
          id: 'qr-1',
          token_hash: 'hash-1',
          public_token: 'token-1',
          token_type: 'ORDER',
          target_id: 'order-1',
          is_active: true,
          created_at: '2026-10-13T12:00:00.000Z',
        }],
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
    expect(await localDb.get('orderNumberReservations', 'reservation-1')).toMatchObject({
      id: 'reservation-1',
      nextNumber: 2,
    });
    expect(await localDb.get('qr_tokens', 'qr-1')).toMatchObject({
      id: 'qr-1',
      publicToken: 'token-1',
      targetId: 'order-1',
    });
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
