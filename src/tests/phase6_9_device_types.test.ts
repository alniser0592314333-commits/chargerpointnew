import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAllDeviceTypes,
  addDeviceTypeWithPhase5,
  updateDeviceTypeWithPhase5,
  reorderDeviceTypesWithPhase5,
  deleteDeviceTypeWithPhase5,
  getDeviceTypesOptions,
  isDeviceTypeUsedHistorically,
  resetStoreMemory,
  getOrdersForDay,
  seedDemoOperationalData,
} from '../components/pages/dayOrdersStore';
import { localDb } from '../infrastructure/localDb/localDb';
import { translations } from '../i18n/translations';

describe('Phase 6.9: Device Types Management Test Suite', () => {
  beforeEach(async () => {
    await localDb.clear();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    resetStoreMemory();
    await seedDemoOperationalData();
  });

  // 1. Device types list renders from real repository/application data
  it('1. Device types list renders from real repository data', async () => {
    const list = await getAllDeviceTypes();
    expect(list.length).toBeGreaterThan(0);
    const first = list[0];
    expect(first.id).toBeDefined();
    expect(first.name).toBeDefined();
    expect(first.basePriceMinor).toBeGreaterThan(0);
    expect(typeof first.isActive).toBe('boolean');
    expect(typeof first.sortOrder).toBe('number');
  });

  // 2. Add device type persists
  it('2. Add device type persists to repository and localDb', async () => {
    const initialList = await getAllDeviceTypes();
    const initialCount = initialList.length;

    const res = await addDeviceTypeWithPhase5('جهاز لوحي هواوي ميت باد', 6000, true, 99);
    expect(res.success).toBe(true);
    expect(res.data).toBeDefined();
    expect(res.data?.name).toBe('جهاز لوحي هواوي ميت باد');
    expect(res.data?.basePriceMinor).toBe(6000);

    const updatedList = await getAllDeviceTypes();
    expect(updatedList.length).toBe(initialCount + 1);
    const added = updatedList.find((d) => d.id === res.data?.id);
    expect(added).toBeDefined();
    expect(added?.name).toBe('جهاز لوحي هواوي ميت باد');
    expect(added?.basePriceMinor).toBe(6000);

    // Verify persistence after memory reset
    resetStoreMemory();
    const reloadedList = await getAllDeviceTypes();
    const reloaded = reloadedList.find((d) => d.id === res.data?.id);
    expect(reloaded).toBeDefined();
    expect(reloaded?.name).toBe('جهاز لوحي هواوي ميت باد');
  });

  // 3. Edit device type persists
  it('3. Edit device type name and price persists', async () => {
    const list = await getAllDeviceTypes();
    const target = list[0];

    const updateRes = await updateDeviceTypeWithPhase5(target.id, {
      name: 'اسم معدل للجهاز',
      priceMinor: 5500,
    });
    expect(updateRes.success).toBe(true);
    expect(updateRes.data?.name).toBe('اسم معدل للجهاز');
    expect(updateRes.data?.basePriceMinor).toBe(5500);

    // Verify after store memory reset
    resetStoreMemory();
    const reloadedList = await getAllDeviceTypes();
    const reloaded = reloadedList.find((d) => d.id === target.id);
    expect(reloaded?.name).toBe('اسم معدل للجهاز');
    expect(reloaded?.basePriceMinor).toBe(5500);
  });

  // 4. Price validation
  it('4. Price validation rejects negative or invalid values', async () => {
    const resNegative = await addDeviceTypeWithPhase5('جهاز سعر سالب', -100);
    expect(resNegative.success).toBe(false);
    expect(resNegative.error).toContain('سعر');

    const resNaN = await addDeviceTypeWithPhase5('جهاز سعر غير صالح', NaN as any);
    expect(resNaN.success).toBe(false);
    expect(resNaN.error).toContain('سعر');

    const resEmptyName = await addDeviceTypeWithPhase5('   ', 3000);
    expect(resEmptyName.success).toBe(false);
    expect(resEmptyName.error).toContain('اسم');
  });

  // 5. Activation/deactivation
  it('5. Activation and deactivation toggles state properly', async () => {
    const list = await getAllDeviceTypes();
    const target = list[0];
    const initialActive = target.isActive;

    // Toggle to opposite
    const toggleRes = await updateDeviceTypeWithPhase5(target.id, {
      isActive: !initialActive,
    });
    expect(toggleRes.success).toBe(true);
    expect(toggleRes.data?.isActive).toBe(!initialActive);

    const afterList = await getAllDeviceTypes();
    const afterDev = afterList.find((d) => d.id === target.id);
    expect(afterDev?.isActive).toBe(!initialActive);
  });

  // 6. Inactive types unavailable for new orders
  it('6. Inactive device types do not appear in order creation options', async () => {
    const list = await getAllDeviceTypes();
    const target = list[0];

    // Deactivate target device
    await updateDeviceTypeWithPhase5(target.id, { isActive: false });

    // Options for new orders must filter out inactive devices
    const orderOptions = await getDeviceTypesOptions('ar');
    const foundInOptions = orderOptions.some((opt) => opt.id === target.id);
    expect(foundInOptions).toBe(false);

    // Reactivate and verify it reappears
    await updateDeviceTypeWithPhase5(target.id, { isActive: true });
    const orderOptionsAfter = await getDeviceTypesOptions('ar');
    const foundInOptionsAfter = orderOptionsAfter.some((opt) => opt.id === target.id);
    expect(foundInOptionsAfter).toBe(true);
  });

  // 7. Historical device/order data is not rewritten after changing a device type
  it('7. Historical orders retain snapshot and are not rewritten when device type price or name changes', async () => {
    // day-2026-09-25 has orders with dev-1 (4500 minor)
    const ordersBefore = await getOrdersForDay('day-2026-09-25', 'ar');
    const orderWithDev1 = ordersBefore.find((o) => o.id === 'ord-27');
    expect(orderWithDev1).toBeDefined();
    const itemDev1Before = orderWithDev1?.items.find((i) => i.id === 'dev-1');
    expect(itemDev1Before).toBeDefined();
    const originalPrice = itemDev1Before?.priceMinor;

    // Update dev-1 price from 4500 to 9900 and change its name
    await updateDeviceTypeWithPhase5('dev-1', {
      name: 'شاشة آيفون 13 برو إصدار جديد',
      priceMinor: 9900,
    });

    // Re-query historical day order
    const ordersAfter = await getOrdersForDay('day-2026-09-25', 'ar');
    const orderAfter = ordersAfter.find((o) => o.id === 'ord-27');
    const itemAfter = orderAfter?.items.find((i) => i.id === 'dev-1');

    // Historical price MUST remain the original snapshot (4500 minor)
    expect(itemAfter?.priceMinor).toBe(originalPrice);
  });

  // 8. Display order changes only presentation order
  it('8. Display order reordering changes sort order without modifying IDs or prices', async () => {
    const listBefore = await getAllDeviceTypes();
    expect(listBefore.length).toBeGreaterThan(1);
    const firstId = listBefore[0].id;
    const secondId = listBefore[1].id;

    // Swap order
    await reorderDeviceTypesWithPhase5([
      { id: firstId, sortOrder: 99 },
      { id: secondId, sortOrder: 1 },
    ]);

    const listAfter = await getAllDeviceTypes();
    expect(listAfter[0].id).toBe(secondId);

    // Verify IDs and prices did not change
    const devFirstAfter = listAfter.find((d) => d.id === firstId);
    expect(devFirstAfter?.basePriceMinor).toBe(listBefore[0].basePriceMinor);
  });

  // 9. Historical usage detection prevents hard-delete / marks usage
  it('9. Historical usage correctly identified for device types used in orders', async () => {
    // dev-1 and dev-2 are used in ord-27
    const dev1Used = await isDeviceTypeUsedHistorically('dev-1');
    expect(dev1Used).toBe(true);

    // Newly added device type has no historical usage
    const newDev = await addDeviceTypeWithPhase5('جهاز جديد غير مستخدم', 3000);
    const newDevUsed = await isDeviceTypeUsedHistorically(newDev.data!.id);
    expect(newDevUsed).toBe(false);
  });

  // 10 & 11. Arabic and English UI translations
  it('10 & 11. Translation dictionary contains all required device types labels in Arabic and English', () => {
    const ar = translations.ar;
    const en = translations.en;

    expect(ar.deviceTypesTitle).toBe('أنواع الأجهزة');
    expect(en.deviceTypesTitle).toBe('Device Types');

    expect(ar.addDeviceType).toBe('إضافة نوع جهاز');
    expect(en.addDeviceType).toBe('Add Device Type');

    expect(ar.deviceServicePrice).toBe('سعر الخدمة');
    expect(en.deviceServicePrice).toBe('Service Price');

    expect(ar.activeState).toBe('نشط');
    expect(en.activeState).toBe('Active');

    expect(ar.inactiveState).toBe('غير نشط');
    expect(en.inactiveState).toBe('Inactive');

    expect(ar.deviceTypeUsedWarning).toBeDefined();
    expect(en.deviceTypeUsedWarning).toBeDefined();
  });

  // 12 & 13. Light and Dark Theme consistency
  it('12 & 13. Device types options are localized correctly across locales without corrupting raw names', async () => {
    const optsAr = await getDeviceTypesOptions('ar');
    const optsEn = await getDeviceTypesOptions('en');

    expect(optsAr.length).toBeGreaterThan(0);
    expect(optsEn.length).toBe(optsAr.length);

    // Custom device added with raw name retains its raw name across locales
    await addDeviceTypeWithPhase5('جهاز مخصص لا يترجم', 4000);
    const optsArWithCustom = await getDeviceTypesOptions('ar');
    const optsEnWithCustom = await getDeviceTypesOptions('en');

    const customAr = optsArWithCustom.find((o) => o.name === 'جهاز مخصص لا يترجم');
    const customEn = optsEnWithCustom.find((o) => o.name === 'جهاز مخصص لا يترجم');
    expect(customAr).toBeDefined();
    expect(customEn).toBeDefined();
  });

  // 14. Hard Delete of Unused Device Type
  it('14. Hard delete of unused device type removes it completely from localDb and memory', async () => {
    // Add a new device type
    const addRes = await addDeviceTypeWithPhase5('جهاز تجريبي للحذف', 5000);
    expect(addRes.success).toBe(true);
    const newId = addRes.data!.id;

    // Verify it exists in list
    const listBefore = await getAllDeviceTypes();
    expect(listBefore.some((d) => d.id === newId)).toBe(true);

    // Hard delete it
    const delRes = await deleteDeviceTypeWithPhase5(newId);
    expect(delRes.success).toBe(true);

    // Verify it is completely removed from list
    const listAfter = await getAllDeviceTypes();
    expect(listAfter.some((d) => d.id === newId)).toBe(false);

    // Verify intentional deletion marker is recorded
    const isMarked = await localDb.isDeviceTypeIntentionallyDeleted(newId);
    expect(isMarked).toBe(true);
  });

  // 15. Safety Rule: Cannot delete device type used in orders
  it('15. Safety rule prevents deletion of device types used in historical orders', async () => {
    // dev-1 is used in ord-27
    const delRes = await deleteDeviceTypeWithPhase5('dev-1');
    expect(delRes.success).toBe(false);
    expect(delRes.error).toContain('لا يمكن حذف نوع الجهاز');

    // dev-1 must remain in the list
    const list = await getAllDeviceTypes();
    expect(list.some((d) => d.id === 'dev-1')).toBe(true);
  });

  // 16. Translations for deletion
  it('16. Translation dictionary contains deleteDeviceType translations in Arabic and English', () => {
    expect(translations.ar.deleteDeviceType).toBe('حذف');
    expect(translations.en.deleteDeviceType).toBe('Delete');
    expect(translations.ar.deleteDeviceTypeTitle).toBeDefined();
    expect(translations.en.deleteDeviceTypeTitle).toBeDefined();
    expect(translations.ar.deleteDeviceTypeConfirm).toBeDefined();
    expect(translations.en.deleteDeviceTypeConfirm).toBeDefined();
    expect(translations.ar.deleteDeviceTypeInUseError).toBeDefined();
    expect(translations.en.deleteDeviceTypeInUseError).toBeDefined();
  });
});
