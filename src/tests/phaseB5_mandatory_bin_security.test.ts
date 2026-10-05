import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { backupService } from '../services/backup/backupService';
import { AuthorizationContext, ActorAdmin } from '../application/authContext';
import {
  AuthorizationError,
  BinRequiredError,
  InsufficientPermissionError,
} from '../domain/errors';

describe('Security Audit: Mandatory Closed-Door BIN Enforcement on Backup Operations', () => {
  const superAdminActor: ActorAdmin = {
    id: 'admin_super_sec_1',
    username: 'superadmin',
    fullName: 'Super Administrator',
    role: 'SUPER_ADMIN',
    permissions: ['settings:manage', 'orders:view', 'orders:create', 'customers:view'],
    isSuperAdmin: true,
  };

  const unauthorizedActor: ActorAdmin = {
    id: 'admin_reg_unauth',
    username: 'regular_admin',
    fullName: 'Regular Admin',
    role: 'ADMIN',
    permissions: ['orders:view'],
    isSuperAdmin: false,
  };

  const validBin = '1234';
  const binVerifier = (bin: string) => bin === validBin;

  const superAdminAuth = new AuthorizationContext(superAdminActor, binVerifier);
  const unauthorizedAuth = new AuthorizationContext(unauthorizedActor, binVerifier);
  const unauthenticatedAuth = new AuthorizationContext(null, binVerifier);

  beforeEach(async () => {
    await localDb.clear();
    await localDb.set('customers', 'cust_init', { id: 'cust_init', name: 'Initial Customer' });
    await localDb.set('orders', 'ord_init', { id: 'ord_init', total: 100 });
  });

  // -------------------------------------------------------------
  // 1. DIRECT SERVICE SECURITY BOUNDARY (No UI Bypass)
  // -------------------------------------------------------------
  describe('Direct Service Boundary: Missing / Empty / Whitespace BIN Rejection', () => {
    it('1. createSnapshot rejects when bin is undefined, empty, or whitespace', async () => {
      // undefined
      await expect(
        backupService.createSnapshot('OFFLINE', superAdminAuth, { name: 'Test', bin: undefined })
      ).rejects.toThrow(BinRequiredError);

      // missing options
      await expect(
        backupService.createSnapshot('OFFLINE', superAdminAuth)
      ).rejects.toThrow(BinRequiredError);

      // empty string
      await expect(
        backupService.createSnapshot('OFFLINE', superAdminAuth, { name: 'Test', bin: '' })
      ).rejects.toThrow(BinRequiredError);

      // whitespace
      await expect(
        backupService.createSnapshot('OFFLINE', superAdminAuth, { name: 'Test', bin: '   ' })
      ).rejects.toThrow(BinRequiredError);

      // null as any
      await expect(
        backupService.createSnapshot('OFFLINE', superAdminAuth, { name: 'Test', bin: null as any })
      ).rejects.toThrow(BinRequiredError);

      // wrong BIN
      await expect(
        backupService.createSnapshot('OFFLINE', superAdminAuth, { name: 'Test', bin: '9999' })
      ).rejects.toThrow(AuthorizationError);

      // Verify no snapshot was created in store
      const list = await backupService.listSnapshots();
      expect(list).toHaveLength(0);
    });

    it('2. deleteSnapshot rejects when bin is undefined, empty, whitespace, or wrong', async () => {
      // First create a snapshot with valid BIN
      const snap = await backupService.createSnapshot('OFFLINE', superAdminAuth, { bin: validBin });

      // undefined
      await expect(
        backupService.deleteSnapshot(snap.snapshotId, superAdminAuth, { bin: undefined })
      ).rejects.toThrow(BinRequiredError);

      // empty
      await expect(
        backupService.deleteSnapshot(snap.snapshotId, superAdminAuth, { bin: '' })
      ).rejects.toThrow(BinRequiredError);

      // whitespace
      await expect(
        backupService.deleteSnapshot(snap.snapshotId, superAdminAuth, { bin: '   ' })
      ).rejects.toThrow(BinRequiredError);

      // wrong BIN
      await expect(
        backupService.deleteSnapshot(snap.snapshotId, superAdminAuth, { bin: '0000' })
      ).rejects.toThrow(AuthorizationError);

      // Verify snapshot was NOT deleted
      const check = await backupService.getSnapshot(snap.snapshotId);
      expect(check).not.toBeNull();
    });

    it('3. restoreSnapshot rejects when bin is undefined, empty, whitespace, or wrong', async () => {
      const snap = await backupService.createSnapshot('OFFLINE', superAdminAuth, { bin: validBin });

      // Mutate live state
      await localDb.set('customers', 'cust_live', { id: 'cust_live', name: 'Live Data' });

      // undefined
      await expect(
        backupService.restoreSnapshot(snap.snapshotId, superAdminAuth, { bin: undefined })
      ).rejects.toThrow(BinRequiredError);

      // empty
      await expect(
        backupService.restoreSnapshot(snap.snapshotId, superAdminAuth, { bin: '' })
      ).rejects.toThrow(BinRequiredError);

      // whitespace
      await expect(
        backupService.restoreSnapshot(snap.snapshotId, superAdminAuth, { bin: '  ' })
      ).rejects.toThrow(BinRequiredError);

      // wrong BIN
      await expect(
        backupService.restoreSnapshot(snap.snapshotId, superAdminAuth, { bin: '8888' })
      ).rejects.toThrow(AuthorizationError);

      // Verify live state was NOT modified or restored
      const live = await localDb.get<any>('customers', 'cust_live');
      expect(live?.name).toBe('Live Data');
    });

    it('4. deleteLocalBusinessData rejects when bin is undefined, empty, whitespace, or wrong', async () => {
      // undefined
      await expect(
        backupService.deleteLocalBusinessData(superAdminAuth, { bin: undefined })
      ).rejects.toThrow(BinRequiredError);

      // empty
      await expect(
        backupService.deleteLocalBusinessData(superAdminAuth, { bin: '' })
      ).rejects.toThrow(BinRequiredError);

      // whitespace
      await expect(
        backupService.deleteLocalBusinessData(superAdminAuth, { bin: '    ' })
      ).rejects.toThrow(BinRequiredError);

      // wrong BIN
      await expect(
        backupService.deleteLocalBusinessData(superAdminAuth, { bin: '7777' })
      ).rejects.toThrow(AuthorizationError);

      // Verify operational tables were NOT wiped
      const cust = await localDb.get<any>('customers', 'cust_init');
      expect(cust).not.toBeNull();
      expect(cust?.name).toBe('Initial Customer');
    });

    it('5. restoreOnlineToLocal rejects when bin is undefined, empty, whitespace, or wrong', async () => {
      const mockOnline = {
        customers: [{ id: 'cust_on_x', name: 'Online X' }],
        businessDays: [],
        orders: [],
        orderItems: [],
        financialLedger: [],
        payments: [],
        paymentAllocations: [],
        deviceTypes: [],
      };

      // undefined
      await expect(
        backupService.restoreOnlineToLocal(superAdminAuth, {
          bin: undefined,
          customOnlineData: mockOnline,
        })
      ).rejects.toThrow(BinRequiredError);

      // empty
      await expect(
        backupService.restoreOnlineToLocal(superAdminAuth, {
          bin: '',
          customOnlineData: mockOnline,
        })
      ).rejects.toThrow(BinRequiredError);

      // whitespace
      await expect(
        backupService.restoreOnlineToLocal(superAdminAuth, {
          bin: '   ',
          customOnlineData: mockOnline,
        })
      ).rejects.toThrow(BinRequiredError);

      // wrong BIN
      await expect(
        backupService.restoreOnlineToLocal(superAdminAuth, {
          bin: '5555',
          customOnlineData: mockOnline,
        })
      ).rejects.toThrow(AuthorizationError);

      // Verify operational tables were NOT replaced
      const cust = await localDb.get<any>('customers', 'cust_init');
      expect(cust?.name).toBe('Initial Customer');
      const onCust = await localDb.get('customers', 'cust_on_x');
      expect(onCust).toBeNull();
    });
  });

  // -------------------------------------------------------------
  // 2. AUTHORIZATION & PERMISSION COMBINATIONS
  // -------------------------------------------------------------
  describe('Full Security Matrix: Authentication, Permissions, and Correct BIN', () => {
    it('requires both settings:manage permission and correct BIN', async () => {
      // 1. Unauthorized user with correct BIN is rejected by permission check
      await expect(
        backupService.createSnapshot('OFFLINE', unauthorizedAuth, { bin: validBin })
      ).rejects.toThrow(InsufficientPermissionError);

      await expect(
        backupService.deleteLocalBusinessData(unauthorizedAuth, { bin: validBin })
      ).rejects.toThrow(InsufficientPermissionError);

      // 2. Logged-out user with correct BIN is rejected by authentication check
      await expect(
        backupService.createSnapshot('OFFLINE', unauthenticatedAuth, { bin: validBin })
      ).rejects.toThrow(AuthorizationError);

      await expect(
        backupService.deleteLocalBusinessData(unauthenticatedAuth, { bin: validBin })
      ).rejects.toThrow(AuthorizationError);

      // 3. SuperAdmin with correct BIN succeeds
      const snap = await backupService.createSnapshot('OFFLINE', superAdminAuth, { bin: validBin });
      expect(snap.snapshotId).toBeDefined();

      const delRes = await backupService.deleteSnapshot(snap.snapshotId, superAdminAuth, { bin: validBin });
      expect(delRes).toBe(true);
    });
  });
});
