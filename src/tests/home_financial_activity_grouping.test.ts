import { describe, expect, test } from 'vitest';
import { groupHomeFinancialActivitiesByOrder, HomeFinancialActivityDisplayItem } from '../domain/financialPresentation';

const charge = (overrides: Partial<HomeFinancialActivityDisplayItem> = {}): HomeFinancialActivityDisplayItem => ({
  id: 'charge-1',
  eventType: 'ORDER_ITEM_CHARGE',
  customerName: 'أحمد',
  customerId: 'customer-1',
  amountMinor: -100,
  displayTitle: 'خصم طلب #27',
  description: 'خصم من رصيد أحمد',
  createdAt: '2026-10-09T10:00:00.000Z',
  orderId: 'order-27',
  orderNumber: 27,
  ...overrides,
});

describe('home recent financial activity grouping', () => {
  test('aggregates all item charges for an order into one display row', () => {
    const rows = [
      charge(),
      charge({ id: 'charge-2', amountMinor: -100, createdAt: '2026-10-09T10:00:01.000Z' }),
      charge({ id: 'charge-3', amountMinor: -100, createdAt: '2026-10-09T10:00:02.000Z' }),
    ];
    const grouped = groupHomeFinancialActivitiesByOrder(rows, 'ar');
    expect(grouped).toHaveLength(1);
    expect(grouped[0].amountMinor).toBe(-300);
    expect(grouped[0].displayTitle).toBe('خصم إجمالي الطلب #27');
    expect(grouped[0].description).toContain('أحمد');
    expect(grouped[0].createdAt).toBe('2026-10-09T10:00:02.000Z');
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.amountMinor === -100)).toBe(true);
  });

  test('keeps different orders and non-charge financial events separate', () => {
    const rows = [
      charge(),
      charge({ id: 'charge-other-order', orderId: 'order-28', orderNumber: 28 }),
      charge({ id: 'charge-other-customer', customerId: 'customer-2', customerName: 'سعيد' }),
      charge({ id: 'payment', eventType: 'PAYMENT', amountMinor: 200, orderId: undefined, orderNumber: undefined }),
    ];
    const grouped = groupHomeFinancialActivitiesByOrder(rows, 'en');
    expect(grouped).toHaveLength(4);
    expect(grouped.filter(row => row.eventType === 'ORDER_ITEM_CHARGE')).toHaveLength(3);
    expect(grouped.find(row => row.id === 'payment')?.amountMinor).toBe(200);
    expect(grouped.find(row => row.orderId === 'order-27' && row.customerId === 'customer-1')?.amountMinor).toBe(-100);
  });

  test('does not group legacy or unlinked charges', () => {
    const rows = [
      charge(),
      charge({ id: 'legacy', eventType: 'ORDER_CHARGE' }),
      charge({ id: 'unlinked', orderId: undefined }),
    ];
    expect(groupHomeFinancialActivitiesByOrder(rows, 'ar')).toHaveLength(3);
  });
});
