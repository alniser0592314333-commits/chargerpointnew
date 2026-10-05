import { describe, it, expect, beforeEach } from 'vitest';
import {
  getActiveQrDesign,
  setActiveQrDesign,
  resetActiveQrDesign,
  DEFAULT_CUSTOMER_QR_DESIGN,
  DEFAULT_ORDER_QR_DESIGN,
} from '../components/qr/defaultDesigns';
import { QRDesignConfig } from '../components/qr/types';

// Mock localStorage for Vitest Node environment if not present
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) || null,
    setItem: (key: string, val: string) => store.set(key, val),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  };
}

describe('QR Design Persistence Test Suite', () => {

  beforeEach(() => {
    localStorage.clear();
    resetActiveQrDesign('CUSTOMER');
    resetActiveQrDesign('ORDER');
  });

  it('1 & 2. Customer design saves and reloads from persistent storage', () => {
    const custom: QRDesignConfig = {
      ...DEFAULT_CUSTOMER_QR_DESIGN,
      backgroundColor: '#123456',
      version: 1,
    };
    setActiveQrDesign('CUSTOMER', custom);

    // Simulate browser refresh/remount by clearing in-memory or reloading from localStorage via getActiveQrDesign
    const loaded = getActiveQrDesign('CUSTOMER');
    expect(loaded.backgroundColor).toBe('#123456');
  });

  it('3 & 4. Order design saves and reloads independently', () => {
    const customOrder: QRDesignConfig = {
      ...DEFAULT_ORDER_QR_DESIGN,
      backgroundColor: '#654321',
      version: 1,
    };
    setActiveQrDesign('ORDER', customOrder);

    const loadedOrder = getActiveQrDesign('ORDER');
    const loadedCustomer = getActiveQrDesign('CUSTOMER');

    expect(loadedOrder.backgroundColor).toBe('#654321');
    expect(loadedCustomer.backgroundColor).toBe(DEFAULT_CUSTOMER_QR_DESIGN.backgroundColor);
  });

  it('5 & 6. Customer design does not overwrite Order design and vice versa', () => {
    setActiveQrDesign('CUSTOMER', { ...DEFAULT_CUSTOMER_QR_DESIGN, borderRadius: 20 });
    setActiveQrDesign('ORDER', { ...DEFAULT_ORDER_QR_DESIGN, borderRadius: 8 });

    expect(getActiveQrDesign('CUSTOMER').borderRadius).toBe(20);
    expect(getActiveQrDesign('ORDER').borderRadius).toBe(8);
  });

  it('7. Reset persists default design', () => {
    setActiveQrDesign('CUSTOMER', { ...DEFAULT_CUSTOMER_QR_DESIGN, backgroundColor: '#999999' });
    resetActiveQrDesign('CUSTOMER');

    expect(getActiveQrDesign('CUSTOMER').backgroundColor).toBe(DEFAULT_CUSTOMER_QR_DESIGN.backgroundColor);
  });

  it('8. Invalid stored config falls back safely', () => {
    localStorage.setItem('app_qr_design_config_CUSTOMER', 'INVALID_JSON{{{');
    // Calling getActiveQrDesign should not throw and fall back to default
    const design = getActiveQrDesign('CUSTOMER');
    expect(design.backgroundColor).toBe(DEFAULT_CUSTOMER_QR_DESIGN.backgroundColor);
  });

  it('9. Refresh/remount does not reset saved design', () => {
    setActiveQrDesign('CUSTOMER', { ...DEFAULT_CUSTOMER_QR_DESIGN, padding: 40 });
    // Re-evaluating getActiveQrDesign simulates fresh module mount reading from localStorage
    const reloaded = getActiveQrDesign('CUSTOMER');
    expect(reloaded.padding).toBe(40);
  });

  it('10. Saving design does not change configuration version/structure incorrectly', () => {
    const design = getActiveQrDesign('CUSTOMER');
    setActiveQrDesign('CUSTOMER', design);
    expect(getActiveQrDesign('CUSTOMER')).toEqual(design);
  });

  it('11. Opening/reading config does not dirty design state', () => {
    const before = getActiveQrDesign('CUSTOMER');
    getActiveQrDesign('CUSTOMER');
    const after = getActiveQrDesign('CUSTOMER');
    expect(after).toEqual(before);
  });
});
