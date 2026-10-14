import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { backupService } from '../services/backup/backupService';
import { AuthorizationContext, ActorAdmin } from '../application/authContext';
import * as dayOrdersStore from '../components/pages/dayOrdersStore';
import * as supabaseClient from '../services/supabase/client';
import { config } from '../config/env';

describe('Phase B.5: Intentional Local Reset vs Fresh Client Bootstrap Isolation', () => {
  const originalUrl = config.supabaseUrl;
  const originalKey = config.supabaseAnonKey;

  const superAdminActor: ActorAdmin = {
    id: 'admin_super_reset_test',
    username: 'superadmin',
    fullName: 'Super Administrator',
    role: 'SUPER_ADMIN',
    permissions: ['settings:manage', 'orders:view', 'orders:create', 'customers:view'],
    isSuperAdmin: true,
  };

  const validBin = '1234';
  const binVerifier = (bin: string) => bin === validBin;
  const superAdminAuth = new AuthorizationContext(superAdminActor, binVerifier);

  beforeEach(async () => {
    config.supabaseUrl = 'https://example.supabase.co';
    config.supabaseAnonKey = 'mock-anon-key';
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('sys_db_version', dayOrdersStore.CURRENT_MIGRATION_VERSION);
    }
    await localDb.clear();
    await localDb.clearLocalResetMarker();
    dayOrdersStore.resetStoreMemory();
  });

  afterEach(() => {
    config.supabaseUrl = originalUrl;
    config.supabaseAnonKey = originalKey;
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------
  // TEST 1 — True Fresh Client
  // -------------------------------------------------------------
  it('TEST 1 — Fresh browser with missing version fetches the authoritative cloud snapshot', async () => {
    const storage = typeof localStorage !== 'undefined' ? localStorage : null;
    storage?.removeItem('sys_db_version');

    const getSupabaseStatusSpy = vi.spyOn(supabaseClient, 'getSupabaseStatus').mockReturnValue({
      isConfigured: true,
      url: 'https://example.supabase.co',
      status: 'connected',
    });

    const snapshot = {
      schema_version: 1,
      captured_at: '2026-10-14T06:00:00.000Z',
      server_reset_generation: 0,
      max_change_sequence: 31168,
      customers: [{
        id: 'fresh-cloud-customer',
        name: 'Fresh Cloud Customer',
        phone: '',
        is_active: true,
        debt_limit_minor: 0,
        charger_fee_exempt: false,
        created_at: '2026-10-14T06:00:00.000Z',
        updated_at: '2026-10-14T06:00:00.000Z',
        version: 1,
      }],
      business_days: [],
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
    };

    const rpcSpy = vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockResolvedValue({
      data: snapshot,
      error: null,
    } as any);

    expect(await localDb.isLocalResetCompleted()).toBe(false);
    expect(await localDb.list('customers')).toHaveLength(0);

    // This follows the real app entry path: clean-boot migration, then store hydration.
    await dayOrdersStore.ensureStoreHydrated();

    expect(rpcSpy).toHaveBeenCalledWith('capture_sync_bootstrap_snapshot', {});
    expect(await localDb.isLocalResetCompleted()).toBe(false);
    expect(await localDb.list<any>('customers')).toMatchObject([
      { id: 'fresh-cloud-customer', name: 'Fresh Cloud Customer' },
    ]);
    expect(await localDb.getSyncState('global')).toMatchObject({
      lastAppliedChangeSequence: 31168,
      resetGeneration: 0,
      status: 'READY',
      reconciliationRequired: false,
    });

    getSupabaseStatusSpy.mockRestore();
    rpcSpy.mockRestore();
  });

  // TEST 2 — Intentional Local Reset
  // -------------------------------------------------------------
  it('TEST 2 — Intentional Local Reset: clears operational data and sets durable marker', async () => {
    // Populate initial local business data
    await localDb.set('customers', 'c1', { id: 'c1', name: 'Customer 1' });
    await localDb.set('businessDays', 'day-1', { id: 'day-1', businessDate: '2026-09-28' });
    await localDb.set('orders', 'o1', { id: 'o1', customerId: 'c1' });
    await localDb.set('orderItems', 'i1', { id: 'i1', orderId: 'o1' });

    expect((await localDb.list('customers')).length).toBe(1);

    // Execute intentional Local Reset
    await backupService.deleteLocalBusinessData(superAdminAuth, { bin: validBin });

    // Operational stores are empty
    expect((await localDb.list('customers')).length).toBe(0);
    expect((await localDb.list('businessDays')).length).toBe(0);
    expect((await localDb.list('orders')).length).toBe(0);
    expect((await localDb.list('orderItems')).length).toBe(0);

    // Marker is durably recorded
    expect(await localDb.isLocalResetCompleted()).toBe(true);
  });

  // -------------------------------------------------------------
  // TEST 3 — Reload After Local Reset (BUG REPRODUCTION & FIX PROOF)
  // -------------------------------------------------------------
  it('TEST 3 — Reload After Local Reset: does NOT call remote full hydration and keeps data empty', async () => {
    const getSupabaseStatusSpy = vi.spyOn(supabaseClient, 'getSupabaseStatus').mockReturnValue({
      isConfigured: true,
      url: 'https://example.supabase.co',
      status: 'connected',
    });

    const restGetSpy = vi
      .spyOn(supabaseClient, 'invokeSupabaseRestGet')
      .mockResolvedValue({ data: [], error: null });

    // Seed local data then perform intentional Local Reset
    await localDb.set('customers', 'c_old', { id: 'c_old', name: 'Old Customer' });
    await backupService.deleteLocalBusinessData(superAdminAuth, { bin: validBin });

    expect(await localDb.isLocalResetCompleted()).toBe(true);

    // Reset spy count before reload
    restGetSpy.mockClear();

    // Reload store from local persistence
    await dayOrdersStore.reloadStoreFromLocal();

    // PROOF: Remote table GET calls MUST NOT be called!
    expect(restGetSpy).not.toHaveBeenCalled();

    // Local data remains pristine and empty
    expect((await localDb.list('customers')).length).toBe(0);
    expect((await localDb.list('orders')).length).toBe(0);

    getSupabaseStatusSpy.mockRestore();
    restGetSpy.mockRestore();
  });

  // -------------------------------------------------------------
  // TEST 4 — Browser / App Restart Simulation
  // -------------------------------------------------------------
  it('TEST 4 — Browser / App Restart Simulation: marker in IndexedDB blocks bootstrap on fresh boot', async () => {
    const getSupabaseStatusSpy = vi.spyOn(supabaseClient, 'getSupabaseStatus').mockReturnValue({
      isConfigured: true,
      url: 'https://example.supabase.co',
      status: 'connected',
    });

    const rpcSpy = vi
      .spyOn(supabaseClient, 'invokeSupabaseRpc')
      .mockResolvedValue({ data: null, error: 'snapshot must remain blocked after an intentional reset' } as any);

    // Directly set marker in storage
    await localDb.setLocalResetMarker(true);

    // Simulate complete app restart (memory wipe)
    dayOrdersStore.resetStoreMemory();

    // Hydrate store on fresh boot
    await dayOrdersStore.ensureStoreHydrated();

    // Bootstrap was blocked: the intentional-reset marker must still prevent a snapshot pull.
    expect(rpcSpy).not.toHaveBeenCalled();
    expect((await localDb.list('customers')).length).toBe(0);

    getSupabaseStatusSpy.mockRestore();
    rpcSpy.mockRestore();
  });

  // -------------------------------------------------------------
  // TEST 5 — Explicit Snapshot Restore
  // -------------------------------------------------------------
  it('TEST 5 — Explicit Snapshot Restore: restores business data and clears reset marker', async () => {
    // Create a valid snapshot
    await localDb.set('customers', 'snap_c1', { id: 'snap_c1', name: 'Snapshot Customer' });
    const snap = await backupService.createSnapshot('OFFLINE', superAdminAuth, { bin: validBin });

    // Perform Local Reset
    await backupService.deleteLocalBusinessData(superAdminAuth, { bin: validBin });
    expect(await localDb.isLocalResetCompleted()).toBe(true);
    expect((await localDb.list('customers')).length).toBe(0);

    // Perform explicit Restore Snapshot
    const res = await backupService.restoreSnapshot(snap.snapshotId, superAdminAuth, { bin: validBin });
    expect(res.success).toBe(true);

    // Marker was cleared upon explicit restore
    expect(await localDb.isLocalResetCompleted()).toBe(false);

    // Reload store
    await dayOrdersStore.reloadStoreFromLocal();

    // Data is restored correctly
    const customers = await localDb.list<any>('customers');
    expect(customers).toHaveLength(1);
    expect(customers[0].name).toBe('Snapshot Customer');
  });

  // -------------------------------------------------------------
  // TEST 6 — Explicit Online -> Local Restore
  // -------------------------------------------------------------
  it('TEST 6 — Explicit Online -> Local Restore: succeeds and populates local database', async () => {
    const mockOnline = {
      customers: [{ id: 'cust_remote_1', name: 'Remote Customer' }],
      businessDays: [{ id: 'day-2026-09-28', businessDate: '2026-09-28' }],
      orders: [],
      orderItems: [],
      financialLedger: [],
      payments: [],
      paymentAllocations: [],
      deviceTypes: [],
    };

    // Perform Local Reset
    await backupService.deleteLocalBusinessData(superAdminAuth, { bin: validBin });
    expect(await localDb.isLocalResetCompleted()).toBe(true);

    // Perform explicit Restore Online -> Local
    const res = await backupService.restoreOnlineToLocal(superAdminAuth, {
      bin: validBin,
      customOnlineData: mockOnline,
    });
    expect(res.success).toBe(true);

    // Marker is cleared
    expect(await localDb.isLocalResetCompleted()).toBe(false);

    // Reload store
    await dayOrdersStore.reloadStoreFromLocal();

    // Data from remote is present
    const customers = await localDb.list<any>('customers');
    expect(customers).toHaveLength(1);
    expect(customers[0].name).toBe('Remote Customer');
  });

  // -------------------------------------------------------------
  // TEST 7 — Existing Populated Client
  // -------------------------------------------------------------
  it('TEST 7 — Existing Populated Client: populated client does delta sync without full table refresh', async () => {
    const getSupabaseStatusSpy = vi.spyOn(supabaseClient, 'getSupabaseStatus').mockReturnValue({
      isConfigured: true,
      url: 'https://example.supabase.co',
      status: 'connected',
    });

    const restGetSpy = vi
      .spyOn(supabaseClient, 'invokeSupabaseRestGet')
      .mockResolvedValue({ data: [], error: null });

    // Populated database
    await localDb.set('customers', 'c_exist', { id: 'c_exist', name: 'Existing' });
    await localDb.setInitialHydrationCompleted(true);

    await dayOrdersStore.ensureStoreHydrated();

    // Full table hydration is NOT called on populated clients (only change_log delta sync may run)
    const tableHydrationCalls = restGetSpy.mock.calls.filter(
      ([tableName]) => tableName !== 'change_log'
    );
    expect(tableHydrationCalls).toHaveLength(0);

    getSupabaseStatusSpy.mockRestore();
    restGetSpy.mockRestore();
  });

  // -------------------------------------------------------------
  // TEST 8 — Marker Survives Store Memory Reset
  // -------------------------------------------------------------
  it('TEST 8 — Marker Survives Store Memory Reset: marker remains in IndexedDB across reloads', async () => {
    await localDb.setLocalResetMarker(true);
    expect(await localDb.isLocalResetCompleted()).toBe(true);

    dayOrdersStore.resetStoreMemory();
    expect(await localDb.isLocalResetCompleted()).toBe(true);
  });

  // -------------------------------------------------------------
  // TEST 9 — Snapshots Survive Reset
  // -------------------------------------------------------------
  it('TEST 9 — Snapshots Survive Reset: snapshots are preserved when Local Reset is executed', async () => {
    await localDb.set('customers', 'c_snap', { id: 'c_snap', name: 'Snap Cust' });
    const snap = await backupService.createSnapshot('OFFLINE', superAdminAuth, { bin: validBin });

    // Local Reset
    await backupService.deleteLocalBusinessData(superAdminAuth, { bin: validBin });

    // Snapshots remain intact
    const list = await backupService.listSnapshots();
    expect(list).toHaveLength(1);
    expect(list[0].snapshotId).toBe(snap.snapshotId);
  });

  // -------------------------------------------------------------
  // TEST 10 — Auth & Device Config Survive Reset
  // -------------------------------------------------------------
  it('TEST 10 — Local Reset clears device types along with operational business data', async () => {
    await localDb.set('deviceTypes', 'dev-1', { id: 'dev-1', name: 'Screen Replacement', isActive: true });

    await backupService.deleteLocalBusinessData(superAdminAuth, { bin: validBin });

    await dayOrdersStore.reloadStoreFromLocal();

    const devTypes = await localDb.list('deviceTypes');
    expect(devTypes.length).toBe(0);
  });
});
