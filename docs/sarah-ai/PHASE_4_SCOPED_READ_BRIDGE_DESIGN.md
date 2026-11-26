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