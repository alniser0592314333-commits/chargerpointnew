# Second-Pass Forensic Audit — Order & Customer Management System

## Scope

This was a second, independent audit of `order-customer-management-system-STABLE-v2.zip`.
The review traced the application from UI handlers/use cases through IndexedDB, outbox/scheduler, sync transport, Supabase RPC contracts, PostgreSQL migrations, backup/restore, and business/financial invariants.

The visual design was intentionally not redesigned.

## High-severity findings fixed

### 1. Unsupported sync command types
The client could enqueue business mutations that the canonical server RPC did not implement:
- `FINANCIAL_LEDGER`
- legacy `PAYMENT`
- goal mutations (`CREATE_GOAL`, `UPDATE_GOAL_CONFIG`, `RECORD_GOAL_REQUEST`, `APPROVE_GOAL_REQUEST`, `REJECT_GOAL_REQUEST`)
- direct credit/refund mutations.

**Fix:** ledger rows are now side-effects of explicit authoritative commands. Payment synchronization is owned by `CREATE_PAYMENT`. Direct financial operations now use explicit canonical commands. Goal commands were added to the canonical RPC and scheduler/aggregate mapping.

A static command-contract scan now reports **0 application command types missing from the canonical RPC**.

### 2. IndexedDB transactions contained `await`
`reorderDeviceTypes`, `recordPayment`, remote delta pull, and the sync bridge could execute asynchronous work inside a live IndexedDB transaction. IndexedDB transactions may auto-commit while JavaScript is awaiting, causing intermittent `TransactionInactiveError`/partial-operation behavior.

**Fix:** those transaction callbacks are synchronous. All required asynchronous reads are completed before entering the transaction.

A static scan now reports **0 async callbacks passed to `runInTransaction`/`runTransaction` in the audited paths**.

### 3. Local rollback was shallow
Rollback snapshots copied Maps but retained references to the same mutable entity objects. A failed mutation after an object had already been modified could therefore leave the in-memory application state mutated even when IndexedDB rolled back.

**Fix:** transaction snapshots now use deep cloning and restore deep-cloned entities.

### 4. Online replacement could fail on Device Type restore
The replacement RPC inserted device types without the required canonical bilingual columns `name_ar` and `name_en`, despite the canonical schema requiring them.

**Fix:** replacement now writes `name`, `name_ar`, `name_en`, `arabic_name`, `charger_fee_enabled`, `charger_fee_applicable`, and the other canonical fields.

### 5. Online replacement omitted goals / goal requests
Backup data included goals and goal requests, but Local → Online replacement did not reconstruct them.

**Fix:** replacement now deletes/rebuilds goals and goal requests in FK-safe order and validates their references.

### 6. Restore could restart local order reservations at 1
Online backups intentionally do not depend on local reservation metadata. After an online-to-local restore, the local reservation table could be empty while orders already existed.

**Fix:** reservation allocation now derives the next safe range from existing orders when no reservation metadata exists.

### 7. Item edit/cancellation could enqueue the wrong operation
Removing an item during order editing used the generic item repository save path, whose outer implementation could classify the operation as `ADD_ORDER_ITEM`.

**Fix:** the operation now atomically writes the cancelled item, any required reversal, and a `CANCEL_ORDER_ITEM` command.

### 8. Payment repository exposed a legacy `PAYMENT` command
The payment repository could enqueue `PAYMENT`, while the authoritative server contract uses `CREATE_PAYMENT`.

**Fix:** the generic repository save no longer emits the legacy command. `recordPayment` is the canonical payment mutation.

### 9. Goal repositories were declared but not wired into the production repository context
`FinalUseCases` had goal/goal-request contracts, but the live `dayOrdersStore` repository context did not provide them, making those use cases fail with `Goal repository not configured`.

**Fix:** goals and goal requests are now hydrated from IndexedDB, included in transaction rollback snapshots, and wired into both transactional and outer repository contexts.

The Goals UI itself remains visually unchanged; it was already a display-only page and no new UI design was invented during this audit.

### 10. Device reorder payload used the wrong charger applicability value
Some reorder/shift commands sent `chargerFeeEnabled` as `chargerFeeApplicable`, which can silently change pricing semantics.

**Fix:** payloads now preserve the actual `chargerFeeApplicable` value, falling back to enabled only when the field is unavailable.

### 11. Local validation allowed values PostgreSQL rejects
Customer debt limits and device prices/sort order were not consistently validated as non-negative integer minor-unit values before local persistence.

**Fix:** authoritative use cases now reject invalid values before writing local state/outbox commands.

## Database delivery strategy

A new migration was added:

`supabase/migrations/00113_second_pass_canonical_contract_hardening.sql`

This is important because changing an already-applied migration file is not sufficient for an existing Supabase project. Migration `00113` re-applies the corrected canonical RPC definitions to the live database and updates the charger-fee setting to the canonical 50 minor units (0.50 ILS).

## Backup / restore audit

The audit verified the intended backup model contains:
- customers
- business days
- device types
- orders
- order items
- payments
- payment allocations
- financial ledger
- goals
- goal requests
- QR tokens
- local order-number reservations
- outbox
- sync history
- sync state

Security-sensitive fields are sanitized before snapshots.

Restore marks the local sync state for reconciliation instead of blindly replaying stale server commands.

## Pricing audit

The canonical server calculation is:

`final charge = base price + applicable charger fee - authorized discount`

The charger fee is controlled by the canonical `default_charger_fee_minor` system setting and defaults to 50 minor units.

Customer charger-fee exemption and whether the item has a charger are both respected.

The server remains authoritative for the final financial mutation.

## Command identity audit

Command IDs and aggregate/entity IDs are now kept conceptually separate. In particular, delivery creates a fresh `DELIVER_ORDER_ITEM` command ID instead of reusing the order-item ID, preventing an IndexedDB outbox primary-key collision with `ADD_ORDER_ITEM`.

## Static verification performed

- TypeScript transpilation/parsing of all directly modified TypeScript files: passed.
- Canonical command-type cross-check: 23 client command types, 0 missing server cases.
- Scan for asynchronous IndexedDB transaction callbacks in audited application/sync paths: 0 remaining.
- Scan for legacy `FINANCIAL_LEDGER` and `PAYMENT` command emission: 0 remaining.
- SQL dollar-quote / block-balance sanity checks: passed for modified migration functions.

## What could not be executed in this environment

A full `npm test` / `npm run build` execution could not be completed because the supplied ZIP does not contain `node_modules` and `npm ci --ignore-scripts --prefer-offline` exceeded the execution time available here. `tsc --noEmit` also stops immediately because the missing installed dependency tree does not provide `vite/client`.

Therefore this audit does **not** claim that a real browser session or a live Supabase project was executed from this environment.

## Final state

The project has been patched for the second-pass findings and includes a new live-database migration (`00113`) so an already-migrated Supabase project can receive the corrected RPC contracts.

The UI styling was intentionally preserved.
