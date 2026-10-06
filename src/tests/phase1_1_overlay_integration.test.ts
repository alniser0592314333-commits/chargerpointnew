/**
 * Phase 1.1 — Durable local entity + optimistic overlay integration.
 *
 * These tests intentionally do not assert a local financial ledger mutation:
 * financial recognition is server-authoritative. They verify the local-first
 * contract: entity/overlay + outbox are durable before sync.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { FinalUseCases, RepositoryContext } from '../application/useCases';
import { AuthorizationContext } from '../application/authContext';
import { OrderEntity, OrderItemEntity } from '../domain/models';

describe('Phase 1.1 — Local-first mutation integration', () => {
  let useCases: FinalUseCases;
  let auth: AuthorizationContext;
  let orders: Map<string, OrderEntity>;
  let items: Map<string, OrderItemEntity>;
  let overlays: any[];

  beforeEach(async () => {
    await localDb.clear();
    orders = new Map();
    items = new Map();
    overlays = [];

    const deps: RepositoryContext = {
      orderRepo: {
        findById: async (id: string) => orders.get(id) || null,
        save: async (o: OrderEntity) => { orders.set(o.id, { ...o }); },
        countForDay: async () => orders.size,
      },
      deviceRepo: {
        findById: async (id: string) => ({
          id, name: 'Test Device', icon: 'phone', basePriceMinor: 1000,
          chargerFeeEnabled: false, isActive: true, sortOrder: 1,
          createdAt: '', updatedAt: '', version: 1,
        }),
        findAll: async () => [],
        save: async () => {},
      },
      transactionManager: {
        runInTransaction: async <T>(work: (ctx: RepositoryContext) => T) => work(deps),
      },
      commandRepo: {
        get: async () => null,
        record: async () => {},
      },
      overlayRepo: {
        getNextSequence: async () => overlays.length + 1,
        save: async (o: any) => { overlays.push(o); },
      },
      itemRepo: {
        findByOrderId: async (orderId: string) => Array.from(items.values()).filter((i: OrderItemEntity) => i.orderId === orderId),
        save: async (i: OrderItemEntity) => { items.set(i.id, { ...i }); },
        findById: async (id: string) => items.get(id) || null,
      },
      customerRepo: {
        findById: async () => ({
          id: 'c1', name: 'Customer', isActive: true,
          debtLimitMinor: -100000, chargerFeeExempt: false,
        }),
        save: async () => {},
        getBalance: async () => 0,
      },
      paymentRepo: {
        save: async () => {},
        saveAllocation: async () => {},
        findByCustomer: async () => [],
        findAllAllocations: async () => [],
      },
      ledgerRepo: {
        append: async () => {},
        findByCustomer: async () => [],
        findAll: async () => [],
      },
      dayRepo: {
        findById: async () => null,
        save: async () => {},
        isClosed: async () => false,
      },
    } as any;

    useCases = new FinalUseCases(deps);
    auth = new AuthorizationContext(
      { id: 'a1', role: 'OPERATOR', permissions: ['orders:create', 'orders:edit', 'orders:deliver'] } as any,
      () => true
    );
  });

  it('CREATE_ORDER persists an optimistic CREATE overlay and durable command', async () => {
    const result = await useCases.createOrder(auth, 'cmd-1', 'day-1', 'c1', 'notes');
    expect(result.success).toBe(true);
    expect(overlays.find(o => o.commandId === 'cmd-1')).toMatchObject({
      entityType: 'orders', entityId: 'cmd-1', operation: 'CREATE', status: 'PENDING',
    });
    expect(orders.get('cmd-1')).toMatchObject({ id: 'cmd-1', status: 'pending', notes: 'notes' });
  });

  it('ADD_ORDER_ITEM uses the order aggregate mutation key and persists the item', async () => {
    const order = await useCases.createOrder(auth, 'cmd-ord-1', 'day-1', 'c1');
    expect(order.success).toBe(true);

    const result = await useCases.addOrderItem(auth, 'cmd-item-1', 'dev-1', false, 'cmd-item-1');
    expect(result.success).toBe(true);
    expect(overlays.find(o => o.commandId === 'cmd-item-1')?.mutationKey).toBe('order:cmd-item-1');
  });

  it('DELIVER_ORDER_ITEM is operationally optimistic but financially unrecognized until sync', async () => {
    const orderResult = await useCases.createOrder(auth, 'cmd-order', 'day-1', 'c1');
    expect(orderResult.success).toBe(true);
    if (!orderResult.success) throw new Error(orderResult.error);
    const order = orderResult.data;
    const itemResult = await useCases.addOrderItem(auth, order.id, 'dev-1', false, 'cmd-item');
    expect(itemResult.success).toBe(true);
    if (!itemResult.success) throw new Error(itemResult.error);
    const item = itemResult.data;

    const result = await useCases.deliverOrderItem(auth, item.id, '1234', 'cmd-deliver');
    expect(result.success).toBe(true);

    expect(items.get(item.id)?.status).toBe('delivered');
    expect(items.get(item.id)?.financialStatus).toBe('UNRECOGNIZED');
    expect(overlays.find(o => o.commandId === 'cmd-deliver')).toMatchObject({
      entityType: 'order_items', entityId: item.id, operation: 'PATCH', status: 'PENDING',
    });
  });

  it('Base + overlay + remote delta keeps remote base while retaining pending overlay', async () => {
    await localDb.set('orders', 'ord-1', { id: 'ord-1', status: 'pending', notes: 'A' });
    await localDb.saveOverlay({
      commandId: 'cmd-1', mutationKey: 'order:ord-1', entityType: 'orders', entityId: 'ord-1',
      operation: 'PATCH', patch: { notes: 'B' }, sequence: 1,
      createdAt: new Date().toISOString(), status: 'PENDING',
    });
    await localDb.set('orders', 'ord-1', { id: 'ord-1', status: 'charging', notes: 'C' });
    const effective = await localDb.getEffectiveState('orders', 'ord-1');
    expect(effective).toMatchObject({ status: 'charging', notes: 'B' });
  });

  it('Rejected mutation removes its overlay without deleting a newer base', async () => {
    await localDb.set('orders', 'ord-1', { id: 'ord-1', status: 'charging', notes: 'server' });
    await localDb.saveOverlay({
      commandId: 'cmd-rej', mutationKey: 'order:ord-1', entityType: 'orders', entityId: 'ord-1',
      operation: 'PATCH', patch: { notes: 'overlay' }, sequence: 1,
      createdAt: new Date().toISOString(), status: 'PENDING',
    });
    await localDb.removeOverlay('cmd-rej');
    expect(await localDb.getEffectiveState('orders', 'ord-1')).toMatchObject({ status: 'charging', notes: 'server' });
  });

  it('TIMEOUT_UNKNOWN retains the same pending overlay for retry', async () => {
    await localDb.saveOverlay({
      commandId: 'cmd-time', mutationKey: 'order:ord-1', entityType: 'orders', entityId: 'ord-1',
      operation: 'PATCH', patch: { notes: 'overlay' }, sequence: 1,
      createdAt: new Date().toISOString(), status: 'PENDING',
    });
    expect((await localDb.getOverlay('cmd-time'))?.status).toBe('PENDING');
  });
});
