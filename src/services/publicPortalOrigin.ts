const CUSTOMER_PORTAL_ORIGIN = 'https://www.monther.work';
const ADMIN_HOSTNAME = 'admin.monther.work';
const CUSTOMER_HOSTNAMES = new Set(['www.monther.work', 'monther.work']);

type PublicOriginLocation = Pick<Location, 'origin' | 'hostname'>;

/**
 * Returns the canonical origin for customer-facing QR links.
 * Admin links must never leak the administrator origin into customer QR codes.
 * Preview and local development origins are preserved so preview links stay testable.
 */
export function getPublicPortalOrigin(locationLike?: PublicOriginLocation): string {
  const current = locationLike ?? (typeof window !== 'undefined' ? window.location : undefined);
  if (!current) return '';
  const hostname = current.hostname.toLowerCase();
  if (hostname === ADMIN_HOSTNAME || CUSTOMER_HOSTNAMES.has(hostname)) {
    return CUSTOMER_PORTAL_ORIGIN;
  }
  return current.origin;
}
