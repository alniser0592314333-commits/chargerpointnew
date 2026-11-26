# Sarah UI identity-switch race audit

Inspected SarahChatPage at commit c8e48f0f86dc0e2aa73c58a8a101b96165a71ce6.

## Confirmed code-level concerns
- The page clears transcript state on account change, and transcript hydration uses an effect-local active flag. However, send/retry/refreshQueue asynchronous operations capture an account at invocation and subsequently update shared component state without checking whether the active account is still the same.
- A request initiated by account A could finish after the component session switches to account B and append its assistant response/error, toggle shared busy state, or refresh queue state. Queue storage operations themselves are account-keyed, but the page's shared state updates are not consistently guarded against stale completion.
- Transcript save effect is keyed by session.userId and hydratedAccount, which helps avoid saves before hydration; however, in-flight save/load completion and messages state transition behavior should be race-tested.
- Gateway uses authenticated user lookup and get_current_admin_profile identity match, active status, admin flag, and AI permission check before provider configuration access. Gateway still relies on service-role for provider configuration/secret RPC, which is provider infrastructure, not business data access. It currently exposes no operational record tools.

## Required remediation before activation
Implement a request/account epoch or active-user ref and check it before every state update after awaited work. Cancel/ignore stale async completions on identity changes. Ensure busy/pending/errors are per-account or reset safely. Apply the same guard to retry and queue refresh; include transcript save race protection.
Tests must simulate switching accounts while load/send/retry/queue-refresh promises are unresolved and assert no response/error/transcript/queue metadata appears in the other account's UI.


## Follow-up verification and contract alignment (2026-11-26)

- The application regression suite completed successfully on commit `98cd8aadd16ca6e274671e37963c0a4c834e5658`, but the Verify application workflow then failed in a Sarah transcript persistence contract test.
- Root cause: the contract test asserted the earlier direct `session.userId` call pattern. The current page resolves an explicit `accountId`, and guards asynchronous work with the account/operation epoch. The assertion was stale; the implementation was not failing that test behavior.
- The contract was updated to assert the account-bound load/save pattern and current-operation guard. This update is on the PR branch and is pending a fresh CI run.
- This is still a source-contract test; it does not constitute behavioural simulation of account switching under unresolved promises.
