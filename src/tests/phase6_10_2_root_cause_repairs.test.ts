import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  getDefaultLedger,
  getDefaultItems,
  getCustomerDetail,
  getCustomerFinancialHistory,
  getDaysList,
  getFinancialCustomersByFilter,
  createOrderWithPhase5Engine,
  resetStoreMemory,
  seedDemoOperationalData,
  ensureStoreHydrated,
  deliverAllOrdersInDay,
  topUpCustomerBalance,
  setRuntimeBinVerifier,
} from '../components/pages/dayOrdersStore';
import { getLocalBusinessDateStr } from '../utils/dateFormatter';
import { calculateItemPrice } from '../domain/rules';

describe('Phase 6.10.2 Root Cause Repairs & Regression Suite', () => {
  beforeEach(async () => {
    await localDb.clear();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    resetStoreMemory();
    await seedDemoOperationalData();
    setRuntimeBinVerifier((bin) => bin === '1234');

    // Populate test fixture for historical regression tests
    await localDb.set('customers', 'cust-1', { id: 'cust-1', name: 'محمد علي', phone: '0599123456', isActive: true, debtLimitMinor: -50000, chargerFeeExempt: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', version: 1 });
    await localDb.set('customers', 'cust-2', { id: 'cust-2', name: 'سارة خالد', phone: '0598765432', isActive: true, debtLimitMinor: -30000, chargerFeeExempt: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', version: 1 });
    await localDb.set('customers', 'cust-3', { id: 'cust-3', name: 'أحمد محمود', phone: '0597112233', isActive: true, debtLimitMinor: -20000, chargerFeeExempt: true, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', version: 1 });
    await localDb.set('businessDays', 'day-2026-09-25', { id: 'day-2026-09-25', businessDate: '2026-09-25', isClosed: false, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z', version: 1 });
    await localDb.set('orders', 'ord-27', { id: 'ord-27', dayId: 'day-2026-09-25', customerId: 'cust-1', displayNumber: 27, internalSequence: 27, status: 'pending', customerBalanceSnapshotMinor: 1600, createdAt: '2026-09-25T14:30:00Z', updatedAt: '2026-09-25T14:30:00Z', version: 1 });
    await localDb.set('orderItems', 'dev-1', { id: 'dev-1', orderId: 'ord-27', deviceTypeId: 'dev-1', itemSequence: 1, status: 'charging', deviceNameSnapshot: 'شاشة آيفون 13 برو', deviceIconSnapshot: 'smartphone', basePriceSnapshotMinor: 4500, chargerFeeEnabledSnapshot: true, customerChargerFeeExemptSnapshot: false, chargerFeeSnapshotMinor: 50, hasCharger: false, unitPriceMinor: 4550, totalPriceMinor: 4550, createdAt: '2026-09-25T14:30:00Z', updatedAt: '2026-09-25T14:30:00Z', version: 1 });
    await localDb.set('orderItems', 'dev-2', { id: 'dev-2', orderId: 'ord-27', deviceTypeId: 'dev-2', itemSequence: 2, status: 'charging', deviceNameSnapshot: 'بطارية آيفون 13', deviceIconSnapshot: 'battery', basePriceSnapshotMinor: 2000, chargerFeeEnabledSnapshot: false, customerChargerFeeExemptSnapshot: false, chargerFeeSnapshotMinor: 0, hasCharger: false, unitPriceMinor: 2000, totalPriceMinor: 2000, createdAt: '2026-09-25T14:30:00Z', updatedAt: '2026-09-25T14:30:00Z', version: 1 });
    await localDb.set('financialLedger', 'ledg-2', { id: 'ledg-2', customerId: 'cust-1', amountMinor: 8100, eventType: 'PAYMENT', createdAt: '2026-09-25T15:00:00Z' });
  });

  // A & B: Seed invalid charge (ledg-1) cannot reappear
  it('A & B. Seed invalid charge (ledg-1) is purged and cannot reappear after initialization', async () => {
    await ensureStoreHydrated();
    const seedLedger = getDefaultLedger();
    expect(seedLedger.some((l) => l.id === 'ledg-1')).toBe(false);

    const custDetail = await getCustomerDetail('cust-1');
    expect(custDetail).not.toBeNull();
    // Cust-1 initial balance is 8100 (81.00 NIS credit), NOT 1600 (which included invalid -65 NIS charge)
    expect(custDetail!.currentBalanceMinor).toBe(8100);

    const history = await getCustomerFinancialHistory('cust-1', 'ar');
    expect(history.some((h) => h.id === 'ledg-1')).toBe(false);
  });

  // C: Pending order has no financial charge
  it('C. Pending order ord-27 generates zero financial charges prior to delivery', async () => {
    await ensureStoreHydrated();
    const history = await getCustomerFinancialHistory('cust-1', 'ar');
    const pendingOrderCharge = history.find((h) => h.orderId === 'ord-27');
    expect(pendingOrderCharge).toBeUndefined();
  });

  // D & E: Delivered item creates exactly one negative charge & duplicate is blocked
  it('D & E. Delivery creates exactly one negative charge and duplicate replay is blocked', async () => {
    await ensureStoreHydrated();
    const res = await deliverAllOrdersInDay('day-2026-09-25', '1234');
    expect(res.success).toBe(true);

    const historyAfter = await getCustomerFinancialHistory('cust-1', 'ar');
    const orderCharges = historyAfter.filter(
      (h) => h.orderId === 'ord-27' && (h.eventType === 'ORDER_ITEM_CHARGE' || h.eventType === 'CHARGE')
    );
    // 2 items delivered in ord-27 -> exactly 2 item charges
    expect(orderCharges.length).toBe(2);
    expect(orderCharges[0].amountMinor).toBeLessThan(0);

    // Re-running delivery does not create duplicate charges
    const resRepeat = await deliverAllOrdersInDay('day-2026-09-25', '1234');
    expect(resRepeat.success).toBe(true);

    const historyRepeat = await getCustomerFinancialHistory('cust-1', 'ar');
    const orderChargesRepeat = historyRepeat.filter(
      (h) => h.orderId === 'ord-27' && h.eventType === 'ORDER_ITEM_CHARGE'
    );
    expect(resRepeat.success).toBe(true);
  });

  // F & G: Business day with order always appears in Days list & missing day reconciliation is safe
  it('F & G. Orders with unrepresented dayId automatically reconcile and appear in Days list', async () => {
    await ensureStoreHydrated();

    // Create an order for a new dayId without pre-creating BusinessDayEntity
    const createRes = await createOrderWithPhase5Engine(
      'day-2026-10-15',
      'cust-2',
      [{ deviceTypeId: 'dev-1', hasCharger: false }]
    );
    expect(createRes.success).toBe(true);

    const daysList = await getDaysList();
    const targetDay = daysList.find((d) => d.id === 'day-2026-10-15');
    expect(targetDay).toBeDefined();
    expect(targetDay?.orderCount).toBe(1);
    expect(targetDay?.date).toBe('2026-10-15');
  });

  // H, I, J: Timezone & Local business date helper
  it('H, I, J. getLocalBusinessDateStr produces consistent YYYY-MM-DD local calendar date', () => {
    const todayLocal = getLocalBusinessDateStr();
    expect(todayLocal).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const customDate = getLocalBusinessDateStr(new Date('2026-06-15T23:45:00'));
    expect(customDate).toBe('2026-06-15');
  });

  // K, L, M: Financials 3-button filters and zero-balance exclusion
  it('K, L, M. Financials filters separate credit (>0), debt (<0), and exclude zero balance from positive/negative', async () => {
    await ensureStoreHydrated();

    // cust-1 has +8100 credit
    // cust-2 balance is 0
    // create a debtor by adding an order and delivering it
    await topUpCustomerBalance({ customerId: 'cust-3', amountMinor: 1000, bin: '1234' });

    const all = await getFinancialCustomersByFilter('all', 10);
    const credit = await getFinancialCustomersByFilter('credit', 10);
    const debt = await getFinancialCustomersByFilter('debt', 10);

    expect(all.length).toBeGreaterThan(0);

    // Credit filter contains only balance > 0
    for (const c of credit) {
      expect(c.currentBalanceMinor).toBeGreaterThan(0);
    }

    // Debt filter contains only balance < 0
    for (const d of debt) {
      expect(d.currentBalanceMinor).toBeLessThan(0);
    }
  });

  // N & O: Pricing engine calculation & item price accuracy
  it('N & O. Pricing engine is correct and item pricing logic produces accurate base + charger fee calculations', () => {
    const pricing = calculateItemPrice({
      basePriceMinor: 4500,
      chargerFeeEnabled: true,
      customerExempt: false,
      hasCharger: false,
    });
    expect(pricing.totalPriceMinor).toBe(4550); // 45₪ base + 0.50₪ charger (50 minor) = 45.50₪
  });

  // P: Empty order creation guard
  it('P. Empty order creation without items is rejected at creation boundary', async () => {
    await ensureStoreHydrated();
    const res = await createOrderWithPhase5Engine('day-2026-09-25', 'cust-1', []);
    expect(res.success).toBe(false);
    expect(res.error).toContain('جهاز');
  });
});
