/**
 * Resolves the semantic parent of an application route.
 *
 * Back navigation is based on the app's page hierarchy, not the browser's
 * raw visit history, so opening/editing several records never makes Back walk
 * through those records one by one.
 */
export function resolveLogicalBackPath(pathAndHash: string): string | null {
  let pathname = pathAndHash;
  try {
    pathname = new URL(pathAndHash, 'http://localhost').pathname;
  } catch {
    pathname = pathAndHash.split(/[?#]/, 1)[0] || '/app';
  }

  if (pathname === '/app' || pathname === '/login' || pathname === '/') return null;

  const orderRoute = pathname.match(/^\/app\/days\/([^/]+)\/orders\/[^/]+\/(?:edit|qr)$/);
  if (orderRoute) return `/app/days/${orderRoute[1]}`;

  const addOrderRoute = pathname.match(/^\/app\/days\/([^/]+)\/add-order$/);
  if (addOrderRoute) return `/app/days/${addOrderRoute[1]}`;

  if (/^\/app\/days\/[^/]+$/.test(pathname)) return '/app/days';
  const purchaseDayRoute = pathname.match(/^\/app\/purchases\/month\/([^/]+)\/week\/([^/]+)\/day\/[^/]+$/);
  if (purchaseDayRoute) return `/app/purchases/month/${purchaseDayRoute[1]}/week/${purchaseDayRoute[2]}`;
  const purchaseWeekRoute = pathname.match(/^\/app\/purchases\/month\/([^/]+)\/week\/[^/]+$/);
  if (purchaseWeekRoute) return `/app/purchases/month/${purchaseWeekRoute[1]}`;
  if (/^\/app\/purchases\/month\/[^/]+$/.test(pathname)) return '/app/purchases';
  if (pathname.startsWith('/app/purchases/supplier/')) return '/app/purchases';

  if (pathname === '/app/days') return '/app';
  if (pathname.startsWith('/app/messages/')) return '/app/messages';
  if (pathname === '/app/messages') return '/app';

  const customerQrRoute = pathname.match(/^\/app\/qr\/customer\/([^/]+)$/);
  if (customerQrRoute) return `/app/customers/${customerQrRoute[1]}`;
  if (/^\/app\/customers\/[^/]+$/.test(pathname)) return '/app/customers';
  if (pathname === '/app/customers') return '/app';

  if (/^\/app\/financials\/customers\/[^/]+$/.test(pathname)) return '/app/financials/customers';
  if (pathname === '/app/financials/customers') return '/app/financials';
  if (pathname === '/app/financials') return '/app';

  if (/^\/app\/settings\//.test(pathname)) return '/app/settings';
  if (pathname === '/app/qr-design') return '/app/settings';
  if (pathname.startsWith('/app/')) return '/app';

  return null;
}
