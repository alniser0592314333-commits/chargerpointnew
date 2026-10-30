type PublicOriginLocation = Pick<Location, 'origin' | 'hostname'>;

/**
 * Customer QR links use the current origin. This lets the public portal and
 * admin app coexist on one domain, and keeps preview/local links on their own
 * origin for safe testing.
 */
export function getPublicPortalOrigin(locationLike?: PublicOriginLocation): string {
  const current = locationLike ?? (typeof window !== 'undefined' ? window.location : undefined);
  return current?.origin ?? '';
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
