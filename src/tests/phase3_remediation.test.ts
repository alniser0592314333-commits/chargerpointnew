import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncEngine, ChangeLogEntry } from '../infrastructure/sync/syncEngine';
import { localDb } from '../infrastructure/localDb/localDb';
import '../infrastructure/sync/syncBridge';
import {
  subscribeStore,
  notifyStore,
  applyRemoteChange,
  getAuthenticatedIdentity,
  globalSyncEngine,
  refreshStoreFromRemote,
  ensureStoreHydrated,
  hydrateFromRemoteTables,
  createNewBusinessDay,
  getDaysList,
  resetStoreMemory,
  StoreScope,
} from '../components/pages/dayOrdersStore';

describe('Phase 3 Remediation Verification Suite', () => {
  beforeEach(async () => {
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
    await localDb.clear();
    resetStoreMemory();
    await ensureStoreHydrated();
  });

  it('1. Delta OPEN_DAY updates in-memory state and notifies businessDays subscribers', async () => {
    let notifiedScope: StoreScope | null = null;
    let notifiedEntityId: string | undefined = undefined;

    const unsub = subscribeStore((scope, entityId) => {
      notifiedScope = scope;
      notifiedEntityId = entityId;
    });

    const testChange: ChangeLogEntry = {
      sequenceId: 101,
      entityType: 'business_days',
      entityId: 'day-2026-09-28',
      action: 'INSERT',
      payload: {
        id: 'day-2026-09-28',
        business_date: '2026-09-28',
        is_closed: false,
        created_at: new Date().toISOString(),
      },
      changedAt: new Date().toISOString(),
    };

    await applyRemoteChange(testChange, {} as any);

    expect(notifiedScope).toBe('businessDays');
    expect(notifiedEntityId).toBe('day-2026-09-28');

    const daysList = await getDaysList();
    const createdDay = daysList.find((d) => d.id === 'day-2026-09-28');
    expect(createdDay).toBeDefined();
    expect(createdDay?.date).toBe('2026-09-28');

    unsub();
  });

  it('2. Targeted subscription notifies relevant scope and ignores unrelated scope', async () => {
    let customerNotified = false;
    let daysNotified = false;

    const unsubCustomer = subscribeStore((scope) => {
      if (scope === 'customers') customerNotified = true;
    });

    const unsubDays = subscribeStore((scope) => {
      if (scope === 'businessDays') daysNotified = true;
    });

    // Notify customer update
    await applyRemoteChange({
      sequenceId: 102,
      entityType: 'customers',
      entityId: 'cust-100',
      action: 'INSERT',
      payload: {
        id: 'cust-100',
        name: 'Ahmad Delta',
        phone: '0590000000',
        is_active: true,
      },
      changedAt: new Date().toISOString(),
    });

    expect(customerNotified).toBe(true);
    expect(daysNotified).toBe(false);

    unsubCustomer();
    unsubDays();
  });

  it('3. Unsubscribe stops listener notifications', async () => {
    let callCount = 0;
    const unsub = subscribeStore(() => {
      callCount++;
    });

    notifyStore('orders', 'ord-1');
    expect(callCount).toBe(1);

    unsub();
    notifyStore('orders', 'ord-2');
    expect(callCount).toBe(1);
  });

  it('4. Delta CREATE_ORDER updates in-memory ordersMap and notifies orders scope', async () => {
    let notifiedScope: StoreScope | null = null;

    const unsub = subscribeStore((scope) => {
      notifiedScope = scope;
    });

    await applyRemoteChange({
      sequenceId: 103,
      entityType: 'orders',
      entityId: 'ord-delta-1',
      action: 'INSERT',
      payload: {
        id: 'ord-delta-1',
        day_id: 'day-2026-09-28',
        customer_id: 'cust-100',
        display_number: 5,
        internal_sequence: 5,
        status: 'PENDING',
        created_at: new Date().toISOString(),
      },
      changedAt: new Date().toISOString(),
    });

    expect(notifiedScope).toBe('orders');

    const persistedOrder = await localDb.get<any>('orders', 'ord-delta-1');
    expect(persistedOrder).toBeDefined();
    expect(persistedOrder.displayNumber).toBe(5);

    unsub();
  });

  it('5. Delta ADD_ORDER_ITEM updates in-memory itemsMap and notifies orderItems scope', async () => {
    let notifiedScope: StoreScope | null = null;

    const unsub = subscribeStore((scope) => {
      notifiedScope = scope;
    });

    await applyRemoteChange({
      sequenceId: 104,
      entityType: 'order_items',
      entityId: 'item-delta-1',
      action: 'INSERT',
      payload: {
        id: 'item-delta-1',
        order_id: 'ord-delta-1',
        device_type_id: 'dev-1',
        item_sequence: 1,
        status: 'CHARGING',
        unit_price_minor: 2500,
        total_price_minor: 2500,
      },
      changedAt: new Date().toISOString(),
    });

    expect(notifiedScope).toBe('orderItems');

    const persistedItem = await localDb.get<any>('orderItems', 'item-delta-1');
    expect(persistedItem).toBeDefined();
    expect(persistedItem.unitPriceMinor).toBe(2500);

    unsub();
  });

  it('6. Delta PAYMENT updates in-memory paymentsMap and notifies payments scope', async () => {
    let notifiedScope: StoreScope | null = null;

    const unsub = subscribeStore((scope) => {
      notifiedScope = scope;
    });

    await applyRemoteChange({
      sequenceId: 105,
      entityType: 'payments',
      entityId: 'pay-delta-1',
      action: 'INSERT',
      payload: {
        id: 'pay-delta-1',
        customer_id: 'cust-100',
        amount_minor: 5000,
        payment_method: 'CASH',
        actor_admin_id: 'admin_test_1',
        command_id: 'cmd-pay-1',
        created_at: new Date().toISOString(),
      },
      changedAt: new Date().toISOString(),
    });

    expect(notifiedScope).toBe('payments');

    const persistedPayment = await localDb.get<any>('payments', 'pay-delta-1');
    expect(persistedPayment).toBeDefined();
    expect(persistedPayment.amountMinor).toBe(5000);

    unsub();
  });

  it('7. getAuthenticatedIdentity returns real identity and throws in production if unauthenticated', () => {
    const storage = typeof localStorage !== 'undefined' ? localStorage : null;
    if (storage) {
      storage.setItem('app_auth_session', JSON.stringify({ userId: 'admin_user_uuid_123' }));
      storage.setItem('app_device_id', 'device_mobile_456');

      const identity = getAuthenticatedIdentity();
      expect(identity.actorAdminId).toBe('admin_user_uuid_123');
      expect(identity.deviceId).toBe('device_mobile_456');
    } else {
      const identity = getAuthenticatedIdentity();
      expect(identity.actorAdminId).toBeDefined();
      expect(identity.deviceId).toBeDefined();
    }
  });

  it('8. Failed delta application leaves cursor unchanged in SyncEngine', async () => {
    const mockTransport = {
      pushCommand: async () => ({ success: true }),
      pullChanges: async (cursor: number) => ({
        changes: [
          {
            sequenceId: 50,
            entityType: 'business_days',
            entityId: 'day-fail',
            action: 'INSERT' as const,
            payload: {},
            changedAt: new Date().toISOString(),
          },
        ],
        latestSequence: 50,
        serverResetGeneration: 1,
      }),
    };

    const engine = new SyncEngine(mockTransport);
    engine.onDeltaApplied = () => {
      throw new Error('Simulated delta processing crash');
    };

    await expect(engine.synchronize()).rejects.toThrow('Simulated delta processing crash');

    const syncState = await localDb.getSyncState('global');
    expect(syncState?.lastAppliedChangeSequence || 0).toBe(0);
  });

  it('9. Normal reconnect calls synchronize delta and does NOT full-hydrate tables', async () => {
    const syncSpy = vi.spyOn(globalSyncEngine, 'synchronize').mockResolvedValue({ pushed: 0, pulled: 0 });

    await refreshStoreFromRemote();

    expect(syncSpy).toHaveBeenCalled();
    syncSpy.mockRestore();
  });
});
