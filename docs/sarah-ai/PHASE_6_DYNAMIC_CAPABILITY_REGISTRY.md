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
- Customer profile, financial, order, and order-creation lookups require a five-minute proof bound to the current Auth user and session; guessed customer codes or a different device/session cannot be used as proof.
- Order creation uses a stable client request ID and invokes the canonical order/item commands within one SQL transaction; the AI model never chooses an RPC name or supplies an actor ID.
- Delivery and cancellation expose target IDs only in the proof-scoped customer order projection; the database wrapper checks customer ownership and delegates to canonical commands, including BIN enforcement and financial reversal behavior.
- Customer balances are calculated by the existing authoritative ledger function; order reads use a bounded server-side projection.
- The canonical goals page RPC retains its existing expiry reconciliation behavior; it is not replaced with a parallel goal engine.
- The system prompt no longer hardcodes the number or names of tools; supplied tool schemas define the request scope.
- The Edge Function config now requires platform JWT verification in addition to explicit auth.getUser and registered-session checks.

## Current capability inventory

The following eleven bounded capabilities are registered today:

| Tool | Required application permission | Data returned |
|---|---|---|
| lookup_customers | customers:view | Up to five active customer names and display codes |
| get_customer_profile | customers:view | Up to five bounded non-financial profile matches after a same-session lookup proof |
| get_customer_financial_summary | customers:view AND (customers:financial-view OR finance:view OR finances:read) | One authoritative customer balance in ILS minor units |
| get_customer_orders | customers:view AND orders:view | Up to ten recent orders and bounded item status/charge details |
| create_order_with_items | customers:view AND orders:create AND orders:edit | One atomic order with up to ten catalog-resolved items; today's day is opened only with settings:manage |
| get_financial_summary | finance:view OR reports:view | Aggregate ledger record count, net balance, and generation time |
| list_pending_payments | finance:approve-payment OR finance:create-payment | Up to twenty pending manual, customer QR, and Jawwal Pay submissions |
| record_and_approve_customer_payment | customers:view AND finance:create-payment AND finance:approve-payment | One manual CASH payment through the existing pending-submission + approval workflow; requires secure BIN |
| approve_payment_submission | finance:approve-payment AND finance:create-payment | Approves one existing pending submission using its ID and amount; requires secure BIN |
| reject_payment_submission | finance:approve-payment | Rejects one existing pending submission with a reason; no BIN |
| get_goals_overview | goals:view OR goals:requests:view | Up to fifteen matching goal/request summaries; read-only |

Read capabilities include customer/profile/balance/order lookup, aggregate financial reporting, pending payment lists, and goal/request summaries. The enabled mutations are order creation, manual CASH payment record-and-approval, approval of an existing pending payment submission, and rejection of an existing pending submission.

Order creation calls the existing canonical CREATE_ORDER and ADD_ORDER_ITEM commands inside one database transaction; any failed item rolls back the whole order. It rechecks active customer/device state, the debt-limit rule, duplicate same-customer/day orders, open-day state, and current account permissions. If today's Palestine business day does not exist, it is created only when the actor has settings:manage; a closed day is never reopened.

Manual CASH payment entry calls the existing create_admin_pending_customer_payment and review_qr_payment_submission workflow in one transaction. Existing customer QR/Jawwal Pay/manual submissions are reviewed through the same review_qr_payment_submission path. Approval requires the account BIN in a separate password field in the app; the BIN is not part of Gemini history/tool arguments and is excluded from idempotency storage. Rejection requires a reason but no BIN.

Mutations use a deterministic action-specific request ID derived from the queued message ID, tool name, and normalized tool arguments. The database binds the result to the Auth user and payload, rechecks the currently active session and permissions, and can safely replay a completed action after the same account renews its session. Customer-specific reads and new customer-targeted actions still require a lookup proof bound to the same Auth user and current session and expiring after five minutes. Order delivery/cancellation/editing, payment refunds/corrections, goal creation/approval/cancellation, customer-history access, and customer assistant mode are not enabled yet.

## Extension contract for each new operation

Every future registry entry must be added only after its implementation is ready and must include:

1. A single stable tool name and strict input schema.
2. One or more exact existing application permission keys. The registry exposes the tool when at least one listed permission is present; the canonical database RPC must enforce the same effective permission rule.
3. A typed executor that calls the original canonical application RPC/Use Case, never arbitrary SQL or a model-selected RPC.
4. Independent database-side actor/session/permission checks on every invocation.
5. A bounded, minimized result DTO and explicit ambiguity handling.
6. Idempotency and confirmation rules for mutations; BIN and approval requirements where the original workflow requires them. Order creation and payment actions use payload-bound action request IDs; order creation commits the order plus all items atomically, and payment approval keeps BIN out of Gemini and persistent idempotency data.
7. Positive and negative tests for Super Admin, ordinary admin with/without the permission, permission revocation during a conversation, account switching, duplicate requests, and unauthorized direct RPC calls.

Customer mode remains a separate actor scope and is not included in this admin registry. Temporary 24-hour history approval must be validated by its existing server-side grant on every history request; conversational context is never a grant.

## Release gate

This branch is not a production release. Run Sarah contract tests, Deno validation, type-check/build, and relevant SQL authorization tests before merge. Do not deploy any database migration or change customer/financial data as part of this registry-only phase.