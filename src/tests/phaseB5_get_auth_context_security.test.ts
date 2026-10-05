import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthorizationContext, ActorAdmin } from '../application/authContext';
import { authService } from '../services/auth/authService';
import * as clientModule from '../services/supabase/client';
import { AuthorizationError } from '../domain/errors';

describe('Security Fix: getAuthContext BIN Fail-Closed Fallback', () => {
  const adminActor: ActorAdmin = {
    id: 'admin_test_01',
    username: 'admin',
    fullName: 'Test Admin',
    role: 'SUPER_ADMIN',
    permissions: ['settings:manage'],
    isSuperAdmin: true,
  };

  /**
   * Helper simulating getAuthContext's verifier creation logic exactly as implemented in BackupDataManagement.tsx
   */
  function createTestAuthContext(): AuthorizationContext {
    return new AuthorizationContext(adminActor, async (enteredBin: string) => {
      if (authService.isSupabaseConfigured()) {
        try {
          return await clientModule.rpcVerifyAdminBin(enteredBin);
        } catch {
          return false;
        }
      }
      return authService.verifyBin(enteredBin);
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // TEST A: Supabase Configured = true, rpcVerifyAdminBin returns true -> succeeds
  // -------------------------------------------------------------------------
  it('TEST A: Supabase configured = true & rpcVerifyAdminBin returns true -> verification succeeds', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(clientModule, 'rpcVerifyAdminBin').mockResolvedValue(true);

    const auth = createTestAuthContext();
    await expect(auth.verifyBin('987654')).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // TEST B: Supabase Configured = true, rpcVerifyAdminBin returns false, enteredBin = "1234" -> MUST FAIL
  // -------------------------------------------------------------------------
  it('TEST B: Supabase configured = true & rpcVerifyAdminBin returns false (enteredBin="1234") -> MUST FAIL without fallback', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(clientModule, 'rpcVerifyAdminBin').mockResolvedValue(false);

    const auth = createTestAuthContext();
    await expect(auth.verifyBin('1234')).rejects.toThrow(AuthorizationError);
  });

  // -------------------------------------------------------------------------
  // TEST C: Supabase Configured = true, rpcVerifyAdminBin returns false, enteredBin = "123456" -> MUST FAIL
  // -------------------------------------------------------------------------
  it('TEST C: Supabase configured = true & rpcVerifyAdminBin returns false (enteredBin="123456") -> MUST FAIL without fallback', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(clientModule, 'rpcVerifyAdminBin').mockResolvedValue(false);

    const auth = createTestAuthContext();
    await expect(auth.verifyBin('123456')).rejects.toThrow(AuthorizationError);
  });

  // -------------------------------------------------------------------------
  // TEST D: Supabase Configured = true, RPC throws / network error -> MUST FAIL
  // -------------------------------------------------------------------------
  it('TEST D: Supabase configured = true & RPC throws/network error -> MUST FAIL (Fail-Closed)', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(clientModule, 'rpcVerifyAdminBin').mockRejectedValue(new Error('Network disconnected'));

    const auth = createTestAuthContext();
    await expect(auth.verifyBin('1234')).rejects.toThrow(AuthorizationError);
  });

  // -------------------------------------------------------------------------
  // TEST E: Supabase Configured = false, valid local test BIN -> succeeds
  // -------------------------------------------------------------------------
  it('TEST E: Supabase configured = false & valid local test BIN ("1234") -> local verification succeeds', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(false);

    const auth = createTestAuthContext();
    await expect(auth.verifyBin('1234')).resolves.toBeUndefined();
    await expect(auth.verifyBin('123456')).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // TEST F: Supabase Configured = false, invalid local BIN -> fails
  // -------------------------------------------------------------------------
  it('TEST F: Supabase configured = false & invalid local BIN ("9999") -> local verification fails', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(false);

    const auth = createTestAuthContext();
    await expect(auth.verifyBin('9999')).rejects.toThrow(AuthorizationError);
  });
});
