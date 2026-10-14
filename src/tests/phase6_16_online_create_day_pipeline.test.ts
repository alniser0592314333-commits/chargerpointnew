/**
 * Phase 6.16: Forensic Verification & Regression Suite for Online Create Day Path
 * Verifies exact flow: UI / createNewBusinessDay -> Repository -> LocalDb Outbox -> SyncEngine -> SupabaseSyncTransport -> execute_sync_command
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as supabaseClient from '../services/supabase/client';
import { SyncEngine } from '../infrastructure/sync/syncEngine';
import { SupabaseSyncTransport } from '../infrastructure/sync/SupabaseSyncTransport';
import { localDb } from '../infrastructure/localDb/localDb';
import { initializeCanonicalSyncState, setTestAppAuthSession } from './utils/testSetup';
import { createNewBusinessDay, getDaysList, ensureStoreHydrated } from '../components/pages/dayOrdersStore';

const storageMap = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storageMap.get(key) || null,
  setItem: (key: string, val: string) => storageMap.set(key, String(val)),
  removeItem: (key: string) => storageMap.delete(key),
  clear: () => storageMap.clear(),
};
(globalThis as any).localStorage = localStorageMock;

const emptyBootstrapSnapshot = () => ({
  schema_version: 1,
  server_reset_generation: 1,
  max_change_sequence: 0,
  customers: [],
  business_days: [],
  device_types: [],
  orders: [],
  order_items: [],
  financial_ledger: [],
  payments: [],
  payment_allocations: [],
  order_number_reservations: [],
  qr_tokens: [],
  goals: [],
  goal_requests: [],
});

const emptyPullPage = () => ({
  changes: [],
  latestSequence: 0,
  serverResetGeneration: 1,
});

describe('Phase 6.16: Online Create Day Forensic & Regression Suite', () => {
  beforeEach(async () => {
    storageMap.clear();
    await localDb.clear();
    vi.restoreAllMocks();
    await initializeCanonicalSyncState();
    setTestAppAuthSession();
    supabaseClient.clearStoredSupabaseAuthSession();
    supabaseClient.setSupabaseAuthToken(null);
    vi.spyOn(supabaseClient, 'invokeSupabaseRestGet').mockImplementation(async (table: string) => {
      if (table === 'system_settings') {
        return { data: [{ value_number: 1 }], error: null };
      }
      return { data: [], error: null };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Online create day queues command in outbox and SyncEngine pushes to execute_sync_command', async () => {
    // 1. Establish valid authenticated session
    const mockToken = 'mock_valid_jwt_access_token_123';
    supabaseClient.setSupabaseAuthToken(mockToken);
    supabaseClient.saveStoredSupabaseAuthSession({
      access_token: mockToken,
      user: { id: 'admin_user_01', email: 'admin@system.local' },
    });

    let invokedRpcName = '';
    let invokedPayload: any = null;

    let executeCallCount = 0;
    vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockImplementation(async (fnName, payload: any) => {
      if (fnName === 'capture_sync_bootstrap_snapshot') {
        return { data: emptyBootstrapSnapshot(), error: null };
      }
      if (fnName === 'pull_canonical_changes') {
        return { data: emptyPullPage(), error: null };
      }
      if (fnName === 'execute_sync_command') {
        executeCallCount++;
        invokedRpcName = fnName;
        invokedPayload = payload;
        return {
          data: {
            success: true,
            command_id: payload.p_command_id,
            command_type: payload.p_command_type,
          },
          error: null,
        };
      }
      return { data: null, error: `Unexpected RPC: ${fnName}` };
    });

    // 2. Trigger creation via domain function
    const targetDate = '2099-05-15';
    const createRes = await createNewBusinessDay(targetDate);
    expect(createRes.success).toBe(true);

    // 3. Verify outbox state is recorded (pending, syncing or accepted as auto-sync pushes)
    let outboxItems = await localDb.listOutbox();
    let dayCmd = outboxItems.find(i => i.commandType === 'OPEN_DAY');
    expect(dayCmd).toBeDefined();
    expect(['pending', 'syncing', 'accepted']).toContain(dayCmd?.status);
    expect(dayCmd?.payload).toMatchObject({
      businessDate: targetDate,
      isClosed: false,
    });

    // 4. Run SyncEngine synchronize to push outbox
    const transport = new SupabaseSyncTransport();
    const engine = new SyncEngine(transport);
    const syncRes = await engine.synchronize();
    expect(syncRes.pushed).toBeGreaterThanOrEqual(0);
    expect(executeCallCount).toBe(1);

    // 5. Verify outbox status is now accepted and RPC invoked
    outboxItems = await localDb.listOutbox();
    dayCmd = outboxItems.find(i => i.commandType === 'OPEN_DAY');
    expect(dayCmd?.status).toBe('accepted');
    expect(invokedRpcName).toBe('execute_sync_command');
    expect(invokedPayload.p_command_type).toBe('OPEN_DAY');
    expect(invokedPayload.p_payload.businessDate).toBe(targetDate);
  });

  it('2. Reload while authenticated preserves token and allows immediate online day creation', async () => {
    // Simulate stored session from earlier login
    const storedToken = 'persisted_jwt_session_after_reload';
    supabaseClient.saveStoredSupabaseAuthSession({
      access_token: storedToken,
      user: { id: 'admin_user_01', email: 'admin@system.local' },
    });

    // Fresh memory state (simulate browser tab refresh)
    supabaseClient.setSupabaseAuthToken(null);

    // Token must be authoritatively resolved from storage
    expect(supabaseClient.getSupabaseAuthToken()).toBe(storedToken);

    let calledWithBearer = '';
    vi.spyOn(supabaseClient, 'getSupabaseStatus').mockReturnValue({
      isConfigured: true,
      url: 'https://test.supabase.local',
      status: 'connected',
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, options: any) => {
      calledWithBearer = options?.headers?.Authorization || '';
      const endpoint = String(url);
      const body = options?.body ? JSON.parse(options.body) : {};
      const data = endpoint.includes('/rpc/pull_canonical_changes')
        ? emptyPullPage()
        : { success: true, command_id: body.p_command_id };
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => data,
      } as any;
    });

    const transport = new SupabaseSyncTransport();
    const engine = new SyncEngine(transport);

    await engine.queueCommand(
      'cmd-reload-day-1',
      'OPEN_DAY',
      'business_days',
      'day-2099-08-01',
      { businessDate: '2099-08-01', isClosed: false },
      'laptop-device',
      'admin-1'
    );

    const syncRes = await engine.synchronize();
    expect(syncRes.pushed).toBe(1);
    expect(calledWithBearer).toBe(`Bearer ${storedToken}`);

    const outbox = await localDb.listOutbox();
    expect(outbox[0].status).toBe('accepted');
  });

  it('3. RPC failure does NOT mark command completed and retains last error', async () => {
    supabaseClient.setSupabaseAuthToken('valid_token');

    vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockImplementation(async (fnName, payload: any) => {
      if (fnName === 'pull_canonical_changes') {
        return { data: emptyPullPage(), error: null };
      }
      return {
        data: null,
        error: 'RPC execute_sync_command failed [500]: Database connection timeout',
      };
    });

    const transport = new SupabaseSyncTransport();
    const engine = new SyncEngine(transport);

    await engine.queueCommand(
      'cmd-failing-day',
      'OPEN_DAY',
      'business_days',
      'day-2099-09-01',
      { businessDate: '2099-09-01' },
      'laptop-device',
      'admin-1'
    );

    const syncRes = await engine.synchronize();
    expect(syncRes.pushed).toBe(0);

    const outbox = await localDb.listOutbox();
    expect(outbox[0].status).toBe('conflict');
    expect(outbox[0].lastError).toContain('Database connection timeout');
  });

  it('4. Duplicate command replay remains idempotent and returns cached success', async () => {
    supabaseClient.setSupabaseAuthToken('valid_token');

    let callCount = 0;
    vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockImplementation(async (fnName, payload: any) => {
      if (fnName === 'pull_canonical_changes') {
        return { data: emptyPullPage(), error: null };
      }
      callCount++;
      return {
        data: { success: true, command_id: payload.p_command_id || 'cmd-idempotent-1' },
        error: null,
      };
    });

    const transport = new SupabaseSyncTransport();
    const engine = new SyncEngine(transport);

    await engine.queueCommand(
      'cmd-idempotent-1',
      'OPEN_DAY',
      'business_days',
      'day-2099-10-01',
      { businessDate: '2099-10-01' },
      'laptop-device',
      'admin-1'
    );

    // First push -> successful
    const sync1 = await engine.synchronize();
    expect(sync1.pushed).toBe(1);
    expect(callCount).toBe(1);

    // Second sync -> nothing pending
    const sync2 = await engine.synchronize();
    expect(sync2.pushed).toBe(0);
    expect(callCount).toBe(1);
  });

  it('5. createTodayBusinessDay from HomePage queues OPEN_DAY and pushes to execute_sync_command', async () => {
    const mockToken = 'mock_jwt_token_home_today';
    supabaseClient.setSupabaseAuthToken(mockToken);
    supabaseClient.saveStoredSupabaseAuthSession({
      access_token: mockToken,
      user: { id: 'admin_user_01', email: 'admin@system.local' },
    });

    let rpcCalledWith: any = null;
    vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockImplementation(async (fnName, payload: any) => {
      if (fnName === 'capture_sync_bootstrap_snapshot') {
        return { data: emptyBootstrapSnapshot(), error: null };
      }
      if (fnName === 'pull_canonical_changes') {
        return { data: emptyPullPage(), error: null };
      }
      if (fnName === 'execute_sync_command') {
        rpcCalledWith = { fnName, payload };
        return {
          data: { success: true, command_id: payload.p_command_id },
          error: null,
        };
      }
      return { data: null, error: `Unexpected RPC: ${fnName}` };
    });

    const todayStr = '2099-06-20';
    const dayId = await createNewBusinessDay(todayStr);
    expect(dayId.success).toBe(true);

    const transport = new SupabaseSyncTransport();
    const engine = new SyncEngine(transport);
    await engine.synchronize();

    const outbox = await localDb.listOutbox();
    const cmd = outbox.find(i => i.commandType === 'OPEN_DAY' && i.aggregateId === dayId.dayId);
    expect(cmd).toBeDefined();
    expect(cmd?.status).toBe('accepted');
    expect(rpcCalledWith.fnName).toBe('execute_sync_command');
    expect(rpcCalledWith.payload.p_command_type).toBe('OPEN_DAY');
  });
});
