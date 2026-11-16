export type RegisteredCustomerSession = {
  session_id: string;
  auth_issued_at: number;
  expires_at: string;
  revoked_at: string | null;
};

/**
 * Decide whether a Supabase-authenticated customer session may occupy the
 * customer's single active-session slot.
 *
 * A password login is verified by signInWithPassword inside the Edge Function.
 * Supabase JWT iat has second-level precision, so a fresh login can legitimately
 * tie the previous iat. Only that fresh-password path may replace on a tie.
 * OAuth/register-session callers still need a strictly newer iat.
 */
export function canRegisterCustomerSession(
  existing: RegisteredCustomerSession | null,
  nextSessionId: string,
  nextIssuedAt: number,
  allowFreshPasswordSession = false,
  nowMs = Date.now(),
): boolean {
  if (!/^[0-9a-f-]{36}$/i.test(nextSessionId) ||
      !Number.isSafeInteger(nextIssuedAt) || nextIssuedAt <= 0) return false;

  if (!existing) return true;

  if (existing.session_id === nextSessionId) {
    const expiresAt = Date.parse(existing.expires_at);
    return existing.revoked_at === null && Number.isFinite(expiresAt) && expiresAt > nowMs;
  }

  const previousIssuedAt = Number(existing.auth_issued_at);
  if (!Number.isSafeInteger(previousIssuedAt) || previousIssuedAt <= 0) return false;
  if (nextIssuedAt < previousIssuedAt) return false;
  if (nextIssuedAt === previousIssuedAt && !allowFreshPasswordSession) return false;

  return true;
}
