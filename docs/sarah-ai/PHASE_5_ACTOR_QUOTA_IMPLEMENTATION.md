# Phase 5 — Database-enforced actor quota

## Status

Implemented in the Sarah gateway branch; CI execution is pending for the latest commit.

## Enforcement model

- The quota actor is derived inside PostgreSQL from `auth.uid()`; no caller-supplied actor ID is accepted by the user-facing RPCs.
- `sarah_ai_consume_my_quota(period)` requires an active registered admin session and `ai:use`.
- `sarah_ai_consume_my_manage_quota(period)` requires an active registered admin session and `ai:manage`; this is used only for provider connection tests.
- The only accepted periods are `hour` and `day`. Limits are fixed in the database at 20/hour and 100/day; the client cannot raise the cap or shorten the window.
- Disabled administrators are rejected using `admins.disabled_at`, even if the older profile projection still reports `is_active=true`.
- The counter implementation is a private `SECURITY DEFINER` function with no execute grants to browser or service roles.
- The usage table has RLS enabled and forced, with no direct table privileges for `anon`, `authenticated`, or `service_role`.
- There is no service-role RPC accepting an arbitrary actor ID. The Edge Functions consume quota using the original caller JWT.
- The primary key includes `actor_auth_user_id`, `window_seconds`, and `window_started_at`, preventing hourly and daily counters from colliding when both windows start at the same UTC boundary.
- Counter increments use a single atomic upsert. Old windows are pruned after 48 hours.

## Gateway integration

- `sarah-ai-chat` calls the user-scoped hourly and daily quota RPCs before loading the provider credential or making a Gemini request.
- `sarah-ai-settings` uses the manage-scoped quota RPC for provider connection tests.
- The provider configuration table is not directly selectable by `service_role`; the gateway uses a narrow server-only runtime projection RPC. The API key is retrieved through a separate server-only Vault RPC.
- Provider configuration save/clear operations are serialized with a transaction-scoped advisory lock.

## Verification added

- Hourly limit: 20 allowed, request 21 denied.
- Daily limit: 100 allowed, request 101 denied.
- Manager with `ai:manage` but without `ai:use`: provider-test quota allowed, chat quota denied.
- Unregistered and disabled admin sessions denied.
- Hour/day window separation checked.
- Browser and service-role table/function grants checked.
- CI launches 30 simultaneous authenticated requests for one actor and expects exactly 20 allowed, 10 denied, with a stored count of 30.

## Remaining boundary

This quota protects Sarah's current text gateway and provider test path. It does not by itself authorize future data tools. Every future tool must call a typed database RPC under the original user JWT, and that RPC must independently enforce `ai:use`, the relevant business permission, active session, bounded inputs, and bounded output. No service-role read bridge is permitted.
