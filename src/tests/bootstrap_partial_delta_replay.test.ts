import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearActiveBootstrapStagingSession } from '../infrastructure/sync/bootstrapStagingStore';
import { localDb } from '../infrastructure/localDb/localDb';
import * as supabaseClient from '../services/supabase/client';
import { mockChunkedBootstrapRpc } from './utils/mockChunkedBootstrap';
import { setTestAppAuthSession } from './utils/testSetup';
import { applyRemoteChange, hydrateFromRemoteTables, reloadStoreFromLocal, resetStoreMemory } from '../components/pages/dayOrdersStore';

describe('Canonical partial-delta replay preserves snapshot fields', () => {
  afterEach(async () => { vi.restoreAllMocks(); await clearActiveBootstrapStagingSession(); });

  beforeEach(async () => {
    await clearActiveBootstrapStagingSession();
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

  it('applies canonical system-setting tombstones to both local setting stores', async () => {
    const key = 'public_landing_title';
    const setting = { key, value_type: 'string', value_string: 'Old title' };
    await localDb.set('system_settings', key, setting);
    await localDb.set('systemSettings', key, setting);

    await localDb.runTransaction(['kvStore', 'syncState'], 'readwrite', (tx) => {
      applyRemoteChange({
        sequenceId: 106,
        entityType: 'system_settings',
        entityId: '00000000-0000-4000-8000-000000000401',
        action: 'DELETE',
        payload: setting,
        version: 1,
        changedAt: '2026-11-03T00:00:00.000Z',
      }, tx);
    });

    expect(await localDb.get('system_settings', key)).toBeNull();
    expect(await localDb.get('systemSettings', key)).toBeNull();
  });

  it('preserves day and device configuration when canonical commands emit status-only patches', async () => {
    const dayId = 'day-2026-11-01';
    const deviceId = '00000000-0000-4000-8000-000000000301';
    await localDb.set('businessDays', dayId, {
      id: dayId,
      businessDate: '2026-11-01',
      isClosed: false,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      version: 1,
    });
    await localDb.set('deviceTypes', deviceId, {
      id: deviceId,
      name: 'Galaxy Screen',
      nameAr: 'شاشة جالكسي',
      nameEn: 'Galaxy Screen',
      icon: 'smartphone',
      basePriceMinor: 4200,
      chargerFeeEnabled: true,
      chargerFeeApplicable: true,
      isActive: true,
      sortOrder: 4,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      version: 1,
    });
    resetStoreMemory();
    await reloadStoreFromLocal();

    await localDb.runTransaction(['kvStore', 'syncState'], 'readwrite', (tx) => {
      applyRemoteChange({
        sequenceId: 104,
        entityType: 'business_days',
        entityId: dayId,
        action: 'UPDATE',
        payload: { id: dayId, status: 'CLOSED' },
        version: 2,
        changedAt: '2026-11-02T00:00:00.000Z',
      }, tx);
      applyRemoteChange({
        sequenceId: 105,
        entityType: 'device_types',
        entityId: deviceId,
        action: 'UPDATE',
        payload: { id: deviceId, status: 'RETIRED' },
        version: 2,
        changedAt: '2026-11-02T00:00:00.000Z',
      }, tx);
    });

    expect(await localDb.get<any>('businessDays', dayId)).toMatchObject({
      businessDate: '2026-11-01',
      isClosed: true,
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    expect(await localDb.get<any>('deviceTypes', deviceId)).toMatchObject({
      name: 'Galaxy Screen',
      nameAr: 'شاشة جالكسي',
      icon: 'smartphone',
      basePriceMinor: 4200,
      isActive: false,
      status: 'RETIRED',
    });
  });

  it('merges partial goal and goal-request updates without resetting established values', async () => {
    const goalId = '00000000-0000-4000-8000-000000000201';
    const requestId = '00000000-0000-4000-8000-000000000202';
    setTestAppAuthSession();
    vi.spyOn(supabaseClient, 'getSupabaseStatus').mockReturnValue({
      isConfigured: true,
      url: 'https://example.supabase.co',
      status: 'connected',
    });
    mockChunkedBootstrapRpc({
      goals: [{
        id: goalId,
        customer_id: 'customer-1',
        target_quantity: 10,
        current_progress: 6,
        bonus_amount_minor: 2500,
        duration_days: 30,
        status: 'ACTIVE',
        started_at: '2026-11-01T00:00:00.000Z',
        expires_at: '2026-12-01T00:00:00.000Z',
        created_at: '2026-11-01T00:00:00.000Z',
        updated_at: '2026-11-01T00:00:00.000Z',
        version: 1,
      }],
      goal_requests: [{
        id: requestId,
        customer_id: 'customer-1',
        requested_target: 12,
        status: 'PENDING',
        created_at: '2026-11-01T00:00:00.000Z',
        updated_at: '2026-11-01T00:00:00.000Z',
        version: 1,
      }],
    });
    expect(await hydrateFromRemoteTables()).toBe(true);

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
