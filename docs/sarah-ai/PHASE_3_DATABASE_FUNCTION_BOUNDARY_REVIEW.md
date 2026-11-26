# Sarah AI — Database function boundary review

Date: 2026-11-26
Status: read-only production catalog/body inspection; no data rows queried, no changes to production.

## Functions inspected

- `_cp_assert_active_admin_permission`: internal helper (postgres-only execute) used by authenticated SECURITY DEFINER entrypoints to resolve the active identity/session and permission.
- `admin_cancel_goal`: resolves the actor using the session/permission helper, then requires goals:manage (Super Admin shortcut) and locks/updates only the selected active goal.
- `admin_review_goal_cancellation`: requires goals:approve or goals:manage, with Super Admin shortcut, and validates active goal/pending cancellation state before update.
- `calculate_customer_authoritative_balance`: validates current session, effective financial-view permission, and customer active/deleted status before calling the guarded implementation.
- `create_admin_pending_customer_payment`: validates active account session, resolves actor from auth.uid(), checks finance:create-payment or Super Admin, amount/note bounds and customer active status.
- `get_admin_goals_page_data`: session/actor resolution and goal/request viewing permissions are resolved server-side.
- `begin_sync_bootstrap`: requires sync:manage through the server permission guard; its return enumerates broad sync collections and is explicitly not a conversational capability.
- `current_admin_id`: invokes session assertion before returning guarded identity.

## Assessment

- These reviewed entrypoints demonstrate server-side actor/session and effective permission checks, but are not approved as Sarah tools by virtue of those checks alone. Some return projections or execute mutations beyond Sarah's narrowly scoped initial capability set.
- Sarah must use dedicated, field-minimized read functions rather than bootstrap/change-log/sync projections or broad report RPCs.
- Service-role execution must never be treated as the conversational actor. The tool bridge needs actor-bound validation and exact permission checks.
- This is a focused sample, not a full SECURITY DEFINER, grants, view, trigger, schema, or RLS audit. Additional public functions and anonymous QR/customer endpoints remain to be inspected.
- Production remains unchanged; this document is audit-only.
