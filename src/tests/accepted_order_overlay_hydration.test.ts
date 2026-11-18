import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildEffectiveOrderItemReadModel } from '../components/pages/dayOrdersStore';
import { localDb, OptimisticOverlayRecord } from '../infrastructure/localDb/localDb';

describe('accepted offline order overlays', () => {
  beforeEach(async () => {
    await localDb.clear();
  });

  it('keeps a successfully pushed order and its items visible until authoritative deltas arrive', async () => {
    const now = new Date().toISOString();
    const order = {
      id: 'order-offline-1',
      dayId: 'day-1',
      displayNumber: 6,
      internalSequence: 6,
      version: 1,
    };
    const item = {
      id: 'item-offline-1',
      orderId: 'order-offline-1',
      deviceTypeId: 'device-1',
      quantity: 2,
      version: 1,
    };
    const orderOverlay: OptimisticOverlayRecord = {
      commandId: order.id,
      mutationKey: 'day:day-1',
      entityType: 'orders',
      entityId: order.id,
      operation: 'CREATE',
      entityPayload: order,
      sequence: 10,
      createdAt: now,
      status: 'PENDING',
    };
    const itemOverlay: OptimisticOverlayRecord = {
      commandId: item.id,
      mutationKey: 'order:order-offline-1',
      entityType: 'order_items',
      entityId: item.id,
      operation: 'CREATE',
      entityPayload: item,
      sequence: 11,
      createdAt: now,
      status: 'PENDING',
    };

    await localDb.saveOverlay(orderOverlay);
    await localDb.saveOverlay(itemOverlay);
    localDb.markOverlaysForCommandAcceptedWithTx(null, order.id);
    localDb.markOverlaysForCommandAcceptedWithTx(null, item.id);

    const effective = buildEffectiveOrderItemReadModel([], [], localDb.listOverlaysSync());
    expect(effective.orders.get(order.id)).toMatchObject({ displayNumber: 6 });
    expect(effective.items.get(item.id)).toMatchObject({ orderId: order.id, quantity: 2 });
    expect(localDb.listOverlaysSync().every((overlay) => overlay.status === 'ACCEPTED')).toBe(true);

    // The server delta hydrates the base entity before the accepted overlay is removed.
    await localDb.set('orders', order.id, { ...order, version: 1 });
    localDb.removeAcceptedOverlaysForEntityWithTx(null, 'orders', order.id, 1);
    const hydrated = buildEffectiveOrderItemReadModel(
      [(await localDb.get('orders', order.id)) as any],
      [],
      localDb.listOverlaysSync(),
    );
    expect(hydrated.orders.get(order.id)).toMatchObject({ displayNumber: 6 });
    expect(localDb.listOverlaysSync()).toHaveLength(1);
  });

  it('does not remove a newer accepted overlay when an older version delta arrives', async () => {
    const now = new Date().toISOString();
    const older: OptimisticOverlayRecord = {
      commandId: 'order-update-v2',
      mutationKey: 'day:day-1',
      entityType: 'orders',
      entityId: 'order-1',
      operation: 'PATCH',
      patch: { displayNumber: 7, version: 2 },
      sequence: 20,
      createdAt: now,
      status: 'PENDING',
    };
    const newer: OptimisticOverlayRecord = {
      commandId: 'order-update-v3',
      mutationKey: 'day:day-1',
      entityType: 'orders',
      entityId: 'order-1',
      operation: 'PATCH',
      patch: { displayNumber: 8, version: 3 },
      sequence: 21,
      createdAt: now,
      status: 'PENDING',
    };
    await localDb.saveOverlay(older);
    await localDb.saveOverlay(newer);
    localDb.markOverlaysForCommandAcceptedWithTx(null, older.commandId);
    localDb.markOverlaysForCommandAcceptedWithTx(null, newer.commandId);

    localDb.removeAcceptedOverlaysForEntityWithTx(null, 'orders', 'order-1', 2);
    const remaining = localDb.listOverlaysSync();
    expect(remaining.map((overlay) => overlay.commandId)).toEqual([newer.commandId]);
    const effective = buildEffectiveOrderItemReadModel(
      [{ id: 'order-1', displayNumber: 6, version: 1 } as any],
      [],
      remaining,
    );
    expect(effective.orders.get('order-1')?.displayNumber).toBe(8);
  });
  it('keeps accepted create overlays until the sync engine applies their matching server deltas', () => {
    const syncEnginePath = path.resolve(process.cwd(), 'src/infrastructure/sync/syncEngine.ts');
    const source = fs.readFileSync(syncEnginePath, 'utf8');
    expect(source).toContain('markOverlaysForCommandAcceptedWithTx');
    expect(source).toContain('removeAcceptedOverlaysForEntityWithTx');
    expect(source).toContain("item.commandType === 'CREATE_ORDER' || item.commandType === 'ADD_ORDER_ITEM'");
  });

});
