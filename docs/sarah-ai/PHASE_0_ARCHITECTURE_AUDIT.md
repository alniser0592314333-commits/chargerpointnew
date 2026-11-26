# Sarah AI — Phase 0 Architecture Audit (Initial Evidence Baseline)

**Date:** 2026-11-24  
**Base:** `main` at `3e2812476421c72660ae33a06337b26732f8b3be`  
**Status:** Phase 0 architecture audit complete for the Sarah foundation and initial tool boundary. Some later capability domains are explicitly deferred until their service-specific permission and data paths are mapped.  
**Safety:** No production database writes, migrations, Edge Function deployments, or changes to `main` were made.

## 1. Executive findings

1. `@google/genai@^2.4.0` is already a dependency in `package.json`, but GitHub code searches for `GoogleGenAI`, `@google/genai`, `generateContent`, `Sarah AI`, `aiProvider`, `audioRecorder`, and `MediaRecorder` returned no source matches. The dependency is currently unused in the indexed source; it is not a working Gemini integration. No Sarah page/service or AI Gateway exists in the reviewed repository tree.
2. The live Supabase project currently has 13 active Edge Functions; none is an AI/Sarah gateway. `supabase/config.toml` also has no AI function entry.
3. The live `public.system_settings` table has seven existing business/QR/reset settings and no AI configuration key. It is RLS-enabled; the inspected table grants were limited to `postgres` and `service_role`, not browser roles.
4. The Settings screen already uses a section-based menu and supports Arabic/English, RTL/LTR, and light/dark themes. A dedicated `ai` section can be added without redesigning the whole Settings page.
5. The app has a canonical local-first command path: `FinalUseCases` → repository/transaction context → local persistence/optimistic overlay/outbox → sync engine → canonical Supabase RPC. Sarah must call this path for mutations and must not write business tables directly.
6. The existing `FinalUseCases` class exposes operational mutation methods, but its public method list does not provide a complete read/query API. Read operations need a separate evidence-based mapping to existing read models/selectors before Sarah tools are finalized.
7. The current IndexedDB schema has durable operational/sync stores, but no Sarah input queue or audio Blob store. Its memory fallback is not suitable for durable AI input retention.
8. The installed Capacitor dependencies do not currently include an audio recorder or filesystem plugin. Native audio persistence/background upload therefore needs a separate Android capability assessment.
9. The database has the Supabase Vault extension installed (version 0.3.1), but the extension is documented as public alpha. The live grants show no `vault` schema access for `authenticated` or `anon`; `service_role` can read/delete the Vault tables, and SECURITY DEFINER `create_secret` / `update_secret` functions are executable by `service_role`. No `delete_secret` helper function is installed. Vault is a plausible server-only secret store, but secret deletion/rotation must be implemented and tested carefully; never expose it directly to the browser.

## 2. Evidence reviewed

### Repository

- `package.json`: React 19, TypeScript, Vite, Capacitor 7, Supabase JS, Vitest, Zod, and `@google/genai`.
- `src/App.tsx`: admin/public route separation, auth bootstrap, session refresh, cross-tab identity change handling, Settings route.
- `src/components/pages/SettingsPage.tsx`: current settings section state/menu, permission checks, bilingual labels, and section rendering.
- `src/application/useCases.ts`: `FinalUseCases`, `RepositoryContext`, transaction boundary and operational mutation methods.
- `src/application/authContext.ts`: authenticated actor, permission checks, and BIN verification contract.
- `src/services/auth/authService.ts`: `UserSession`, role/permission hydration, persisted Supabase session handling.
- `src/infrastructure/localDb/localDb.ts`: IndexedDB database name/version, object stores, memory fallback, outbox/history/state/snapshot/overlay persistence.
- `src/infrastructure/sync/syncEngine.ts`: scheduler, dependency handling, retry classification, and diagnostic journal integration.
- `src/infrastructure/sync/SupabaseSyncTransport.ts`: canonical `execute_sync_command` push and canonical change pull.
- `src/tests/canonical_architecture_foundation.test.ts`: existing architecture invariants and regression-test patterns.
- `supabase/config.toml`: currently declared Edge Function routes and JWT verification flags.

The repository's GitHub code-search index did not return usable source matches during this pass. Therefore, absence claims are limited to the reviewed files and live inventories; this is not represented as a successful full-repository grep.

### Current repository state

- Latest observed `main` commit: `3e2812476421c72660ae33a06337b26732f8b3be` — cross-tab account identity consistency.
- PR #322 is open and changes only a CI test command to include bootstrap recovery/streaming regressions. It is not an AI implementation and does not change runtime code.
- This audit is being recorded on a separate documentation branch. Nothing has been committed to `main`.

### Live Supabase read-only inventory

- Project: `ydhcyamtgioyrxfarkwk`, status `ACTIVE_HEALTHY`, PostgreSQL 17.6.
- 13 active Edge Functions were listed; no AI/Sarah gateway is present.
- No AI-related public setting key or AI-named public RPC was found in the metadata query.
- `public.system_settings`: seven keys, all existing business, QR, or reset settings; RLS enabled; inspected table grants were for `postgres` and `service_role`.
- `public.permissions` and `public.role_permissions` are not a single simple registry. The permissions catalog includes granular keys plus older aliases and several test-looking permission codes; `admin_custom_permissions` also contributes per-admin grants/denials.
- Live role mappings differ materially: ADMIN/MANAGER role rows contain only goal permissions; Super Admin rows contain broad operational permissions. Per-admin custom grants/denials are also present. Effective access must be calculated from the actual session and server policy, not inferred from a role label.
- `purchases:manage` exists in the permission catalog and is required by the canonical purchase command dispatcher, but it was absent from the inspected role assignments and custom permission entries. Do not assume a non-Super-Admin can use Purchase Book until their effective permission is proven.
- `ai:use` and `ai:manage` do not exist yet in the permission catalog, role assignments, or custom grants.
- The Vault extension is installed. `authenticated` and `anon` have no `vault` schema usage; `service_role` does. The inspected `vault.create_secret` and `vault.update_secret` functions are SECURITY DEFINER with an empty search_path and are executable by `service_role`. This gives a plausible server-only write path, but it still needs a dedicated Edge Function security review and lifecycle tests. Vault is documented as public alpha, so its operational suitability must be consciously accepted.

No business rows or secret values were queried for this audit.

## 3. Existing architecture to reuse

### Identity and authorization

- `UserSession` carries the active admin identity, role, and permissions.
- `AuthorizationContext` provides `requireAuth()`, `hasPermission()`, `assertPermission()`, and BIN verification.
- `App.tsx` discards stale in-memory identity after a cross-tab account switch and refreshes server permissions when the app returns to the foreground.
- Server-side canonical command processing has its own permission checks. Client UI visibility is not an authorization boundary.

**Requirement:** Every Sarah request, queued item, tool proposal, and execution must be bound to the authenticated admin identity and device/session context. `getAuthorizedAdminContext()` currently reconstructs a client authorization context from the cached `app_auth_session`; Sarah must additionally force-refresh the current server session before executing a tool, then use the canonical Use Case and server-side RPC checks. Re-check permissions at execution time. Never carry queued input across account changes.

### Operational writes

The reviewed `FinalUseCases` mutation surface includes:

- Orders: create, add item, edit notes/items, deliver, cancel, renumber, closed-day guarded operations.
- Customers: create, update, deactivate, debt limit, charger-fee exemption, notes.
- Devices: create, update, deactivate, delete, reorder.
- Finance: payment, FIFO allocation, customer credit, refunds/reversals, credit adjustment.
- Business days: create and close.
- Goals: proposal, create/update, requests, approval/rejection, evaluation.

The class also receives a `RepositoryContext` with transaction coordination and optional purchase repository access. Purchase Book operations live in a separate `src/services/purchaseBook/purchaseBookService.ts` boundary rather than in `FinalUseCases`: `listPurchaseRows`, `savePurchaseCatalog`, `hidePurchaseCatalog`, `createCurrentPurchaseDay`, `createPurchaseWeek`, `addPurchaseOrder`, and `markPurchaseOrderPaid`. The reviewed service checks the active admin ID, rejects owner mismatches, and writes through the shared transaction/repository path. Sarah must call these existing functions only after mapping their permission and server-side ownership/sync contracts; it must not duplicate purchase logic.

### Offline and synchronization

Current IndexedDB database: `OrderSystemOfflineDB`, schema version 5. Reviewed stores include:

- `outbox`
- `syncHistory`
- `syncState`
- `kvStore`
- `backupSnapshots`
- `mutationSnapshots`
- `optimisticOverlays`

The outbox already records command identity, actor admin, device, correlation ID, status, retry count, and dependencies. The sync engine has structured failure classes/stages, retry eligibility, dependency scheduling, and diagnostic journal hooks.

**Do not reuse the operational outbox as Sarah's pre-execution input queue.** A prompt/audio recording is not yet a business command. Sarah needs its own durable queue and lifecycle; after a validated tool invokes an existing use case, that use case creates the one canonical outbox command.

Memory fallback in the current local database is not durable across process termination. Sarah must explicitly fail closed or retain input in a supported durable store when persistent storage is unavailable; it must not claim that a memory-only queued recording is safely retained.

## 4. Capability and permission map

| Capability | Existing evidence | Sarah status |
|---|---|---|
| Orders and order items | `FinalUseCases`: create, add item, combined create, edit notes/items, deliver, cancel, renumber. Existing read helpers: day orders, order search, edit detail | Reuse original use cases; read wrappers must assert `orders:view`. Delivery/cancel need BIN where the existing use case requires it |
| Customers | `FinalUseCases`: create/update/deactivate, debt-limit, charger-fee exemption, notes; read helpers: search/list/detail/orders/financial history | Require `customers:view` for ordinary reads; financial history/balance requires financial-view/finance access. Deactivation is blocked pending shared RBAC repair |
| Devices and pricing | `FinalUseCases`: create/update/deactivate/delete/reorder; read helper: all device types | Require `devices:view` for reads, `devices:manage` for general changes, and additionally `devices:pricing` / `devices:charger-policy` for protected fields |
| Finance and payments | `FinalUseCases`: record payment, FIFO allocation, customer credit, credit consumption, refund/reversal; read helpers: customer financial history, overview, debt/credit filters | Require finance and customer-financial permissions; BIN for protected mutations; confirmation and idempotency guard. Never expose internal projection helpers as write tools |
| Business days | `FinalUseCases`: create/close; read helpers: day list, business day, home dashboard | Reuse existing paths; close day is sensitive and requires explicit confirmation. Read permission mapping must be explicit in Sarah wrappers |
| Goals | `FinalUseCases`: create/update, proposal calculation, request, approve/reject, progress evaluation; separate admin RPC wrappers for cancellation/review | Reuse original paths; resolve `goals:request` vs server `goals:manage` mismatch; never treat progress evaluation as read-only |
| Purchase Book | Purchase repository and isolated live tables exist; no matching methods in the reviewed `FinalUseCases` method list | Do not expose until its real use-case and per-admin ownership path is mapped |
| Backup/restore | Existing backup UI/service and local snapshot stores | Read/diagnostic only initially; no AI restore/reset/delete |
| Sync diagnostics | Existing sync engine, history, journal, classification, Sync Center, outbox and correlation IDs | Reuse existing evidence; safe reads first. Exclude destructive UI actions such as outbox/history deletion and all unsafe command recreation |
| Customer portal/wallets | Separate customer account/session and wallet Edge Function boundaries | Keep isolated; admin Sarah must not inherit customer wallet access |
| Settings/admin management | Existing Settings UI, admin management, and settings permissions | AI provider settings require a dedicated permission boundary |

### Permission proposal (not yet implemented)

The current registry has no dedicated AI permissions. Add explicit permissions only after the full permission registry and server-side permission resolver are reconciled:

- `ai:use` — use Sarah.
- `ai:manage` — configure providers, credentials, model profiles, and export/import integration packages.

Provider management should default to Super Admin only until the dedicated permission is added and enforced server-side. Do not simply reuse `settings:manage` to expose provider credentials or model spend controls to every settings manager.

### Existing authorization gaps that block specific Sarah tools

- **Customer deactivation:** `FinalUseCases.deactivateCustomer()` delegates to `updateCustomer(..., { isActive: false })`. The client use case checks `customers:edit`, and the live canonical dispatcher maps `UPDATE_CUSTOMER` to `customers:edit`; the current live dispatcher contains no `customers:deactivate` check for this command. The separate permission exists in the permission catalog and custom-permission data, but is not enforced on this command path. Do not expose customer deactivation through Sarah until the shared UI/use-case/server contract is corrected and regression-tested.
- **Goal request mismatch:** `recordGoalRequest()` checks only authentication in the client use case, while the canonical dispatcher maps `RECORD_GOAL_REQUEST` to `goals:manage`; the permission catalog separately defines `goals:request`. The UI/read projection has distinct request-view access. Reconcile this mismatch before exposing goal-request tools.
- **Credit consumption and goal proposal methods:** `consumeCustomerCredit()` and `generateCustomerGoalProposal()` do not assert a granular client permission themselves. The server dispatcher maps credit consumption to `finance:credit-adjustment`; proposal generation is read/calculation behavior. Sarah must add explicit permission checks at its tool boundary, and the shared UI/use-case/server contracts should be reconciled before exposure.
- **Read-model authorization:** the reviewed local read helpers (customer search/details/orders/financial history, order/day lists, financial overview, device list) hydrate local maps and generally do not assert permissions themselves. They are safe only behind the app's screen-level gates today. Sarah must wrap them with explicit per-tool permission checks before returning data to the model. Financial history/balances need the stricter finance/customer financial-view gate, not merely customer search access.
- **Purchase Book:** `purchases:manage` exists in the permission catalog and is required by the canonical server dispatcher, but it was absent from the inspected role-permission assignments and custom permission entries. Do not assume ordinary admins can use Purchase Book; verify the actual effective permission for the actor before exposing any purchase tool.

## 5. Target architecture for Gemini-first, provider-neutral Sarah

1. **Sarah UI:** chat and diagnostic UI in the admin app; separate Settings section named `إعدادات الذكاء الاصطناعي`.
2. **Durable Sarah Input Queue:** one ordered queue for text/audio, stable sequence and IDs, actor/device/session binding, correlation ID, source payload reference, state, and result reference.
3. **AI Gateway:** server-side provider access. Validate the Supabase user, active admin mapping, current account session, and `ai:use` / `ai:manage` permissions. Provider keys never reach React, PWA, APK, logs, exports, or model context.
4. **Provider Adapter contract:** normalize requests, tool calls, structured output, errors, timeouts, and declared capabilities. Gemini is the first adapter. Other providers are added by implementing the same contract, not by rewriting Sarah.
5. **Intelligence layer:** intent, entity resolution, clarification, planning, and tool selection using strict schemas. The model proposes structured tool calls; it does not decide authorization.
6. **Command executor:** validate schema and business parameters, re-check the active actor's permissions, request confirmation for sensitive actions, and call the existing application use case. Never write business tables directly.
7. **Read/query adapters:** map existing UI read models/selectors to explicit, permission-aware query tools. Do not create a parallel data model or send full database snapshots to the model.
8. **Diagnostics:** carry one correlation ID across Sarah input → provider request → tool proposal → use case → local transaction/outbox → sync/RPC → reconciliation. Reuse existing sync diagnostic evidence.

### Provider configuration and portability

The Settings page has an in-page section state and menu, currently with personal, general, orders, backup, sync, account, about, and releases sections. A dedicated `ai` section can be added to this pattern, titled `إعدادات الذكاء الاصطناعي`, with bilingual labels. The new section must be gated by a dedicated `ai:manage` permission and server authorization, not just the existing client-side Settings visibility check. The current Settings UI treats Super Admin as a client-side permission bypass; the new provider-management Edge Function must independently validate the real server-side actor and role.

A provider profile should include provider ID, adapter/API format, endpoint/base URL when applicable, model ID, supported capabilities, timeout/retry policy, and bounded generation parameters. Capability flags must be verified against the selected model; audio and tool calling are not assumed to be identical across providers.

The export/import package should contain:

- Provider profile metadata and non-secret connection settings.
- Sarah tool catalog and JSON Schemas.
- System behavior/prompt version and response contracts.
- Permission mapping, safety rules, lifecycle/error contracts, and adapter compatibility/version metadata.

It must **not** contain API keys, Supabase keys, JWTs, BIN/PIN, customer records, chat history, audio recordings, or production data. Credentials are re-entered at the destination. Exporting the integration contract is portable; it does not magically export executable provider adapters or grant a third-party model access to ChargerPointNew. The destination system still needs a compatible adapter and an authenticated tool-execution bridge.

The Settings UI should offer separate actions for exporting the integration package and importing a compatible package. Import must validate schema/version, show a diff/preview, reject unknown or unsafe tool permissions, and never import secrets or automatically grant privileges. A provider switch changes the adapter/profile only; it must not rewrite Sarah's tool schemas, business rules, authorization registry, queue, or command executor.

### Provider secret storage

Do not store provider API keys in `localStorage`, IndexedDB, APK resources, Vite environment variables, or a browser-readable `system_settings` row. The settings UI should submit the key to a server endpoint and receive only masked metadata/status thereafter.

Supabase Vault is present but currently documented as public alpha. The live privilege check found no `vault` schema usage for `authenticated` or `anon`, and confirmed that `service_role` can execute the Vault create/update functions. This supports a server-only design: an authenticated Edge Function validates the caller, then a privileged server-side operation writes/reads the provider secret; the browser receives only masked status. Before adopting it, review the Edge Function authorization path, delete/rotation semantics, secret naming, audit events, and decrypted-view access. If those checks fail, use a separately managed backend secret store rather than weakening database grants.

## 6. Audio and offline constraints

- Preserve original audio bytes; transcription is optional processing, not a replacement for the recording.
- PWA: use a bounded IndexedDB Blob store and handle quota failures explicitly.
- APK: assess a native app-private file store and reliable background worker (WorkManager or an equivalent supported implementation).
- Current package dependencies do not show a dedicated microphone/audio recorder or Capacitor Filesystem plugin.
- Queue order must survive offline periods, app closure, reboot, and network return. No cross-account execution.
- PWA background processing after browser closure is best-effort; do not promise Android-style reliable background work.
- If durable storage fails, report that the recording was not safely queued. Do not silently fall back to volatile memory.

## 7. Protected components and non-negotiable boundaries

- Existing `FinalUseCases`, `AuthorizationContext`, repository transactions, local DB, outbox, scheduler, sync engine, canonical RPC, FIFO allocation, BIN verification, and server-side RBAC remain authoritative.
- Sarah does not issue SQL, call business-table REST writes, bypass server permission checks, or invent business rules.
- No new financial ledger, customer balance, payment, or sync system.
- No deletion of outbox items, command-ID replacement after uncertain execution, duplicate financial retries, or forced dependency bypass.
- No provider secret or sensitive credential in prompts, diagnostics, exports, or client bundles.
- No cross-account reuse of prompts, audio, model responses, cached entities, or queued actions.
- No production migration, Edge Function deployment, or production data write as part of this audit.

## 8. Phase 0 completion and deferred audit boundaries

Phase 0 is complete for the foundation and initial safe tool boundary. The audit established the existing application write path, main read-model surface, live permission catalog/role mappings, current account/session guard, Supabase Edge Function authentication pattern, provider-secret storage constraints, Settings extension point, offline stores, sync diagnostics, backup/purchase/wallet isolation, and the test suites that Sarah must extend.

The following are intentionally deferred to the relevant implementation phase rather than treated as approved capabilities:

1. Complete per-screen permission mapping for notifications, events, customer portal entitlements, wallet management, and every Purchase Book read method.
2. Full end-to-end verification of every existing UI action against every live canonical RPC branch. The live database function definition is authoritative for the findings recorded here; no production command was executed.
3. A local CI baseline run. This audit read the current workflow and test suites but did not run the repository's tests; existing CI checks must be run on the implementation branch before any PR is considered ready.
4. Native microphone/audio persistence and Android background work. No recorder/filesystem plugin or tracked Android project source was found; this requires a dedicated native design and APK build-pipeline review.
5. A production-safe Vault lifecycle proof, including secret rotation/deletion and least-privilege access. No secret was created, read, updated, or deleted during this audit.

No runtime implementation, production migration, Edge Function deployment, or production data write was performed in Phase 0.

## 9. Planned implementation phases and gates

- **Phase 0 — Audit:** complete evidence report, capability map, permission matrix, risks, and test plan. No runtime changes.
- **Phase 1 — Foundation:** provider-neutral contracts, configuration model, dedicated permission design, secure gateway/secret-storage proof, settings UI skeleton. Gemini first.
- **Phase 2 — Durable queue:** ordered, account-bound text/audio queue and persistence tests.
- **Phase 3 — Input and provider:** Gemini text/audio transport, structured responses, timeouts, limits, and provider adapter tests.
- **Phase 4 — Read tools:** permission-aware read tools backed by existing read models.
- **Phase 5 — Operational tools:** low-risk operations through original use cases, with confirmation where required.
- **Phase 6 — Financial/sensitive tools:** only after BIN/confirmation/idempotency regression coverage.
- **Phase 7 — Diagnostic intelligence:** explain sync failures from existing evidence and only offer safe supported repairs.
- **Phase 8 — Native reliability:** APK audio storage and background upload; PWA remains best-effort.
- **Phase 9 — Hardening:** cross-account, permission, offline, audio, provider-switch, export/import, and regression acceptance suite.

No phase advances until its own acceptance tests pass. Build success alone is not operational proof.
