# Smart Customer Goals — Canonical Policy

## Approved business rules
- A customer can have only one ACTIVE goal.
- Goal duration is a randomly selected integer from 3 through 15 days inclusive unless an authorized admin explicitly sets a valid duration.
- Once a goal is created, its chosen duration and expiry are persisted. Sync, refresh, and retries must not reroll an existing goal.
- The target scales with both the customer's recent delivered-device pace and the selected duration. Recent activity is measured over the previous seven days.
- Target formula: expected devices during the goal = (distinct qualifying devices delivered in the previous 7 days / 7) × duration. Target = max(10, ceil(expected devices + max(10, 25% of expected devices))).
- Count distinct order-item IDs, not ledger rows. Only actually delivered and financially recognized devices qualify. A reversed/cancelled item must not count toward active-goal progress.
- Reward remains based on target size and challenge difficulty. Existing reward band is 8–13 agorot per target device (₪0.80–₪1.30 per 10 devices), and all values remain integer minor units.
- Hard reward cap: ₪2 per 10 target devices = 20 agorot per target device. Bonus must never exceed targetQuantity × 20 minor units. Example: target 50 → cap 1,000 agorot = ₪10.
- Progress is derived, not manually editable. Completion and bonus issuance must be atomic and idempotent. Completed/failed goals are immutable.
- Server/PostgreSQL is authoritative for eligibility, progress, completion, expiry, and bonus issuance; client-computed values are advisory only.
- Cancelling/reversing a previously counted delivery must remove that device from an ACTIVE goal's progress.
- Goal duration and expiry must remain consistent: expires_at = started_at + duration_days × 24 hours.

## Code/database reconciliation findings (read-only audit)
- `src/domain/rules.ts` previously restricted duration to 6–7 days, used a fixed seven-day target independent of selected duration, and had no ₪2/10-device cap.
- `src/application/useCases.ts` previously counted CHARGE/ORDER_ITEM_CHARGE ledger rows rather than distinct item IDs; evaluator did the same, so duplicate ledger rows could inflate progress and reversals were not subtracted.
- `src/domain/invariants.ts` previously allowed any positive duration and did not validate the reward cap.
- Live `public.goals` schema has target, progress, bonus, duration, status, start/expiry timestamps and bonus_ledger_id, but the database duration constraint is only `duration_days > 0`; it does not enforce 3–15 or reward cap.
- Live `public.evaluate_customer_active_goal(uuid)` counts distinct delivered, recognized order items and excludes soft-deleted items, but its EXECUTE privilege is granted to PUBLIC and anon as well as authenticated. It is SECURITY DEFINER and must be hardened.
- Live `execute_canonical_sync_command` UPDATE_GOAL_PROGRESS branch accepts client-provided progress/status/bonus fields instead of independently verifying progress and target eligibility. This violates server-authoritative goal accounting and remains a database-side blocker.
- The live database already has `trg_change_capture` triggers on `goals`, `goal_requests`, and `financial_ledger`; the previous goal functions also manually wrote change_log rows, creating duplicate delta events. The forward migration removes manual goal-related change-log writes and relies on full-row trigger capture.
- The migration currently in source control and live function body are not identical; the database change must be a new forward migration, not an edit to an already-applied migration.
- No live goal data should be mutated for tests. Existing live goal tables were reported empty during the audit; tests must use isolated fixtures/local mocks.

## Release gate
Do not consider the feature complete until a forward SQL migration enforces the same duration and bonus rules, hardens evaluator privileges, recalculates progress on the server, rejects forged progress/bonus mutations, and handles reversals consistently. Verify typecheck/unit tests and inspect the generated migration before applying it to the live project.
