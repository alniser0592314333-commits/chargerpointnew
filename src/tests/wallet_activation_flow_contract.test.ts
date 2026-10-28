import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Wallet activation workflow security contract', () => {
  const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
  const wallet = read('supabase/functions/wallet-service/index.ts');
  const account = read('supabase/functions/customer-account/index.ts');
  const requests = read('supabase/migrations/20261028170000_wallet_activation_requests.sql');
  const review = read('supabase/migrations/20261028171000_wallet_activation_review_rpc.sql');
  const adminPanel = read('src/components/pages/CustomerAccountNotificationsPanel.tsx');
  const servicesPage = read('src/components/pages/PublicServicesPage.tsx');
  const publicRouter = read('src/PublicPortalApp.tsx');
  const push = read('supabase/functions/native-push/index.ts');

  it('lets a valid customer request activation before entitlement, but gates financial actions', () => {
    expect(wallet).toContain('"wallet-activation-status", "wallet-request-activation"');
    expect(wallet).toContain('action === "wallet-activation-status"');
    expect(wallet).toContain('action === "wallet-request-activation"');
    expect(wallet).toContain('if (!entitlement || entitlement.enabled !== true)');
    expect(wallet).toContain('registered.session_id !== sessionId');
    expect(wallet).toContain('link.must_change_password');
  });

  it('prevents duplicate pending requests and keeps wallet activation independent from customer deletion', () => {
    expect(requests).toContain('where status = \'PENDING\'');
    expect(requests).toContain('on public.wallet_activation_requests (customer_id) where status = \'PENDING\'');
    expect(requests).not.toMatch(/references public\.customers\s*\(id\)/i);
    expect(requests).toContain('force row level security');
    expect(requests).toContain('revoke all on table public.wallet_activation_requests from anon, authenticated');
  });

  it('requires administrator authorization and atomically records the decision and entitlement', () => {
    expect(account).toContain('action === "admin-review-wallet-activation"');
    expect(account).toContain('requireAdmin()');
    expect(account).toContain('wallet_review_activation_request');
    expect(review).toContain('for update');
    expect(review).toContain('v_request.status <> \'PENDING\'');
    expect(review).toContain('updated_by');
    expect(review).toContain('decided_by = p_admin_id');
    expect(review).toContain('WALLET_ACTIVATION_APPROVED');
    expect(review).toContain('WALLET_ACTIVATION_REJECTED');
    expect(review).toContain('grant execute on function public.wallet_review_activation_request');
  });

  it('surfaces requests in the existing admin inbox and customer status UI', () => {
    expect(account).toContain('walletActivationRequests');
    expect(adminPanel).toContain('reviewWalletActivation');
    expect(adminPanel).toContain('Wallet activation requests');
    expect(servicesPage).toContain('verify-session');
    expect(publicRouter).toContain("pathname === '/public/services'");
    expect(publicRouter).toContain("pathname === '/public/services/wallet'");
  });

  it('routes push events through the existing native notification pipeline', () => {
    expect(wallet).toContain('WALLET_ACTIVATION_REQUESTED');
    expect(push).toContain('eventType === "WALLET_ACTIVATION_REQUESTED"');
    expect(push).toContain('WALLET_ACTIVATION_APPROVED');
    expect(push).toContain('WALLET_ACTIVATION_REJECTED');
  });
});
