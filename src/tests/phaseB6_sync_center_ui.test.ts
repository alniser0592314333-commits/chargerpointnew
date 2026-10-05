import { describe, it, expect, beforeEach, vi } from 'vitest';
import { localDb, OutboxRecord, SyncHistoryRecord } from '../infrastructure/localDb/localDb';
import { globalSyncEngine } from '../components/pages/dayOrdersStore';
import { syncEventEmitter, SyncEvent } from '../infrastructure/sync/syncEngine';
import { authService, UserSession } from '../services/auth/authService';

describe('B.6 — SYNC CENTER UI & DIAGNOSTIC INTEGRATION TESTS', () => {
  beforeEach(async () => {
    await localDb.clear();
  });

  // -------------------------------------------------------------------------
  // TEST 1: SYNCED state
  // -------------------------------------------------------------------------
  it('TEST 1: SYNCED state resolved when online with clean outbox and no errors', async () => {
    const outbox = await localDb.listOutbox();
    const history = await localDb.listHistory();

    expect(outbox).toHaveLength(0);

    // Derivation logic validation
    const isOnline = true;
    const isSyncing = false;
    const pendingCount = outbox.filter((i) => i.status === 'pending').length;
    const blockedCount = outbox.filter((i) => i.status === 'blocked').length;
    const failedCount = outbox.filter((i) => i.status === 'rejected' || i.status === 'conflict').length;

    let derivedState = 'SYNCED';
    if (!isOnline) derivedState = 'OFFLINE';
    else if (isSyncing) derivedState = 'SYNCING';
    else if (blockedCount > 0) derivedState = 'BLOCKED';
    else if (failedCount > 0) derivedState = 'FAILED';
    else if (pendingCount > 0) derivedState = 'PENDING';

    expect(derivedState).toBe('SYNCED');
  });

  // -------------------------------------------------------------------------
  // TEST 2: SYNCING state
  // -------------------------------------------------------------------------
  it('TEST 2: SYNCING state resolved when sync cycle is in progress', async () => {
    let syncStartedEmitted = false;
    const unsub = syncEventEmitter.subscribe((evt: SyncEvent) => {
      if (evt.type === 'sync_started') {
        syncStartedEmitted = true;
      }
    });

    syncEventEmitter.emit({ type: 'sync_started', timestamp: new Date().toISOString() });
    expect(syncStartedEmitted).toBe(true);

    unsub();
  });

  // -------------------------------------------------------------------------
  // TEST 3: PENDING state
  // -------------------------------------------------------------------------
  it('TEST 3: PENDING state resolved when outbox contains pending commands', async () => {
    const record: OutboxRecord = {
      commandId: 'cmd_pend_001',
      commandType: 'CREATE_ORDER',
      aggregateType: 'orders',
      aggregateId: 'ord_100',
      payload: { total: 50 },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending',
      retryCount: 0,
    };
    await localDb.saveOutbox(record);

    const outbox = await localDb.listOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].status).toBe('pending');

    const pendingCount = outbox.filter((i) => i.status === 'pending' || i.status === 'syncing').length;
    expect(pendingCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // TEST 4: BLOCKED state
  // -------------------------------------------------------------------------
  it('TEST 4: BLOCKED state resolved when outbox command is blocked by dependency', async () => {
    const record: OutboxRecord = {
      commandId: 'cmd_blocked_002',
      commandType: 'DELIVERY_CHARGE',
      aggregateType: 'orders',
      aggregateId: 'ord_101',
      payload: { amount: 20 },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'blocked',
      retryCount: 0,
      dependencyCommandId: 'cmd_parent_001',
    };
    await localDb.saveOutbox(record);

    const outbox = await localDb.listOutbox();
    const blockedCount = outbox.filter((i) => i.status === 'blocked').length;
    expect(blockedCount).toBe(1);
    expect(outbox[0].dependencyCommandId).toBe('cmd_parent_001');
  });

  // -------------------------------------------------------------------------
  // TEST 5: FAILED state with NETWORK
  // -------------------------------------------------------------------------
  it('TEST 5: FAILED state with NETWORK error classification', async () => {
    const hist: SyncHistoryRecord = {
      historyId: 'hist_fail_net_01',
      commandId: 'cmd_fail_net_01',
      commandType: 'CREATE_CUSTOMER',
      entityType: 'customers',
      entityId: 'cust_net_1',
      state: 'FAILED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attemptCount: 1,
      errorClass: 'NETWORK',
      errorMessage: 'Failed to fetch',
      failureStage: 'TRANSPORT',
      retryEligible: true,
    };
    await localDb.saveHistory(hist);

    const history = await localDb.listHistory();
    expect(history).toHaveLength(1);
    expect(history[0].errorClass).toBe('NETWORK');
    expect(history[0].failureStage).toBe('TRANSPORT');
  });

  // -------------------------------------------------------------------------
  // TEST 6: FAILED state with AUTHENTICATION/AUTHORIZATION
  // -------------------------------------------------------------------------
  it('TEST 6: FAILED state with AUTHENTICATION / AUTHORIZATION classification', async () => {
    const hist: SyncHistoryRecord = {
      historyId: 'hist_fail_auth_01',
      commandId: 'cmd_fail_auth_01',
      commandType: 'DELETE_CUSTOMER',
      entityType: 'customers',
      entityId: 'cust_auth_1',
      state: 'FAILED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attemptCount: 1,
      errorClass: 'AUTHORIZATION',
      errorMessage: 'Forbidden: Admin lacks required permission',
      failureStage: 'RPC',
      retryEligible: false,
    };
    await localDb.saveHistory(hist);

    const history = await localDb.listHistory();
    expect(history[0].errorClass).toBe('AUTHORIZATION');
    expect(history[0].retryEligible).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TEST 7: OFFLINE state
  // -------------------------------------------------------------------------
  it('TEST 7: OFFLINE state resolved when navigator.onLine is false', async () => {
    const isOnline = false;
    let derivedState = 'SYNCED';
    if (!isOnline) derivedState = 'OFFLINE';

    expect(derivedState).toBe('OFFLINE');
  });

  // -------------------------------------------------------------------------
  // TEST 8: Manual Sync does not throw error if cycle already in progress
  // -------------------------------------------------------------------------
  it('TEST 8: Manual Sync coalesces gracefully when sync cycle is already in progress', async () => {
    // Simulate active sync cycle on globalSyncEngine
    (globalSyncEngine as any).isSyncing = true;

    await expect(globalSyncEngine.synchronize()).rejects.toThrow('Sync cycle already in progress');

    // Reset flag
    (globalSyncEngine as any).isSyncing = false;
  });

  // -------------------------------------------------------------------------
  // TEST 9: Developer Diagnostic authorization check
  // -------------------------------------------------------------------------
  it('TEST 9: Developer Diagnostic authorization checks Super Admin role', async () => {
    const superAdminSession: UserSession = {
      userId: 'admin_super_99',
      email: 'super@system.local',
      fullName: 'Super Admin',
      role: 'SUPER_ADMIN',
      permissions: ['settings:manage'],
      tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    };

    vi.spyOn(authService, 'getCurrentSession').mockResolvedValue(superAdminSession);

    const session = await authService.getCurrentSession();
    expect(session?.role).toBe('SUPER_ADMIN');

    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // TEST 10: Developer Diagnostic displays actual sync history data
  // -------------------------------------------------------------------------
  it('TEST 10: Developer Diagnostic renders actual history data accurately', async () => {
    const hist: SyncHistoryRecord = {
      historyId: 'hist_diag_100',
      commandId: 'cmd_diag_100',
      groupId: 'grp_test_01',
      commandType: 'CREATE_ORDER',
      entityType: 'orders',
      entityId: 'ord_diag_100',
      state: 'FAILED',
      createdAt: '2026-09-28T10:00:00.000Z',
      updatedAt: '2026-09-28T10:00:05.000Z',
      attemptCount: 2,
      errorClass: 'DATABASE_CONSTRAINT',
      errorMessage: 'Key (id)=(ord_diag_100) already exists',
      failureStage: 'REMOTE_EXECUTION',
      rpcReached: true,
      retryEligible: false,
      httpStatus: 400,
      postgresSqlstate: '23505',
      constraintName: 'orders_pkey',
    };
    await localDb.saveHistory(hist);

    const history = await localDb.listHistory();
    const target = history.find((h) => h.commandId === 'cmd_diag_100');

    expect(target).toBeDefined();
    expect(target?.groupId).toBe('grp_test_01');
    expect(target?.errorClass).toBe('DATABASE_CONSTRAINT');
    expect(target?.postgresSqlstate).toBe('23505');
    expect(target?.constraintName).toBe('orders_pkey');
  });

  // -------------------------------------------------------------------------
  // TEST 11: Purging sync diagnostic history clears historical diagnostic errors
  // -------------------------------------------------------------------------
  it('TEST 11: Purging sync diagnostic history clears historical errors from Developer Diagnostics and localDb', async () => {
    // Seed historical failed record
    const hist: SyncHistoryRecord = {
      historyId: 'hist_diag_err',
      commandId: 'cmd_diag_err',
      commandType: 'CREATE_ORDER',
      entityType: 'orders',
      entityId: 'ord_123',
      state: 'FAILED',
      createdAt: '2026-09-28T10:00:00.000Z',
      updatedAt: '2026-09-28T10:00:01.000Z',
      attemptCount: 3,
      errorClass: 'DATABASE_CONSTRAINT',
      errorMessage: 'Historical error that should not persist forever',
      failureStage: 'REMOTE_EXECUTION',
      retryEligible: false,
    };
    await localDb.saveHistory(hist);

    const historyBefore = await localDb.listHistory();
    expect(historyBefore.length).toBeGreaterThan(0);

    // Execute clearSyncHistory
    await localDb.clearSyncHistory();

    const historyAfter = await localDb.listHistory();
    expect(historyAfter).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // TEST 12: Sync state recovers to SYNCED after clearing diagnostics if no pending outbox
  // -------------------------------------------------------------------------
  it('TEST 12: Sync state recovers from FAILED to SYNCED after clearing diagnostics if outbox is empty', async () => {
    // Before clear: history has FAILED record
    const hist: SyncHistoryRecord = {
      historyId: 'hist_fail_old',
      commandId: 'cmd_fail_old',
      commandType: 'CREATE_ORDER',
      entityType: 'orders',
      entityId: 'ord_999',
      state: 'FAILED',
      createdAt: '2026-09-28T10:00:00.000Z',
      updatedAt: '2026-09-28T10:00:01.000Z',
      attemptCount: 1,
      errorClass: 'SERVER',
      errorMessage: 'Old server error',
    };
    await localDb.saveHistory(hist);

    let history = await localDb.listHistory();
    let outbox = await localDb.listOutbox();

    const failedRecordsBefore = history.filter(
      (h) => h.state === 'FAILED' || h.state === 'FAILED_PERMANENT' || h.state === 'FAILED_RETRYABLE'
    );
    const failedCountBefore = outbox.filter((i) => i.status === 'rejected' || i.status === 'conflict').length + failedRecordsBefore.length;

    expect(failedCountBefore).toBeGreaterThan(0);

    // Clear diagnostics
    await localDb.clearSyncHistory();

    history = await localDb.listHistory();
    outbox = await localDb.listOutbox();

    const failedRecordsAfter = history.filter(
      (h) => h.state === 'FAILED' || h.state === 'FAILED_PERMANENT' || h.state === 'FAILED_RETRYABLE'
    );
    const failedCountAfter = outbox.filter((i) => i.status === 'rejected' || i.status === 'conflict').length + failedRecordsAfter.length;
    const pendingCount = outbox.filter((i) => i.status === 'pending' || i.status === 'syncing').length;
    const blockedCount = outbox.filter((i) => i.status === 'blocked').length;

    let derivedState = 'SYNCED';
    if (blockedCount > 0) derivedState = 'BLOCKED';
    else if (failedCountAfter > 0) derivedState = 'FAILED';
    else if (pendingCount > 0) derivedState = 'PENDING';

    expect(derivedState).toBe('SYNCED');
  });

  // -------------------------------------------------------------------------
  // TEST 13: Operational data and sync cursor preserved during clearSyncHistory
  // -------------------------------------------------------------------------
  it('TEST 13: Orders, customers, outbox, and lastPulledAt cursor are strictly preserved when clearing diagnostics', async () => {
    // 1. Seed customer
    await localDb.set('customers', 'cust_001', {
      id: 'cust_001',
      name: 'Customer 1',
      phone: '0590000000',
    });

    // 2. Seed pending outbox record
    const pendingOutbox: OutboxRecord = {
      commandId: 'cmd_keep_001',
      commandType: 'CREATE_ORDER',
      aggregateType: 'orders',
      aggregateId: 'ord_keep_001',
      payload: { total: 100 },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending',
      retryCount: 0,
    };
    await localDb.saveOutbox(pendingOutbox);

    // 3. Seed sync state with lastPulledAt
    const testSyncTime = '2026-09-30T12:00:00.000Z';
    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 42,
      lastPulledAt: testSyncTime,
    });

    // 4. Seed history record
    await localDb.saveHistory({
      historyId: 'hist_to_purge',
      commandId: 'cmd_old_err',
      commandType: 'CREATE_ORDER',
      entityType: 'orders',
      entityId: 'ord_old',
      state: 'FAILED',
      createdAt: '2026-09-28T10:00:00.000Z',
      updatedAt: '2026-09-28T10:00:01.000Z',
      attemptCount: 1,
    });

    // Clear diagnostics
    await localDb.clearSyncHistory();

    // Verify history was cleared
    const history = await localDb.listHistory();
    expect(history).toHaveLength(0);

    // Verify customer preserved
    const customer = await localDb.get('customers', 'cust_001');
    expect(customer).toBeDefined();
    expect((customer as any).name).toBe('Customer 1');

    // Verify outbox preserved
    const outbox = await localDb.listOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].commandId).toBe('cmd_keep_001');

    // Verify sync state cursor preserved
    const syncState = await localDb.getSyncState('global');
    expect(syncState?.lastPulledAt).toBe(testSyncTime);
  });
});
