import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { setTestAppAuthSession } from './utils/testSetup';
import {
  resetStoreMemory,
  seedDemoOperationalData,
  ensureStoreHydrated,
  addDeviceTypeWithPhase5,
  createOrderWithPhase5Engine,
  getPublicOrderByToken,
  getItemLocalizedDeviceName,
  setRuntimeBinVerifier,
  getOrCreateOrderQrToken,
} from '../components/pages/dayOrdersStore';
import { rpcGetOrCreateOrderQr } from '../services/supabase/client';

describe('Bilingual Order Item Name in QR Page Resolution', () => {
  beforeEach(async () => {
    await localDb.clear();
    setTestAppAuthSession();
    resetStoreMemory();
    await seedDemoOperationalData();
    await ensureStoreHydrated();
    setRuntimeBinVerifier((bin) => bin === '1234');
  });

  it('1. Resolves English device name when locale is "en"', async () => {
    // 1. Get seeded order
    const orders = await localDb.list<any>('orders');
    expect(orders.length).toBeGreaterThan(0);
    const sampleOrder = orders.find((o) => o.id === 'ord-27') || orders[0];

    // 2. Generate/fetch token
    const token = await getOrCreateOrderQrToken(sampleOrder.id);
    expect(token).toBeTruthy();

    // 3. Resolve via public resolver
    const publicOrder = await getPublicOrderByToken(token);
    expect(publicOrder).not.toBeNull();
    expect(publicOrder?.items?.length).toBeGreaterThan(0);

    const firstItem = publicOrder!.items![0];
    expect(firstItem.name).toBe('شاشة آيفون 13 برو');
    expect(firstItem.name_en).toBe('iPhone 13 Pro Screen');

    const resolveDisplayName = (item: any, loc: 'ar' | 'en') =>
      loc === 'en'
        ? (item.name_en || getItemLocalizedDeviceName(item.device_type_id || item.name, 'en', item.name))
        : (item.name_ar || item.name);

    // Arabic display calculation
    expect(resolveDisplayName(firstItem, 'ar')).toBe('شاشة آيفون 13 برو');

    // English display calculation
    expect(resolveDisplayName(firstItem, 'en')).toBe('iPhone 13 Pro Screen');
  });

  it('2. Falls back gracefully when device has no English name configured', () => {
    const legacyItem = {
      name: 'قطعة غيار مخصصة',
      device_type_id: 'custom-dev-id',
    };

    const resolveDisplayName = (item: any, loc: 'ar' | 'en') =>
      loc === 'en'
        ? (item.name_en || getItemLocalizedDeviceName(item.device_type_id || item.name, 'en', item.name))
        : (item.name_ar || item.name);

    expect(resolveDisplayName(legacyItem, 'en')).toBe('قطعة غيار مخصصة');
  });
});
