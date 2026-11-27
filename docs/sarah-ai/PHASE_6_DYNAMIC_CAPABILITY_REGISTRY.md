# Sarah Phase 6 — Dynamic capability registry

**Status:** implementation foundation on an isolated branch; not yet deployed.

## Implemented in this phase

- The chat gateway now defines one capability registry for Sarah's currently approved capabilities.
- Each entry owns its Gemini declaration and the exact existing effective application permission key(s) required to expose it.
- The enabled tool list is derived from the authenticated admin profile returned by the original user JWT.
- Super Admin receives every capability registered in this catalog without a separate per-tool permission toggle.
- Ordinary admins receive only capabilities present in their current effective permission projection. The UI does not supply this list.
- The server rejects any model tool call that is not in the current request's enabled registry.
- Existing PostgreSQL RPCs independently enforce actor identity, active session, ai:use, and the underlying business permission. A permission revoked while Gemini is processing therefore fails closed at the RPC boundary.
- The system prompt no longer hardcodes the number or names of tools; supplied tool schemas define the request scope.
- The Edge Function config now requires platform JWT verification in addition to explicit auth.getUser and registered-session checks.

## Current capability inventory

The following five bounded capabilities are registered today:

| Tool | Required application permission | Data returned |
|---|---|---|
| lookup_customers | customers:view | Up to five active customer names and display codes |
| get_customer_profile | customers:view | Up to five bounded non-financial profile matches |
| get_financial_summary | finance:view OR reports:view | Aggregate ledger record count, net balance, and generation time |
| list_pending_payments | finance:approve-payment OR finance:create-payment | Up to twenty pending manual/Jawwal Pay submissions; read-only |
| get_goals_overview | goals:view OR goals:requests:view | Up to fifteen matching goal/request summaries; read-only |

The finance and goals tools are read-only. No order listing, delivery, payment creation/approval, goal creation/approval/cancellation, or customer-history access/write operation is enabled yet.

## Extension contract for each new operation

Every future registry entry must be added only after its implementation is ready and must include:

1. A single stable tool name and strict input schema.
2. One or more exact existing application permission keys. The registry exposes the tool when at least one listed permission is present; the canonical database RPC must enforce the same effective permission rule.
3. A typed executor that calls the original canonical application RPC/Use Case, never arbitrary SQL or a model-selected RPC.
4. Independent database-side actor/session/permission checks on every invocation.
5. A bounded, minimized result DTO and explicit ambiguity handling.
6. Idempotency and confirmation rules for mutations; BIN and approval requirements where the original workflow requires them.
7. Positive and negative tests for Super Admin, ordinary admin with/without the permission, permission revocation during a conversation, account switching, duplicate requests, and unauthorized direct RPC calls.

Customer mode remains a separate actor scope and is not included in this admin registry. Temporary 24-hour history approval must be validated by its existing server-side grant on every history request; conversational context is never a grant.

## Release gate

This branch is not a production release. Run Sarah contract tests, Deno validation, type-check/build, and relevant SQL authorization tests before merge. Do not deploy any database migration or change customer/financial data as part of this registry-only phase.