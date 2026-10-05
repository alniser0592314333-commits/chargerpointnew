# Offline & Sync Architecture Reference (`docs/offline-sync-architecture.md`)

## 1. Source of Truth & Philosophy
- **Server Database = Source of Truth**: PostgreSQL on Supabase is the definitive authority. Local admin devices operate offline and queue business mutations as cryptographic `Command` objects.
- **Outbox Pattern**: Every local mutation is persisted to the local outbox before local optimistic application.
- **No Full Database Replacement**: Synchronization is incremental and transactional via change feeds and command pushes.
- **Financial Serialization**: Financial operations (payments, recognition, reversals, credit) are never subject to last-write-wins; they are serialized on the server.

---

## 2. Infrastructure Architecture
- **Local DB (`src/infrastructure/localDb/`)**: IndexedDB abstraction layer managing tables for customers, devices, orders, items, payments, ledger projections, outbox, and sync state.
- **Sync Engine (`src/infrastructure/sync/`)**: Coordinates command pushes, monotonic sequence cursor (`sequence_id`) pulling, conflict resolution, retry policies, and sync locking.
- **Idempotency & Concurrency**: Enforced via `command_id` unique processing records and entity `version` optimistic concurrency.
