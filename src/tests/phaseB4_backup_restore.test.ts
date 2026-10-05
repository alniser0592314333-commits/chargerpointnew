import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  backupService,
  computeSnapshotChecksum,
  sanitizeEntity,
} from '../services/backup/backupService';
import { AuthorizationContext, ActorAdmin } from '../application/authContext';
import {
  AuthorizationError,
  InsufficientPermissionError,
  SnapshotIntegrityError,
  SnapshotFormatError,
  NotFoundError,
} from '../domain/errors';

describe('Phase B.4: Durable Backup Snapshots + Online/Offline Consolidated Backup + Restore Foundation', () => {
  const superAdminActor: ActorAdmin = {
    id: 'admin_super_1',
    username: 'superadmin',
    fullName: 'Super Administrator',
    role: 'SUPER_ADMIN',
    permissions: ['settings:manage', 'orders:view', 'orders:create', 'customers:view'],
    isSuperAdmin: true,
  };

  const regularAdminActor: ActorAdmin = {
    id: 'admin_reg_1',
    username: 'viewer',
    fullName: 'Read Only Viewer',
    role: 'VIEWER',
    permissions: ['orders:view'],
    isSuperAdmin: false,
  };

  const validBin = '1234';
  const binVerifier = (bin: string) => bin === validBin;

  const superAdminAuth = new AuthorizationContext(superAdminActor, binVerifier);
  const unauthorizedAuth = new AuthorizationContext(regularAdminActor, binVerifier);
  const unauthenticatedAuth = new AuthorizationContext(null, binVerifier);

  beforeEach(async () => {
    // Clear all storage including snapshots between test runs
    await localDb.clear();
  });

  // TEST 1 — CREATE ONLINE SNAPSHOT
  it('TEST 1 — CREATE ONLINE SNAPSHOT: creates a valid immutable snapshot from authoritative online data', async () => {
    const mockOnlineData = {
      customers: [{ id: 'cust_on_1', name: 'Online Customer', version: 1 }],
      businessDays: [{ id: 'day_on_1', date: '2026-10-01', version: 1 }],
      orders: [{ id: 'ord_on_1', dayId: 'day_on_1', customerId: 'cust_on_1', version: 1 }],
      orderItems: [{ id: 'item_on_1', orderId: 'ord_on_1', price: 50, version: 1 }],
      financialLedger: [],
      payments: [],
      paymentAllocations: [],
      deviceTypes: [{ id: 'dev_on_1', name: 'Screen', version: 1 }],
    };

    const snapshot = await backupService.createSnapshot('ONLINE', superAdminAuth, {
      customOnlineData: mockOnlineData,
      name: 'Test Online Backup 1',
      bin: validBin,
    });

    expect(snapshot).toBeDefined();
    expect(snapshot.snapshotId).toMatch(/^snap_/);
    expect(snapshot.sourceType).toBe('ONLINE');
    expect(snapshot.status).toBe('COMPLETED');
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.snapshotVersion).toBe(1);
    expect(snapshot.data.customers).toHaveLength(1);
    expect(snapshot.data.customers[0].name).toBe('Online Customer');
    expect(snapshot.metadata.totalEntities).toBe(5);
    expect(snapshot.metadata.checksum).toBeDefined();

    // Verify it is persisted in localDb
    const retrieved = await backupService.getSnapshot(snapshot.snapshotId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.snapshotId).toBe(snapshot.snapshotId);
  });

  // TEST 2 — CREATE OFFLINE SNAPSHOT
  it('TEST 2 — CREATE OFFLINE SNAPSHOT: captures current local business state from IndexedDB', async () => {
    // Seed local business entities
    await localDb.set('customers', 'cust_local_1', { id: 'cust_local_1', name: 'Local Customer', version: 1 });
    await localDb.set('orders', 'ord_local_1', { id: 'ord_local_1', total: 200, version: 1 });
    await localDb.set('businessDays', 'day_local_1', { id: 'day_local_1', date: '2026-10-02', version: 1 });

    const snapshot = await backupService.createSnapshot('OFFLINE', superAdminAuth, {
      name: 'Test Offline Backup 2',
      bin: validBin,
    });

    expect(snapshot.sourceType).toBe('OFFLINE');
    expect(snapshot.data.customers).toHaveLength(1);
    expect(snapshot.data.customers[0].name).toBe('Local Customer');
    expect(snapshot.data.orders).toHaveLength(1);
    expect(snapshot.data.businessDays).toHaveLength(1);
    expect(snapshot.metadata.totalEntities).toBe(3);
  });

  // TEST 3 — MULTIPLE SNAPSHOTS
  it('TEST 3 — MULTIPLE SNAPSHOTS: supports multiple independent snapshots ordered by createdAt descending', async () => {
    await localDb.set('customers', 'c1', { id: 'c1', name: 'Customer 1' });
    const snap1 = await backupService.createSnapshot('OFFLINE', superAdminAuth, { name: 'Backup Alpha', bin: validBin });

    // Small delay to ensure distinct creation times
    await new Promise((r) => setTimeout(r, 15));

    await localDb.set('customers', 'c2', { id: 'c2', name: 'Customer 2' });
    const snap2 = await backupService.createSnapshot('OFFLINE', superAdminAuth, { name: 'Backup Beta', bin: validBin });

    const list = await backupService.listSnapshots();
    expect(list).toHaveLength(2);
    expect(list[0].snapshotId).toBe(snap2.snapshotId); // Beta is newer
    expect(list[1].snapshotId).toBe(snap1.snapshotId); // Alpha is older

    // Verify both are independently accessible
    const fetch1 = await backupService.getSnapshot(snap1.snapshotId);
    const fetch2 = await backupService.getSnapshot(snap2.snapshotId);
    expect(fetch1?.snapshotName).toBe('Backup Alpha');
    expect(fetch2?.snapshotName).toBe('Backup Beta');
  });

  // TEST 4 — SNAPSHOT IMMUTABILITY
  it('TEST 4 — SNAPSHOT IMMUTABILITY: snapshot data remains unchanged when live business data changes', async () => {
    await localDb.set('customers', 'cust_immut', { id: 'cust_immut', name: 'Original Name' });
    const snap = await backupService.createSnapshot('OFFLINE', superAdminAuth, { bin: validBin });

    // Now modify the live local business data
    await localDb.set('customers', 'cust_immut', { id: 'cust_immut', name: 'Mutated Live Name' });
    await localDb.set('customers', 'cust_new', { id: 'cust_new', name: 'Brand New Customer' });

    // Retrieve snapshot from persistent store
    const retrieved = await backupService.getSnapshot(snap.snapshotId);
    expect(retrieved?.data.customers).toHaveLength(1);
    expect(retrieved?.data.customers[0].name).toBe('Original Name'); // Invariant: Unchanged!
  });

  // TEST 5 — DELETE LOCAL DATA DOES NOT DELETE SNAPSHOTS
  it('TEST 5 — DELETE LOCAL DATA DOES NOT DELETE SNAPSHOTS: snapshots survive local business data reset', async () => {
    await localDb.set('customers', 'c_to_delete', { id: 'c_to_delete', name: 'Will be deleted' });
    const snapshot = await backupService.createSnapshot('OFFLINE', superAdminAuth, { bin: validBin });

    // Delete local business data
    await backupService.deleteLocalBusinessData(superAdminAuth, { bin: validBin });

    // Live operational table is empty
    const customers = await localDb.list('customers');
    expect(customers).toHaveLength(0);

    // But the backup snapshot STILL exists and is intact!
    const preservedSnapshot = await backupService.getSnapshot(snapshot.snapshotId);
    expect(preservedSnapshot).not.toBeNull();
    expect(preservedSnapshot?.data.customers[0].name).toBe('Will be deleted');
  });

  // TEST 6 — CLEAR SYNC HISTORY DOES NOT DELETE SNAPSHOTS
  it('TEST 6 — CLEAR SYNC HISTORY DOES NOT DELETE SNAPSHOTS: snapshots survive SyncHistory clearing', async () => {
    await localDb.saveHistory({
      historyId: 'h1',
      commandId: 'cmd1',
      commandType: 'TEST',
      entityType: 'test',
      entityId: 't1',
      state: 'SUCCESS',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attemptCount: 1,
    });

    const snap = await backupService.createSnapshot('OFFLINE', superAdminAuth, { bin: validBin });

    // Clear sync history
    await backupService.clearSyncHistory(superAdminAuth);

    const historyList = await localDb.listHistory();
    expect(historyList).toHaveLength(0);

    // Snapshot is preserved
    const retrieved = await backupService.getSnapshot(snap.snapshotId);
    expect(retrieved).not.toBeNull();
  });

  // TEST 7 — RESTORE SNAPSHOT
  it('TEST 7 — RESTORE SNAPSHOT: restores snapshot content into local operational state', async () => {
    // Seed initial state A
    await localDb.set('customers', 'cust_A', { id: 'cust_A', name: 'State A Customer' });
    await localDb.set('orders', 'ord_A', { id: 'ord_A', total: 500 });
    const snapA = await backupService.createSnapshot('OFFLINE', superAdminAuth, { name: 'Snapshot A', bin: validBin });

    // Mutate state to B
    await localDb.set('customers', 'cust_A', { id: 'cust_A', name: 'State B Mutated Customer' });
    await localDb.set('customers', 'cust_B_only', { id: 'cust_B_only', name: 'Only in State B' });
    await localDb.remove('orders', 'ord_A');

    // Restore Snapshot A
    const restoreResult = await backupService.restoreSnapshot(snapA.snapshotId, superAdminAuth, { bin: validBin });
    expect(restoreResult.success).toBe(true);

    // Verify local operational state returned strictly to Snapshot A
    const restoredCustA = await localDb.get<any>('customers', 'cust_A');
    const restoredCustB = await localDb.get<any>('customers', 'cust_B_only');
    const restoredOrdA = await localDb.get<any>('orders', 'ord_A');

    expect(restoredCustA?.name).toBe('State A Customer');
    expect(restoredCustB).toBeNull(); // B-only entity was safely cleared
    expect(restoredOrdA?.total).toBe(500); // Ord A restored
  });

  // TEST 8 — RESTORE DOES NOT DELETE SNAPSHOT
  it('TEST 8 — RESTORE DOES NOT DELETE SNAPSHOT: snapshot record remains in store after being restored', async () => {
    await localDb.set('customers', 'cust_1', { id: 'cust_1', name: 'Customer' });
    const snap = await backupService.createSnapshot('OFFLINE', superAdminAuth, { bin: validBin });

    await backupService.restoreSnapshot(snap.snapshotId, superAdminAuth, { bin: validBin });

    // Snapshot must still exist in backupSnapshots
    const stillExists = await backupService.getSnapshot(snap.snapshotId);
    expect(stillExists).not.toBeNull();
    expect(stillExists?.snapshotId).toBe(snap.snapshotId);
  });

  // TEST 9 — DELETE ONE SNAPSHOT
  it('TEST 9 — DELETE ONE SNAPSHOT: deleting a specific snapshot does not affect other snapshots or business data', async () => {
    await localDb.set('customers', 'c_persist', { id: 'c_persist', name: 'Business Data' });

    const snapA = await backupService.createSnapshot('OFFLINE', superAdminAuth, { name: 'A', bin: validBin });
    const snapB = await backupService.createSnapshot('OFFLINE', superAdminAuth, { name: 'B', bin: validBin });

    // Explicitly delete only Snapshot A
    const deleted = await backupService.deleteSnapshot(snapA.snapshotId, superAdminAuth, { bin: validBin });
    expect(deleted).toBe(true);

    // Snap A is gone
    const checkA = await backupService.getSnapshot(snapA.snapshotId);
    expect(checkA).toBeNull();

    // Snap B remains intact
    const checkB = await backupService.getSnapshot(snapB.snapshotId);
    expect(checkB).not.toBeNull();

    // Business data is untouched
    const businessCustomer = await localDb.get<any>('customers', 'c_persist');
    expect(businessCustomer?.name).toBe('Business Data');
  });

  // TEST 10 — MULTIPLE DEPENDENCIES / BUSINESS RELATIONSHIPS
  it('TEST 10 — MULTIPLE RELATIONSHIPS: preserves relational integrity across orders, days, items, and customers', async () => {
    const day = { id: 'day_rel', date: '2026-10-10' };
    const cust = { id: 'cust_rel', name: 'Relational Customer' };
    const order = { id: 'ord_rel', dayId: 'day_rel', customerId: 'cust_rel', total: 100 };
    const item = { id: 'item_rel', orderId: 'ord_rel', deviceTypeId: 'dev_rel' };
    const dev = { id: 'dev_rel', name: 'Charger' };

    await localDb.set('businessDays', day.id, day);
    await localDb.set('customers', cust.id, cust);
    await localDb.set('orders', order.id, order);
    await localDb.set('orderItems', item.id, item);
    await localDb.set('deviceTypes', dev.id, dev);

    const snapshot = await backupService.createSnapshot('OFFLINE', superAdminAuth, { bin: validBin });

    // Verify all relational links are correctly captured
    const d = snapshot.data;
    expect(d.orders[0].dayId).toBe(day.id);
    expect(d.orders[0].customerId).toBe(cust.id);
    expect(d.orderItems[0].orderId).toBe(order.id);
    expect(d.orderItems[0].deviceTypeId).toBe(dev.id);
  });

  // TEST 11 — CONSOLIDATED BACKUP
  it('TEST 11 — CONSOLIDATED BACKUP: merges online authoritative and offline local state into ONE snapshot', async () => {
    // Online has Customer 1 and Order 1
    const mockOnline = {
      customers: [{ id: 'cust_1', name: 'Online Cust 1', version: 1 }],
      businessDays: [{ id: 'day_1', date: '2026-10-01', version: 1 }],
      orders: [{ id: 'ord_1', total: 100, version: 1 }],
      orderItems: [],
      financialLedger: [],
      payments: [],
      paymentAllocations: [],
      deviceTypes: [],
    };

    // Offline has Customer 2 (created locally offline)
    await localDb.set('customers', 'cust_2', { id: 'cust_2', name: 'Offline Cust 2', version: 1 });
    await localDb.saveOutbox({
      commandId: 'cmd_c2',
      commandType: 'CREATE_CUSTOMER',
      aggregateType: 'customers',
      aggregateId: 'cust_2',
      payload: { id: 'cust_2', name: 'Offline Cust 2' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending',
      retryCount: 0,
    });

    const consolidated = await backupService.createSnapshot('CONSOLIDATED', superAdminAuth, {
      customOnlineData: mockOnline,
      name: 'Consolidated Backup 11',
      bin: validBin,
    });

    expect(consolidated.sourceType).toBe('CONSOLIDATED');
    expect(consolidated.data.customers).toHaveLength(2);
    // Both cust_1 (from online) and cust_2 (from offline) are present in the ONE snapshot!
    const ids = consolidated.data.customers.map((c) => c.id);
    expect(ids).toContain('cust_1');
    expect(ids).toContain('cust_2');
    expect(consolidated.metadata.recordCounts.customers).toBe(2);
  });

  // TEST 12 — CONSOLIDATED BACKUP DOES NOT SILENTLY DISCARD OFFLINE CHANGES
  it('TEST 12 — DOES NOT DISCARD OFFLINE CHANGES: records pending local offline mutations with reconciliation flag', async () => {
    const mockOnline = {
      customers: [{ id: 'cust_edit', name: 'Online Baseline Name', version: 1 }],
      businessDays: [],
      orders: [],
      orderItems: [],
      financialLedger: [],
      payments: [],
      paymentAllocations: [],
      deviceTypes: [],
    };

    // Local offline has pending edit to cust_edit based on same version 1
    await localDb.set('customers', 'cust_edit', { id: 'cust_edit', name: 'Offline Edited Name', version: 1 });
    await localDb.saveOutbox({
      commandId: 'cmd_edit_cust',
      commandType: 'UPDATE_CUSTOMER',
      aggregateType: 'customers',
      aggregateId: 'cust_edit',
      payload: { id: 'cust_edit', name: 'Offline Edited Name' },
      expectedVersion: 1,
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending',
      retryCount: 0,
    });

    const consolidated = await backupService.createSnapshot('CONSOLIDATED', superAdminAuth, {
      customOnlineData: mockOnline,
      bin: validBin,
    });

    const cust = consolidated.data.customers.find((c) => c.id === 'cust_edit');
    expect(cust).toBeDefined();
    expect(cust?.name).toBe('Offline Edited Name');
    expect(cust?._reconciliation).toBe('offline_pending');
  });

  // TEST 13 — CONSOLIDATED BACKUP DOES NOT SILENTLY OVERWRITE AUTHORITATIVE ONLINE DATA
  it('TEST 13 — DOES NOT OVERWRITE AUTHORITATIVE ONLINE DATA: flags concurrent remote modification as conflict', async () => {
    // Online was concurrently updated to version 2
    const mockOnline = {
      customers: [{ id: 'cust_conf', name: 'Server Remote Version 2', version: 2 }],
      businessDays: [],
      orders: [],
      orderItems: [],
      financialLedger: [],
      payments: [],
      paymentAllocations: [],
      deviceTypes: [],
    };

    // Local offline has un-synced edit on older version 1
    await localDb.set('customers', 'cust_conf', { id: 'cust_conf', name: 'Local Stale Version 1', version: 1 });
    await localDb.saveOutbox({
      commandId: 'cmd_stale',
      commandType: 'UPDATE_CUSTOMER',
      aggregateType: 'customers',
      aggregateId: 'cust_conf',
      payload: { id: 'cust_conf', name: 'Local Stale Version 1' },
      expectedVersion: 1,
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending',
      retryCount: 0,
    });

    const consolidated = await backupService.createSnapshot('CONSOLIDATED', superAdminAuth, {
      customOnlineData: mockOnline,
      bin: validBin,
    });

    // Invariant: Authoritative remote data is preserved and conflict is flagged
    const cust = consolidated.data.customers.find((c) => c.id === 'cust_conf');
    expect(cust?.name).toBe('Server Remote Version 2');
    expect(cust?._conflict).toBe('CONCURRENT_REMOTE_MODIFICATION');

    const meta = consolidated.data.consolidationMetadata;
    expect(meta?.unresolvedConflicts).toHaveLength(1);
    expect(meta?.unresolvedConflicts[0].entityId).toBe('cust_conf');
  });

  // TEST 13b — PREVENT OFFLINE DELETE RESURRECTION
  it('TEST 13b — PREVENT OFFLINE DELETE RESURRECTION: online entity with pending offline DELETE is not silently resurrected', async () => {
    // 1. Online has an existing customer
    const mockOnline = {
      customers: [{ id: 'cust_to_delete', name: 'Authoritative Online Customer', version: 1 }],
      businessDays: [],
      orders: [],
      orderItems: [],
      financialLedger: [],
      payments: [],
      paymentAllocations: [],
      deviceTypes: [],
    };

    // 2. Offline has deleted the customer (so customer is missing from localDb.customers),
    // and an uncommitted pending DELETE command is in the Outbox
    await localDb.saveOutbox({
      commandId: 'cmd_delete_cust_1',
      commandType: 'DELETE_CUSTOMER',
      aggregateType: 'customers',
      aggregateId: 'cust_to_delete',
      payload: { id: 'cust_to_delete', action: 'DELETE' },
      expectedVersion: 1,
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending',
      retryCount: 0,
    });

    const consolidated = await backupService.createSnapshot('CONSOLIDATED', superAdminAuth, {
      customOnlineData: mockOnline,
      bin: validBin,
    });

    // Assertions:
    // A. Entity is NOT silently restored as authoritative unchanged data
    const cust = consolidated.data.customers.find((c) => c.id === 'cust_to_delete');
    expect(cust).toBeDefined();
    expect(cust?._conflict).toBe('PENDING_OFFLINE_DELETE');
    expect(cust?._reconciliation).toBe('pending_delete');
    expect(cust?._pendingDelete).toBe(true);

    // B. Consolidation metadata records the pending deletion / conflict state
    const meta = consolidated.data.consolidationMetadata;
    expect(meta?.unresolvedConflicts).toHaveLength(1);
    expect(meta?.unresolvedConflicts[0].entityId).toBe('cust_to_delete');
    expect(meta?.unresolvedConflicts[0].reason).toContain('local pending DELETE');

    // C. The pending DELETE remains represented as pending rather than being marked successful
    const outboxCmd = await localDb.getOutbox('cmd_delete_cust_1');
    expect(outboxCmd).not.toBeNull();
    expect(outboxCmd?.status).toBe('pending');
  });

  // TEST 14 — RESTORE INTEGRITY VALIDATION
  it('TEST 14 — RESTORE INTEGRITY VALIDATION: rejects restore if snapshot checksum is invalid or tampered', async () => {
    await localDb.set('customers', 'c_orig', { id: 'c_orig', name: 'Original' });
    const snap = await backupService.createSnapshot('OFFLINE', superAdminAuth, { bin: validBin });

    // Tamper with the snapshot metadata checksum directly in storage
    const tampered = await backupService.getSnapshot(snap.snapshotId);
    if (tampered) {
      tampered.metadata.checksum = 'tampered_bad_checksum';
      await localDb.saveSnapshot(tampered);
    }

    // Attempt restore must reject with SnapshotIntegrityError
    await expect(backupService.restoreSnapshot(snap.snapshotId, superAdminAuth, { bin: validBin })).rejects.toThrow(
      SnapshotIntegrityError
    );
  });

  // TEST 15 — RESTORE FAILURE SAFETY (Pre-Write Validation)
  it('TEST 15 — RESTORE FAILURE SAFETY: current local state is not cleared if validation fails', async () => {
    // Current live business state
    await localDb.set('customers', 'c_current', { id: 'c_current', name: 'Current Live Customer' });

    // Create a corrupted snapshot with invalid entity structure
    const invalidSnapshot: any = {
      snapshotId: 'snap_corrupt_test',
      snapshotName: 'Corrupt',
      createdAt: new Date().toISOString(),
      sourceType: 'OFFLINE',
      schemaVersion: 1,
      snapshotVersion: 1,
      status: 'COMPLETED',
      metadata: { recordCounts: {}, totalEntities: 0, checksum: '' },
      data: {
        customers: 'NOT_AN_ARRAY', // Corrupt structure
        businessDays: [],
        orders: [],
        orderItems: [],
      },
    };
    invalidSnapshot.metadata.checksum = computeSnapshotChecksum(invalidSnapshot.data);
    await localDb.saveSnapshot(invalidSnapshot);

    // Attempt restore
    await expect(backupService.restoreSnapshot('snap_corrupt_test', superAdminAuth, { bin: validBin })).rejects.toThrow(
      SnapshotFormatError
    );

    // Verify current live state is NOT destroyed or cleared
    const currentCust = await localDb.get<any>('customers', 'c_current');
    expect(currentCust?.name).toBe('Current Live Customer');
  });

  // TEST 15b — ATOMIC RESTORE ROLLBACK (Mid-Write Execution Failure)
  it('TEST 15b — ATOMIC RESTORE ROLLBACK: mid-restore write failure completely rolls back operational data and preserves snapshot', async () => {
    // 1. Establish valid existing local operational state
    await localDb.set('customers', 'pre_cust_1', { id: 'pre_cust_1', name: 'Pre-existing Customer 1', version: 1 });
    await localDb.set('orders', 'pre_ord_1', { id: 'pre_ord_1', total: 100, version: 1 });
    await localDb.setSyncState({ table: 'customers', lastAppliedChangeSequence: 42, lastPulledAt: '2026-09-01T00:00:00Z' });

    // 2. Create a valid snapshot containing multiple entity groups
    await localDb.set('customers', 'snap_cust_1', { id: 'snap_cust_1', name: 'Snapshot Customer 1', version: 2 });
    await localDb.set('customers', 'snap_cust_2_fail', { id: 'snap_cust_2_fail', name: 'Failing Customer', version: 2 });
    await localDb.set('orders', 'snap_ord_1', { id: 'snap_ord_1', total: 500, version: 2 });
    const validSnapshot = await backupService.createSnapshot('OFFLINE', superAdminAuth, { name: 'Valid Rollback Test Snapshot', bin: validBin });

    // Reset local operational state to the pre-existing state
    await localDb.clearOperationalTables();
    await localDb.set('customers', 'pre_cust_1', { id: 'pre_cust_1', name: 'Pre-existing Customer 1', version: 1 });
    await localDb.set('orders', 'pre_ord_1', { id: 'pre_ord_1', total: 100, version: 1 });
    await localDb.setSyncState({ table: 'customers', lastAppliedChangeSequence: 42, lastPulledAt: '2026-09-01T00:00:00Z' });

    // 3. Inject a failure hook that throws on writing the second customer
    localDb.__setWriteHookForTesting((table, id) => {
      if (table === 'customers' && id === 'snap_cust_2_fail') {
        throw new Error('SIMULATED_WRITE_FAULT_DURING_RESTORE');
      }
    });

    try {
      // 4. Attempt restore — MUST reject because fault injection triggers mid-write
      await expect(
        backupService.restoreSnapshot(validSnapshot.snapshotId, superAdminAuth, { bin: validBin })
      ).rejects.toThrow('SIMULATED_WRITE_FAULT_DURING_RESTORE');

      // 5. Verification of atomicity and rollback:
      // - Previous operational business data remains unchanged
      const preCust = await localDb.get<any>('customers', 'pre_cust_1');
      expect(preCust).not.toBeNull();
      expect(preCust?.name).toBe('Pre-existing Customer 1');

      const preOrd = await localDb.get<any>('orders', 'pre_ord_1');
      expect(preOrd).not.toBeNull();
      expect(preOrd?.total).toBe(100);

      // - No partially restored snapshot data remains
      const snapCust1 = await localDb.get('customers', 'snap_cust_1');
      expect(snapCust1).toBeNull();
      const snapCust2 = await localDb.get('customers', 'snap_cust_2_fail');
      expect(snapCust2).toBeNull();
      const snapOrd1 = await localDb.get('orders', 'snap_ord_1');
      expect(snapOrd1).toBeNull();

      // - syncState remains the previous state
      const syncState = await localDb.getSyncState('customers');
      expect(syncState?.lastAppliedChangeSequence).toBe(42);

      // - backupSnapshots remains intact
      const snapCheck = await backupService.getSnapshot(validSnapshot.snapshotId);
      expect(snapCheck).not.toBeNull();
      expect(snapCheck?.snapshotName).toBe('Valid Rollback Test Snapshot');
    } finally {
      localDb.__setWriteHookForTesting(null);
    }
  });

  // TEST 16 — SNAPSHOT DOES NOT CONTAIN SECRETS (Unit Sanitizer)
  it('TEST 16 — SNAPSHOT DOES NOT CONTAIN SECRETS: all camelCase, snake_case, and token variations are scrubbed', async () => {
    const rawEntity = {
      id: 'cust_secret',
      name: 'Safe Customer',
      password: 'p1',
      passwordHash: 'p2',
      password_hash: 'p3',
      bin: '1234',
      binHash: 'bh1',
      binSalt: 'bs1',
      accessToken: 'at1',
      refreshToken: 'rt1',
      sessionToken: 'st1',
      secretKey: 'sk1',
      apiKey: 'ak1',
      safeKey: 'keep_me_safe',
      nested: {
        access_token: 'secret_nested_token',
        secret_key: 'nested_secret_key',
        phone: '0592314333',
      },
      nestedList: [
        { id: 'item_1', apiKey: 'inner_ak', label: 'Item 1' },
      ],
    };

    const sanitized = sanitizeEntity(rawEntity) as any;

    // Verify all specified secrets are stripped
    expect(sanitized.password).toBeUndefined();
    expect(sanitized.passwordHash).toBeUndefined();
    expect(sanitized.password_hash).toBeUndefined();
    expect(sanitized.bin).toBeUndefined();
    expect(sanitized.binHash).toBeUndefined();
    expect(sanitized.binSalt).toBeUndefined();
    expect(sanitized.accessToken).toBeUndefined();
    expect(sanitized.refreshToken).toBeUndefined();
    expect(sanitized.sessionToken).toBeUndefined();
    expect(sanitized.secretKey).toBeUndefined();
    expect(sanitized.apiKey).toBeUndefined();
    expect(sanitized.nested.access_token).toBeUndefined();
    expect(sanitized.nested.secret_key).toBeUndefined();
    expect(sanitized.nestedList[0].apiKey).toBeUndefined();

    // Verify harmless keys are preserved
    expect(sanitized.id).toBe('cust_secret');
    expect(sanitized.name).toBe('Safe Customer');
    expect(sanitized.safeKey).toBe('keep_me_safe');
    expect(sanitized.nested.phone).toBe('0592314333');
    expect(sanitized.nestedList[0].id).toBe('item_1');
    expect(sanitized.nestedList[0].label).toBe('Item 1');
  });

  // TEST 16b — PERSISTED SNAPSHOT SANITIZATION BOUNDARY
  it('TEST 16b — PERSISTED SNAPSHOT SANITIZATION BOUNDARY: secrets scrubbed from snapshot payload including consolidationMetadata', async () => {
    // Online customer with secrets
    const mockOnline = {
      customers: [
        {
          id: 'cust_with_secrets',
          name: 'Online Secret Customer',
          passwordHash: 'hash_9988',
          apiKey: 'remote_api_key_secret',
          secretKey: 'remote_secret_key',
          binSalt: 'salt_123',
          version: 2,
        },
      ],
      businessDays: [],
      orders: [],
      orderItems: [],
      financialLedger: [],
      payments: [],
      paymentAllocations: [],
      deviceTypes: [],
    };

    // Offline stale edit with local secrets
    await localDb.set('customers', 'cust_with_secrets', {
      id: 'cust_with_secrets',
      name: 'Local Secret Customer',
      sessionToken: 'local_sess_tok',
      accessToken: 'local_acc_tok',
      refreshToken: 'local_ref_tok',
      version: 1,
    });
    await localDb.saveOutbox({
      commandId: 'cmd_sec',
      commandType: 'UPDATE_CUSTOMER',
      aggregateType: 'customers',
      aggregateId: 'cust_with_secrets',
      payload: { id: 'cust_with_secrets', bin: '0000', binHash: 'secret_bin_hash' },
      expectedVersion: 1,
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending',
      retryCount: 0,
    });

    const snapshot = await backupService.createSnapshot('CONSOLIDATED', superAdminAuth, {
      customOnlineData: mockOnline,
      name: 'Sanitized Consolidated Snapshot',
      bin: validBin,
    });

    // Inspect actual persisted record from storage
    const persisted = await localDb.getSnapshot(snapshot.snapshotId);
    expect(persisted).not.toBeNull();

    const jsonString = JSON.stringify(persisted?.data);

    // Verify none of the secret keys appear anywhere in persisted JSON
    expect(jsonString).not.toContain('passwordHash');
    expect(jsonString).not.toContain('remote_api_key_secret');
    expect(jsonString).not.toContain('remote_secret_key');
    expect(jsonString).not.toContain('salt_123');
    expect(jsonString).not.toContain('local_sess_tok');
    expect(jsonString).not.toContain('local_acc_tok');
    expect(jsonString).not.toContain('local_ref_tok');
    expect(jsonString).not.toContain('secret_bin_hash');

    // Verify consolidationMetadata is sanitized and conflict diagnostics are recorded cleanly
    const meta = persisted?.data.consolidationMetadata;
    expect(meta?.unresolvedConflicts).toHaveLength(1);
    const diag = meta?.unresolvedConflicts[0] as any;
    expect(diag.onlineVersion?.passwordHash).toBeUndefined();
    expect(diag.onlineVersion?.apiKey).toBeUndefined();
    expect(diag.offlineVersion?.sessionToken).toBeUndefined();
  });

  // TEST 17 — AUTHORIZATION
  it('TEST 17 — AUTHORIZATION: unauthenticated or unauthorized users are strictly rejected', async () => {
    // 1. Unauthenticated rejected
    await expect(backupService.createSnapshot('OFFLINE', unauthenticatedAuth, { bin: validBin })).rejects.toThrow(
      AuthorizationError
    );

    // 2. Insufficient permission rejected
    await expect(backupService.createSnapshot('OFFLINE', unauthorizedAuth, { bin: validBin })).rejects.toThrow(
      InsufficientPermissionError
    );

    // 3. Restore unauthorized rejected
    await expect(backupService.restoreSnapshot('any_snap', unauthorizedAuth, { bin: validBin })).rejects.toThrow(
      InsufficientPermissionError
    );

    // 4. Delete unauthorized rejected
    await expect(backupService.deleteSnapshot('any_snap', unauthorizedAuth, { bin: validBin })).rejects.toThrow(
      InsufficientPermissionError
    );
  });

  // TEST 18 — ONLINE → LOCAL RESTORE
  it('TEST 18 — ONLINE -> LOCAL RESTORE: authoritative online data replaces local state while preserving snapshots', async () => {
    // 1. Create a snapshot first
    await localDb.set('customers', 'c_before', { id: 'c_before', name: 'Before' });
    const snap = await backupService.createSnapshot('OFFLINE', superAdminAuth, { name: 'Preserve Me', bin: validBin });

    // 2. Authoritative online state
    const mockOnline = {
      customers: [{ id: 'cust_remote_final', name: 'Authoritative Remote Customer', version: 5 }],
      businessDays: [{ id: 'day_remote', date: '2026-10-05', version: 2 }],
      orders: [],
      orderItems: [],
      financialLedger: [],
      payments: [],
      paymentAllocations: [],
      deviceTypes: [],
    };

    // 3. Perform restoreOnlineToLocal
    const result = await backupService.restoreOnlineToLocal(superAdminAuth, {
      customOnlineData: mockOnline,
      bin: validBin,
    });
    expect(result.success).toBe(true);

    // Local state now has remote data
    const remoteCust = await localDb.get<any>('customers', 'cust_remote_final');
    expect(remoteCust?.name).toBe('Authoritative Remote Customer');

    // Old local state 'c_before' was replaced
    const oldCust = await localDb.get<any>('customers', 'c_before');
    expect(oldCust).toBeNull();

    // But the backup snapshot was PRESERVED!
    const preservedSnap = await backupService.getSnapshot(snap.snapshotId);
    expect(preservedSnap).not.toBeNull();
    expect(preservedSnap?.snapshotName).toBe('Preserve Me');
  });
});
