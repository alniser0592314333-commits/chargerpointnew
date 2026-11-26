# Sarah AI — Public database access inventory

Date: 2026-11-26
Status: read-only catalog audit; no production data rows queried or modified.

## Tables with RLS enabled and no policies

A catalog query identified public tables with RLS enabled and no policies. The inspected set did not show direct SELECT grants to anon or authenticated. This is not proof against indirect access through routines, views, storage, or other paths; it must be treated as an inventory result.

Wallet ledger/account tables also showed FORCE RLS enabled in the inventory.

## Public SECURITY DEFINER routines inspected

- `check_system_bootstrapped` / `is_system_bootstrapped`: return a boolean indicating whether an active Super Admin exists.
- `get_global_app_identity`: returns branding/app identity fields (app name and logo URLs, version, timestamps, updated-by).
- `public_landing_content`: returns public hours, active device types/prices, brand assets, and charger fee setting.
- `public_resolve_customer_qr`: resolves an active customer QR token to customer name and derived code.
- `public_resolve_order_qr`: public order token resolver; returns order and item/payment projection, including customer identity and positive-credit flag. Higher privacy-impact and excluded from Sarah.
- `public_resolve_qr_payment_submission`: public order-token submission status projection; customer-token branch requires authenticated customer session validation.
- `submit_qr_payment`: public token-bound payment submission workflow, validates payment method, token, receipt storage path and ownership, and limits pending/repeated submissions.

## Limitations and follow-up

- Function definitions and catalog metadata were inspected; end-to-end rate-limit/token lifecycle/response tests were not run.
- This does not constitute a full audit of all exposed RPCs, views, storage policies, triggers, grants, or cross-schema paths.
- Public QR endpoint privacy findings are not approved for Sarah access.
- No production changes were made.
