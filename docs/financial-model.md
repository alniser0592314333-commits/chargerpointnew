# Financial Model Reference (`docs/financial-model.md`)

## 1. Financial Recognition
- Each order item is financially recognized **exactly once** upon transition to `delivered`.
- Charging items do not contribute to recognized debt or financial obligation.

## 2. Payments & FIFO Allocations
- Payments are atomic and immutable.
- Allocations map payments to outstanding recognized orders using FIFO based on `internal_sequence`.

## 3. Customer Credit
- Generated when payments exceed outstanding recognized balances.
- Consumed automatically during financial recognition (`CREDIT_USED`).

## 4. Reversals & Refunds
- Corrective actions append new ledger events (`REFUND`, `REVERSAL`, `CORRECTION`) rather than modifying historical ledger entries.
