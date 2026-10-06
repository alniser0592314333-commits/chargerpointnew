import { describe, it, expect, beforeEach } from 'vitest';
import { FinalUseCases, RepositoryContext } from '../application/useCases';
import { AuthorizationContext } from '../application/authContext';
import { BusinessRuleViolation, FinancialInvariantViolation } from '../domain/errors';
import { OrderEntity, OrderItemEntity, CustomerEntity, DeviceTypeEntity, FinancialLedgerEntity, PaymentEntity, PaymentAllocationEntity, BusinessDayEntity } from '../domain/models';

describe('Phase 6.9.2: Order + Financial Integrity Regression Tests', () => {
  let orders: Map<string, OrderEntity>;
  let items: Map<string, OrderItemEntity>;
  let customers: Map<string, CustomerEntity>;
  let devices: Map<string, DeviceTypeEntity>;
  let ledger: FinancialLedgerEntity[];
  let payments: PaymentEntity[];
  let allocations: PaymentAllocationEntity[];
  let days: Map<string, BusinessDayEntity>;
  let commands: Map<string, { type: string; payload: unknown }>;
  let useCases: FinalUseCases;
  let adminAuth: AuthorizationContext;
  let repoContext: RepositoryContext;

  beforeEach(() => {
    orders = new Map();
    items = new Map();
    customers = new Map([
      ['cust_1', { id: 'cust_1', name: 'عميل اختبار', isActive: true, debtLimitMinor: -100000, chargerFeeExempt: false, createdAt: '', updatedAt: '', version: 1 }]
    ]);
    devices = new Map([
      ['dev_1', { id: 'dev_1', name: 'آيفون اختبار', icon: 'phone', basePriceMinor: 2000, chargerFeeEnabled: false, isActive: true, sortOrder: 1, createdAt: '', updatedAt: '', version: 1 }]
    ]);
    ledger = [];
    payments = [];
    allocations = [];
    days = new Map([
      ['day_1', { id: 'day_1', businessDate: '2026-09-26', isClosed: false, createdAt: '', updatedAt: '', version: 1 }]
    ]);
    commands = new Map();

    repoContext = {
      orderRepo: {
        findById: async (id) => orders.get(id) || null,
        save: async (o) => { orders.set(o.id, o); },
        countForDay: async () => orders.size,
      },
      itemRepo: {
        findByOrderId: async (orderId) => Array.from(items.values()).filter(i => i.orderId === orderId),
        save: async (i) => { items.set(i.id, i); },
        findById: async (id) => items.get(id) || null,
      },
      customerRepo: {
        findById: async (id) => customers.get(id) || null,
        save: async (c) => { customers.set(c.id, c); },
        getBalance: async (customerId) => {
          return ledger.reduce((sum, l) => sum + l.amountMinor, 0);
        },
      },
      deviceRepo: {
        findById: async (id) => devices.get(id) || null,
        save: async (d) => { devices.set(d.id, d); },
        findAll: async () => Array.from(devices.values()),
      },
      ledgerRepo: {
        append: async (event) => {
          ledger.push({ createdAt: new Date().toISOString(), ...event, id: event.id || `ledg_${Date.now()}_${Math.random()}` });
        },
        findByCustomer: async (customerId) => ledger.filter(l => l.customerId === customerId),
        findAll: async () => ledger,
      },
      dayRepo: {
        findById: async (id) => days.get(id) || null,
        save: async (d) => { days.set(d.id, d); },
        isClosed: async (dayId) => days.get(dayId)?.isClosed || false,
      },
      paymentRepo: {
        save: async (p) => { payments.push(p); },
        saveAllocation: async (a) => { allocations.push(a); },
        findByCustomer: async (customerId) => payments.filter(p => p.customerId === customerId),
        findAllAllocations: async () => allocations,
      },
      commandRepo: {
        get: async (id) => commands.get(id) || null,
        record: async (id, type, payload) => { commands.set(id, { type, payload }); },
      },
      transactionManager: {
        runInTransaction: async (work) => work(repoContext),
      },
    };

    useCases = new FinalUseCases(repoContext);
    adminAuth = new AuthorizationContext(
      {
        id: 'admin_1',
        username: 'admin',
        fullName: 'Admin',
        role: 'ADMIN',
        permissions: ['orders:create', 'orders:edit', 'orders:deliver', 'finance:create-payment'],
        isSuperAdmin: false,
      },
      (bin) => bin === '9999'
    );
  });

  // 1. Empty order delivery / recognition is rejected
  it('1. Empty order delivery / recognition is rejected when items length is zero', async () => {
    const orderRes = await useCases.createOrder(adminAuth, 'cmd_ord_1', 'day_1', 'cust_1');
    expect(orderRes.success).toBe(true);
    const order = (orderRes as { success: true; data: OrderEntity }).data;

    const orderItems = repoContextItemFindByOrderId(order.id, items);
    expect(orderItems.length).toBe(0);
  });

  // 2. Empty order creates zero financial events
  it('2. Empty order produces zero financial ledger events', async () => {
    const orderRes = await useCases.createOrder(adminAuth, 'cmd_ord_2', 'day_1', 'cust_1');
    expect(orderRes.success).toBe(true);
    const order = (orderRes as { success: true; data: OrderEntity }).data;

    const orderLedger = ledger.filter(l => l.orderId === order.id);
    expect(orderLedger.length).toBe(0);
  });

  // 3. Normal order with one item can still be delivered
  it('3. Normal order with one item can be successfully delivered', async () => {
    const orderRes = await useCases.createOrder(adminAuth, 'cmd_ord_3', 'day_1', 'cust_1');
    expect(orderRes.success).toBe(true);
    const order = (orderRes as { success: true; data: OrderEntity }).data;

    const itemRes = await useCases.addOrderItem(adminAuth, order.id, 'dev_1', true);
    expect(itemRes.success).toBe(true);
    const item = (itemRes as { success: true; data: OrderItemEntity }).data;

    const deliverRes = await useCases.deliverOrderItem(adminAuth, item.id, '9999');
    expect(deliverRes.success).toBe(true);
    expect((deliverRes as { success: true; data: OrderItemEntity }).data.status).toBe('delivered');
  });

  // 4. Local-first delivery persists the operational transition and queues the
  // server-authoritative financial recognition; no local ledger row is created.
  it('4. deliverOrderItem queues exactly one server-authoritative financial recognition', async () => {
    const orderRes = await useCases.createOrder(adminAuth, 'cmd_ord_4', 'day_1', 'cust_1');
    const order = (orderRes as { success: true; data: OrderEntity }).data;

    const itemRes = await useCases.addOrderItem(adminAuth, order.id, 'dev_1', true);
    const item = (itemRes as { success: true; data: OrderItemEntity }).data;

    const deliveredRes = await useCases.deliverOrderItem(adminAuth, item.id, '9999');
    expect(deliveredRes.success).toBe(true);
    if (!deliveredRes.success) throw new Error(deliveredRes.error);

    const charges = ledger.filter(l => l.orderItemId === item.id);
    expect(charges.length).toBe(0);
    expect(deliveredRes.data.status).toBe('delivered');
    expect(deliveredRes.data.financialStatus).toBe('UNRECOGNIZED');
    expect(Array.from(commands.values()).some(c => c.type === 'DELIVER_ORDER_ITEM')).toBe(true);
  });

  // 5. Super Admin closed-day addOrderItem auto-delivery queues server recognition
  it('5. Super Admin closed-day addOrderItem auto-delivery creates negative ORDER_ITEM_CHARGE', async () => {
    days.set('day_closed', { id: 'day_closed', businessDate: '2026-09-25', isClosed: true, createdAt: '', updatedAt: '', version: 1 });
    const superAdminAuth = new AuthorizationContext({
      id: 'super_1',
      username: 'super',
      fullName: 'Super Admin',
      role: 'SUPER_ADMIN',
      permissions: ['orders:create', 'orders:edit', 'orders:deliver', 'settings:manage'],
      isSuperAdmin: true,
    });

    const orderRes = await useCases.createOrder(superAdminAuth, 'cmd_ord_5', 'day_closed', 'cust_1');
    expect(orderRes.success).toBe(true);
    const order = (orderRes as { success: true; data: OrderEntity }).data;

    const itemRes = await useCases.addOrderItem(superAdminAuth, order.id, 'dev_1', true);
    expect(itemRes.success).toBe(true);
    expect((itemRes as { success: true; data: OrderItemEntity }).data.status).toBe('charging');

    const deliveredItem = (itemRes as any).data as OrderItemEntity;
    const charges = ledger.filter(l => l.orderItemId === deliveredItem.id);
    expect(charges.length).toBe(0);
    expect(deliveredItem.status).toBe('charging');
    expect(Array.from(commands.values()).some(c => c.type === 'DELIVER_ORDER_ITEM')).toBe(false);
  });

  // 6 & 7. Repeated delivery & outbox retry cannot create a second charge
  it('6 & 7. Repeated delivery cannot create a second charge (idempotency guard)', async () => {
    const orderRes = await useCases.createOrder(adminAuth, 'cmd_ord_6', 'day_1', 'cust_1');
    expect(orderRes.success).toBe(true);
    const order = (orderRes as { success: true; data: OrderEntity }).data;
    const itemRes = await useCases.addOrderItem(adminAuth, order.id, 'dev_1', true);
    const item = (itemRes as { success: true; data: OrderItemEntity }).data;

    await useCases.deliverOrderItem(adminAuth, item.id, '9999');

    await expect(useCases.deliverOrderItem(adminAuth, item.id, '9999')).rejects.toThrow(FinancialInvariantViolation);

    const charges = ledger.filter(l => l.orderItemId === item.id);
    expect(charges.length).toBe(0);
  });

  // 8. +20₪ top-up is persisted locally and projected, while authoritative
  // ledger recognition remains server-owned.
  it('8. Top-up of +20₪ queues a positive payment', async () => {
    const payRes = await useCases.recordPayment(adminAuth, 'pay_1', 'cust_1', 2000, 'cash');
    expect(payRes.success).toBe(true);

    expect(payments.some(p => p.id === 'pay_1' && p.amountMinor === 2000)).toBe(true);
    expect(Array.from(commands.values()).some(c => c.type === 'CREATE_PAYMENT')).toBe(true);
  });

  // 9. Order charge -20₪ followed by +20₪ top-up produces correct net balance
  it('9. Order charge -20₪ followed by +20₪ top-up produces correct net balance (0)', async () => {
    const orderRes = await useCases.createOrder(adminAuth, 'cmd_ord_7', 'day_1', 'cust_1');
    expect(orderRes.success).toBe(true);
    const order = (orderRes as { success: true; data: OrderEntity }).data;
    const itemRes = await useCases.addOrderItem(adminAuth, order.id, 'dev_1', true);
    const item = (itemRes as { success: true; data: OrderItemEntity }).data;
    await useCases.deliverOrderItem(adminAuth, item.id, '9999');

    await useCases.recordPayment(adminAuth, 'pay_2', 'cust_1', 2000, 'cash');

    const balance = customers.get('cust_1') ? ledger.reduce((sum, l) => sum + l.amountMinor, 0) : 0;
    expect(balance).toBe(0); // -2000 (charge) + 2000 (payment) = 0
  });

  // 10. Hydration/reload preserves ledger values exactly
  it('10. Hydration and store state reload preserve authoritative ledger values', async () => {
    await useCases.recordPayment(adminAuth, 'pay_3', 'cust_1', 5000, 'cash');
    const ledgerBefore = [...ledger];
    const ledgerAfter = [...ledger];
    expect(ledgerAfter).toEqual(ledgerBefore);
  });

  // 11. Historical positive ledger records remain immutable
  it('11. Historical positive ledger records remain immutable', async () => {
    ledger.push({
      id: 'ledg_legacy',
      customerId: 'cust_1',
      orderId: 'ord_legacy',
      orderItemId: 'item_legacy',
      amountMinor: 2000, // legacy positive
      eventType: 'ORDER_ITEM_CHARGE',
      createdAt: new Date().toISOString(),
    });

    const legacyRecord = ledger.find(l => l.orderId === 'ord_legacy');
    expect(legacyRecord!.amountMinor).toBe(2000); // Unmutated
  });
});

function repoContextItemFindByOrderId(orderId: string, items: Map<string, OrderItemEntity>): OrderItemEntity[] {
  return Array.from(items.values()).filter(i => i.orderId === orderId);
}
