import { Capacitor, registerPlugin } from '@capacitor/core';

export interface AccountBiometricNativePlugin {
  isAvailable(): Promise<{ available: boolean }>;
  createKey(options: { alias: string }): Promise<{ publicKey: string }>;
  signChallenge(options: { alias: string; challenge: string; title: string; subtitle: string }): Promise<{ signature: string }>;
  deleteKey(options: { alias: string }): Promise<{ deleted: boolean }>;
}
const NativeBiometric = registerPlugin<AccountBiometricNativePlugin>('AccountBiometric');
const b64url = (value: Uint8Array) => {
  let raw = '';
  value.forEach((b) => { raw += String.fromCharCode(b); });
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
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
export async function enrollAccountBiometric(accessToken: string, deviceLabel = 'Android device') {
  if (!(await isNativeBiometricAvailable())) throw new Error('BIOMETRIC_NOT_AVAILABLE');
  const alias = randomAlias();
  const { challengeId, challenge } = await callEndpoint('enroll-challenge', {}, accessToken);
  const { publicKey } = await NativeBiometric.createKey({ alias });
  const { signature } = await NativeBiometric.signChallenge({ alias, challenge, title: 'تفعيل الدخول بالبصمة', subtitle: 'أكد هويتك لتفعيل الدخول الآمن' });
  const result = await callEndpoint('enroll-verify', { challengeId, publicKey, signature, credentialId: alias, deviceLabel }, accessToken);
  try { localStorage.setItem('cp_biometric_alias_' + result.accountType, alias); } catch {}
  return result;
}
export async function loginWithAccountBiometric(accountType: 'customer' | 'admin', identifier: string, bin?: string) {
  if (!(await isNativeBiometricAvailable())) throw new Error('BIOMETRIC_NOT_AVAILABLE');
  const { challengeId, challenge, credentialId, requiresBin } = await callEndpoint('login-challenge', { accountType, identifier });
  if (requiresBin && !bin) throw new Error('BIN_REQUIRED');
  const { signature } = await NativeBiometric.signChallenge({ alias: credentialId, challenge, title: 'تسجيل الدخول بالبصمة', subtitle: 'أكد هويتك لفتح حسابك' });
  return await callEndpoint('login-verify', { challengeId, credentialId, signature, ...(bin ? { bin } : {}) });
}
export async function revokeAccountBiometric(accessToken: string) {
  const result = await callEndpoint('revoke', {}, accessToken);
  try { localStorage.removeItem('cp_biometric_alias_customer'); localStorage.removeItem('cp_biometric_alias_admin'); } catch {}
  return result;
}

export async function getAccountBiometricStatus(accessToken: string): Promise<{ enrolled: boolean; credentialId?: string | null }> {
  const result = await callEndpoint('status', {}, accessToken);
  return { enrolled: result.enrolled === true, credentialId: typeof result.credentialId === 'string' ? result.credentialId : null };
}
