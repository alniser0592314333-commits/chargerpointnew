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


## Anonymous/public endpoint spot-check

- `public_resolve_customer_qr` resolves an active, unexpired bearer QR token and returns only customer name and derived customer code.
- `public_resolve_order_qr` resolves an active order bearer token and returns a broad order/payment projection, including customer name, item details, paid/due amounts, and the customer's financial balance. This is intended for the public order-QR experience, but represents a higher privacy-impact surface than the customer QR resolver. Keep this endpoint out of Sarah's catalog; review the public QR privacy model, token lifecycle, rate limiting, and whether balance fields are necessary in a separate application security audit.
- `public_landing_content` returns configured opening hours, active device types/prices, brand assets and charger fee settings for public landing use.
- `is_system_bootstrapped`/ `check_system_bootstrapped` return a boolean about whether an active Super Admin exists; no account data is exposed by the inspected definitions.
- This is a definition spot-check; token entropy, rate limiting, storage, expiry policy, and full response handling were not tested end-to-end. No changes were made to these production functions.

## Expanded catalog inventory (read-only, 2026-11-26)

A catalog query enumerated public SECURITY DEFINER routines with argument signatures, search_path settings, and ACLs. This is an inventory snapshot, not a full source audit.

- The inventory includes many authenticated EXECUTE entrypoints and corresponding guarded implementation/internal variants. These must be evaluated as actor/session/permission gates and not merely based on the presence of SECURITY DEFINER.
- Several sync/bootstrap/snapshot routines are broad-data projections; they are excluded from Sarah's conversational capabilities pending exact field scope and actor checks.
- The query is a metadata inventory only. It did not read business data or modify catalog state.
- Further full-body/ACL testing is still required before any scoped data tool is approved for Sarah.
