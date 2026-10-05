# Sync State Machine Reference (`docs/sync-state-machine.md`)

## 1. Outbox Command States
Commands in the local outbox transition through the following states:
- `pending`: Created locally, awaiting next sync cycle.
- `syncing`: Currently being pushed to server transport.
- `accepted`: Successfully validated and committed by server.
- `rejected`: Non-retryable validation or business rule rejection.
- `conflict`: Optimistic concurrency or idempotency payload conflict requiring resolution.

## 2. Retry Policy
- **Retryable Errors**: Network timeout, temporary server unavailability. Triggers exponential backoff with jitter.
- **Non-Retryable Errors**: Permission denied, closed day rejection, validation error, idempotency conflict. Transitions immediately to `rejected` or `conflict`.
