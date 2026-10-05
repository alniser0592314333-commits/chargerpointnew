import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  backupService,
  computeSnapshotChecksum,
  PORTABLE_BACKUP_FORMAT_IDENTIFIER,
  PORTABLE_BACKUP_FORMAT_VERSION,
} from '../services/backup/backupService';
import { AuthorizationContext, ActorAdmin } from '../application/authContext';
import {
  resetStoreMemory,
  seedDemoOperationalData,
  reloadStoreFromLocal,
  getCustomersCount,
  getOrdersCount,
} from '../components/pages/dayOrdersStore';

describe('Phase B.8: Portable Backup Export, Validation, Import & Restoration', () => {
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
  });

  // TEST 1: Export Snapshot to Portable Backup Format
  it('1. Exports an existing snapshot to canonical portable backup format with valid metadata and zero secrets', async () => {
    await seedDemoOperationalData();

    // Create an offline snapshot
    const snap = await backupService.createSnapshot('OFFLINE', superAdminAuth, {
      name: 'Morning Operational Snapshot',
      bin: validBin,
    });

    // Export to portable format
    const exported = await backupService.exportSnapshotToPortableFormat(snap.snapshotId);

    expect(exported.fileName).toMatch(/\.backup\.json$/);
    expect(exported.fileContent).toBeDefined();
    expect(exported.portableData).toBeDefined();

    const data = exported.portableData;
    expect(data.formatIdentifier).toBe(PORTABLE_BACKUP_FORMAT_IDENTIFIER);
    expect(data.formatVersion).toBe(PORTABLE_BACKUP_FORMAT_VERSION);
    expect(data.schemaVersion).toBe(1);
    expect(data.snapshotVersion).toBe(1);
    expect(data.snapshotId).toBe(snap.snapshotId);
    expect(data.snapshotName).toBe('Morning Operational Snapshot');
    expect(data.metadata.totalEntities).toBeGreaterThan(0);
    expect(data.metadata.checksum).toBeDefined();

    // Verify secret scrubbing
    const jsonStr = exported.fileContent;
    expect(jsonStr).not.toContain('password');
    expect(jsonStr).not.toContain('binHash');
    expect(jsonStr).not.toContain('secret');
  });

  // TEST 2: Validate Portable Backup File
  it('2. Validates untrusted backup JSON content and rejects corrupted or tampered payloads', async () => {
    await seedDemoOperationalData();

    const snap = await backupService.createSnapshot('OFFLINE', superAdminAuth, {
      name: 'Validation Test Snapshot',
      bin: validBin,
    });

    const exported = await backupService.exportSnapshotToPortableFormat(snap.snapshotId);

    // 1. Valid file passes validation
    const validResult = backupService.validateAndParsePortableBackup(exported.fileContent);
    expect(validResult.valid).toBe(true);
    expect(validResult.portableFile).toBeDefined();

    // 2. Bad JSON syntax fails
    const invalidJsonResult = backupService.validateAndParsePortableBackup('{ bad json ');
    expect(invalidJsonResult.valid).toBe(false);
    expect(invalidJsonResult.errorCode).toBe('INVALID_JSON');

    // 3. Unrecognized format identifier fails
    const badFormat = JSON.parse(exported.fileContent);
    badFormat.formatIdentifier = 'INVALID_FORMAT_ID';
    const badFormatResult = backupService.validateAndParsePortableBackup(JSON.stringify(badFormat));
    expect(badFormatResult.valid).toBe(false);
    expect(badFormatResult.errorCode).toBe('UNRECOGNIZED_FORMAT');

    // 4. Checksum mismatch fails
    const tampered = JSON.parse(exported.fileContent);
    tampered.data.customers.push({ id: 'cust_hacked', name: 'Hacked Customer' });
    const tamperedResult = backupService.validateAndParsePortableBackup(JSON.stringify(tampered));
    expect(tamperedResult.valid).toBe(false);
    expect(tamperedResult.errorCode).toBe('CHECKSUM_MISMATCH');
  });

  // TEST 3: Import Portable Backup into backupSnapshots without touching live operational data
  it('3. Imports a validated backup into backupSnapshots store while keeping live business data untouched', async () => {
    await seedDemoOperationalData();
    const initialCustCount = await getCustomersCount();

    // Create a snapshot and export it
    const snap = await backupService.createSnapshot('OFFLINE', superAdminAuth, {
      name: 'Exportable Snapshot',
      bin: validBin,
    });
    const exported = await backupService.exportSnapshotToPortableFormat(snap.snapshotId);

    // Clear localDb completely
    await localDb.clear();
    resetStoreMemory();

    // Live business data is empty
    const custCountAfterClear = await getCustomersCount();
    expect(custCountAfterClear).toBe(0);

    // Import the exported backup
    const importRes = await backupService.importPortableBackup(exported.portableData);
    expect(importRes.isDuplicate).toBe(false);
    expect(importRes.snapshotId).toBe(snap.snapshotId);

    // Snapshot is now present in backupSnapshots
    const snapshots = await backupService.listSnapshots();
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].snapshotName).toBe('Exportable Snapshot');

    // Crucial: Live operational business data remains empty until explicit restore!
    const custCountAfterImport = await getCustomersCount();
    expect(custCountAfterImport).toBe(0);
  });

  // TEST 4: Duplicate Import Handling (Copy vs Overwrite)
  it('4. Handles duplicate snapshot IDs gracefully with importAsCopy or overwrite options', async () => {
    await seedDemoOperationalData();

    const snap = await backupService.createSnapshot('OFFLINE', superAdminAuth, {
      name: 'Duplicate Test Snap',
      bin: validBin,
    });
    const exported = await backupService.exportSnapshotToPortableFormat(snap.snapshotId);

    // First import without options detects duplicate
    const dupRes = await backupService.importPortableBackup(exported.portableData);
    expect(dupRes.isDuplicate).toBe(true);

    // Import as copy
    const copyRes = await backupService.importPortableBackup(exported.portableData, {
      importAsCopy: true,
    });
    expect(copyRes.isDuplicate).toBe(false);
    expect(copyRes.snapshotId).not.toBe(snap.snapshotId);

    const snapshots = await backupService.listSnapshots();
    expect(snapshots.length).toBe(2);

    // Overwrite duplicate
    const overwriteRes = await backupService.importPortableBackup(exported.portableData, {
      overwriteDuplicate: true,
    });
    expect(overwriteRes.isDuplicate).toBe(false);
    expect(overwriteRes.snapshotId).toBe(snap.snapshotId);
  });

  // TEST 5: Restore Operational State from Imported Snapshot
  it('5. Restores operational business data seamlessly from an imported portable backup snapshot', async () => {
    await seedDemoOperationalData();
    const originalCustCount = await getCustomersCount();
    expect(originalCustCount).toBe(6);

    // Create snapshot and export
    const snap = await backupService.createSnapshot('OFFLINE', superAdminAuth, {
      name: 'Backup to Restore',
      bin: validBin,
    });
    const exported = await backupService.exportSnapshotToPortableFormat(snap.snapshotId);

    // Reset operational data
    await backupService.deleteLocalBusinessData(superAdminAuth, { bin: validBin });
    await reloadStoreFromLocal();
    expect(await getCustomersCount()).toBe(0);

    // Import snapshot
    await backupService.importPortableBackup(exported.portableData, { overwriteDuplicate: true });

    // Restore from imported snapshot
    const restoreRes = await backupService.restoreSnapshot(snap.snapshotId, superAdminAuth, {
      bin: validBin,
    });
    expect(restoreRes.success).toBe(true);

    await reloadStoreFromLocal();
    expect(await getCustomersCount()).toBe(6);
  });

  // TEST 6: Deterministic Export -> Serialize -> Parse -> Recompute Checksum Round-Trip
  it('6. Ensures deterministic round-trip checksum calculation with Date objects and undefined properties', async () => {
    const testData = {
      customers: [{ id: 'c1', name: 'Test Customer', createdAt: new Date().toISOString(), customField: undefined }],
      businessDays: [],
      orders: [],
      orderItems: [],
      financialLedger: [],
      payments: [],
      paymentAllocations: [],
      deviceTypes: [],
      qrTokens: [],
    };

    const checksum1 = computeSnapshotChecksum(testData);
    const serialized = JSON.stringify(testData, null, 2);
    const parsed = JSON.parse(serialized);
    const checksum2 = computeSnapshotChecksum(parsed);

    expect(checksum1).toBe(checksum2);
  });
});
