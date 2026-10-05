# FINAL PRODUCT BASELINE

## 1. OBJECTIVE
This document is the authoritative project reference recording the current verified state of the application. All future development work MUST treat this baseline as the existing system and MUST NOT silently redesign, replace, bypass, or regress verified architecture or business rules.

---

## 2. CANONICAL VERIFIED BEHAVIOR

### Authentication
- **First Super Admin Setup**: Collects full name, username, email, password, BIN confirmation, and requires 6-digit email OTP verification.
- **Subnormal Login**: Standard login flow for existing installations with server-authoritative authentication and session validation via Supabase Auth.

### Super Admin
- Absolute top-level system authority with automatic `*` permissions.
- Cannot be restricted by ordinary admins and cannot be deleted by subordinate admins.
- Can create, delete, activate, deactivate, and manage subordinate admins, passwords, and BINs.

### Ordinary Admins & Permissions
- Explicit, database-backed permissions enforced server-side via `get_effective_permissions` and `execute_sync_command`.
- Cannot elevate privileges or manage other admins without explicit authorization.

### BIN Security
- High-privilege verification factor required for sensitive operations (Super Admin login, payments, financial recognition).
- Verified server-authoritatively via `rpcVerifyAdminBinWithTracking`.
- Never stored in plaintext in local storage or backup snapshots.

### Customers
- Stable immutable IDs.
- Supports multiple orders and multiple same-day orders.
- Tracks balance, credit, debt, individual debt limits, and charger-fee exemptions.
- Strict `ACTIVE → DELETED` lifecycle preserving historical audit trails while blocking new transactions.

### Orders & Numbering
- Stable immutable Order IDs and immutable `displayNumber` operational identifiers.
- Assigned once per business day; never changes through edits, delivery, payment, sync, backup, or restore.
- **Order Numbering Architecture**: Server-reserved ranges (default size 20), lazy on-demand reservation (zero reservation on startup, login, day open, or orders page view), offline consumption, multi-device collision prevention, and backup/restore preservation. No count+1, max+1, timestamps, or array indices.

### Order Items / Devices & Financial States
- Stable IDs referencing Device Types.
- **Independence of States**: Operational (`charging`, `delivered`, `cancelled`), Financial (`unrecognized`, `recognized`, `reversed`), and Payment (`unpaid`, `partially_paid`, `paid`) states remain strictly independent (`Delivered ≠ Paid`).
- Historical price snapshots (`basePriceSnapshotMinor`) frozen upon financial recognition.
- Charger fee matrix applied only when device is fee-applicable AND customer is not exempt AND charger is missing.
- Discounts authorized, stored, frozen historically, respecting: `Final Charge = Base Price + Charger Fee − Discount`.

### Financial System
- Append-only immutable `financial_ledger`.
- Payments and FIFO payment allocations at the order item level.
- Customer balance derived from the financial ledger (positive = credit, zero = no balance, negative = debt).
- Server-enforced debt limits.
- Overpayment becomes customer credit; financial recognition occurs exactly once per delivered item.

### Goals
- One active goal per customer based on a 7-day behavior baseline.
- Variable duration (6–14 days), target quantity, and bonus amount calculated with whole-number minor unit rounding.
- Read-only progress tracking; early completion or target ≤ progress upon edit grants bonus exactly once.
- Customer request workflow with admin approval/rejection.

### Business Days & Daily Close
- Stable business-day IDs with explicit server-authoritative opening and closing.
- Idempotent daily close automatically processes active undelivered non-cancelled items as delivered and executes single financial recognition.

### QR / Customer Access
- Secure token-resolved customer portal (`CustomerQrPage.tsx`) scoping orders, balances, and goals strictly to the authenticated customer without exposing admin data.

### Backup, Restore & Portable Backup
- Durable IndexedDB snapshots in `backupSnapshots` store surviving operational resets.
- FNV-1a checksum validation (`computeSnapshotChecksum`), atomic restore transactions, credential scrubbing (`sanitizeEntity`), and portable export/import (`.ocmbak`).

### Offline & Delta Synchronization
- Local-first operation: local entity projection + outbox command committed atomically in a single IndexedDB transaction (`localDb.runTransaction`).
- Monotonic delta synchronization (`sequence_id > lastAppliedChangeSequence`) with bounded batches, strict cursor advancement, and outbox dependency revalidation/unblocking.

---

## 3. ARCHITECTURAL NON-REGRESSION RULE
Future development MUST preserve the verified baseline unless a new explicit product requirement intentionally changes it. No future change may silently:
- Bypass the local-first pipeline or introduce direct UI → Supabase mutations.
- Reload entire tables unnecessarily or replace delta sync with full sync.
- Regenerate, reuse, or derive order numbers from counts/timestamps.
- Mutate historical financial records or equate Delivered with Paid.
- Bypass server authorization or weaken Super Admin authority.
- Expose BIN, password, or token data in backups.
- Physically delete historical customer business data.
- Break backup/restore integrity, stable IDs, or historical price snapshots.
- Reset or corrupt sync cursors, remove change-log coverage, or introduce duplicate navigation systems.

---

## 4. FUTURE DEVELOPMENT PROTOCOL
For every future feature or modification:
1. State the new requirement.
2. Identify affected baseline areas, UI screens, domain rules, database entities/RPCs, sync/outbox behavior, backup/restore impact, and authorization/security impact.
3. Implement the change without breaking unrelated baseline behavior.
4. Run targeted tests, regression suites, typecheck (`tsc --noEmit`), linter, and production build (`npm run build`).
5. Update `docs/FINAL_PRODUCT_BASELINE.md` only if canonical product behavior has intentionally changed.

---

## 5. BASELINE STATUS
- **BASELINE STATUS:** VERIFIED AND FROZEN
- **TEST STATUS:** 744/744 PASSING
- **TYPECHECK:** PASS
- **LINT:** PASS
- **BUILD:** PASS
- **UI/UX BASELINE:** VERIFIED
- **PRODUCT REQUIREMENTS BASELINE:** VERIFIED
- **SOURCE CODE MODIFIED:** NO
- **DATABASE MODIFIED:** NO
- **TESTS MODIFIED:** NO
- **CANONICAL BASELINE DOCUMENT:** CREATED
