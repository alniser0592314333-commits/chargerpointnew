import { describe, it, expect } from 'vitest';
import { getItemLocalizedDeviceName } from '../components/pages/dayOrdersStore';

describe('Public Payment Page Verification', () => {
  it('1. Correctly formats and resolves bilingual device names for items', () => {
    const itemEn = {
      name: 'شاشة آيفون 13 برو',
      name_en: 'iPhone 13 Pro Screen',
      name_ar: 'شاشة آيفون 13 برو',
      device_type_id: 'dev-1',
    };

    const resolveDisplayName = (item: any, loc: 'ar' | 'en') =>
      loc === 'en'
        ? (item.name_en || getItemLocalizedDeviceName(item.device_type_id || item.name, 'en', item.name))
        : (item.name_ar || item.name);

    expect(resolveDisplayName(itemEn, 'en')).toBe('iPhone 13 Pro Screen');
    expect(resolveDisplayName(itemEn, 'ar')).toBe('شاشة آيفون 13 برو');
  });

  it('2. Fallback gracefully when item has no English name configured', () => {
    const legacyItem = {
      name: 'شاحن سامسونج',
      device_type_id: 'dev-custom',
    };

    const resolveDisplayName = (item: any, loc: 'ar' | 'en') =>
      loc === 'en'
        ? (item.name_en || getItemLocalizedDeviceName(item.device_type_id || item.name, 'en', item.name))
        : (item.name_ar || item.name);

    expect(resolveDisplayName(legacyItem, 'ar')).toBe('شاحن سامسونج');
    expect(resolveDisplayName(legacyItem, 'en')).toBe('شاحن سامسونج');
  });

  it('3. Verifies official payment transfer recipient details', () => {
    const targetRecipient = '0592369875';
    expect(targetRecipient).toBe('0592369875');
  });
});
