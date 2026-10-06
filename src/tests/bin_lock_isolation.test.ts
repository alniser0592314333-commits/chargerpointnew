import { describe, it, expect, beforeEach, vi } from 'vitest';
import { authService } from '../services/auth/authService';
import * as supabaseClient from '../services/supabase/client';
import { config } from '../config/env';

const storageMap = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storageMap.get(key) || null,
  setItem: (key: string, val: string) => storageMap.set(key, String(val)),
  removeItem: (key: string) => storageMap.delete(key),
  clear: () => storageMap.clear(),
};
(globalThis as any).localStorage = localStorageMock;

describe('Bin Lock Isolation From Primary Auth Regression Tests', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    storageMap.clear();
    await authService.logout();
    config.supabaseUrl = 'https://example.supabase.co';
    config.supabaseAnonKey = 'sb_publishable_mock_key';
  });

  it('TEST A — Correct password, locked BIN: password passes, BIN challenge throws BIN_LOCKED_FROZEN without clearing primary session', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: {
        access_token: 'jwt_super_token',
        user: { id: 'user_super', email: 'super@system.local' },
      },
      error: null,
    });
    vi.spyOn(authService, 'getAdminProfile').mockResolvedValue({
      authenticated: true,
      is_admin: true,
      is_active: true,
      admin_id: 'admin_super',
      role: 'SUPER_ADMIN',
      permissions: ['admin:manage'],
    });

    // 1. Primary password auth passes and demands BIN
    await expect(authService.login('super@system.local', 'validpass')).rejects.toThrow('SUPER_ADMIN_BIN_REQUIRED');

    // 2. Verify Super Admin BIN when locked -> throws BIN_LOCKED_FROZEN
    vi.spyOn(supabaseClient, 'rpcVerifyAdminBinWithTracking').mockResolvedValue({
      success: false,
      is_locked: true,
      status: 'LOCKED',
      failed_attempts: 3,
      remaining_attempts: 0,
      error: 'Account locked',
    } as any);

    let errorThrown: any = null;
    try {
      await authService.verifySuperAdminBin('123456');
    } catch (err) {
      errorThrown = err;
    }

    expect(errorThrown).not.toBeNull();
    expect(errorThrown.message).toBe('BIN_LOCKED_FROZEN');

    // 3. Primary auth session (Supabase auth token) must remain valid and not be cleared
    expect(supabaseClient.getSupabaseAuthToken()).toBe('jwt_super_token');
  });

  it('TEST B — Invalid password returns null (INVALID_CREDENTIALS)', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: null,
      error: 'Invalid login credentials',
    });

    const session = await authService.login('super@system.local', 'wrongpass');
    expect(session).toBeNull();
  });

  it('TEST C — Correct password, wrong BIN: throws WRONG_BIN with remaining attempts', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: {
        access_token: 'jwt_super_token',
        user: { id: 'user_super', email: 'super@system.local' },
      },
      error: null,
    });
    vi.spyOn(authService, 'getAdminProfile').mockResolvedValue({
      authenticated: true,
      is_admin: true,
      is_active: true,
      admin_id: 'admin_super',
      role: 'SUPER_ADMIN',
      permissions: ['admin:manage'],
    });

    await expect(authService.login('super@system.local', 'validpass')).rejects.toThrow('SUPER_ADMIN_BIN_REQUIRED');

    vi.spyOn(supabaseClient, 'rpcVerifyAdminBinWithTracking').mockResolvedValue({
      success: false,
      is_locked: false,
      status: 'ACTIVE',
      remaining_attempts: 2,
      failed_attempts: 1,
      error: 'Wrong BIN',
    } as any);

    let errorThrown: any = null;
    try {
      await authService.verifySuperAdminBin('0000');
    } catch (err) {
      errorThrown = err;
    }

    expect(errorThrown).not.toBeNull();
    expect(errorThrown.message).toBe('WRONG_BIN');
    expect(errorThrown.remainingAttempts).toBe(2);
  });

  it('TEST D — Correct password, Super Admin BIN required state reached', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: {
        access_token: 'jwt_super_token',
        user: { id: 'user_super', email: 'super@system.local' },
      },
      error: null,
    });
    vi.spyOn(authService, 'getAdminProfile').mockResolvedValue({
      authenticated: true,
      is_admin: true,
      is_active: true,
      admin_id: 'admin_super',
      role: 'SUPER_ADMIN',
      permissions: ['admin:manage'],
    });

    await expect(authService.login('super@system.local', 'pass123')).rejects.toThrow('SUPER_ADMIN_BIN_REQUIRED');
  });

  it('TEST E — BIN failure does not sign out or clear Supabase session', async () => {
    supabaseClient.setSupabaseAuthToken('test_token_preserved');
    const tokenBefore = supabaseClient.getSupabaseAuthToken();
    expect(tokenBefore).toBe('test_token_preserved');

    vi.spyOn(supabaseClient, 'rpcVerifyAdminBinWithTracking').mockResolvedValue({
      success: false,
      is_locked: true,
      status: 'LOCKED',
      remaining_attempts: 0,
      failed_attempts: 3,
    } as any);

    try {
      await authService.verifySuperAdminBin('9999');
    } catch {}

    // Primary session token must be preserved
    expect(supabaseClient.getSupabaseAuthToken()).toBe('test_token_preserved');
  });
});
