import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  phase5UseCases,
  repoContext,
  resetStoreMemory,
  setRuntimeBinVerifier,
  subscribeStore,
  updateOrderWithPhase5Engine,
} from '../components/pages/dayOrdersStore';
import { localDb } from '../infrastructure/localDb/localDb';
import { AuthorizationContext } from '../application/authContext';
import { initializeCanonicalSyncState } from './utils/testSetup';

const superAdminAuth = new AuthorizationContext(
  {
    id: 'admin-regression-1',
    username: 'regression',
    fullName: 'Regression Super Admin',
    role: 'SUPER_ADMIN',
    permissions: [
      'settings:manage',
      'customers:create',
      'orders:create',
      'orders:edit',
      'orders:deliver',
      'orders:cancel',
      'finance:create-payment',
    ] as any,
    isSuperAdmin: true,
  },
  async (bin) => bin === '1234'
);

const seedBaseOrder = async () => {
  await repoContext.customerRepo.save({
    id: 'cust-regression',
    name: 'Regression Customer',
    phone: '0599000000',
    isActive: true,
    debtLimitMinor: -100000,
    chargerFeeExempt: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  });

  await repoContext.dayRepo.save({
    id: 'day-regression',
    businessDate: '2026-10-06',
    isClosed: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  });

  await repoContext.deviceRepo.save({
    id: 'device-regression',
    name: 'Regression Device',
    nameAr: 'جهاز اختبار',
    icon: 'smartphone',
    basePriceMinor: 2000,
    chargerFeeEnabled: false,
    isActive: true,
    sortOrder: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  });

  await repoContext.deviceRepo.save({
    id: 'device-regression-2',
    name: 'Regression Device 2',
    nameAr: 'جهاز اختبار 2',
    icon: 'smartphone',
    basePriceMinor: 3000,
    chargerFeeEnabled: false,
    isActive: true,
    sortOrder: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  });
};

describe('Offline reactivity and delivery targeting regression', () => {
  beforeEach(async () => {
    await localDb.clear();
    await initializeCanonicalSyncState();
    resetStoreMemory();
    setRuntimeBinVerifier((bin) => bin === '1234');

    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
      localStorage.setItem(
        'app_auth_session',
        JSON.stringify({
          userId: 'admin-regression-1',
          username: 'regression',
          fullName: 'Regression Super Admin',
          role: 'SUPER_ADMIN',
          permissions: [
            'settings:manage',
            'customers:create',
            'orders:create',
            'orders:edit',
            'orders:deliver',
            'orders:cancel',
            'finance:create-payment',
          ],
        })
      );
      localStorage.setItem('sys_db_version', '6.10.3D');
    }
  });

  afterEach(() => {
    setRuntimeBinVerifier(null);
  });

  it('notifies mounted store subscribers for overlay-backed offline order and payment mutations', async () => {
    await seedBaseOrder();

    const scopes: string[] = [];
    const unsubscribe = subscribeStore((scope) => scopes.push(scope));

    const orderResult = await phase5UseCases.createOrder(
      superAdminAuth,
      crypto.randomUUID(),
      'day-regression',
      'cust-regression'
    );
    expect(orderResult.success).toBe(true);

    const paymentResult = await phase5UseCases.recordPayment(
      superAdminAuth,
      crypto.randomUUID(),
      'cust-regression',
      1000,
      'cash'
    );
    expect(paymentResult.success).toBe(true);

    unsubscribe();

    expect(scopes).toContain('orders');
    expect(scopes).toContain('payments');
    expect(scopes).toContain('financialLedger');
  });

  it('when a delivered order receives a new device, choosing Delivered targets only the new charging item', async () => {
    await seedBaseOrder();

    await repoContext.orderRepo.save({
      id: 'order-delivered-regression',
      dayId: 'day-regression',
      customerId: 'cust-regression',
      displayNumber: 1,
      internalSequence: 1,
      status: 'delivered',
      customerBalanceSnapshotMinor: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    await repoContext.itemRepo.save({
      id: 'item-already-delivered',
      orderId: 'order-delivered-regression',
      deviceTypeId: 'device-regression',
      itemSequence: 1,
      status: 'delivered',
      financialStatus: 'RECOGNIZED',
      deviceNameSnapshot: 'Regression Device',
      deviceIconSnapshot: 'smartphone',
      basePriceSnapshotMinor: 2000,
      chargerFeeEnabledSnapshot: false,
      customerChargerFeeExemptSnapshot: false,
      chargerFeeSnapshotMinor: 0,
      hasCharger: true,
      unitPriceMinor: 2000,
      totalPriceMinor: 2000,
      deliveredAt: new Date().toISOString(),
      financiallyRecognizedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    const result = await updateOrderWithPhase5Engine(
      'order-delivered-regression',
      '',
      'delivered',
      [{ deviceTypeId: 'device-regression-2', hasCharger: true }],
      [],
      '1234'
    );

    expect(result.success).toBe(true);

    const outbox = await localDb.listOutbox();
    const addCommands = outbox.filter((c) => c.commandType === 'ADD_ORDER_ITEM');
    const deliverCommands = outbox.filter((c) => c.commandType === 'DELIVER_ORDER_ITEM');

    expect(addCommands).toHaveLength(2);
    expect(deliverCommands).toHaveLength(1);
    expect(deliverCommands[0].payload.itemId).not.toBe('item-already-delivered');

    const newItemId = addCommands[0].payload.id as string;
    expect(deliverCommands[0].payload.itemId).toBe(newItemId);
    const persistedNewItem = await localDb.get<any>('orderItems', newItemId);
    expect(persistedNewItem?.id).toBe(newItemId);
    expect(persistedNewItem?.orderId).toBe('order-delivered-regression');
    expect(persistedNewItem?.status).toBe('charging');

    const effectiveNewItem = await repoContext.itemRepo.findById(newItemId);
    expect(effectiveNewItem?.status).toBe('delivered');
  });

  it('persists a newly created order and all items in the local read model together with its outbox', async () => {
    await seedBaseOrder();

    const commandId = crypto.randomUUID();
    const result = await phase5UseCases.createOrderWithItems(
      superAdminAuth,
      commandId,
      'day-regression',
      'cust-regression',
      [
        { deviceTypeId: 'device-regression', hasCharger: false },
        { deviceTypeId: 'device-regression-2', hasCharger: true },
      ]
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    const orderId = result.data.order.id;
    const localOrder = await repoContext.orderRepo.findById(orderId);
    const localItems = await repoContext.itemRepo.findByOrderId(orderId);
    const outbox = await localDb.listOutbox();

    expect(localOrder?.id).toBe(orderId);
    expect(localOrder?.dayId).toBe('day-regression');
    expect(localItems).toHaveLength(2);
    expect(localItems.every((item) => item.orderId === orderId)).toBe(true);

    const createCommand = outbox.find(
      (command) => command.commandId === commandId && command.commandType === 'CREATE_ORDER'
    );
    const addCommands = outbox.filter(
      (command) => command.commandType === 'ADD_ORDER_ITEM' && command.payload.orderId === orderId
    );

    expect(createCommand).toBeTruthy();
    expect(addCommands).toHaveLength(2);
    expect(addCommands.every((command) => command.payload.dependencyCommandId === commandId)).toBe(true);
  });
});
