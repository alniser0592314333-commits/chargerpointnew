import { Capacitor, registerPlugin } from '@capacitor/core';

export interface AccountBiometricNativePlugin {
  isAvailable(): Promise<{ available: boolean }>;
  createKey(options: { alias: string }): Promise<{ publicKey: string }>;
  signChallenge(options: { alias: string; challenge: string; title: string; subtitle: string; negativeButtonText: string }): Promise<{ signature: string }>;
  deleteKey(options: { alias: string }): Promise<{ deleted: boolean }>;
}
const NativeBiometric = registerPlugin<AccountBiometricNativePlugin>('AccountBiometric');
const b64url = (value: Uint8Array) => {
  let raw = '';
  value.forEach((b) => { raw += String.fromCharCode(b); });
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};
const promptLocale = () => {
  try {
    const value = document.documentElement.lang || localStorage.getItem('sys_locale') || 'ar';
    return value.toLowerCase().startsWith('en') ? 'en' : 'ar';
  } catch { return 'ar'; }
};
const randomAlias = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};
const callEndpoint = async (action: string, payload: Record<string, unknown> = {}, accessToken?: string) => {
  const { config } = await import('../../config/env');
  if (!config.supabaseUrl || !config.supabaseAnonKey) throw new Error('BIOMETRIC_SERVICE_UNAVAILABLE');
  const token = accessToken || config.supabaseAnonKey;
  const response = await fetch(config.supabaseUrl.replace(/\/+$/, '') + '/functions/v1/account-biometric', {
    method: 'POST', cache: 'no-store',
    headers: { apikey: config.supabaseAnonKey, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    const error = new Error(typeof body?.error === 'string' ? body.error : 'BIOMETRIC_REQUEST_FAILED') as Error & { details?: Record<string, unknown> };
    error.details = body && typeof body === 'object' ? body : undefined;
    throw error;
  }
  return body;
};
export const isNativeBiometricAvailable = async () => {
  if (!Capacitor.isNativePlatform()) return false;
  // Android may briefly report the biometric bridge as unavailable while the
  // Activity is returning from logout / a previous prompt. A single failed
  // capability probe must not suppress the first actual fingerprint prompt.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await NativeBiometric.isAvailable();
      if (result.available === true) return true;
    } catch {
      // Retry one transient bridge/activity failure; do not loop indefinitely.
    }
    if (attempt === 0) await wait(250);
  }
  return false;
};
export async function enrollAccountBiometric(
  accessToken: string,
  deviceLabel = 'Android device',
  settingsReauth?: { password: string; bin?: string },
) {
  if (!(await isNativeBiometricAvailable())) throw new Error('BIOMETRIC_NOT_AVAILABLE');
  const alias = randomAlias();
  try {
    const { challengeId, challenge, accountType } = await callEndpoint('enroll-challenge', settingsReauth ? { settingsReauth: true, ...settingsReauth } : {}, accessToken);
    const { publicKey } = await NativeBiometric.createKey({ alias });
    const en = promptLocale() === 'en';
    const { signature } = await NativeBiometric.signChallenge({
      alias, challenge,
      title: en ? 'Enable fingerprint sign-in' : 'تفعيل الدخول بالبصمة',
      subtitle: en ? 'Confirm your identity to enable secure sign-in' : 'أكد هويتك لتفعيل الدخول الآمن',
      negativeButtonText: en ? 'Cancel' : 'إلغاء',
    });
    const result = await callEndpoint('enroll-verify', { challengeId, publicKey, signature, credentialId: alias, deviceLabel }, accessToken);
    // Re-enrollment replaces the server-side credential. Remove the previous local
    // private key only after the new credential has been accepted by the server.
    try {
      const enrolledAccountType = accountType === 'customer' || accountType === 'admin' ? accountType : null;
      if (!enrolledAccountType) throw new Error('BIOMETRIC_ACCOUNT_TYPE_UNAVAILABLE');
      const storageKey = 'cp_biometric_alias_' + enrolledAccountType;
      const previousAlias = localStorage.getItem(storageKey);
      if (previousAlias && previousAlias !== alias && /^[a-f0-9]{32}$/.test(previousAlias)) {
        await NativeBiometric.deleteKey({ alias: previousAlias }).catch(() => undefined);
      }
      localStorage.setItem(storageKey, alias);
    } catch {}
    return result;
  } catch (error) {
    await NativeBiometric.deleteKey({ alias }).catch(() => undefined);
    throw error;
  }
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestLoginChallenge(accountType: 'customer' | 'admin', identifier: string, credentialId?: string) {
  // A short-lived network/Edge cold-start failure must not force the customer to
  // press the fingerprint button a second time. Retry only transient failures
  // before the OS biometric dialog is opened; never retry credential/identity errors.
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await callEndpoint('login-challenge', { accountType, ...(identifier ? { identifier } : {}), ...(credentialId ? { credentialId } : {}) });
    } catch (error) {
      lastError = error;
      const code = error instanceof Error ? error.message : '';
      const transient = code === 'BIOMETRIC_REQUEST_FAILED'
        || code === 'CHALLENGE_UNAVAILABLE'
        || code === 'BIOMETRIC_SERVICE_UNAVAILABLE'
        || (error instanceof TypeError);
      if (!transient || attempt === 1) throw error;
      await wait(350);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('BIOMETRIC_REQUEST_FAILED');
}

export async function loginWithAccountBiometric(accountType: 'customer' | 'admin', identifier?: string) {
  if (!(await isNativeBiometricAvailable())) throw new Error('BIOMETRIC_NOT_AVAILABLE');
  const normalizedIdentifier = identifier?.trim() || '';
  let localKeyAlias = '';
  try {
    localKeyAlias = localStorage.getItem('cp_biometric_alias_' + accountType) || '';
    // Migrate the alias saved by the earlier enrollment bug, which used an
    // undefined account type even though the server credential was valid.
    if (!localKeyAlias && accountType === 'admin') {
      const legacyAlias = localStorage.getItem('cp_biometric_alias_undefined') || '';
      if (/^[a-f0-9]{32}$/.test(legacyAlias)) {
        localKeyAlias = legacyAlias;
        localStorage.setItem('cp_biometric_alias_admin', legacyAlias);
        localStorage.removeItem('cp_biometric_alias_undefined');
      }
    }
  } catch {}
  if (!normalizedIdentifier && !/^[a-f0-9]{32}$/.test(localKeyAlias)) throw new Error('BIOMETRIC_IDENTIFIER_REQUIRED');
  const { challengeId, challenge, credentialId } = await requestLoginChallenge(accountType, normalizedIdentifier, localKeyAlias || undefined);
  // The device-bound strong-biometric signature is the login factor. The BIN
  // remains available for separate sensitive actions, not for this login flow.
  const en = promptLocale() === 'en';
  const { signature } = await NativeBiometric.signChallenge({
    alias: String(credentialId).replace(/-/g, ''), challenge,
    title: en ? 'Sign in with fingerprint' : 'تسجيل الدخول بالبصمة',
    subtitle: en ? 'Confirm your identity to open your account' : 'أكد هويتك لفتح حسابك',
    negativeButtonText: en ? 'Cancel' : 'إلغاء',
  });
  return await callEndpoint('login-verify', { challengeId, credentialId, signature });
}
export async function revokeAccountBiometric(accessToken: string) {
  const result = await callEndpoint('revoke', {}, accessToken);
  try {
    for (const type of ['customer', 'admin']) {
      const alias = localStorage.getItem('cp_biometric_alias_' + type);
      if (alias && /^[a-f0-9]{32}$/.test(alias) && Capacitor.isNativePlatform()) {
        await NativeBiometric.deleteKey({ alias }).catch(() => undefined);
      }
      localStorage.removeItem('cp_biometric_alias_' + type);
    }
  } catch {}
  return result;
}

export async function getAccountBiometricStatus(accessToken: string): Promise<{ enrolled: boolean; credentialId?: string | null; keyAlias?: string | null }> {
  const result = await callEndpoint('status', {}, accessToken);
  return { enrolled: result.enrolled === true, credentialId: typeof result.credentialId === 'string' ? result.credentialId : null, keyAlias: typeof result.keyAlias === 'string' ? result.keyAlias : null };
}

export async function authorizeJawwalPaymentBiometric(accessToken: string): Promise<{ authorizationId: string; expiresAt: string }> {
  if (!(await isNativeBiometricAvailable())) throw new Error('BIOMETRIC_NOT_AVAILABLE');
  const alias = localStorage.getItem('cp_biometric_alias_customer') || '';
  if (!/^[a-f0-9]{32}$/.test(alias)) throw new Error('BIOMETRIC_NOT_ENROLLED');
  let challenge: Record<string, unknown>;
  try {
    challenge = await callEndpoint('jawwal-payment-challenge', {}, accessToken);
  } catch (error) {
    const details = error && typeof error === 'object' && 'details' in error
      ? (error as Error & { details?: Record<string, unknown> }).details : undefined;
    if (error instanceof Error && error.message === 'JAWJAL_BIOMETRIC_LOCKED' && typeof details?.lockedUntil === 'string') {
      throw new Error('JAWJAL_BIOMETRIC_LOCKED:' + details.lockedUntil);
    }
    throw error;
  }
  const en = promptLocale() === 'en';
  let signed: { signature: string };
  try {
    signed = await NativeBiometric.signChallenge({
      alias: String(challenge.credentialId).replace(/-/g, ''),
      challenge: String(challenge.challenge),
      title: en ? 'Authorize Jawwal Pay' : 'تأكيد الدفع بالبصمة',
      subtitle: en ? 'Verify your identity to submit this payment' : 'أكد هويتك بالبصمة لإرسال الدفعة',
      negativeButtonText: en ? 'Cancel' : 'إلغاء',
    });
  } catch (promptError) {
    const promptCode = promptError instanceof Error ? promptError.message : 'BIOMETRIC_PROMPT_FAILED';
    // Once a server challenge exists, every failed/cancelled prompt is reported
    // to the server. If reporting fails, fail closed and never submit a payment.
    try {
      const failed = await callEndpoint('jawwal-payment-failure', {
        challengeId: challenge.challengeId,
        credentialId: challenge.credentialId,
        reason: promptCode.slice(0, 80),
      }, accessToken);
      if (typeof failed.lockedUntil === 'string' && new Date(failed.lockedUntil).getTime() > Date.now()) {
        throw new Error('JAWJAL_BIOMETRIC_LOCKED:' + failed.lockedUntil);
      }
    } catch (reportError) {
      if (reportError instanceof Error && reportError.message.startsWith('JAWJAL_BIOMETRIC_LOCKED:')) throw reportError;
      throw new Error('BIOMETRIC_FAILURE_COULD_NOT_BE_RECORDED');
    }
    if (promptCode === 'BIOMETRIC_CANCELLED') throw new Error('BIOMETRIC_CANCELLED');
    throw new Error('BIOMETRIC_PROMPT_FAILED');
  }
  const verified = await callEndpoint('jawwal-payment-verify', {
    challengeId: challenge.challengeId,
    credentialId: challenge.credentialId,
    signature: signed.signature,
  }, accessToken);
  return { authorizationId: String(verified.authorizationId), expiresAt: String(verified.expiresAt) };
}
