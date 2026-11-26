# Sarah Phase 3 — Read capability design audit

**Reviewed commit:** 92770c29a678238bff353663b716eb18525ef163  
**Scope:** Source-level mapping of existing read models; no application data queried and no operational writes.

## Verified read model candidates

The current `src/components/pages/dayOrdersStore.ts` exports established read functions that already hydrate local-first canonical models and project pending overlays:

- `searchCustomersAndOrders(query, limit)`: mixed customer/order search. Numeric query is interpreted as order number first. It can return phone and customer name; Sarah must not return bulk results or expose phone by default.
- `getCustomersList(query, limit)`: supports name, phone, code; returns balance and phone, and no explicit limit returns the whole active list. Wrappers must enforce small hard limits and avoid phone output unless needed.
- `getCustomerDetail(customerId)`: resolves ID or customer code and returns name, phone, code, balance, debt limit, active state, exemption, creation date.
- `getCustomerOrders(customerId)`: returns order/item summaries, amounts, business date, status and payment status. Bound results before model context.
- `getCustomerFinancialHistory(customerId)`: includes authoritative ledger plus pending projections; sensitive financial history and must be guarded by effective finance/customer-financial permissions.
- `getOrdersForDay(dayId)`: day order/item read model including projected status and payment status; requires a scoped day and bounded response.
- `getDaysList()`, `getTodayHomeData(locale)`, `getFinancialsOverviewData()`, `getFinancialCustomersByFilter(filter,limit)`: summary candidates, but require explicit permission wrappers and output-field minimization.

## Architecture constraints before implementation

1. The helpers are client-side read models, not independent authorization boundaries. A future tool bridge must re-check active authenticated account/session and effective permission at invocation time; UI navigation permission is not sufficient.
2. Never pass a model's arbitrary customer identifier into a helper without validation and a permission check. Resolve customer matches to a canonical record first; ask for disambiguation if search is ambiguous.
3. Avoid list-all and unbounded helper calls. Hard-code wrapper caps, select only relevant fields, and truncate history by records and serialized bytes.
4. Minimize provider exposure: phone, full ledger notes, IDs, and sensitive metadata should be excluded unless the user task requires them. The model should receive only a small sanitized result.
5. Read tools must not mutate, repair, synchronize, or create days. They should fail closed when required hydration is unavailable and clearly distinguish local/pending data from authoritative data.
6. Do not implement a second SQL/REST business-data layer. Reuse these models and existing canonical Use Cases; mutation tools remain a later phase with explicit confirmation, BIN where applicable, server-side checks, and idempotency.

## Chat-gateway observations for later hardening

- The gateway accepts bounded client-provided history; it should be treated as untrusted content, never as authorization or system instructions.
- The first narrow read-only tool is now implemented: customer name/code lookup only. It uses the original user JWT and a typed database RPC requiring `ai:use` plus `customers:view`; it returns at most five active customer names/codes and no IDs, phone, balance, notes, or order data. No other operational tools are enabled.
- Queue recovery deliberately avoids automatically replaying interrupted provider calls without idempotency.
- CI for the reviewed commit passed the Sarah settings/chat contracts, Deno validation, provider-adapter tests, migration isolation, and application type-check/build. The full-main baseline diagnostic is separately known to have 44 failing test files and is not attributed to this PR.

## Next implementation gate

Expand the catalog only one capability at a time. Customer lookup is implemented; customer detail (without financial history), order history, and scoped day summaries remain disabled. Add direct-RPC negative permission, ambiguity, hard-limit, account-switch, offline/hydration, and data-minimization tests before each expansion.


## Implementation update — 26 Nov 2026

The first customer lookup capability is wired through Gemini function calling in `sarah-ai-chat`. The Edge Function:
- exposes only `lookup_customers` when the authenticated admin profile has `customers:view`;
- executes at most one function call per user request;
- forwards the original bearer token to `sarah_ai_lookup_customers` through the user-scoped client;
- does not send service-role credentials to the data capability;
- performs a second Gemini request without tools, preventing recursive/multiple tool calls.

The database RPC independently requires `ai:use` and `customers:view`, derives identity/session from the JWT, validates input length/control characters, excludes inactive/deleted customers, and returns a maximum of five name/code-only matches. Direct EXECUTE is authenticated-only. Isolated SQL tests cover permission denial, inactive sessions, disabled admins, result caps, data minimization, and invalid input.

This is the only active data capability. Customer detail, balances, financial history, orders, days, devices, notifications, and all mutations remain unavailable to Sarah.
