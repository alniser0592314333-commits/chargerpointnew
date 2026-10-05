import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  computeCustomerOrderPaymentStatuses,
  getOrdersForDay,
  getCustomerOrders,
  topUpCustomerBalance,
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

  it('2. Order for customer with positive real balance is PAID (مدفوع)', async () => {
    const custId = 'cust-5';
    const dayId = 'day-2026-10-02';

    // Top up 10000 minor (100 NIS)
    await topUpCustomerBalance({
      customerId: custId,
      amountMinor: 10000,
      bin: '1234',
    });

    const ordRes = await createOrderWithPhase5Engine(
      dayId,
      custId,
      [{ deviceTypeId: 'dev-1', hasCharger: false }]
    );
    expect(ordRes.success).toBe(true);
    const orderId = ordRes.order!.id;

    const statuses = computeCustomerOrderPaymentStatuses(custId);
    expect(statuses.get(orderId)?.paymentStatus).toBe('PAID');

    const custOrders = await getCustomerOrders(custId);
    expect(custOrders.find((o) => o.id === orderId)?.paymentStatus).toBe('PAID');
  });

  it('3. Order for customer with insufficient balance is PARTIAL (مدفوع جزئي)', async () => {
    const custId = 'cust-5';
    const dayId = 'day-2026-10-02';

    // Top up 1000 minor (10 NIS), dev-1 price is 4550 minor
    await topUpCustomerBalance({
      customerId: custId,
      amountMinor: 1000,
      bin: '1234',
    });

    const ordRes = await createOrderWithPhase5Engine(
      dayId,
      custId,
      [{ deviceTypeId: 'dev-1', hasCharger: false }]
    );
    expect(ordRes.success).toBe(true);
    const orderId = ordRes.order!.id;

    const statuses = computeCustomerOrderPaymentStatuses(custId);
    expect(statuses.get(orderId)?.paymentStatus).toBe('PARTIAL');
    expect(statuses.get(orderId)?.allocatedAmountMinor).toBe(1000);

    const custOrders = await getCustomerOrders(custId);
    expect(custOrders.find((o) => o.id === orderId)?.paymentStatus).toBe('PARTIAL');
  });

  it('4. FIFO Multi-order sequence: 3 orders, paying incrementally', async () => {
    const custId = 'cust-5';
    const dayId = 'day-2026-10-02';

    // Order 1 (Oldest)
    const ord1Res = await createOrderWithPhase5Engine(dayId, custId, [{ deviceTypeId: 'dev-2', hasCharger: false }]);
    const order1Id = ord1Res.order!.id;
    const order1Total = ord1Res.order!.items.reduce((s, i) => s + i.priceMinor, 0);

    // Order 2 (Second)
    const ord2Res = await createOrderWithPhase5Engine(dayId, custId, [{ deviceTypeId: 'dev-2', hasCharger: false }]);
    const order2Id = ord2Res.order!.id;
    const order2Total = ord2Res.order!.items.reduce((s, i) => s + i.priceMinor, 0);

    // Order 3 (Third)
    const ord3Res = await createOrderWithPhase5Engine(dayId, custId, [{ deviceTypeId: 'dev-2', hasCharger: false }]);
    const order3Id = ord3Res.order!.id;
    const order3Total = ord3Res.order!.items.reduce((s, i) => s + i.priceMinor, 0);

    // Step A: Initially with 0 payment, all 3 orders must be UNPAID
    let alloc = computeCustomerOrderPaymentStatuses(custId);
    expect(alloc.get(order1Id)?.paymentStatus).toBe('UNPAID');
    expect(alloc.get(order2Id)?.paymentStatus).toBe('UNPAID');
    expect(alloc.get(order3Id)?.paymentStatus).toBe('UNPAID');

    // Step B: Customer pays Order1 total + half of Order2 total
    const partialAmount = order1Total + Math.floor(order2Total / 2);
    await topUpCustomerBalance({ customerId: custId, amountMinor: partialAmount, bin: '1234' });

    alloc = computeCustomerOrderPaymentStatuses(custId);
    // Order 1 (oldest) gets full amount -> PAID
    expect(alloc.get(order1Id)?.paymentStatus).toBe('PAID');
    expect(alloc.get(order1Id)?.allocatedAmountMinor).toBe(order1Total);

    // Order 2 (second) gets partial amount -> PARTIAL
    expect(alloc.get(order2Id)?.paymentStatus).toBe('PARTIAL');
    expect(alloc.get(order2Id)?.allocatedAmountMinor).toBe(Math.floor(order2Total / 2));

    // Order 3 (third) gets 0 -> UNPAID
    expect(alloc.get(order3Id)?.paymentStatus).toBe('UNPAID');
    expect(alloc.get(order3Id)?.allocatedAmountMinor).toBe(0);

    // Step C: Customer pays remaining of Order2 + partial of Order3
    const remainingToPay = (order2Total - Math.floor(order2Total / 2)) + Math.floor(order3Total / 2);
    await topUpCustomerBalance({ customerId: custId, amountMinor: remainingToPay, bin: '1234' });

    alloc = computeCustomerOrderPaymentStatuses(custId);
    // Order 1 is PAID
    expect(alloc.get(order1Id)?.paymentStatus).toBe('PAID');

    // Order 2 is PAID
    expect(alloc.get(order2Id)?.paymentStatus).toBe('PAID');

    // Order 3 is PARTIAL
    expect(alloc.get(order3Id)?.paymentStatus).toBe('PARTIAL');
    expect(alloc.get(order3Id)?.allocatedAmountMinor).toBe(Math.floor(order3Total / 2));
  });
});
