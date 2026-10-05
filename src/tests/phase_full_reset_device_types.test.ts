import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  getAllDeviceTypes,
  addDeviceTypeWithPhase5,
  deleteDeviceTypeWithPhase5,
  getDefaultDevices,
  resetStoreMemory,
  clearAllOperationalData,
  reloadStoreFromLocal,
  ensureStoreHydrated,
  getCustomersCount,
  getOrdersCount,
  getBusinessDaysCount,
  getLedgerCount,
} from '../components/pages/dayOrdersStore';
import { localDb } from '../infrastructure/localDb/localDb';
import { backupService } from '../services/backup/backupService';
import { AuthorizationContext, ActorAdmin } from '../application/authContext';

describe('FULL RESET CORRECTION — DEVICE TYPES ZERO & ONLINE RESET RPC', () => {
  const migration00022Path = path.join(process.cwd(), 'supabase', 'migrations', '00022_fix_online_reset_where_clause_and_device_types.sql');
  const migration00022Content = fs.readFileSync(migration00022Path, 'utf8');

  const superAdminActor: ActorAdmin = {
    id: '00000000-0000-0000-0000-000000000001',
    username: 'superadmin',
    fullName: 'Super Admin',
    role: 'SUPER_ADMIN',
    permissions: ['settings:manage', 'admin:manage'],
    isSuperAdmin: true,
  };

  const mockValidBinVerifier = async (bin: string) => bin === '1234' || bin === '123456';

  beforeEach(async () => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
    await clearAllOperationalData();
  });

  describe('Part 1 & 2 & 7 & 11: Migration 00022 — Online Reset RPC & WHERE Clause Fix', () => {
    it('A. Fixes SQLSTATE 21000 by adding explicit WHERE true to all DELETE statements', () => {
      expect(migration00022Content).toContain('DELETE FROM payment_allocations WHERE true;');
      expect(migration00022Content).toContain('DELETE FROM financial_ledger WHERE true;');
      expect(migration00022Content).toContain('DELETE FROM payments WHERE true;');
      expect(migration00022Content).toContain('DELETE FROM order_items WHERE true;');
      expect(migration00022Content).toContain('DELETE FROM orders WHERE true;');
      expect(migration00022Content).toContain('DELETE FROM qr_tokens WHERE true;');
      expect(migration00022Content).toContain('DELETE FROM customers WHERE true;');
      expect(migration00022Content).toContain('DELETE FROM business_days WHERE true;');
      expect(migration00022Content).toContain('DELETE FROM device_types WHERE true;');
      expect(migration00022Content).toContain('DELETE FROM sync_conflicts WHERE true;');
      expect(migration00022Content).toContain('DELETE FROM change_log WHERE true;');
      expect(migration00022Content).toContain('DELETE FROM processed_commands WHERE true;');
    });

    it('B & C. Includes device_types in Online Full Reset scope returning 0', () => {
      expect(migration00022Content).toContain('DELETE FROM device_types WHERE true;');
      expect(migration00022Content).toContain("'device_types', v_count_device_types");
    });

    it('P & Q. Preserves Security: Auth, BIN verification, settings:manage, and Advisory Lock', () => {
      expect(migration00022Content).toContain('IF auth.uid() IS NULL THEN');
      expect(migration00022Content).toContain("p_entered_bin IS NULL OR trim(p_entered_bin) = ''");
      expect(migration00022Content).toContain('v_bin_verified := verify_admin_bin(p_entered_bin);');
      expect(migration00022Content).toContain("PERFORM pg_advisory_xact_lock(hashtext('online_business_reset_lock'));");
    });
  });

  describe('Part 3 & 4 & 5 & 8 & 9: Local Full Reset & Device Types Zero State', () => {
    it('D, E & J. getDefaultDevices returns empty array [] and Local Reset results in deviceTypes = 0', async () => {
      expect(getDefaultDevices()).toEqual([]);

      resetStoreMemory();
      const list = await getAllDeviceTypes();
      expect(list.length).toBe(0);
    });

    it('F, G, H & I. Reload, restart, and ensureStoreHydrated maintain deviceTypes = 0', async () => {
      resetStoreMemory();
      await ensureStoreHydrated();
      expect((await getAllDeviceTypes()).length).toBe(0);

      await reloadStoreFromLocal();
      expect((await getAllDeviceTypes()).length).toBe(0);
    });

    it('K. deletedDeviceTypeMarkers is reset to 0 during Local Reset', async () => {
      await localDb.recordIntentionalDeviceTypeDeletion('dev-test');
      expect(await localDb.isDeviceTypeIntentionallyDeleted('dev-test')).toBe(true);

      await clearAllOperationalData();

      const markers = await localDb.listIntentionalDeviceTypeDeletions();
      expect(markers.length).toBe(0);
    });

    it('Part 6 & 9. Local Operational Counts = 0 and Snapshots preserved', async () => {
      const auth = new AuthorizationContext(superAdminActor, mockValidBinVerifier);
      const snap = await backupService.createSnapshot('OFFLINE', auth, { name: 'Test Snapshot', bin: '1234' });

      resetStoreMemory();

      expect(await getCustomersCount()).toBe(0);
      expect(await getOrdersCount()).toBe(0);
      expect(await getBusinessDaysCount()).toBe(0);
      expect(await getLedgerCount()).toBe(0);
      expect((await getAllDeviceTypes()).length).toBe(0);

      const snapshots = await backupService.listSnapshots();
      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots.some((s) => s.snapshotId === snap.snapshotId)).toBe(true);
    });
  });

  describe('Part 4 & 10: Manual Device Creation and Hard Delete', () => {
    it('L. User can manually add device types after Full Reset', async () => {
      resetStoreMemory();
      expect((await getAllDeviceTypes()).length).toBe(0);

      const res = await addDeviceTypeWithPhase5('جهاز جديد مضاف يدويًا', 3500);
      expect(res.success).toBe(true);

      const list = await getAllDeviceTypes();
      expect(list.length).toBe(1);
      expect(list[0].name).toBe('جهاز جديد مضاف يدويًا');
    });

    it('M. Hard Delete Device Type works cleanly for unreferenced devices', async () => {
      resetStoreMemory();
      const addRes = await addDeviceTypeWithPhase5('جهاز مؤقت للحذف', 4000);
      const deviceId = addRes.data!.id;

      expect((await getAllDeviceTypes()).length).toBe(1);

      const delRes = await deleteDeviceTypeWithPhase5(deviceId);
      expect(delRes.success).toBe(true);

      expect((await getAllDeviceTypes()).length).toBe(0);
    });
  });
});
