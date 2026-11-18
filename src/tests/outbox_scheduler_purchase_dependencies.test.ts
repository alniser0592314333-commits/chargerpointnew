import { beforeEach, describe, expect, it } from 'vitest';
import { localDb, OutboxRecord } from '../infrastructure/localDb/localDb';
import { OutboxScheduler, extractCommandDependencies } from '../infrastructure/sync/outboxScheduler';

const makeCommand = (
  commandId: string,
  commandType: string,
  payload: Record<string, unknown>,
  createdAt = '2026-11-18T10:00:00.000Z',
): OutboxRecord => ({
  commandId,
  commandType,
  payload,
  status: 'pending',
  createdAt,
  updatedAt: createdAt,
  deviceId: 'device-test',
  actorAdminId: 'admin-test',
  aggregateType: commandType.startsWith('SAVE_PURCHASE_') ? 'purchase' : 'purchase_orders',
  aggregateId: String(payload.id || commandId),
  retryCount: 0,
  resetGeneration: 1,
} as unknown as OutboxRecord);

describe('purchase outbox dependency ordering', () => {
  beforeEach(async () => {
    await localDb.clear();
  });

  it('makes a purchase order wait for its pending day and newly-created catalog references', () => {
    const day = makeCommand('day-1', 'SAVE_PURCHASE_DAY', { id: 'day-1' }, '2026-11-18T10:00:00.000Z');
    const supplier = makeCommand('supplier-1', 'SAVE_PURCHASE_SUPPLIER', { id: 'supplier-1' }, '2026-11-18T10:00:01.000Z');
    const item = makeCommand('item-1', 'SAVE_PURCHASE_ITEM', { id: 'item-1' }, '2026-11-18T10:00:02.000Z');
    const method = makeCommand('method-1', 'SAVE_PURCHASE_PAYMENT_METHOD', { id: 'method-1' }, '2026-11-18T10:00:03.000Z');
    const order = makeCommand('purchase-1', 'SAVE_PURCHASE_ORDER', {
      id: 'purchase-1',
      purchaseDayId: 'day-1',
      supplierId: 'supplier-1',
      itemId: 'item-1',
      paymentMethodId: 'method-1',
    }, '2026-11-18T10:00:04.000Z');

    const dependencies = extractCommandDependencies(order, [day, supplier, item, method, order]);
    expect(dependencies).toEqual(expect.arrayContaining(['day-1', 'supplier-1', 'item-1', 'method-1']));
  });

  it('orders purchase month, week and day creation as a dependency chain', () => {
    const month = makeCommand('month-1', 'SAVE_PURCHASE_MONTH', { id: 'month-1' }, '2026-11-18T10:00:00.000Z');
    const week = makeCommand('week-1', 'SAVE_PURCHASE_WEEK', { id: 'week-1', monthId: 'month-1' }, '2026-11-18T10:00:01.000Z');
    const day = makeCommand('day-1', 'SAVE_PURCHASE_DAY', { id: 'day-1', weekId: 'week-1' }, '2026-11-18T10:00:02.000Z');
    const all = [day, week, month];

    expect(extractCommandDependencies(week, all)).toContain('month-1');
    expect(extractCommandDependencies(day, all)).toContain('week-1');
  });

  it('does not send a purchase order if its referenced day is missing locally and has no creator command', async () => {
    const order = makeCommand('purchase-2', 'SAVE_PURCHASE_ORDER', {
      id: 'purchase-2',
      purchaseDayId: 'missing-day',
    });
    const result = await new OutboxScheduler().schedule([order], [order], async () => null);
    expect(result.ready.map((item) => item.commandId)).not.toContain(order.commandId);
    expect(result.blocked.has(order.commandId)).toBe(true);
  });

  it('allows an order to use an existing local purchase day with no pending creator command', async () => {
    await localDb.set('purchaseDays', 'existing-day', { id: 'existing-day', isClosed: false });
    const order = makeCommand('purchase-3', 'SAVE_PURCHASE_ORDER', {
      id: 'purchase-3',
      purchaseDayId: 'existing-day',
    });
    const result = await new OutboxScheduler().schedule([order], [order], async () => null);
    expect(result.ready.map((item) => item.commandId)).toContain(order.commandId);
    expect(result.blocked.has(order.commandId)).toBe(false);
  });
});
