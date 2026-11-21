import { describe, expect, it } from 'vitest';
import {
  getPortalHostRedirect,
  getPublicPortalOrigin,
  isCustomerPortalPath,
} from './publicPortalOrigin';

describe('getPublicPortalOrigin', () => {
  it('routes customer QR links from the admin origin to the customer portal', () => {
    expect(getPublicPortalOrigin({ hostname: 'admin.monther.work', origin: 'https://admin.monther.work' })).toBe('https://www.monther.work');
  });

  it('uses the canonical customer host for production aliases and the Vercel production domain', () => {
    for (const hostname of ['www.monther.work', 'monther.work', 'chargerpointnew.vercel.app']) {
      expect(getPublicPortalOrigin({ hostname, origin: `https://${hostname}` })).toBe('https://www.monther.work');
    }
  });

  it('routes the Android Capacitor localhost WebView to the public customer portal', () => {
    expect(getPublicPortalOrigin({ hostname: 'localhost', origin: 'https://localhost' })).toBe('https://www.monther.work');
  });

  it('preserves preview and ordinary local development origins', () => {
    expect(getPublicPortalOrigin({ hostname: 'chargerpointnew-preview.vercel.app', origin: 'https://chargerpointnew-preview.vercel.app' })).toBe('https://chargerpointnew-preview.vercel.app');
    expect(getPublicPortalOrigin({ hostname: 'localhost', origin: 'http://localhost:3000' })).toBe('http://localhost:3000');
  });

  it('returns an empty origin in a non-browser environment', () => {
    expect(getPublicPortalOrigin()).toBe('');
  });
});

describe('isCustomerPortalPath', () => {
  it('recognizes public customer routes', () => {
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

  it('does not classify admin entry routes as customer routes', () => {
    for (const path of ['/', '/app', '/app/settings', '/login', '/reset-password', '/customers']) {
      expect(isCustomerPortalPath(path), path).toBe(false);
    }
  });
});

describe('getPortalHostRedirect', () => {
  const www = 'www.monther.work';
  const admin = 'admin.monther.work';

  it.each(['/app', '/app/settings', '/login', '/reset-password', '/customers'])(
    'moves legacy admin route %s from www to the admin origin',
    (pathname) => {
      expect(getPortalHostRedirect({
        hostname: www,
        pathname,
        search: '?from=shortcut',
        hash: '#section',
      })).toBe(`https://${admin}${pathname}?from=shortcut#section`);
    },
  );

  it('keeps every recognized public customer route on www', () => {
    for (const pathname of ['/public/about', '/download', '/public/services', '/c/token', '/o/token', '/pay/token']) {
      expect(getPortalHostRedirect({ hostname: www, pathname, search: '', hash: '' })).toBeNull();
    }
  });

  it('moves accidental public routes from the admin origin to www', () => {
    expect(getPortalHostRedirect({
      hostname: admin,
      pathname: '/o/order-token',
      search: '?source=qr',
      hash: '',
    })).toBe('https://www.monther.work/o/order-token?source=qr');
  });

  it('does not redirect the root or API endpoints', () => {
    for (const pathname of ['/', '/api', '/api/download/admin']) {
      expect(getPortalHostRedirect({ hostname: www, pathname, search: '', hash: '' })).toBeNull();
    }
  });

  it('does not rewrite preview or unrelated hosts', () => {
    expect(getPortalHostRedirect({
      hostname: 'chargerpointnew-preview.vercel.app',
      pathname: '/app',
      search: '',
      hash: '',
    })).toBeNull();
  });
});
