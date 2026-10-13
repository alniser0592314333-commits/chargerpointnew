import { describe, expect, it } from 'vitest';
import { getFullyDeliveredDayIds } from '../components/pages/dayOrdersStore';

const order = (id: string, dayId = 'day-1', status = 'pending', deletedAt?: string) => ({ id, dayId, status, deletedAt });
const item = (orderId: string, status = 'delivered', deletedAt?: string) => ({ orderId, status, deletedAt });

describe('day delivery completion indicator', () => {
  it('marks a day complete only when every active order has active delivered items', () => {
    const result = getFullyDeliveredDayIds(
      [order('o1'), order('o2')],
      [item('o1', 'delivered'), item('o1', 'delivered'), item('o2', 'DELIVERED')]
    );
    expect(result.has('day-1')).toBe(true);
  });

  it('returns the day to incomplete when a new/edited item is charging', () => {
    const result = getFullyDeliveredDayIds(
      [order('o1')],
      [item('o1', 'delivered'), item('o1', 'charging')]
    );
    expect(result.has('day-1')).toBe(false);
  });

  it('ignores cancelled orders and cancelled items but not active orders with no active items', () => {
    const complete = getFullyDeliveredDayIds(
      [order('delivered'), order('cancelled', 'day-1', 'cancelled')],
      [item('delivered', 'delivered'), item('cancelled', 'charging')]
    );
    expect(complete.has('day-1')).toBe(true);

    const noActiveItems = getFullyDeliveredDayIds(
      [order('active')],
      [item('active', 'cancelled')]
    );
    expect(noActiveItems.has('day-1')).toBe(false);
  });

  it('does not mark an empty day green and ignores deleted records', () => {
    expect(getFullyDeliveredDayIds([], []).has('day-1')).toBe(false);
    const result = getFullyDeliveredDayIds(
      [order('deleted-order', 'day-1', 'delivered', '2026-10-13T00:00:00Z')],
      [item('deleted-order', 'delivered')]
    );
    expect(result.has('day-1')).toBe(false);
  });
});
