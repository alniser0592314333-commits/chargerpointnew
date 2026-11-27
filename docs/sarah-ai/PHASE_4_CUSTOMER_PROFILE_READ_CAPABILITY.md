# Sarah Phase 4 — Limited Customer Profile Read

**Status:** Implementation branch; isolated SQL and gateway verification pending.

## Capability

Adds one narrow, read-only tool after customer name/code lookup:

- Database RPC: `public.sarah_ai_get_customer_profile(text,text)`
- Migration: `20261127090000_sarah_ai_customer_profile_read.sql`
- Gemini tool: `get_customer_profile`
- Input: exact four-character hexadecimal customer code, with an optional 2–64 character name hint to disambiguate code collisions.
- Output: at most five active customer profiles, with name, code, status, active flag, creation timestamp, and charger-fee-exemption flag.

## Explicitly excluded

The profile DTO does not return customer IDs, phone numbers, balances, debt limits, notes, payment/ledger rows, orders, or financial history. The RPC never accepts a customer UUID or an actor/customer scope override.

## Authorization and limits

- The original authenticated admin JWT is forwarded through the user-scoped Supabase client; no service-role data read is used.
- PostgreSQL independently requires a current registered admin session, `ai:use`, and `customers:view`.
- Each direct RPC call consumes its own atomic hourly and daily tool quota.
- The query is fixed to the canonical four-character UUID-derived customer code and an optional name substring; it is parameterized and capped at five returned rows.
- EXECUTE is granted only to `authenticated`; anon and service_role are denied.
- The chat gateway permits only one tool call per user request and sends the follow-up Gemini request without any tools, preventing recursive or chained tool calls.

## Required verification

The isolated SQL test covers:
- Duplicate four-character codes capped at five with `has_more`.
- Name-hint disambiguation for a colliding code.
- Exact code and no-match behavior.
- Inactive and deleted customer exclusion.
- No IDs, phone, balance, debt-limit, notes, order, or financial-history fields.
- Invalid code, short hint, and control-character rejection.
- Independent `ai:use` / `customers:view` enforcement.
- Unregistered and disabled admin session denial.
- Authenticated-only EXECUTE grants.

No production migration or deployment is performed by this branch.
