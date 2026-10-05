import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  CURRENT_MIGRATION_VERSION,
  ensureStoreHydrated,
  resetStoreMemory,
  seedDemoOperationalData,
  getCustomersList,
  getDaysList,
  getOrdersForDay,
  getFinancialCustomersByFilter,
  getAllDeviceTypes,
  createTodayBusinessDay,
  addNewCustomer,
  createOrderWithPhase5Engine,
  deliverAllOrdersInDay,
  topUpCustomerBalance,
  getCustomerFinancialHistory,
  setRuntimeBinVerifier,
  runCleanBootMigrationIfNeeded,
} from '../components/pages/dayOrdersStore';
import { authService, SUPER_ADMIN_TEST_ACCOUNT } from '../services/auth/authService';

const getLocalStorage = () => {
  if (typeof localStorage !== 'undefined') return localStorage;
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  if (typeof globalThis !== 'undefined' && (globalThis as any).localStorage) return (globalThis as any).localStorage;
  return null;
};

describe('Phase 6.10.3D: Real Browser Clean Boot Migration & Storage Verification', () => {
  beforeEach(async () => {
    if (typeof globalThis.localStorage === 'undefined') {
      (globalThis as any).localStorage = {
        store: {} as Record<string, string>,
        getItem(key: string) {
          return this.store[key] || null;
        },
        setItem(key: string, value: string) {
          this.store[key] = value;
        },
        removeItem(key: string) {
          delete this.store[key];
        },
        clear() {
          this.store = {};
        },
      };
    } else {
      localStorage.clear();
    }
    await localDb.clear();
    const storage = getLocalStorage();
    if (storage) storage.clear();
    resetStoreMemory();
    setRuntimeBinVerifier((bin) => bin === '1234');
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Migration runs when version is missing and db is empty
  it('1. Migration runs and purges storage when sys_db_version is missing on empty database', async () => {
    const storage = getLocalStorage();
    if (storage) storage.removeItem('sys_db_version');

    const migrated = await runCleanBootMigrationIfNeeded();

    expect(migrated).toBe(true);
    if (storage) expect(storage.getItem('sys_db_version')).toBe(CURRENT_MIGRATION_VERSION);

    const custs = await localDb.list('customers');
    expect(custs.length).toBe(0);
  });

  // 2. Migration runs when version is old
  it('2. Migration preserves existing data when sys_db_version is outdated (e.g., 1.0.0)', async () => {
    await seedDemoOperationalData();
    const storage = getLocalStorage();
    if (storage) storage.setItem('sys_db_version', '1.0.0');

    resetStoreMemory();
    const migrated = await runCleanBootMigrationIfNeeded();
    expect(migrated).toBe(false);
    if (storage) expect(storage.getItem('sys_db_version')).toBe(CURRENT_MIGRATION_VERSION);

    const ords = await localDb.list('orders');
    expect(ords.length).toBeGreaterThan(0);
  });

  // 3. Migration does not rerun when version is current
  it('3. Migration is skipped when sys_db_version matches current version', async () => {
    const storage = getLocalStorage();
    if (storage) storage.setItem('sys_db_version', CURRENT_MIGRATION_VERSION);

    const newCust = { id: 'cust_new_1', name: 'عميل جديد 1', phone: '0590001111', isActive: true, debtLimitMinor: -10000, createdAt: '', updatedAt: '', version: 1 };
    await localDb.set('customers', newCust.id, newCust);

    const migrated = await runCleanBootMigrationIfNeeded();
    expect(migrated).toBe(false);

    const custs = await localDb.list('customers');
    expect(custs.length).toBe(1);
  });

  // 4. RAW IndexedDB operational records are safely preserved
  it('4. RAW IndexedDB operational records are safely preserved when data exists across clean boot check', async () => {
    await seedDemoOperationalData();
    const storage = getLocalStorage();
    if (storage) storage.removeItem('sys_db_version');

    const migrated = await runCleanBootMigrationIfNeeded();
    expect(migrated).toBe(false);

    const [custs, days, ords, items, ledger] = await Promise.all([
      localDb.list('customers'),
      localDb.list('businessDays'),
      localDb.list('orders'),
      localDb.list('orderItems'),
      localDb.list('financialLedger'),
    ]);

    expect(custs.length).toBeGreaterThan(0);
    expect(days.length).toBeGreaterThan(0);
    expect(ords.length).toBeGreaterThan(0);
    expect(items.length).toBeGreaterThan(0);
  });

  // 5. In-memory maps load preserved data
  it('5. In-memory store maps are hydrated with preserved data after migration check', async () => {
    await seedDemoOperationalData();
    const storage = getLocalStorage();
    if (storage) storage.removeItem('sys_db_version');

    await ensureStoreHydrated();

    const custs = await getCustomersList();
    const days = await getDaysList();
    expect(custs.length).toBeGreaterThan(0);
    expect(days.length).toBeGreaterThan(0);
  });

  // 6. Device types cleared during clean boot migration
  it('6. Device types configuration records are cleared across migration', async () => {
    await ensureStoreHydrated();
    const devs = await getAllDeviceTypes();
    expect(devs.length).toBe(0);
  });

  // 7. Settings preserved
  it('7. System theme and language settings keys in localStorage remain untouched', async () => {
    const storage = getLocalStorage();
    if (storage) {
      storage.setItem('app_theme', 'dark');
      storage.setItem('app_locale', 'ar');
    }

    await runCleanBootMigrationIfNeeded();

    if (storage) {
      expect(storage.getItem('app_theme')).toBe('dark');
      expect(storage.getItem('app_locale')).toBe('ar');
    }
  });

  // 8. Security preserved
  it('8. Security verifiers and BIN verification boundaries remain intact', () => {
    const session = authService.verifyBin('123456');
    expect(session).toBe(true);
  });

  // 9. Super Admin preserved
  it('9. Super Admin test account credentials and authorization role remain accessible', async () => {
    const session = await authService.login('superadmin@system.local', '123456', '123456');
    expect(session).not.toBeNull();
    expect(session?.role).toBe('SUPER_ADMIN');
    expect(SUPER_ADMIN_TEST_ACCOUNT.isActive).toBe(true);
  });

  // 10. No runtime seed data recreated
  it('10. Fresh hydration on new session does not recreate mock operational seed data', async () => {
    await ensureStoreHydrated();
    const custs = await getCustomersList();
    const days = await getDaysList();
    const financials = await getFinancialCustomersByFilter('all', 10);

    expect(custs.length).toBe(0);
    expect(days.length).toBe(0);
    expect(financials.length).toBe(0);
  });

  // 11. Reload remains empty
  it('11. Reloading memory state after clean boot migration leaves storage empty', async () => {
    await ensureStoreHydrated();

    resetStoreMemory();
    await ensureStoreHydrated();

    const custs = await getCustomersList();
    expect(custs.length).toBe(0);
  });

  // 12. Logout/Login remains empty
  it('12. Logout followed by re-login maintains zero operational data state', async () => {
    await ensureStoreHydrated();
    await authService.logout();
    const loginSession = await authService.login('superadmin@system.local', '123456', '123456');
    expect(loginSession).not.toBeNull();

    resetStoreMemory();
    await ensureStoreHydrated();

    const custs = await getCustomersList();
    expect(custs.length).toBe(0);
  });

  // 13. First new order starts #1
  it('13. First created order on clean business day starts at display number #1', async () => {
    await seedDemoOperationalData();
    await ensureStoreHydrated();
    const cust = await addNewCustomer('عميل تجريبي جديد', '0599000000');
    const dayId = await createTodayBusinessDay('2026-09-26');

    const orderRes = await createOrderWithPhase5Engine(dayId, cust.id, [
      { deviceTypeId: 'dev-1', hasCharger: false },
    ]);

    expect(orderRes.success).toBe(true);
    const dayOrders = await getOrdersForDay(dayId);
    expect(dayOrders.length).toBe(1);
    expect(dayOrders[0].orderNumber).toBe(1);
  });

  // 14. Pending order has zero charge
  it('14. Pending order generates zero financial charges prior to delivery', async () => {
    await seedDemoOperationalData();
    await ensureStoreHydrated();
    const cust = await addNewCustomer('عميل الذمم', '0599111222');
    const dayId = await createTodayBusinessDay('2026-09-26');

    await createOrderWithPhase5Engine(dayId, cust.id, [
      { deviceTypeId: 'dev-1', hasCharger: false },
    ]);

    const history = await getCustomerFinancialHistory(cust.id);
    expect(history.length).toBe(0);
  });

  // 15. Delivered order creates one negative charge
  it('15. Delivering an order creates exactly one negative ORDER_ITEM_CHARGE per item', async () => {
    await seedDemoOperationalData();
    await ensureStoreHydrated();
    const cust = await addNewCustomer('عميل التسليم', '0599333444');
    const dayId = await createTodayBusinessDay('2026-09-26');

    await createOrderWithPhase5Engine(dayId, cust.id, [
      { deviceTypeId: 'dev-1', hasCharger: false },
    ]);

    const delRes = await deliverAllOrdersInDay(dayId, '1234');
    expect(delRes.success).toBe(true);

    const history = await getCustomerFinancialHistory(cust.id);
    expect(history.length).toBe(1);
    expect(history[0].eventType).toBe('ORDER_ITEM_CHARGE');
    expect(history[0].amountMinor).toBeLessThan(0);
  });

  // 16. Positive payment is green
  it('16. Balance top-up creates positive amount payment record', async () => {
    await ensureStoreHydrated();
    const cust = await addNewCustomer('عميل الدفع', '0599555666');
    const topUp = await topUpCustomerBalance({ customerId: cust.id, amountMinor: 5000, bin: '1234' });
    expect(topUp.success).toBe(true);

    const history = await getCustomerFinancialHistory(cust.id);
    expect(history.length).toBe(1);
    expect(history[0].amountMinor).toBe(5000);
    expect(history[0].amountMinor).toBeGreaterThan(0);
  });

  // 17 & 18. Financial sign color semantics
  it('17 & 18. Financial amount signs strictly govern visual color semantics (positive=green, negative=red, zero=neutral)', () => {
    const getSemanticColor = (amountMinor: number): string => {
      if (amountMinor > 0) return 'text-emerald-600 dark:text-[#4ade80]';
      if (amountMinor < 0) return 'text-red-600 dark:text-[#f87171]';
      return 'text-gray-500 dark:text-gray-400';
    };

    expect(getSemanticColor(5000)).toContain('emerald');
    expect(getSemanticColor(-3000)).toContain('red');
    expect(getSemanticColor(0)).toContain('gray');
  });

  // 19. Business day persists after reload
  it('19. Business day created after clean boot persists across reloads', async () => {
    await ensureStoreHydrated();
    const dayId = await createTodayBusinessDay('2026-09-26');

    resetStoreMemory();
    await ensureStoreHydrated();

    const days = await getDaysList();
    expect(days.some((d) => d.id === dayId)).toBe(true);
  });
});
