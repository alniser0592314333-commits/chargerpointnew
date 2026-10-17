import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Isolated customer QR portal security contract', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261017410000_public_customer_portal_read_model.sql'
  );
  const appPath = path.resolve(process.cwd(), 'src/App.tsx');
  const pagePath = path.resolve(process.cwd(), 'src/components/pages/PublicCustomerPortalPage.tsx');
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

  it('routes both established customer QR URL formats to the isolated portal', () => {
    const app = fs.readFileSync(appPath, 'utf8');
    expect(app).toContain("import { PublicCustomerPortalPage } from './components/pages/PublicCustomerPortalPage'");
    expect(app).toContain("pathname.startsWith('/c/')");
    expect(app).toContain("pathname.startsWith('/public/qr/customer/')");
    expect(app).toContain('<PublicCustomerPortalPage token={token} />');
    expect(app).not.toContain('<PublicCustomerQrPage token={token} />');
  });

  it('prevents QR bearer-token referrer leakage and search indexing', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    expect(html).toContain('<meta name="referrer" content="no-referrer" />');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive" />');
  });

  it('uses only the scoped RPC, suppresses financial data offline, and does not expose admin controls', () => {
    const page = fs.readFileSync(pagePath, 'utf8');
    expect(page).toContain("'public_resolve_customer_portal'");
    expect(page).toContain("p_public_token: token");
    expect(page).toContain('setData(null)');
    expect(page).toContain('navigator.onLine');
    expect(page).toContain('payment_submissions');
    expect(page).toContain('bonus_recorded');
    expect(page).not.toContain('service_role');
    expect(page).not.toContain('adminBin');
    expect(page).not.toContain('invokeSupabaseRestGet');
  });
});
