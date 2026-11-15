const CANONICAL_CUSTOMER_ORIGIN = 'https://www.monther.work';
const PRODUCTION_HOST_ALIASES = new Set([
  'www.monther.work',
  'monther.work',
  'admin.monther.work',
  'chargerpointnew.vercel.app',
]);

type PublicOriginLocation = Pick<Location, 'origin' | 'hostname'>;

/**
 * Customer-facing links must always open the public customer portal, never the
 * admin host or Capacitor's internal https://localhost WebView origin.
 *
 * Keep ordinary localhost development (including its port) and Vercel preview
 * deployments isolated so testing does not accidentally send production links.
 */
export function getPublicPortalOrigin(locationLike?: PublicOriginLocation): string {
  const current = locationLike ?? (typeof window !== 'undefined' ? window.location : undefined);
  if (!current) return '';

  const hostname = current.hostname.toLowerCase();
  if (PRODUCTION_HOST_ALIASES.has(hostname) || (hostname === 'localhost' && current.origin === 'https://localhost')) {
    return CANONICAL_CUSTOMER_ORIGIN;
  }

  return current.origin;
}

/** True only for explicitly public/customer-facing SPA routes. */
export function isCustomerPortalPath(pathname: string): boolean {
  return pathname === '/public/about' ||
    pathname === '/download' ||
    pathname === '/public/services' ||
    pathname.startsWith('/public/services/') ||
    pathname.startsWith('/c/') ||
    pathname.startsWith('/o/') ||
    pathname.startsWith('/pay/') ||
    pathname.startsWith('/public/order/') ||
    pathname.startsWith('/public/qr/customer/') ||
    pathname.startsWith('/public/qr/order/');
}
