# Domain State Transitions Reference (`docs/domain-state-transitions.md`)

## 1. Order Status Transitions
- `pending` ➔ `charging`, `cancelled`
- `charging` ➔ `delivered`, `cancelled`
- `delivered` ➔ `cancelled` only through the audited cancellation path that reverses recognized financial charges; direct reopening to `pending` or `charging` is forbidden. New items may be added, which starts those new items in `charging` without reverting already-delivered items.
- `cancelled` ➔ (Terminal state)

## 2. Order Item Status Transitions
- `charging` ➔ `delivered`, `cancelled`
- `delivered` ➔ (Terminal state; recognized financially)
- `cancelled` ➔ (Terminal state)

## 3. Forbidden Transitions
- `delivered` ➔ `pending` or `charging` (Direct reversion of delivered status is prohibited; corrections must be handled via reversal ledger events).
- `cancelled` ➔ `charging` or `delivered` (Cancelled items cannot be reactivated normally).
