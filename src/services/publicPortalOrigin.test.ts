import { describe, expect, it } from 'vitest';
import { getPublicPortalOrigin } from './publicPortalOrigin';

describe('getPublicPortalOrigin', () => {
  it('routes customer QR links from the admin origin to the customer portal', () => {
    expect(getPublicPortalOrigin({ hostname: 'admin.monther.work', origin: 'https://admin.monther.work' })).toBe('https://www.monther.work');
  });

  it('uses the canonical customer host for both production customer aliases', () => {
    expect(getPublicPortalOrigin({ hostname: 'www.monther.work', origin: 'https://www.monther.work' })).toBe('https://www.monther.work');
    expect(getPublicPortalOrigin({ hostname: 'monther.work', origin: 'https://monther.work' })).toBe('https://www.monther.work');
  });

  it('preserves preview and local development origins', () => {
    expect(getPublicPortalOrigin({ hostname: 'chargerpointnew-preview.vercel.app', origin: 'https://chargerpointnew-preview.vercel.app' })).toBe('https://chargerpointnew-preview.vercel.app');
    expect(getPublicPortalOrigin({ hostname: 'localhost', origin: 'http://localhost:3000' })).toBe('http://localhost:3000');
  });

  it('returns an empty origin in a non-browser environment', () => {
    expect(getPublicPortalOrigin()).toBe('');
  });
});

describe('isCustomerPortalPath', () => {
  it('recognizes public customer routes', async () => {
    const { isCustomerPortalPath } = await import('./publicPortalOrigin');
    for (const path of [
      '/public/about',
      '/public/services',
      '/public/services/help',
      '/download',
      '/c/customer-token',
      '/o/order-token',
      '/pay/payment-token',
      '/public/order/order-token',
      '/public/qr/customer/customer-token',
      '/public/qr/order/order-token',
    ]) {
      expect(isCustomerPortalPath(path), path).toBe(true);
    }
  });

  it('does not classify admin entry routes as customer routes', async () => {
    const { isCustomerPortalPath } = await import('./publicPortalOrigin');
    for (const path of ['/', '/app', '/app/settings', '/login', '/reset-password', '/customers']) {
      expect(isCustomerPortalPath(path), path).toBe(false);
    }
  });
});
