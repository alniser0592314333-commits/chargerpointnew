# Domain Model & Database Foundation Specification (Audited & Corrected)

This document defines the complete architectural domain model and relational database schema for the Order & Customer Management System, built for Supabase (PostgreSQL).

## 1. Architectural Principles
- **Server as Source of Truth**: PostgreSQL enforces relational integrity, constraints, and audit trails.
- **Append-Only Financial Ledger**: Immutable financial events enforced by database-level BEFORE UPDATE/DELETE triggers.
- **Monetary Representation**: Integer minor units only (`100 = 1.00₪`). Floating-point numbers are strictly forbidden for currency.
- **Snapshot Isolation**: Order items capture immutable snapshots of prices, names, icons, and charger fee policies at creation time.
- **Per-Item Financial Recognition & Credit Semantics**: Financial recognition occurs strictly once per item upon transition to `delivered`. **Customer credit is consumed only when a financial recognition event occurs**, never at customer or order creation.
- **Idempotency**: All sensitive/financial commands carry a unique `command_id` registered in `processed_commands`.
- **Non-Destructive Cascades**: Foreign keys such as `order_items.order_id` use `ON DELETE RESTRICT` to prevent destructive deletion of historical financial/audit data.

---

## 2. Database Schema & Security Highlights

### 2.1. Financial Ledger Immutability
`financial_ledger` is protected by database triggers (`prevent_ledger_modification`) that raise an exception on any `UPDATE` or `DELETE` attempt. Corrections require inserting a new ledger event linked via `reference_id`.

### 2.2. Optimistic Concurrency Control
All mutable entities include a `version` column. Application-layer updates must enforce:
```sql
UPDATE ... WHERE id = :id AND version = :expected_version;
```
If zero rows are updated, a concurrency conflict is detected and handled.

### 2.3. Security & Cryptography
- **Passwords & BINs**: Stored strictly as cryptographic hashes (never plain text). Never logged in application or audit logs.
- **QR Tokens**: Cryptographically random non-guessable tokens. Raw IDs are never exposed; database stores secure hashes or handles verification via server RPC.
- **Row Level Security (RLS)**: Enabled across all tables to enforce security boundaries.
