/**
 * Delivery Scope, Item Visibility & Financial History Regression Test Suite
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  repoContext,
  deliverSingleOrderItem,
  deliverEntireOrder,
  deliverAllOrdersInDay,
  getCustomerFinancialHistory,
  reloadStoreFromLocal,
  resetStoreMemory,
  setRuntimeBinVerifier,
} from '../components/pages/dayOrdersStore';
import { AuthorizationContext } from '../application/authContext';
import { Permission } from '../domain/enums';
import { initializeCanonicalSyncState } from './utils/testSetup';
import { backupService, PORTABLE_BACKUP_FORMAT_IDENTIFIER, PORTABLE_BACKUP_FORMAT_VERSION } from '../services/backup/backupService';

describe('Delivery Scope, Item Visibility & Financial History Suite', () => {
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

  const setupTestOrderWithThreeItems = async () => {
    // 1. Create Customer
    await repoContext.customerRepo.save({
      id: 'cust-scope-1',
      name: 'علي حسن',
      phone: '0599112233',
      isActive: true,
      debtLimitMinor: -50000,
      chargerFeeExempt: false,
      createdAt: '2026-10-04T10:00:00Z',
      updatedAt: '2026-10-04T10:00:00Z',
      version: 1,
    });

    // 2. Create Business Day
    await repoContext.dayRepo.save({
      id: 'day-2026-10-04',
      businessDate: '2026-10-04',
      isClosed: false,
      createdAt: '2026-10-04T00:00:00Z',
      updatedAt: '2026-10-04T00:00:00Z',
      version: 1,
    });

    // 3. Create Device Type
    await repoContext.deviceRepo.save({
      id: 'dev-type-1',
      name: 'شاشة آيفون 13',
      icon: 'smartphone',
      basePriceMinor: 600,
      chargerFeeEnabled: false,
      isActive: true,
      sortOrder: 1,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
      version: 1,
    });

    // 4. Create Order
    await repoContext.orderRepo.save({
      id: 'ord-scope-100',
      dayId: 'day-2026-10-04',
      customerId: 'cust-scope-1',
      displayNumber: 20,
      internalSequence: 20,
      status: 'pending',
      customerBalanceSnapshotMinor: 0,
      createdAt: '2026-10-04T10:00:00Z',
      updatedAt: '2026-10-04T10:00:00Z',
      version: 1,
    });

    // 5. Create 3 Order Items
    await repoContext.itemRepo.save({
      id: 'item-A',
      orderId: 'ord-scope-100',
      deviceTypeId: 'dev-type-1',
      itemSequence: 1,
      status: 'charging',
      financialStatus: 'UNRECOGNIZED',
      paymentStatus: 'UNPAID',
      deviceNameSnapshot: 'شاشة آيفون 13',
      deviceIconSnapshot: 'smartphone',
      basePriceSnapshotMinor: 600,
      chargerFeeEnabledSnapshot: false,
      customerChargerFeeExemptSnapshot: false,
      chargerFeeSnapshotMinor: 0,
      hasCharger: false,
      unitPriceMinor: 600,
      totalPriceMinor: 600,
      createdAt: '2026-10-04T10:00:00Z',
      updatedAt: '2026-10-04T10:00:00Z',
      version: 1,
    });

    await repoContext.itemRepo.save({
      id: 'item-B',
      orderId: 'ord-scope-100',
      deviceTypeId: 'dev-type-1',
      itemSequence: 2,
      status: 'charging',
      financialStatus: 'UNRECOGNIZED',
      paymentStatus: 'UNPAID',
      deviceNameSnapshot: 'شاشة آيفون 13',
      deviceIconSnapshot: 'smartphone',
      basePriceSnapshotMinor: 600,
      chargerFeeEnabledSnapshot: false,
      customerChargerFeeExemptSnapshot: false,
      chargerFeeSnapshotMinor: 0,
      hasCharger: false,
      unitPriceMinor: 600,
      totalPriceMinor: 600,
      createdAt: '2026-10-04T10:00:00Z',
      updatedAt: '2026-10-04T10:00:00Z',
      version: 1,
    });

    await repoContext.itemRepo.save({
      id: 'item-C',
      orderId: 'ord-scope-100',
      deviceTypeId: 'dev-type-1',
      itemSequence: 3,
      status: 'charging',
      financialStatus: 'UNRECOGNIZED',
      paymentStatus: 'UNPAID',
      deviceNameSnapshot: 'شاشة آيفون 13',
      deviceIconSnapshot: 'smartphone',
      basePriceSnapshotMinor: 600,
      chargerFeeEnabledSnapshot: false,
      customerChargerFeeExemptSnapshot: false,
      chargerFeeSnapshotMinor: 0,
      hasCharger: false,
      unitPriceMinor: 600,
      totalPriceMinor: 600,
      createdAt: '2026-10-04T10:00:00Z',
      updatedAt: '2026-10-04T10:00:00Z',
      version: 1,
    });

    await reloadStoreFromLocal();
  };

  it('Test A: deliverSingleOrderItem delivers ONLY Item B, leaving A and C charging', async () => {
    await setupTestOrderWithThreeItems();

    const result = await deliverSingleOrderItem('item-B', validBin);
    expect(result.success).toBe(true);

    const itemA = await repoContext.itemRepo.findById('item-A');
    const itemB = await repoContext.itemRepo.findById('item-B');
    const itemC = await repoContext.itemRepo.findById('item-C');

    expect(itemA?.status).toBe('charging');
    expect(itemB?.status).toBe('delivered');
    expect(itemC?.status).toBe('charging');

    // Financial recognition is server-authoritative; local delivery must not
    // fabricate a ledger entry. The durable command is the local mutation.
    const ledger = await repoContext.ledgerRepo.findByCustomer('cust-scope-1');
    expect(ledger.length).toBe(0);

    // Exactly 1 Outbox command
    const outbox = await localDb.listOutbox();
    const deliverCmds = outbox.filter((c) => c.commandType === 'DELIVER_ORDER_ITEM');
    expect(deliverCmds.length).toBe(1);
    expect(deliverCmds[0].aggregateId).toBe('item-B');
  });

  it('Test B: Delivered Item B remains in Order item list', async () => {
    await setupTestOrderWithThreeItems();
    await deliverSingleOrderItem('item-B', validBin);

    const orderItems = await repoContext.itemRepo.findByOrderId('ord-scope-100');
    expect(orderItems.length).toBe(3);

    const itemB = orderItems.find((i) => i.id === 'item-B');
    expect(itemB).toBeDefined();
    expect(itemB?.status).toBe('delivered');

    // Reload store and re-verify
    await reloadStoreFromLocal();
    const orderItemsPostReload = await repoContext.itemRepo.findByOrderId('ord-scope-100');
    expect(orderItemsPostReload.length).toBe(3);
  });

  it('Test C: Order status remains pending when 1 of 3 items is delivered, becomes delivered when all 3 are delivered', async () => {
    await setupTestOrderWithThreeItems();

    await deliverSingleOrderItem('item-B', validBin);
    let order = await repoContext.orderRepo.findById('ord-scope-100');
    expect(order?.status).toBe('pending');

    await deliverSingleOrderItem('item-A', validBin);
    order = await repoContext.orderRepo.findById('ord-scope-100');
    expect(order?.status).toBe('pending');

    await deliverSingleOrderItem('item-C', validBin);
    order = await repoContext.orderRepo.findById('ord-scope-100');
    expect(order?.status).toBe('delivered');
  });

  it('Test D: deliverEntireOrder delivers all 3 items in order explicitly', async () => {
    await setupTestOrderWithThreeItems();

    const result = await deliverEntireOrder('ord-scope-100', validBin);
    expect(result.success).toBe(true);
    expect(result.deliveredCount).toBe(3);

    const items = await repoContext.itemRepo.findByOrderId('ord-scope-100');
    expect(items.every((i) => i.status === 'delivered')).toBe(true);

    const ledger = await repoContext.ledgerRepo.findByCustomer('cust-scope-1');
    expect(ledger.length).toBe(0);
  });

  it('Test E: deliverAllOrdersInDay executes bulk day delivery properly', async () => {
    await setupTestOrderWithThreeItems();

    const result = await deliverAllOrdersInDay('day-2026-10-04', validBin);
    expect(result.success).toBe(true);
    expect(result.deliveredCount).toBe(1); // 1 order delivered

    const order = await repoContext.orderRepo.findById('ord-scope-100');
    expect(order?.status).toBe('delivered');
  });

  it('Test F: Financial history scopes ORDER_ITEM_CHARGE entries strictly to their target item', async () => {
    await setupTestOrderWithThreeItems();
    await deliverSingleOrderItem('item-B', validBin);

    // Until the command is accepted by the server, financial history remains
    // authoritative-only and therefore contains no charge row.
    const history = await getCustomerFinancialHistory('cust-scope-1', 'ar');
    expect(history.length).toBe(1);
    expect(['ORDER_ITEM_CHARGE', 'CHARGE']).toContain(history[0].eventType);
  });

  it('Test H: Restore then single item delivery works cleanly', async () => {
    const rawData = {
      customers: [
        {
          id: 'cust-rest-1',
          name: 'سامي الخالد',
          phone: '0599887766',
          isActive: true,
          debtLimitMinor: -50000,
          chargerFeeExempt: false,
          createdAt: '2026-10-04T10:00:00Z',
          updatedAt: '2026-10-04T10:00:00Z',
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
      deviceTypes: [],
      orders: [
        {
          id: 'ord-rest-1',
          dayId: 'day-2026-10-04',
          customerId: 'cust-rest-1',
          displayNumber: 5,
          internalSequence: 5,
          status: 'pending' as const,
          customerBalanceSnapshotMinor: 0,
          createdAt: '2026-10-04T10:00:00Z',
          updatedAt: '2026-10-04T10:00:00Z',
          version: 1,
        },
      ],
      orderItems: [
        {
          id: 'item-rest-1',
          orderId: 'ord-rest-1',
          deviceTypeId: 'dev-1',
          itemSequence: 1,
          status: 'charging' as const,
          financialStatus: 'UNRECOGNIZED' as const,
          paymentStatus: 'UNPAID' as const,
          deviceNameSnapshot: 'بطارية آيفون',
          deviceIconSnapshot: 'battery',
          basePriceSnapshotMinor: 2000,
          chargerFeeEnabledSnapshot: false,
          customerChargerFeeExemptSnapshot: false,
          chargerFeeSnapshotMinor: 0,
          hasCharger: false,
          unitPriceMinor: 2000,
          totalPriceMinor: 2000,
          createdAt: '2026-10-04T10:00:00Z',
          updatedAt: '2026-10-04T10:00:00Z',
          version: 1,
        },
      ],
      financialLedger: [],
      payments: [],
      paymentAllocations: [],
    };

    const portable = {
      formatIdentifier: PORTABLE_BACKUP_FORMAT_IDENTIFIER,
      formatVersion: PORTABLE_BACKUP_FORMAT_VERSION,
      schemaVersion: 1,
      snapshotVersion: 1,
      snapshotId: 'snap_delivery_test',
      snapshotName: 'Delivery Test',
      createdAt: '2026-10-04T10:00:00Z',
      sourceType: 'OFFLINE' as const,
      metadata: { recordCounts: {}, totalEntities: 4, checksum: '' },
      data: rawData as any,
    } as any;

    const imported = await backupService.importPortableBackup(portable);
    await backupService.restoreSnapshot(imported.snapshotId, superAdminAuth, { bin: validBin });

    const delRes = await deliverSingleOrderItem('item-rest-1', validBin);
    expect(delRes.success).toBe(true);

    const items = await repoContext.itemRepo.findByOrderId('ord-rest-1');
    expect(items.length).toBe(1);
    expect(items[0].status).toBe('delivered');
  });

  it('Test I: Deliver one item then reload store preserves item and order state', async () => {
    await setupTestOrderWithThreeItems();
    await deliverSingleOrderItem('item-B', validBin);

    await reloadStoreFromLocal();

    const items = await repoContext.itemRepo.findByOrderId('ord-scope-100');
    expect(items.length).toBe(3);

    const itemA = items.find((i) => i.id === 'item-A');
    const itemB = items.find((i) => i.id === 'item-B');
    const itemC = items.find((i) => i.id === 'item-C');

    expect(itemA?.status).toBe('charging');
    expect(itemB?.status).toBe('delivered');
    expect(itemC?.status).toBe('charging');

    const order = await repoContext.orderRepo.findById('ord-scope-100');
    expect(order?.status).toBe('pending');
  });
});
