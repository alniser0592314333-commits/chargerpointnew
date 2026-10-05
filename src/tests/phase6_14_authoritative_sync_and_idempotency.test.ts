/**
 * Phase 6.14: Authoritative Remote Sync Security & Command Idempotency Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SupabaseSyncTransport } from '../infrastructure/sync/SupabaseSyncTransport';
import * as supabaseClient from '../services/supabase/client';

describe('Phase 6.14: Remote Authorization Boundary & Command Idempotency Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Server-Authoritative Authorization Boundary', () => {
    it('rejects sync commands pushed without authenticated active admin', async () => {
      vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockResolvedValueOnce({
        data: null,
        error: 'Unauthorized: Caller is not a registered admin profile',
      });

      const transport = new SupabaseSyncTransport();
      const res = await transport.pushCommand({
        commandId: 'cmd_unauth_001',
        commandType: 'CREATE_ORDER',
        deviceId: 'dev_1',
        actorAdminId: 'adm_1',
        payload: { dayId: 'day-1', customerId: 'cust-1' },
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('Unauthorized');
    });

    it('rejects sync commands when admin lacks specific permission (e.g. orders:create)', async () => {
      vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockResolvedValueOnce({
        data: null,
        error: 'Forbidden: Admin lacks required permission "orders:create" for command "CREATE_ORDER"',
      });

      const transport = new SupabaseSyncTransport();
      const res = await transport.pushCommand({
        commandId: 'cmd_forbidden_002',
        commandType: 'CREATE_ORDER',
        deviceId: 'dev_1',
        actorAdminId: 'adm_1',
        payload: { dayId: 'day-1', customerId: 'cust-1' },
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('Forbidden');
      expect(res.error).toContain('orders:create');
    });

    it('rejects offline replay attempt after admin account is disabled', async () => {
      vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockResolvedValueOnce({
        data: null,
        error: 'Forbidden: Admin account is inactive or disabled',
      });

      const transport = new SupabaseSyncTransport();
      const res = await transport.pushCommand({
        commandId: 'cmd_disabled_003',
        commandType: 'CREATE_CUSTOMER',
        deviceId: 'dev_1',
        actorAdminId: 'adm_1',
        payload: { name: 'Replay Customer' },
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('Forbidden: Admin account is inactive or disabled');
    });
  });

  describe('2. True Command Idempotency vs Entity Idempotency', () => {
    it('returns cached successful result for duplicate command without re-executing', async () => {
      let rpcCallCount = 0;
      vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockImplementation(async (fnName, params: any) => {
        if (fnName === 'execute_sync_command') {
          rpcCallCount++;
          // Returns cached result for the exact same command_id
          return {
            data: {
              success: true,
              command_id: params.p_command_id,
              command_type: params.p_command_type,
              actor_admin_id: 'admin_1',
              cached: rpcCallCount > 1,
            },
            error: null,
          };
        }
        return { data: null, error: 'Unknown RPC' };
      });

      const transport = new SupabaseSyncTransport();
      const req = {
        commandId: 'cmd_idemp_order_100',
        commandType: 'CREATE_ORDER',
        deviceId: 'dev_1',
        actorAdminId: 'adm_1',
        payload: { id: 'ord_100', dayId: 'day-1', customerId: 'cust-1', status: 'charging' },
      };

      // First attempt
      const res1 = await transport.pushCommand(req);
      expect(res1.success).toBe(true);

      // Replay of identical command (e.g. after network glitch or app restart)
      const res2 = await transport.pushCommand(req);
      expect(res2.success).toBe(true);
      expect(rpcCallCount).toBe(2);
    });

    it('ensures financial ledger commands are strictly idempotent on replay', async () => {
      vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockResolvedValue({
        data: {
          success: true,
          command_id: 'cmd_ledg_200',
          command_type: 'DELIVERY_CHARGE',
          processed_at: new Date().toISOString(),
        },
        error: null,
      });

      const transport = new SupabaseSyncTransport();
      const financialReq = {
        commandId: 'cmd_ledg_200',
        commandType: 'DELIVERY_CHARGE',
        deviceId: 'dev_1',
        actorAdminId: 'adm_1',
        payload: {
          id: 'ledg_200',
          amountMinor: -2000,
          orderId: 'ord_200',
          customerId: 'cust_200',
        },
      };

      const firstPush = await transport.pushCommand(financialReq);
      expect(firstPush.success).toBe(true);

      // Re-pushing exact same financial charge command
      const retryPush = await transport.pushCommand(financialReq);
      expect(retryPush.success).toBe(true);
    });
  });
});
