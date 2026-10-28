import { config } from '../../config/env';
import { customerAuth } from './customerAuth';

export type WalletServiceResult<T = Record<string, unknown>> = T & { ok?: boolean; error?: string };

export async function callWalletService<T = Record<string, unknown>>(
  action: string,
  payload: Record<string, unknown> = {},
  explicitAccessToken?: string | null,
): Promise<{ data: WalletServiceResult<T> | null; error: string | null }> {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return { data: null, error: 'SUPABASE_NOT_CONFIGURED' };
  }
  let accessToken = explicitAccessToken;
  if (!accessToken) {
    const { data } = await customerAuth.auth.getSession();
    accessToken = data.session?.access_token || config.supabaseAnonKey;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(config.supabaseUrl.replace(/\/+$/, '') + '/functions/v1/wallet-service', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, ...payload }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.ok !== true) {
      return { data: result, error: typeof result?.error === 'string' ? result.error : 'WALLET_SERVICE_REQUEST_FAILED' };
    }
    return { data: result as WalletServiceResult<T>, error: null };
  } catch {
    return { data: null, error: 'NETWORK_UNAVAILABLE' };
  } finally {
    clearTimeout(timeout);
  }
}
