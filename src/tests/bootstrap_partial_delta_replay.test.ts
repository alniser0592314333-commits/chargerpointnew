import { beforeEach, describe, expect, it } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { applyRemoteChange, reloadStoreFromLocal, resetStoreMemory } from '../components/pages/dayOrdersStore';

describe('Canonical partial-delta replay preserves snapshot fields', () => {
  beforeEach(async () => {
    await localDb.clear();
    resetStoreMemory();
  });

  it('merges partial order-item updates over the previously installed snapshot row', async () => {
    const id = '00000000-0000-4000-8000-000000000101';
    await localDb.set('orderItems', id, {
      id,
      orderId: 'order-1',
      deviceTypeId: 'device-1',
      itemSequence: 3,
      status: 'charging',
      financialStatus: 'UNRECOGNIZED',
      paymentStatus: 'UNPAID',
      deviceNameSnapshot: 'Galaxy',
      deviceIconSnapshot: 'smartphone',
      basePriceSnapshotMinor: 1200,
      chargerFeeEnabledSnapshot: true,
      customerChargerFeeExemptSnapshot: false,
      chargerFeeSnapshotMinor: 50,
      hasCharger: true,
      unitPriceMinor: 1200,
      totalPriceMinor: 1250,
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
      version: 1,
    });
    resetStoreMemory();
    await reloadStoreFromLocal();

    await localDb.runTransaction(['kvStore', 'syncState'], 'readwrite', (tx) => {
      applyRemoteChange({
        sequenceId: 101,
        entityType: 'order_items',
        entityId: id,
        action: 'UPDATE',
        payload: { id, status: 'delivered' },
        version: 2,
        changedAt: '2026-11-02T10:00:00.000Z',
      }, tx);
    });

    expect(await localDb.get<any>('orderItems', id)).toMatchObject({
      id,
      status: 'delivered',
      orderId: 'order-1',
      deviceTypeId: 'device-1',
      deviceNameSnapshot: 'Galaxy',
      deviceIconSnapshot: 'smartphone',
      basePriceSnapshotMinor: 1200,
      chargerFeeSnapshotMinor: 50,
      totalPriceMinor: 1250,
      hasCharger: true,
      version: 2,
    });
  });

  it('merges partial goal and goal-request updates without resetting established values', async () => {
    const goalId = '00000000-0000-4000-8000-000000000201';
    const requestId = '00000000-0000-4000-8000-000000000202';
    await localDb.set('goals', goalId, {
      id: goalId,
      customerId: 'customer-1',
      targetQuantity: 10,
      currentProgress: 6,
      bonusAmountMinor: 2500,
      durationDays: 30,
      status: 'ACTIVE',
      startedAt: '2026-11-01T00:00:00.000Z',
      expiresAt: '2026-12-01T00:00:00.000Z',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      version: 1,
    });
    await localDb.set('goalRequests', requestId, {
      id: requestId,
      customerId: 'customer-1',
      requestedTarget: 12,
      status: 'PENDING',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      version: 1,
    });
    resetStoreMemory();
    await reloadStoreFromLocal();

    await localDb.runTransaction(['kvStore', 'syncState'], 'readwrite', (tx) => {
      applyRemoteChange({
        sequenceId: 102,
        entityType: 'goals',
        entityId: goalId,
        action: 'UPDATE',
        payload: { id: goalId, status: 'COMPLETED' },
        version: 2,
        changedAt: '2026-11-02T00:00:00.000Z',
      }, tx);
      applyRemoteChange({
        sequenceId: 103,
        entityType: 'goal_requests',
        entityId: requestId,
        action: 'UPDATE',
        payload: { id: requestId, status: 'APPROVED', resulting_goal_id: goalId },
        version: 2,
        changedAt: '2026-11-02T00:00:00.000Z',
      }, tx);
    });

    expect(await localDb.get<any>('goals', goalId)).toMatchObject({
      customerId: 'customer-1',
      targetQuantity: 10,
      currentProgress: 6,
      bonusAmountMinor: 2500,
      durationDays: 30,
      status: 'COMPLETED',
    });
    expect(await localDb.get<any>('goalRequests', requestId)).toMatchObject({
      customerId: 'customer-1',
      requestedTarget: 12,
      status: 'APPROVED',
      resultingGoalId: goalId,
    });
  });
});
