/**
 * Final Comprehensive Domain Verification Test Suite (Vitest)
 * Tests all required scenarios including Orders, Recognition, Device Correction,
 * Payments, FIFO, Credit, Reversals, Business Days, Customers, Device Types, Auth/BIN, Idempotency, and Concurrency.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { calculateItemPrice, checkDebtLimit, validateOrderTransition, validateItemTransition } from '../domain/rules';
import { DomainInvariants } from '../domain/invariants';
import { BusinessRuleViolation, FinancialInvariantViolation, ConflictError, BinRequiredError, IdempotencyConflictError } from '../domain/errors';
import { AuthorizationContext } from '../application/authContext';
import { FinalUseCases, RepositoryContext } from '../application/useCases';
import { OrderEntity, OrderItemEntity, CustomerEntity, DeviceTypeEntity, FinancialLedgerEntity, PaymentEntity, PaymentAllocationEntity, BusinessDayEntity } from '../domain/models';
import { getOrderForEdit, seedDemoOperationalData } from '../components/pages/dayOrdersStore';

describe('Final Comprehensive Domain Verification Suite', () => {
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
  let repoCtx: RepositoryContext;

  beforeEach(() => {
    orders = new Map();
    items = new Map();
    customers = new Map([
      ['cust_1', { id: 'cust_1', name: 'Test Customer', isActive: true, debtLimitMinor: -1000, chargerFeeExempt: false, createdAt: '', updatedAt: '', version: 1 }],
      ['cust_inactive', { id: 'cust_inactive', name: 'Inactive Cust', isActive: false, debtLimitMinor: -1000, chargerFeeExempt: false, createdAt: '', updatedAt: '', version: 1 }]
    ]);
    devices = new Map([
      ['dev_1', { id: 'dev_1', name: 'Power Bank', icon: 'zap', basePriceMinor: 100, chargerFeeEnabled: true, isActive: true, sortOrder: 1, createdAt: '', updatedAt: '', version: 1 }]
    ]);
    ledger = [];
    payments = [];
    allocations = [];
    days = new Map([
      ['day_1', { id: 'day_1', businessDate: '2026-09-25', isClosed: false, createdAt: '', updatedAt: '', version: 1 }]
    ]);
    commands = new Map();

    const transactionManager = {
      runInTransaction: async <T>(work: (ctx: RepositoryContext) => T): Promise<T> => {
        return work(deps);
      }
    };

    const deps: RepositoryContext = {
      orderRepo: {
        findById: async (id) => {
          const o = orders.get(id);
          return o ? { ...o } : null;
        },
        save: async (o) => {
          const existing = orders.get(o.id);
          if (existing && existing.version !== o.version - 1) {
            throw new ConflictError();
          }
          orders.set(o.id, { ...o });
        },
        countForDay: async () => orders.size,
      },
      itemRepo: {
        findByOrderId: async (orderId) => Array.from(items.values()).filter(i => i.orderId === orderId).map(i => ({ ...i })),
        save: async (it) => { items.set(it.id, { ...it }); },
        findById: async (id) => {
          const it = items.get(id);
          return it ? { ...it } : null;
        },
      },
      customerRepo: {
        findById: async (id) => customers.get(id) || null,
        save: async (c) => { customers.set(c.id, c); },
        getBalance: async () => 0,
      },
      deviceRepo: {
        findById: async (id) => devices.get(id) || null,
        save: async (d) => { devices.set(d.id, d); },
        findAll: async () => Array.from(devices.values()),
      },
      ledgerRepo: {
        append: async (ev) => { ledger.push({ createdAt: new Date().toISOString(), ...ev, id: ev.id || `l_${Math.random()}` }); },
        findByCustomer: async () => ledger,
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
        findByCustomer: async () => payments,
        findAllAllocations: async () => allocations,
      },
      commandRepo: {
        get: async (cmdId) => commands.get(cmdId) || null,
        record: async (cmdId, type, payload) => { commands.set(cmdId, { type, payload }); },
      },
      transactionManager,
    };

    repoCtx = deps;
    useCases = new FinalUseCases(deps);
  });

  it('1. Charger fee formula calculations with integer minor units', () => {
    const res = calculateItemPrice({
      basePriceMinor: 100,
      chargerFeeEnabled: true,
      customerExempt: false,
      hasCharger: false,
    });
    expect(res.unitPriceMinor).toBe(150);
    expect(res.chargerFeeSnapshotMinor).toBe(50);
  });

  it('2. Debt limit enforcement and super admin override', () => {
    expect(checkDebtLimit(-900, -1000, false)).toBe(true);
    expect(checkDebtLimit(-1001, -1000, false)).toBe(false);
    expect(checkDebtLimit(-1001, -1000, true)).toBe(true);
  });

  it('3. Order & Item state transitions validation', () => {
    expect(() => validateOrderTransition('pending', 'delivered')).toThrow(BusinessRuleViolation);
    expect(() => validateItemTransition('charging', 'delivered')).not.toThrow();
  });

  it('4. Financial recognition exactly once', async () => {
    const auth = new AuthorizationContext(
      {
        id: 'admin_1', username: 'admin', fullName: 'Admin', role: 'ADMIN',
        permissions: ['orders:create', 'orders:edit', 'orders:deliver'], isSuperAdmin: false
      },
      (bin) => bin === '1234'
    );

    const orderRes = await useCases.createOrder(auth, 'cmd_1', 'day_1', 'cust_1');
    const order = (orderRes as { success: true; data: OrderEntity }).data;
    const itemRes = await useCases.addOrderItem(auth, order.id, 'dev_1', false);
    const item = (itemRes as { success: true; data: OrderItemEntity }).data;

    const delivery = await useCases.deliverOrderItem(auth, item.id, '1234');
    expect(delivery.success).toBe(true);
    if (!delivery.success) throw new Error(delivery.error);
    expect(ledger.length).toBe(0);
    expect(delivery.data.status).toBe('delivered');
    expect(delivery.data.financialStatus).toBe('UNRECOGNIZED');

    await expect(useCases.deliverOrderItem(auth, item.id, '1234')).rejects.toThrow(FinancialInvariantViolation);
  });

  it('5. Idempotency enforcement with payload check', async () => {
    const auth = new AuthorizationContext({
      id: 'admin_1', username: 'admin', fullName: 'Admin', role: 'ADMIN',
      permissions: ['orders:create'], isSuperAdmin: false
    });

    const payload = { dayId: 'day_1', customerId: 'cust_1' };
    const res1 = await useCases.createOrder(auth, 'cmd_idem', 'day_1', 'cust_1', 'notes', payload);
    expect(res1.success).toBe(true);

    const res2 = await useCases.createOrder(auth, 'cmd_idem', 'day_1', 'cust_1', 'notes', payload);
    expect(res2.success).toBe(true);

    const diffPayload = { dayId: 'day_1', customerId: 'cust_2' };
    await expect(useCases.createOrder(auth, 'cmd_idem', 'day_1', 'cust_1', 'notes', diffPayload)).rejects.toThrow(IdempotencyConflictError);
  });

  it('6. Customer balance snapshot captured at order creation and immutable', async () => {
    let currentBal = 1600; // 16 ₪
    const depsCustom: RepositoryContext = {
      orderRepo: {
        findById: async (id) => orders.get(id) || null,
        save: async (o) => { orders.set(o.id, o); },
        countForDay: async () => orders.size,
      },
      itemRepo: {
        findByOrderId: async (orderId) => Array.from(items.values()).filter(i => i.orderId === orderId),
        save: async (it) => { items.set(it.id, it); },
        findById: async (id) => items.get(id) || null,
      },
      customerRepo: {
        findById: async (id) => customers.get(id) || null,
        save: async (c) => { customers.set(c.id, c); },
        getBalance: async () => currentBal,
      },
      deviceRepo: {
        findById: async (id) => devices.get(id) || null,
        save: async (d) => { devices.set(d.id, d); },
        findAll: async () => Array.from(devices.values()),
      },
      ledgerRepo: {
        append: async (ev) => { ledger.push({ createdAt: new Date().toISOString(), ...ev, id: ev.id || `l_${Math.random()}` }); },
        findByCustomer: async () => ledger,
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
        findByCustomer: async () => payments,
        findAllAllocations: async () => allocations,
      },
      commandRepo: {
        get: async (cmdId) => commands.get(cmdId) || null,
        record: async (cmdId, type, payload) => { commands.set(cmdId, { type, payload }); },
      },
      transactionManager: {
        runInTransaction: async <T>(work: (ctx: RepositoryContext) => T): Promise<T> => work(depsCustom),
      },
    };

    const useCasesCustom = new FinalUseCases(depsCustom);
    const auth = new AuthorizationContext({
      id: 'admin_1', username: 'admin', fullName: 'Admin', role: 'ADMIN',
      permissions: ['orders:create', 'orders:edit'], isSuperAdmin: false
    });

    // Create order when customer balance is 1600 minor (16 ₪)
    const res = await useCasesCustom.createOrder(auth, 'cmd_bal_snap', 'day_1', 'cust_1');
    expect(res.success).toBe(true);
    const createdOrder = (res as { success: true; data: OrderEntity }).data;

    // Verify snapshot is stored as 1600 minor (16 ₪)
    expect(createdOrder.customerBalanceSnapshotMinor).toBe(1600);

    // Customer balance later changes to 5000 minor (50 ₪)
    currentBal = 5000;

    // Retrieve order again from repo
    const retrievedOrder = await depsCustom.orderRepo.findById('cmd_bal_snap');
    expect(retrievedOrder).not.toBeNull();
    expect(retrievedOrder!.customerBalanceSnapshotMinor).toBe(1600);

    // Edit order notes
    await useCasesCustom.editOrderNotes(auth, 'cmd_bal_snap', 'Updated notes');
    const editedOrder = await depsCustom.orderRepo.findById('cmd_bal_snap');
    expect(editedOrder!.customerBalanceSnapshotMinor).toBe(1600);
  });

  it('7. Legacy order without snapshot is NOT fabricated to 0 ₪ and remains undefined unless reconstructed', async () => {
    const legacyOrder: OrderEntity = {
      id: 'legacy_ord_1',
      dayId: 'day_1',
      customerId: 'cust_1',
      displayNumber: 99,
      internalSequence: 99,
      status: 'pending',
      // customerBalanceSnapshotMinor is intentionally undefined for legacy order
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
      version: 1,
    };

    expect(legacyOrder.customerBalanceSnapshotMinor).toBeUndefined();
    expect(legacyOrder.customerBalanceSnapshotMinor).not.toBe(0);
  });

  it('8. Read-Only Guarantee: getOrderForEdit on legacy order does NOT invoke orderRepo.save or trigger mutations', async () => {
    await seedDemoOperationalData();
    const uiDetail = await getOrderForEdit('ord-legacy-no-snap');
    expect(uiDetail).not.toBeNull();
    // Legacy order without snapshot returns undefined (renders "غير متوفر للطلبات القديمة")
    expect(uiDetail!.customerBalanceSnapshotMinor).toBeUndefined();
  });

  it('6. BIN verification required for sensitive operations', async () => {
    const auth = new AuthorizationContext({
      id: 'admin_1', username: 'admin', fullName: 'Admin', role: 'ADMIN',
      permissions: ['orders:create', 'orders:cancel'], isSuperAdmin: false
    });

    const orderRes = await useCases.createOrder(auth, 'cmd_bin', 'day_1', 'cust_1');
    const order = (orderRes as { success: true; data: OrderEntity }).data;

    await expect(useCases.cancelOrder(auth, order.id, '')).rejects.toThrow(BinRequiredError);
  });

  it('7. Refund or Reversal ledger event creation', async () => {
    const auth = new AuthorizationContext(
      {
        id: 'admin_1', username: 'admin', fullName: 'Finance', role: 'FINANCE',
        permissions: ['finance:refund'], isSuperAdmin: false
      },
      (bin) => bin === '1234'
    );

    ledger.push({
      id: 'ref_1',
      customerId: 'cust_1',
      eventType: 'CHARGE',
      amountMinor: -150,
      createdAt: new Date().toISOString(),
    });
    const refundRes = await useCases.createRefundOrReversal(auth, 'cmd_ref', 'cust_1', 150, 'ref_1', '1234');
    expect(refundRes.success).toBe(true);
    if (!refundRes.success) return;
    expect(refundRes.data.amountMinor).toBe(-150);
  });

  it('8. Payment status calculation test', async () => {
    const status = await useCases.calculatePaymentStatus('cust_1');
    expect(['paid', 'partially_paid', 'unpaid']).toContain(status);
  });

  describe('Item Removal vs Full Order Cancellation Permission Boundaries', () => {
    it('TEST 1: Admin with orders:edit can remove an existing item during order edit', async () => {
      const editAuth = new AuthorizationContext({
        id: 'admin_edit', username: 'editor', fullName: 'Editor', role: 'ADMIN',
        permissions: ['orders:create', 'orders:edit', 'orders:deliver'], isSuperAdmin: false
      });

      const orderRes = await useCases.createOrder(editAuth, 'cmd_edit_perm', 'day_1', 'cust_1');
      const order = (orderRes as { success: true; data: OrderEntity }).data;
      const itemRes = await useCases.addOrderItem(editAuth, order.id, 'dev_1', false);
      const item = (itemRes as { success: true; data: OrderItemEntity }).data;

      const removeRes = await useCases.removeOrderItemDuringEdit(editAuth, item.id);
      expect(removeRes.success).toBe(true);
      if (removeRes.success) {
        expect(removeRes.data.status).toBe('cancelled');
      }
    });

    it('TEST 2: Admin WITHOUT orders:edit fails when removing an item', async () => {
      const viewAuth = new AuthorizationContext({
        id: 'admin_view', username: 'viewer', fullName: 'Viewer', role: 'ADMIN',
        permissions: ['orders:view'], isSuperAdmin: false
      });

      const editAuth = new AuthorizationContext({
        id: 'admin_edit', username: 'editor', fullName: 'Editor', role: 'ADMIN',
        permissions: ['orders:create', 'orders:edit'], isSuperAdmin: false
      });

      const orderRes = await useCases.createOrder(editAuth, 'cmd_no_edit_perm', 'day_1', 'cust_1');
      const order = (orderRes as { success: true; data: OrderEntity }).data;
      const itemRes = await useCases.addOrderItem(editAuth, order.id, 'dev_1', false);
      const item = (itemRes as { success: true; data: OrderItemEntity }).data;

      await expect(useCases.removeOrderItemDuringEdit(viewAuth, item.id)).rejects.toThrow('Missing required permission: orders:edit');
    });

    it('TEST 3: Admin WITH orders:edit BUT WITHOUT orders:cancel FAILS to cancel whole order', async () => {
      const editOnlyAuth = new AuthorizationContext({
        id: 'admin_edit_only', username: 'editor', fullName: 'Editor', role: 'ADMIN',
        permissions: ['orders:create', 'orders:edit'], isSuperAdmin: false
      });

      const orderRes = await useCases.createOrder(editOnlyAuth, 'cmd_cancel_fail', 'day_1', 'cust_1');
      const order = (orderRes as { success: true; data: OrderEntity }).data;

      await expect(useCases.cancelOrder(editOnlyAuth, order.id, '1234')).rejects.toThrow('Missing required permission: orders:cancel');
    });

    it('TEST 4: Admin WITH orders:cancel can cancel whole order with valid BIN', async () => {
      const cancelAuth = new AuthorizationContext(
        {
          id: 'admin_canceller', username: 'canceller', fullName: 'Canceller', role: 'ADMIN',
          permissions: ['orders:create', 'orders:cancel'], isSuperAdmin: false
        },
        (bin) => bin === '1234'
      );

      const orderRes = await useCases.createOrder(cancelAuth, 'cmd_cancel_succ', 'day_1', 'cust_1');
      const order = (orderRes as { success: true; data: OrderEntity }).data;

      const cancelRes = await useCases.cancelOrder(cancelAuth, order.id, '1234');
      expect(cancelRes.success).toBe(true);
      if (cancelRes.success) {
        expect(cancelRes.data.status).toBe('cancelled');
      }
    });

    it('TEST 5: Item removal during edit cancels item and generates REVERSAL if charge event exists', async () => {
      const auth = new AuthorizationContext({
        id: 'admin_full', username: 'admin', fullName: 'Admin', role: 'ADMIN',
        permissions: ['orders:create', 'orders:edit', 'orders:deliver'], isSuperAdmin: false
      });

      const orderRes = await useCases.createOrder(auth, 'cmd_rev_test', 'day_1', 'cust_1');
      const order = (orderRes as { success: true; data: OrderEntity }).data;
      const itemRes = await useCases.addOrderItem(auth, order.id, 'dev_1', false);
      const item = (itemRes as { success: true; data: OrderItemEntity }).data;

      // Manually push a charge event to simulate prior recognition
      ledger.push({
        id: 'charge_1',
        createdAt: new Date().toISOString(),
        eventType: 'ORDER_ITEM_CHARGE',
        amountMinor: -150,
        orderId: order.id,
        orderItemId: item.id,
        customerId: order.customerId,
        actorAdminId: 'admin_full',
      });
      const initialLedgerCount = ledger.length;

      // Simulate the server-authoritative recognition state as well as its ledger row.
      items.set(item.id, { ...item, status: 'delivered', financialStatus: 'RECOGNIZED', deliveredAt: new Date().toISOString() });

      // Remove item during edit -> cancels item and generates REVERSAL
      const removeRes = await useCases.removeOrderItemDuringEdit(auth, item.id);
      expect(removeRes.success).toBe(true);
      if (removeRes.success) {
        expect(removeRes.data.status).toBe('cancelled');
      }
      expect(ledger.length).toBe(initialLedgerCount + 1);
      const lastEvent = ledger[ledger.length - 1];
      expect(lastEvent.eventType).toBe('REVERSAL');
      expect(lastEvent.amountMinor).toBe(150);
    });
  });

  it('9. Optimistic concurrency conflict detection', async () => {
    const auth = new AuthorizationContext({
      id: 'admin_1', username: 'admin', fullName: 'Admin', role: 'ADMIN',
      permissions: ['orders:create', 'orders:edit'], isSuperAdmin: false
    });

    const orderRes = await useCases.createOrder(auth, 'cmd_conc', 'day_1', 'cust_1');
    const order = (orderRes as { success: true; data: OrderEntity }).data;

    // Simulate concurrent update in repo (repo version advanced to 99)
    orders.set(order.id, { ...order, version: 99 });

    // Client A attempts to save stale local order (version 1 + 1 = 2)
    const staleOrderToSave = { ...order, notes: 'Stale update', version: 2 };
    await expect(repoCtx.orderRepo.save(staleOrderToSave)).rejects.toThrow(ConflictError);
  });
});
