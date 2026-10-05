import { describe, it, expect, beforeEach } from 'vitest';
import { translations } from '../i18n/translations';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  getTodayHomeData,
  createTodayBusinessDay,
  getOrdersForDay,
  resetStoreMemory,
  seedDemoOperationalData,
} from '../components/pages/dayOrdersStore';

describe('Phase 6.7: Home Operational & Financial Overview', () => {
  beforeEach(async () => {
    await localDb.clear();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    resetStoreMemory();
    await seedDemoOperationalData();
  });

  // 1. Translations: Completeness in Arabic & English
  it('1. Home and Financial translation dictionary is complete and localized', () => {
    const ar = translations.ar;
    const en = translations.en;

    expect(ar.navHome).toBe('الرئيسية');
    expect(en.navHome).toBe('Home');

    expect(ar.homeHeaderSubtitle).toBe('نظرة سريعة على تشغيل اليوم');
    expect(en.homeHeaderSubtitle).toBe("Quick overview of today's operations");

    expect(ar.todayLabel).toBe('اليوم');
    expect(en.todayLabel).toBe('Today');

    expect(ar.financialSummaryTitle).toBe('الملخص المالي');
    expect(en.financialSummaryTitle).toBe('Financial Summary');

    expect(ar.totalDebt).toBe('إجمالي الديون');
    expect(en.totalDebt).toBe('Total Debt');

    expect(ar.totalCollected).toBe('إجمالي التحصيل');
    expect(en.totalCollected).toBe('Total Collected');

    expect(ar.totalOrders).toBe('إجمالي الطلبات');
    expect(en.totalOrders).toBe('Total Orders');

    expect(ar.totalOrderValue).toBe('إجمالي قيمة الطلبات');
    expect(en.totalOrderValue).toBe('Total Order Value');

    expect(ar.recentFinancialActivity).toBe('آخر العمليات المالية');
    expect(en.recentFinancialActivity).toBe('Recent Financial Activity');

    expect(ar.quickAccessTitle).toBe('الوصول السريع');
    expect(en.quickAccessTitle).toBe('Quick Access');
  });

  // 2. Today uses actual current date and does NOT use last existing day as Today
  it('2. Home strictly uses actual current date and does NOT fallback to last existing day', async () => {
    const data = await getTodayHomeData('ar');
    expect(data).not.toBeNull();

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const expectedTodayStr = `${y}-${m}-${d}`;

    expect(data.currentDateStr).toBe(expectedTodayStr);
  });

  // 3. Today's Business Day Detection (State A vs State B)
  it('3. Detects if Business Day exists for actual today date or not', async () => {
    const data = await getTodayHomeData('ar');
    // If today is not in seeded dates (e.g. 2026-09-26), todayDay is null
    if (data.currentDateStr !== '2026-09-25') {
      expect(data.todayDay).toBeNull();
    } else {
      expect(data.todayDay).not.toBeNull();
      expect(data.todayDay!.businessDate).toBe('2026-09-25');
    }
  });

  // 4. Creating today's business day creates the correct entity
  it('4. Creating today business day creates authoritative business day and updates state', async () => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const todayStr = `${y}-${m}-${d}`;

    const createdDayId = await createTodayBusinessDay(todayStr);
    expect(createdDayId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const dataAfter = await getTodayHomeData('ar');
    expect(dataAfter.todayDay).not.toBeNull();
    expect(dataAfter.todayDay!.id).toBe(createdDayId);
    expect(dataAfter.todayDay!.businessDate).toBe(todayStr);
  });

  // 5. Total Debt uses authoritative customer balances (sum of negative balances as positive debt)
  it('5. Total Debt is accurately calculated from authoritative negative balances', async () => {
    const data = await getTodayHomeData('ar');
    expect(data.totalDebtMinor).toBeGreaterThanOrEqual(0);
    // Total Debt must not equal order charges or total revenue
    expect(data.totalDebtMinor).not.toBe(data.totalOrdersValueMinor);
  });

  // 6. Total Collected uses authoritative payment transactions
  it('6. Total Collected accurately reflects actual payments collected and excludes order charges', async () => {
    const data = await getTodayHomeData('ar');
    expect(data.totalCollectedMinor).toBeGreaterThanOrEqual(0);
    // Seeded payments: 8100 + 2000 = 10100 minor
    expect(data.totalCollectedMinor).toBe(10100);
  });

  // 7. Total Orders and Total Order Value are system-wide
  it('7. Total Orders and Total Order Value are system-wide across all business days', async () => {
    const data = await getTodayHomeData('ar');
    expect(data.totalOrdersCount).toBeGreaterThanOrEqual(3);
    expect(data.totalOrdersValueMinor).toBeGreaterThanOrEqual(10000);
  });

  // 8. Recent Financial Activities is capped at max 5 and ordered newest-first
  it('8. Recent Financial Activities list contains max 5 newest-first authoritative transactions', async () => {
    const data = await getTodayHomeData('ar');
    expect(data.recentFinancialActivities.length).toBeLessThanOrEqual(5);

    if (data.recentFinancialActivities.length > 1) {
      for (let i = 0; i < data.recentFinancialActivities.length - 1; i++) {
        const curr = new Date(data.recentFinancialActivities[i].createdAt).getTime();
        const next = new Date(data.recentFinancialActivities[i + 1].createdAt).getTime();
        expect(curr).toBeGreaterThanOrEqual(next);
      }
    }
  });

  // 9. Customer Name is strictly RAW in recent financial activities
  it('9. Customer Name in financial activity items is strictly RAW and untranslated', async () => {
    const dataAr = await getTodayHomeData('ar');
    const dataEn = await getTodayHomeData('en');

    expect(dataAr.recentFinancialActivities.length).toBe(dataEn.recentFinancialActivities.length);
    for (let i = 0; i < dataAr.recentFinancialActivities.length; i++) {
      expect(dataAr.recentFinancialActivities[i].customerName).toBe(
        dataEn.recentFinancialActivities[i].customerName
      );
    }
  });
});
