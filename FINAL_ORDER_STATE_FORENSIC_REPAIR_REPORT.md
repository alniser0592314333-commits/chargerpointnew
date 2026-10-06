# Final Order / OrderItem State-Management Forensic Repair Report

## Scope

A source-level forensic review was performed over the supplied `STABLE-v3-AUDITED-FINAL` project, concentrating on the complete Order / OrderItem lifecycle and the delivery/cancellation financial contract:

- order creation and item creation
- device-type pricing snapshots
- local repository writes
- transaction/outbox creation
- dependency scheduling
- delivery of one item
- delivery of an entire order
- delivery of all orders in a day
- order cancellation
- item cancellation
- server-side canonical RPC behavior
- admin identity mapping
- expected-version/concurrency contract
- financial ledger recognition/reversal
- payment allocation locking
- change-log/delta hydration
- stale delta handling
- local failure rollback
- restart persistence of mutation snapshots

The review was iterative: after each repair pass, source-level searches and TypeScript transpilation checks were repeated.

## Critical defects found and repaired

### 1. Client was authoritatively changing Order.status after delivery

The delivery UI paths in `dayOrdersStore.ts` were directly setting the parent Order to `delivered`, including batch delivery paths.

This was the previously proven cause of parent/child divergence when an item delivery failed.

**Repair:** all production direct writes to an existing `Order.status` were removed. UI status is now calculated as a projection from canonical `OrderItem.status`; persistent Order.status is server-owned.

### 2. Delivery was locally creating the financial charge before the server committed it

`deliverOrderItem()` was writing both:
- `OrderItem.status = delivered`
- `financialStatus = RECOGNIZED`
- a negative `ORDER_ITEM_CHARGE` ledger row

before the canonical server command was executed.

That could create a local financial effect even when the server later rejected the command.

**Repair:** delivery now performs only the local optimistic operational item transition and queues the canonical command. The financial ledger entry and financial recognition are created only by the server transaction.

### 3. Cancellation was locally creating financial reversals

Both order and item cancellation paths were appending local `REVERSAL` ledger entries before server acceptance.

**Repair:** local cancellation now changes only the optimistic item operational state and queues the command. Reversal ledger entries are server-authoritative.

### 4. Cancelled delivered items were inconsistent between client and server rules

The client rejected delivered → cancelled while the intended financial architecture required an append-only reversal path for recognized charges.

**Repair:** the domain transition now allows `delivered → cancelled`. The server migration implements an atomic reversal for recognized items before marking them cancelled.

### 5. Order projection was not deterministic across all mixed item states

The client had several independent parent-status calculations.

**Repair:** `calculateOrderProjection()` was added and the UI now uses the canonical item-status matrix:

- zero items → pending
- active charging → charging
- charging + delivered → charging
- all active delivered → delivered
- delivered + cancelled → delivered
- charging + cancelled → charging
- all cancelled → cancelled

Cancelled items are inactive.

### 6. Remote delta hydration could overwrite state with stale versions

`applyRemoteChange()` accepted incoming Order/OrderItem versions without comparing them to the current local version.

**Repair:** UPDATE/TOMBSTONE hydration now ignores an incoming entity version that is not newer than the current local version. INSERT remains authoritative so server-created records can replace local optimistic create shells with authoritative server data.

### 7. OrderItem dependency checks did not verify existing local order-item records

The scheduler checked business days, orders, customers and devices, but not the `orderItems` store when resolving a delivery/cancellation dependency.

**Repair:** `orderItems` is now included in dependency existence checks.

### 8. Mutation aggregate identity was wrong for OrderItem commands

Delivery/cancellation commands could use the item UUID as the aggregate ID, separating mutations that actually belong to the same Order aggregate.

**Repair:**

- ADD_ORDER_ITEM → `order:<orderId>`
- DELIVER_ORDER_ITEM → `order:<orderId>`
- CANCEL_ORDER_ITEM → `order:<orderId>`
- CANCEL_ORDER → `order:<orderId>`
- payment/financial customer mutations → `customer:<customerId>`
- device mutations → `deviceType:<deviceTypeId>`

### 9. Expected-version was being discarded by the public Supabase wrapper

`execute_sync_command()` received `p_expected_version` but did not pass it to the canonical function.

**Repair:** migration `00115_final_order_state_financial_concurrency_contract.sql` injects `expectedVersion` into the canonical payload.

### 10. Canonical RPC did not enforce the expected version in the final 00113 implementation

The variable existed but the final implementation did not consistently enforce it.

**Repair:** migration 00115 enforces `VERSION_CONFLICT` checks for Order/OrderItem mutation commands.

### 11. Admin identity could map auth.users.id directly into admins.id

The final 00113 baseline attempted to resolve the actor using `admins.id = auth.uid()` even though the schema uses `admins.auth_user_id` for the Supabase Auth identity.

**Repair:** migration 00115 resolves:

`auth.uid() → admins.auth_user_id → admins.id`

with a safe fallback for an explicitly supplied internal admin ID.

### 12. Server-side Order.status ownership was not enforced

`UPDATE_ORDER` could mutate `orders.status` directly.

**Repair:** migration 00115 rejects attempts to mutate Order.status through UPDATE_ORDER. Status changes are now controlled by the canonical lifecycle commands.

### 13. ADD_ORDER_ITEM did not update the server Order projection

An Order could remain `pending` while it already contained charging items.

**Repair:** successful server-side ADD_ORDER_ITEM changes the parent Order to `charging` and records the authoritative Order change.

Adding an item to an already delivered Order correctly returns it to `charging` until the new item is delivered.

### 14. Server delivery parent-state calculation was too narrow

The previous delivery implementation only changed the Order to delivered when no non-delivered/non-cancelled items remained.

**Repair:** the canonical server projection is now recalculated after delivery:

- charging exists → charging
- active items all delivered → delivered
- no active items → cancelled

The calculation is performed inside the same database transaction as item recognition and ledger insertion.

### 15. Financial concurrency was not serialized

The baseline RPC relied on optimistic versions only and had no deterministic customer-level serialization.

**Repair:** migration 00115 introduces a consistent lock hierarchy for financial mutations:

`customer → order/order-item`

Payment operations lock the customer first and then the recognized items in deterministic UUID order. Delivery/cancellation follow the same customer-first hierarchy.

### 16. Financial operations could race across devices

Delivery/payment/payment allocation operations could previously overlap on the same customer without a shared database lock.

**Repair:** the canonical server transaction now locks the customer row before financial mutation and locks affected OrderItem rows deterministically for payment allocation.

### 17. Mutation rollback data was not persisted in the supplied code

There was no persistent command-scoped mutation snapshot mechanism in the supplied artifact.

**Repair:** IndexedDB version 5 now contains `mutationSnapshots` with:

- commandId
- creation time
- affected records
- existence state
- pre-mutation data

Delivery, cancellation, Order notes updates, Order creation, and OrderItem creation paths now capture the relevant rollback state.

### 18. Rollback could overwrite a newer authoritative state

A naïve snapshot restoration would be unsafe after a newer server delta arrived.

**Repair:** rollback only restores a snapshot record when the current local entity has not advanced beyond the snapshot version. A newer authoritative version is preserved.

### 19. TIMEOUT_UNKNOWN command identity is preserved

The existing sync flow retains the same outbox command ID for network/timeout retry instead of generating a second remote command.

This was preserved.

### 20. Server financial reversal is append-only

Recognized cancellation now creates a positive `REVERSAL` ledger entry referencing the original charge, rather than mutating/deleting historical ledger rows.

This preserves ledger immutability and returns the reversed amount to the customer's net credit/balance calculation.

## Final command contracts

### Delivery

`DELIVER_ORDER_ITEM`

Payload includes:

- `itemId`
- `orderItemId`
- `orderId`
- `bin`
- expected item version through the outbox contract

Server transaction:

1. resolve authenticated admin
2. lock customer
3. lock Order + OrderItem
4. verify expected version
5. verify item/order are deliverable
6. verify debt limit
7. mark item delivered + recognized
8. append negative ORDER_ITEM_CHARGE
9. recalculate Order.status
10. append change-log entries
11. record processed command
12. commit atomically

### Item cancellation

`CANCEL_ORDER_ITEM`

- charging → cancelled with no financial effect
- delivered + recognized → reversal ledger entry + cancelled/reversed item
- already cancelled → idempotent semantic result
- invalid states → rejected

The parent Order projection is recalculated in the same transaction.

### Order cancellation

`CANCEL_ORDER`

- allowed only while parent Order is pending/charging
- customer and Order are locked
- recognized item charges are reversed exactly once
- all non-cancelled items become cancelled
- parent Order becomes cancelled
- all authoritative changes are recorded in one transaction

### Order update

`UPDATE_ORDER`

May update notes, but cannot authoritatively mutate `Order.status`.

## Source-level verification performed

### TypeScript syntax/transpile check

All `.ts` and `.tsx` files were passed through the TypeScript compiler's transpilation parser after the repair pass.

**Result: PASS**

### Production Order.status assignment audit

No direct production assignments of the form `order.status = ...` remain in application/use-case/UI code.

Remaining references are read-only checks/projections.

**Result: PASS**

### Production operationalStatus assignment audit

No production writes to `operationalStatus` remain.

**Result: PASS**

### Delivery/cancellation local ledger audit

No local `ledgerRepo.append()` remains inside the delivery/cancellation operational paths.

**Result: PASS**

### Migration structural checks

Migration 00115 contains:

- canonical RPC replacement
- wrapper replacement
- auth-user → admin identity resolution
- customer locks
- Order/OrderItem locks
- deterministic payment-item locking
- expected-version enforcement
- server-owned Order.status
- append-only reversal
- schema migration registration

**Result: PASS by source inspection**

## Important deployment state

`00115_final_order_state_financial_concurrency_contract.sql` is included in the corrected project.

It has NOT been claimed as live-applied to Supabase from this environment. The supplied project did not contain a usable live database credential/session for independently applying and verifying the migration.

Therefore the corrected artifact is **source-ready**, but live PostgreSQL behavior still requires the migration to be applied and then verified against the actual Supabase database.

## Build limitation

A full `npm ci` could not complete in this environment because dependency installation timed out and the project has no installed `node_modules` tree.

The TypeScript source was therefore validated with the globally available TypeScript compiler's transpilation parser rather than falsely claiming a full Vite production build.

## Final source verdict

**SOURCE-LEVEL REPAIR: COMPLETE**

The critical delivery/cancellation state, financial recognition/reversal, parent Order projection, dependency, identity, optimistic-version, rollback, delta, and server-concurrency defects identified during the forensic review were repaired in the supplied artifact.

The corrected project is packaged separately for the next deployment/verification step.
