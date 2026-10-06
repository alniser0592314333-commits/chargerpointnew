/**
 * Restore Runtime Read Model Rehydration Regression Test Suite
 * Verifies that restoring backups synchronizes runtime in-memory repositories (itemsMap, etc.)
 * before business operations (deliverOrderItem, deliverAllOrdersInDay) resume.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { backupService, PortableBackupFile, PORTABLE_BACKUP_FORMAT_IDENTIFIER, PORTABLE_BACKUP_FORMAT_VERSION } from '../services/backup/backupService';
import { AuthorizationContext } from '../application/authContext';
import { Permission } from '../domain/enums';
import {
  ensureStoreHydrated,
  reloadStoreFromLocal,
  repoContext,
  phase5UseCases,
  deliverAllOrdersInDay,
  resetStoreMemory,
  setRuntimeBinVerifier,
} from '../components/pages/dayOrdersStore';
import { initializeCanonicalSyncState } from './utils/testSetup';

describe('Restore Runtime Read Model Rehydration & Delivery Suite', () => {
  const superAdminAuth = new AuthorizationContext(
    {
      id: 'admin_super_1',
      username: 'superadmin',
      fullName: 'Super Administrator',
      role: 'SUPER_ADMIN',
      isSuperAdmin: true,
      permissions: ['settings:manage', 'orders:view', 'orders:create', 'orders:edit', 'orders:deliver', 'orders:cancel'] as Permission[],
    },
    async (bin) => bin === '1234'
  );

  const validBin = '1234';

  beforeEach(async () => {
    await localDb.clear();
    await initializeCanonicalSyncState();
    resetStoreMemory();
    setRuntimeBinVerifier((bin) => bin === '1234');
  });

  const createCanonicalBackupPayload = (): PortableBackupFile => {
    const rawData = {
      customers: [
        {
          id: 'cust-101',
          name: 'خالد أحمد',
          phone: '0599001122',
          isActive: true,
          debtLimitMinor: -50000,
          chargerFeeExempt: false,
          createdAt: '2026-10-01T10:00:00Z',
          updatedAt: '2026-10-01T10:00:00Z',
          version: 1,
        },
      ],
      businessDays: [
        {
          id: 'day-2026-10-04',
          businessDate: '2026-10-04',
          isClosed: false,
          createdAt: '2026-10-04T00:00:00Z',
          updatedAt: '2026-10-04T00:00:00Z',
          version: 1,
        },
      ],
      deviceTypes: [
        {
          id: 'dev-1',
          name: 'شاشة آيفون 13 برو',
          icon: 'smartphone',
          basePriceMinor: 4500,
          chargerFeeEnabled: true,
          isActive: true,
          sortOrder: 1,
          createdAt: '2026-09-01T00:00:00Z',
          updatedAt: '2026-09-01T00:00:00Z',
          version: 1,
        },
      ],
      orders: [
        {
          id: 'ord-500',
          dayId: 'day-2026-10-04',
          customerId: 'cust-101',
          displayNumber: 1,
          internalSequence: 1,
          status: 'pending' as const,
          customerBalanceSnapshotMinor: 0,
          createdAt: '2026-10-04T10:00:00Z',
          updatedAt: '2026-10-04T10:00:00Z',
          version: 1,
        },
      ],
      orderItems: [
        {
          id: 'item-501',
          orderId: 'ord-500',
          deviceTypeId: 'dev-1',
          itemSequence: 1,
          status: 'charging' as const,
          financialStatus: 'UNRECOGNIZED' as const,
          paymentStatus: 'UNPAID' as const,
          deviceNameSnapshot: 'شاشة آيفون 13 برو',
          deviceIconSnapshot: 'smartphone',
          basePriceSnapshotMinor: 4500,
          chargerFeeEnabledSnapshot: true,
          customerChargerFeeExemptSnapshot: false,
          chargerFeeSnapshotMinor: 50,
          hasCharger: false,
          unitPriceMinor: 4550,
          totalPriceMinor: 4550,
          createdAt: '2026-10-04T10:00:00Z',
          updatedAt: '2026-10-04T10:00:00Z',
          version: 1,
        },
        {
          id: 'item-502',
          orderId: 'ord-500',
          deviceTypeId: 'dev-1',
          itemSequence: 2,
          status: 'cancelled' as const,
          financialStatus: 'UNRECOGNIZED' as const,
          paymentStatus: 'UNPAID' as const,
          deviceNameSnapshot: 'شاشة آيفون 13 برو',
          deviceIconSnapshot: 'smartphone',
          basePriceSnapshotMinor: 4500,
          chargerFeeEnabledSnapshot: true,
          customerChargerFeeExemptSnapshot: false,
          chargerFeeSnapshotMinor: 50,
          hasCharger: false,
          unitPriceMinor: 4550,
          totalPriceMinor: 4550,
          createdAt: '2026-10-04T10:00:00Z',
          updatedAt: '2026-10-04T10:00:00Z',
          version: 1,
        },
      ],
      financialLedger: [],
      payments: [],
      paymentAllocations: [],
      qrTokens: [],
      orderNumberReservations: [],
    };

    return {
      formatIdentifier: PORTABLE_BACKUP_FORMAT_IDENTIFIER,
      formatVersion: PORTABLE_BACKUP_FORMAT_VERSION,
      schemaVersion: 1,
      snapshotVersion: 1,
      snapshotId: 'snap_canonical_test_1',
      snapshotName: 'Canonical Test Backup',
      createdAt: '2026-10-04T10:00:00Z',
      sourceType: 'OFFLINE',
      metadata: {
        recordCounts: {
          customers: 1,
          businessDays: 1,
          deviceTypes: 1,
          orders: 1,
          orderItems: 2,
          financialLedger: 0,
          payments: 0,
          paymentAllocations: 0,
        },
        totalEntities: 6,
        checksum: '',
      },
      data: rawData as any,
    };
  };

  it('16. Restore then Read: itemRepo.findById returns restored canonical Order Item with status "charging"', async () => {
    const portable = createCanonicalBackupPayload();
    const imported = await backupService.importPortableBackup(portable);
    
    // Perform restore
    const restoreRes = await backupService.restoreSnapshot(imported.snapshotId, superAdminAuth, { bin: validBin });
    expect(restoreRes.success).toBe(true);

    // Read directly from runtime repository
    const item = await repoContext.itemRepo.findById('item-501');
    expect(item).toBeDefined();
    expect(item).not.toBeNull();
    expect(item?.status).toBe('charging');
    expect(item?.financialStatus).toBe('UNRECOGNIZED');
    expect(item?.totalPriceMinor).toBe(4550);
  });

  it('17. Restore then Deliver (Path A): single item delivery transitions charging -> delivered with financial recognition', async () => {
    const portable = createCanonicalBackupPayload();
    const imported = await backupService.importPortableBackup(portable);

    // Initial state before restore
    await backupService.restoreSnapshot(imported.snapshotId, superAdminAuth, { bin: validBin });

    // Execute single item delivery through application use case
    const deliverResult = await phase5UseCases.deliverOrderItem(superAdminAuth, 'item-501', validBin);
    expect(deliverResult.success).toBe(true);
    if (!deliverResult.success) throw new Error('Expected delivery to succeed');
    expect(deliverResult.data.status).toBe('delivered');
    expect(deliverResult.data.financialStatus).toBe('RECOGNIZED');

    // Verify financial recognition ledger was created
    const ledger = await repoContext.ledgerRepo.findByCustomer('cust-101');
    expect(ledger.length).toBe(1);
    expect(ledger[0].eventType).toBe('ORDER_ITEM_CHARGE');
    expect(ledger[0].amountMinor).toBe(-4550);
    expect(ledger[0].orderItemId).toBe('item-501');

    // Verify Outbox command was recorded
    const outbox = await localDb.listOutbox();
    const deliverCmd = outbox.find((c) => c.commandType === 'DELIVER_ORDER_ITEM');
    expect(deliverCmd).toBeDefined();
    expect(deliverCmd?.aggregateId).toBe('item-501');
  });

  it('18. Deliver All (Path B): deliverAllOrdersInDay processes eligible items without "undefined" status error', async () => {
    const portable = createCanonicalBackupPayload();
    const imported = await backupService.importPortableBackup(portable);

    await backupService.restoreSnapshot(imported.snapshotId, superAdminAuth, { bin: validBin });

    // Deliver all in the restored business day
    const deliverAllResult = await deliverAllOrdersInDay('day-2026-10-04', validBin);
    expect(deliverAllResult.success).toBe(true);
    expect(deliverAllResult.deliveredCount).toBe(1); // 1 active item delivered, 1 cancelled item skipped

    // Verify item-501 is delivered
    const item501 = await repoContext.itemRepo.findById('item-501');
    expect(item501?.status).toBe('delivered');
    expect(item501?.financialStatus).toBe('RECOGNIZED');

    // Verify item-502 (cancelled) was NOT modified
    const item502 = await repoContext.itemRepo.findById('item-502');
    expect(item502?.status).toBe('cancelled');

    // Financial ledger has exactly 1 charge
    const ledger = await repoContext.ledgerRepo.findByCustomer('cust-101');
    expect(ledger.length).toBe(1);
    expect(ledger[0].orderItemId).toBe('item-501');
  });

  it('19. Restore Failure Safety: failed restore transaction preserves previous state and does not poison runtime', async () => {
    // 1. Setup initial active dataset
    const initialPortable = createCanonicalBackupPayload();
    const imported1 = await backupService.importPortableBackup(initialPortable);
    await backupService.restoreSnapshot(imported1.snapshotId, superAdminAuth, { bin: validBin });

    const itemBefore = await repoContext.itemRepo.findById('item-501');
    expect(itemBefore?.id).toBe('item-501');

    // 2. Mock localDb.runTransaction to simulate mid-transaction failure
    const originalRunTx = localDb.runTransaction.bind(localDb);
    vi.spyOn(localDb, 'runTransaction').mockImplementationOnce(async () => {
      throw new Error('Simulated IndexedDB Disk Failure');
    });

    // 3. Attempt restore of a different snapshot
    const secondPortable = createCanonicalBackupPayload();
    secondPortable.snapshotId = 'snap_corrupt_attempt';
    secondPortable.data.customers[0].name = 'اسم جديد لم يتم حفظه';
    const imported2 = await backupService.importPortableBackup(secondPortable);

    await expect(
      backupService.restoreSnapshot(imported2.snapshotId, superAdminAuth, { bin: validBin })
    ).rejects.toThrow('Simulated IndexedDB Disk Failure');

    // 4. Verify previous runtime and persisted state is intact
    const itemAfter = await repoContext.itemRepo.findById('item-501');
    expect(itemAfter?.id).toBe('item-501');
    expect(itemAfter?.status).toBe('charging');
  });

  it('20. Hydration Flag Safety: isStoreHydrated === true before restore does not prevent rehydration', async () => {
    // 1. Manually mark store hydrated with empty state
    await ensureStoreHydrated();
    const itemPrior = await repoContext.itemRepo.findById('item-501');
    expect(itemPrior).toBeNull();

    // 2. Perform restore
    const portable = createCanonicalBackupPayload();
    const imported = await backupService.importPortableBackup(portable);
    await backupService.restoreSnapshot(imported.snapshotId, superAdminAuth, { bin: validBin });

    // 3. Verify store is automatically refreshed and item-501 is immediately readable
    const itemPost = await repoContext.itemRepo.findById('item-501');
    expect(itemPost).not.toBeNull();
    expect(itemPost?.id).toBe('item-501');
    expect(itemPost?.status).toBe('charging');
  });
});
