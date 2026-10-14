import { beforeEach, describe, expect, it, vi } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  clearAllOperationalData,
  ensureStoreHydrated,
  resetStoreMemory,
  updateOrderWithPhase5Engine,
} from '../components/pages/dayOrdersStore';
import { initializeCanonicalSyncState, setTestAppAuthSession } from './utils/testSetup';

const ids = {
  day: '10000000-0000-4000-8000-000000000011',
  customer: '10000000-0000-4000-8000-000000000012',
  order: '10000000-0000-4000-8000-000000000013',
  item: '10000000-0000-4000-8000-000000000014',
  deviceType: '10000000-0000-4000-8000-000000000015',
};

describe('note-only order edit with an unchanged order status', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await clearAllOperationalData();
    await localDb.clear();
    resetStoreMemory();
    await initializeCanonicalSyncState();
    setTestAppAuthSession();

    const now = new Date().toISOString();
    await localDb.set('businessDays', ids.day, {
      id: ids.day,
      businessDate: '2026-10-13',
      isClosed: false,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    await localDb.set('customers', ids.customer, {
      id: ids.customer,
      name: 'Test customer',
      phone: '0000000000',
      isActive: true,
      chargerFeeExempt: false,
      debtLimitMinor: -100000,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    await localDb.set('orders', ids.order, {
      id: ids.order,
      dayId: ids.day,
      customerId: ids.customer,
      displayNumber: 1,
      internalSequence: 1,
      status: 'pending',
      customerBalanceSnapshotMinor: 0,
      notes: 'Original notes',
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    await localDb.set('orderItems', ids.item, {
      id: ids.item,
      orderId: ids.order,
      deviceTypeId: ids.deviceType,
      itemSequence: 1,
      status: 'charging',
      deviceNameSnapshot: 'Test device',
      deviceIconSnapshot: 'smartphone',
      basePriceSnapshotMinor: 10000,
      chargerFeeEnabledSnapshot: false,
      customerChargerFeeExemptSnapshot: false,
      chargerFeeSnapshotMinor: 0,
      hasCharger: false,
      unitPriceMinor: 10000,
      totalPriceMinor: 10000,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    await ensureStoreHydrated();
  });

  it('allows editing notes without forcing a status transition from pending to charging', async () => {
    const result = await updateOrderWithPhase5Engine(
      ids.order,
      'Updated notes',
      'pending',
      [],
      [],
    );

    expect(result.success, result.error).toBe(true);
    const outbox = await localDb.listOutbox();
    expect(outbox.some((command) => {
      const payload = command.payload as Record<string, unknown> | undefined;
      return payload?.notes === 'Updated notes';
    })).toBe(true);
  });
});
