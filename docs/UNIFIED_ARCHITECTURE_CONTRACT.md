# Unified Application / Sync / Database Contract

## Authority
The application domain and use-case layer define business meaning. The local database is the offline read/write boundary. Supabase is the authoritative remote commit boundary. Historical SQL migrations are not the target architecture.

## One business operation, one command
Canonical write operations are represented by one command type and one server transaction:
- OPEN_DAY / CLOSE_DAY
- CREATE_CUSTOMER / UPDATE_CUSTOMER
- CREATE_DEVICE_TYPE / UPDATE_DEVICE_TYPE / DELETE_DEVICE_TYPE
- CREATE_ORDER / UPDATE_ORDER / CANCEL_ORDER
- ADD_ORDER_ITEM / DELIVER_ORDER_ITEM / CANCEL_ORDER_ITEM
- CREATE_PAYMENT / POST_PAYMENT
- CREATE_CUSTOMER_CREDIT / CONSUME_CUSTOMER_CREDIT / CREATE_REFUND
- CREATE_GOAL / UPDATE_GOAL_CONFIG / UPDATE_GOAL_PROGRESS
- RECORD_GOAL_REQUEST / APPROVE_GOAL_REQUEST / REJECT_GOAL_REQUEST

UI code calls application use cases. Repositories persist local state and create the outbox entry; they must not create a second independent remote-write path.

## Sync rules
1. Reads use the local read model during normal operation.
2. Writes are local-first.
3. Every remote write has one stable UUID command id.
4. The command id is the idempotency key and must never be replaced merely because a previous attempt was processed.
5. Dependencies are explicit and are scheduled before dispatch.
6. The server transaction is authoritative for business side effects.
7. A successful RPC must return success=true; merely receiving an HTTP/RPC response is not success.
8. Remote change-log rows contain the full canonical row payload and authoritative version.
9. Pull never overwrites a still-pending local mutation.
10. Generation reset clears stale remote read-model state while preserving pending local aggregates, outbox records, and sync history.
11. After pushes, a final authoritative pull reconciles the server result before the cycle is considered complete.
12. Retryable transport/server failures remain in the outbox. Permanent validation/authorization/conflict failures are surfaced without infinite retry loops.

## Financial rules
- Currency is integer minor units.
- The application default charger fee is 50 minor units.
- Order-item price is snapshotted when the item is created; delivery does not recalculate historical price from the current device price.
- Delivery changes operational status to DELIVERED and financial status to RECOGNIZED in the same server transaction that inserts the charge ledger row.
- The charge ledger amount is negative; payments/credits are positive.
- An order-item charge is unique per item.
- Cancelling an already recognized item creates a reversal and marks financial status REVERSED.
- Customer balance is the sum of authoritative ledger rows plus projections from still-pending local financial mutations.

## Important fixes made
- Removed the duplicate online customer-credit mutation path. Customer credit now goes through the same local-first command/outbox path online and offline.
- Fixed createCustomerCredit using an undefined commandId.
- Fixed device updates mutating the live repository object before transaction rollback snapshots were captured.
- Fixed cancelled order-item versioning so the version increments on mutation.
- Made the sync transport reject RPC responses that do not explicitly contain success=true.
- Propagated change-log versions into the client reconciliation layer.
- Fixed sparse order-item delivery deltas being ignored because they looked like version 1 updates.
- Added defensive delivery projection for recognized financial status.
- Fixed sparse ledger change reconciliation by deriving customer identity from the related order/item and normalizing canonical charge sign.
- Prevented remote hydration from erasing pending local work.
- Prevented partial remote hydration from clearing a healthy local model.
- Added a final authoritative pull after command pushes.
- Added the authoritative database baseline in supabase/final_schema.sql.

## Runtime verification boundary
The code contract and SQL are statically aligned, but the live project cannot be inspected from this environment. Live RPC deployment, PostgREST schema cache state, RLS execution, and actual PostgreSQL transaction behavior must be verified when the baseline is applied to the disposable online database.