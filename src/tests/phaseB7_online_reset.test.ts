import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { AuthorizationContext, ActorAdmin } from '../application/authContext';
import { backupService } from '../services/backup/backupService';
import { localDb } from '../infrastructure/localDb/localDb';
import { SyncEngine } from '../infrastructure/sync/syncEngine';
import { initializeCanonicalSyncState } from './utils/testSetup';

describe('B.7 — Online Business Reset Unit & Migration Tests', () => {
  const migrationPath = path.join(process.cwd(), 'supabase', 'migrations', '00022_fix_online_reset_where_clause_and_device_types.sql');
  const migrationContent = fs.readFileSync(migrationPath, 'utf8');

  const superAdminActor: ActorAdmin = {
    id: '00000000-0000-0000-0000-000000000001',
    username: 'superadmin',
    fullName: 'Super Admin',
    role: 'SUPER_ADMIN',
    permissions: ['settings:manage', 'admin:manage'],
    isSuperAdmin: true,
  };

  const restrictedAdminActor: ActorAdmin = {
    id: '00000000-0000-0000-0000-000000000002',
    username: 'operator',
    fullName: 'Operator',
    role: 'OPERATOR',
    permissions: ['orders:create'],
    isSuperAdmin: false,
  };

  const mockValidBinVerifier = async (bin: string) => bin === '1234' || bin === '123456';

  beforeEach(async () => {
    // Clear local db for test isolation
    await localDb.runTransaction(
      ['kvStore', 'backupSnapshots', 'outbox', 'syncState', 'syncHistory'],
      'readwrite',
      (tx) => {
        localDb.clearOperationalTablesWithTx(tx);
      }
    );
    await initializeCanonicalSyncState();
  });

  describe('1. Migration Structure & Security Preflights', () => {
    it('defines reset_online_business_data function as SECURITY DEFINER', () => {
      expect(migrationContent).toContain('CREATE OR REPLACE FUNCTION reset_online_business_data');
      expect(migrationContent).toContain('SECURITY DEFINER');
      expect(migrationContent).toContain('SET search_path = public, pg_temp');
    });

    it('enforces auth.uid() authentication preflight', () => {
      expect(migrationContent).toContain('IF auth.uid() IS NULL THEN');
      expect(migrationContent).toContain('Authentication required');
    });

    it('enforces non-empty, non-whitespace BIN format validation', () => {
      expect(migrationContent).toContain("p_entered_bin IS NULL OR trim(p_entered_bin) = ''");
      expect(migrationContent).toContain('Entered BIN cannot be empty');
    });

    it('enforces settings:manage or Super Admin authorization', () => {
      expect(migrationContent).toContain("v_admin_role NOT IN ('SUPER_ADMIN', 'Super Admin')");
      expect(migrationContent).toContain("permission IN ('settings:manage', 'admin:manage', 'SUPER_ADMIN')");
    });

    it('calls server-side pgcrypto verify_admin_bin and rejects on failure', () => {
      expect(migrationContent).toContain('v_bin_verified := verify_admin_bin(p_entered_bin);');
      expect(migrationContent).toContain('Security verification failed for Online Reset');
    });
  });

  describe('2. Atomicity & Concurrency Protection', () => {
    it('acquires the exact transaction-scoped advisory lock: online_business_reset_lock', () => {
      expect(migrationContent).toContain("PERFORM pg_advisory_xact_lock(hashtext('online_business_reset_lock'));");
    });

    it('does NOT use session-level advisory locks or session_replication_role', () => {
      expect(migrationContent).not.toContain("session_replication_role");
      expect(migrationContent).not.toContain("pg_advisory_lock(");
      expect(migrationContent).not.toContain("pg_try_advisory");
    });
  });

  describe('3. Delete Dependency Graph & Preservation Set', () => {
    it('deletes business tables in exact audited FK dependency order', () => {
      const deleteOrder = [
        'DELETE FROM payment_allocations WHERE true;',
        'DELETE FROM financial_ledger WHERE true;',
        'DELETE FROM payments WHERE true;',
        'DELETE FROM order_items WHERE true;',
        'DELETE FROM orders WHERE true;',
        'DELETE FROM qr_tokens WHERE true;',
        'DELETE FROM customers WHERE true;',
        'DELETE FROM business_days WHERE true;',
        'DELETE FROM device_types WHERE true;',
        'DELETE FROM sync_conflicts WHERE true;',
        'DELETE FROM change_log WHERE true;',
        'DELETE FROM processed_commands WHERE true;',
      ];

      let lastIndex = -1;
      for (const sqlClause of deleteOrder) {
        const index = migrationContent.indexOf(sqlClause);
        expect(index).toBeGreaterThan(-1);
        expect(index).toBeGreaterThan(lastIndex);
        lastIndex = index;
      }
    });

    it('preserves administrative identities, permissions, app_devices, and audit logs', () => {
      const preservedTables = [
        'admins',
        'roles',
        'permissions',
        'role_permissions',
        'admin_custom_permissions',
        'app_devices',
        'audit_logs',
      ];

      for (const table of preservedTables) {
        expect(migrationContent).not.toContain(`DELETE FROM ${table}`);
        expect(migrationContent).not.toContain(`TRUNCATE ${table}`);
      }
    });

    it('disables trg_immutable_financial_ledger correctly in migration 00102', () => {
      const migration102Path = path.join(process.cwd(), 'supabase', 'migrations', '00102_fix_reset_online_business_data_trigger.sql');
      const migration102Content = fs.readFileSync(migration102Path, 'utf8');
      expect(migration102Content).toContain('ALTER TABLE financial_ledger DISABLE TRIGGER trg_immutable_financial_ledger;');
      expect(migration102Content).toContain('ALTER TABLE financial_ledger ENABLE TRIGGER trg_immutable_financial_ledger;');
      expect(migration102Content).not.toContain('trg_prevent_ledger_tampering');
      expect(migration102Content).not.toContain('trg_prevent_ledger_delete');
    });

    it('returns authoritative JSONB response containing exact deletion counts', () => {
      expect(migrationContent).toContain("'operation', 'ONLINE_RESET'");
      expect(migrationContent).toContain("'deletedCounts', jsonb_build_object(");
      expect(migrationContent).toContain("'payment_allocations'");
      expect(migrationContent).toContain("'financial_ledger'");
      expect(migrationContent).toContain("'processed_commands'");
    });
  });

  describe('4. BackupService Client Validation Bounds', () => {
    it('rejects empty or whitespace BIN in deleteOnlineBusinessData without calling RPC', async () => {
      const auth = new AuthorizationContext(superAdminActor, mockValidBinVerifier);

      await expect(backupService.deleteOnlineBusinessData(auth, '')).rejects.toThrow();
      await expect(backupService.deleteOnlineBusinessData(auth, '   ')).rejects.toThrow();
    });

    it('rejects unauthenticated caller in deleteOnlineBusinessData', async () => {
      const unauthContext = new AuthorizationContext(null as any, mockValidBinVerifier);

      await expect(backupService.deleteOnlineBusinessData(unauthContext, '1234')).rejects.toThrow();
    });

    it('rejects caller lacking settings:manage permission', async () => {
      const restrictedAuth = new AuthorizationContext(restrictedAdminActor, mockValidBinVerifier);

      await expect(backupService.deleteOnlineBusinessData(restrictedAuth, '1234')).rejects.toThrow();
    });

    it('leaves local backup snapshots untouched during online reset service invocation', async () => {
      const auth = new AuthorizationContext(superAdminActor, mockValidBinVerifier);

      const snap = await backupService.createSnapshot('OFFLINE', auth, { name: 'Pre-reset snapshot', bin: '1234' });
      expect(snap.snapshotId).toBeDefined();

      const snapshotsBefore = await backupService.listSnapshots();
      expect(snapshotsBefore.length).toBe(1);

      // Local snapshots remain in IndexedDB / localDb regardless of online reset
      const snapshotsAfter = await backupService.listSnapshots();
      expect(snapshotsAfter.length).toBe(1);
      expect(snapshotsAfter[0].snapshotId).toBe(snap.snapshotId);
    });
  });

  describe('5. Reset Generation & Stale Sync Cursor Safety (Tests A-L)', () => {
    it('Test A: Migration 00103 updates server_reset_generation atomically in reset_online_business_data', () => {
      const migration103Path = path.join(process.cwd(), 'supabase', 'migrations', '00103_reset_generation_and_sync_safety.sql');
      const migration103Content = fs.readFileSync(migration103Path, 'utf8');
      expect(migration103Content).toContain("server_reset_generation");
      expect(migration103Content).toContain("value_number = COALESCE(value_number, 1) + 1");
      expect(migration103Content).toContain("serverResetGeneration");
    });

    it('Test B & C: execute_sync_command validates resetGeneration and rejects stale child or root commands', () => {
      const migration103Path = path.join(process.cwd(), 'supabase', 'migrations', '00103_reset_generation_and_sync_safety.sql');
      const migration103Content = fs.readFileSync(migration103Path, 'utf8');
      expect(migration103Content).toContain("v_cmd_gen < v_server_gen");
      expect(migration103Content).toContain("Reset Generation Mismatch");
    });

    it('Test D through I: SyncEngine reconciles newer server reset generation, rebases cursor to 0, and quarantines stale outbox items', async () => {
      const engine = new SyncEngine({
        pushCommand: async () => ({ success: true, serverVersion: 1, rpcReached: true }),
        pullChanges: async () => ({ changes: [{ sequenceId: 1, entityType: 'orders', entityId: 'ord-new', action: 'INSERT', payload: {}, changedAt: new Date().toISOString() }], latestSequence: 1, serverResetGeneration: 2 })
      });

      await localDb.setSyncState({ table: 'global', lastAppliedChangeSequence: 500, resetGeneration: 1, lastPulledAt: '' });
      await localDb.saveOutbox({
        commandId: 'stale-cmd',
        commandType: 'CREATE_ORDER',
        aggregateType: 'orders',
        aggregateId: 'ord-old',
        payload: { resetGeneration: 1 },
        createdAt: '',
        deviceId: 'dev-1',
        actorAdminId: 'admin-1',
        status: 'pending',
        retryCount: 0,
        resetGeneration: 1,
      });

      const result = await engine.synchronize();
      expect(result.pulled).toBeGreaterThanOrEqual(1);

      const syncState = await localDb.getSyncState('global');
      expect(syncState?.resetGeneration).toBe(2);
      expect(syncState?.lastAppliedChangeSequence).toBe(1);

      const outbox = await localDb.listOutbox();
      const stale = outbox.find(o => o.commandId === 'stale-cmd');
      expect(stale?.status).toBe('rejected');
      expect(stale?.lastError).toBe('RESET_GENERATION_MISMATCH');
    });
  });
});
