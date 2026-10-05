import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  addDeviceTypeWithPhase5,
  updateDeviceTypeWithPhase5,
  getAllDeviceTypes,
  getDeviceTypesOptions,
  getDeviceDisplayName,
  getItemLocalizedDeviceName,
  createOrderWithPhase5Engine,
  getOrdersForDay,
  getCustomerOrders,
  resetStoreMemory,
  seedDemoOperationalData,
  setRuntimeBinVerifier,
  ensureStoreHydrated,
} from '../components/pages/dayOrdersStore';

describe('Bilingual Device Types (Arabic + English Dedicated Fields)', () => {
  beforeEach(async () => {
    await localDb.clear();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    resetStoreMemory();
    await seedDemoOperationalData();
    await ensureStoreHydrated();
    setRuntimeBinVerifier((bin) => bin === '1234');
  });

  it('1. Adds a new device type with both Arabic and English names', async () => {
    const res = await addDeviceTypeWithPhase5(
      'هاتف شاومي نوت 13',
      3500,
      true,
      10,
      true,
      'Xiaomi Redmi Note 13',
      'هاتف شاومي نوت 13'
    );
    expect(res.success).toBe(true);
    expect(res.data).toBeDefined();
    const dev = res.data!;
    expect(dev.nameAr).toBe('هاتف شاومي نوت 13');
    expect(dev.nameEn).toBe('Xiaomi Redmi Note 13');

    // Display Name in Arabic mode
    expect(getDeviceDisplayName(dev, 'ar')).toBe('هاتف شاومي نوت 13');
    // Display Name in English mode
    expect(getDeviceDisplayName(dev, 'en')).toBe('Xiaomi Redmi Note 13');

    // Global helper by ID in Arabic & English
    expect(getItemLocalizedDeviceName(dev.id, 'ar')).toBe('هاتف شاومي نوت 13');
    expect(getItemLocalizedDeviceName(dev.id, 'en')).toBe('Xiaomi Redmi Note 13');
  });

  it('2. getDeviceTypesOptions returns the correct language based on active locale', async () => {
    const res = await addDeviceTypeWithPhase5(
      'سامسونج الترا',
      5000,
      true,
      20,
      true,
      'Samsung Galaxy Ultra',
      'سامسونج الترا'
    );
    expect(res.success).toBe(true);

    const arOpts = await getDeviceTypesOptions('ar');
    const enOpts = await getDeviceTypesOptions('en');

    const addedAr = arOpts.find((o) => o.id === res.data!.id);
    const addedEn = enOpts.find((o) => o.id === res.data!.id);

    expect(addedAr?.name).toBe('سامسونج الترا');
    expect(addedEn?.name).toBe('Samsung Galaxy Ultra');
  });

  it('3. Orders with bilingual device types reflect current language in order details and reports', async () => {
    const devRes = await addDeviceTypeWithPhase5(
      'ايباد برو',
      8000,
      true,
      1,
      true,
      'iPad Pro M4',
      'ايباد برو'
    );
    const devId = devRes.data!.id;

    const ordRes = await createOrderWithPhase5Engine('day-2026-10-02', 'cust-1', [
      { deviceTypeId: devId, hasCharger: false },
    ]);
    expect(ordRes.success).toBe(true);
    const orderId = ordRes.order!.id;

    // In Arabic locale
    const arDayOrders = await getOrdersForDay('day-2026-10-02', 'ar');
    const arOrder = arDayOrders.find((o) => o.id === orderId);
    expect(arOrder?.items[0].deviceName).toContain('ايباد برو');

    // In English locale
    const enDayOrders = await getOrdersForDay('day-2026-10-02', 'en');
    const enOrder = enDayOrders.find((o) => o.id === orderId);
    expect(enOrder?.items[0].deviceName).toContain('iPad Pro M4');

    // In Customer Orders Summary
    const arCustOrders = await getCustomerOrders('cust-1', 'ar');
    expect(arCustOrders.find((o) => o.id === orderId)?.items[0].deviceName).toBe('ايباد برو');

    const enCustOrders = await getCustomerOrders('cust-1', 'en');
    expect(enCustOrders.find((o) => o.id === orderId)?.items[0].deviceName).toBe('iPad Pro M4');
  });

  it('4. Updating Arabic and English names updates both locales seamlessly', async () => {
    const devRes = await addDeviceTypeWithPhase5(
      'اسم مؤقت',
      1000,
      true,
      1,
      true,
      'Temp Name',
      'اسم مؤقت'
    );
    const devId = devRes.data!.id;

    const updateRes = await updateDeviceTypeWithPhase5(devId, {
      nameAr: 'شاحن أنكر 65 واط',
      nameEn: 'Anker 65W GaN Charger',
      priceMinor: 2500,
    });
    expect(updateRes.success).toBe(true);

    const all = await getAllDeviceTypes();
    const updated = all.find((d) => d.id === devId);
    expect(updated?.nameAr).toBe('شاحن أنكر 65 واط');
    expect(updated?.nameEn).toBe('Anker 65W GaN Charger');

    expect(getDeviceDisplayName(updated!, 'ar')).toBe('شاحن أنكر 65 واط');
    expect(getDeviceDisplayName(updated!, 'en')).toBe('Anker 65W GaN Charger');
  });
});
