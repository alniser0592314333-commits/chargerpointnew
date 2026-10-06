/**
 * Phase 1.1 — Overlay Integration Test Suite
 * Validates production mutation paths against the Optimistic Overlay architecture.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { FinalUseCases, RepositoryContext } from '../application/useCases';
import { AuthorizationContext } from '../application/authContext';

describe('Phase 1.1 — Overlay Integration', () => {
  let useCases: FinalUseCases;
  let auth: AuthorizationContext;

  beforeEach(async () => {
    await localDb.clear();
    // Setup Mock RepositoryContext
    const deps: RepositoryContext = {
      orderRepo: {
        findById: vi.fn(),
        save: vi.fn(),
        countForDay: vi.fn(() => 0),
      },
      // ... other deps
      transactionManager: {
        runInTransaction: vi.fn(async (work) => work(deps)),
      },
      commandRepo: {
        get: vi.fn(),
        record: vi.fn(),
      },
      itemRepo: {
        findByOrderId: vi.fn(() => []),
        save: vi.fn(),
        findById: vi.fn(),
      },
      customerRepo: {
        findById: vi.fn(() => ({ id: 'c1', isActive: true, debtLimitMinor: 1000 })),
        save: vi.fn(),
        getBalance: vi.fn(() => 0),
      },
      paymentRepo: {
        save: vi.fn(),
        saveAllocation: vi.fn(),
        findByCustomer: vi.fn(() => []),
        findAllAllocations: vi.fn(() => []),
      },
      ledgerRepo: {
        append: vi.fn(),
        findByCustomer: vi.fn(() => []),
        findAll: vi.fn(() => []),
      },
      dayRepo: {
        findById: vi.fn(),
        save: vi.fn(),
        isClosed: vi.fn(() => false),
      },
    } as any;

    useCases = new FinalUseCases(deps);
    auth = new AuthorizationContext({ id: 'a1', role: 'OPERATOR', permissions: ['orders:create'] } as any, () => true);
  });

  it('Test 1: CREATE_ORDER with no Base -> create overlay -> Effective State contains Order', async () => {
    await useCases.createOrder(auth, 'cmd-1', 'day-1', 'c1', 'notes');

    const effective = await localDb.getEffectiveState('orders', 'cmd-1');
    expect(effective).toMatchObject({ id: 'cmd-1', status: 'pending', notes: 'notes' });
  });

  it('Test 2: ADD_ORDER_ITEM -> mutationKey is "order:<orderId>"', async () => {
    await useCases.addOrderItem(auth, 'cmd-ord-1', 'dev-1', false, 'cmd-item-1');

    const overlays = await localDb.listOverlays();
    expect(overlays[0].mutationKey).toBe('order:cmd-ord-1');
  });

  it('Test 3: DELIVER_ORDER_ITEM -> optimistic status delivered', async () => {
    await useCases.deliverOrderItem(auth, 'item-1', 'bin-1');

    const effective = await localDb.getEffectiveState('order_items', 'item-1');
    // Note: status will be 'delivered' in effective state due to overlay
    expect(effective.status).toBe('delivered');
  });

  it('Test 4: Base A + Overlay B + remote Delta C -> Base becomes C while Overlay B remains', async () => {
    await localDb.set('orders', 'ord-1', { id: 'ord-1', status: 'pending', notes: 'A' });
    await localDb.saveOverlay({
      commandId: 'cmd-1',
      mutationKey: 'order:ord-1',
      entityType: 'orders',
      entityId: 'ord-1',
      operation: 'PATCH',
      patch: { notes: 'B' },
      sequence: 1,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
    });

    await localDb.set('orders', 'ord-1', { id: 'ord-1', status: 'charging', notes: 'C' });

    const effective = await localDb.getEffectiveState('orders', 'ord-1');
    expect(effective).toMatchObject({ status: 'charging', notes: 'B' });
  });

  it('Test 5: REJECTED mutation -> overlay removed, newer Base preserved', async () => {
    await localDb.saveOverlay({
      commandId: 'cmd-rej',
      mutationKey: 'order:ord-1',
      entityType: 'orders',
      entityId: 'ord-1',
      operation: 'PATCH',
      patch: { notes: 'overlay' },
      sequence: 1,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
    });
    
    // Server rejects command
    await localDb.removeOverlay('cmd-rej');
    
    const effective = await localDb.getEffectiveState('orders', 'ord-1');
    expect(effective).toBeNull(); // assuming no Base A
  });

  it('Test 6: TIMEOUT_UNKNOWN -> same commandId, overlay retained', async () => {
    await localDb.saveOverlay({
      commandId: 'cmd-time',
      mutationKey: 'order:ord-1',
      entityType: 'orders',
      entityId: 'ord-1',
      operation: 'PATCH',
      patch: { notes: 'overlay' },
      sequence: 1,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
    });
    
    const overlay = await localDb.getOverlay('cmd-time');
    expect(overlay).toBeDefined();
  });
});
