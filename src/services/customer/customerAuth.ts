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
  let accessToken = explicitAccessToken;
  if (!accessToken) {
    const { data: sessionData } = await customerAuth.auth.getSession();
    accessToken = sessionData.session?.access_token || config.supabaseAnonKey;
  }
  try {
    const readOnlyAction = ['entry', 'portal-data', 'customer-activity', 'verify-session', 'admin-list'].includes(action);
    const controller = readOnlyAction ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 10000) : null;
    let response: Response;
    try {
      response = await fetch(config.supabaseUrl.replace(/\/+$/, '') + '/functions/v1/customer-account', {
        method: 'POST',
        cache: 'no-store',
        headers: {
          apikey: config.supabaseAnonKey,
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action, ...payload }),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
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

export const CUSTOMER_TERMS_VERSION = '2026-10-18-v1';
