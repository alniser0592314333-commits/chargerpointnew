# Sarah AI — Database Enforcement Boundary Audit (Phase 3)

Date: 2026-11-26
Branch: feat/sarah-chat-gemini-gateway-20261125
Status: audit note only; no production DB changes.

## Non-negotiable design
Sarah must never receive database credentials, direct SQL access, or an unrestricted service-role data path. The model is an untrusted request planner. Each capability must be exposed through a narrowly typed, allow-listed function and re-authorized at execution time.

## Database-layer enforcement
- Supabase RLS remains the primary row boundary for browser/session-bound access where applicable.
- Authenticated identity must be derived from trusted auth context, not tool arguments or prompt state.
- For privileged operations requiring SECURITY DEFINER, enforce session identity, active-account/session guard, role/permission, and object scope in the function itself; fixed search_path and explicit EXECUTE grants are mandatory.
- Never expose service_role to the browser or Gemini. A service-role backend must have its own strict, per-request actor authorization and data-scope validation; service_role does not itself enforce RLS.
- No model-generated SQL, arbitrary table access, broad customer listing, or cross-account data joins.
- Customer capability scope must derive exclusively from the authenticated customer session; admin capabilities must be bound to the specific active admin identity and effective permissions.
- Offline queues, transcripts, retries, and audio blobs remain identity-keyed and are cleared/rejected on account change.

## Direct production catalog checks (read-only)
The Supabase catalog inspection was attempted against project ydhcyamtgioyrxfarkwk. Tool output was incomplete/ambiguous for multi-statement catalog queries, so it is NOT treated as a complete RLS/security audit.
- The verbose public-table catalog reported RLS enabled on the listed tables including roles, permissions, admins, device_types and devices.
- A query surfaced only a permissive SELECT policy on app_release_policies (public read) plus a super-admin insert check; this table appears release-policy metadata, not business customer/ledger records.
- The grants query output surfaced browser-role table grants for app_release_policies only, but because the tool response was incomplete, this cannot be treated as proof that all tables/grants/policies are secure.
- SECURITY DEFINER functions exist in public schema, many with fixed search_path; several legacy/internal functions show empty search_path or pg_catalog/public. Each function needs individually reviewed definition, ACL, wrapper/implementation linkage, and callers. Presence alone is not evidence of vulnerability.

## Further verified catalog observations (targeted function-definition queries)
- `get_effective_permissions(p_admin_id)` is SECURITY DEFINER and callable by authenticated users; it derives the current admin identity via a guarded function and requires `admin:manage` when querying another admin. This is a positive guard pattern, but it still needs negative tests.
- `read_sync_bootstrap_page(entity,cursor,limit)` is callable by authenticated admins with `sync:manage`; it restricts entity types to a fixed allow-list, caps page size at 500, and scopes purchase-book rows by admin id. Its other allow-listed business collections are broad synchronization projections, not appropriate for Sarah's conversational read bridge.
- `capture_authoritative_business_snapshot()` wrapper checks the active-account session before its implementation. Other synchronization capture/pull wrappers also include explicit permission/session checks; implementations and actor scopes require further review.
- Some SECURITY DEFINER functions intentionally have elevated grants for `authenticated`, while wallet snapshot/transaction functions and some internal dispatch functions are service_role-only. This distinction must be preserved; do not treat service-role-only ACLs as browser-callable exposure. Catalog evidence alone cannot confirm downstream caller safety.
- Targeted reads of definitions and ACLs were performed only; no RPC was executed to read business data and no changes were made.

## Required audit before activating Sarah data tools
1. Inventory all business tables, RLS, FORCE RLS, grants, policies, views/materialized views, RPC EXECUTE ACLs, SECURITY DEFINER definitions, and exposed schemas.
2. Verify each public/browser callable RPC has identity/session guard and fail-closed scope; inspect all service-role pathways and Edge Functions.
3. Build Sarah read capabilities as narrowly scoped RPCs or backend actions with database-enforced actor scope and hard result/field limits. Do not expose existing general-purpose read models as security boundaries.
4. Add negative tests: spoofed admin/customer IDs, permission escalation, cross-admin/cross-customer access, revoked session, role change, account switch, prompt injection, service-role path, RPC bypass, search/list limits.
5. Keep tool catalog disabled until all tests and deployment checks pass.

## No production changes
This audit note documents a boundary and an incomplete inspection. It makes no claim of verified RLS completeness and does not apply migrations, modify production rows, merge, or deploy.


## 2026-11-26 follow-up: catalog and advisory scan

- A read-only catalog query enumerated public/storage tables and policy state. 59 public tables reported RLS enabled without policies; this is not automatically a vulnerability because direct table grants were separately enumerated.
- The targeted information_schema.table_privileges query showed browser-role table grants only on `app_release_policies` among public tables. Its anon SELECT and authenticated SELECT/INSERT/UPDATE policies are intentional release metadata access, but need separate scope/content review.
- The catalog query found no public-schema views/materialized views in the enumerated relation set. (The `v_email` name is a table in the catalog, not a view.)
- Supabase security advisors reported 8 SECURITY DEFINER functions executable by anon, including public bootstrap checks, app identity, landing content, QR resolvers, and QR-payment submission. These are public application endpoints and must be audited individually; their existence is not proof of exploitable exposure. The separate authenticated SECURITY DEFINER advisor findings also require triage before Sarah's tool bridge is enabled.
- Supabase advisors also reported extensions pgcrypto and pg_net in public schema. Relocation is not included in Sarah work because it could affect existing production RPCs and is not yet dependency-mapped.
- No data rows were read. These are catalog, grant, policy, and advisor findings only.

## Read-only session-gate regression repair (branch-only)

- The server session-active function previously attempted legacy session registration and activity updates in read-only transactions.
- The migration was updated so read-only transactions avoid writes: an already registered session is still checked for revocation and expiry; an unregistered session fails closed instead of registering; the read-only path returns before the activity-write throttle.
- The activity update condition is explicitly guarded by the read-only flag.
- A source contract was added to require the read-only guard. This has not yet been confirmed by a completed CI run and is not deployed to production.


## Effective-permission resolution findings

- The server-side `_cp_assert_active_admin_permission` helper derives the actor from `auth.uid()`, requires an active registered session, resolves the linked active admin record, and grants the Super Admin role shortcut only after that identity resolution.
- `get_effective_permissions` checks that a non-service caller is the current active admin and requires `admin:manage` when requesting another admin's permission set.
- The internal effective-permission projection uses custom permission state as an override: if any custom-permission rows exist for an admin, only positive custom grants are returned; otherwise the profile's stored permissions are used. This is important for Sarah's execution-time permission checks and needs negative/override tests, not assumptions that custom grants are additive.
- The read-sync-bootstrap RPC is deliberately not suitable as Sarah's read tool: its entity allow-list still returns shared business projections for admins who hold `sync:manage`, whereas the conversational tool catalog must be narrower and field-minimized.
