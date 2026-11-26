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
