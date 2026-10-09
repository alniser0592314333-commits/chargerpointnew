import { describe, expect, it } from 'vitest';
import { OrderEntity } from '../domain/models';
import { analyzeOrderNumbering } from '../components/pages/dayOrdersStore';

const order = (id: string, dayId: string, displayNumber: number): OrderEntity => ({
  id,
  dayId,
  customerId: 'customer-1',
  displayNumber,
  internalSequence: displayNumber,
  status: 'pending',
  createdAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-09T10:00:00.000Z',
  version: 1,
});

describe('read-only daily order number diagnostics', () => {
  it('reports duplicate and missing numbers without changing any order number', () => {
    const rows = [
      order('order-a', 'day-2026-10-09', 1),
      order('order-b', 'day-2026-10-09', 1),
      order('order-c', 'day-2026-10-09', 0),
      order('order-d', 'day-2026-10-09', 4),
      order('order-e', 'day-2026-10-08', 1),
    ];
    const before = rows.map((row) => row.displayNumber);

    const diagnostics = analyzeOrderNumbering(rows);

    expect(diagnostics.filter((entry) => entry.issue === 'DUPLICATE').map((entry) => entry.orderId).sort())
      .toEqual(['order-a', 'order-b']);
    expect(diagnostics.filter((entry) => entry.issue === 'MISSING_OR_INVALID').map((entry) => entry.orderId))
      .toEqual(['order-c']);
    expect(rows.map((row) => row.displayNumber)).toEqual(before);
  });

  it('does not treat the same number on different business days as a conflict', () => {
    const rows = [
      order('order-a', 'day-2026-10-08', 1),
      order('order-b', 'day-2026-10-09', 1),
    ];

    expect(analyzeOrderNumbering(rows)).toEqual([]);
  });
});
