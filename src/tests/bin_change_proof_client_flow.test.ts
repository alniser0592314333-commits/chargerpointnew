import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authService } from '../services/auth/authService';
import * as supabaseClient from '../services/supabase/client';

describe('BIN change proof client flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('issues a proof only after re-authenticating the same currently signed-in admin and verifying the current BIN', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(authService, 'getSupabaseAuthSession').mockResolvedValue({
      access_token: 'existing-session-token',
      user: { id: 'user-1' },
    } as any);
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: {
        access_token: 'temporary-reauth-token',
        user: { id: 'user-1', email: 'admin@example.test' },
      },
      error: null,
    } as any);
    vi.spyOn(supabaseClient, 'rpcIssueBinChangeProof').mockResolvedValue({
      success: true,
      proofToken: 'p'.repeat(64),
      expiresInSeconds: 120,
      error: null,
    });

    const result = await authService.verifyCurrentPassword(
      'admin@example.test',
      'correct-password',
      '1234'
    );

    expect(result.success).toBe(true);
    expect(result.token).toBe('p'.repeat(64));
    expect(supabaseClient.rpcIssueBinChangeProof).toHaveBeenCalledWith(
      '1234',
      'temporary-reauth-token'
    );
  });

  it('rejects credentials for a different admin and never requests a proof for that identity', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(authService, 'getSupabaseAuthSession').mockResolvedValue({
      access_token: 'existing-session-token',
      user: { id: 'user-1' },
    } as any);
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: {
        access_token: 'other-admin-token',
        user: { id: 'user-2', email: 'other@example.test' },
      },
      error: null,
    } as any);
    const proofSpy = vi.spyOn(supabaseClient, 'rpcIssueBinChangeProof');

    const result = await authService.verifyCurrentPassword(
      'other@example.test',
      'correct-password',
      '1234'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('currently signed-in admin');
    expect(proofSpy).not.toHaveBeenCalled();
  });

  it('preserves authoritative remaining-attempt details when the current BIN is wrong', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(authService, 'getSupabaseAuthSession').mockResolvedValue({
      access_token: 'existing-session-token',
      user: { id: 'user-1' },
    } as any);
    vi.spyOn(supabaseClient, 'supabaseSignInWithPassword').mockResolvedValue({
      session: {
        access_token: 'temporary-reauth-token',
        user: { id: 'user-1', email: 'admin@example.test' },
      },
      error: null,
    } as any);
    vi.spyOn(supabaseClient, 'rpcIssueBinChangeProof').mockResolvedValue({
      success: false,
      error: 'WRONG_BIN',
      remainingAttempts: 2,
      failedAttempts: 1,
      status: 'ACTIVE',
    } as any);

    const result = await authService.verifyCurrentPassword(
      'admin@example.test',
      'correct-password',
      '0000'
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('WRONG_BIN');
    expect(result.remainingAttempts).toBe(2);
    expect(result.failedAttempts).toBe(1);
  });

  it('submits the single-use proof with the existing same-admin session to change the BIN', async () => {
    vi.spyOn(authService, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseClient, 'getSupabaseAuthToken').mockReturnValue('existing-session-token');
    vi.spyOn(supabaseClient, 'rpcSetAdminBin').mockResolvedValue({
      success: true,
      error: null,
    });

    const result = await authService.changeAdminBin('5678', 'p'.repeat(64));

    expect(result).toEqual({ success: true, error: null });
    expect(supabaseClient.rpcSetAdminBin).toHaveBeenCalledWith(
      '5678',
      'p'.repeat(64),
      'existing-session-token'
    );
  });
});
