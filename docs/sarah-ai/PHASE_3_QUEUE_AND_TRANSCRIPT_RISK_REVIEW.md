# Sarah AI — Queue and Transcript Risk Review

Date: 2026-11-26
Branch: feat/sarah-chat-gemini-gateway-20261125
Review only; no production changes.

## Verified implementation observations
- Durable input records are keyed by actorAccountId and sequence, and list/transition/remove methods require an account ID and verify ownership before modifying a record.
- Text and audio inputs have bounds (20,000 characters and 25 MiB). Audio is persisted as a Blob, though audio capture/transmission is not yet enabled in the page.
- Interrupted UPLOADING records are changed to NEEDS_ATTENTION rather than blindly replayed, because provider delivery may have occurred before app shutdown.
- Offline text is stored as QUEUED_OFFLINE and displayed for manual retry. This page does not currently implement automatic reconnect-driven replay.
- Transcript IndexedDB rows are keyed by accountId and capped at 500 messages per save, but local IndexedDB data is not encrypted by this implementation and no retention policy is enforced.
- Existing account-switch tests are source-pattern checks, not deferred-promise behavioural simulations. They are useful guardrails but do not prove races cannot occur.

## Risk and follow-up
1. Before any business-data capability is enabled, add behavioural tests that hold hydration/send/retry/queue refresh/save promises unresolved, switch account, and resolve/reject in different orders. Assert no stale UI state crosses accounts.
2. Verify queue-record ownership with collision, tampering, and simultaneous account tests; ensure transition/remove fail closed and recoverInterruptedUploads cannot change another actor's rows.
3. Document and implement explicit retention/deletion controls for transcripts and completed/abandoned queue records before sensitive operational context is stored locally.
4. Evaluate encryption-at-rest feasibility and threat model for IndexedDB. Do not imply browser IndexedDB is encrypted or protected against a local device user.
5. Consider auto-reconnect queue sending only after a clear idempotency contract exists. Until then, manual retry and interruption review are safer than automatic replay.
6. Keep audio and operational tools disabled until these behaviours and the database enforcement audit are verified.

## Scope
This review is grounded in source inspection of SarahInputQueue, SarahConversationStore, and SarahChatPage. It does not claim a complete threat-model review or production validation.
