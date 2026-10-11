import { describe, expect, test } from 'vitest';
import { groupCustomerFinancialHistoryByOrder, CustomerFinancialHistoryDisplayItem } from '../domain/financialPresentation';

type Charge = CustomerFinancialHistoryDisplayItem & {
  orderId: string;
  orderDisplayNumber: number;
  orderItems: NonNullable<CustomerFinancialHistoryDisplayItem['orderItems']>;
  orderTotalMinor: number;
};

const charge = (overrides: Partial<Charge> = {}): Charge => ({
  id: 'ledger-item-1',
  eventType: 'ORDER_ITEM_CHARGE',
  amountMinor: -100,
  postBalanceMinor: -100,
  createdAt: '2026-10-09T10:00:00.000Z',
  orderId: 'order-1',
  orderDisplayNumber: 27,
  description: 'Device delivered',
  shortTitle: 'Order #27',
  orderItems: [{ id: 'item-1', deviceName: 'Xiaomi', priceMinor: 100, hasCharger: true }],
  orderTotalMinor: 100,
  ...overrides,
});

describe('customer financial history order grouping', () => {
  test('shows all item charges for one order as one aggregate row without changing the total or final balance', () => {
    const history = [
      charge(),
      charge({
        id: 'ledger-item-2',
        amountMinor: -100,
        postBalanceMinor: -200,
        createdAt: '2026-10-09T10:00:01.000Z',
        orderItems: [{ id: 'item-2', deviceName: 'Samsung', priceMinor: 100, hasCharger: false }],
      }),
      charge({
        id: 'ledger-item-3',
        amountMinor: -100,
        postBalanceMinor: -300,
        createdAt: '2026-10-09T10:00:02.000Z',
        orderItems: [{ id: 'item-3', deviceName: 'Nokia', priceMinor: 100, hasCharger: false }],
      }),
    ];

    const result = groupCustomerFinancialHistoryByOrder(history, 'ar');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('order-charge-order-1');
    expect(result[0].amountMinor).toBe(-300);
    expect(result[0].postBalanceMinor).toBe(-300);
    expect(result[0].orderItems?.map(item => item.id)).toEqual(['item-1', 'item-2', 'item-3']);
    expect(result[0].orderTotalMinor).toBe(300);
    expect(result[0].shortTitle).toBe('خصم إجمالي الطلب');
    expect(result[0].description).toBe('خصم إجمالي الطلب رقم #27');
    expect(history).toHaveLength(3);
    expect(history[0].amountMinor).toBe(-100);
  });

  test('keeps payments and charges from different orders separate', () => {
    const history: CustomerFinancialHistoryDisplayItem[] = [
      charge(),
      { ...charge({ id: 'ledger-item-2', orderId: 'order-2', orderDisplayNumber: 28 }) },
      {
        id: 'payment-1',
        eventType: 'PAYMENT',
        amountMinor: 500,
        postBalanceMinor: 300,
        createdAt: '2026-10-09T10:00:03.000Z',
        description: 'Payment',
        shortTitle: 'Balance added',
      },
    ];

    const result = groupCustomerFinancialHistoryByOrder(history, 'en');

    expect(result).toHaveLength(3);
    expect(result.filter(row => row.eventType === 'ORDER_ITEM_CHARGE')).toHaveLength(2);
    expect(result.find(row => row.id === 'order-charge-order-1')?.amountMinor).toBe(-100);
    expect(result.find(row => row.id === 'order-charge-order-2')?.amountMinor).toBe(-100);
    expect(result.find(row => row.id === 'payment-1')?.amountMinor).toBe(500);
    expect(result.find(row => row.id === 'order-charge-order-1')?.description).toBe('Total charge for order #27');
  });

  test('does not merge legacy order charges or unlinked item charges', () => {
    const history: CustomerFinancialHistoryDisplayItem[] = [
      charge(),
      charge({ id: 'legacy-order-charge', eventType: 'ORDER_CHARGE', amountMinor: -300 }),
      charge({ id: 'unlinked-charge', orderId: undefined, amountMinor: -100 }),
    ];

    const result = groupCustomerFinancialHistoryByOrder(history, 'en');

    expect(result).toHaveLength(3);
    expect(result.some(row => row.id === 'legacy-order-charge')).toBe(true);
    expect(result.some(row => row.id === 'unlinked-charge')).toBe(true);
  });
});
