# Smart Customer Goals — Current Policy and Release Audit

## Current proposal policy in `src/domain/rules.ts`

- A customer may have only one ACTIVE goal. The live database enforces this with the partial unique index `uq_goals_one_active_customer`.
- A generated proposal uses an integer duration between 5 and 15 days. For a 28-day activity profile, the selected range is activity-sensitive: 5–9 days at a high recent pace, 5–11 days at a medium pace, and 7–15 days at a lower pace. An explicitly selected admin duration may be 3–15 days.
- The activity profile covers up to 28 days. The recent seven-day average contributes 65% and the 28-day average contributes 35%.
- Expected devices = weighted daily pace × duration. The target is at least 10 and adds a stretch of the greater of 10 devices or 25% of expected devices.
- The proposal reward rate is 15–20 agorot per target device. Proposal generation has a minimum total bonus of 150 agorot. The hard maximum is 20 agorot per target device; all amounts are integer minor units.
- Once created, a goal's duration and expiry must remain consistent: `expires_at = started_at + duration_days`.
- The client proposal is advisory. PostgreSQL is authoritative for eligibility, progress, completion, expiry, and bonus issuance.

## Server-side progress and state enforcement confirmed in the live database

- Progress counts distinct order-item IDs only when status is `delivered`, operational status is `DELIVERED`, financial status is `RECOGNIZED`, delivery time is within the goal window, and the item is not soft-deleted.
- The order-item update trigger invokes the server evaluator when delivery, recognition, reversal, or soft-delete fields change.
- The evaluator locks the ACTIVE goal, recalculates progress from order items, and handles completion/expiry. Completion writes a matching BONUS ledger entry and updates the goal in the same transaction.
- The goal business-rule trigger enforces positive target, 3–15 day duration, expiry/duration consistency, the 20-agorot-per-device cap, server-calculated progress, and matching bonus-ledger data for COMPLETED goals. PR #310 additionally validates every new BONUS row at transaction commit and makes existing BONUS rows immutable against UPDATE/DELETE.
- Completed and failed goals are immutable.
- The public evaluator is not executable by `anon`; direct execution of the internal evaluator is not granted to `anon`, `authenticated`, or `service_role`. The public wrapper is permission-guarded.

## Live database audit findings on 16 November 2026

- There is one ACTIVE goal and one COMPLETED goal; two goal requests are APPROVED. No goal-specific cron job is scheduled.
- The live goal and goal-request tables have change-capture triggers. The canonical dispatcher also manually calls `record_canonical_change` after the same DML, producing duplicate sync rows. The live log contains 4 duplicate goal-request UPDATE groups (4 redundant rows), 4 duplicate goal INSERT groups (4 redundant rows), and 2,505 duplicate financial-ledger INSERT groups (2,505 redundant rows). Every duplicate pair is from the same transaction, confirming that the row trigger and the later manual recorder both logged the same DML.
- PR #310 adds four low-resource fixes without changing production: expiry reconciliation inside the existing admin Goals RPC and both existing customer portal resolver overloads, same-transaction de-duplication for trigger-captured goals, goal requests, and financial-ledger events, a deferred constraint trigger that rejects a BONUS ledger row unless its matching goal is COMPLETED at transaction commit, and suppression of external push dispatch only during read-time reconciliation (normal delivery-triggered completion notifications remain unchanged), and rejection of goal approvals that omit the reviewed target, bonus, or duration instead of silently using defaults. It deliberately creates no cron job, polling loop, extra client RPC, Edge Function, or new index.

## Remaining release blockers requiring isolated regression tests

1. **Pending-request duplication:** `goal_requests` currently has only its primary-key index; it has no database uniqueness guard for one PENDING request per customer. Confirm the intended product rule, then enforce it atomically if only one pending request is allowed.
3. **Legacy RPC closure:** the authenticated `execute_sync_command` entry point delegates through the session-guarded wrapper to the canonical dispatcher. The older `execute_sync_command_impl` wrapper and its unlocked implementation are not executable by `authenticated`, but `service_role` still has EXECUTE on the wrapper. Audit any service-role callers before revoking that legacy path.

## Cost and rollout rules

- Do not add a per-minute cron, client polling, repeated data downloads, or new Edge Function/HTTP work for goals.
- Prefer existing RPC calls and database triggers; keep new queries bounded by existing indexes.
- Test only against isolated fixtures. Do not mutate live customer, goal, or financial-ledger rows for verification.
- Do not apply this forward migration to production until CI verifies the exact migration and the release blockers above are addressed.
