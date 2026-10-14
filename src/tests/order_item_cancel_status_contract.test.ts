import { describe, expect, it } from 'vitest';
import { AuthorizationContext } from '../application/authContext';
import { FinalUseCases, RepositoryContext } from '../application/useCases';
import {
  AuthorizationError,
  BinRequiredError,
  InsufficientPermissionError,
} from '../domain/errors';
import { validateOrderTransition } from '../domain/rules';
import {
  BusinessDayEntity,
  CustomerEntity,
  DeviceTypeEntity,
  FinancialLedgerEntity,
  OrderEntity,
  OrderItemEntity,
  PaymentAllocationEntity,
  PaymentEntity,
} from '../domain/models';

const TEST_BIN = '7890';
const WRONG_BIN = '0000';

function createHarness() {
  const orders = new Map<string, OrderEntity>();
  const items = new Map<string, OrderItemEntity>();
  const customers = new Map<string, CustomerEntity>([
    ['cust_1', {
      id: 'cust_1',
      name: 'Customer 1',
      isActive: true,
      debtLimitMinor: 50000,
      chargerFeeExempt: false,
      createdAt: '',
      updatedAt: '',
      version: 1,
    }],
  ]);
  const days = new Map<string, BusinessDayEntity>([
    ['day_1', {
      id: 'day_1',
      businessDate: '2026-10-11',
      isClosed: false,
      createdAt: '',
      updatedAt: '',
      version: 1,
    }],
  ]);
  const devices = new Map<string, DeviceTypeEntity>([
    ['dev_1', {
      id: 'dev_1',
      name: 'Test Device',
      icon: 'smartphone',
      basePriceMinor: 3000,
      chargerFeeEnabled: false,
      isActive: true,
      sortOrder: 1,
      createdAt: '',
      updatedAt: '',
      version: 1,
    }],
    ['dev_2', {
      id: 'dev_2',
      name: 'Test Device 2',
      icon: 'smartphone',
      basePriceMinor: 4500,
      chargerFeeEnabled: true,
      isActive: true,
      sortOrder: 2,
      createdAt: '',
      updatedAt: '',
      version: 1,
    }],
  ]);
  const ledger: FinancialLedgerEntity[] = [];
  const payments: PaymentEntity[] = [];
  const allocations: PaymentAllocationEntity[] = [];
  const commands = new Map<string, { type: string; payload: unknown }>();

  let repoContext: RepositoryContext;
  repoContext = {
    orderRepo: {
      findById: async (id) => orders.get(id) || null,
      save: async (order) => { orders.set(order.id, { ...order }); },
      countForDay: async () => orders.size,
    },
    itemRepo: {
      findById: async (id) => items.get(id) || null,
      save: async (item) => { items.set(item.id, { ...item }); },
      findByOrderId: async (orderId) => [...items.values()].filter((item) => item.orderId === orderId),
    },
    customerRepo: {
      findById: async (id) => customers.get(id) || null,
      save: async (customer) => { customers.set(customer.id, { ...customer }); },
      getBalance: async (customerId) => ledger
        .filter((entry) => entry.customerId === customerId)
        .reduce((sum, entry) => sum + entry.amountMinor, 0),
    },
    deviceRepo: {
      findById: async (id) => devices.get(id) || null,
      findAll: async () => [...devices.values()],
      save: async (device) => { devices.set(device.id, { ...device }); },
    },
    ledgerRepo: {
      append: async (entry) => {
        ledger.push({
          ...entry,
          id: entry.id || `ledger_${ledger.length + 1}`,
          createdAt: entry.createdAt || new Date().toISOString(),
        } as FinancialLedgerEntity);
      },
      findByCustomer: async (customerId) => ledger.filter((entry) => entry.customerId === customerId),
      findAll: async () => [...ledger],
    },
    dayRepo: {
      findById: async (id) => days.get(id) || null,
      save: async (day) => { days.set(day.id, { ...day }); },
      isClosed: async (dayId) => Boolean(days.get(dayId)?.isClosed),
    },
    paymentRepo: {
      save: async (payment) => { payments.push(payment); },
      saveAllocation: async (allocation) => { allocations.push(allocation); },
      findByCustomer: async (customerId) => payments.filter((payment) => payment.customerId === customerId),
      findAllAllocations: async () => [...allocations],
    },
    commandRepo: {
      get: async (id) => commands.get(id) || null,
      record: async (id, type, payload) => { commands.set(id, { type, payload }); },
    },
    transactionManager: {
      runInTransaction: async (work) => work(repoContext),
    },
  };

  return {
    orders,
    items,
    ledger,
    commands,
    useCases: new FinalUseCases(repoContext),
  };
}

function makeAuth(permissions: string[]) {
  return new AuthorizationContext(
    {
      id: 'admin_1',
      username: 'admin',
      fullName: 'Admin',
      role: 'ADMIN',
      permissions: permissions as import('../domain/enums').Permission[],
      isSuperAdmin: false,
    },
    (bin) => bin === TEST_BIN,
  );
}

async function createPersistedOrderAndItem(
  harness: ReturnType<typeof createHarness>,
  auth: AuthorizationContext,
  commandId: string,
) {
  const orderResult = await harness.useCases.createOrder(auth, commandId, 'day_1', 'cust_1');
  if (!orderResult.success) throw new Error('Test setup could not create an order');
  const order = orderResult.data;
  // These unit tests model the local repository after the CREATE_ORDER outbox
  // overlay is applied; createOrder itself intentionally only queues the command.
  harness.orders.set(order.id, order);

  const itemResult = await harness.useCases.addOrderItem(auth, order.id, 'dev_1', false);
  if (!itemResult.success) throw new Error('Test setup could not add an order item');
  const item = itemResult.data;
  // addOrderItem follows the same local-first overlay contract.
  harness.items.set(item.id, item);
  return { order, item };
}

describe('Order-item cancellation BIN and status contract', () => {
  it('rejects missing or wrong BIN before queueing CANCEL_ORDER_ITEM', async () => {
    const h = createHarness();
    const auth = makeAuth(['orders:create', 'orders:edit', 'orders:cancel']);
    const { item } = await createPersistedOrderAndItem(h, auth, 'order_missing_bin');

    await expect(h.useCases.removeOrderItemDuringEdit(auth, item.id, '')).rejects.toThrow(BinRequiredError);
    await expect(h.useCases.removeOrderItemDuringEdit(auth, item.id, WRONG_BIN)).rejects.toThrow(AuthorizationError);
    expect([...h.commands.values()].filter((command) => command.type === 'CANCEL_ORDER_ITEM')).toHaveLength(0);
    expect(h.items.get(item.id)?.status).toBe('charging');
  });

  it('queues the same canonical cancellation command with BIN and a cancellation overlay', async () => {
    const h = createHarness();
    const auth = makeAuth(['orders:create', 'orders:edit', 'orders:cancel']);
    const { item } = await createPersistedOrderAndItem(h, auth, 'order_valid_bin');

    const result = await h.useCases.removeOrderItemDuringEdit(auth, item.id, TEST_BIN);
    expect(result.success).toBe(true);
    expect((result as any).data.status).toBe('cancelled');

    const command = [...h.commands.values()].find((entry) => entry.type === 'CANCEL_ORDER_ITEM');
    expect(command).toBeDefined();
    expect((command!.payload as any).bin).toBe(TEST_BIN);
    expect((command!.payload as any).orderItemId).toBe(item.id);
    expect((command!.payload as any).deferBinVerification).toBeUndefined();
    expect((result as any).data.cancelledAt).toBeTruthy();
  });

  it('defers BIN explicitly for offline-first cancellation so SyncCenter can resume it', async () => {
    const h = createHarness();
    const auth = makeAuth(['orders:create', 'orders:edit', 'orders:cancel']);
    const { item } = await createPersistedOrderAndItem(h, auth, 'order_deferred_bin');

    const result = await h.useCases.removeOrderItemDuringEdit(auth, item.id, '', {
      deferBinVerification: true,
    });
    expect(result.success).toBe(true);

    const command = [...h.commands.values()].find((entry) => entry.type === 'CANCEL_ORDER_ITEM');
    expect(command).toBeDefined();
    expect((command!.payload as any).bin).toBe('');
    expect((command!.payload as any).deferBinVerification).toBe(true);
  });

  it('requires orders:cancel, matching the canonical server authorization boundary', async () => {
    const h = createHarness();
    const auth = makeAuth(['orders:create', 'orders:edit']);
    const { item } = await createPersistedOrderAndItem(h, auth, 'order_permission');

    await expect(h.useCases.removeOrderItemDuringEdit(auth, item.id, TEST_BIN)).rejects.toThrow(InsufficientPermissionError);
    expect([...h.commands.values()].filter((command) => command.type === 'CANCEL_ORDER_ITEM')).toHaveLength(0);
  });

  it('allows delivered-to-cancelled only as a protected correction, never delivered-to-charging/pending', () => {
    expect(() => validateOrderTransition('delivered', 'cancelled')).not.toThrow();
    expect(() => validateOrderTransition('delivered', 'charging')).toThrow();
    expect(() => validateOrderTransition('delivered', 'pending')).toThrow();
    expect(() => validateOrderTransition('cancelled', 'charging')).toThrow();
    expect(() => validateOrderTransition('cancelled', 'delivered')).toThrow();
  });

  it('updates an undelivered item through UPDATE_ORDER_ITEM without creating financial entries', async () => {
    const h = createHarness();
    const auth = makeAuth(['orders:create', 'orders:edit']);
    const { item } = await createPersistedOrderAndItem(h, auth, 'order_item_edit');
    const beforeLedgerCount = h.ledger.length;

    const result = await h.useCases.updateOrderItem(auth, item.id, 'dev_2', false);

    expect(result.success).toBe(true);
    expect((result as any).data.deviceTypeId).toBe('dev_2');
    expect((result as any).data.deviceNameSnapshot).toBe('Test Device 2');
    expect((result as any).data.hasCharger).toBe(false);
    expect((result as any).data.totalPriceMinor).toBe(4550);
    const command = [...h.commands.values()].find((entry) => entry.type === 'UPDATE_ORDER_ITEM');
    expect(command).toBeDefined();
    expect((command!.payload as any).itemId).toBe(item.id);
    expect((command!.payload as any).expectedVersion).toBe(item.version);
    expect(h.ledger).toHaveLength(beforeLedgerCount);
  });

  it('rejects editing a delivered/financially recognized item', async () => {
    const h = createHarness();
    const auth = makeAuth(['orders:create', 'orders:edit']);
    const { item } = await createPersistedOrderAndItem(h, auth, 'order_item_edit_delivered');
    h.items.set(item.id, {
      ...item,
      status: 'delivered',
      financialStatus: 'RECOGNIZED',
      financiallyRecognizedAt: new Date().toISOString(),
    });

    await expect(h.useCases.updateOrderItem(auth, item.id, 'dev_2', false))
      .rejects.toThrow('Only undelivered, financially unrecognized items can be edited');
    expect([...h.commands.values()].filter((entry) => entry.type === 'UPDATE_ORDER_ITEM')).toHaveLength(0);
  });

  it('rejects adding an item to a cancelled order before queuing ADD_ORDER_ITEM', async () => {
    const h = createHarness();
    const auth = makeAuth(['orders:create', 'orders:edit']);
    const orderResult = await h.useCases.createOrder(auth, 'cancelled_parent', 'day_1', 'cust_1');
    if (!orderResult.success) throw new Error('Test setup could not create an order');
    h.orders.set(orderResult.data.id, { ...orderResult.data, status: 'cancelled' });

    await expect(
      h.useCases.addOrderItem(auth, orderResult.data.id, 'dev_1', false)
    ).rejects.toThrow('Cannot add item to cancelled order');
    expect([...h.commands.values()].filter((entry) => entry.type === 'ADD_ORDER_ITEM')).toHaveLength(0);
  });

  it('allows a delivered item correction to queue the reversal-backed server command without local financial fabrication', async () => {
    const h = createHarness();
    const auth = makeAuth(['orders:create', 'orders:edit', 'orders:cancel']);
    const { item } = await createPersistedOrderAndItem(h, auth, 'order_delivered_item');
    const delivered = {
      ...item,
      status: 'delivered' as const,
      financialStatus: 'RECOGNIZED' as const,
      deliveredAt: new Date().toISOString(),
      financiallyRecognizedAt: new Date().toISOString(),
      version: item.version + 1,
    };
    h.items.set(item.id, delivered);
    h.ledger.push({
      id: 'charge_1',
      customerId: 'cust_1',
      orderId: item.orderId,
      orderItemId: item.id,
      actorAdminId: 'admin_1',
      eventType: 'ORDER_ITEM_CHARGE',
      amountMinor: -3000,
      createdAt: new Date().toISOString(),
    } as FinancialLedgerEntity);

    const result = await h.useCases.removeOrderItemDuringEdit(auth, item.id, TEST_BIN);
    expect(result.success).toBe(true);
    expect((result as any).data.status).toBe('cancelled');
    expect(h.ledger.filter((entry) => entry.eventType === 'REVERSAL')).toHaveLength(0);

    const command = [...h.commands.values()].find((entry) => entry.type === 'CANCEL_ORDER_ITEM');
    expect(command).toBeDefined();
    expect((command!.payload as any).bin).toBe(TEST_BIN);
  });
});
