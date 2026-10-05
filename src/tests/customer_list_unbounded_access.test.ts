import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  addNewCustomer,
  getCustomersList,
  searchCustomersAndOrders,
  resetStoreMemory,
  clearAllOperationalData,
  defaultAdminAuth,
} from '../components/pages/dayOrdersStore';
import { localDb } from '../infrastructure/localDb/localDb';
import '../infrastructure/sync/syncBridge';

describe('CUSTOMER LIST UNBOUNDED ACCESS & ANTI-TRUNCATION AUDIT', () => {
  beforeEach(async () => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
    await clearAllOperationalData();
    await localDb.clearLocalResetMarker();
    resetStoreMemory();
    vi.restoreAllMocks();
  });

  // A. When 9 customers exist in IndexedDB, getCustomersList() returns all 9
  it('A. returns all 9 customers without artificial 6-limit truncation', async () => {
    for (let i = 1; i <= 9; i++) {
      await addNewCustomer(`عميل رقم ${i}`, `059900000${i}`);
    }

    const allCustomers = await getCustomersList();
    expect(allCustomers.length).toBe(9);

    const searchRes = await searchCustomersAndOrders();
    expect(searchRes.customers.length).toBe(9);
    expect(searchRes.totalStoreCustomersCount).toBe(9);
  });

  // B. Customer #7, #8, #9 are reachable and searchable
  it('B. customer #7, #8, #9 can be located via search query across entire storage', async () => {
    for (let i = 1; i <= 9; i++) {
      await addNewCustomer(`العميل المتميز ${i}`, `059911100${i}`);
    }

    const search7 = await searchCustomersAndOrders('المتميز 7');
    expect(search7.customers.length).toBe(1);
    expect(search7.customers[0].name).toBe('العميل المتميز 7');

    const search9 = await searchCustomersAndOrders('المتميز 9');
    expect(search9.customers.length).toBe(1);
    expect(search9.customers[0].name).toBe('العميل المتميز 9');
  });

  // C. Total count is accurately reported
  it('C. totalStoreCustomersCount reflects 9 rather than 6', async () => {
    for (let i = 1; i <= 9; i++) {
      await addNewCustomer(`عميل الإحصاء ${i}`, `059922200${i}`);
    }

    const res = await searchCustomersAndOrders('');
    expect(res.totalStoreCustomersCount).toBe(9);
    expect(res.customers.length).toBe(9);
  });

  // D. Newest-first sorting order is strictly preserved
  it('D. sorting order remains newest first (descending by createdAt)', async () => {
    const cust1 = await addNewCustomer('العميل الأول', '0599333001');
    await new Promise((r) => setTimeout(r, 10));
    const cust2 = await addNewCustomer('العميل الأخير', '0599333002');

    const list = await getCustomersList();
    expect(list.length).toBe(2);
    expect(list[0].id).toBe(cust2.id);
    expect(list[1].id).toBe(cust1.id);
  });

  // E. Explicit limit parameter is still supported when requested (e.g. for widgets)
  it('E. supports explicit limit when deliberately requested', async () => {
    for (let i = 1; i <= 9; i++) {
      await addNewCustomer(`عميل تجريبي ${i}`, `059944400${i}`);
    }

    const limitedList = await getCustomersList('', 3);
    expect(limitedList.length).toBe(3);

    const fullList = await getCustomersList();
    expect(fullList.length).toBe(9);
  });
});
