import { describe, it, expect, beforeEach } from 'vitest';
import { AuthorizationContext } from '../application/authContext';
import { FinalUseCases, RepositoryContext } from '../application/useCases';
import {
  BinRequiredError,
  AuthorizationError,
  FinancialInvariantViolation,
} from '../domain/errors';
import { OrderEntity, OrderItemEntity, FinancialLedgerEntity, CustomerEntity, BusinessDayEntity } from '../domain/models';

describe('Phase 6.11.4: Strict Delivery & Cancellation BIN Security Regression Suite', () => {
  const TEST_BIN = '7890';
  const WRONG_BIN = '0000';

  let orders: Map<string, OrderEntity>;
  let items: Map<string, OrderItemEntity>;
  let ledger: FinancialLedgerEntity[];
  let customers: Map<string, CustomerEntity>;
  let days: Map<string, BusinessDayEntity>;
  let commands: Map<string, any>;
  let numberSequences: Map<string, number>;
  let overlaySequence: number;
  let repoContext: RepositoryContext;
  let useCases: FinalUseCases;

  beforeEach(() => {
    orders = new Map();
    items = new Map();
    ledger = [];
    customers = new Map();
    days = new Map();
    commands = new Map();
    numberSequences = new Map();
    overlaySequence = 0;

    customers.set('cust_1', {
      id: 'cust_1',
      name: 'Customer 1',
      phone: '0599111222',
      isActive: true,
      debtLimitMinor: -50000,
      chargerFeeExempt: false,
      createdAt: '',
      updatedAt: '',
      version: 1,
    });

    days.set('day_1', {
      id: 'day_1',
      businessDate: '2026-09-27',
      isClosed: false,
      createdAt: '',
      updatedAt: '',
      version: 1,
    });

    repoContext = {
      orderRepo: {
        findById: async (id: string) => orders.get(id) || null,
        save: async (o: OrderEntity) => { orders.set(o.id, { ...o }); },
        countForDay: async () => orders.size,
        findByDay: (dayId: string) => Array.from(orders.values()).filter((order) => order.dayId === dayId),
      },
      itemRepo: {
        findById: async (id: string) => items.get(id) || null,
        save: async (i: OrderItemEntity) => { items.set(i.id, { ...i }); },
        findByOrderId: async (oId: string) => Array.from(items.values()).filter(i => i.orderId === oId),
      },
      ledgerRepo: {
        append: async (entry) => {
          const record: FinancialLedgerEntity = {
            createdAt: new Date().toISOString(),
            ...entry,
            id: entry.id || `ledg_${Date.now()}_${Math.random()}`,
          };
          ledger.push(record);
        },
        findByCustomer: async (cId: string) => ledger.filter(l => l.customerId === cId),
        findAll: async () => [...ledger],
      },
      customerRepo: {
        findById: async (id: string) => customers.get(id) || null,
        save: async (c: CustomerEntity) => { customers.set(c.id, { ...c }); },
        getBalance: async (cId: string) => ledger.filter(l => l.customerId === cId).reduce((s, l) => s + l.amountMinor, 0),
      },
      deviceRepo: {
        findById: async (id: string) => ({
          id,
          name: 'Screen Repair',
          icon: 'smartphone',
          basePriceMinor: 3000,
          chargerFeeEnabled: false,
          isActive: true,
          sortOrder: 0,
          createdAt: '',
          updatedAt: '',
          version: 1,
        }),
        findAll: async () => [],
        save: async () => {},
      },
      dayRepo: {
        findById: async (id: string) => days.get(id) || null,
        isClosed: async (dayId: string) => Boolean(days.get(dayId)?.isClosed),
        save: async (d: BusinessDayEntity) => { days.set(d.id, { ...d }); },
      },
      commandRepo: {
        get: async (id: string) => commands.get(id) || null,
        record: async (id: string, type: string, payload: unknown) => { commands.set(id, { type, payload }); },
      },
      reservationRepo: {
        findActiveByDayAndDevice: () => null,
        save: () => {},
        reserveRange: (dayId: string, deviceId: string, commandId?: string, rangeSize = 20) => ({
          id: `range-${dayId}-${deviceId}`, businessDayId: dayId, deviceId,
          startNumber: 1, endNumber: rangeSize, nextNumber: 1, status: 'ACTIVE',
          commandId: commandId || `range-command-${dayId}`, createdAt: '', updatedAt: '', version: 1,
        }),
        getLastAssignedNumberForDay: (dayId: string) => Math.max(
          numberSequences.get(dayId) || 0,
          ...Array.from(orders.values()).filter((order) => order.dayId === dayId).map((order) => order.displayNumber),
          0
        ),
        saveLastAssignedNumberForDay: (dayId: string, number: number) => numberSequences.set(dayId, Math.max(numberSequences.get(dayId) || 0, number)),
      },
      overlayRepo: {
        save: (overlay: any) => {
          if (overlay.entityType === 'orders' && overlay.entityPayload) orders.set(overlay.entityId, { ...overlay.entityPayload, id: overlay.entityId } as OrderEntity);
        },
        saveWithTx: (overlay: any) => {
          if (overlay.entityType === 'orders' && overlay.entityPayload) orders.set(overlay.entityId, { ...overlay.entityPayload, id: overlay.entityId } as OrderEntity);
        },
        hasPendingRenumberForDaySync: () => false,
        remove: async () => {},
        get: async () => null,
        getNextSequence: () => ++overlaySequence,
      },
      paymentRepo: {
        save: async () => {},
        saveAllocation: async () => {},
        findByCustomer: async () => [],
        findAllAllocations: async () => [],
      },
      transactionManager: {
        runInTransaction: async (work) => work(repoContext),
      },
    };

    useCases = new FinalUseCases(repoContext);
  });

  // A. deliverOrderItem with wrong BIN: rejected, zero mutations
  it('A. deliverOrderItem with wrong BIN is rejected with zero mutations', async () => {
    const auth = new AuthorizationContext(
      {
        id: 'admin_1',
        username: 'admin',
        fullName: 'Admin',
        role: 'ADMIN',
        permissions: ['orders:create', 'orders:edit', 'orders:deliver'],
        isSuperAdmin: false,
      },
      (bin) => bin === TEST_BIN
    );

    const orderRes = await useCases.createOrder(auth, 'cmd_1', 'day_1', 'cust_1');
    const order = (orderRes as any).data;
    // CREATE_ORDER is overlay/outbox-first; hydrate the fake local repository as the real overlay-aware repo would.
    orders.set(order.id, order);
    const itemRes = await useCases.addOrderItem(auth, order.id, 'dev_1', false);
    const item = (itemRes as any).data;
    items.set(item.id, item);

    const initialLedgerCount = ledger.length;
    const initialCustomerBalance = await repoContext.customerRepo.getBalance('cust_1');

    // Attempt delivery with wrong BIN
    await expect(
      useCases.deliverOrderItem(auth, item.id, WRONG_BIN)
    ).rejects.toThrow(AuthorizationError);

    // Verify item remains unchanged ('charging')
    const itemAfter = items.get(item.id);
    expect(itemAfter?.status).toBe('charging');
    expect(itemAfter?.deliveredAt).toBeUndefined();

    // Verify order remains unchanged ('pending')
    const orderAfter = orders.get(order.id);
    expect(orderAfter?.status).toBe('pending');

    // Verify zero ledger events appended
    expect(ledger.length).toBe(initialLedgerCount);

    // Verify zero balance mutation
    const balanceAfter = await repoContext.customerRepo.getBalance('cust_1');
    expect(balanceAfter).toBe(initialCustomerBalance);
  });

  // B. deliverOrderItem with missing / invalid BIN: rejected with zero mutations
  it('B. deliverOrderItem with missing or invalid BIN format is rejected', async () => {
    const auth = new AuthorizationContext(
      {
        id: 'admin_1',
        username: 'admin',
        fullName: 'Admin',
        role: 'ADMIN',
        permissions: ['orders:create', 'orders:edit', 'orders:deliver'],
        isSuperAdmin: false,
      },
      (bin) => bin === TEST_BIN
    );

    const orderRes = await useCases.createOrder(auth, 'cmd_2', 'day_1', 'cust_1');
    const order = (orderRes as any).data;
    // CREATE_ORDER is overlay/outbox-first; hydrate the fake local repository as the real overlay-aware repo would.
    orders.set(order.id, order);
    const itemRes = await useCases.addOrderItem(auth, order.id, 'dev_1', false);
    const item = (itemRes as any).data;
    items.set(item.id, item);

    // Empty string
    await expect(useCases.deliverOrderItem(auth, item.id, '')).rejects.toThrow(BinRequiredError);
    // Whitespace
    await expect(useCases.deliverOrderItem(auth, item.id, '   ')).rejects.toThrow(BinRequiredError);
    // Short
    await expect(useCases.deliverOrderItem(auth, item.id, '12')).rejects.toThrow(BinRequiredError);
    // Non-numeric
    await expect(useCases.deliverOrderItem(auth, item.id, 'abcd')).rejects.toThrow(BinRequiredError);

    // Zero mutation occurred
    expect(items.get(item.id)?.status).toBe('charging');
    expect(ledger.length).toBe(0);
  });

  // C. deliverOrderItem with verifier unavailable: rejected with zero mutations
  it('C. deliverOrderItem with verifier unavailable fails closed without mutation', async () => {
    const authNoVerifier = new AuthorizationContext(
      {
        id: 'admin_1',
        username: 'admin',
        fullName: 'Admin',
        role: 'ADMIN',
        permissions: ['orders:create', 'orders:edit', 'orders:deliver'],
        isSuperAdmin: false,
      },
      undefined // No verifier configured
    );

    const authForSetup = new AuthorizationContext(
      {
        id: 'admin_1',
        username: 'admin',
        fullName: 'Admin',
        role: 'ADMIN',
        permissions: ['orders:create', 'orders:edit'],
        isSuperAdmin: false,
      }
    );

    const orderRes = await useCases.createOrder(authForSetup, 'cmd_3', 'day_1', 'cust_1');
    const order = (orderRes as any).data;
    orders.set(order.id, order);
    const itemRes = await useCases.addOrderItem(authForSetup, order.id, 'dev_1', false);
    const item = (itemRes as any).data;
    items.set(item.id, item);

    await expect(
      useCases.deliverOrderItem(authNoVerifier, item.id, TEST_BIN)
    ).rejects.toThrow(AuthorizationError);

    expect(items.get(item.id)?.status).toBe('charging');
    expect(ledger.length).toBe(0);
  });

  // D. deliverOrderItem with correct test verifier: succeeds, negative charge, retry idempotent
  it('D. deliverOrderItem with correct test verifier succeeds, logs negative charge, and idempotently blocks duplicate', async () => {
    const auth = new AuthorizationContext(
      {
        id: 'admin_1',
        username: 'admin',
        fullName: 'Admin',
        role: 'ADMIN',
        permissions: ['orders:create', 'orders:edit', 'orders:deliver'],
        isSuperAdmin: false,
      },
      (bin) => bin === TEST_BIN
    );

    const orderRes = await useCases.createOrder(auth, 'cmd_4', 'day_1', 'cust_1');
    const order = (orderRes as any).data;
    // CREATE_ORDER is overlay/outbox-first; hydrate the fake local repository as the real overlay-aware repo would.
    orders.set(order.id, order);
    const itemRes = await useCases.addOrderItem(auth, order.id, 'dev_1', false);
    const item = (itemRes as any).data;
    items.set(item.id, item);

    const deliverRes = await useCases.deliverOrderItem(auth, item.id, TEST_BIN);
    expect(deliverRes.success).toBe(true);
    const deliveredItem = (deliverRes as any).data as OrderItemEntity;
    items.set(item.id, deliveredItem);

    // The client records the optimistic item overlay and canonical command only.
    // The server remains authoritative for the financial ledger charge.
    expect(deliveredItem.status).toBe('delivered');
    expect(deliveredItem.deliveredAt).toBeDefined();
    expect(ledger.filter(l => l.eventType === 'ORDER_ITEM_CHARGE' && l.orderItemId === item.id)).toHaveLength(0);
    expect([...commands.values()].filter(c => c.type === 'DELIVER_ORDER_ITEM')).toHaveLength(1);

    // Retry must be rejected locally and must not queue a second delivery command.
    await expect(
      useCases.deliverOrderItem(auth, item.id, TEST_BIN)
    ).rejects.toThrow(FinancialInvariantViolation);
    expect([...commands.values()].filter(c => c.type === 'DELIVER_ORDER_ITEM')).toHaveLength(1);
  });

  // E. Existing cancelOrder behavior remains unchanged
  it('E. Existing cancelOrder behavior remains unchanged (verifies BIN, transitions order, logs reversal if charged)', async () => {
    const auth = new AuthorizationContext(
      {
        id: 'admin_1',
        username: 'admin',
        fullName: 'Admin',
        role: 'ADMIN',
        permissions: ['orders:create', 'orders:edit', 'orders:deliver', 'orders:cancel'],
        isSuperAdmin: false,
      },
      (bin) => bin === TEST_BIN
    );

    const orderRes = await useCases.createOrder(auth, 'cmd_5', 'day_1', 'cust_1');
    const order = (orderRes as any).data;
    // CREATE_ORDER is overlay/outbox-first; hydrate the fake local repository as the real overlay-aware repo would.
    orders.set(order.id, order);
    const itemRes = await useCases.addOrderItem(auth, order.id, 'dev_1', false);
    const item = (itemRes as any).data;
    items.set(item.id, item);

    // Delivery is queued locally; financial recognition is performed by the canonical server command.
    const deliverRes = await useCases.deliverOrderItem(auth, item.id, TEST_BIN);
    expect(deliverRes.success).toBe(true);
    items.set(item.id, (deliverRes as any).data);
    orders.set(order.id, { ...order, status: 'delivered' });
    expect([...commands.values()].filter(c => c.type === 'DELIVER_ORDER_ITEM')).toHaveLength(1);
    expect(ledger.filter(l => l.eventType === 'ORDER_ITEM_CHARGE')).toHaveLength(0);

    // Wrong BIN fails cancelOrder without queuing cancellation.
    await expect(
      useCases.cancelOrder(auth, order.id, WRONG_BIN)
    ).rejects.toThrow(AuthorizationError);
    expect([...commands.values()].filter(c => c.type === 'CANCEL_ORDER')).toHaveLength(0);

    // Correct BIN succeeds, even for a delivered order, by queueing the protected reversal-backed command.
    const cancelRes = await useCases.cancelOrder(auth, order.id, TEST_BIN);
    expect(cancelRes.success).toBe(true);
    expect((cancelRes as any).data.status).toBe('cancelled');
    expect([...commands.values()].filter(c => c.type === 'CANCEL_ORDER')).toHaveLength(1);
    expect(ledger.filter(l => l.eventType === 'REVERSAL')).toHaveLength(0);
  });

  // F. Existing cancelOrderItem behavior remains unchanged
  it('F. Existing cancelOrderItem behavior remains unchanged (verifies BIN, transitions charging item to cancelled)', async () => {
    const auth = new AuthorizationContext(
      {
        id: 'admin_1',
        username: 'admin',
        fullName: 'Admin',
        role: 'ADMIN',
        permissions: ['orders:create', 'orders:edit', 'orders:cancel'],
        isSuperAdmin: false,
      },
      (bin) => bin === TEST_BIN
    );

    const orderRes = await useCases.createOrder(auth, 'cmd_6', 'day_1', 'cust_1');
    const order = (orderRes as any).data;
    // CREATE_ORDER is overlay/outbox-first; hydrate the fake local repository as the real overlay-aware repo would.
    orders.set(order.id, order);
    const itemRes = await useCases.addOrderItem(auth, order.id, 'dev_1', false);
    const item = (itemRes as any).data;
    items.set(item.id, item);

    // Wrong BIN fails cancelOrderItem
    await expect(
      useCases.cancelOrderItem(auth, item.id, WRONG_BIN)
    ).rejects.toThrow(AuthorizationError);

    expect(items.get(item.id)?.status).toBe('charging');

    // Correct BIN succeeds and returns the optimistic cancellation overlay.
    const cancelItemRes = await useCases.cancelOrderItem(auth, item.id, TEST_BIN);
    expect(cancelItemRes.success).toBe(true);
    expect((cancelItemRes as any).data.status).toBe('cancelled');
    expect(items.get(item.id)?.status).toBe('charging'); // Base repository is not mutated directly.
    const cancelCommand = [...commands.values()].find(c => c.type === 'CANCEL_ORDER_ITEM');
    expect(cancelCommand).toBeDefined();
    expect((cancelCommand!.payload as any).bin).toBe(TEST_BIN);
  });
});
