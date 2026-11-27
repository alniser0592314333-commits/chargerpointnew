# Sarah AI — Phase 4 Scoped Read Bridge

Date: 2026-11-26

**Status:** Customer name/code lookup merged; limited customer profile read is in follow-up implementation and CI validation.

## Implemented capability

The first operational data capability is **customer name/code lookup**:

- Database RPC: `public.sarah_ai_lookup_customers(text)`
- Migration: `20261126213000_sarah_ai_scoped_customer_lookup.sql`
- Gemini tool name: `lookup_customers`
- Invocation: `sarah-ai-chat` forwards the original authenticated user's JWT through a user-scoped Supabase client. The tool never uses the service-role client.
- Required database permissions: `ai:use` and `customers:view`, checked independently inside PostgreSQL and resolved through the authoritative `admin_custom_permissions` / `admins.permissions` projection. The Admin Management UI exposes `ai:use` and `ai:manage` as separately assignable permissions; the legacy `permissions` / `role_permissions` catalog is not used for Sarah authorization.
- Session and actor: derived from `auth.uid()`, current registered admin session, and current effective permissions; no client-supplied admin/customer ID is accepted.
- Input: one normalized search string, 2–64 printable characters. The database uses fixed name-substring or exact four-character customer-code matching.
- Output: at most five active customer names and four-character display codes, plus `match_count` and `has_more`.
- Excluded: raw customer IDs, phone numbers, balances, debts, notes, ledger rows, orders, and deleted/inactive customers.
- The Edge Function allows at most one `lookup_customers` call per user request. The follow-up Gemini request receives the tool result but no further tools.
- The model is instructed to treat customer names/results as data, never as instructions, and not to claim access to fields that were not returned.

No customer financial history, order, finance, payment, day, device, notification, or write tool is enabled. A limited non-financial profile read is being added separately.

## Security model

- Tool inputs are untrusted hints, never authorization context.
- Resolve actor identity and session from the Supabase authenticated request; validate the current registered session on each invocation.
- Permission resolution is server-side, per invocation, using the active actor's effective permission set.
- Each capability maps to one typed operation. No arbitrary SQL, table names, dynamic query fields, generated RPC names, or client-selected admin/customer scope.
- Return only small sanitized result DTOs; no private notes, raw identifiers, or bulk datasets.
- Customer mode remains a separate future catalog and must derive scope only from its authenticated customer session.
- The provider service-role client is limited to narrow server-only runtime-config and Vault-secret RPCs. It has no direct SELECT access to the provider config table and is never used for customer data.
- The Sarah quota table has no direct grants to browser or service roles. User-facing quota RPCs derive the actor from `auth.uid()`.

## Database enforcement

- `sarah_ai_lookup_customers` calls the private `sarah_ai_assert_use_permission()` and `_cp_assert_active_admin_permission('customers:view')` checks before querying.
- The follow-up `sarah_ai_get_customer_profile` RPC applies the same independent checks, requires an exact four-character hexadecimal customer code, optionally filters by a name hint, and returns only a bounded non-financial profile DTO.
- EXECUTE is granted only to `authenticated`; anon and service_role cannot invoke the lookup RPC.
- The query is fixed, parameterized, active-customer-only, and capped inside PostgreSQL. The model cannot choose columns, sort expressions, joins, or row limits.
- The strict session-registry migration separately closes the read-only missing-session acceptance path, preserves first-owner bootstrap through a fresh-auth registration wrapper, and backfills only active admin sessions with live Auth sessions.
- The customer Jawwal recipient remains readable by a valid active customer Auth session linked to an active customer; that RPC returns a global recipient number, not customer records, and does not require a newer customer app-session registry row.

## Gateway quotas and service-role boundary

- `sarah_ai_consume_my_quota(period)`: fixed 20/hour and 100/day; requires `ai:use`.
- `sarah_ai_consume_my_manage_quota(period)`: same fixed caps for provider connection tests; requires `ai:manage`.
- Both derive the actor from `auth.uid()`. `ai:use` and `ai:manage` are granted only through explicit Super Admin-controlled custom permissions (Super Admin retains its existing bypass). No arbitrary-actor service-role quota RPC exists.
- The private counter uses an atomic upsert and a primary key containing actor, window duration, and window start, so hourly and daily windows cannot collide.
- The provider config table has no direct privileges for anon, authenticated, or service_role. The gateway calls a narrow service-only runtime projection and a separate service-only Vault secret RPC.
- Provider save/clear operations are serialized with a transaction-scoped advisory lock.

## Deferred capabilities and gates

The following remain disabled until each receives a separate typed RPC, permission mapping, bounded DTO, direct-RPC negative tests, and CI evidence:

1. Customer order history and customer history aggregates.
2. Customer balance and financial history.
3. Order lookup, order details, and order summaries.
4. Day summaries and daily order lists.
5. Devices, pricing, goals, requests, notifications, and events.
6. Purchase Book: must remain strictly per-admin owner-scoped.
7. Any mutation: must use existing application Use Cases, BIN/confirmation rules, transactional repositories, outbox/idempotency, and server-side authorization. No direct business-table writes.

## Test gate

The isolated customer lookup SQL test covers:
- Max-five output and `has_more` when more matches exist.
- Exact four-character code lookup and no-match behavior.
- Inactive/deleted customer exclusion.
- No customer IDs, phone, balance, notes, or order fields in the result.
- Short, oversized, and control-character input rejection.
- Denial for manager without `ai:use`, unregistered session, and disabled admin.
- Explicit authenticated-only EXECUTE grants.

The customer-profile SQL test covers code collisions and name-hint disambiguation, no-match/inactive/deleted exclusion, DTO field minimization, invalid input, independent permission denial, inactive sessions, and authenticated-only EXECUTE grants.

The quota CI step additionally launches 30 concurrent requests for one authenticated actor and expects exactly 20 allowed and 10 denied, with a stored count of 30.

The separate account-switch unit test covers stale async response rejection and A→B→A account switching. Multi-tab IndexedDB behavioural tests were added and merged with cross-context enqueue, upload-claim, and interrupted-upload recovery race coverage.

## Non-goals

- No model-generated SQL.
- No broad sync/bootstrap RPCs as conversational tools.
- No service-role delegated customer-data reads.
- No customer-to-customer data access.
- No model-generated business mutations.
- No claim that Sarah can inspect fields or execute actions not explicitly listed above.

## Implementation update — 27 Nov 2026

The limited customer profile read is being added as the second read-only customer capability. It is callable only through the original user JWT, re-checks `ai:use` and `customers:view` in PostgreSQL, charges its own tool quota, accepts a canonical four-character hexadecimal code plus optional name hint, and returns at most five sanitized non-financial profile DTOs. The DTO excludes IDs, phone, balance, debt limits, notes, orders, and financial history. It does not use the service-role data client and does not add any mutation capability.
