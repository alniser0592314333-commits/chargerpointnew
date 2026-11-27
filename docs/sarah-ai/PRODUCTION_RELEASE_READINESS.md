# Sarah AI — Production Release Readiness

Status: **prepared, not deployed**. This document records the read-only production preflight and the verified release order. No production SQL, Edge Function, secret, customer record, or APK was changed while preparing it.

## 1. Current verification

- Production project is active. Latest recorded migration is `read_only_account_session_guard` (production ledger version `20261126074440`).
- The provider configuration table, Sarah quota table/RPCs, scoped lookup RPC, limited customer-profile RPC, and Super Admin BIN-session-proof table/RPC are not present in production.
- Supabase Vault is available, but no Sarah-named Vault secret exists yet.
- Neither `sarah-ai-settings` nor `sarah-ai-chat` is deployed.
- Current session inventory: 234 account-session rows, 175 active registered administrator-session rows, 2 active administrators, and 4 currently valid administrator Auth sessions without an account-session registry row. The strict registry migration explicitly backfills those missing rows as **browser sessions for 7 days** (it does not infer native/PWA from user-agent); repeat this count immediately before deployment.
- `ai:use` and `ai:manage` currently have zero rows in `admin_custom_permissions`. Super Admin is allowed by the server-side bypass; other administrators must be explicitly granted the required permission after deployment.
- Existing native-push event routing, order/item lifecycle, goal-completion, manual-top-up triggers, and the app-release policy table/guard/RLS policies are already present. Do not replay those migrations just because their current local filenames have different timestamps.

## 2. Migration history warning

The production migration ledger does not consistently use the timestamp prefix found in the current repository filenames. Some already-applied migrations are recorded under different version IDs and/or names. A filename-prefix-only comparison therefore overstates the pending set.

**Do not run a bulk `supabase db push` or migration reset against production until the ledger has been reconciled.** Apply only migrations confirmed absent by both the recorded migration name and the live schema/function checks, one at a time, and verify after each application.

A historical migration, `20261012180000_fix_uuid_min_in_delivery_replay.sql`, is genuinely missing: the current production canonical dispatcher still contains `SELECT COUNT(*), MIN(id), MIN(amount_minor)`. PostgreSQL has no `MIN(uuid)` aggregate. The migration safely patches the unlocked canonical dispatcher and is covered by CI fixtures for both the original dispatcher and the later wrapper/implementation split. Apply this targeted fix first; do not skip it as an old timestamp.

Other older filename mismatches were checked against production: the empty-replacement guard, QR token hash/relational constraints, customer-portal projections/reminders, and three-pending Jawwal Pay guard are already represented in the live schema or later applied migrations. The unused legacy QR helper migration `20261018152000_public_order_qr_credit_coverage.sql` is not referenced by the current `PublicOrderPage` flow, which uses the current order-QR resolver RPCs; do not apply it as part of this release.

## 3. Confirmed production application order

Apply each SQL file below individually, in this order, and stop immediately if any application or postcondition fails:

1. `supabase/migrations/20261012180000_fix_uuid_min_in_delivery_replay.sql` — repair the live UUID aggregate in delivery replay.
2. `supabase/migrations/20261126080000_sarah_ai_provider_configuration.sql` — Vault-backed provider settings and server-side `ai:manage` checks.
3. `supabase/migrations/20261126170000_sarah_ai_atomic_actor_quota.sql` — per-actor atomic hourly/daily quotas and `ai:use` checks.
4. `supabase/migrations/20261126200000_strict_account_session_registry.sql` — strict administrator-session registry, session lifecycle RPCs, and scoped authorization. Recheck the four-session backfill count immediately before applying.
5. `supabase/migrations/20261126210000_native_push_admin_session_expiry_gate.sql` — require active, non-disabled, unexpired administrator sessions for admin push delivery.
6. `supabase/migrations/20261126213000_sarah_ai_scoped_customer_lookup.sql` — limited, permission-checked customer lookup.
7. `supabase/migrations/20261126220000_super_admin_bin_session_proof.sql` — bind fresh Super Admin session registration/reactivation to the BIN proof from that exact Auth session.
8. `supabase/migrations/20261127090000_sarah_ai_customer_profile_read.sql` — limited customer-profile read capability.

After step 7, run the PostgREST schema reload (`NOTIFY pgrst, 'reload schema';`; the repository's `20261126223400_reload_postgrest_schema_after_bin_functions.sql` contains only this notification). Then verify the final RPC contracts before deploying the Edge Functions.

The native-push pg_net/event-routing/manual-top-up migrations and the app-release-policy migration are already represented in production; do not reapply them in this release.

## 4. Edge Function deployment

Deploy only after the SQL postconditions above pass:

- `sarah-ai-settings`
- `sarah-ai-chat`

Include the shared files imported by the functions: `_shared/ai/providerRegistry.ts`, `_shared/ai/providerTypes.ts`, `_shared/ai/geminiProviderAdapter.ts`, and `_shared/http/requestBodyLimit.ts`, plus their transitive imports.

`supabase/config.toml` intentionally sets `verify_jwt = false` for these endpoints because each function performs explicit Bearer-token validation, Auth user resolution, active-admin/profile checks, and permission checks in its own code. Do not change this setting without reviewing that explicit validation path.

Vault is ready but contains no Sarah provider key. The key must be entered by the administrator through the protected AI settings UI after deployment. Never put it in Git, GitHub Actions secrets, source code, or this chat.

## 5. Required post-deployment checks

- Super Admin can open AI settings, save a provider key, test the connection, and clear/rotate the key without the key appearing in browser storage or API responses.
- A non-Super-Admin without `ai:manage` cannot read/change provider settings; one with `ai:use` can use Sarah but cannot manage the provider.
- Sarah can perform only the approved customer lookup and limited profile read. Confirm she cannot read balances, payments, ledger entries, receipts, phone numbers, notes, orders, or other customers' private records, and cannot execute writes or arbitrary SQL.
- Confirm hourly/daily quota enforcement and concurrent-call limits.
- Test both administrator accounts through fresh password login, Super Admin BIN verification, saved-account login, biometric login, refresh/reactivation, logout, revoke-other-session, and expiry. Test customer sign-in and customer Jawwal Pay flows separately.
- Confirm expired/revoked admin sessions do not receive admin push notifications, while valid customer push and account-status recovery notifications continue to work.
- Confirm the delivery replay path succeeds for a UUID-backed ledger case after the first migration.

## 6. CI and merge status

- GitHub Actions run `45952841261` passed all six jobs, including the duplicate migration-prefix guard, isolated SQL fixtures, Sarah provider/quota/lookup/profile contracts, account-session tests, TypeScript checks, Edge Function checks, lint, and production bundle build.
- The optional full-suite diagnostic reports 45 failing test files / 172 failing tests on both this PR and the `main` baseline (114 files and 1,122 tests pass in each run). The counts match exactly, so these are pre-existing baseline failures, not regressions from this migration rename.
- The latest Vercel production deployment is READY at commit `522e109`; current `main` is one commit ahead at `b8f3157`. The current PR changes only migration naming, tests, and documentation, but merging it can cause Vercel to deploy the current `main` tree. The PR preview was previously rate-limited; its latest status is checked separately.
- The repository's `main` branch is not protected and has no required status checks configured. GitHub currently reports PR #331 as mergeable and the branch is 0 commits behind main. Do not treat this as a substitute for the production release gates below.


## 6. Client compatibility and release-policy checks

- The latest published admin APK in GitHub Releases is `v1.4.2` (18 Nov 2026). That APK uses the legacy `register_my_account_session` call. The strict registry migration preserves this endpoint but deliberately classifies new legacy registrations as `browser`, which receives a 7-day idle window. The current `main` source uses `reactivate_my_account_session` / `register_my_account_session_v2` and identifies native/installed-PWA clients, which receive a 30-day idle window.
- The existing APK remains on the compatibility path, but the four backfilled sessions and any new legacy registrations are browser-class for 7 days. Build and publish a new signed admin APK from the current reviewed `main` source before/alongside the strict-session rollout if native 30-day behavior is required. The current source also reactivates the session immediately after BIN verification, avoiding the older APK's delayed registration after app hydration.
- The latest published customer APK asset is `v1.3.0` (5 Nov 2026). The live app-release policy rows currently say admin `1.0.1` and customer `1.2.7`; both have download URLs, and both grace windows are expired. These values are behind the latest GitHub release assets. This is separate from Sarah; confirm the intended rollout versions before changing the policy because it can trigger update prompts.

## 7. Safety boundary

This PR is code/documentation only. Do not merge, apply SQL, deploy Edge Functions, or enter the provider key until the release operator explicitly approves the production window. There are no down migrations for the session-security changes; take an available backup first, apply forward-only changes one at a time, and prepare a forward-fix path rather than attempting an improvised rollback.
