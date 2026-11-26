# Sarah AI — Phase 4 Scoped Read Bridge Design

Date: 2026-11-26
Status: design gate, not implemented or enabled.

## Security model
- Tool inputs are untrusted hints, never authorization context.
- Resolve actor identity and session from the Supabase authenticated request; validate the current registered session on each invocation.
- Permission resolution must be server-side, per invocation, using the active actor's effective permission set.
- Each capability maps to a single typed operation. No arbitrary SQL, table names, dynamic query fields, generated RPC names, or client-selected admin/customer scope.
- Return only small sanitized result DTOs; no phone, private notes, raw identifiers, or bulk datasets unless the task and permission specifically require them.
- Customer mode is a separate future catalog and must derive scope only from its authenticated customer session.

## Candidate initial read capabilities (sequence matters)
1. Customer name/code lookup: require customer-view permission, limit to 5 matches, return minimal display identity and ambiguity signal; no full-list enumeration and no phone by default.
2. Customer order summary: resolve a customer from an unambiguous canonical match; require order-view permission; hard bound by time window and number of orders.
3. Customer balance: separate financial capability; require effective customer-financial/finance-view permission; return server-calculated balance and currency, not ledger rows by default.
4. Order details: only after canonical order resolution; require orders:view and bound item/metadata fields.
5. Day summary: permission-check the requested day and cap rows/serialized bytes.

## Database enforcement requirements
- Public RPCs must validate active registered session and actor identity in their body; EXECUTE grants must be explicit.
- For ordinary authenticated admin calls, never accept a supplied admin ID to establish scope.
- Permissions must be checked at the RPC execution boundary, not in the model prompt, UI, or tool dispatcher only.
- Shared business records are not necessarily admin-owned. The boundary is effective permission, not pretending all records are tenant-owned. The Purchase Book is a true per-admin scope and must remain owner-scoped.
- Avoid existing sync bootstrap/pull RPCs as conversational tools: they are intentionally broad projections and are designed for synchronization.
- Service-role Edge Functions must re-authorize every request and must not treat service-role as the actor; if a database boundary cannot validate delegated actor scope, do not expose the capability.

## Test gate
- Admin A/B permissions, custom grant/deny replacement behavior, revoked/expired session, account switch, spoofed admin/customer/order IDs, no permission, prompt/history injection, result caps, offline/hydration state, no direct table grants, no service-role bypass.
- Behavioural tests must exercise RPC/database enforcement; source-string tests alone are not sufficient.
- Each capability remains disabled until a negative test proves unauthorized calls fail even when bypassing the UI/model.

## Current decision
Do not implement/enable operational reads until the public function catalog, grant matrix, and relevant SECURITY DEFINER bodies have been reviewed sufficiently to map existing canonical data paths and choose the smallest safe database capability.
## Database catalog results added to the implementation gate

Read-only production catalog review found:
- No public views/materialized views were cataloged.
- Public direct table SELECT/INSERT grants to browser roles are limited to `app_release_policies`; its policies were reviewed.
- Public EXECUTE on SECURITY DEFINER functions for browser roles was cataloged. Anonymous callable routines include the intentionally public app-identity/landing and QR/payment-token surfaces; these are not Sarah capabilities.
- Sync/bootstrap functions enforce an active admin and `sync:manage`, but their broad projections and paging allow-listed collection access are not a safe conversational interface.
- Purchase Book RLS is owner-scoped via `current_purchase_admin_id()`; any conversational tool would need to preserve that owner scope and not cross it.

## Initial typed capability contract (design only)

The first implementation candidate remains a narrowly typed customer lookup, not a direct table query:
- Input: normalized search string only (bounded length); no caller-supplied admin identity, permission, table, field, or SQL.
- Actor: derive auth user/session and active admin ID in the database boundary; require customer-view permission.
- Scope: active customer records only; exclude deleted/archived entries according to canonical application rules.
- Output: maximum 5 minimal matches with stable display code and name, plus an ambiguity indicator; no phone, financial balance, notes, ledger rows, order history, bulk enumeration, or arbitrary identifiers unless a later separately gated capability explicitly needs them.
- Query and result byte/row caps must be enforced by the database function, not only by the model tool wrapper.
- Add negative tests for actor spoofing, permission revocation, inactive sessions, account switching, ambiguous lookup, injection, excessive input, and no permission before enabling.
- This is still design only; no bridge function, migration, or capability has been implemented or enabled.

## Gateway rate-limit implementation status (branch-only, CI pending)

The branch currently implements a durable atomic hourly per-actor quota: 20 calls per actor per 3600-second bucket. It uses the Auth UUID validated by the gateway, service-role-only RPC, RLS, no direct browser grants, and deletes old buckets beyond 48 hours. The Edge Function fail-closes if the quota RPC fails and returns 429 when the quota is exhausted. This is the implementation currently in code; it does not implement the alternative 10-per-15-minute plus 100-per-day policy described in earlier planning.

The quota test SQL and gateway contract test are included in the branch. CI and deployment validation are still pending; no production migration has been applied by this branch work.

## Read-bridge blocker discovered in live catalog review

The existing `_cp_assert_active_admin_permission` deliberately returns NULL for service-role requests, bypassing browser-session and permission resolution. Therefore, calling existing permission-guarded RPCs from the Edge Function using service-role credentials does **not** preserve the originating user's permission boundary. The existing gateway currently verifies the user/session and `ai:use` in its own context, but a delegated read RPC would need a distinct database-level delegated-actor validation mechanism. No read capability should be exposed until that mechanism independently validates actor identity, current registered session, effective permission and operation scope despite service-role invocation. This is a concrete security design blocker, not a prompt/UI issue.


## Delegated database authorization: safer candidate to validate next

A promising alternative to passing actor IDs through service-role RPCs is to invoke the narrow capability using the **original validated user's JWT** (the same bearer token validated at the gateway), with a user-scoped Supabase client and no service-role credential for the capability call. This allows Postgres `auth.uid()` and request claims to represent the actual user, so existing active-session and permission guards can evaluate in their native context.

This is only a candidate pending implementation and tests; the quota and secret management can remain service-role-only, isolated from the data-capability client.

Implementation gates:
1. Build a dedicated user-JWT RPC client that cannot fall back to service-role credentials, and never persist/echo the JWT.
2. Confirm current registered-session checks match the user/session context carried by the JWT; ensure account switching or revoked sessions are denied.
3. Add a typed lookup RPC with fixed search behavior, bounded input, fixed minimal output and hard max-five limit; its own DB body calls the existing active-admin and customer-view guard before querying.
4. Avoid forwarding Gemini-supplied IDs, filters, column names, SQL, permission codes or table names.
5. Test direct RPC invocation independently from the chat/UI, including denied actor, revoked session, permission revoked, spoofing and malformed input. Also test Edge Function forwarding and prove the tool cannot use service role.
6. Keep the tool disabled until these tests and CI run. This is not yet implemented.
