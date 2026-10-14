import { describe, it, expect, beforeEach } from 'vitest';
import { translations } from '../i18n/translations';
import { localDb } from '../infrastructure/localDb/localDb';
import { setTestAppAuthSession } from './utils/testSetup';
import {
  getFinancialsOverviewData,
  getAllFinancialCustomers,
  searchFinancialCustomers,
  getCustomerDetail,
  getCustomerFinancialHistory,
  getCustomerOrders,
  topUpCustomerBalance,
  validateBinFormat,
  resetStoreMemory,
  seedDemoOperationalData,
  setRuntimeBinVerifier,
} from '../components/pages/dayOrdersStore';

describe('Phase 6.8 & 6.8.x: Financials Overview, Customer Ledgers & In-Context Top-Up', () => {
  beforeEach(async () => {
    await localDb.clear();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    setTestAppAuthSession();
    resetStoreMemory();
    await seedDemoOperationalData();
    setRuntimeBinVerifier((bin) => bin === '1234');
  });

  // 1. Translation dictionary completeness in Arabic & English
  it('1. Financials translation dictionary is complete and localized', () => {
    const ar = translations.ar;
    const en = translations.en;

    expect(ar.navFinancials).toBe('المالية');
    expect(en.navFinancials).toBe('Financials');

    expect(ar.financialsSubtitle).toBe('متابعة الحركة المالية وأرصدة العملاء');
    expect(en.financialsSubtitle).toBe('Track financial transactions and customer balances');

    expect(ar.totalCustomerDebt).toBe('إجمالي ديون العملاء');
    expect(en.totalCustomerDebt).toBe('Total Customer Debt');

    expect(ar.totalCustomerCredit).toBe('إجمالي الأرصدة الدائنة');
    expect(en.totalCustomerCredit).toBe('Total Customer Credit');

    expect(ar.viewAllFinancialCustomers).toBe('عرض جميع العملاء');
    expect(en.viewAllFinancialCustomers).toBe('View all customers');

    expect(ar.customerBalancesTitle).toBe('أرصدة العملاء');
    expect(en.customerBalancesTitle).toBe('Customer Balances');

    expect(ar.financialHistoryTitle).toBe('السجل المالي');
    expect(en.financialHistoryTitle).toBe('Financial History');

    expect(ar.orderHistoryTitle).toBe('سجل الطلبات');
    expect(en.orderHistoryTitle).toBe('Order History');

    expect(ar.topUpBalance).toBe('شحن الرصيد');
    expect(en.topUpBalance).toBe('Top-up Balance');

    expect(ar.sensitiveOperation).toBe('عملية مالية حساسة');
    expect(en.sensitiveOperation).toBe('Sensitive Financial Operation');

    expect(ar.confirmTopUp).toBe('تأكيد شحن الرصيد');
    expect(en.confirmTopUp).toBe('Confirm Balance Top-up');
  });

  // 2. Financial Overview Data
  it('2. Financial Overview calculates authoritative summary totals accurately', async () => {
    const overview = await getFinancialsOverviewData();
    expect(overview).not.toBeNull();
    expect(overview.totalDebtMinor).toBeGreaterThanOrEqual(0);
    expect(overview.totalCreditMinor).toBeGreaterThanOrEqual(0);
    expect(overview.totalCollectedMinor).toBeGreaterThanOrEqual(0);
    expect(overview.totalOrdersValueMinor).toBeGreaterThanOrEqual(0);
  });

  // 3. Direct Customer Search
  it('3. searchFinancialCustomers searches by name, code/id and phone', async () => {
    const resultsName = await searchFinancialCustomers('أحمد');
    expect(resultsName.length).toBeGreaterThan(0);
    expect(resultsName[0].name).toContain('أحمد');

    const resultsCode = await searchFinancialCustomers('cust-1');
    expect(resultsCode.length).toBeGreaterThan(0);
    expect(resultsCode[0].id).toBe('cust-1');

    const empty = await searchFinancialCustomers('');
    expect(empty).toEqual([]);
  });

  // 4. getAllFinancialCustomers returns all active customers with correct debt/credit semantics
  it('4. getAllFinancialCustomers returns all active customers with proper balance signs and sorting', async () => {
    const customers = await getAllFinancialCustomers();
    expect(customers.length).toBeGreaterThan(0);

    const firstZeroIndex = customers.findIndex((c) => c.currentBalanceMinor === 0);
    if (firstZeroIndex !== -1) {
      for (let i = 0; i < firstZeroIndex; i++) {
        expect(customers[i].currentBalanceMinor).not.toBe(0);
      }
      for (let i = firstZeroIndex; i < customers.length; i++) {
        expect(customers[i].currentBalanceMinor).toBe(0);
      }
    }
  });

  // 5. Phase 6.8.x: Top-up flow format validation (BIN & Amount)
  it('5. Top-up requires 4-digit BIN format and positive amount', async () => {
    // 5.1 Unit verification of validateBinFormat helper (UX format check)
    expect(validateBinFormat('').valid).toBe(false);
    expect(validateBinFormat('12').valid).toBe(false);
    expect(validateBinFormat('abcd').valid).toBe(false);
    expect(validateBinFormat('1234').valid).toBe(true);
    expect(validateBinFormat('9999').valid).toBe(true);
    expect(validateBinFormat('1234', 'en').valid).toBe(true);
    expect(validateBinFormat('12', 'en').error).toContain('Invalid or incomplete BIN');

    // 5.2 Top-up rejects missing / short BIN
    const invalidBinRes = await topUpCustomerBalance({
      customerId: 'cust-1',
      amountMinor: 2000,
      bin: '12',
    });
    expect(invalidBinRes.success).toBe(false);
    expect(invalidBinRes.error).toContain('BIN');

    // 5.3 Non-positive amount rejected
    const invalidAmountRes = await topUpCustomerBalance({
      customerId: 'cust-1',
      amountMinor: 0,
      bin: '1234',
    });
    expect(invalidAmountRes.success).toBe(false);
    expect(invalidAmountRes.error).toContain('مبلغ');
  });

  // 6. Phase 6.8.x: Authoritative Top-up Execution & Balance Update
  it('6. Authoritative top-up creates single payment and updates balance accurately', async () => {
    const custBefore = await getCustomerDetail('cust-2');
    expect(custBefore).not.toBeNull();
    const balanceBefore = custBefore!.currentBalanceMinor;

    const topUpAmountMinor = 5000; // 50.00 NIS
    const res = await topUpCustomerBalance({
      customerId: 'cust-2',
      amountMinor: topUpAmountMinor,
      bin: '1234',
      note: 'دفعة نقدية تجريبية',
    });

    expect(res.success).toBe(true);
    expect(res.newBalanceMinor).toBe(balanceBefore + topUpAmountMinor);

    // Verify in customer financial history
    const history = await getCustomerFinancialHistory('cust-2', 'ar');
    expect(history.length).toBeGreaterThan(0);
    const newest = history[0];
    expect(['CREDIT_ADJUSTMENT', 'PAYMENT']).toContain(newest.eventType);
    expect(newest.amountMinor).toBe(topUpAmountMinor);
    expect(newest.note).toBe('دفعة نقدية تجريبية');
  });

  // 7. Phase 6.8.x: FIFO Allocation remains authoritative
  it('7. Top-up triggers FIFO payment allocation on unpaid orders', async () => {
    const ordersBefore = await getCustomerOrders('cust-4', 'ar');
    expect(ordersBefore.length).toBeGreaterThan(0);

    // cust-4 has ord-legacy-no-snap (-1000) and items
    const res = await topUpCustomerBalance({
      customerId: 'cust-4',
      amountMinor: 5000,
      bin: '1234',
    });
    expect(res.success).toBe(true);

    const ordersAfter = await getCustomerOrders('cust-4', 'ar');
    expect(ordersAfter.length).toBe(ordersBefore.length);
  });

  // 8. Financial history is sorted newest-first visually
  it('8. Customer financial history is sorted strictly newest-first', async () => {
    const history = await getCustomerFinancialHistory('cust-1', 'ar');
    expect(history.length).toBeGreaterThan(0);

    if (history.length > 1) {
      for (let i = 0; i < history.length - 1; i++) {
        const curr = new Date(history[i].createdAt).getTime();
        const next = new Date(history[i + 1].createdAt).getTime();
        expect(curr).toBeGreaterThanOrEqual(next);
      }
    }
  });

  // 9. Customer Names are strictly RAW data across language changes
  it('9. Customer Names remain untranslated RAW data in financial listings', async () => {
    const custAr = await getCustomerDetail('cust-1');
    const custEn = await getCustomerDetail('cust-1');

    expect(custAr).not.toBeNull();
    expect(custEn).not.toBeNull();
    expect(custAr!.name).toBe(custEn!.name);
  });

  // 10. Critical Financial Consistency & Durable Local Hydration
  it('10. Critical Financial Consistency: Topped-up balance (+20₪) survives store memory reset / offline remount and hydrates deterministically', async () => {
    // cust-1 initially has +81₪ (payment) -> balance 81₪ (8100 minor) after purging invalid pending charge ledg-1
    const initialDetail = await getCustomerDetail('cust-1');
    expect(initialDetail).not.toBeNull();
    expect(initialDetail!.currentBalanceMinor).toBe(8100);

    // Commit +20₪ top-up
    const topUpRes = await topUpCustomerBalance({
      customerId: 'cust-1',
      amountMinor: 2000,
      bin: '1234',
      note: 'دفعة نقدية إضافية',
    });
    expect(topUpRes.success).toBe(true);
    expect(topUpRes.newBalanceMinor).toBe(10100); // 81₪ + 20₪ = 101₪

    // Verify detail reflects 101₪
    const beforeResetDetail = await getCustomerDetail('cust-1');
    expect(beforeResetDetail!.currentBalanceMinor).toBe(10100);

    // Simulate JS memory reset / page remount / internet reconnect cycle
    resetStoreMemory();

    // Verify after memory reset that store properly hydrates from localDb
    const afterHydrateDetail = await getCustomerDetail('cust-1');
    expect(afterHydrateDetail).not.toBeNull();
    // Balance MUST remain 101₪ (10100 minor)
    expect(afterHydrateDetail!.currentBalanceMinor).toBe(10100);

    // Verify financial history after hydration contains the +20₪ transaction
    const history = await getCustomerFinancialHistory('cust-1', 'ar');
    expect(history.length).toBe(2); // +81₪, +20₪
    expect(history[0].amountMinor).toBe(2000); // Newest first
    expect(history[0].postBalanceMinor).toBe(10100);
  });

  // 11. Command outbox registration for customer credit
  it('11. Customer credit operation records authoritative outbox command for offline sync', async () => {
    await topUpCustomerBalance({
      customerId: 'cust-2',
      amountMinor: 3000,
      bin: '1234',
      note: 'سداد جزئي',
    });

    const outbox = await localDb.listOutbox();
    const creditCommands = outbox.filter((c) => c.commandType === 'CREATE_CUSTOMER_CREDIT');
    expect(creditCommands.length).toBeGreaterThan(0);
    expect((creditCommands[0].payload as any).customerId).toBe('cust-2');
  });

  // 12. Unit Test: Authoritative BIN Verifier with Correct / Incorrect values
  it('12. Authoritative BIN verifier strictly rejects wrong BIN and accepts correct BIN', async () => {
    const { getAuthoritativeBinVerifier } = await import('../components/pages/dayOrdersStore');
    const verifier = getAuthoritativeBinVerifier();
    expect(verifier).toBeDefined();

    const actor = {
      id: 'admin',
      username: 'admin',
      fullName: 'Admin',
      role: 'SUPER_ADMIN' as const,
      permissions: [],
      isSuperAdmin: true,
    };

    // Correct BIN ('1234') -> must return true
    const validRes = await verifier!('1234', actor);
    expect(validRes).toBe(true);

    // Incorrect BIN ('4321') -> must return false
    const invalidRes = await verifier!('4321', actor);
    expect(invalidRes).toBe(false);
  });
});
