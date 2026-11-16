import { describe, expect, it } from 'vitest';
import { canRegisterCustomerSession, type RegisteredCustomerSession } from '../../supabase/functions/_shared/customerSessionPolicy';

const now = Date.parse('2026-11-16T06:00:00.000Z');
const existing: RegisteredCustomerSession = {
  session_id: '11111111-1111-4111-8111-111111111111',
  auth_issued_at: 1794808800,
  expires_at: '2026-11-23T06:00:00.000Z',
  revoked_at: null,
};
const nextSessionId = '22222222-2222-4222-8222-222222222222';

describe('customer account session recovery', () => {
  it('allows a freshly password-authenticated replacement when JWT iat ties to the previous second', () => {
    expect(canRegisterCustomerSession(existing, nextSessionId, existing.auth_issued_at, true, now)).toBe(true);
  });

  it('does not allow a same-second replacement from an old or non-password-authenticated token', () => {
    expect(canRegisterCustomerSession(existing, nextSessionId, existing.auth_issued_at, false, now)).toBe(false);
  });

  it('rejects a token issued before the currently registered session', () => {
    expect(canRegisterCustomerSession(existing, nextSessionId, existing.auth_issued_at - 1, true, now)).toBe(false);
  });

  it('allows a strictly newer authenticated session to replace the previous session', () => {
    expect(canRegisterCustomerSession(existing, nextSessionId, existing.auth_issued_at + 1, false, now)).toBe(true);
  });

  it('accepts the same session only while its server-side binding is active', () => {
    expect(canRegisterCustomerSession(existing, existing.session_id, existing.auth_issued_at, false, now)).toBe(true);
    expect(canRegisterCustomerSession({ ...existing, expires_at: '2026-11-15T06:00:00.000Z' }, existing.session_id, existing.auth_issued_at, false, now)).toBe(false);
    expect(canRegisterCustomerSession({ ...existing, revoked_at: '2026-11-15T06:00:00.000Z' }, existing.session_id, existing.auth_issued_at, false, now)).toBe(false);
  });

  it('allows a first session and rejects malformed session claims', () => {
    expect(canRegisterCustomerSession(null, nextSessionId, 1794808800, false, now)).toBe(true);
    expect(canRegisterCustomerSession(null, 'not-a-session', 1794808800, true, now)).toBe(false);
    expect(canRegisterCustomerSession(null, nextSessionId, 0, true, now)).toBe(false);
  });
});
