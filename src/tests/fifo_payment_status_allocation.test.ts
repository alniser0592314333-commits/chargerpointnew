import { describe, it, expect, beforeEach } from 'vitest';
import { setTestAppAuthSession } from './utils/testSetup';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  computeCustomerOrderPaymentStatuses,
  getOrdersForDay,
  getCustomerOrders,
  getCustomerFinancialHistory,
  topUpCustomerBalance,
  deliverSingleOrderItem,
  phase5UseCases,
  getAuthorizedAdminContext,
  createOrderWithPhase5Engine,
  resetStoreMemory,
  seedDemoOperationalData,
  setRuntimeBinVerifier,
  ensureStoreHydrated,
} from '../components/pages/dayOrdersStore';

describe('FIFO Order Payment Status Allocation Engine', () => {
  beforeEach(async () => {
    await localDb.clear();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    setTestAppAuthSession();
    resetStoreMemory();
    await seedDemoOperationalData();
    await ensureStoreHydrated();
    setRuntimeBinVerifier((bin) => bin === '1234');
  });

  it('1. Order for customer with 0 or negative balance is UNPAID (غير مدفوع), not PAID', async () => {
    const custId = 'cust-5'; // Fresh customer with 0 orders and 0 balance
    const dayId = 'day-2026-10-02';

    // Create order
    const ordRes = await createOrderWithPhase5Engine(
      dayId,
      custId,
      [{ deviceTypeId: 'dev-1', hasCharger: false }],
      'طلب كاش / دين'
    );
    expect(ordRes.success).toBe(true);
    const orderId = ordRes.order!.id;

    // Verify order payment status is UNPAID because balance was 0 and became negative
    const statuses = computeCustomerOrderPaymentStatuses(custId);
    expect(statuses.get(orderId)?.paymentStatus).toBe('UNPAID');

    const dayOrders = await getOrdersForDay(dayId);
    const dayOrder = dayOrders.find((o) => o.id === orderId);
    expect(dayOrder?.paymentStatus).toBe('UNPAID');

    const custOrders = await getCustomerOrders(custId);
    const custOrder = custOrders.find((o) => o.id === orderId);
    expect(custOrder?.paymentStatus).toBe('UNPAID');
  });

  it('2. A delivered order is PAID only after an actual payment, not from wallet credit alone', async () => {
    const custId = 'cust-5';
    const dayId = 'day-2026-10-02';

    await topUpCustomerBalance({ customerId: custId, amountMinor: 10000, bin: '1234' });

    const ordRes = await createOrderWithPhase5Engine(
      dayId,
      custId,
      [{ deviceTypeId: 'dev-1', hasCharger: false }]
    );
    expect(ordRes.success).toBe(true);
    const order = ordRes.order!;
    const delivery = await deliverSingleOrderItem(order.items[0].id, '1234');
    expect(delivery.success).toBe(true);

    const auth = getAuthorizedAdminContext('1234');
    const payment = await phase5UseCases.recordPayment(
      auth, crypto.randomUUID(), custId, 10000, 'CASH', 'FIFO TEST'
    );
    expect(payment.success).toBe(true);

    const statuses = computeCustomerOrderPaymentStatuses(custId);
    expect(statuses.get(order.id)?.paymentStatus).toBe('PAID');
  });

  it('3. A delivered order with insufficient actual payment is PARTIAL', async () => {
    const custId = 'cust-5';
    const dayId = 'day-2026-10-02';

    await topUpCustomerBalance({ customerId: custId, amountMinor: 10000, bin: '1234' });

    const ordRes = await createOrderWithPhase5Engine(
      dayId,
      custId,
      [{ deviceTypeId: 'dev-1', hasCharger: false }]
    );
    expect(ordRes.success).toBe(true);
    const order = ordRes.order!;
    const delivery = await deliverSingleOrderItem(order.items[0].id, '1234');
    expect(delivery.success).toBe(true);

    const auth = getAuthorizedAdminContext('1234');
    const payment = await phase5UseCases.recordPayment(
      auth, crypto.randomUUID(), custId, 1000, 'CASH', 'FIFO TEST PARTIAL'
    );
    expect(payment.success).toBe(true);

    const statuses = computeCustomerOrderPaymentStatuses(custId);
    expect(statuses.get(order.id)?.paymentStatus).toBe('PARTIAL');
    expect(statuses.get(order.id)?.allocatedAmountMinor).toBe(1000);
  });

  it('4. FIFO multi-order sequence uses actual payments and only recognized items', async () => {
    const custId = 'cust-5';
    const dayId = 'day-2026-10-02';

    await topUpCustomerBalance({ customerId: custId, amountMinor: 20000, bin: '1234' });

    const orders: Array<{ id: string; itemId: string; total: number; order: any; deliveredItem: any }> = [];
    for (let n = 0; n < 3; n++) {
      const res = await createOrderWithPhase5Engine(
        dayId,
        custId,
        [{ deviceTypeId: 'dev-2', hasCharger: false }]
      );
      expect(res.success).toBe(true);
      const order = res.order!;
      const item = order.items[0];
      const delivery = await deliverSingleOrderItem(item.id, '1234');
      expect(delivery.success).toBe(true);
      orders.push({
        id: order.id,
        itemId: item.id,
        total: item.priceMinor,
        order,
        deliveredItem: delivery.item ?? item,
      });
    }

    const auth = getAuthorizedAdminContext('1234');

    const firstAmount = orders[0].total + Math.floor(orders[1].total / 2);
    const p1 = await phase5UseCases.recordPayment(
      auth, crypto.randomUUID(), custId, firstAmount, 'CASH', 'FIFO TEST 1'
    );
    expect(p1.success).toBe(true);

    let statuses = computeCustomerOrderPaymentStatuses(custId);
    expect(statuses.get(orders[0].id)?.paymentStatus).toBe('PAID');
    expect(statuses.get(orders[0].id)?.allocatedAmountMinor).toBe(orders[0].total);
    expect(statuses.get(orders[1].id)?.paymentStatus).toBe('PARTIAL');
    expect(statuses.get(orders[1].id)?.allocatedAmountMinor).toBe(Math.floor(orders[1].total / 2));
    expect(statuses.get(orders[2].id)?.paymentStatus).toBe('UNPAID');

    const secondAmount =
      (orders[1].total - Math.floor(orders[1].total / 2)) +
      Math.floor(orders[2].total / 2);
    const p2 = await phase5UseCases.recordPayment(
      auth, crypto.randomUUID(), custId, secondAmount, 'CASH', 'FIFO TEST 2'
    );
    expect(p2.success).toBe(true);

    statuses = computeCustomerOrderPaymentStatuses(custId);
    expect(statuses.get(orders[0].id)?.paymentStatus).toBe('PAID');
    expect(statuses.get(orders[1].id)?.paymentStatus).toBe('PAID');
    expect(statuses.get(orders[2].id)?.paymentStatus).toBe('PARTIAL');
    expect(statuses.get(orders[2].id)?.allocatedAmountMinor).toBe(Math.floor(orders[2].total / 2));
  });


  it('5. Customer top-up records CREATE_PAYMENT and keeps idempotency after memory reset', async () => {
    const custId = 'cust-5';
    const idempotencyKey = crypto.randomUUID();
    const result = await topUpCustomerBalance({
      customerId: custId,
      amountMinor: 1000,
      bin: '1234',
      idempotencyKey,
    });

    expect(result.success).toBe(true);
    const command = await (phase5UseCases as any).deps.commandRepo.get(idempotencyKey);
    expect(command?.type).toBe('CREATE_PAYMENT');

    resetStoreMemory();
    await ensureStoreHydrated();

    const retry = await topUpCustomerBalance({
      customerId: custId,
      amountMinor: 1000,
      bin: '1234',
      idempotencyKey,
    });
    expect(retry.success).toBe(true);

    const mismatchedRetry = await topUpCustomerBalance({
      customerId: custId,
      amountMinor: 2000,
      bin: '1234',
      idempotencyKey,
    });
    expect(mismatchedRetry.success).toBe(false);
    expect(mismatchedRetry.error).toContain('IDEMPOTENCY_CONFLICT');

    const matchingCommands = (await localDb.listOutbox()).filter((entry) => entry.commandId === idempotencyKey);
    expect(matchingCommands).toHaveLength(1);
  });

  it('shows a delivered item charge in customer history before the server ledger arrives', async () => {
    const orderResult = await createOrderWithPhase5Engine(
      'day-2026-10-02',
      'cust-5',
      [{ deviceTypeId: 'dev-1', hasCharger: false }]
    );
    expect(orderResult.success).toBe(true);
    const order = orderResult.order!;
    const delivery = await deliverSingleOrderItem(order.items[0].id, '1234');
    expect(delivery.success).toBe(true);

    const history = await getCustomerFinancialHistory('cust-5', 'ar');
    const pendingCharge = history.find(
      (entry) => entry.eventType === 'ORDER_ITEM_CHARGE' && entry.orderItemId === order.items[0].id
    );
    expect(pendingCharge).toBeTruthy();
    expect(pendingCharge?.amountMinor).toBeLessThan(0);
  });

  it('6. Equal millisecond timestamps use overlay sequence to preserve FIFO causality', async () => {
    const customerId = 'cust-5';
    const orderId = 'order-sequence-regression';
    const itemId = 'item-sequence-regression';
    const sameTimestamp = '2026-10-14T00:00:00.000Z';
    const order = {
      id: orderId,
      customerId,
      status: 'pending',
      internalSequence: 1,
    } as any;
    const item = {
      id: itemId,
      orderId,
      status: 'delivered',
      financialStatus: 'RECOGNIZED',
      totalPriceMinor: 4500,
      finalChargeSnapshotMinor: 4500,
      createdAt: sameTimestamp,
      itemSequence: 1,
    } as any;

    await localDb.saveOverlay({
      commandId: 'payment-before-item',
      mutationKey: `customer:${customerId}`,
      entityType: 'payments',
      entityId: 'payment-before-item',
      operation: 'CREATE',
      entityPayload: { id: 'payment-before-item', customerId, amountMinor: 10000 },
      sequence: 1,
      createdAt: sameTimestamp,
      status: 'PENDING',
    } as any);
    await localDb.saveOverlay({
      commandId: 'item-create-sequence',
      mutationKey: `order:${orderId}`,
      entityType: 'order_items',
      entityId: itemId,
      operation: 'CREATE',
      entityPayload: item,
      sequence: 2,
      createdAt: sameTimestamp,
      status: 'PENDING',
    } as any);

    let statuses = computeCustomerOrderPaymentStatuses(
      customerId,
      new Map([[orderId, order]]),
      new Map([[itemId, item]])
    );
    expect(statuses.get(orderId)?.paymentStatus).toBe('UNPAID');
    expect(statuses.get(orderId)?.allocatedAmountMinor).toBe(0);

    await localDb.saveOverlay({
      commandId: 'payment-after-item',
      mutationKey: `customer:${customerId}`,
      entityType: 'payments',
      entityId: 'payment-after-item',
      operation: 'CREATE',
      entityPayload: { id: 'payment-after-item', customerId, amountMinor: 1000 },
      sequence: 3,
      createdAt: sameTimestamp,
      status: 'PENDING',
    } as any);

    statuses = computeCustomerOrderPaymentStatuses(
      customerId,
      new Map([[orderId, order]]),
      new Map([[itemId, item]])
    );
    expect(statuses.get(orderId)?.paymentStatus).toBe('PARTIAL');
    expect(statuses.get(orderId)?.allocatedAmountMinor).toBe(1000);
  });

  it('6. A pending payment cannot retroactively pay an order created after the payment', async () => {
    const custId = 'cust-5';
    const dayId = 'day-2026-10-02';

    const payment = await topUpCustomerBalance({
      customerId: custId,
      amountMinor: 10000,
      bin: '1234',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(payment.success).toBe(true);

    const ordRes = await createOrderWithPhase5Engine(
      dayId,
      custId,
      [{ deviceTypeId: 'dev-1', hasCharger: false }]
    );
    expect(ordRes.success).toBe(true);
    const order = ordRes.order!;
    const delivery = await deliverSingleOrderItem(order.items[0].id, '1234');
    expect(delivery.success).toBe(true);

    const statuses = computeCustomerOrderPaymentStatuses(custId);

    expect(statuses.get(order.id)?.paymentStatus).toBe('UNPAID');
    expect(statuses.get(order.id)?.allocatedAmountMinor).toBe(0);
  });

});
