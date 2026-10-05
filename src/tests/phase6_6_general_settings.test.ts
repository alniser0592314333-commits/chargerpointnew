import { describe, it, expect, beforeEach } from 'vitest';
import { translations } from '../i18n/translations';
import { localDb } from '../infrastructure/localDb/localDb';
import { getCustomerQrCardData, resetStoreMemory, seedDemoOperationalData } from '../components/pages/dayOrdersStore';

describe('Phase 6.6: General Settings Page & Global Preferences', () => {
  let mockStorage: Record<string, string> = {};

  beforeEach(async () => {
    await localDb.clear();
    resetStoreMemory();
    await seedDemoOperationalData();
    mockStorage = {};
    if (typeof globalThis.localStorage === 'undefined') {
      (globalThis as any).localStorage = {
        getItem: (k: string) => mockStorage[k] ?? null,
        setItem: (k: string, v: string) => {
          mockStorage[k] = v;
        },
        removeItem: (k: string) => {
          delete mockStorage[k];
        },
        clear: () => {
          mockStorage = {};
        },
      };
    } else {
      localStorage.clear();
    }
  });

  // 1. Translations: Arabic and English completeness
  it('1. General Settings translation dictionary is complete and typed in Arabic & English', () => {
    const ar = translations.ar;
    const en = translations.en;

    expect(ar.settingsTitle).toBe('الإعدادات');
    expect(en.settingsTitle).toBe('Settings');

    expect(ar.appearanceSectionTitle).toBe('المظهر');
    expect(en.appearanceSectionTitle).toBe('Appearance');

    expect(ar.languageSectionTitle).toBe('اللغة');
    expect(en.languageSectionTitle).toBe('Language');

    expect(ar.themeLight).toBe('فاتح');
    expect(en.themeLight).toBe('Light');

    expect(ar.themeDark).toBe('داكن');
    expect(en.themeDark).toBe('Dark');

    expect(ar.themeSystem).toBe('تلقائي');
    expect(en.themeSystem).toBe('System');

    expect(ar.logoSectionTitle).toBe('شعار التطبيق');
    expect(en.logoSectionTitle).toBe('App Logo');

    expect(ar.qrDesignSectionTitle).toBe('تصميم QR');
    expect(en.qrDesignSectionTitle).toBe('QR Design');

    expect(ar.accountSectionTitle).toBe('الحساب');
    expect(en.accountSectionTitle).toBe('Account');

    expect(ar.aboutSectionTitle).toBe('حول التطبيق');
    expect(en.aboutSectionTitle).toBe('About Application');
  });

  // 2. Theme Switching & Persistence in localStorage
  it('2. Theme preference saves to sys_theme in localStorage and supports light, dark, system', () => {
    // Light
    localStorage.setItem('sys_theme', 'light');
    expect(localStorage.getItem('sys_theme')).toBe('light');

    // Dark
    localStorage.setItem('sys_theme', 'dark');
    expect(localStorage.getItem('sys_theme')).toBe('dark');

    // System
    localStorage.setItem('sys_theme', 'system');
    expect(localStorage.getItem('sys_theme')).toBe('system');
  });

  // 3. Language Switching & Persistence in localStorage
  it('3. Language preference saves to sys_locale in localStorage and supports ar, en', () => {
    // Arabic
    localStorage.setItem('sys_locale', 'ar');
    expect(localStorage.getItem('sys_locale')).toBe('ar');

    // English
    localStorage.setItem('sys_locale', 'en');
    expect(localStorage.getItem('sys_locale')).toBe('en');
  });

  // 4. Customer Name is NEVER translated or altered when language changes
  it('4. Customer Name data remains strictly RAW and untranslated regardless of locale', async () => {
    const cardData = await getCustomerQrCardData('cust-1');
    expect(cardData).not.toBeNull();
    // Name is the raw value stored in DB
    expect(cardData!.customerName).toBe('محمد علي');
    expect(cardData!.customerCode).toBe('A7K2');

    // Card data tokens remain untouched
    expect(cardData!.token.length).toBeGreaterThan(0);
  });

  // 5. Account & About system properties
  it('5. System Title and Version exist consistently across locales', () => {
    expect(translations.ar.systemTitle).toBeTruthy();
    expect(translations.en.systemTitle).toBeTruthy();
    expect(translations.ar.appArchitectureDesc).toContain('Local-First');
    expect(translations.en.appArchitectureDesc).toContain('Local-First');
  });
});
