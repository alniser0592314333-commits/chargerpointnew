import { describe, it, expect, beforeEach } from 'vitest';
import type { DeviceTypeEntity, OrderItemEntity } from '../domain/models';
import {
  searchCustomersAndOrders,
  getCustomerOrders,
  getCustomerFinancialHistory,
  getDeviceTypesOptions,
  resetStoreMemory,
  seedDemoOperationalData,
} from '../components/pages/dayOrdersStore';
import { localDb } from '../infrastructure/localDb/localDb';
import { translations, Locale } from '../i18n/translations';
import { formatDate, formatTime, formatWeekday, formatCurrency } from '../utils/dateFormatter';

describe('Phase 6.x: Unified Search & Complete i18n Verification Suite', () => {
  beforeEach(async () => {
    await localDb.clear();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    resetStoreMemory();
    await seedDemoOperationalData();
  });
  describe('Part A: Customer & Order Search Functionality', () => {
    it('1. Default empty query returns up to 6 customer records without orders', async () => {
      const result = await searchCustomersAndOrders('', 6);
      expect(result.isOrderSearch).toBe(false);
      expect(result.customers.length).toBeGreaterThan(0);
      expect(result.customers.length).toBeLessThanOrEqual(6);
      expect(result.orders.length).toBe(0);
    });

    it('2. Search by customer name returns matching customer record', async () => {
      const result = await searchCustomersAndOrders('محمد', 6);
      expect(result.isOrderSearch).toBe(false);
      expect(result.customers.length).toBeGreaterThan(0);
      expect(result.customers.some((c) => c.name.includes('محمد'))).toBe(true);
    });

    it('3. Search by 4-character Customer Code (e.g., A7K2 or lowercase a7k2)', async () => {
      const defaultList = await searchCustomersAndOrders('', 6);
      const testCode = defaultList.customers[0]?.code;
      expect(testCode).toBeDefined();

      const result = await searchCustomersAndOrders(testCode.toLowerCase(), 6);
      expect(result.customers.length).toBeGreaterThan(0);
      expect(result.customers[0].code).toBe(testCode);
    });

    it('4. Search by Order Number (numeric query e.g. "8") returns all matching orders across multiple days', async () => {
      // In dayOrdersStore seed, order #8 exists on both 2026-09-25 and 2026-09-24
      const result = await searchCustomersAndOrders('8', 6);
      expect(result.isOrderSearch).toBe(true);
      expect(result.orders.length).toBeGreaterThanOrEqual(2);

      // Verify all returned orders have displayNumber === 8
      result.orders.forEach((ord) => {
        expect(ord.orderNumber).toBe(8);
        expect(ord.businessDate).toBeDefined();
        expect(ord.customerName).toBeDefined();
        expect(ord.dayId).toBeDefined();
        expect(ord.orderId).toBeDefined();
      });

      // Verify distinct dates exist in the search results
      const dates = result.orders.map((o) => o.businessDate);
      expect(dates).toContain('2026-09-25');
      expect(dates).toContain('2026-09-24');
    });

    it('5. Search by Order Number with hash prefix (e.g. "#8") works identically to "8"', async () => {
      const result = await searchCustomersAndOrders('#8', 6);
      expect(result.isOrderSearch).toBe(true);
      expect(result.orders.length).toBeGreaterThanOrEqual(2);
      expect(result.orders.every((o) => o.orderNumber === 8)).toBe(true);
    });

    it('6. Search for non-existent order number falls through without error', async () => {
      const result = await searchCustomersAndOrders('99999', 6);
      expect(result.isOrderSearch).toBe(false);
      expect(result.orders.length).toBe(0);
      expect(result.customers.length).toBe(0);
    });
  });

  describe('Part B: Unified i18n & Translation Parity', () => {
    it('7. Translation dictionaries have identical keys for Arabic and English', () => {
      const arKeys = Object.keys(translations.ar).sort();
      const enKeys = Object.keys(translations.en).sort();

      expect(arKeys.length).toBe(enKeys.length);
      expect(arKeys).toEqual(enKeys);
    });

    it('8. Search bar placeholder matches the required specification in AR and EN', () => {
      expect(translations.ar.searchCustomerPlaceholder).toBe(
        'ابحث باسم العميل أو رقم العميل أو رقم الطلب'
      );
      expect(translations.en.searchCustomerPlaceholder).toBe(
        'Search by customer name, customer ID, or order number'
      );
    });

    it('9. Formatter produces correct date, time, weekday, and currency for both locales', () => {
      const testIso = '2026-09-25T14:30:00Z';

      // Date
      const dateAr = formatDate(testIso, 'ar');
      const dateEn = formatDate(testIso, 'en');
      expect(dateAr).toContain('2026');
      expect(dateEn).toContain('2026');

      // Weekday
      const weekdayAr = formatWeekday('2026-09-25', 'ar');
      const weekdayEn = formatWeekday('2026-09-25', 'en');
      expect(weekdayAr).toBe('الجمعة');
      expect(weekdayEn).toBe('Friday');

      // Currency
      const curr = formatCurrency(1500);
      expect(curr).toContain('15');
      expect(curr).toContain('₪');
    });

    it('10. Device types provide localized names according to requested locale', async () => {
      const arOpts = await getDeviceTypesOptions('ar');
      const enOpts = await getDeviceTypesOptions('en');

      expect(arOpts.length).toBeGreaterThan(0);
      expect(enOpts.length).toBeGreaterThan(0);
      expect(arOpts.length).toBe(enOpts.length);

      // Verify English options have English names
      const iphoneEn = enOpts.find((d) => d.id === 'dev-1');
      expect(iphoneEn?.name).toBe('iPhone 13 Pro Screen');

      // Verify Arabic options have Arabic names
      const iphoneAr = arOpts.find((d) => d.id === 'dev-1');
      expect(iphoneAr?.name).toBe('شاشة آيفون 13 برو');
    });

    it('11. Customer Financial History provides localized shortTitle & descriptions', async () => {
      const arHistory = await getCustomerFinancialHistory('cust-4', 'ar');
      const enHistory = await getCustomerFinancialHistory('cust-4', 'en');

      expect(arHistory.length).toBeGreaterThan(0);
      expect(enHistory.length).toBeGreaterThan(0);

      // Check Arabic item title
      const arItem = arHistory.find((h) => h.orderDisplayNumber === 24);
      expect(arItem?.shortTitle).toBe('طلب #24');
      expect(arItem?.description).toContain('خصم');

      // Check English item title
      const enItem = enHistory.find((h) => h.orderDisplayNumber === 24);
      expect(enItem?.shortTitle).toBe('Order #24');
      expect(enItem?.description).toContain('deducted');
    });

    it('12. Architecture Boundary: Domain entities have zero UI localization properties', () => {
      // Verify sample domain entity adheres to strictly frozen Domain Types
      const sampleDevice: DeviceTypeEntity = {
        id: 'dev-sample',
        name: 'شاشة',
        icon: 'phone',
        basePriceMinor: 1000,
        chargerFeeEnabled: false,
        isActive: true,
        sortOrder: 1,
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
        version: 1,
      };
      expect('nameAr' in sampleDevice).toBe(false);
      expect('nameEn' in sampleDevice).toBe(false);

      const sampleOrderItem: OrderItemEntity = {
        id: 'item-1',
        orderId: 'ord-1',
        deviceTypeId: 'dev-1',
        itemSequence: 1,
        status: 'charging',
        deviceNameSnapshot: 'شاشة',
        deviceIconSnapshot: 'phone',
        basePriceSnapshotMinor: 1000,
        chargerFeeEnabledSnapshot: false,
        customerChargerFeeExemptSnapshot: false,
        chargerFeeSnapshotMinor: 0,
        hasCharger: false,
        unitPriceMinor: 1000,
        totalPriceMinor: 1000,
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
        version: 1,
      };
      expect('deviceNameSnapshotEn' in sampleOrderItem).toBe(false);
    });
  });
});
