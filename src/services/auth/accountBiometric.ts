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
  if (!response.ok || !body?.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'BIOMETRIC_REQUEST_FAILED');
  return body;
};
export const isNativeBiometricAvailable = async () => {
  if (!Capacitor.isNativePlatform()) return false;
  try { return (await NativeBiometric.isAvailable()).available === true; } catch { return false; }
};
export async function enrollAccountBiometric(
  accessToken: string,
  deviceLabel = 'Android device',
  settingsReauth?: { password: string; bin?: string; emailOtp?: string },
) {
  if (!(await isNativeBiometricAvailable())) throw new Error('BIOMETRIC_NOT_AVAILABLE');
  const alias = randomAlias();
  try {
    const { challengeId, challenge } = await callEndpoint('enroll-challenge', settingsReauth ? { settingsReauth: true, ...settingsReauth } : {}, accessToken);
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
      const storageKey = 'cp_biometric_alias_' + result.accountType;
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
export async function loginWithAccountBiometric(accountType: 'customer' | 'admin', identifier: string, bin?: string) {
  if (!(await isNativeBiometricAvailable())) throw new Error('BIOMETRIC_NOT_AVAILABLE');
  const { challengeId, challenge, credentialId, requiresBin } = await callEndpoint('login-challenge', { accountType, identifier });
  if (requiresBin && !bin) throw new Error('BIN_REQUIRED');
  const en = promptLocale() === 'en';
  const { signature } = await NativeBiometric.signChallenge({
    alias: String(credentialId).replace(/-/g, ''), challenge,
    title: en ? 'Sign in with fingerprint' : 'تسجيل الدخول بالبصمة',
    subtitle: en ? 'Confirm your identity to open your account' : 'أكد هويتك لفتح حسابك',
    negativeButtonText: en ? 'Cancel' : 'إلغاء',
  });
  return await callEndpoint('login-verify', { challengeId, credentialId, signature, ...(bin ? { bin } : {}) });
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
