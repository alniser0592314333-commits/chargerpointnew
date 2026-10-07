import { describe, expect, it } from 'vitest';
import { OutboxScheduler } from '../infrastructure/sync/outboxScheduler';
import type { OutboxRecord } from '../infrastructure/localDb/localDb';

const makeRecord = (
  commandId: string,
  commandType: string,
  createdAt: string,
  payload: Record<string, unknown>,
  status: OutboxRecord['status'] = 'pending',
): OutboxRecord => ({
  commandId,
  commandType,
  aggregateType: commandType === 'ADD_ORDER_ITEM' ? 'order_items' : 'orders',
  aggregateId: String(payload.id ?? commandId),
  payload,
  createdAt,
  deviceId: 'device-1',
  actorAdminId: 'admin-1',
  status,
  retryCount: 0,
});

describe('order mutation causal barriers', () => {
  it('blocks a later ADD_ORDER_ITEM behind an earlier BIN-blocked delivery in the same order', async () => {
    const firstAdd = makeRecord(
      'add-1',
      'ADD_ORDER_ITEM',
      '2026-10-07T08:00:00.000Z',
      { id: 'item-1', orderId: 'order-1' },
      'accepted',
    );
    const firstDelivery = makeRecord(
      'deliver-1',
      'DELIVER_ORDER_ITEM',
      '2026-10-07T08:01:00.000Z',
      { id: 'item-1', itemId: 'item-1', orderId: 'order-1', deferBinVerification: true, bin: '' },
      'blocked',
    );
    const secondAdd = makeRecord(
      'add-2',
      'ADD_ORDER_ITEM',
      '2026-10-07T08:02:00.000Z',
      { id: 'item-2', orderId: 'order-1' },
      'pending',
    );

    const scheduler = new OutboxScheduler();
    const result = await scheduler.schedule(
      [secondAdd],
      [firstAdd, firstDelivery, secondAdd],
    );

    expect(result.ready.map((item) => item.commandId)).not.toContain('add-2');
    expect(result.blocked.get('add-2')?.unsatisfiedDependencies).toContain('deliver-1');
  });

  it('allows an unrelated customer credit to proceed while an order mutation is BIN-blocked', async () => {
    const blockedDelivery = makeRecord(
      'deliver-1',
      'DELIVER_ORDER_ITEM',
      '2026-10-07T08:01:00.000Z',
      { id: 'item-1', itemId: 'item-1', orderId: 'order-1', deferBinVerification: true, bin: '' },
      'blocked',
    );
    const credit = makeRecord(
      'credit-1',
      'CREATE_CUSTOMER_CREDIT',
      '2026-10-07T08:02:00.000Z',
      { id: 'credit-1', customerId: 'customer-1', amountMinor: 1300 },
      'pending',
    );

    const scheduler = new OutboxScheduler();
    const result = await scheduler.schedule(
      [credit],
      [blockedDelivery, credit],
    );

    expect(result.ready.map((item) => item.commandId)).toContain('credit-1');
    expect(result.blocked.has('credit-1')).toBe(false);
  });
});
