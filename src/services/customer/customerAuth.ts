import { createClient } from '@supabase/supabase-js';
import { config } from '../../config/env';

const customerStorageKey = 'chargerpoint_customer_auth_session';

export const customerAuth = createClient(config.supabaseUrl || 'http://127.0.0.1:54321', config.supabaseAnonKey || 'missing-public-key', {
  auth: {
    storageKey: customerStorageKey,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
});

export type CustomerAccountActionResult<T = Record<string, unknown>> = T & {
  ok?: boolean;
  error?: string;
};

export async function callCustomerAccount<T = Record<string, unknown>>(
  action: string,
  payload: Record<string, unknown> = {},
  explicitAccessToken?: string | null,
): Promise<{ data: CustomerAccountActionResult<T> | null; error: string | null }> {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return { data: null, error: 'SUPABASE_NOT_CONFIGURED' };
  }
  const { data: sessionData } = await customerAuth.auth.getSession();
  const accessToken = explicitAccessToken || sessionData.session?.access_token || config.supabaseAnonKey;
  try {
    const response = await fetch(config.supabaseUrl.replace(/\/+$/, '') + '/functions/v1/customer-account', {
      method: 'POST',
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, ...payload }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.ok !== true) {
      return { data: result, error: typeof result?.error === 'string' ? result.error : 'CUSTOMER_ACCOUNT_REQUEST_FAILED' };
    }
    return { data: result as CustomerAccountActionResult<T>, error: null };
  } catch {
    return { data: null, error: 'NETWORK_UNAVAILABLE' };
  }
}

export async function setCustomerSession(session: {
  access_token: string;
  refresh_token: string;
}): Promise<string | null> {
  const { data, error } = await customerAuth.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  return error ? error.message : data.session ? null : 'CUSTOMER_SESSION_UNAVAILABLE';
}

export async function startCustomerOAuth(
  provider: 'google' | 'apple' | 'facebook',
  token: string,
  mode: 'login' | 'activate',
): Promise<string | null> {
  if (typeof window === 'undefined') return 'BROWSER_REQUIRED';
  const redirectTo = new URL('/c/' + encodeURIComponent(token), window.location.origin);
  try { sessionStorage.setItem('cp_customer_oauth_mode:' + token, mode); } catch {}
  redirectTo.searchParams.set('customer_oauth', mode);
  const { error } = await customerAuth.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: redirectTo.toString(),
      queryParams: provider === 'google' ? { prompt: 'select_account' } : undefined,
    },
  });
  return error?.message ?? null;
}

export const CUSTOMER_TERMS_VERSION = '2026-10-18-v1';
