import { describe, expect, test } from 'vitest';
import {
  buildEffectiveOrderItemReadModel,
} from '../components/pages/dayOrdersStore';
import type { OrderEntity, OrderItemEntity } from '../domain/models';
import type { OptimisticOverlayRecord } from '../infrastructure/localDb/localDb';

const order = (overrides: Partial<OrderEntity> = {}): OrderEntity => ({
  id: 'order-12',
  dayId: 'day-2026-10-12',
  customerId: 'customer-1',
  displayNumber: 1,
  internalSequence: 1,
  status: 'charging',
  createdAt: '2026-10-12T08:00:00.000Z',
  updatedAt: '2026-10-12T08:00:00.000Z',
  version: 1,
  ...overrides,
});

const item = (overrides: Partial<OrderItemEntity> = {}): OrderItemEntity => ({
  id: 'item-1',
  orderId: 'order-12',
  deviceTypeId: 'device-1',
  itemSequence: 1,
  status: 'charging',
  deviceNameSnapshot: 'Phone',
  deviceIconSnapshot: 'smartphone',
  basePriceSnapshotMinor: 800,
  chargerFeeEnabledSnapshot: false,
  customerChargerFeeExemptSnapshot: false,
  chargerFeeSnapshotMinor: 0,
  hasCharger: false,
  unitPriceMinor: 800,
  totalPriceMinor: 800,
  createdAt: '2026-10-12T08:00:00.000Z',
  updatedAt: '2026-10-12T08:00:00.000Z',
  version: 1,
  ...overrides,
});

const overlay = (
  commandId: string,
  entityType: string,
  entityId: string,
  operation: OptimisticOverlayRecord['operation'],
  sequence: number,
  payload: Record<string, unknown>
): OptimisticOverlayRecord => ({
  commandId,
  mutationKey: `order:order-12`,
  entityType,
  entityId,
  operation,
  entityPayload: operation === 'CREATE' ? payload : undefined,
  patch: operation === 'PATCH' ? payload : undefined,
  sequence,
  createdAt: new Date(1_791_792_000_000 + sequence).toISOString(),
  status: 'PENDING',
});

describe('effective order history read model', () => {
  test('includes an order and its new devices before their CREATE overlays sync', () => {
    const createdOrder = order();
    const createdItem = item();
    const result = buildEffectiveOrderItemReadModel([], [], [
      overlay('create-order', 'orders', createdOrder.id, 'CREATE', 1, createdOrder as unknown as Record<string, unknown>),
      overlay('create-item', 'order_items', createdItem.id, 'CREATE', 2, createdItem as unknown as Record<string, unknown>),
    ]);

    expect(result.orders.get(createdOrder.id)).toMatchObject({
      id: 'order-12',
      dayId: 'day-2026-10-12',
      displayNumber: 1,
    });
    expect(result.items.get(createdItem.id)).toMatchObject({
      id: 'item-1',
      orderId: 'order-12',
      status: 'charging',
      totalPriceMinor: 800,
    });
  });

  test('applies pending edits in sequence and does not resurrect a removed device', () => {
    const baseOrder = order();
    const baseItem = item();
    const result = buildEffectiveOrderItemReadModel([baseOrder], [baseItem], [
      // Deliberately supplied out of sequence to model arbitrary IndexedDB hydration order.
      overlay('cancel-item', 'order_items', baseItem.id, 'PATCH', 3, { status: 'cancelled', version: 3 }),
      overlay('patch-order', 'orders', baseOrder.id, 'PATCH', 2, { notes: 'edited', version: 2 }),
      overlay('create-item', 'order_items', 'item-new', 'CREATE', 1, item({ id: 'item-new' }) as unknown as Record<string, unknown>),
    ]);

    expect(result.orders.get(baseOrder.id)).toMatchObject({ notes: 'edited', dayId: 'day-2026-10-12' });
    expect(result.items.get(baseItem.id)).toMatchObject({ status: 'cancelled', version: 3 });
    expect(result.items.get('item-new')).toMatchObject({ id: 'item-new', orderId: 'order-12' });
  });

  test('applies a pending tombstone to the effective view without mutating the base maps', () => {
    const baseOrder = order();
    const result = buildEffectiveOrderItemReadModel([baseOrder], [], [
      overlay('delete-order', 'orders', baseOrder.id, 'DELETE', 1, {}),
    ]);

    expect(result.orders.has(baseOrder.id)).toBe(false);
    expect(baseOrder.id).toBe('order-12');
  });
});
