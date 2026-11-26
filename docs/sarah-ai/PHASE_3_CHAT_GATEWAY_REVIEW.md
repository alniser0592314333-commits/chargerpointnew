# Sarah AI — Gateway and account-isolation review

Date: 2026-11-26
Branch: feat/sarah-chat-gemini-gateway-20261125
Status: static review of PR #326; findings are gates, not verified runtime fixes.

## Reviewed scope
- `supabase/functions/sarah-ai-chat/index.ts`
- `src/services/ai/sarahChatService.ts`
- Account-bound IndexedDB transcript and durable input queue
- Contract tests for account switching and queue recovery

## Positive controls observed
- Supabase bearer token is validated via `auth.getUser`; profile identity must match the Auth UUID.
- The gateway checks active admin profile and `ai:use` before retrieving provider config/key.
- Client-supplied role is not accepted as authorization context.
- Provider key retrieval is server-only; responses do not return provider raw errors or key.
- Request body, history count/text and provider timeout are bounded.
- Transcript hydration/save and queued retry logic use account identity and operation-generation checks; interrupted queue uploads are not automatically blindly replayed.
- Durable queue and transcript stores are separate from operational outbox; storage failure is fail-closed.

## Findings and gates
1. **No persistent gateway quota/rate limit:** authenticated users with `ai:use` can make repeated calls subject to provider limits. Add atomic server-side per-Auth-UUID burst and daily quota; do not key on client account IDs or IP alone. Rate-limit denial must not expose provider credentials or internal state.
2. **Account isolation is primarily client-side for transcript/input storage:** IndexedDB keys and UI operation guards help prevent accidental cross-account state reuse, but a local browser/device owner can inspect or alter local storage. Do not treat local transcript/queue data as a server authorization boundary. Future server-stored messages/results must validate actor and account scope in DB.
3. **Tool capability boundary remains disabled:** no operational tools are exposed by this gateway. The system prompt explicitly states this; responses must not be represented as live record access or command execution.
4. **Permission enforcement has to be fresh:** current gateway resolves the profile on each request; future tool calls need an independent re-check at execution, including revocation and active-account/session mismatch. A permission cached during chat initialization is insufficient.
5. **Provider configuration and migration are not production-verified:** the migration test fixture is isolated CI and does not establish production migration readiness or deployed Edge Function state.
6. **CORS wildcard:** currently permissive for browser origins, but authorization is bearer-token based and no credentialed cookies are used. Review tighter origin policy as a hardening item; do not claim this is an authorization control.
7. **Static contracts are insufficient alone:** CI should add behavioural tests for concurrent account switches, expired/revoked tokens, missing/inactive profile, permission revocation, request size limits, provider timeout, and queue lease contention. Tests must not require production credentials.

## Next engineering sequence
- Implement and test atomic server-side quota before expanding capabilities.
- Finish read-capability mapping from canonical repositories/use cases and effective permissions.
- Add database-enforced typed read function(s) only after their security contract and negative tests are reviewed.
- Keep all operational read/write tool catalogs disabled until bypass tests prove database enforcement.
- No merge, production migration, production RPC execution, or deployment is performed by this review.


## Follow-up verification — 26 Nov 2026

- The branch now contains an atomic quota implementation: 20 requests per validated Supabase Auth UUID per hourly bucket; service-role-only RPC; RLS forced; direct browser grants revoked; gateway fails closed if quota infrastructure fails. The isolated SQL regression has been strengthened to verify exact remaining counts, actor separation, limit/window bounds and grants. This latest test commit has not yet produced a GitHub Actions run, so it is pending CI evidence.
- Live catalog inspection confirms the current active-session guard calls `assert_my_account_session_active()` and resolves the admin by `auth.uid()`; `_cp_assert_active_admin_permission` deliberately returns NULL for service-role requests. This means the service-role path cannot be reused as a delegated user tool boundary even when the gateway independently validates a caller.
- The chat gateway currently has no operational capability calls: the service-role client is used for quota and provider configuration/secret retrieval only. Therefore, no ChargerPointNew customer/order/finance data is available to Sarah in this phase.
- The branch's read-bridge proposal must use a separately constructed authenticated-user RPC client forwarding the validated bearer token, not service-role calls. The database capability itself must validate active registered session, current actor and permission, with direct negative tests before any enablement.
- Remaining CI status: GitHub Actions has not returned a PR run for the latest quota-test commit at this observation; Vercel preview was building at the time of inspection. Neither is a pass. No production writes, migrations, merge or deployment were performed.


## CI evidence update — 26 Nov 2026

- GitHub Actions run #2677 for the PR merge ref completed. The isolated Sarah AI provider/quota migration job **passed**, including applying the quota migration and running the quota/grant regression script. This is evidence for the isolated fixture only, not production deployment.
- Overall Verify Application run #2677 failed in a separate job: `Verify username sign-in against local Supabase Auth`. The script reported HTTP 503 and `Username sign-in is temporarily unavailable`. This failure does not originate from the Sarah quota migration job. Its root cause is not yet determined; it must not be dismissed as flaky without investigation.
- Android APK build workflow run #914 succeeded on that merge ref. Vercel status for commit `1caae879...` was success. These statuses do not prove the chat gateway was deployed to production.
- Live guard inspection: `assert_my_account_session_active()` delegates to `is_my_account_session_active()` for browser JWTs and rejects revoked/expired/unavailable sessions. `get_current_admin_profile()` calls the active-session guard. `_cp_assert_active_admin_permission` returns NULL for service_role; hence service-role calls are explicitly not a delegated user authorization context.
- The authenticated-user RPC bridge remains a gated design. Before enabling a capability, verify JWT forwarding and database identity/session/permission/ownership controls with isolated direct-RPC negative tests. No production write, merge, or deployment occurred.


## Follow-up CI confirmation — 26 Nov 2026

- The later Verify Application run #2678 against the PR's current head SHA `9e3c79dcc2a0fcb25eb522740fe5f1cbf5fc093a` completed successfully. All six jobs, including the isolated Sarah provider/quota verification, the username sign-in local integration, the full verification job and migration job, passed.
- The username-sign-in integration logs show the local Supabase stack was reset, the integration account was inserted, and the script completed its real Auth success, generic credential failure, unknown-user non-disclosure, and rate-limit assertions.
- Run #2677's HTTP 503 was not reproduced on #2678. No specific causal fix or root cause for the earlier failure has been demonstrated; do not label it resolved by a code change or flaky conclusively.
- The #2678 Android APK workflow #915 also succeeded; Vercel preview status was successful. These are CI/preview results, not production release or merge evidence.
- PR #324 and #325 remain open and unmerged. Their latest observed Verify Application and Android builds both passed (runs #2576/#814 for #324 and #2579/#817 for #325). Coordination/merge order is still required before the three branches are integrated.


## Latest verification — 26 Nov 2026

- Verify Application run #2680 on the current PR merge ref completed successfully. The existing full application regression suite and the notification integration job both passed; the latter included Sarah gateway contract tests and Edge Function type-checking.
- Android workflow #917 initially encountered Maven Central HTTP 429 while resolving Android dependencies in the customer APK job. A targeted rerun of that failed job completed successfully. The final run #917 jobs now report customer APK, admin APK, notification integration, and regression suite all successful.
- Vercel preview status for head `b95972664d7e76e491b5b199903841fb9d074417` is successful.
- This validates the branch build and isolated tests only. No operational read bridge has been implemented; unresolved IndexedDB behavioural race testing and database-level delegated authorization remain gates. PR #326 and dependencies #324/#325 remain draft/open; no merge, production migration, or deployment has occurred.


## Queue lease race review — 26 Nov 2026

Static review of `src/application/ai/sarahInputQueue.ts` identified a race requiring a targeted behavioural test and correction before recovery is relied upon:

- `recoverInterruptedUploads(accountId)` lists account rows, evaluates lease expiry outside a transaction, then calls `transition(..., "NEEDS_ATTENTION")`.
- `transition` atomically checks the row's account and allowed state, but it does not compare an expected prior state/version, nor validate the lease timestamp inside the write transaction. It also accepts the caller's requested next state without an expected-state token.
- Consequently the earlier expiry observation is not transactionally coupled to the recovery write. A competing tab can renew/alter a lease or state after the listing. The transition may then mark a changed UPLOADING row as needing attention based on stale observation (or race handling may be unable to distinguish the outcome).

**Suggested correction gate (not yet implemented):** introduce an atomic recovery operation that re-reads the row in the same read-write transaction, verifies actor/account ownership, current state is UPLOADING, and lease is still expired, and only then transitions it. Use a compare-and-set guard (expected state + lease value/version) to avoid overwriting concurrent updates; return a benign race outcome if the row changed. Add behavioural tests with competing transactions/tabs for lease renewal, state change, and account-switch isolation. Do not treat static source contracts as proof of race-free behaviour.

This finding is based on static code inspection only; no race has been reproduced and no runtime fix is claimed. No production writes, merge, or deployment were performed.


## Live database session-guard discrepancy — 26 Nov 2026

A read-only inspection of the live project function definition (no writes) confirms that the deployed `public.is_my_account_session_active()` has a read-only transaction branch that returns `true` when no matching `public.account_sessions` row is found, provided the Auth session lookup passed. The same function's non-read-only path attempts to register an absent session row. This differs from the stricter proposed branch-version reviewed earlier, which rejects missing rows in read-only mode.

**Capability gate:** a delegated Read Bridge must not rely on this deployed guard alone for proof of registered application-session state in read-only transactions. It must independently require the matching `account_sessions` row (actor UUID + Auth session UUID), non-revoked state, and non-expired window, alongside fresh permission and ownership checks. A future correction to the live guard itself requires isolated migration tests, explicit approval and production migration authorization; no such migration was executed here.

This is a verified code-definition discrepancy from live read-only catalog inspection, not a test of exploitability or proof that any user accessed unauthorized data. No production changes were made.


## Queue recovery compare-and-set remediation — 26 Nov 2026

Branch-only follow-up now changes interrupted-upload recovery to re-read the queue record inside a read-write IndexedDB transaction and recover it only when account ownership, `UPLOADING` state, the previously observed lease timestamp, and lease expiry still match. Concurrent lease renewal or state change becomes a benign no-op instead of a stale transition. A source-contract test asserts this transactional comparison. This code is on PR #326 branch only; CI is queued and behavioral multi-tab tests remain outstanding. No production or operational database changes were performed.


## Lease recovery predicate coverage

The compare-and-set eligibility predicate is now isolated as a pure helper and exercised for a matching expired record, lease renewal, state change, cross-account record, and missing record. The recovery transaction calls this predicate after its in-transaction reread. These tests validate predicate cases; they do not replace multi-tab IndexedDB behavioral testing.
