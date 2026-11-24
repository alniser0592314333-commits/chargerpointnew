# Sarah AI — Phase 0 Architecture Audit (Initial Evidence Baseline)

**Date:** 2026-11-24  
**Base:** `main` at `3e2812476421c72660ae33a06337b26732f8b3be`  
**Status:** Initial read-only evidence inventory. Phase 0 is not yet declared complete.  
**Safety:** No production database writes, migrations, Edge Function deployments, or changes to `main` were made.

## 1. Executive findings

1. `@google/genai@^2.4.0` is already a dependency in `package.json`, but dependency presence is not evidence of a working Gemini integration. No Sarah page/service or AI Gateway was found in the reviewed application entry points and known service paths.
2. The live Supabase project currently has 13 active Edge Functions; none is an AI/Sarah gateway. `supabase/config.toml` also has no AI function entry.
3. The live `public.system_settings` table has seven existing business/QR/reset settings and no AI configuration key. It is RLS-enabled; the inspected table grants were limited to `postgres` and `service_role`, not browser roles.
4. The Settings screen already uses a section-based menu and supports Arabic/English, RTL/LTR, and light/dark themes. A dedicated `ai` section can be added without redesigning the whole Settings page.
5. The app has a canonical local-first command path: `FinalUseCases` → repository/transaction context → local persistence/optimistic overlay/outbox → sync engine → canonical Supabase RPC. Sarah must call this path for mutations and must not write business tables directly.
6. The existing `FinalUseCases` class exposes operational mutation methods, but its public method list does not provide a complete read/query API. Read operations need a separate evidence-based mapping to existing read models/selectors before Sarah tools are finalized.
7. The current IndexedDB schema has durable operational/sync stores, but no Sarah input queue or audio Blob store. Its memory fallback is not suitable for durable AI input retention.
8. The installed Capacitor dependencies do not currently include an audio recorder or filesystem plugin. Native audio persistence/background upload therefore needs a separate Android capability assessment.
9. The database has the Supabase Vault extension installed (version 0.3.1), but the extension is documented as public alpha. Its current grants do not provide an obvious browser-safe write path. It must not be treated as ready for direct frontend secret storage.

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
- `public.permissions` and `public.role_permissions` are not a single simple registry. The role-permission table contains legacy aliases such as `orders:read/write` and `finances:read/write` alongside newer granular keys. `admin_custom_permissions` also contributes per-admin grants/denials.
- Existing role mappings differ materially: ADMIN/MANAGER role rows contain goal permissions; Super Admin rows contain broad operational permissions. Effective access must be calculated from the actual session and server policy, not inferred from a role label.
- The Vault extension is installed. The inspected `vault` grants show decrypted-secret reads available to `service_role` and `postgres`, but no direct browser access. Vault is not assumed to be the final provider-key storage design until its write path, grants, lifecycle, and alpha status are reviewed.

No business rows or secret values were queried for this audit.

## 3. Existing architecture to reuse

### Identity and authorization

- `UserSession` carries the active admin identity, role, and permissions.
- `AuthorizationContext` provides `requireAuth()`, `hasPermission()`, `assertPermission()`, and BIN verification.
- `App.tsx` discards stale in-memory identity after a cross-tab account switch and refreshes server permissions when the app returns to the foreground.
- Server-side canonical command processing has its own permission checks. Client UI visibility is not an authorization boundary.

**Requirement:** Every Sarah request, queued item, tool proposal, and execution must be bound to the authenticated admin identity and device/session context. Re-check permissions at execution time. Never carry queued input across account changes.

### Operational writes

The reviewed `FinalUseCases` mutation surface includes:

- Orders: create, add item, edit notes/items, deliver, cancel, renumber, closed-day guarded operations.
- Customers: create, update, deactivate, debt limit, charger-fee exemption, notes.
- Devices: create, update, deactivate, delete, reorder.
- Finance: payment, FIFO allocation, customer credit, refunds/reversals, credit adjustment.
- Business days: create and close.
- Goals: proposal, create/update, requests, approval/rejection, evaluation.

The class also receives a `RepositoryContext` with transaction coordination and optional purchase repository access. However, no purchase-book mutation methods appeared in the extracted public method list. Purchases and other non-core modules must be traced to their actual service/use-case boundaries before Sarah receives tools for them.

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

## 4. Capability and permission map — initial

| Capability | Existing evidence | Sarah status |
|---|---|---|
| Orders and order items | Operational mutation methods and granular permissions exist | Reuse existing use cases; query/read selectors still need mapping |
| Customers | Mutation methods and granular permissions exist | Reuse existing use cases; minimize customer data sent to the model |
| Devices and pricing | Device mutation methods and permissions exist | Reuse existing use cases |
| Finance and payments | Payment, FIFO, credit, refund/reversal methods exist; BIN/server guards exist | Sensitive actions require explicit confirmation and original BIN flow |
| Business days | Create/close methods exist | Closing a day is sensitive; require explicit confirmation |
| Goals | Goal methods and permissions exist | Reuse actual goal use cases and server checks |
| Purchase Book | Purchase repository and isolated live tables exist; no matching methods in the reviewed `FinalUseCases` method list | Do not expose until its real use-case and per-admin ownership path is mapped |
| Backup/restore | Existing backup UI/service and local snapshot stores | Read/diagnostic only initially; no AI restore/reset/delete |
| Sync diagnostics | Existing sync engine, history, journal, classification, and Sync Center | Reuse existing evidence; no outbox deletion or unsafe command recreation |
| Customer portal/wallets | Separate customer account/session and wallet Edge Function boundaries | Keep isolated; admin Sarah must not inherit customer wallet access |
| Settings/admin management | Existing Settings UI, admin management, and settings permissions | AI provider settings require a dedicated permission boundary |

### Permission proposal (not yet implemented)

The current registry has no dedicated AI permissions. Add explicit permissions only after the full permission registry and server-side permission resolver are reconciled:

- `ai:use` — use Sarah.
- `ai:manage` — configure providers, credentials, model profiles, and export/import integration packages.

Provider management should default to Super Admin only until the dedicated permission is added and enforced server-side. Do not simply reuse `settings:manage` to expose provider credentials or model spend controls to every settings manager.

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

A provider profile should include provider ID, adapter/API format, endpoint/base URL when applicable, model ID, supported capabilities, timeout/retry policy, and bounded generation parameters. Capability flags must be verified against the selected model; audio and tool calling are not assumed to be identical across providers.

The export/import package should contain:

- Provider profile metadata and non-secret connection settings.
- Sarah tool catalog and JSON Schemas.
- System behavior/prompt version and response contracts.
- Permission mapping, safety rules, lifecycle/error contracts, and adapter compatibility/version metadata.

It must **not** contain API keys, Supabase keys, JWTs, BIN/PIN, customer records, chat history, audio recordings, or production data. Credentials are re-entered at the destination. Exporting the integration contract is portable; it does not magically export executable provider adapters or grant a third-party model access to ChargerPointNew. The destination system still needs a compatible adapter and an authenticated tool-execution bridge.

### Provider secret storage

Do not store provider API keys in `localStorage`, IndexedDB, APK resources, Vite environment variables, or a browser-readable `system_settings` row. The settings UI should submit the key to a server endpoint and receive only masked metadata/status thereafter.

Supabase Vault is present but currently documented as public alpha. Before choosing it, verify a least-privilege server-only write/read/delete path and ensure decrypted views cannot be queried by browser roles. If that cannot be proven, use a separately managed backend secret store rather than weakening database grants.

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

## 8. Phase 0 work still required before implementation

This document is an initial evidence baseline, not a claim that every screen and server path has been audited. Before Phase 1 code:

1. Trace the composition/instantiation path for `FinalUseCases` and map how current UI actions reach it.
2. Map read-only selectors/read models for orders, customers, devices, days, finance, goals, purchases, notifications, and wallet entitlements.
3. Inspect the complete permission resolver and canonical RPC branches, including legacy permission aliases and current effective-permission behavior.
4. Inspect backup/restore and Purchase Book service boundaries and account isolation.
5. Review Edge Function authentication/session validation patterns and establish a server-only provider-config/secret-storage proof.
6. Assess native microphone/audio/file capabilities and PWA quota behavior.
7. Establish a baseline for the relevant test suites and identify existing unrelated failures before adding Sarah tests.

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
