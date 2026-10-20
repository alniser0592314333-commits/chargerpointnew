# Native Android push notifications

This implementation sends device notifications from the existing canonical event records; it does not create a second notification inbox.

## Events

- A new pending `qr_payment_submissions` row notifies registered admin APKs.
- A payment submission becoming `APPROVED` or `REJECTED` notifies the matching customer installation.
- Existing `customer_account_events` of type `RESET_REQUESTED` or `GOAL_REQUESTED` notify admins.
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

Store the exact function URL in Vault under `native_push_function_url`, for example:

`https://ydhcyamtgioyrxfarkwk.supabase.co/functions/v1/native-push`

The migration generates the dispatch credential inside Vault. The database trigger sends only a small event reference and that credential; the Edge Function validates it through a verifier callable only with the service-role key, re-reads the authoritative row, derives recipients server-side, and sends generic messages without receipt paths, amounts, balances, passwords, or customer QR tokens.

## Rollout safety

- Apply the accompanying migration only after review and explicit approval.
- Deploy `native-push` with `verify_jwt = false` only because the function independently verifies the Vault-generated dispatch secret for database-trigger dispatch and validates Supabase Auth plus active admin/customer sessions for registration/unregistration.
- No migration or Edge Function deployment is performed by this branch.
- Without Firebase configuration, the APK build intentionally continues with a warning, but actual FCM registration/delivery is unavailable.
