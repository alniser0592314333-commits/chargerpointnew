# FINAL FORENSIC FULL-APP + BACKUP/RESTORE AUDIT

Date: 2026-10-06

## Executive verdict

The backup system was **not fully safe as a recovery mechanism** in the supplied repaired project. The main UI buttons existed and the basic snapshot/checksum/restore flow was present, but several changes made during the previous refactor created real backup gaps.

The most important finding was this:

> The application could create an internal local snapshot containing recovery metadata, but the **Download → Upload → Restore portable path could silently lose recovery-critical data** that was present in the local snapshot.

I repaired the backup path directly in the project. The repaired source now treats backup as a recovery artifact rather than only a copy of visible business tables.

## What was scanned

The audit covered the application tree, IndexedDB/local persistence, backup service, backup UI, sync/outbox state, order-number reservation state, QR persistence, financial records, restore/replacement paths, Supabase backup migrations, portable import/export validation, and the existing backup-related test suites.

Primary areas audited:

- `src/services/backup/backupService.ts`
- `src/components/settings/BackupDataManagement.tsx`
- `src/infrastructure/localDb/localDb.ts`
- `src/infrastructure/sync/*`
- `src/application/useCases.ts`
- `src/components/pages/dayOrdersStore.ts`
- backup/restore/replacement Supabase migrations
- `phaseB4_backup_restore.test.ts`
- `phaseB8_portable_backup.test.ts`
- `phaseB5_backup_ui.test.ts`
- `safety_snapshot_pagination_strict.test.ts`
- runtime local-storage persistence keys

---

# 1. Critical backup defects found

## P0 — Portable export was incomplete

`captureOfflineData()` already captured:

- business data
- outbox
- sync history
- sync state

But `exportSnapshotToPortableFormat()` did **not** export the outbox or sync history.

That means:

1. user creates an offline snapshot;
2. snapshot contains pending commands;
3. user downloads it;
4. later uploads it to another device;
5. the uploaded portable backup no longer contains the same pending recovery state.

That violates the requirement of an exact offline recovery backup.

### Fixed
Portable export/import now preserves:

- outbox
- sync history
- mutation rollback snapshots
- deleted-device markers
- local change-log state
- order-number reservations
- QR tokens
- local preferences

---

# 2. P0 — Mutation rollback snapshots were missing from backup

The previous refactor introduced persistent `mutationSnapshots` to protect optimistic local mutations from rejected/conflicting commands.

However, the backup system did not include them.

This created a dangerous situation:

- local database contains optimistic change;
- rollback snapshot exists;
- backup is taken;
- restore is performed later;
- rollback metadata is missing.

The restored application could therefore have the optimistic entity without the exact recovery record that was supposed to reverse it.

### Fixed
`mutationSnapshots` are now captured, exported, validated, imported and restored.

---

# 3. P0 — deletion markers were missing from backup

`deletedDeviceTypeMarkers` exist specifically to prevent a deleted device type from being resurrected by a later pull/sync.

They were cleared by operational reset but were not included in the backup payload.

A restore could therefore resurrect something that the local sync system intentionally remembered as deleted.

### Fixed
Deletion markers are now part of the exact offline recovery payload.

---

# 4. P0 — Online backup was not a true point-in-time snapshot

The previous Online backup path read each Supabase table separately through paginated REST calls.

That means table A could be read before a transaction and table B after a transaction.

For financial data, this is not ideal because a backup can theoretically contain a mixed-time state.

The project already contained an authoritative PostgreSQL checkpoint mechanism, but the application backup button was not using it.

### Fixed
Added:

`supabase/migrations/00116_authoritative_backup_v2.sql`

It introduces `create_authoritative_backup_checkpoint_v2()` which:

- verifies the authenticated admin + BIN server-side;
- captures the core data in one PostgreSQL transaction;
- includes system settings;
- includes QR tokens;
- stores the checkpoint server-side;
- returns the exact captured payload;
- records the authoritative change-log sequence;
- calculates a content hash over the actual snapshot.

The application's ONLINE and CONSOLIDATED backup paths now use this authoritative capture unless test/custom data is explicitly supplied.

**Important:** migration `00116_authoritative_backup_v2.sql` must be applied to the live Supabase project before the Online snapshot button is used.

---

# 5. P0 — Online normalization was silently dropping important fields

Several normalization functions reconstructed a reduced object instead of preserving the complete authoritative row.

Examples of fields at risk of being lost included:

- payment `reference`
- payment `actor_admin_id`
- payment `command_id`
- ledger `sequence_number`
- ledger `linked_ledger_id`
- order internal sequence
- order QR token linkage
- order lifecycle timestamps
- order-item discount/final-charge/notes and other historical columns
- QR expiry/active metadata
- business-day metadata
- device-type status/version fields

This was especially dangerous because the backup could look valid while silently losing information.

### Fixed
Authoritative normalizers now preserve the original sanitized row (`...row`) and add canonical aliases on top.

The backup therefore keeps all known database columns instead of projecting them into a smaller shape.

---

# 6. P0 — Restore could retain stale sync/rollback state

The previous restore cleared business tables but could retain sync/rollback metadata that was newer than the snapshot.

That could cause the restored state to be combined with metadata from a different generation.

### Fixed
Restore now clears before repopulation:

- sync state
- mutation snapshots
- outbox
- sync history
- operational business data

Then it restores exactly what the snapshot contained.

---

# 7. P0 — local DB reset did not completely clear mutationSnapshots

`mutationSnapshots` had been introduced as a separate IndexedDB object store.

Some reset/clear paths cleared the in-memory map but did not consistently clear the IndexedDB object store.

A browser reload could therefore resurrect stale rollback records.

### Fixed
All relevant clear paths now clear the persistent `mutationSnapshots` store as well.

This includes normal operational clearing and full local DB clearing.

---

# 8. P1 — backup capture could observe different moments between tables

Offline backup previously performed many awaited `localDb.list()` calls.

A local mutation could theoretically occur between two table reads.

### Fixed
Added a single hydrated-memory recovery snapshot operation in `localDb`.

The backup clones the local state in one synchronous pass over the hydrated cache, covering:

- business tables
- outbox
- sync history
- sync state
- mutation snapshots
- deletion markers
- local change log
- order-number reservations

This gives the offline backup a consistent application-level point in time.

---

# 9. P1 — local application preferences were not backed up

Business data was not the only persistent application state.

Important local preferences included:

- theme
- language
- QR design configurations
- local logo cache
- active logo selection
- global identity cache

Authentication/session credentials are intentionally excluded.

### Fixed
A strict allowlist of safe local preference keys is now included in backup and restored later.

No auth session, access token, refresh token or BIN is backed up.

---

# 10. P1 — restore/import referential integrity was too weak

Portable validation checked basic collections and some order references, but restore itself did not perform the same full referential validation.

### Fixed
Before destructive restore, the application now verifies references between:

- customers → orders
- business days → orders
- orders → order items
- device types → order items
- customers → payments
- payments/orders → allocations
- financial ledger → customer/order/item
- goals → customers
- goal requests → customers
- QR tokens → customer/order targets

This happens before operational data is cleared.

---

# 11. P1 — portable metadata could lie about record counts

The checksum protected the data payload, but the declared metadata counts were not independently compared with the actual arrays.

### Fixed
Portable validation now checks declared counts and `totalEntities` against the actual payload.

A mismatch is rejected as `METADATA_MISMATCH`.

---

# 12. P1 — destructive Local → Online replacement could promote optimistic local state

This was the most important non-download backup conflict found during the wider scan.

The application has a powerful operation:

**Replace Online with Local Data**

But local data can be optimistic while:

- outbox commands are pending;
- mutation rollback snapshots still exist;
- synchronization requires reconciliation.

Promoting such a local state wholesale to the server can turn an optimistic UI projection into server truth.

That is unsafe, especially for financial delivery recognition.

### Fixed
Local → Online replacement is now blocked while:

- pending outbox commands exist;
- mutation snapshots exist;
- local reconciliation is required.

The correct flow is now:

**sync/settle → verify local state → replacement**

rather than:

**optimistic local state → overwrite server**.

---

# 13. Financial backup preservation review

The financial model was checked specifically because this application treats the ledger as authoritative.

The repaired backup preserves:

- financial ledger rows
- payment rows
- payment allocations
- order/item references
- ledger metadata
- payment idempotency command IDs
- actor IDs
- historical sequence fields when present
- reversal linkage fields when present

The online authoritative backup also captures these from one PostgreSQL snapshot.

### Important architectural rule preserved

Backup does **not** calculate a new balance and save that as authoritative truth.

It preserves the underlying financial events and allocations so the application can reconstruct the same financial state.

---

# 14. QR backup review

QR data is part of the durable business identity.

The repaired backup preserves QR token records instead of treating QR data as disposable UI state.

The online authoritative backup V2 explicitly includes `qrTokens`.

Authentication/session tokens are still excluded by the secret scrubber.

---

# 15. What is intentionally NOT backed up

For security, the backup does **not** contain:

- Supabase access tokens
- refresh tokens
- passwords
- password hashes
- admin BINs
- BIN hashes/salts
- service-role keys
- API keys
- private keys
- browser authentication session

An imported backup restores application/business state, not somebody's login credentials.

---

# 16. Existing server backup path — finding

The original migrations already contained `backup_checkpoints` and authoritative backup/restore RPCs.

The older checkpoint implementation had two limitations:

1. it did not include QR tokens/system settings in the captured business snapshot;
2. its integrity hash was based primarily on counts/ledger sum rather than a hash of the full payload.

The new V2 checkpoint path was added instead of pretending the older implementation was perfect.

The current UI does not directly use the old server checkpoint restore RPC; the application's visible restore flow restores a portable/local snapshot into IndexedDB.

---

# 17. Backup lifecycle after repair

## Offline backup

`IndexedDB hydrated state`
→ exact application recovery snapshot
→ sanitize secrets
→ checksum
→ immutable local backup snapshot
→ downloadable portable JSON

## Online backup

`Authenticated admin + BIN`
→ PostgreSQL authoritative V2 checkpoint
→ one consistent database snapshot
→ server checkpoint retained
→ payload returned to app
→ local immutable snapshot
→ portable download

## Upload backup

`JSON file`
→ parse
→ format/version validation
→ checksum validation
→ metadata count validation
→ referential integrity validation
→ secret sanitization
→ stored as backup snapshot only

**Import does not overwrite live business data.**

## Restore backup

`backup snapshot`
→ checksum verification
→ structural/FK validation
→ clear operational state + stale recovery metadata
→ restore business data
→ restore pending recovery metadata
→ restore safe local preferences
→ mark synchronization as requiring reconciliation where appropriate
→ reload runtime

---

# 18. Test coverage added

Added:

`src/tests/backup_forensic_completeness.test.ts`

It specifically checks:

- recovery-critical metadata is captured;
- pending outbox survives export;
- mutation snapshots survive export;
- deletion markers survive export;
- local preferences survive export;
- checksum remains deterministic;
- altered metadata counts are rejected;
- restore brings recovery metadata back.

Existing backup suites were also reviewed rather than replacing them.

---

# 19. Verification status

### Passed

- Modified `backupService.ts` TypeScript transpile/syntax check: **PASS**
- Modified `localDb.ts` TypeScript transpile/syntax check: **PASS** when parsed as TypeScript (not JSX)
- New forensic backup test source transpile/syntax check: **PASS**
- New SQL migration dollar-quote balance: **PASS**
- Original supplied ZIP integrity: **PASS**
- Static scan for the old Supabase project reference in the repaired source: no matches found

### Not honestly claimed

A complete `npm run build` / Vitest run was not claimed because the environment does not have the project's installed dependency tree and previous dependency installation attempts timed out.

The new SQL migration was **not applied to the live Supabase project** from this environment.

Therefore the repaired project is source-level complete for this audit, but the final live-online backup path still requires applying migration `00116_authoritative_backup_v2.sql` and then performing a real browser/Supabase backup → download → clear → upload → restore test.

---

# 20. Final judgement

### Before this repair

**Backup status: YELLOW/RED for disaster recovery.**

The buttons worked conceptually, but the portable backup could lose recovery-critical information and the online capture was not guaranteed to be a consistent point-in-time snapshot.

### After this repair

**Backup architecture: GREEN at source level, pending live migration/runtime proof.**

The backup now has the correct separation:

- business data
- financial history
- identity/QR data
- offline pending work
- rollback metadata
- sync metadata
- safe local preferences
- integrity validation
- authoritative server checkpoint

Most importantly, the system no longer treats a JSON export as merely a copy of the visible customer/order tables.

It is now designed as a **recoverable application state snapshot**.

## Files changed for this audit

- `src/services/backup/backupService.ts`
- `src/infrastructure/localDb/localDb.ts`
- `src/tests/backup_forensic_completeness.test.ts`
- `supabase/migrations/00116_authoritative_backup_v2.sql`

The rest of the previously repaired application code was left intact unless required to make backup/restore safe.
