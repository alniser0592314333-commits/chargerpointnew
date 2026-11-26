# Phase 5 — Actor quota implementation

## Change
- Atomic actor-authenticated request quota in a server-only RPC.
- The Edge Function invokes quota after validated auth/profile/permission, before reading provider secret or contacting Gemini.
- Default quota: 20 requests per actor per rolling bucket hour (bucketed hourly UTC epoch boundary); server-side actor UUID comes from Supabase Auth, never request JSON.
- Fail closed if RPC unavailable; quota denial returns 429. No secret is exposed.
- Retention cleanup deletes bucket records older than 48 hours on quota invocation.
- RLS and table/function grants block anon/authenticated direct access.

## CI validation
- Isolated PostgreSQL fixture.
- Test verifies allowed calls, excess denial, actor isolation, null actor rejection, and browser role grants.

## Limitations / next security work
- Quota is hourly per actor, not provider billing hard cap; provider-side limits still matter.
- Bucket accounting intentionally consumes a slot before provider request and does not refund failed upstream requests.
- Concurrency correctness relies on PostgreSQL unique-key conflict update, tested with sequential behavioral assertions; CI should add parallel sessions for race testing.
- Continue with history validation, provider response controls, broader behavioral tests, and the first narrowly scoped read capability before any merge/deployment.
