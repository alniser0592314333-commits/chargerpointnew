import { describe, expect, it } from 'vitest';
import { normalizeCustomerSearchText } from '../utils/customerSearch';
import { projectOrderSearchResult } from '../utils/orderSearchProjection';

describe('legacy-safe customer and order search projection', () => {
  it('normalizes missing or malformed customer search values without throwing', () => {
    expect(normalizeCustomerSearchText(undefined)).toBe('');
    expect(normalizeCustomerSearchText(null)).toBe('');
    expect(normalizeCustomerSearchText({ name: 'not a string' })).toBe('');
    expect(normalizeCustomerSearchText('أحمد ١٢')).toBe('احمد 12');
  });

  it('projects an existing legacy order even when its date and customer display fields are incomplete', () => {
    const result = projectOrderSearchResult(
      {
        id: 'order-legacy-01',
        displayNumber: '27',
        dayId: 'day-2026-11-27',
        customerId: 'customer-legacy-01',
        createdAt: null,
        status: 'pending',
      },
      { id: 'customer-legacy-01', name: null, phone: 12345 },
      { businessDate: null },
      [
        { orderId: 'order-legacy-01', status: 'pending', totalPriceMinor: '1500' },
        { orderId: 'order-legacy-01', status: 'cancelled', totalPriceMinor: 900 },
        { orderId: 'order-legacy-01', status: 'pending', totalPriceMinor: 'not-a-number' },
      ],
      '',
    );

    expect(result).toEqual({
      orderId: 'order-legacy-01',
      orderNumber: 27,
      dayId: 'day-2026-11-27',
      businessDate: '2026-11-27',
      customerId: 'customer-legacy-01',
      customerName: 'عميل غير معروف',
      customerCode: '----',
      createdAt: '',
      status: 'pending',
      totalMinor: 1500,
    });
  });

  it('uses a valid creation date when the day row is missing and rejects invalid calendar dates', () => {
    const result = projectOrderSearchResult(
      {
        id: 'order-legacy-02',
        displayNumber: 8,
        dayId: 'day-unknown',
        customerId: 'customer-02',
        createdAt: '2026-10-03T10:30:00Z',
      },
      { name: 'عميل' },
      null,
      [],
      'AB12',
    );
    expect(result?.businessDate).toBe('2026-10-03');

    const invalid = projectOrderSearchResult(
      {
        id: 'order-legacy-03',
        displayNumber: 9,
        dayId: 'day-2026-02-31',
        customerId: 'customer-03',
      },
      null,
      { businessDate: '2026-02-31' },
      [],
      'CD34',
    );
    expect(invalid?.businessDate).toBe('');
  });

  it('skips records that cannot be navigated to instead of emitting broken result cards', () => {
    expect(projectOrderSearchResult(
      { id: 'order-01', displayNumber: 1, dayId: '', customerId: 'customer-01' },
      null,
      null,
      [],
      'AB12',
    )).toBeNull();
    expect(projectOrderSearchResult(
      { id: 'order-02', displayNumber: 'not-a-number', dayId: 'day-2026-11-28', customerId: 'customer-02' },
      null,
      null,
      [],
      'AB12',
    )).toBeNull();
  });
});
