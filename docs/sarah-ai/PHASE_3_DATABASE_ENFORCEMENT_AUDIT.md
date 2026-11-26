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

## Required audit before activating Sarah data tools
1. Inventory all business tables, RLS, FORCE RLS, grants, policies, views/materialized views, RPC EXECUTE ACLs, SECURITY DEFINER definitions, and exposed schemas.
2. Verify each public/browser callable RPC has identity/session guard and fail-closed scope; inspect all service-role pathways and Edge Functions.
3. Build Sarah read capabilities as narrowly scoped RPCs or backend actions with database-enforced actor scope and hard result/field limits. Do not expose existing general-purpose read models as security boundaries.
4. Add negative tests: spoofed admin/customer IDs, permission escalation, cross-admin/cross-customer access, revoked session, role change, account switch, prompt injection, service-role path, RPC bypass, search/list limits.
5. Keep tool catalog disabled until all tests and deployment checks pass.

## No production changes
This audit note documents a boundary and an incomplete inspection. It makes no claim of verified RLS completeness and does not apply migrations, modify production rows, merge, or deploy.
