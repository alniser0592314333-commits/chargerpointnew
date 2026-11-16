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
- The goal business-rule trigger enforces positive target, 3–15 day duration, expiry/duration consistency, the 20-agorot-per-device cap, server-calculated progress, and matching bonus-ledger data for COMPLETED goals.
- Completed and failed goals are immutable.
- The public evaluator is not executable by `anon`; direct execution of the internal evaluator is not granted to `anon`, `authenticated`, or `service_role`. The public wrapper is permission-guarded.

## Live database audit findings on 16 November 2026

- There is one ACTIVE goal and one COMPLETED goal; two goal requests are APPROVED. No goal-specific cron job is scheduled.
- The live goal and goal-request tables have change-capture triggers. The canonical dispatcher also manually calls `record_canonical_change` after the same DML, producing duplicate sync rows. The live log contains 4 duplicated goal-request entity/version groups (6 redundant rows) and 6 duplicated goal entity/version groups (7 redundant rows).
- PR #310 adds two low-resource fixes without changing production: expiry reconciliation inside the existing admin Goals read RPC, and same-transaction de-duplication for trigger-captured goals, goal requests, and financial-ledger events. It deliberately creates no cron job, polling loop, extra client RPC, Edge Function, or new index.

## Release blockers still requiring isolated regression tests

1. **Premature bonus insertion:** the canonical `UPDATE_GOAL_PROGRESS` branch can insert a BONUS ledger row when the client sends `bonusGranted=true`, before the goal update proves that the goal is completed. The goal trigger validates a matching ledger row when status becomes COMPLETED, but it does not itself reject a BONUS row that is inserted while the goal remains ACTIVE. This path must be closed before release.
2. **Approval fallbacks:** `APPROVE_GOAL_REQUEST` still defaults missing proposal fields to target 10 (after requested target), bonus 500 agorot, and duration 7 days. Approval should require the reviewed proposal values or generate them server-side, not silently invent defaults.
3. **Pending-request duplication:** `goal_requests` currently has only its primary-key index; it has no database uniqueness guard for one PENDING request per customer. Confirm the intended product rule, then enforce it atomically if only one pending request is allowed.
4. **Customer-facing expiry view:** PR #310 reconciles expiry when the admin Goals page is opened. Verify the customer portal's read path and decide whether it needs the same on-demand server reconciliation without adding a separate polling request.
5. **Legacy RPC closure:** the older `execute_sync_command_impl_unlocked` still contains client-driven goal mutation code. Confirm all callers remain routed through the canonical guarded RPC and that the legacy implementation cannot be executed directly.

## Cost and rollout rules

- Do not add a per-minute cron, client polling, repeated data downloads, or new Edge Function/HTTP work for goals.
- Prefer existing RPC calls and database triggers; keep new queries bounded by existing indexes.
- Test only against isolated fixtures. Do not mutate live customer, goal, or financial-ledger rows for verification.
- Do not apply this forward migration to production until CI verifies the exact migration and the release blockers above are addressed.
