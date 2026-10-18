import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Isolated customer QR portal security contract', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261018042125_public_customer_portal_read_model.sql'
  );
  const appPath = path.resolve(process.cwd(), 'src/App.tsx');
  const pagePath = path.resolve(process.cwd(), 'src/components/pages/PublicCustomerPortalPage.tsx');
  const supabaseClientPath = path.resolve(process.cwd(), 'src/services/supabase/client.ts');
  const storePath = path.resolve(process.cwd(), 'src/components/pages/dayOrdersStore.ts');
  const publicOrderPath = path.resolve(process.cwd(), 'src/components/pages/PublicOrderPage.tsx');
  const publicPaymentPath = path.resolve(process.cwd(), 'src/components/pages/PublicPaymentPage.tsx');
  const htmlPath = path.resolve(process.cwd(), 'index.html');

  it('resolves only active CUSTOMER capabilities and never grants direct table access', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toContain("qt.token_type = 'CUSTOMER'");
    expect(sql).toContain('qt.is_active IS TRUE');
    expect(sql).toContain('qt.expires_at IS NULL OR qt.expires_at > statement_timestamp()');
    expect(sql).toContain("c.status <> 'DELETED'");
    expect(sql).toContain('length(p_public_token) < 24');
    expect(sql).toContain('length(p_public_token) > 64');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public, pg_temp');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.public_resolve_customer_portal(text) FROM PUBLIC, anon, authenticated, service_role');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.public_resolve_customer_portal(text) TO anon, authenticated, service_role');
    expect(sql).not.toMatch(/GRANT\s+SELECT\s+ON\s+TABLE\s+public\.(customers|orders|financial_ledger)/i);
  });

  it('returns minimized customer-owned financial and operational data only', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toContain("WHERE fl.customer_id = v_customer_id");
    expect(sql).toContain('WHERE o.customer_id = v_customer_id');
    expect(sql).toContain('WHERE customer_id = v_customer_id');
    expect(sql).toContain("'balance_minor'");
    expect(sql).toContain("'orders'");
    expect(sql).toContain("'payment_submissions'");
    expect(sql).toContain("'goals'");
    expect(sql).toContain("'bonus_recorded'");
    expect(sql).not.toContain("'phone'");
    expect(sql).not.toContain("'notes'");
    expect(sql).not.toContain("'receipt_url'");
    expect(sql).not.toContain("'customer_id'");
    expect(sql).not.toContain("'admin_id'");
  });

  it('routes customer QR URLs to account auth and preserves distinct order QR URLs', () => {
    const app = fs.readFileSync(appPath, 'utf8');
    const store = fs.readFileSync(storePath, 'utf8');
    expect(app).toContain("import { CustomerAccountPage } from './components/pages/CustomerAccountPage'");
    expect(app).toContain("pathname.startsWith('/c/')");
    expect(app).toContain("pathname.startsWith('/public/qr/customer/')");
    expect(app).toContain('<CustomerAccountPage token={token} />');
    expect(app).toContain("pathname.startsWith('/o/')");
    expect(app).toContain("pathname.startsWith('/public/qr/order/')");
    expect(app).toContain('<PublicOrderPage token={token} />');
    expect(app).not.toContain("pathname.startsWith('/o/')\n      const token = pathname.replace('/o/', '');\n      return <CustomerAccountPage");
    expect(app).not.toContain('<PublicCustomerQrPage token={token} />');
    const customerQrStart = store.indexOf('export const getCustomerQrCardData = async (');
    const customerQrBuilder = store.slice(customerQrStart, customerQrStart + 2500);
    const orderQrStart = store.indexOf('export const getOrderQrCardData = async (');
    const orderQrBuilder = store.slice(orderQrStart, store.indexOf('export const getBusinessDay = async', orderQrStart));
    expect(customerQrBuilder).toContain('`\u0024{origin}/c/\u0024{publicToken}`');
    expect(orderQrBuilder).toContain('`\u0024{origin}/o/\u0024{publicToken}`');
  });

  it('skips admin session inspection and business-store bootstrap on public capability routes', () => {
    const app = fs.readFileSync(appPath, 'utf8');
    const publicGuard = app.indexOf('if (isPublicPortalPath(parseRoute(window.location.pathname).pathname))');
    const authLookup = app.indexOf('authService.captureAuthCallback()');
    const storeBootstrap = app.indexOf('await ensureStoreHydrated();');
    expect(publicGuard).toBeGreaterThan(-1);
    expect(authLookup).toBeGreaterThan(publicGuard);
    expect(storeBootstrap).toBeGreaterThan(publicGuard);
    expect(app.slice(publicGuard, authLookup)).toContain('setIsAuthChecking(false)');
    expect(app.slice(publicGuard, authLookup)).toContain('return () => { isMounted = false; }');
  });

  it('keeps all public customer/order QR lookups out of the admin local business store', () => {
    const store = fs.readFileSync(storePath, 'utf8');
    const customerStart = store.indexOf('export const getPublicCustomerByToken = async (');
    const customerEnd = store.indexOf('export interface PublicOrderQrData', customerStart);
    const orderStart = store.indexOf('export const getPublicOrderByToken = async (');
    const orderEnd = store.indexOf('export interface UIRecentFinancialActivityItem', orderStart);
    expect(customerStart).toBeGreaterThan(-1);
    expect(orderStart).toBeGreaterThan(-1);
    const customerResolver = store.slice(customerStart, customerEnd);
    const orderResolver = store.slice(orderStart, orderEnd);
    for (const resolver of [customerResolver, orderResolver]) {
      expect(resolver).toContain('if (isBrowserOffline()) return null');
      expect(resolver).not.toContain('ensureStoreHydrated');
      expect(resolver).not.toContain('initDbIfNeeded');
      expect(resolver).not.toContain('localDb');
    }
  });

  it('clears public order and payment data on offline transitions', () => {
    const order = fs.readFileSync(publicOrderPath, 'utf8');
    expect(order).toContain("window.addEventListener('offline', onOffline)");
    expect(order).toContain("window.addEventListener('online', onOnline)");
    expect(order).toContain('}, [token, online]);');
    expect(order).toContain('setData(null)');
    expect(order).toContain('setSubmission(null)');
    expect(order).toContain('requestId !== requestGeneration.current');
    const payment = fs.readFileSync(publicPaymentPath, 'utf8');
    expect(payment).toContain("window.addEventListener('offline', onOffline)");
    expect(payment).toContain("window.addEventListener('online', onOnline)");
    expect(payment).toContain('}, [token, online]);');
    expect(payment).toContain('setOrder(null)');
    expect(payment).toContain('setCustomer(null)');
    expect(payment).toContain('setSubmission(null)');
    expect(payment).toContain("throw new Error('OFFLINE')");
    expect(payment).toContain('submissionGeneration !== requestGeneration.current');
    expect(payment).toContain('Account and receipt details are hidden while offline.');
  });

  it('prevents QR bearer-token referrer leakage and search indexing', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    expect(html).toContain('<meta name="referrer" content="no-referrer" />');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive" />');
  });

  it('uses only the scoped RPC, suppresses financial data offline, and does not expose admin controls', () => {
    const page = fs.readFileSync(pagePath, 'utf8');
    expect(page).toContain("'portal-data'");
    expect(page).toContain("callCustomerAccount<{ data: PortalData }>");
    expect(page).not.toContain("'public_resolve_customer_portal'");
    const accountAuth = fs.readFileSync(path.resolve(process.cwd(), 'supabase/functions/customer-account/index.ts'), 'utf8');
    expect(accountAuth).toContain('.eq("token_type", "CUSTOMER")');
    expect(accountAuth).toContain('resolved.customer.id !== link.customer_id');
    expect(accountAuth).toContain('activeSessionExpiresAt');
    expect(accountAuth).toContain('admin-set-status');
    expect(accountAuth).toContain('customer_account_consume_rate_limit');
    expect(accountAuth).toContain('REQUEST_TOO_LARGE');
    expect(accountAuth).toContain('action === "accept-terms"');
    const accountMigration = fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations/20261018060000_customer_account_auth.sql'), 'utf8');
    expect(accountMigration).toContain('REVOKE ALL ON FUNCTION public.public_resolve_customer_portal(text) FROM PUBLIC, anon, authenticated');
    expect(accountMigration).toContain('GRANT EXECUTE ON FUNCTION public.public_resolve_customer_portal(text) TO service_role');
    expect(accountMigration).toContain('customer_account_one_pending_reset_idx');
    expect(accountMigration).toContain('customer_account_consume_rate_limit');
    expect(accountMigration).toContain("TERMS_ACCEPTED");
    expect(accountMigration).toContain('customer_account_sessions');
    const client = fs.readFileSync(supabaseClientPath, 'utf8');
    expect(client).toContain('forceAnonymous: boolean = false');
    expect(client).toContain('forceAnonymous ? null : resolveAuthBearerToken(customAuthToken)');
    expect(client).toContain('!forceAnonymous');
    for (const publicRpc of [
      "'public_resolve_customer_qr'",
      "'public_resolve_order_qr'",
    ]) {
      const resolverStart = client.indexOf('export async function rpcResolveCustomerQr');
      const index = client.indexOf(publicRpc, resolverStart);
      expect(index).toBeGreaterThan(resolverStart);
      const callEnd = client.indexOf(');', index);
      const call = client.slice(index, callEnd + 2);
      expect(call.replace(/\s+/g, ' ')).toContain('undefined, true, false, true');
    }


    const paymentStatusStart = client.indexOf('export async function rpcResolveQrPaymentSubmission');
    const paymentStatusEnd = client.indexOf('export async function rpcGetOrCreateCustomerQr', paymentStatusStart);
    const paymentStatusCall = client.slice(paymentStatusStart, paymentStatusEnd);
    expect(paymentStatusCall).toContain('customAuthToken');
    expect(paymentStatusCall).toContain('forceAnonymous = !customAuthToken');
    const paymentPage = fs.readFileSync(publicPaymentPath, 'utf8');
    expect(paymentPage).toContain("'verify-session'");
    expect(paymentPage).toContain('customerSessionData.session.access_token');
    expect(paymentPage).toContain('Authorization: `Bearer ${bearer}`');
    const paymentEdge = fs.readFileSync(path.resolve(process.cwd(), 'supabase/functions/submit-qr-payment/index.ts'), 'utf8');
    expect(paymentEdge).toContain('Customer QR payment must use the same authenticated customer session');
    expect(paymentEdge).toContain('accountLink.terms_version !== CUSTOMER_ACCOUNT_TERMS_VERSION');
    expect(paymentEdge).toContain('targetKind = "ORDER"');
    expect(page).toContain('setData(null)');
    expect(page).toContain('navigator.onLine');
    expect(page).toContain('requestGeneration.current += 1');
    expect(page).toContain('requestId !== requestGeneration.current');
    expect(page).toContain('never restore financial data after connectivity drops');
    expect(page).toContain('payment_submissions');
    expect(page).toContain('bonus_recorded');
    expect(page).not.toContain('service_role');
    expect(page).not.toContain('adminBin');
    expect(page).not.toContain('invokeSupabaseRestGet');
  });
});
