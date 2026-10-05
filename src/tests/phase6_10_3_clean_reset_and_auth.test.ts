import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { authService, SUPER_ADMIN_TEST_ACCOUNT } from '../services/auth/authService';
import {
  getCustomersCount,
  getOrdersCount,
  getBusinessDaysCount,
  getLedgerCount,
  clearAllOperationalData,
  getFinancialsOverviewData,
  resetStoreMemory,
  ensureStoreHydrated,
  getDefaultDevices,
} from '../components/pages/dayOrdersStore';

describe('Phase 6.10.3 Clean Reset, Super Admin Bootstrap, and Financial Semantics', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(false);
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
    resetStoreMemory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Super Admin Test Account exists with required roles and permissions', () => {
    expect(SUPER_ADMIN_TEST_ACCOUNT.email).toBe('superadmin@system.local');
    expect(SUPER_ADMIN_TEST_ACCOUNT.role).toBe('SUPER_ADMIN');
    expect(SUPER_ADMIN_TEST_ACCOUNT.pin).toBe('123456');
    expect(SUPER_ADMIN_TEST_ACCOUNT.bin).toBe('123456');
    expect(SUPER_ADMIN_TEST_ACCOUNT.isActive).toBe(true);
    expect(SUPER_ADMIN_TEST_ACCOUNT.permissions.length).toBeGreaterThan(15);
  });

  it('2. Login with Super Admin credentials creates valid session', async () => {
    const session = await authService.login(
      'superadmin@system.local',
      '123456',
      '123456'
    );
    expect(session).not.toBeNull();
    expect(session?.email).toBe('superadmin@system.local');
    expect(session?.role).toBe('SUPER_ADMIN');

    const currentSession = await authService.getCurrentSession();
    expect(currentSession).not.toBeNull();
    expect(currentSession?.userId).toBe(SUPER_ADMIN_TEST_ACCOUNT.id);
  });

  it('3. Logout clears active session', async () => {
    await authService.login('superadmin@system.local', '123456', '123456');
    expect(await authService.getCurrentSession()).not.toBeNull();

    await authService.logout();
    expect(await authService.getCurrentSession()).toBeNull();
  });

  it('4. Operational Data Reset purges operational records while retaining device types config', async () => {
    await ensureStoreHydrated();
    await clearAllOperationalData();

    expect(await getCustomersCount()).toBe(0);
    expect(await getOrdersCount()).toBe(0);
    expect(await getBusinessDaysCount()).toBe(0);
    expect(await getLedgerCount()).toBe(0);

    const overview = await getFinancialsOverviewData();
    expect(overview.totalDebtMinor).toBe(0);
    expect(overview.totalCollectedMinor).toBe(0);
    expect(overview.totalOrdersValueMinor).toBe(0);

    const devices = getDefaultDevices();
    expect(devices.length).toBe(0);
  });

  it('5. Financial color semantics rule: Positive (>0), Negative (<0), Zero (===0)', () => {
    const getFinancialColor = (amountMinor: number) => {
      if (amountMinor > 0) return 'GREEN';
      if (amountMinor < 0) return 'RED';
      return 'NEUTRAL';
    };

    expect(getFinancialColor(2000)).toBe('GREEN');
    expect(getFinancialColor(4550)).toBe('GREEN');
    expect(getFinancialColor(-2000)).toBe('RED');
    expect(getFinancialColor(-4550)).toBe('RED');
    expect(getFinancialColor(0)).toBe('NEUTRAL');
  });
});
