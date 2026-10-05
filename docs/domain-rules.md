# Official Business Rules Reference (`docs/domain-rules.md`)

This document defines the canonical business rules for the Order & Customer Management System.

## 1. General Principles
- **Monetary Calculations**: Strictly integer minor units (`100 = 1.00₪`). Rounding uses **Round Half Up**.
- **Server as Source of Truth**: Business invariants and calculations are enforced at the domain/application layer.
- **Idempotency**: All sensitive commands carry a `command_id` checked against `processed_commands` with strict payload verification (`IdempotencyConflictError`).
- **Optimistic Concurrency**: Entities track `version`. Updates require version matching.

---

## 2. Order & Item Lifecycle Rules
- **Canonical Order Statuses**: `pending`, `charging`, `delivered`, `cancelled`.
- **Canonical Item Statuses**: `charging`, `delivered`, `cancelled`.
- **Debt Limit**: Checked at **Order Creation**. If balance < limit, regular admins are blocked; Super Admins can override.
- **Snapshots**: Created at item insertion (Device name, icon, base price, charger fee enabled, customer exemption, charger fee, has charger, unit price, total price). Historical snapshots never mutate.
- **Financial Recognition**: Occurs strictly once per item when transitioning `charging -> delivered`.

---

## 3. Charger Fee Formula
Base price + Surcharge where:
- Surcharge = `0.50₪` (50 minor units) if:
  1. Device type charger fee is enabled.
  2. Customer is NOT exempt.
  3. `has_charger = false`.
- Otherwise surcharge = 0.

---

## 4. Financial & Payment Rules
- **Append-Only Ledger**: `financial_ledger` is immutable.
- **FIFO Allocation**: Payments and credits are allocated to the oldest outstanding recognized orders first using server-side immutable sequence.
- **Customer Credit**: Consumed only during financial recognition events, never at creation.
- **Business Day Closing**: At 6:00 PM, non-cancelled charging items are auto-delivered and recognized. Closed days block regular admin edits; Super Admins can perform temporary edits without reopening the day.
- **Sensitive Operations**: Require Authorization context + valid BIN verification (`BinRequiredError`).
