/**
 * Phase 6.15: Auth Token Resolution Hierarchy & Outbox Resumption Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as supabaseClient from '../services/supabase/client';
import { SyncEngine, MockServerSyncTransport } from '../infrastructure/sync/syncEngine';
import { SupabaseSyncTransport } from '../infrastructure/sync/SupabaseSyncTransport';
import { localDb } from '../infrastructure/localDb/localDb';
import { initializeCanonicalSyncState } from './utils/testSetup';

const storageMap = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storageMap.get(key) || null,
  setItem: (key: string, val: string) => storageMap.set(key, String(val)),
  removeItem: (key: string) => storageMap.delete(key),
  clear: () => storageMap.clear(),
};
(globalThis as any).localStorage = localStorageMock;

describe('Phase 6.15: Auth Token Resolution & Outbox Resume Security Suite', () => {
  beforeEach(async () => {
    storageMap.clear();
    await localDb.clear();
    await initializeCanonicalSyncState();
    supabaseClient.clearStoredSupabaseAuthSession();
    supabaseClient.setSupabaseAuthToken(null);
    vi.restoreAllMocks();
    vi.spyOn(supabaseClient, 'getSupabaseStatus').mockReturnValue({
      isConfigured: true,
      url: 'https://test.supabase.co',
      status: 'connected',
    });
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

  describe('A. Token Resolution Hierarchy & Anon Key Safeguards', () => {
    it('1. Rejects authenticated RPC when no token is present, without falling back to anon key as bearer', async () => {
      // Ensure no active token and no stored session
      expect(supabaseClient.getSupabaseAuthToken()).toBeNull();

      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const res = await supabaseClient.invokeSupabaseRpc('execute_sync_command', {
        p_command_id: 'cmd-test-1',
      });

      expect(res.data).toBeNull();
      expect(res.error).toContain('AUTH_TOKEN_MISSING');
      // Fetch should NOT even be called with anon key pretending to be user
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('2. Automatically recovers token from stored session on reload (memory reset)', async () => {
      // Simulate page reload: localStorage has session, but in-memory activeAuthToken is null
      supabaseClient.saveStoredSupabaseAuthSession({
        access_token: 'valid_jwt_token_reloaded_from_storage',
        user: { id: 'admin-123', email: 'admin@system.local' },
      });

      // Reset in-memory token to null
      supabaseClient.setSupabaseAuthToken(null);

      // getSupabaseAuthToken and resolveAuthBearerToken should automatically rehydrate
      expect(supabaseClient.getSupabaseAuthToken()).toBe('valid_jwt_token_reloaded_from_storage');

      // Mock fetch
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as any);

      const res = await supabaseClient.invokeSupabaseRpc('get_current_admin_profile', {});
      expect(res.error).toBeNull();
      expect(res.data).toEqual({ success: true });
    });

    it('3. Respects explicit customAuthToken with highest priority', async () => {
      supabaseClient.saveStoredSupabaseAuthSession({
        access_token: 'stored_token',
        user: { id: 'admin-stored', email: 'stored@system.local' },
      });
      supabaseClient.setSupabaseAuthToken('active_token');

      let capturedBearer = '';
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, options: any) => {
        capturedBearer = options?.headers?.Authorization || '';
        return {
          ok: true,
          json: async () => ({ success: true }),
        } as any;
      });

      await supabaseClient.invokeSupabaseRpc('get_current_admin_profile', {}, 'custom_override_token');
      expect(capturedBearer).toBe('Bearer custom_override_token');
    });

    it('4. Allows public RPCs to run with anon key without login', async () => {
      expect(supabaseClient.getSupabaseAuthToken()).toBeNull();

      let capturedApiKey = '';
      let capturedBearer = '';
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, options: any) => {
        capturedApiKey = options?.headers?.apikey || '';
        capturedBearer = options?.headers?.Authorization || '';
        return {
          ok: true,
          json: async () => true,
        } as any;
      });

      const res = await supabaseClient.invokeSupabaseRpc('is_system_bootstrapped', {});
      expect(res.error).toBeNull();
      expect(res.data).toBe(true);
      expect(capturedApiKey).toBeDefined();
      expect(capturedBearer).toBe(`Bearer ${capturedApiKey}`);
    });
  });

  describe('B. Outbox Resumption & Recoverable Auth Error Retry', () => {
    it('1. Outbox commands stuck with auth errors are retried when session is restored', async () => {
      const transport = new SupabaseSyncTransport();
      const engine = new SyncEngine(transport);

      // Queue command while user is offline or not authenticated
      await engine.queueCommand(
        'cmd-unauth-1',
        'OPEN_DAY',
        'business_days',
        'day-1',
        { businessDate: '2026-09-27' },
        'dev-1',
        'admin-1'
      );

      // Attempt 1: Sync fails with AUTH_TOKEN_MISSING
      await engine.synchronize();

      const outboxAfterFail = await localDb.listOutbox();
      // The canonical pull is a preflight: without a user token, the engine
      // must stop before pushing or mutating the pending command.
      expect(outboxAfterFail[0].status).toBe('pending');
      expect(outboxAfterFail[0].lastError).toBeUndefined();
      expect(outboxAfterFail[0].retryCount).toBe(0);

      // User now logs in: token is set
      supabaseClient.setSupabaseAuthToken('valid_access_token_now');

      // Mock the canonical pull page and then the command execution RPC.
      vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockImplementation(async (fnName, payload: any) => {
        if (fnName === 'pull_canonical_changes') {
          return {
            data: { changes: [], latestSequence: 0, serverResetGeneration: 1 },
            error: null,
          };
        }
        if (fnName === 'execute_sync_command') {
          return { data: { success: true, command_id: payload.p_command_id }, error: null };
        }
        return { data: null, error: `Unexpected RPC: ${fnName}` };
      });

      // Attempt 2: Synchronize resumes and pushes the command
      const syncResult = await engine.synchronize();
      expect(syncResult.pushed).toBe(1);

      const outboxAfterSuccess = await localDb.listOutbox();
      expect(outboxAfterSuccess[0].status).toBe('accepted');
      expect(outboxAfterSuccess[0].lastError).toBeUndefined();
    });

    it('2. resumePendingOutbox resets stuck syncing/conflict/auth-rejected items to pending', async () => {
      const engine = new SyncEngine(new MockServerSyncTransport());

      await localDb.saveOutbox({
        commandId: 'cmd-rejected-auth',
        commandType: 'CREATE_ORDER',
        aggregateType: 'orders',
        aggregateId: 'ord-1',
        payload: { amount: 100 },
        createdAt: new Date().toISOString(),
        deviceId: 'dev-1',
        actorAdminId: 'admin-1',
        status: 'rejected',
        retryCount: 2,
        lastError: 'UNAUTHORIZED_ANONYMOUS: Token expired',
      });

      await localDb.saveOutbox({
        commandId: 'cmd-conflict-auth',
        commandType: 'CREATE_CUSTOMER',
        aggregateType: 'customers',
        aggregateId: 'cust-1',
        payload: { name: 'Customer A' },
        createdAt: new Date().toISOString(),
        deviceId: 'dev-1',
        actorAdminId: 'admin-1',
        status: 'conflict',
        retryCount: 1,
        lastError: 'AUTH_TOKEN_MISSING: Authentication required',
      });

      const resumedCount = await engine.resumePendingOutbox();
      expect(resumedCount).toBe(2);

      const items = await localDb.listOutbox();
      expect(items.find(i => i.commandId === 'cmd-rejected-auth')?.status).toBe('pending');
      expect(items.find(i => i.commandId === 'cmd-conflict-auth')?.status).toBe('pending');
    });

    it('3. Outbox records and sync state survive localDb restart and reload', async () => {
      await localDb.saveOutbox({
        commandId: 'cmd-persist-1',
        commandType: 'OPEN_DAY',
        aggregateType: 'business_days',
        aggregateId: 'day-1',
        payload: { businessDate: '2026-09-27' },
        createdAt: new Date().toISOString(),
        deviceId: 'dev-1',
        actorAdminId: 'admin-1',
        status: 'pending',
        retryCount: 0,
      });

      await localDb.setSyncState({
        table: 'global',
        lastAppliedChangeSequence: 42,
        lastPulledAt: new Date().toISOString(),
      });

      // Verify retrieval
      const item = await localDb.getOutbox('cmd-persist-1');
      expect(item).not.toBeNull();
      expect(item?.commandId).toBe('cmd-persist-1');

      const syncState = await localDb.getSyncState('global');
      expect(syncState?.lastAppliedChangeSequence).toBe(42);
    });
  });
});
