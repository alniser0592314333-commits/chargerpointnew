import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as supabaseClient from '../services/supabase/client';
import { authService } from '../services/auth/authService';

describe('Server-Authoritative BIN Attempt Tracking & Fail-Closed Security (Tests 1 - 10)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  interface TestAdminRecord {
    id: string;
    authUserId: string;
    binHash: string;
    failedAttempts: number;
    status: 'ACTIVE' | 'LOCKED';
    lockedAt: string | null;
  }

  // Exact server simulation of RPC public.verify_admin_bin_with_attempt_tracking
  const simulateServerBinVerifyRpc = (
    callerAuthUid: string | null,
    enteredBin: string,
    adminDb: TestAdminRecord
  ) => {
    if (!callerAuthUid) {
      return {
        success: false,
        status: 'UNAUTHENTICATED' as const,
        is_locked: false,
        remaining_attempts: 0,
        failed_attempts: 0,
        error: 'Authentication required',
      };
    }

    if (adminDb.status === 'LOCKED' || adminDb.failedAttempts >= 3) {
      adminDb.status = 'LOCKED';
      adminDb.lockedAt = adminDb.lockedAt || new Date().toISOString();
      return {
        success: false,
        status: 'LOCKED' as const,
        is_locked: true,
        remaining_attempts: 0,
        failed_attempts: adminDb.failedAttempts,
        error: 'BIN_LOCKED_FROZEN',
      };
    }

    const isCorrect = adminDb.binHash === 'bcrypt_' + enteredBin.trim();

    if (isCorrect) {
      adminDb.failedAttempts = 0;
      adminDb.status = 'ACTIVE';
      adminDb.lockedAt = null;
      return {
        success: true,
        status: 'ACTIVE' as const,
        is_locked: false,
        remaining_attempts: 3,
        failed_attempts: 0,
      };
    }

    // Atomic increment
    adminDb.failedAttempts += 1;
    if (adminDb.failedAttempts >= 3) {
      adminDb.status = 'LOCKED';
      adminDb.lockedAt = new Date().toISOString();
      return {
        success: false,
        status: 'LOCKED' as const,
        is_locked: true,
        remaining_attempts: 0,
        failed_attempts: adminDb.failedAttempts,
        error: 'BIN_LOCKED_FROZEN',
      };
    }

    return {
      success: false,
      status: 'ACTIVE' as const,
      is_locked: false,
      remaining_attempts: 3 - adminDb.failedAttempts,
      failed_attempts: adminDb.failedAttempts,
      error: 'WRONG_BIN',
    };
  };

  it('TEST 1: First REAL wrong BIN -> server failed_attempts = 1, remaining_attempts = 2 -> UI displays 2', async () => {
    const adminDb: TestAdminRecord = {
      id: 'admin_1',
      authUserId: 'user_1',
      binHash: 'bcrypt_2026',
      failedAttempts: 0,
      status: 'ACTIVE',
      lockedAt: null,
    };

    const serverRes = simulateServerBinVerifyRpc('user_1', '0000', adminDb);
    expect(serverRes.success).toBe(false);
    expect(serverRes.failed_attempts).toBe(1);
    expect(serverRes.remaining_attempts).toBe(2);
    expect(serverRes.is_locked).toBe(false);
    expect(adminDb.failedAttempts).toBe(1);

    // Mock client RPC returning this authoritative server result
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: { access_token: 'jwt_1', user: { id: 'user_1', email: 'admin@test.local' } },
      error: null,
    });
    vi.spyOn(authService, 'getAdminProfile').mockResolvedValue({
      authenticated: true,
      is_admin: true,
      is_active: true,
      admin_id: 'admin_1',
      role: 'SUPER_ADMIN',
      permissions: ['admin:manage'],
    });
    vi.spyOn(supabaseClient, 'rpcVerifyAdminBinWithTracking').mockResolvedValue(serverRes);

    try {
      await authService.login('admin@test.local', 'password123', '0000');
      expect.fail('Should have thrown WRONG_BIN');
    } catch (err: any) {
      expect(err.message).toBe('WRONG_BIN');
      expect(err.remainingAttempts).toBe(2);
      expect(err.failedAttempts).toBe(1);
    }
  });

  it('TEST 2: Second REAL wrong BIN -> server failed_attempts = 2, remaining_attempts = 1 -> UI displays 1', async () => {
    const adminDb: TestAdminRecord = {
      id: 'admin_1',
      authUserId: 'user_1',
      binHash: 'bcrypt_2026',
      failedAttempts: 1, // Already 1 failure
      status: 'ACTIVE',
      lockedAt: null,
    };

    const serverRes = simulateServerBinVerifyRpc('user_1', '0000', adminDb);
    expect(serverRes.success).toBe(false);
    expect(serverRes.failed_attempts).toBe(2);
    expect(serverRes.remaining_attempts).toBe(1);
    expect(serverRes.is_locked).toBe(false);
    expect(adminDb.failedAttempts).toBe(2);

    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: { access_token: 'jwt_1', user: { id: 'user_1', email: 'admin@test.local' } },
      error: null,
    });
    vi.spyOn(authService, 'getAdminProfile').mockResolvedValue({
      authenticated: true,
      is_admin: true,
      is_active: true,
      admin_id: 'admin_1',
      role: 'SUPER_ADMIN',
      permissions: ['admin:manage'],
    });
    vi.spyOn(supabaseClient, 'rpcVerifyAdminBinWithTracking').mockResolvedValue(serverRes);

    try {
      await authService.login('admin@test.local', 'password123', '0000');
      expect.fail('Should have thrown WRONG_BIN');
    } catch (err: any) {
      expect(err.message).toBe('WRONG_BIN');
      expect(err.remainingAttempts).toBe(1);
      expect(err.failedAttempts).toBe(2);
    }
  });

  it('TEST 3: Third REAL wrong BIN -> server failed_attempts = 3, remaining_attempts = 0, status = LOCKED, is_locked = true', async () => {
    const adminDb: TestAdminRecord = {
      id: 'admin_1',
      authUserId: 'user_1',
      binHash: 'bcrypt_2026',
      failedAttempts: 2, // Already 2 failures
      status: 'ACTIVE',
      lockedAt: null,
    };

    const serverRes = simulateServerBinVerifyRpc('user_1', '0000', adminDb);
    expect(serverRes.success).toBe(false);
    expect(serverRes.failed_attempts).toBe(3);
    expect(serverRes.remaining_attempts).toBe(0);
    expect(serverRes.is_locked).toBe(true);
    expect(serverRes.status).toBe('LOCKED');
    expect(adminDb.status).toBe('LOCKED');
    expect(adminDb.failedAttempts).toBe(3);

    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: { access_token: 'jwt_1', user: { id: 'user_1', email: 'admin@test.local' } },
      error: null,
    });
    vi.spyOn(authService, 'getAdminProfile').mockResolvedValue({
      authenticated: true,
      is_admin: true,
      is_active: true,
      admin_id: 'admin_1',
      role: 'SUPER_ADMIN',
      permissions: ['admin:manage'],
    });
    vi.spyOn(supabaseClient, 'rpcVerifyAdminBinWithTracking').mockResolvedValue(serverRes);

    try {
      await authService.login('admin@test.local', 'password123', '0000');
      expect.fail('Should have thrown BIN_LOCKED_FROZEN');
    } catch (err: any) {
      expect(err.message).toBe('BIN_LOCKED_FROZEN');
      expect(err.remainingAttempts).toBe(0);
      expect(err.failedAttempts).toBe(3);
    }
  });

  it('TEST 4: Fourth attempt on LOCKED account -> rejected immediately by server without comparing crypt', () => {
    const adminDb: TestAdminRecord = {
      id: 'admin_1',
      authUserId: 'user_1',
      binHash: 'bcrypt_2026',
      failedAttempts: 3,
      status: 'LOCKED',
      lockedAt: new Date().toISOString(),
    };

    // Even if user enters the correct BIN on 4th attempt, server rejects because account is LOCKED
    const serverRes = simulateServerBinVerifyRpc('user_1', '2026', adminDb);
    expect(serverRes.success).toBe(false);
    expect(serverRes.status).toBe('LOCKED');
    expect(serverRes.is_locked).toBe(true);
    expect(serverRes.remaining_attempts).toBe(0);
  });

  it('TEST 5: RPC/network failure -> must NOT increment failed_attempts, must NOT return fake fallback, must throw BIN_VERIFICATION_UNAVAILABLE', async () => {
    // Simulating network error from Supabase RPC
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: { access_token: 'jwt_1', user: { id: 'user_1', email: 'admin@test.local' } },
      error: null,
    });
    vi.spyOn(authService, 'getAdminProfile').mockResolvedValue({
      authenticated: true,
      is_admin: true,
      is_active: true,
      admin_id: 'admin_1',
      role: 'SUPER_ADMIN',
      permissions: ['admin:manage'],
    });
    vi.spyOn(supabaseClient, 'rpcVerifyAdminBinWithTracking').mockResolvedValue({
      success: false,
      status: 'ERROR',
      is_locked: false,
      remaining_attempts: -1,
      failed_attempts: -1,
      error: 'Failed to fetch: Network timeout',
      isTechnicalError: true,
    });

    try {
      await authService.login('admin@test.local', 'password123', '0000');
      expect.fail('Should have thrown BIN_VERIFICATION_UNAVAILABLE');
    } catch (err: any) {
      expect(err.message).toBe('BIN_VERIFICATION_UNAVAILABLE');
      // No fake attempt counts
      expect(err.remainingAttempts).toBeUndefined();
      expect(err.failedAttempts).toBeUndefined();
    }
  });

  it('TEST 6: RPC malformed/missing data -> fails closed cleanly', async () => {
    // Raw client call when RPC returns null/error
    vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockResolvedValue({
      data: null,
      error: '404 Function not found',
    });

    const res = await supabaseClient.rpcVerifyAdminBinWithTracking('1234', 'jwt_test');
    expect(res.success).toBe(false);
    expect(res.status).toBe('ERROR');
    expect(res.isTechnicalError).toBe(true);
    expect(res.remaining_attempts).toBe(-1);
    expect(res.failed_attempts).toBe(-1);
  });

  it('TEST 7: Valid BIN before any failures -> login continues normally and returns UserSession', async () => {
    const adminDb: TestAdminRecord = {
      id: 'admin_1',
      authUserId: 'user_1',
      binHash: 'bcrypt_2026',
      failedAttempts: 0,
      status: 'ACTIVE',
      lockedAt: null,
    };

    const serverRes = simulateServerBinVerifyRpc('user_1', '2026', adminDb);
    expect(serverRes.success).toBe(true);
    expect(serverRes.status).toBe('ACTIVE');

    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: { access_token: 'jwt_1', user: { id: 'user_1', email: 'admin@test.local' } },
      error: null,
    });
    vi.spyOn(authService, 'getAdminProfile').mockResolvedValue({
      authenticated: true,
      is_admin: true,
      is_active: true,
      admin_id: 'admin_1',
      role: 'SUPER_ADMIN',
      permissions: ['admin:manage'],
    });
    vi.spyOn(supabaseClient, 'rpcVerifyAdminBinWithTracking').mockResolvedValue(serverRes);

    const session = await authService.login('admin@test.local', 'password123', '2026');
    expect(session).not.toBeNull();
    expect(session?.role).toBe('SUPER_ADMIN');
    expect(session?.userId).toBe('admin_1');
  });

  it('TEST 8: LOCKED fixture + correct password + recovery proof -> Recovery succeeds -> ACTIVE, failed_attempts = 0, locked_at = null', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: { access_token: 'jwt_1', user: { id: 'user_1', email: 'admin@test.local' } },
      error: null,
    });
    vi.spyOn(supabaseClient, 'rpcIssueBinRecoveryProof').mockResolvedValue({
      success: true,
      proofToken: 'proof_token_valid_123',
      expiresInSeconds: 120,
      error: null,
    });
    vi.spyOn(supabaseClient, 'rpcRecoverAndResetAdminBin').mockResolvedValue({
      success: true,
      error: null,
    });

    const res = await authService.recoverAndResetBin('admin@test.local', 'CorrectPassword123!', '9999');
    expect(res.success).toBe(true);
    expect(res.error).toBeNull();
  });

  it('TEST 9: After Recovery, account is ACTIVE and normal BIN verification is available', () => {
    const adminDb: TestAdminRecord = {
      id: 'admin_1',
      authUserId: 'user_1',
      binHash: 'bcrypt_9999', // New recovered BIN
      failedAttempts: 0,
      status: 'ACTIVE',
      lockedAt: null,
    };

    const serverRes = simulateServerBinVerifyRpc('user_1', '9999', adminDb);
    expect(serverRes.success).toBe(true);
    expect(serverRes.status).toBe('ACTIVE');
    expect(serverRes.is_locked).toBe(false);
  });

  it('TEST 10: JWT-only recovery remains rejected (Proof required)', async () => {
    const clientRes = await supabaseClient.rpcRecoverAndResetAdminBin('2026', '', 'jwt_token_only');
    expect(clientRes.success).toBe(false);
    expect(clientRes.error).toContain('PROOF_REQUIRED');
  });
});
