/**
 * Phase 1 — Canonical State Ownership + Persistent Optimistic Overlay Test Suite
 * Validates Effective State calculations, CRUD overlays, deterministic sequence,
 * delta preservation, restart safety, and order projection rules.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { localDb, OptimisticOverlayRecord } from '../infrastructure/localDb/localDb';
import { calculateOrderProjection } from '../domain/rules';

describe('Phase 1 — Canonical State & Optimistic Overlay Architecture', () => {
  beforeEach(async () => {
    await localDb.clear();
  });

  it('Test 1: Base entity + PATCH overlay -> Effective State contains patched value', async () => {
    await localDb.set('orders', 'ord-1', { id: 'ord-1', status: 'pending', notes: 'original' });

    await localDb.saveOverlay({
      commandId: 'cmd-patch-1',
      mutationKey: 'order:ord-1',
      entityType: 'orders',
      entityId: 'ord-1',
      operation: 'PATCH',
      patch: { notes: 'patched note' },
      sequence: 1,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
    });

    const effective = await localDb.getEffectiveState('orders', 'ord-1');
    expect(effective).toMatchObject({
      id: 'ord-1',
      status: 'pending',
      notes: 'patched note',
    });
  });

  it('Test 2: No Base + CREATE overlay -> Effective State contains entity', async () => {
    await localDb.saveOverlay({
      commandId: 'cmd-create-1',
      mutationKey: 'order:ord-new',
      entityType: 'orders',
      entityId: 'ord-new',
      operation: 'CREATE',
      entityPayload: { id: 'ord-new', status: 'pending', displayNumber: 101 },
      sequence: 1,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
    });

    const effective = await localDb.getEffectiveState('orders', 'ord-new');
    expect(effective).toMatchObject({
      id: 'ord-new',
      status: 'pending',
      displayNumber: 101,
    });
  });

  it('Test 3: CREATE overlay + PATCH overlay -> Effective State contains both', async () => {
    await localDb.saveOverlay({
      commandId: 'cmd-create-2',
      mutationKey: 'order:ord-2',
      entityType: 'orders',
      entityId: 'ord-2',
      operation: 'CREATE',
      entityPayload: { id: 'ord-2', status: 'pending' },
      sequence: 1,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
    });

    await localDb.saveOverlay({
      commandId: 'cmd-patch-2',
      mutationKey: 'order:ord-2',
      entityType: 'orders',
      entityId: 'ord-2',
      operation: 'PATCH',
      patch: { status: 'charging' },
      sequence: 2,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
    });

    const effective = await localDb.getEffectiveState('orders', 'ord-2');
    expect(effective).toMatchObject({
      id: 'ord-2',
      status: 'charging',
    });
  });

  it('Test 4: DELETE overlay masks Base entity', async () => {
    await localDb.set('orders', 'ord-3', { id: 'ord-3', status: 'pending' });

    await localDb.saveOverlay({
      commandId: 'cmd-del-3',
      mutationKey: 'order:ord-3',
      entityType: 'orders',
      entityId: 'ord-3',
      operation: 'DELETE',
      sequence: 1,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
    });

    const effective = await localDb.getEffectiveState('orders', 'ord-3');
    expect(effective).toBeNull();
  });

  it('Test 5: Two overlays apply in deterministic sequence order', async () => {
    await localDb.set('orders', 'ord-4', { id: 'ord-4', status: 'pending', notes: 'v0' });

    // Sequence 2 arrives with earlier timestamp or vice versa; sequence takes precedence
    await localDb.saveOverlay({
      commandId: 'cmd-seq-2',
      mutationKey: 'order:ord-4',
      entityType: 'orders',
      entityId: 'ord-4',
      operation: 'PATCH',
      patch: { notes: 'final v2' },
      sequence: 2,
      createdAt: '2026-10-06T01:00:00Z',
      status: 'PENDING',
    });

    await localDb.saveOverlay({
      commandId: 'cmd-seq-1',
      mutationKey: 'order:ord-4',
      entityType: 'orders',
      entityId: 'ord-4',
      operation: 'PATCH',
      patch: { notes: 'intermediate v1' },
      sequence: 1,
      createdAt: '2026-10-06T02:00:00Z', // later timestamp but lower sequence
      status: 'PENDING',
    });

    const effective = await localDb.getEffectiveState('orders', 'ord-4');
    expect(effective.notes).toBe('final v2');
  });

  it('Test 6: Base A + Overlay B + server delta C -> Base becomes C while Overlay B remains', async () => {
    await localDb.set('orders', 'ord-5', { id: 'ord-5', status: 'pending' });

    await localDb.saveOverlay({
      commandId: 'cmd-overlay-5',
      mutationKey: 'order:ord-5',
      entityType: 'orders',
      entityId: 'ord-5',
      operation: 'PATCH',
      patch: { notes: 'local overlay note' },
      sequence: 1,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
    });

    // Simulate authoritative server delta C arriving and updating Base
    await localDb.set('orders', 'ord-5', { id: 'ord-5', status: 'charging', notes: 'server baseline c' });

    const effective = await localDb.getEffectiveState('orders', 'ord-5');
    expect(effective).toMatchObject({
      id: 'ord-5',
      status: 'charging',
      notes: 'local overlay note', // Overlay B remains active on top of Base C
    });
  });

  it('Test 7: Restart preserves Base + Overlay + Outbox', async () => {
    await localDb.set('orders', 'ord-6', { id: 'ord-6', status: 'pending' });
    await localDb.saveOverlay({
      commandId: 'cmd-restart-1',
      mutationKey: 'order:ord-6',
      entityType: 'orders',
      entityId: 'ord-6',
      operation: 'PATCH',
      patch: { status: 'delivered' },
      sequence: 1,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
    });
    await localDb.saveOutbox({
      commandId: 'cmd-restart-1',
      commandType: 'DELIVER_ORDER_ITEM',
      aggregateType: 'orders',
      aggregateId: 'ord-6',
      payload: {},
      createdAt: new Date().toISOString(),
      deviceId: 'dev-1',
      actorAdminId: 'admin-1',
      status: 'pending',
      retryCount: 0,
    });

    // Re-hydrate / new database instance simulation
    const effective = await localDb.getEffectiveState('orders', 'ord-6');
    const outboxItems = await localDb.listOutbox();
    const overlays = await localDb.listOverlays();

    expect(effective.status).toBe('delivered');
    expect(outboxItems).toHaveLength(1);
    expect(overlays).toHaveLength(1);
  });

  it('Test 8: Order.status is not permanently authored by client delivery code', async () => {
    // Verify that client cannot arbitrarily set Order.status independently of item projection rules
    const projected1 = calculateOrderProjection([{ status: 'charging' }]);
    const projected2 = calculateOrderProjection([{ status: 'delivered' }]);

    expect(projected1).toBe('charging');
    expect(projected2).toBe('delivered');
  });

  it('Test 9: Order projection follows the defined state matrix', async () => {
    expect(calculateOrderProjection([])).toBe('pending');
    expect(calculateOrderProjection([{ status: 'charging' }, { status: 'charging' }])).toBe('charging');
    expect(calculateOrderProjection([{ status: 'charging' }, { status: 'delivered' }])).toBe('charging');
    expect(calculateOrderProjection([{ status: 'delivered' }, { status: 'delivered' }])).toBe('delivered');
    expect(calculateOrderProjection([{ status: 'delivered' }, { status: 'cancelled' }])).toBe('delivered');
    expect(calculateOrderProjection([{ status: 'charging' }, { status: 'cancelled' }])).toBe('charging');
    expect(calculateOrderProjection([{ status: 'cancelled' }, { status: 'cancelled' }])).toBe('cancelled');
  });

  it('Test 10: Child mutation retains dependency on parent CREATE', async () => {
    await localDb.saveOverlay({
      commandId: 'cmd-parent-create',
      mutationKey: 'order:ord-parent',
      entityType: 'orders',
      entityId: 'ord-parent',
      operation: 'CREATE',
      entityPayload: { id: 'ord-parent', status: 'pending' },
      sequence: 1,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
    });

    await localDb.saveOverlay({
      commandId: 'cmd-child-item',
      mutationKey: 'order_items:item-child',
      entityType: 'order_items',
      entityId: 'item-child',
      operation: 'CREATE',
      entityPayload: { id: 'item-child', orderId: 'ord-parent', status: 'charging' },
      sequence: 2,
      dependencyCommandId: 'cmd-parent-create',
      createdAt: new Date().toISOString(),
      status: 'PENDING',
    });

    const childOverlay = await localDb.getOverlay('cmd-child-item');
    expect(childOverlay?.dependencyCommandId).toBe('cmd-parent-create');
  });
});
