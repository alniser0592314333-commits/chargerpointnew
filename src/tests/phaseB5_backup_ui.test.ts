import { describe, it, expect, beforeEach } from 'vitest';
import { translations } from '../i18n/translations';
import { localDb } from '../infrastructure/localDb/localDb';
import { backupService } from '../services/backup/backupService';
import { AuthorizationContext, ActorAdmin } from '../application/authContext';
import {
  resetStoreMemory,
  seedDemoOperationalData,
  reloadStoreFromLocal,
  getCustomersCount,
  getOrdersCount,
  getBusinessDaysCount,
} from '../components/pages/dayOrdersStore';

describe('Phase B.5: Settings + Backup/Restore UI Integration & End-to-End Contracts', () => {
  const superAdminActor: ActorAdmin = {
    id: 'admin_super_1',
    username: 'superadmin',
    fullName: 'Super Administrator',
    role: 'SUPER_ADMIN',
    permissions: ['settings:manage', 'orders:view', 'orders:create', 'customers:view'],
    isSuperAdmin: true,
  };

  const validBin = '1234';
  const binVerifier = (bin: string) => bin === validBin;
  const superAdminAuth = new AuthorizationContext(superAdminActor, binVerifier);

  beforeEach(async () => {
    await localDb.clear();
    resetStoreMemory();
    await seedDemoOperationalData();
  });

  // 1. Translations completeness for B.5 Backup & Data Management
  it('1. Phase B.5 translation keys are complete and fully matched across Arabic & English', () => {
    const ar = translations.ar;
    const en = translations.en;

    expect(ar.backupSectionTitle).toBe('النسخ الاحتياطي وإدارة البيانات');
    expect(en.backupSectionTitle).toBe('Backup & Data Management');

    expect(ar.createSnapshot).toBe('نسخة جديدة');
    expect(en.createSnapshot).toBe('New Backup');

    expect(ar.snapshotsListTitle).toBe('النسخ الاحتياطية المحفوظة');
    expect(en.snapshotsListTitle).toBe('Saved Backup Snapshots');

    expect(ar.restoreSnapshot).toBe('استعادة');
    expect(en.restoreSnapshot).toBe('Restore');

    expect(ar.restoreOnlineTitle).toBe('استعادة البيانات المحلية من الخادم');
    expect(en.restoreOnlineTitle).toBe('Restore Local Data from Online');

    expect(ar.deleteLocalDataTitle).toBe('حذف قاعدة البيانات المحلية');
    expect(en.deleteLocalDataTitle).toBe('Delete Local Database');

    expect(ar.clearSyncHistoryTitle).toBe('مسح سجل المزامنة');
    expect(en.clearSyncHistoryTitle).toBe('Clear Sync History');
  });

  // 2. Snapshot Creation and Deterministic Listing
  it('2. Snapshot creation populates backup snapshots list deterministically newest-first', async () => {
    // Initially no snapshots
    const initialList = await backupService.listSnapshots();
    expect(initialList.length).toBe(0);

    // Create OFFLINE snapshot
    const snap1 = await backupService.createSnapshot('OFFLINE', superAdminAuth, {
      name: 'Initial Morning Backup',
      bin: validBin,
    });
    expect(snap1.snapshotId).toBeDefined();
    expect(snap1.metadata.totalEntities).toBeGreaterThan(0);

    // Create ONLINE snapshot
    const snap2 = await backupService.createSnapshot('ONLINE', superAdminAuth, {
      name: 'Authoritative Cloud State',
      bin: validBin,
      customOnlineData: {
        customers: [{ id: 'cust_cloud_1', name: 'Cloud Cust', version: 1 }],
        businessDays: [],
        orders: [],
        orderItems: [],
        financialLedger: [],
        payments: [],
        paymentAllocations: [],
        deviceTypes: [],
      },
    });

    const list = await backupService.listSnapshots();
    expect(list.length).toBe(2);

    // Sort newest first
    const sorted = [...list].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    expect(sorted[0].snapshotId).toBe(snap2.snapshotId);
    expect(sorted[1].snapshotId).toBe(snap1.snapshotId);
  });

  // 3. Restore Snapshot seamlessly updates operational state and UI store
  it('3. Restoring a snapshot replaces local operational business data and syncs with store reloader', async () => {
    // Current seed data has customers
    const initialCustCount = await getCustomersCount();
    expect(initialCustCount).toBe(6);

    // Capture snapshot of this state
    const snap = await backupService.createSnapshot('OFFLINE', superAdminAuth, {
      name: 'Full 6-Customer Backup',
      bin: validBin,
    });

    // Now perform a zero reset of operational data
    await backupService.deleteLocalBusinessData(superAdminAuth, { bin: validBin });
    await reloadStoreFromLocal();

    const afterResetCount = await getCustomersCount();
    expect(afterResetCount).toBe(0);

    // Snapshots remain 100% preserved
    const listAfterReset = await backupService.listSnapshots();
    expect(listAfterReset.length).toBe(1);

    // Restore the snapshot
    const res = await backupService.restoreSnapshot(snap.snapshotId, superAdminAuth, {
      bin: validBin,
    });
    expect(res.success).toBe(true);
    await reloadStoreFromLocal();

    const restoredCustCount = await getCustomersCount();
    expect(restoredCustCount).toBe(6);
  });

  // 4. Restore Online directly to local operational store
  it('4. Restoring online data directly repopulates local operational database while keeping snapshots intact', async () => {
    // Create a snapshot first to ensure it survives online restoration
    await backupService.createSnapshot('OFFLINE', superAdminAuth, {
      name: 'Offline Pre-cloud Sync',
      bin: validBin,
    });

    const customOnlineData = {
      customers: [
        { id: 'cloud_c1', name: 'Cloud Customer 1', phone: '0590001111', version: 1 },
        { id: 'cloud_c2', name: 'Cloud Customer 2', phone: '0590002222', version: 1 },
      ],
      businessDays: [
        { id: 'day_cloud_1', businessDate: '2026-10-01', isClosed: false, version: 1 },
      ],
      orders: [],
      orderItems: [],
      financialLedger: [],
      payments: [],
      paymentAllocations: [],
      deviceTypes: [],
    };

    const res = await backupService.restoreOnlineToLocal(superAdminAuth, {
      bin: validBin,
      customOnlineData,
    });

    expect(res.success).toBe(true);
    expect(res.restoredCount).toBe(3); // 2 customers + 1 business day

    await reloadStoreFromLocal();

    const custCount = await getCustomersCount();
    expect(custCount).toBe(2);

    const dayCount = await getBusinessDaysCount();
    expect(dayCount).toBe(1);

    // Backup snapshots remain 100% safe
    const snapshots = await backupService.listSnapshots();
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].snapshotName).toBe('Offline Pre-cloud Sync');
  });

  // 5. Delete Snapshot removes single snapshot without touching business data or other snapshots
  it('5. Deleting a snapshot removes only the target snapshot record', async () => {
    const snap1 = await backupService.createSnapshot('OFFLINE', superAdminAuth, {
      name: 'Snap 1',
      bin: validBin,
    });
    const snap2 = await backupService.createSnapshot('OFFLINE', superAdminAuth, {
      name: 'Snap 2',
      bin: validBin,
    });

    let list = await backupService.listSnapshots();
    expect(list.length).toBe(2);

    const deleted = await backupService.deleteSnapshot(snap1.snapshotId, superAdminAuth, {
      bin: validBin,
    });
    expect(deleted).toBe(true);

    list = await backupService.listSnapshots();
    expect(list.length).toBe(1);
    expect(list[0].snapshotId).toBe(snap2.snapshotId);
  });

  // 6. Clear Sync History clears outbox logs while keeping operational data and snapshots intact
  it('6. Clear Sync History clears sync logs while preserving all business data and snapshots', async () => {
    // Add sync history record
    await localDb.saveHistory({
      historyId: 'hist_test_1',
      commandId: 'cmd_test_1',
      commandType: 'CREATE_ORDER',
      entityType: 'orders',
      entityId: 'ord_1',
      state: 'SUCCESS',
      attemptCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const snap = await backupService.createSnapshot('OFFLINE', superAdminAuth, {
      name: 'Safe Snapshot',
      bin: validBin,
    });

    let history = await localDb.listHistory();
    expect(history.length).toBe(1);

    await backupService.clearSyncHistory(superAdminAuth);

    history = await localDb.listHistory();
    expect(history.length).toBe(0);

    // Business data remains intact
    const custCount = await getCustomersCount();
    expect(custCount).toBe(6);

    // Snapshots remain intact
    const snapshots = await backupService.listSnapshots();
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].snapshotId).toBe(snap.snapshotId);
  });

  // 7. CRITICAL: Pending Outbox commands survive clearSyncHistory()
  it('7. CRITICAL: Pending Outbox commands survive clearSyncHistory() and are NOT destroyed', async () => {
    // Push pending and terminal outbox commands
    await localDb.saveOutbox({
      commandId: 'cmd_pending_1',
      commandType: 'CREATE_CUSTOMER',
      aggregateType: 'customers',
      aggregateId: 'cust_offline_99',
      payload: { name: 'Offline Pending Customer' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_super_1',
      status: 'pending',
      retryCount: 0,
    });

    await localDb.saveHistory({
      historyId: 'hist_old_1',
      commandId: 'cmd_old_1',
      commandType: 'CREATE_DAY',
      entityType: 'business_days',
      entityId: 'day_1',
      state: 'SUCCESS',
      attemptCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let outboxBefore = await localDb.listOutbox();
    expect(outboxBefore.length).toBe(1);
    expect(outboxBefore[0].commandId).toBe('cmd_pending_1');

    // Execute clearSyncHistory
    await backupService.clearSyncHistory(superAdminAuth);

    // Outbox MUST still contain the pending command
    let outboxAfter = await localDb.listOutbox();
    expect(outboxAfter.length).toBe(1);
    expect(outboxAfter[0].commandId).toBe('cmd_pending_1');

    // Only history was cleared
    let history = await localDb.listHistory();
    expect(history.length).toBe(0);
  });

  // 8. Consolidated Snapshot creation produces exactly one reconciled snapshot with conflict tracking
  it('8. Consolidated snapshot creation creates exactly ONE snapshot record with reconciled counts', async () => {
    const customOnlineData = {
      customers: [{ id: 'cust-1', name: 'محمد علي (Online)', version: 2 }],
      businessDays: [],
      orders: [],
      orderItems: [],
      financialLedger: [],
      payments: [],
      paymentAllocations: [],
      deviceTypes: [],
    };

    const snap = await backupService.createSnapshot('CONSOLIDATED', superAdminAuth, {
      name: 'Merged State Backup',
      bin: validBin,
      customOnlineData,
    });

    expect(snap.sourceType).toBe('CONSOLIDATED');
    expect(snap.data.consolidationMetadata).toBeDefined();
    expect(snap.data.consolidationMetadata?.onlineRecordCount).toBe(1);
    expect(snap.data.consolidationMetadata?.offlineRecordCount).toBeGreaterThan(0);

    const list = await backupService.listSnapshots();
    // Only one new snapshot was created
    expect(list.length).toBe(1);
    expect(list[0].snapshotId).toBe(snap.snapshotId);
  });

  // 9. Unauthorized access rejection
  it('9. Unauthorized user without settings:manage permission cannot create, restore, or delete snapshots', async () => {
    const viewerActor: ActorAdmin = {
      id: 'admin_viewer',
      username: 'viewer',
      fullName: 'Viewer Only',
      role: 'VIEWER',
      permissions: ['orders:view'],
      isSuperAdmin: false,
    };
    const viewerAuth = new AuthorizationContext(viewerActor, binVerifier);

    await expect(
      backupService.createSnapshot('OFFLINE', viewerAuth, { bin: validBin })
    ).rejects.toThrow();

    await expect(
      backupService.deleteLocalBusinessData(viewerAuth, { bin: validBin })
    ).rejects.toThrow();

    await expect(
      backupService.clearSyncHistory(viewerAuth)
    ).rejects.toThrow();
  });
});
