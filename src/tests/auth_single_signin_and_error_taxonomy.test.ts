import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authService } from '../services/auth/authService';
import * as supabaseClient from '../services/supabase/client';

const storageMap = new Map<string, string>();
const mockStorage = {
  getItem: (k: string) => storageMap.get(k) || null,
  setItem: (k: string, v: string) => { storageMap.set(k, String(v)); },
  removeItem: (k: string) => { storageMap.delete(k); },
  clear: () => { storageMap.clear(); },
};
(globalThis as any).localStorage = mockStorage;

describe('Auth Architecture: Single Password Authentication & Error Taxonomy', () => {
  const MOCK_SUPER_ADMIN_PROFILE: supabaseClient.AdminProfileRpcResult = {
    authenticated: true,
    is_admin: true,
    is_active: true,
    is_email_confirmed: true,
    admin_id: 'admin_uuid_123',
    auth_user_id: 'auth_user_uuid_123',
    username: 'superowner',
    full_name: 'Super Owner',
    email: 'super@system.local',
    role: 'SUPER_ADMIN',
    permissions: ['settings:manage', 'admin:manage'] as any,
  };

  const MOCK_SIGN_IN_SESSION: supabaseClient.SupabaseAuthSession = {
    access_token: 'valid_temporary_jwt_abc123',
    token_type: 'bearer',
    expires_in: 3600,
    user: {
      id: 'auth_user_uuid_123',
      email: 'super@system.local',
    },
  };

  const MOCK_BIN_SUCCESS: supabaseClient.BinAttemptVerificationResult = {
    success: true,
    status: 'ACTIVE',
    is_locked: false,
    remaining_attempts: 3,
    failed_attempts: 0,
    error: null,
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    storageMap.clear();
    await authService.logout();
    authService.clearPendingSuperAdminContext();
  });

  // TEST 1: Username + correct password -> exactly ONE signInWithPassword call
  it('TEST 1: Username + correct password -> exactly ONE signInWithPassword call', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'rpcGetEmailByUsername').mockResolvedValue('super@system.local');
    const signInSpy = vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: MOCK_SIGN_IN_SESSION,
      error: null,
      statusCode: 200,
    });
    vi.spyOn(supabaseClient, 'rpcGetCurrentAdminProfile').mockResolvedValue({
      profile: MOCK_SUPER_ADMIN_PROFILE,
      error: null,
    });

    await expect(authService.login('superowner', 'correct_password')).rejects.toThrow('SUPER_ADMIN_BIN_REQUIRED');

    expect(signInSpy).toHaveBeenCalledTimes(1);
    expect(authService.hasPendingSuperAdminContext()).toBe(true);
  });

  // TEST 2: After SUPER_ADMIN_BIN_REQUIRED: Entering BIN -> ZERO additional signInWithPassword calls
  it('TEST 2: After SUPER_ADMIN_BIN_REQUIRED: Entering BIN -> ZERO additional signInWithPassword calls', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'rpcGetEmailByUsername').mockResolvedValue('super@system.local');
    const signInSpy = vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: MOCK_SIGN_IN_SESSION,
      error: null,
      statusCode: 200,
    });
    vi.spyOn(supabaseClient, 'rpcGetCurrentAdminProfile').mockResolvedValue({
      profile: MOCK_SUPER_ADMIN_PROFILE,
      error: null,
    });
    const binSpy = vi.spyOn(supabaseClient, 'rpcVerifyAdminBinWithTracking').mockResolvedValue(MOCK_BIN_SUCCESS);

    // Step 1: Initial password authentication
    await expect(authService.login('superowner', 'correct_password')).rejects.toThrow('SUPER_ADMIN_BIN_REQUIRED');
    expect(signInSpy).toHaveBeenCalledTimes(1);

    // Step 2: Entering BIN
    const finalSession = await authService.verifySuperAdminBin('123456');

    expect(signInSpy).toHaveBeenCalledTimes(1); // ZERO additional signInWithPassword calls!
    expect(binSpy).toHaveBeenCalledTimes(1);
    expect(binSpy).toHaveBeenCalledWith('123456', 'valid_temporary_jwt_abc123');
    expect(finalSession).not.toBeNull();
  });

  // TEST 3: Correct BIN -> Dashboard/final login succeeds using the existing temporary token
  it('TEST 3: Correct BIN -> Dashboard/final login succeeds using existing temporary token', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'rpcGetEmailByUsername').mockResolvedValue('super@system.local');
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: MOCK_SIGN_IN_SESSION,
      error: null,
      statusCode: 200,
    });
    vi.spyOn(supabaseClient, 'rpcGetCurrentAdminProfile').mockResolvedValue({
      profile: MOCK_SUPER_ADMIN_PROFILE,
      error: null,
    });
    vi.spyOn(supabaseClient, 'rpcVerifyAdminBinWithTracking').mockResolvedValue(MOCK_BIN_SUCCESS);

    await expect(authService.login('superowner', 'correct_password')).rejects.toThrow('SUPER_ADMIN_BIN_REQUIRED');
    const session = await authService.verifySuperAdminBin('123456');

    expect(session?.role).toBe('SUPER_ADMIN');
    expect(session?.userId).toBe('admin_uuid_123');
    expect(supabaseClient.getSupabaseAuthToken()).toBe('valid_temporary_jwt_abc123');
  });

  // TEST 4: Wrong BIN -> Password is NOT authenticated again
  it('TEST 4: Wrong BIN -> Password is NOT authenticated again', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'rpcGetEmailByUsername').mockResolvedValue('super@system.local');
    const signInSpy = vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: MOCK_SIGN_IN_SESSION,
      error: null,
      statusCode: 200,
    });
    vi.spyOn(supabaseClient, 'rpcGetCurrentAdminProfile').mockResolvedValue({
      profile: MOCK_SUPER_ADMIN_PROFILE,
      error: null,
    });
    vi.spyOn(supabaseClient, 'rpcVerifyAdminBinWithTracking').mockResolvedValue({
      success: false,
      status: 'ACTIVE',
      is_locked: false,
      remaining_attempts: 2,
      failed_attempts: 1,
      error: 'WRONG_BIN',
    });

    await expect(authService.login('superowner', 'correct_password')).rejects.toThrow('SUPER_ADMIN_BIN_REQUIRED');
    expect(signInSpy).toHaveBeenCalledTimes(1);

    // Wrong BIN attempt 1
    await expect(authService.verifySuperAdminBin('999999')).rejects.toThrow('WRONG_BIN');
    expect(signInSpy).toHaveBeenCalledTimes(1); // STILL 1!

    // Temporary context remains alive in memory for retry
    expect(authService.hasPendingSuperAdminContext()).toBe(true);

    // Wrong BIN attempt 2
    await expect(authService.verifySuperAdminBin('888888')).rejects.toThrow('WRONG_BIN');
    expect(signInSpy).toHaveBeenCalledTimes(1); // STILL 1!
  });

  // TEST 5: BIN locked -> Password is NOT authenticated again
  it('TEST 5: BIN locked -> Password is NOT authenticated again', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'rpcGetEmailByUsername').mockResolvedValue('super@system.local');
    const signInSpy = vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: MOCK_SIGN_IN_SESSION,
      error: null,
      statusCode: 200,
    });
    vi.spyOn(supabaseClient, 'rpcGetCurrentAdminProfile').mockResolvedValue({
      profile: MOCK_SUPER_ADMIN_PROFILE,
      error: null,
    });
    vi.spyOn(supabaseClient, 'rpcVerifyAdminBinWithTracking').mockResolvedValue({
      success: false,
      status: 'LOCKED',
      is_locked: true,
      remaining_attempts: 0,
      failed_attempts: 3,
      error: 'BIN_LOCKED_FROZEN',
    });

    await expect(authService.login('superowner', 'correct_password')).rejects.toThrow('SUPER_ADMIN_BIN_REQUIRED');
    expect(signInSpy).toHaveBeenCalledTimes(1);

    await expect(authService.verifySuperAdminBin('000000')).rejects.toThrow('BIN_LOCKED_FROZEN');
    expect(signInSpy).toHaveBeenCalledTimes(1); // Password NOT authenticated again
    expect(authService.hasPendingSuperAdminContext()).toBe(false); // Cleared on lock
  });

  // TEST 6: Rate limit 429 during initial password authentication -> shows RATE_LIMIT error, NOT password error
  it('TEST 6: Rate limit 429 during initial password authentication -> throws RATE_LIMIT error', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'rpcGetEmailByUsername').mockResolvedValue('super@system.local');
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: null,
      error: 'Too many requests, please wait before retrying.',
      statusCode: 429,
      isRateLimited: true,
    });

    await expect(authService.login('superowner', 'any_password')).rejects.toThrow('RATE_LIMIT');
  });

  // TEST 7: get_current_admin_profile failure after successful password auth -> shows PROFILE_RPC_FAILED, NOT password error
  it('TEST 7: Profile RPC failure after successful password auth -> throws PROFILE_RPC_FAILED', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'rpcGetEmailByUsername').mockResolvedValue('super@system.local');
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: MOCK_SIGN_IN_SESSION,
      error: null,
      statusCode: 200,
    });
    // Password auth was 200 OK, but profile RPC failed due to PostgREST issue
    vi.spyOn(supabaseClient, 'rpcGetCurrentAdminProfile').mockResolvedValue({
      profile: null,
      error: 'Could not find function public.get_current_admin_profile in schema cache',
    });

    await expect(authService.login('superowner', 'correct_password')).rejects.toThrow('PROFILE_RPC_FAILED');
  });

  // TEST 8: username lookup failure -> shows USERNAME_LOOKUP_FAILED, NOT password error
  it('TEST 8: Username lookup failure -> throws USERNAME_LOOKUP_FAILED', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'rpcGetEmailByUsername').mockRejectedValue(new Error('Network or PostgREST error resolving username'));
    const signInSpy = vi.spyOn(supabaseClient, 'supabaseSignInWithPassword');

    await expect(authService.login('superowner', 'any_password')).rejects.toThrow('USERNAME_LOOKUP_FAILED');
    expect(signInSpy).not.toHaveBeenCalled();
  });

  // TEST 9: network failure -> shows NETWORK error, NOT password error
  it('TEST 9: Network failure during password auth -> throws NETWORK_ERROR', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'rpcGetEmailByUsername').mockResolvedValue('super@system.local');
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: null,
      error: 'Failed to fetch: network unreachable',
      isNetworkError: true,
    });

    await expect(authService.login('superowner', 'any_password')).rejects.toThrow('NETWORK_ERROR');
  });

  // TEST 10: real invalid password response from GoTrue -> returns null (mapped to invalid credentials)
  it('TEST 10: Real invalid password response from GoTrue -> returns null', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'rpcGetEmailByUsername').mockResolvedValue('super@system.local');
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: null,
      error: 'Invalid login credentials',
      statusCode: 400,
      isInvalidCredentials: true,
    });

    const result = await authService.login('superowner', 'wrong_password');
    expect(result).toBeNull();
  });

  // TEST 11: BIN verification technical error -> does NOT consume BIN attempt and does NOT show password error
  it('TEST 11: BIN verification technical error -> throws BIN_VERIFICATION_UNAVAILABLE without consuming attempt', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'rpcGetEmailByUsername').mockResolvedValue('super@system.local');
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: MOCK_SIGN_IN_SESSION,
      error: null,
      statusCode: 200,
    });
    vi.spyOn(supabaseClient, 'rpcGetCurrentAdminProfile').mockResolvedValue({
      profile: MOCK_SUPER_ADMIN_PROFILE,
      error: null,
    });
    vi.spyOn(supabaseClient, 'rpcVerifyAdminBinWithTracking').mockResolvedValue({
      success: false,
      status: 'ERROR',
      is_locked: false,
      remaining_attempts: 3,
      failed_attempts: 0,
      isTechnicalError: true,
      error: 'Connection timeout with PostgreSQL',
    });

    await expect(authService.login('superowner', 'correct_password')).rejects.toThrow('SUPER_ADMIN_BIN_REQUIRED');

    await expect(authService.verifySuperAdminBin('123456')).rejects.toThrow('BIN_VERIFICATION_UNAVAILABLE');
    // Context preserved so user can retry entering BIN
    expect(authService.hasPendingSuperAdminContext()).toBe(true);
  });

  // TEST 12 & 13: Single login call even if called with all 3 parameters (legacy backward compatibility)
  it('TEST 12 & 13: Legacy 3-parameter call executes signInWithPassword exactly ONCE', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'rpcGetEmailByUsername').mockResolvedValue('super@system.local');
    const signInSpy = vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: MOCK_SIGN_IN_SESSION,
      error: null,
      statusCode: 200,
    });
    vi.spyOn(supabaseClient, 'rpcGetCurrentAdminProfile').mockResolvedValue({
      profile: MOCK_SUPER_ADMIN_PROFILE,
      error: null,
    });
    vi.spyOn(supabaseClient, 'rpcVerifyAdminBinWithTracking').mockResolvedValue(MOCK_BIN_SUCCESS);

    const session = await authService.login('superowner', 'correct_password', '123456');

    expect(signInSpy).toHaveBeenCalledTimes(1); // EXACTLY ONCE!
    expect(session).not.toBeNull();
  });

  // TEST 14: Successful Super Admin login -> final session persistence works exactly as before
  it('TEST 14: Successful Super Admin login -> final session persistence is saved in localStorage and memory', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'rpcGetEmailByUsername').mockResolvedValue('super@system.local');
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: MOCK_SIGN_IN_SESSION,
      error: null,
      statusCode: 200,
    });
    vi.spyOn(supabaseClient, 'rpcGetCurrentAdminProfile').mockResolvedValue({
      profile: MOCK_SUPER_ADMIN_PROFILE,
      error: null,
    });
    vi.spyOn(supabaseClient, 'rpcVerifyAdminBinWithTracking').mockResolvedValue(MOCK_BIN_SUCCESS);

    // Before BIN: localStorage should NOT have session
    await expect(authService.login('superowner', 'correct_password')).rejects.toThrow('SUPER_ADMIN_BIN_REQUIRED');
    expect(mockStorage.getItem('app_auth_session')).toBeNull();

    // After BIN: session is committed
    const finalSession = await authService.verifySuperAdminBin('123456');
    expect(finalSession).not.toBeNull();

    const stored = mockStorage.getItem('app_auth_session');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.role).toBe('SUPER_ADMIN');
    expect(parsed.email).toBe('super@system.local');
  });
});
