# Native Android push notifications

This implementation sends device notifications from the existing canonical event records; it does not create a second notification inbox.

## Events

- A new pending `qr_payment_submissions` row notifies registered admin APKs with the submitted amount and timestamp.
- Inserts into the existing canonical `goal_requests` table notify admin APKs; status changes notify the matching customer after review. Password-reset and account-state events continue to use `customer_account_events`.
- A payment submission becoming `APPROVED` or `REJECTED` notifies the matching customer installation; approval notifications include the amount and submission date/time.
- A canonical `financial_ledger` `PAYMENT` row from a manual admin top-up notifies the matching customer with the amount and top-up date/time. Rows linked to QR submissions are suppressed here to avoid duplicate approval notifications.
- Existing customer account events for password reset/change and account freeze/reactivation/cancellation notify the matching customer installation.
- Notification taps open the existing admin Notifications/Goals route or restore the customer portal session.
- Foreground FCM events are displayed using Android local notifications; background/terminated delivery uses FCM.

## Required provider configuration

FCM requires a Firebase project and an Android app registration for **both** package IDs:

- `com.chargerpointnew.admin`
- `com.chargerpointnew.customer`

Add the corresponding base64-encoded `google-services.json` files as GitHub Actions secrets:

- `GOOGLE_SERVICES_JSON_ADMIN_BASE64`
- `GOOGLE_SERVICES_JSON_CUSTOMER_BASE64`

The build checks that each file contains the package ID for the APK being built. Do not commit either JSON file or a Firebase private key.

Configure these Supabase Edge Function secrets for `native-push`:

- `FCM_PROJECT_ID`
- `FCM_CLIENT_EMAIL`
- `FCM_PRIVATE_KEY` (the service-account PEM private key; keep it only in Supabase secrets)

The migration automatically stores the exact function URL in Vault under `native_push_function_url` and generates the dispatch credential there. The database trigger sends only a small event reference and that credential; the Edge Function validates it through a verifier callable only with the service-role key, re-reads the authoritative row, derives recipients server-side, and formats the approved amount/date from authoritative records. Push payloads never include receipt paths, balances, passwords, or customer QR tokens.

## Rollout safety

- The migration `20261021140000_native_push_manual_balance_topups.sql` adds the manual top-up trigger; the corresponding live migration was applied as part of the repair.
- Deploy `native-push` with `verify_jwt = false` only because the function independently verifies the Vault-generated dispatch secret for database-trigger dispatch and validates Supabase Auth plus active admin/customer sessions for registration/unregistration.
- No migration or Edge Function deployment is performed by this branch.
- Without the two Firebase JSON secrets, the APK workflow emits a warning and builds an APK without working FCM delivery. Configure both secrets before treating the APK as notification-ready.
