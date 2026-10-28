import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Public wallet management access contract', () => {
  const page = fs.readFileSync(path.resolve(process.cwd(), 'src/components/pages/WalletManagementPage.tsx'), 'utf8');
  const portal = fs.readFileSync(path.resolve(process.cwd(), 'src/PublicPortalApp.tsx'), 'utf8');
  const endpoint = fs.readFileSync(path.resolve(process.cwd(), 'supabase/functions/customer-account/index.ts'), 'utf8');
  const migration = fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations/20261028150000_wallet_management_entitlements.sql'), 'utf8');

  it('is reachable from the public portal, not the admin application', () => {
    expect(portal).toContain("pathname === '/public/services/wallet'");
    expect(portal).toContain('<WalletManagementPage');
    expect(page).not.toContain('AdminApp');
    expect(page).not.toContain('admin-bin');
  });

  it('bounds wallet access verification to avoid an indefinite loading state', () => {
    const auth = fs.readFileSync(path.resolve(process.cwd(), 'src/services/customer/customerAuth.ts'), 'utf8');
    expect(auth).toContain("'wallet-management-access'");
    expect(auth).toContain('setTimeout(() => controller.abort(), 10000)');
  });

  it('requires the existing customer credentials and fails closed when offline or unauthorized', () => {
    expect(page).toContain("callCustomerAccount");
    expect(page).toContain("'login'");
    expect(page).toContain("'wallet-management-access'");
    expect(page).toContain("setGate('offline')");
    expect(page).toContain("setGate('denied')");
    expect(page).toContain('Financial data remains hidden');
  });

  it('enforces active session, active account, and explicit entitlement on the server', () => {
    expect(endpoint).toContain('action === "wallet-management-access"');
    expect(endpoint).toContain('sessionIsActive(link, authenticated.user.id, authenticated.claims)');
    expect(endpoint).toContain('link.account_status !== "ACTIVE"');
    expect(endpoint).toContain('link.must_change_password');
    expect(endpoint).toContain('customer_service_entitlements');
    expect(endpoint).toContain('entitlement.enabled !== true');
  });

  it('defaults access off and prevents direct client table access', () => {
    expect(migration).toContain('enabled boolean not null default false');
    expect(migration).toContain('enable row level security');
    expect(migration).toContain('force row level security');
    expect(migration).toContain('revoke all on table public.customer_service_entitlements from anon, authenticated');
    expect(migration).not.toMatch(/create policy/i);
  });
});
