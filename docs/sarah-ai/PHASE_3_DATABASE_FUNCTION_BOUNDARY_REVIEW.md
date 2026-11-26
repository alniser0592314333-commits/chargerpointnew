# Sarah AI — Database function boundary review

Date: 2026-11-26
Status: read-only production catalog/body inspection; no data rows queried, no changes to production.

## Functions inspected

- `_cp_assert_active_admin_permission`: internal helper (postgres-only execute) used by authenticated SECURITY DEFINER entrypoints to resolve the active identity/session and permission.
- `admin_cancel_goal`: resolves the actor using the session/permission helper, then requires goals:manage (Super Admin shortcut) and locks/updates only the selected active goal.
- `admin_review_goal_cancellation`: requires goals:approve or goals:manage, with Super Admin shortcut, and validates active goal/pending cancellation state before update.
- `calculate_customer_authoritative_balance`: validates current session, effective financial-view permission, and customer active/deleted status before calling the guarded implementation.
- `create_admin_pending_customer_payment`: validates active account session, resolves actor from auth.uid(), checks finance:create-payment or Super Admin, amount/note bounds and customer active status.
- `get_admin_goals_page_data`: session/actor resolution and goal/request viewing permissions are resolved server-side.
- `begin_sync_bootstrap`: requires sync:manage through the server permission guard; its return enumerates broad sync collections and is explicitly not a conversational capability.
- `current_admin_id`: invokes session assertion before returning guarded identity.

## Assessment

- These reviewed entrypoints demonstrate server-side actor/session and effective permission checks, but are not approved as Sarah tools by virtue of those checks alone. Some return projections or execute mutations beyond Sarah's narrowly scoped initial capability set.
- Sarah must use dedicated, field-minimized read functions rather than bootstrap/change-log/sync projections or broad report RPCs.
- Service-role execution must never be treated as the conversational actor. The tool bridge needs actor-bound validation and exact permission checks.
- This is a focused sample, not a full SECURITY DEFINER, grants, view, trigger, schema, or RLS audit. Additional public functions and anonymous QR/customer endpoints remain to be inspected.
- Production remains unchanged; this document is audit-only.


## Anonymous/public endpoint spot-check

- `public_resolve_customer_qr` resolves an active, unexpired bearer QR token and returns only customer name and derived customer code.
- `public_resolve_order_qr` resolves an active order bearer token and returns a broad order/payment projection, including customer name, item details, paid/due amounts, and a boolean indicating positive customer credit (not the full balance). This is intended for the public order-QR experience, but represents a higher privacy-impact surface than the customer QR resolver. Keep this endpoint out of Sarah's catalog; review the public QR privacy model, token lifecycle, rate limiting, and whether balance fields are necessary in a separate application security audit.
- `public_landing_content` returns configured opening hours, active device types/prices, brand assets and charger fee settings for public landing use.
- `is_system_bootstrapped`/ `check_system_bootstrapped` return a boolean about whether an active Super Admin exists; no account data is exposed by the inspected definitions.
- This is a definition spot-check; token entropy, rate limiting, storage, expiry policy, and full response handling were not tested end-to-end. No changes were made to these production functions.

## Expanded catalog inventory (read-only, 2026-11-26)

A catalog query enumerated public SECURITY DEFINER routines with argument signatures, search_path settings, and ACLs. This is an inventory snapshot, not a full source audit.

- The inventory includes many authenticated EXECUTE entrypoints and corresponding guarded implementation/internal variants. These must be evaluated as actor/session/permission gates and not merely based on the presence of SECURITY DEFINER.
- Several sync/bootstrap/snapshot routines are broad-data projections; they are excluded from Sarah's conversational capabilities pending exact field scope and actor checks.
- The query is a metadata inventory only. It did not read business data or modify catalog state.
- Further full-body/ACL testing is still required before any scoped data tool is approved for Sarah.

## Expanded grant and routine review (read-only)

- Enumerated public SECURITY DEFINER functions and effective EXECUTE for `anon` and `authenticated`. The direct anonymous execute surface is limited to intended public bootstrap-status, app-identity/landing, QR/payment token endpoints in this catalog result; no other anonymous SECURITY DEFINER routine surfaced in the enumerated list.
- Public direct table privileges for `anon` or `authenticated` are limited to `app_release_policies` in the table catalog query. Its public read policy and Super Admin insert/update policies were reviewed.
- Public schema views/materialized views catalog query returned no entries.
- Purchase Book tables' policies enforce `admin_id = current_purchase_admin_id()`, which is an owner-bound scope; the current purchase identity function's body/grant should still be included in a dedicated behavioral adversarial test.
- The sync entrypoints `begin_sync_bootstrap` and `read_sync_bootstrap_page` require active admin session and `sync:manage`; their dynamic table allow-list and paging are synchronization-only, not Sarah capabilities. They return potentially broad records and should not be repurposed.
- `get_effective_permissions(p_admin_id)` checks the caller's current admin permission and requires admin:manage for another admin's permissions; its internal implementation is not directly executable by browser roles.

## Gateway operational gap identified

The current `sarah-ai-chat` Edge Function validates user identity, active admin profile and `ai:use`, and restricts request/history sizes. However, the reviewed gateway has no durable server-side per-actor rate/quota limiter before calling Gemini. A dedicated limiter needs an authenticated-actor key, bounded policy, atomic database enforcement, service-role-only internal access, and abuse/denial tests. Do not implement a weak in-memory limiter or reuse customer-login rate limits. This is a follow-up security gate before broader or higher-cost capabilities.

## Supabase advisor snapshot (read-only, 2026-11-26)

Security advisor reported:
- 59 public tables with RLS enabled but no policies (INFO). Catalog review found browser-role direct table access limited to `app_release_policies`; the no-policy tables are not directly exposed through those table grants in this snapshot. This remains defense-in-depth, not a blanket approval.
- 8 anonymous-callable SECURITY DEFINER functions (WARN), matching the inspected public bootstrap-status, identity/landing, and QR token/payment endpoints; their public intent and minimization/rate-limit behavior require separate validation.
- 73 authenticated-callable SECURITY DEFINER routines (WARN). This is a broad RPC API; effective actor/session/permission guards must be reviewed per function, and the warning itself is not proof of vulnerability.
- `pgcrypto` and `pg_net` in public schema (WARN); relocation requires separate dependency/migration planning.
- Auth compromised-password protection advisor warning; this is an account-security setting, not Sarah-specific.
- Performance advisor reported 57 unindexed foreign keys (INFO), 20 unused-index candidates (INFO), and 2 tables without primary keys (INFO). No indexes or keys were changed because remediation requires workload, migration, and data-integrity review.

No production DDL, writes, or setting changes were performed.

## Idle-session reactivation policy finding — needs separate remediation

Read-only inspection of the live function definition and migration shows `reactivate_my_account_session(p_client_type)` derives the idle window from caller-supplied `p_client_type`. It validates the underlying Auth session and rejects revoked sessions, but it does not validate a server-issued biometric proof or require a fresh Auth session for the `native/installed_pwa` 30-day branch. An authenticated caller can directly invoke the RPC and choose that client type. This makes the 7-day browser-vs-30-day native/PWA idle-window distinction client-asserted rather than a trusted boundary.

This is a policy-enforcement weakness, not a demonstrated privilege escalation beyond the authenticated account. The underlying Supabase Auth session and account-session revocation still apply. It nevertheless undermines the intended server-enforced idle policy.

Recommended safe remediation: require evidence of a fresh authentication event before native/PWA reactivation (server-validated Auth session creation age or a narrowly scoped, one-time server proof tied to the biometric/password reauthentication flow); never trust client type alone. Add adversarial RPC tests that attempt expired-browser-session reactivation with a spoofed `native` value and verify denial, while validating legitimate fresh native/PWA reactivation.

No changes were made to the live function. This needs a new migration (not editing the already-applied migration) and a dedicated test/validation cycle.


## Additional gateway review — request abuse and prompt-history boundary (2026-11-26)

Read-only source inspection of `supabase/functions/sarah-ai-chat/index.ts` confirmed:

- Each request validates the bearer token with Supabase Auth, resolves the active admin profile using `get_current_admin_profile`, verifies that profile's Auth UUID matches the authenticated user, and enforces `ai:use` (or Super Admin role) before reading the provider configuration/secret.
- The provider credential is retrieved server-side through the service-role-only RPC; it is not sent to the client. Request body and text/history bounds are checked, and provider calls have an abort timeout.
- The endpoint has no durable per-actor quota/rate-limit enforcement. Provider-side quota errors do not replace a server-side abuse-control policy.
- History is client-supplied and bounded, but it is not server-authenticated as a prior transcript. It must be treated as untrusted prompt context. This is acceptable for the currently tool-less conversational gateway only if the model is not treated as a source of authorization or operational truth. Before adding tools, the server must construct/validate the tool context and scope independently; never authorize from history.
- CORS currently allows any origin. The bearer-token and server-side authorization checks remain the security boundary, but a narrower origin policy may reduce unintended cross-origin usage and should be evaluated with the mobile/web deployment model.

**Status:** findings only; no implementation, migration, or production change. A durable atomic limiter, browser-level behavioural tests, and an origin policy decision remain release gates before any operational bridge.
