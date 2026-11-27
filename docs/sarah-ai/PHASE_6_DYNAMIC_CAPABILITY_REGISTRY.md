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
- Goal proposals are generated in PostgreSQL from the same 28-day delivered/recognized/non-replacement activity profile and policy as the app. Goal creation, approval, rejection, and edits use canonical sync commands; cancellation and cancellation review use the existing guarded admin RPCs.
- Customer balances are calculated by the existing authoritative ledger function; order reads use a bounded server-side projection.
- The canonical goals page RPC retains its existing expiry reconciliation behavior; it is not replaced with a parallel goal engine.
- The system prompt no longer hardcodes the number or names of tools; supplied tool schemas define the request scope.
- The Edge Function config now requires platform JWT verification in addition to explicit auth.getUser and registered-session checks.

## Current capability inventory

The following fifty bounded capabilities are registered today:

| Tool | Required application permission | Data returned |
|---|---|---|
| lookup_customers | customers:view OR customers:read | Up to five active customer names and display codes |
| get_customer_profile | customers:view OR customers:read | Up to five bounded non-financial profile matches after a same-session lookup proof |
| get_customer_financial_summary | (customers:view OR customers:read) AND (customers:financial-view OR finance:view OR finances:read) | One authoritative customer balance in ILS minor units |
| get_customer_financial_history | (customers:view OR customers:read) AND (customers:financial-view OR finance:view OR finances:read) | Up to twenty recent authoritative ledger entries with bounded references |
| adjust_customer_finances | customers:view AND (customers:financial-view OR finance:view) AND (finance:credit-adjustment OR finance:refund), with the database enforcing the exact action permission | Adds/consumes customer credit or refunds a specific positive payment entry; refund caps and secure BIN are enforced server-side |
| get_business_day_orders | orders:view | Up to 200 orders for one business date, with exact IDs, display numbers, versions and customer names |
| renumber_day_orders | orders:view AND orders:renumber-day | Reorders the complete order set for one open day through the canonical command with version and set validation |
| get_business_hours_settings | settings:manage | Reads current public business hours through the app's existing Edge Function |
| update_business_hours_settings | settings:manage | Updates only explicit fields after reading current settings through the canonical SET_SYSTEM_SETTING command; the database rechecks session and permission on the write |
| get_jawwal_pay_recipient | settings:manage | Reads the central public Jawwal Pay recipient number through the app's existing authenticated RPC |
| update_jawwal_pay_recipient | settings:manage | Updates the central recipient number in 05xxxxxxxx format through the original session- and permission-guarded RPC |
| get_customer_orders | (customers:view OR customers:read) AND (orders:view OR orders:read) | Up to ten recent orders and bounded item status/charge details |
| create_order_with_items | (customers:view OR customers:read) AND orders:create AND (orders:edit OR orders:write) | One atomic order with up to ten catalog-resolved items; today's day is opened only with settings:manage |
| lookup_customer_accounts | (customers:view OR customers:read) AND customers:deactivate | Up to five active or inactive account names, codes, and active states; creates same-session proof |
| set_customer_active_status | (customers:view OR customers:read) AND (customers:edit OR customers:write) AND customers:deactivate | Activates/deactivates one exact account through canonical UPDATE_CUSTOMER |
| update_customer_protected_settings | (customers:view OR customers:read) AND (customers:edit OR customers:write), with the database checking the exact field permission | Updates only the protected field for which the admin has the granular permission; requires separate secure BIN and redacted canonical audit logging |
| update_customer_profile | (customers:view OR customers:read) AND (customers:edit OR customers:write) | Updates only name, phone, or notes after a same-session lookup; protected debt-limit and charger-fee exemption fields remain excluded |
| create_customer | customers:create | Creates one active customer through the canonical command with the app's default ₪20 debt limit and no charger exemption; stable request ID prevents duplicate creation |
| get_device_catalog | devices:view | Up to one hundred non-retired device types, bilingual names, base prices, and charger policy |
| create_device_type | devices:manage AND devices:pricing AND devices:charger-policy | Creates one device type through the canonical catalog command |
| update_device_type | devices:manage, with additional database checks for devices:pricing and devices:charger-policy when those fields change | Updates one exact catalog item using its returned version |
| retire_device_type | devices:manage | Retires one exact catalog item through the canonical command; order history is preserved |
| get_financial_summary | finance:view OR reports:view | Aggregate ledger record count, net balance, and generation time |
| list_pending_payments | finance:approve-payment OR finance:create-payment | Up to twenty pending manual, customer QR, and Jawwal Pay submissions |
| record_and_approve_customer_payment | customers:view AND finance:create-payment AND finance:approve-payment | One manual CASH payment through the existing pending-submission + approval workflow; requires secure BIN |
| approve_payment_submission | finance:approve-payment AND finance:create-payment | Approves one existing pending submission using its ID and amount; requires secure BIN |
| reject_payment_submission | finance:approve-payment | Rejects one existing pending submission with a reason; no BIN |
| deliver_order_item | (customers:view OR customers:read) AND (orders:view OR orders:read) AND orders:deliver | Delivers one exact item through canonical financial recognition; secure BIN required |
| cancel_order_item | (customers:view OR customers:read) AND (orders:view OR orders:read) AND orders:cancel | Cancels one exact item through canonical financial reversal; secure BIN required |
| cancel_order | (customers:view OR customers:read) AND (orders:view OR orders:read) AND orders:cancel | Cancels one full order through canonical item-level reversals; secure BIN required |
| get_goals_overview | goals:view OR goals:manage OR goals:requests:view OR goals:approve | Up to fifteen matching goal/request summaries plus a bounded customer directory |
| list_customer_history_requests | customers:edit OR customers:write OR customers:manage OR customer_accounts:manage OR customer_accounts:reset OR admin:manage | Up to twenty pending customer requests for temporary full-history access |
| review_customer_history_request | same customer-account management permissions | Approves or rejects one pending request; approval creates the existing 24-hour server-side grant |
| list_subordinate_admins | admin:manage | Up to 100 subordinate admin account summaries without credentials |
| get_admin_custom_permissions | admin:manage AND Super Admin role | Custom permission overrides for one exact subordinate admin; original RPC is Super Admin-only |
| get_admin_audit_logs | admin:manage | Up to 100 recent admin audit events, optionally filtered to one target |
| set_admin_permission | admin:manage AND Super Admin role | Grants or explicitly denies one exact system permission through the original RPC; secure BIN required |
| suspend_admin | admin:manage AND Super Admin role | Suspends one subordinate admin through the original RPC; secure BIN required |
| activate_admin | admin:manage AND Super Admin role | Reactivates one subordinate admin through the original RPC; secure BIN required |
| get_sarah_ai_provider_settings | ai:manage | Reads sanitized Gemini provider/model/generation settings and whether a key exists; never returns the key |
| update_sarah_ai_provider_settings | ai:manage | Updates model and generation settings while preserving an existing secret; if no key exists, directs the admin to the secure settings screen |
| test_sarah_ai_provider_connection | ai:manage | Tests the configured provider without exposing credentials |
| clear_sarah_ai_provider_settings | ai:manage | Clears the provider configuration only after an explicit user request |
| get_customer_goal_proposal | goals:manage | Official app-generated proposal from the last 28 days of qualifying activity |
| create_customer_goal | goals:manage | Creates one active goal with app-generated values unless all three manual values are explicitly supplied |
| approve_goal_request | goals:approve | Approves one pending request with a complete app-generated or explicit proposal |
| reject_goal_request | goals:approve | Rejects one pending goal request with a reason |
| update_customer_goal | goals:manage | Updates target/duration/bonus only, using expected-version protection |
| cancel_customer_goal | goals:manage | Cancels one active goal through the existing admin RPC |
| review_goal_cancellation | goals:approve OR goals:manage | Approves/rejects one pending cancellation request through the existing admin RPC |

Read capabilities include customer/profile/balance/order lookup, non-retired device catalog, aggregate financial reporting, pending payment lists, goal/request summaries, official goal proposals, Jawwal Pay recipient number, and sanitized AI provider settings. Enabled mutations include customer creation, basic profile editing and BIN-protected debt-limit/charger-exemption changes, device catalog creation/update/retirement, customer credit adjustments and payment refunds, customer activation/suspension, business-hours and Jawwal Pay recipient settings, AI provider model/generation-setting changes and explicitly requested provider clearing, order creation, delivery, item/order cancellation, full-day order renumbering, manual CASH payment record-and-approval, approval/rejection of existing pending payment submissions, and goal creation, request approval/rejection, goal configuration updates, goal cancellation, and cancellation-request review. Provider API keys remain confined to the secure AI settings screen and are never accepted or returned in chat. Device price and charger-policy changes are checked independently against the exact original permission keys inside PostgreSQL.

Order creation calls the existing canonical CREATE_ORDER and ADD_ORDER_ITEM commands inside one database transaction; any failed item rolls back the whole order. It rechecks active customer/device state, the debt-limit rule, duplicate same-customer/day orders, open-day state, and current account permissions. If today's Palestine business day does not exist, it is created only when the actor has settings:manage; a closed day is never reopened.

Manual CASH payment entry calls the existing create_admin_pending_customer_payment and review_qr_payment_submission workflow in one transaction. Existing customer QR/Jawwal Pay/manual submissions are reviewed through the same review_qr_payment_submission path. Approval requires the account BIN in a separate password field in the app; the BIN is not part of Gemini history/tool arguments and is excluded from idempotency storage. Rejection requires a reason but no BIN.

Mutations use a deterministic action-specific request ID derived from the queued message ID, tool name, and normalized tool arguments. The database binds results to the Auth user and payload, rechecks the active session and current permissions, and safely replays completed commands. Customer-specific profile/balance/order reads and order lifecycle actions require a lookup proof bound to the same Auth user and current session and expiring after five minutes. Goal operations use the exact customer/goal/request IDs returned by the permission-checked Goals page projection and recheck the relevant goals permission in the database. Order corrections and finance corrections have no separate canonical assistant workflow identified yet; sync-center actions remain device-local and are not exposed to the server-side assistant; global settings beyond business hours/business-day opening, subordinate-admin creation and password/BIN credential changes, and customer assistant mode are not enabled yet. The selectable sync:manage permission is still enforced by the original Sync Center, but Sarah cannot inspect or mutate a device's IndexedDB outbox until a separate client-local tool bridge is implemented. The current inventory is therefore not the complete application permission surface; these operations remain closed until their original workflows have been safely wrapped and tested. The change-log hardening migration prevents future canonical writes from logging credential fields. The one-time historical redaction SQL is retained only as a disposable CI test fixture, not as a production migration. No existing production audit rows are changed by this phase. Customer-history requests and their 24-hour approvals use the existing customer-history Edge Function and database grant.

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