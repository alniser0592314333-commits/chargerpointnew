import { describe, it, expect, beforeEach } from 'vitest';
import { AuthorizationContext } from '../application/authContext';
import { BinRequiredError, AuthorizationError, InsufficientPermissionError } from '../domain/errors';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  ensureStoreHydrated,
  resetStoreMemory,
  seedDemoOperationalData,
  setRuntimeBinVerifier,
  topUpCustomerBalance,
  deliverAllOrdersInDay,
  addNewCustomer,
  createOrderWithPhase5Engine,
  getOrdersForDay,
  getCustomersList,
  CURRENT_MIGRATION_VERSION,
  phase5UseCases,
  getAuthorizedAdminContext,
  runCleanBootMigrationIfNeeded,
} from '../components/pages/dayOrdersStore';

describe('Phase 6.11.1: P0 Security & Persistence Repaired Verification', () => {
  beforeEach(async () => {
    if (typeof globalThis.localStorage === 'undefined') {
      (globalThis as any).localStorage = {
        store: {} as Record<string, string>,
        getItem(k: string) { return this.store[k] || null; },
        setItem(k: string, v: string) { this.store[k] = String(v); },
        removeItem(k: string) { delete this.store[k]; },
        clear() { this.store = {}; },
      };
    } else {
      localStorage.clear();
    }

    await localDb.clear();
    localStorage.setItem('sys_db_version', CURRENT_MIGRATION_VERSION);
    resetStoreMemory();
    await seedDemoOperationalData();
    setRuntimeBinVerifier(null);
  });

  describe('P0-A: BIN Security Fail-Closed Semantics', () => {
    it('1. verifyBin rejects invalid format (empty, short, non-numeric) with BinRequiredError', () => {
      const auth = new AuthorizationContext(
        {
          id: 'admin_1',
          username: 'admin',
          fullName: 'Admin',
          role: 'ADMIN',
          permissions: ['orders:deliver'],
          isSuperAdmin: true,
        },
        () => true
      );

      expect(() => auth.verifyBin('')).toThrow(BinRequiredError);
      expect(() => auth.verifyBin('   ')).toThrow(BinRequiredError);
      expect(() => auth.verifyBin('12')).toThrow(BinRequiredError);
      expect(() => auth.verifyBin('123')).toThrow(BinRequiredError);
      expect(() => auth.verifyBin('abcd')).toThrow(BinRequiredError);
      expect(() => auth.verifyBin('12a4')).toThrow(BinRequiredError);
    });

    it('2. verifyBin rejects when verifier is missing (fails closed)', () => {
      const auth = new AuthorizationContext(
        {
          id: 'admin_1',
          username: 'admin',
          fullName: 'Admin',
          role: 'ADMIN',
          permissions: ['orders:deliver'],
          isSuperAdmin: true,
        },
        undefined // missing verifier
      );

      expect(() => auth.verifyBin('1234')).toThrow(AuthorizationError);
      expect(() => auth.verifyBin('123456')).toThrow(AuthorizationError);
    });

    it('3. verifyBin rejects when verifier returns false', () => {
      const auth = new AuthorizationContext(
        {
          id: 'admin_1',
          username: 'admin',
          fullName: 'Admin',
          role: 'ADMIN',
          permissions: ['orders:deliver'],
          isSuperAdmin: true,
        },
        (bin) => bin === '9876'
      );

      expect(() => auth.verifyBin('1234')).toThrow(AuthorizationError);
      expect(() => auth.verifyBin('0000')).toThrow(AuthorizationError);
      expect(() => auth.verifyBin('9876')).not.toThrow();
    });

    it('4. verifyBin rejects when verifier throws', () => {
      const auth = new AuthorizationContext(
        {
          id: 'admin_1',
          username: 'admin',
          fullName: 'Admin',
          role: 'ADMIN',
          permissions: ['orders:deliver'],
          isSuperAdmin: true,
        },
        () => {
          throw new Error('Database connection failed');
        }
      );

      expect(() => auth.verifyBin('1234')).toThrow(AuthorizationError);
    });

    it('5. verifyBin supports asynchronous verifier (e.g. Supabase RPC)', async () => {
      const auth = new AuthorizationContext(
        {
          id: 'admin_1',
          username: 'admin',
          fullName: 'Admin',
          role: 'ADMIN',
          permissions: ['orders:deliver'],
          isSuperAdmin: true,
        },
        async (bin) => {
          await new Promise((r) => setTimeout(r, 10));
          return bin === '5555';
        }
      );

      await expect(auth.verifyBin('1111')).rejects.toThrow(AuthorizationError);
      await expect(auth.verifyBin('5555')).resolves.toBeUndefined();
    });

    it('6. Runtime protected paths (topUp, deliver) fail closed offline without verifier', async () => {
      setRuntimeBinVerifier(null);

      // Top up attempt with arbitrary BIN offline must fail closed
      const topUpRes = await topUpCustomerBalance({
        customerId: 'cust-1',
        amountMinor: 1000,
        bin: '1234',
      });
      expect(topUpRes.success).toBe(false);

      // Deliver all orders attempt offline without verifier must fail closed
      const deliverRes = await deliverAllOrdersInDay('day-1', '1234');
      expect(deliverRes.success).toBe(false);
    });

    it('7. Use cases enforce BIN verification at use-case boundary', async () => {
      const authWithoutVerifier = new AuthorizationContext({
        id: 'admin_1',
        username: 'admin',
        fullName: 'Admin',
        role: 'ADMIN',
        permissions: ['orders:cancel', 'finance:credit-adjustment'],
        isSuperAdmin: false,
      });

      // Cancellation must fail closed when verifier is missing
      await expect(
        phase5UseCases.cancelOrder(authWithoutVerifier, 'ord-1', '1234')
      ).rejects.toThrow(AuthorizationError);

      // Credit adjustment must fail closed when verifier is missing
      await expect(
        phase5UseCases.createCustomerCredit(authWithoutVerifier, 'cust-1', 1000, '1234')
      ).rejects.toThrow(AuthorizationError);
    });
  });

  describe('P0-B: Data Persistence & Operational Reset Lifecycle', () => {
    it('1. sys_operational_reset executes once and is immediately cleared from localStorage', async () => {
      localStorage.removeItem('sys_db_version');
      localStorage.setItem('sys_operational_reset', 'true');
      expect(localStorage.getItem('sys_operational_reset')).toBe('true');

      resetStoreMemory();
      await ensureStoreHydrated();

      // Flag must be removed immediately so it does not act as permanent tombstone
      expect(localStorage.getItem('sys_operational_reset')).toBeNull();
      expect(localStorage.getItem('sys_db_version')).toBe(CURRENT_MIGRATION_VERSION);
    });

    it('2. Persisted operational data survives app unmount / reload simulation', async () => {
      await ensureStoreHydrated();

      // 1. Create real customer
      const cust = await addNewCustomer('خالد المنصوري', '0599112233');
      expect(cust.id).toBeDefined();

      // 2. Open a business day and create an order
      const dayId = 'day-test-persist-1';
      await localDb.set('businessDays', dayId, {
        id: dayId,
        businessDate: '2026-09-27',
        isClosed: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      });

      const orderRes = await createOrderWithPhase5Engine(dayId, cust.id, [
        { deviceTypeId: 'dev-1', hasCharger: true },
      ]);
      expect(orderRes.success).toBe(true);

      // Verify in memory before reload
      const ordersBefore = await getOrdersForDay(dayId);
      expect(ordersBefore.length).toBe(1);
      expect(ordersBefore[0].customerName).toBe(cust.name);

      const customersBefore = await getCustomersList();
      const foundCustBefore = customersBefore.find((c) => c.id === cust.id);
      expect(foundCustBefore).toBeDefined();

      // 3. SIMULATE APP UNMOUNT / TAB RESTORATION / RELOAD
      // Memory maps wiped clean, but IndexedDB and localStorage persist
      resetStoreMemory();

      // Re-hydrate store as a new boot would do
      await ensureStoreHydrated();

      // 4. VERIFY all created entities are still present in memory and match IndexedDB
      const ordersAfter = await getOrdersForDay(dayId);
      expect(ordersAfter.length).toBe(1);
      expect(ordersAfter[0].id).toBe(ordersBefore[0].id);
      expect(ordersAfter[0].customerName).toBe(cust.name);
      expect(ordersAfter[0].items.length).toBe(1);

      const customersAfter = await getCustomersList();
      const foundCustAfter = customersAfter.find((c) => c.id === cust.id);
      expect(foundCustAfter).toBeDefined();
      expect(foundCustAfter?.name).toBe('خالد المنصوري');

      // 5. Subsequent reload also preserves the data
      resetStoreMemory();
      await ensureStoreHydrated();

      const ordersSecondReload = await getOrdersForDay(dayId);
      expect(ordersSecondReload.length).toBe(1);
    });

    it('3. Migration version prevents re-clearing of newly created records on boot', async () => {
      await ensureStoreHydrated();

      const cust = await addNewCustomer('سامر النجار', '0599554433');
      expect(cust.id).toBeDefined();

      // Reset memory to simulate restart
      resetStoreMemory();

      // Ensure sys_db_version is still current
      expect(localStorage.getItem('sys_db_version')).toBe(CURRENT_MIGRATION_VERSION);

      await ensureStoreHydrated();

      const customers = await getCustomersList();
      const samer = customers.find((c) => c.name === 'سامر النجار');
      expect(samer).toBeDefined();
    });
  });
});
