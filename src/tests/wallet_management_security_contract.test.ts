import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Public wallet management access contract', () => {
  const page = fs.readFileSync(path.resolve(process.cwd(), 'src/components/pages/WalletManagementPage.tsx'), 'utf8');
  const portal = fs.readFileSync(path.resolve(process.cwd(), 'src/PublicPortalApp.tsx'), 'utf8');
  const endpoint = fs.readFileSync(path.resolve(process.cwd(), 'supabase/functions/customer-account/index.ts'), 'utf8');
  const walletEndpoint = fs.readFileSync(path.resolve(process.cwd(), 'supabase/functions/wallet-service/index.ts'), 'utf8');
  const walletClient = fs.readFileSync(path.resolve(process.cwd(), 'src/services/customer/walletService.ts'), 'utf8');
  const migration = fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations/20261028150000_wallet_management_entitlements.sql'), 'utf8');
  const walletPanel = fs.readFileSync(path.resolve(process.cwd(), 'src/components/pages/WalletSnapshotPanel.tsx'), 'utf8');
  const walletSchema = fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations/20261028160000_wallet_accounts_and_transactions.sql'), 'utf8');
  const snapshotRpc = fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations/20261028161000_wallet_snapshot_rpc.sql'), 'utf8');

  it('is reachable from the public portal, not the admin application', () => {
    expect(portal).toContain("pathname === '/public/services/wallet'");
    expect(portal).toContain('<WalletManagementPage');
    expect(page).not.toContain('AdminApp');
    expect(page).not.toContain('admin-bin');
  });

  it('bounds wallet access verification to avoid an indefinite loading state', () => {
    const auth = fs.readFileSync(path.resolve(process.cwd(), 'src/services/customer/customerAuth.ts'), 'utf8');
    expect(walletClient).toContain("/functions/v1/wallet-service");
    expect(auth).toContain('setTimeout(() => controller.abort(), 10000)');
  });

  it('requires the existing customer credentials and fails closed when offline or unauthorized', () => {
    expect(page).toContain("callWalletService");
    expect(page).toContain("'login'");
    expect(page).toContain("'wallet-management-access'");
    expect(page).toContain("callWalletService");
    expect(page).toContain("setGate('offline')");
    expect(page).toContain("setGate('denied')");
    expect(page).toContain('Financial data remains hidden');
  });

  it('enforces active session, active account, and explicit entitlement on the server', () => {
    expect(walletEndpoint).toContain('action === "wallet-management-access"');
    expect(endpoint).not.toContain('wallet-management-access');
    expect(walletEndpoint).toContain('sessionId');
    expect(walletEndpoint).toContain('registered.session_id !== sessionId');
    expect(walletEndpoint).toContain('link.account_status !== "ACTIVE"');
    expect(walletEndpoint).toContain('link.must_change_password');
    expect(walletEndpoint).toContain('wallet_service_entitlements');
    expect(endpoint).not.toContain('wallet-management-access');
    expect(endpoint).not.toContain('wallet-record-transaction');
    expect(walletEndpoint).toContain('entitlement.enabled !== true');
  });

  it('defaults access off and prevents direct client table access', () => {
    expect(migration).toContain('enabled boolean not null default false');
    expect(migration).toContain('enable row level security');
    expect(migration).toContain('force row level security');
    expect(migration).toContain('revoke all on table public.wallet_service_entitlements from anon, authenticated');
    expect(migration).not.toMatch(/create policy/i);
  });

  it('renders wallet balances and activity only from the authenticated server snapshot', () => {
    expect(page).toContain('<WalletSnapshotPanel />');
    expect(walletPanel).toContain("callWalletService<{ snapshot?: Snapshot }>('wallet-snapshot'");
    expect(walletPanel).toContain('balance_minor');
    expect(walletPanel).toContain('snapshot.transactions.map');
    expect(walletPanel).toContain('setSnapshot(null)');
    expect(walletPanel).toContain("'wallet-create-account'");
    expect(walletPanel).toContain("'wallet-record-transaction'");
    expect(walletPanel).toContain('transactionKey || crypto.randomUUID()');
    expect(walletPanel).toContain('transactionConflict');
    expect(walletPanel).toContain('IDEMPOTENCY_KEY_REUSED');
    expect(walletPanel).toContain('INSUFFICIENT_WALLET_BALANCE');
  });

  it('keeps wallet records customer-scoped and denies direct browser table access', () => {
    expect(walletEndpoint).toContain('p_customer_id: link.customer_id');
    expect(walletEndpoint).toContain('p_actor_auth_user_id: authData.user.id');
    expect(walletSchema).toContain('foreign key (source_wallet_id, customer_id)');
    expect(walletSchema).toContain('foreign key (destination_wallet_id, customer_id)');
    expect(walletSchema).toContain('force row level security');
    expect(walletSchema).toContain('revoke all on public.wallet_transactions from anon, authenticated');
    expect(snapshotRpc).toContain("where t.customer_id = p_customer_id");
  });

  it('bounds snapshot reads and rejects reuse of an idempotency key with changed transaction data', () => {
    const auth = fs.readFileSync(path.resolve(process.cwd(), 'src/services/customer/customerAuth.ts'), 'utf8');
    expect(walletClient).toContain("/functions/v1/wallet-service");
    expect(auth).toContain('setTimeout(() => controller.abort(), 10000)');
    expect(walletSchema).toContain('p_currency is null');
    expect(walletSchema).toContain('IDEMPOTENCY_KEY_REUSED');
    expect(walletEndpoint).toContain('code.includes("IDEMPOTENCY_KEY_REUSED")');
  });

  it('uses currency-specific minor units for wallet entry and balance display', () => {
    expect(walletPanel).toContain("currency === 'JOD' ? 1000 : 100");
    expect(walletPanel).toContain("currency === 'JOD' ? 3 : 2");
    expect(walletPanel).toContain('enteredAmount * currencyScale(selectedCurrency)');
    expect(walletPanel).toContain("'0.001' : '0.01'");
  });

  it('keeps the wallet transaction migration syntactically complete and single-pass', () => {
    expect((walletSchema.match(/^begin;$/gm) || [])).toHaveLength(1);
    expect((walletSchema.match(/^commit;$/gm) || [])).toHaveLength(1);
    expect((walletSchema.match(/create or replace function public\.wallet_record_transaction\(/g) || [])).toHaveLength(1);
    expect(walletSchema).toContain("p_currency not in ('ILS', 'USD', 'JOD')");
    expect(walletSchema).toContain("currency in ('ILS', 'USD', 'JOD')");
    expect(walletSchema).toContain("p_transaction_type is null or p_transaction_type not in ('INCOME', 'EXPENSE', 'TRANSFER')");
    expect(walletSchema).not.toMatch(/p_currency !~ '\^\[A-Z\]\{3\}\s*\n/);
  });

});
