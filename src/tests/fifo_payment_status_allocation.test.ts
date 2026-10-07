import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  computeCustomerOrderPaymentStatuses,
  getOrdersForDay,
  getCustomerOrders,
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

    const effectiveItems = new Map(order.items.map((item) => [item.id, item]));
    if (delivery.item) effectiveItems.set(delivery.item.id, delivery.item);

    const statuses = computeCustomerOrderPaymentStatuses(
      custId,
      new Map([[order.id, order]]),
      effectiveItems
    );
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

    const effectiveItems = new Map(order.items.map((item) => [item.id, item]));
    if (delivery.item) effectiveItems.set(delivery.item.id, delivery.item);

    const statuses = computeCustomerOrderPaymentStatuses(
      custId,
      new Map([[order.id, order]]),
      effectiveItems
    );
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

    const effectiveOrders = new Map(orders.map((entry) => [entry.id, entry.order]));
    const effectiveItems = new Map<string, any>();
    for (const entry of orders) {
      effectiveItems.set(entry.itemId, entry.deliveredItem);
    }

    const auth = getAuthorizedAdminContext('1234');

    const firstAmount = orders[0].total + Math.floor(orders[1].total / 2);
    const p1 = await phase5UseCases.recordPayment(
      auth, crypto.randomUUID(), custId, firstAmount, 'CASH', 'FIFO TEST 1'
    );
    expect(p1.success).toBe(true);

    let statuses = computeCustomerOrderPaymentStatuses(
      custId, effectiveOrders, effectiveItems
    );
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

    statuses = computeCustomerOrderPaymentStatuses(
      custId, effectiveOrders, effectiveItems
    );
    expect(statuses.get(orders[0].id)?.paymentStatus).toBe('PAID');
    expect(statuses.get(orders[1].id)?.paymentStatus).toBe('PAID');
    expect(statuses.get(orders[2].id)?.paymentStatus).toBe('PARTIAL');
    expect(statuses.get(orders[2].id)?.allocatedAmountMinor).toBe(Math.floor(orders[2].total / 2));
  });

});
