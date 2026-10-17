/**
 * Supabase Client & Connection Abstraction Layer
 * Centralized Supabase configuration ready for authentication and central database storage.
 * No service-role key on frontend. Uses anonymous/public key and environment variables.
 *
 * Phase 6.5.2B:
 * Persistent Random Public Capability Handle (Option C) RPC integration.
 * - Idempotent get_or_create_customer_qr
 * - Explicit rotate_customer_qr
 * - get_or_create_order_qr
 * - public_resolve_customer_qr by public_token
 */

import { config } from '../../config/env';

export interface SupabaseClientStub {
  isConfigured: boolean;
  url: string;
  status: 'disconnected' | 'connected' | 'error';
}

export const getSupabaseStatus = (): SupabaseClientStub => {
  const isConfigured = Boolean(config.supabaseUrl && config.supabaseAnonKey);
  return {
    isConfigured,
    url: config.supabaseUrl || 'Not configured',
    status: isConfigured ? 'connected' : 'disconnected',
  };
};


/**
 * Security-sensitive mutations are never allowed to start from an offline browser state.
 * This is only an early client-side barrier; the authoritative server RPC remains the
 * final authorization/mutation gate. No sensitive admin/settings mutation is queued.
 */
export const assertOnlineForSensitiveOperation = (operationLabel = 'This operation'): void => {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error(`ONLINE_REQUIRED: ${operationLabel} requires an active internet connection and cannot run offline.`);
  }
};
export interface PublicCustomerQrRpcResult {
  customer_name: string;
  customer_code: string;
}

export interface PublicQrPaymentSubmissionRpcResult {
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  amount_minor: number | string | null;
  payment_method: string;
  created_at: string;
  reviewed_at?: string | null;
  balance_before_minor?: number | string | null;
  balance_after_minor?: number | string | null;
}

export interface PublicOrderQrRpcResult {
  order_id: string;
  order_number: number;
  customer_name: string;
  customer_code?: string;
  status: string;
  created_at: string;
  items_count: number;
  order_total_minor?: number;
  order_due_minor?: number;
  customer_has_positive_credit?: boolean | null;
  order_qr_submission_limit_reached?: boolean | null;
  items?: Array<{
    name: string;
    name_ar?: string;
    name_en?: string;
    device_type_id?: string;
    status: string;
    operational_status?: string;
    payment_status?: string;
    has_charger: boolean;
    quantity?: number;
    unit_price_minor?: number;
    total_price_minor?: number;
    paid_minor?: number;
    due_minor?: number;
    charger_fee_exempt?: boolean;
  }>;
}

let activeAuthToken: string | null = null;

export const setSupabaseAuthToken = (token: string | null) => {
  activeAuthToken = token && token.trim() ? token.trim() : null;
};

export const resolveAuthBearerToken = (customAuthToken?: string): string | null => {
  if (customAuthToken && customAuthToken.trim()) {
    return customAuthToken.trim();
  }
  if (activeAuthToken && activeAuthToken.trim()) {
    return activeAuthToken.trim();
  }
  const stored = getStoredSupabaseAuthSession();
  if (stored?.access_token && stored.access_token.trim()) {
    activeAuthToken = stored.access_token.trim();
    return activeAuthToken;
  }
  return null;
};

export const getSupabaseAuthToken = (): string | null => {
  return resolveAuthBearerToken();
};

export interface SupabaseAuthSession {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  user: {
    id: string;
    email?: string;
    email_confirmed_at?: string;
    user_metadata?: Record<string, any>;
  };
}

const SUPABASE_AUTH_STORAGE_KEY = 'supabase_auth_session';

const getLocalStorage = () => {
  if (typeof localStorage !== 'undefined') return localStorage;
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  if (typeof globalThis !== 'undefined' && (globalThis as any).localStorage) return (globalThis as any).localStorage;
  return null;
};

export const saveStoredSupabaseAuthSession = (session: SupabaseAuthSession) => {
  const storage = getLocalStorage();
  if (storage) {
    try {
      storage.setItem(SUPABASE_AUTH_STORAGE_KEY, JSON.stringify(session));
    } catch {}
  }
};

export const getStoredSupabaseAuthSession = (): SupabaseAuthSession | null => {
  const storage = getLocalStorage();
  if (storage) {
    try {
      const stored = storage.getItem(SUPABASE_AUTH_STORAGE_KEY);
      if (stored) {
        return JSON.parse(stored) as SupabaseAuthSession;
      }
    } catch {}
  }
  return null;
};

export const clearStoredSupabaseAuthSession = () => {
  const storage = getLocalStorage();
  if (storage) {
    try {
      storage.removeItem(SUPABASE_AUTH_STORAGE_KEY);
    } catch {}
  }
  setSupabaseAuthToken(null);
};

/**
 * Parses and extracts Supabase Auth callback from window.location.hash or search parameters.
 * Automatically clears sensitive token fragments from the address bar via replaceState.
 */
export function parseSupabaseAuthCallbackFromUrl(): {
  session: SupabaseAuthSession | null;
  error: string | null;
  type?: string | null;
} {
  if (typeof window === 'undefined' || !window.location) {
    return { session: null, error: null };
  }

  const hash = window.location.hash || '';
  const search = window.location.search || '';

  // 1. Check for errors in hash or search
  let errorParam: string | null = null;
  let errorDescParam: string | null = null;

  if (hash.includes('error=')) {
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    errorParam = params.get('error');
    errorDescParam = params.get('error_description');
  } else if (search.includes('error=')) {
    const params = new URLSearchParams(search);
    errorParam = params.get('error');
    errorDescParam = params.get('error_description');
  }

  if (errorParam || errorDescParam) {
    if (window.history?.replaceState) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
    return {
      session: null,
      error: errorDescParam || errorParam || 'Authentication failed',
    };
  }

  // 2. Check for access_token in hash (e.g. #access_token=...&refresh_token=...&type=signup)
  if (hash.includes('access_token=')) {
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token') || undefined;
    const tokenType = params.get('token_type') || 'bearer';
    const expiresInStr = params.get('expires_in');
    const type = params.get('type') || undefined;

    if (accessToken) {
      let userId = '';
      let userEmail = '';
      let userMeta: Record<string, any> = {};

      try {
        const parts = accessToken.split('.');
        if (parts.length === 3) {
          try {
            const payload = JSON.parse(atob(parts[1]));
            userId = payload.sub || payload.id || '';
            userEmail = payload.email || '';
            userMeta = payload.user_metadata || {};
          } catch (e) {
            console.warn('[AUTH_DEBUG] JWT parsing failed, skipping payload extraction', e);
          }
        }
      } catch (e) {
        console.warn('[AUTH_DEBUG] JWT parsing structure error', e);
      }

      const session: SupabaseAuthSession = {
        access_token: accessToken,
        token_type: tokenType,
        expires_in: expiresInStr ? parseInt(expiresInStr, 10) : 3600,
        refresh_token: refreshToken,
        user: {
          id: userId,
          email: userEmail,
          user_metadata: userMeta,
        },
      };

      setSupabaseAuthToken(accessToken);
      saveStoredSupabaseAuthSession(session);

      // Clean the URL hash immediately so tokens are removed from address bar
      if (window.history?.replaceState) {
        window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
      }

      return { session, error: null, type };
    }
  }

  // 3. Fallback: retrieve stored session
  const stored = getStoredSupabaseAuthSession();
  if (stored?.access_token) {
    setSupabaseAuthToken(stored.access_token);
    return { session: stored, error: null };
  }

  return { session: null, error: null };
}

const PUBLIC_RPCS = new Set([
  'is_system_bootstrapped',
  'get_email_by_username',
  'public_resolve_customer_qr',
  'public_resolve_order_qr',
  'public_resolve_qr_payment_submission',
  'get_or_create_customer_qr',
  'get_or_create_order_qr',
  'get_global_app_identity',
]);

let refreshPromise: Promise<SupabaseAuthSession | null> | null = null;

/**
 * Attempts to refresh the Supabase Auth session using stored refresh token.
 */
export async function supabaseRefreshToken(): Promise<{ session: SupabaseAuthSession | null; error: string | null }> {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return { session: null, error: 'SUPABASE_NOT_CONFIGURED' };
  }

  const stored = getStoredSupabaseAuthSession();
  if (!stored?.refresh_token) {
    return { session: null, error: 'NO_REFRESH_TOKEN' };
  }

  if (refreshPromise) {
    const s = await refreshPromise;
    return { session: s, error: s ? null : 'REFRESH_FAILED' };
  }

  refreshPromise = (async () => {
    try {
      const cleanUrl = config.supabaseUrl.replace(/\/+$/, '');
      const endpoint = `${cleanUrl}/auth/v1/token?grant_type=refresh_token`;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'apikey': config.supabaseAnonKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refresh_token: stored.refresh_token }),
      });

      if (!res.ok) {
        console.warn(`[AUTH_DEBUG] supabaseRefreshToken failed with status ${res.status}`);
        return null;
      }

      const data = await res.json();
      if (!data.access_token) return null;

      const newSession: SupabaseAuthSession = {
        access_token: data.access_token,
        token_type: data.token_type || 'bearer',
        expires_in: data.expires_in || 3600,
        refresh_token: data.refresh_token || stored.refresh_token,
        user: data.user || stored.user,
      };

      setSupabaseAuthToken(newSession.access_token);
      saveStoredSupabaseAuthSession(newSession);
      return newSession;
    } catch (err) {
      console.warn('[AUTH_DEBUG] supabaseRefreshToken exception:', err);
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  const newSession = await refreshPromise;
  return { session: newSession, error: newSession ? null : 'REFRESH_FAILED' };
}

let suspensionHandler: (() => void) | null = null;
export function registerSuspensionHandler(handler: () => void) {
  suspensionHandler = handler;
}

export function triggerSuspension() {
  if (suspensionHandler) {
    suspensionHandler();
  }
}

/**
 * Generic caller for Supabase RPC endpoints using client-safe anon/auth key.
 */
export async function invokeSupabaseRpc<T>(
  functionName: string,
  payload?: Record<string, unknown>,
  customAuthToken?: string,
  allowAnonymous: boolean = false,
  isRetry: boolean = false
): Promise<{ data: T | null; error: string | null }> {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    console.warn('[AUTH_DEBUG] invokeSupabaseRpc: Supabase NOT configured');
    return { data: null, error: 'SUPABASE_NOT_CONFIGURED' };
  }

  const token = resolveAuthBearerToken(customAuthToken);
  const isPublic = allowAnonymous || PUBLIC_RPCS.has(functionName);

  if (!token && !isPublic) {
    console.warn(`[AUTH_DEBUG] invokeSupabaseRpc [${functionName}]: AUTH_TOKEN_MISSING`);
    return { data: null, error: `AUTH_TOKEN_MISSING: Authentication token required for RPC ${functionName}` };
  }

  try {
    const cleanUrl = config.supabaseUrl.replace(/\/+$/, '');
    const endpoint = `${cleanUrl}/rest/v1/rpc/${functionName}`;
    const bearer = token || config.supabaseAnonKey;
    const urlObj = new URL(cleanUrl);

    console.info(`[AUTH_DEBUG] invokeSupabaseRpc [${functionName}] -> Hostname: ${urlObj.hostname}, AnonKeyPresent: ${Boolean(config.supabaseAnonKey)}, IsPublic: ${isPublic}, BearerPresent: ${Boolean(bearer)}`);

    const hasPayload = payload !== undefined && payload !== null && Object.keys(payload).length > 0;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'apikey': config.supabaseAnonKey,
        'Authorization': `Bearer ${bearer}`,
        ...(hasPayload ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(hasPayload ? { body: JSON.stringify(payload) } : {}),
    });

    console.info(`[AUTH_DEBUG] invokeSupabaseRpc [${functionName}] -> HTTP Status: ${res.status} ${res.statusText}`);

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[AUTH_DEBUG] invokeSupabaseRpc [${functionName}] -> Error Response:`, errText);

      if (errText && (errText.includes('inactive or disabled') || errText.includes('ACCESS_DENIED_INACTIVE'))) {
        triggerSuspension();
      }

      // Check for JWT expired / 401 error and attempt auto-refresh once
      const isExpired = res.status === 401 && !isRetry && (
        errText.includes('JWT expired') ||
        errText.includes('PGRST303') ||
        errText.includes('token is expired') ||
        errText.includes('jwt')
      );

      if (isExpired) {
        console.info(`[AUTH_DEBUG] invokeSupabaseRpc [${functionName}] -> JWT expired detected, attempting token refresh...`);
        const { session: refreshedSession } = await supabaseRefreshToken();
        if (refreshedSession?.access_token) {
          console.info(`[AUTH_DEBUG] invokeSupabaseRpc [${functionName}] -> Token refreshed successfully, retrying RPC call`);
          return invokeSupabaseRpc<T>(functionName, payload, refreshedSession.access_token, allowAnonymous, true);
        }
      }

      return { data: null, error: `RPC ${functionName} failed [${res.status}]: ${errText}` };
    }

    if (res.status === 204) {
      console.info(`[AUTH_DEBUG] invokeSupabaseRpc [${functionName}] -> HTTP 204 No Content`);
      return { data: null as unknown as T, error: null };
    }

    let data: T;
    try {
      data = (await res.json()) as T;
    } catch {
      // Safely handle empty response body or non-JSON payloads without throwing
      data = null as unknown as T;
    }

    console.info(`[AUTH_DEBUG] invokeSupabaseRpc [${functionName}] -> Result:`, data === null ? 'NULL' : typeof data);
    return { data, error: null };
  } catch (err: any) {
    console.warn(`[AUTH_DEBUG] invokeSupabaseRpc [${functionName}] -> Network/Fetch Exception:`, err?.message || err);
    return { data: null, error: err?.message || 'Network error invoking Supabase RPC' };
  }
}

/**
 * Generic caller for Supabase REST GET endpoints using authenticated bearer token or anon key.
 */
export async function invokeSupabaseRestGet<T>(
  table: string,
  queryParams: string = 'select=*',
  customAuthToken?: string,
  allowAnonymous: boolean = false,
  isRetry: boolean = false
): Promise<{ data: T[] | null; error: string | null }> {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return { data: null, error: 'SUPABASE_NOT_CONFIGURED' };
  }

  const token = resolveAuthBearerToken(customAuthToken);
  if (!token && !allowAnonymous) {
    return { data: null, error: `AUTH_TOKEN_MISSING: Authentication token required for table ${table}` };
  }

  try {
    const cleanUrl = config.supabaseUrl.replace(/\/+$/, '');
    const q = queryParams ? (queryParams.startsWith('?') ? queryParams : `?${queryParams}`) : '';
    const endpoint = `${cleanUrl}/rest/v1/${table}${q}`;
    const bearer = token || config.supabaseAnonKey;

    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'apikey': config.supabaseAnonKey,
        'Authorization': `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      if (errText && (errText.includes('inactive or disabled') || errText.includes('ACCESS_DENIED_INACTIVE'))) {
        triggerSuspension();
      }

      // REST GET must use the same single-refresh authentication contract as RPC.
      // A stale access token otherwise makes every cloud backup/capture fail even
      // though the stored refresh token can still recover the session.
      const isExpired = res.status === 401 && !isRetry && (
        errText.includes('JWT expired') ||
        errText.includes('PGRST301') ||
        errText.includes('PGRST303') ||
        errText.includes('token is expired') ||
        errText.toLowerCase().includes('jwt')
      );

      if (isExpired) {
        const { session: refreshedSession } = await supabaseRefreshToken();
        if (refreshedSession?.access_token) {
          return invokeSupabaseRestGet<T>(
            table,
            queryParams,
            refreshedSession.access_token,
            allowAnonymous,
            true
          );
        }
      }

      return { data: null, error: `REST GET ${table} failed [${res.status}]: ${errText}` };
    }

    if (res.status === 204) {
      return { data: [] as T[], error: null };
    }

    let data: T[];
    try {
      data = (await res.json()) as T[];
    } catch {
      data = [] as T[];
    }

    return { data, error: null };
  } catch (err: any) {
    return { data: null, error: err?.message || `Network error fetching ${table}` };
  }
}

/**
 * Generic caller for Supabase REST POST/UPSERT endpoints.
 */
export async function invokeSupabaseRestUpsert<T>(
  table: string,
  payload: Record<string, unknown> | Record<string, unknown>[],
  onConflict?: string,
  customAuthToken?: string,
  allowAnonymous: boolean = false,
  isRetry: boolean = false
): Promise<{ data: T | null; error: string | null }> {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return { data: null, error: 'SUPABASE_NOT_CONFIGURED' };
  }

  const token = resolveAuthBearerToken(customAuthToken);
  if (!token && !allowAnonymous) {
    return { data: null, error: `AUTH_TOKEN_MISSING: Authentication token required for table ${table}` };
  }

  try {
    const cleanUrl = config.supabaseUrl.replace(/\/+$/, '');
    const conflictQuery = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
    const endpoint = `${cleanUrl}/rest/v1/${table}${conflictQuery}`;
    const bearer = token || config.supabaseAnonKey;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'apikey': config.supabaseAnonKey,
        'Authorization': `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      if (errText && (errText.includes('inactive or disabled') || errText.includes('ACCESS_DENIED_INACTIVE'))) {
        triggerSuspension();
      }

      const isExpired = res.status === 401 && !isRetry && (
        errText.includes('JWT expired') ||
        errText.includes('PGRST301') ||
        errText.includes('PGRST303') ||
        errText.includes('token is expired') ||
        errText.toLowerCase().includes('jwt')
      );

      if (isExpired) {
        const { session: refreshedSession } = await supabaseRefreshToken();
        if (refreshedSession?.access_token) {
          return invokeSupabaseRestUpsert<T>(
            table,
            payload,
            onConflict,
            refreshedSession.access_token,
            allowAnonymous,
            true
          );
        }
      }

      return { data: null, error: `REST UPSERT ${table} failed [${res.status}]: ${errText}` };
    }

    if (res.status === 204) {
      return { data: null, error: null };
    }

    let data: T;
    try {
      data = (await res.json()) as T;
    } catch {
      data = null as unknown as T;
    }

    return { data, error: null };
  } catch (err: any) {
    return { data: null, error: err?.message || `Network error upserting ${table}` };
  }
}

export interface SupabaseSignInResult {
  session: SupabaseAuthSession | null;
  error: string | null;
  statusCode?: number;
  isEmailUnconfirmed?: boolean;
  isRateLimited?: boolean;
  isInvalidCredentials?: boolean;
  isNetworkError?: boolean;
}

/**
 * Supabase Auth: Sign in with email and password
 */
export async function supabaseSignInWithPassword(
  email: string,
  passOrPin: string,
  persistSession: boolean = true
): Promise<SupabaseSignInResult> {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return { session: null, error: 'SUPABASE_NOT_CONFIGURED' };
  }

  try {
    const cleanUrl = config.supabaseUrl.replace(/\/+$/, '');
    const endpoint = `${cleanUrl}/auth/v1/token?grant_type=password`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'apikey': config.supabaseAnonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: email.trim(), password: passOrPin }),
    });

    if (!res.ok) {
      const errText = await res.text();
      let parsedDesc = errText;
      let isEmailUnconfirmed = false;
      let isRateLimited = res.status === 429;
      let isInvalidCredentials = false;

      try {
        const errJson = JSON.parse(errText);
        parsedDesc = errJson.error_description || errJson.msg || errJson.message || errText;
      } catch {}

      const lowerDesc = parsedDesc.toLowerCase();
      if (
        lowerDesc.includes('email not confirmed') ||
        errText.toLowerCase().includes('email not confirmed')
      ) {
        isEmailUnconfirmed = true;
      }
      if (res.status === 429 || lowerDesc.includes('rate limit') || lowerDesc.includes('too many requests')) {
        isRateLimited = true;
      }
      if (
        lowerDesc.includes('invalid login credentials') ||
        lowerDesc.includes('invalid grant') ||
        lowerDesc.includes('invalid credentials') ||
        lowerDesc.includes('invalid email or password') ||
        lowerDesc.includes('invalid password') ||
        (res.status === 400 && !isEmailUnconfirmed)
      ) {
        isInvalidCredentials = true;
      }

      console.warn(`[AUTH_DEBUG] supabaseSignInWithPassword -> FAILED [${res.status}]: ${parsedDesc}`);
      return {
        session: null,
        error: parsedDesc,
        statusCode: res.status,
        isEmailUnconfirmed,
        isRateLimited,
        isInvalidCredentials,
      };
    }

    const session = (await res.json()) as SupabaseAuthSession;
    console.info(`[AUTH_DEBUG] supabaseSignInWithPassword -> SUCCESS, userId: ${session.user?.id}`);
    setSupabaseAuthToken(session.access_token);
    if (persistSession) {
      saveStoredSupabaseAuthSession(session);
    }
    return { session, error: null, statusCode: 200 };
  } catch (err: any) {
    return {
      session: null,
      error: err?.message || 'Network error during sign in',
      isNetworkError: true,
    };
  }
}

/**
 * Supabase Auth: Update password for authenticated user
 */
export async function supabaseUpdatePassword(password: string): Promise<{
  error: string | null;
}> {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return { error: 'SUPABASE_NOT_CONFIGURED' };
  }
  const token = getSupabaseAuthToken();
  if (!token) {
    return { error: 'Authentication required' };
  }

  try {
    const cleanUrl = config.supabaseUrl.replace(/\/+$/, '');
    const endpoint = `${cleanUrl}/auth/v1/user`;

    const res = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        'apikey': config.supabaseAnonKey,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { error: errText || 'Failed to update password' };
    }
    return { error: null };
  } catch (err: any) {
    return { error: err?.message || 'Network error during password update' };
  }
}

/**
 * Supabase Auth: Sign up new user
 */
export async function supabaseSignUp(
  email: string,
  passOrPin: string
): Promise<{
  session: SupabaseAuthSession | null;
  userOnly: boolean;
  error: string | null;
  isEmailUnconfirmed?: boolean;
}> {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return { session: null, userOnly: false, error: 'SUPABASE_NOT_CONFIGURED' };
  }

  try {
    const cleanUrl = config.supabaseUrl.replace(/\/+$/, '');
    const redirectUrl =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : 'https://ais-dev-ysj6qxp5jjdotuhhmuwlez-886408646256.europe-west2.run.app';
    const endpoint = `${cleanUrl}/auth/v1/signup?redirect_to=${encodeURIComponent(redirectUrl)}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'apikey': config.supabaseAnonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: email.trim(),
        password: passOrPin,
        options: {
          emailRedirectTo: redirectUrl,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      let parsedDesc = errText;
      try {
        const errJson = JSON.parse(errText);
        parsedDesc = errJson.error_description || errJson.msg || errJson.message || errText;
      } catch {}
      return { session: null, userOnly: false, error: parsedDesc };
    }

    const data = await res.json();
    if (data.access_token) {
      const session = data as SupabaseAuthSession;
      setSupabaseAuthToken(session.access_token);
      saveStoredSupabaseAuthSession(session);
      return { session, userOnly: false, error: null };
    } else {
      return { session: null, userOnly: true, error: null, isEmailUnconfirmed: true };
    }
  } catch (err: any) {
    return { session: null, userOnly: false, error: err?.message || 'Network error during sign up' };
  }
}

/**
 * Verifies a 6-digit email confirmation OTP code with Supabase Auth
 */
export async function supabaseVerifyEmailOtp(
  email: string,
  token: string
): Promise<{
  session: SupabaseAuthSession | null;
  error: string | null;
  errorCode?: string | null;
}> {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return { session: null, error: 'SUPABASE_NOT_CONFIGURED' };
  }

  const cleanEmail = email.trim();
  const cleanToken = token.trim();

  // Enforce strict 6-digit numeric OTP format client-side validation
  if (!/^\d{6}$/.test(cleanToken)) {
    return {
      session: null,
      error: 'رمز التحقق يجب أن يتكون من 6 أرقام بالضبط',
      errorCode: 'INVALID_TOKEN_FORMAT',
    };
  }

  try {
    const cleanUrl = config.supabaseUrl.replace(/\/+$/, '');
    const endpoint = `${cleanUrl}/auth/v1/verify`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'apikey': config.supabaseAnonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'signup',
        email: cleanEmail,
        token: cleanToken,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      let errMsg = 'رمز التحقق غير صحيح أو منتهي الصلاحية';
      let errCode = 'VERIFICATION_FAILED';
      try {
        const errJson = JSON.parse(errText);
        if (errJson.msg || errJson.error_description || errJson.message) {
          errMsg = errJson.msg || errJson.error_description || errJson.message;
        }
        if (errJson.code) errCode = errJson.code;
      } catch {
        // default message
      }
      return { session: null, error: errMsg, errorCode: errCode };
    }

    const data = await res.json();
    if (!data.access_token || !data.user) {
      return { session: null, error: 'تعذر استخراج جلسة المصادقة بعد إدخال الرمز', errorCode: 'NO_SESSION' };
    }

    const session: SupabaseAuthSession = {
      access_token: data.access_token,
      token_type: data.token_type || 'bearer',
      expires_in: data.expires_in || 3600,
      refresh_token: data.refresh_token || '',
      user: {
        id: data.user.id,
        email: data.user.email,
        email_confirmed_at: data.user.email_confirmed_at || new Date().toISOString(),
      },
    };

    setSupabaseAuthToken(session.access_token);
    saveStoredSupabaseAuthSession(session);

    return { session, error: null };
  } catch (err: any) {
    return { session: null, error: err?.message || 'خطأ في الاتصال أثناء التحقق من الرمز' };
  }
}

/**
 * Resends the confirmation OTP / link email via Supabase Auth
 */
export async function supabaseResendEmailOtp(
  email: string
): Promise<{
  success: boolean;
  error: string | null;
  errorCode?: string | null;
  isRateLimited?: boolean;
}> {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return { success: false, error: 'SUPABASE_NOT_CONFIGURED' };
  }

  try {
    const cleanUrl = config.supabaseUrl.replace(/\/+$/, '');
    const endpoint = `${cleanUrl}/auth/v1/resend`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'apikey': config.supabaseAnonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'signup',
        email: email.trim(),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      let errMsg = 'تعذر إعادة إرسال رمز التحقق الآن. حاول لاحقاً.';
      let isRateLimited = res.status === 429;
      try {
        const errJson = JSON.parse(errText);
        if (errJson.msg || errJson.error_description || errJson.message) {
          errMsg = errJson.msg || errJson.error_description || errJson.message;
        }
        if (res.status === 429 || (errMsg && errMsg.toLowerCase().includes('rate limit'))) {
          isRateLimited = true;
          errMsg = 'تم تجاوز الحد المسموح لإعادة الإرسال. يرجى الانتظار والمحاولة لاحقاً.';
        }
      } catch {
        // default
      }
      return { success: false, error: errMsg, isRateLimited };
    }

    return { success: true, error: null };
  } catch (err: any) {
    return { success: false, error: err?.message || 'خطأ في الاتصال أثناء إعادة إرسال الرمز' };
  }
}

/**
 * Checks if the system already has a Super Admin bootstrapped in PostgreSQL
 */
export async function rpcCheckSystemBootstrapped(): Promise<{ isBootstrapped: boolean; error: string | null }> {
  const { data, error } = await invokeSupabaseRpc<boolean>('is_system_bootstrapped', {});
  if (error) {
    return { isBootstrapped: true, error };
  }
  return { isBootstrapped: Boolean(data), error: null };
}

export interface AdminProfileRpcResult {
  authenticated: boolean;
  is_admin: boolean;
  is_active?: boolean;
  is_email_confirmed?: boolean;
  admin_id?: string;
  auth_user_id?: string;
  username?: string;
  full_name?: string;
  email?: string;
  role?: string;
  permissions?: string[];
}

/**
 * Server-Authoritative Admin Profile Resolver RPC.
 * Derives admin identity & role strictly from auth.uid() in PostgreSQL.
 */
export async function rpcGetCurrentAdminProfile(
  customAuthToken?: string
): Promise<{ profile: AdminProfileRpcResult | null; error: string | null }> {
  const { data, error } = await invokeSupabaseRpc<AdminProfileRpcResult>(
    'get_current_admin_profile',
    {},
    customAuthToken
  );
  if (error || !data) {
    return { profile: null, error: error || 'Failed to resolve admin profile' };
  }
  return { profile: data, error: null };
}

let lastGetEmailError: string | null = null;
export const getLastGetEmailError = (): string | null => lastGetEmailError;

export async function rpcResolveEmailByUsername(username: string): Promise<{
  email: string | null;
  error: string | null;
}> {
  lastGetEmailError = null;
  const cleanUsername = username.trim();
  console.info(`[AUTH_DEBUG] rpcResolveEmailByUsername called with username: "${cleanUsername}"`);

  const payload: Record<string, unknown> = {
    p_username: cleanUsername,
  };
  const { data, error } = await invokeSupabaseRpc<string>('get_email_by_username', payload);
  if (error) {
    console.warn(`[AUTH_DEBUG] rpcResolveEmailByUsername -> error returned: ${error}`);
    lastGetEmailError = error;
    return { email: null, error };
  }
  if (!data) {
    console.warn(`[AUTH_DEBUG] rpcResolveEmailByUsername -> data is NULL or empty`);
    return { email: null, error: null };
  }
  const email = typeof data === 'string' && data.trim() ? data.trim() : null;
  console.info(`[AUTH_DEBUG] rpcResolveEmailByUsername -> resolved email successfully`);
  return { email, error: null };
}

export async function rpcGetEmailByUsername(username: string): Promise<string | null> {
  const res = await rpcResolveEmailByUsername(username);
  return res.email;
}

/**
 * Calls the secure one-time bootstrap RPC to create the first Super Admin
 */
export async function rpcBootstrapFirstSuperAdmin(
  payload: {
    username: string;
    fullName?: string;
    bin: string;
  },
  customAuthToken?: string
): Promise<{ success: boolean; data?: any; error?: string | null }> {
  const { data, error } = await invokeSupabaseRpc<any>(
    'bootstrap_first_super_admin',
    {
      p_username: payload.username.trim(),
      p_full_name: payload.fullName?.trim() || payload.username.trim(),
      p_bin: payload.bin.trim(),
    },
    customAuthToken
  );

  if (error) {
    return { success: false, error };
  }

  if (data && typeof data === 'object') {
    if (data.success === false) {
      return {
        success: false,
        error: data.message || data.code || 'Bootstrap failed',
        data,
      };
    }
    return { success: true, data, error: null };
  }

  return { success: false, error: 'Invalid response from server' };
}

/**
 * Resolves customer QR securely via PostgreSQL RPC `public_resolve_customer_qr`.
 * Uses `p_public_token` (persistent 128-bit capability identifier).
 */
export async function rpcResolveCustomerQr(
  publicToken: string
): Promise<{ customerName: string; customerCode: string } | null> {
  const { data, error } = await invokeSupabaseRpc<PublicCustomerQrRpcResult[]>(
    'public_resolve_customer_qr',
    { p_public_token: publicToken }
  );

  if (error) {
    // A failed RPC is a server/contract failure, not proof that the QR token is invalid.
    // Preserve the failure so callers do not silently fall back to device-local identity.
    throw new Error(`CUSTOMER_QR_RESOLUTION_FAILED: ${error}`);
  }

  if (data === null) {
    throw new Error('CUSTOMER_QR_RESOLUTION_FAILED: empty RPC response');
  }

  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  const row = data[0];
  if (
    !row ||
    typeof row.customer_name !== 'string' ||
    typeof row.customer_code !== 'string'
  ) {
    throw new Error('CUSTOMER_QR_RESOLUTION_FAILED: invalid server response contract');
  }

  return {
    customerName: row.customer_name,
    customerCode: row.customer_code,
  };
}

/**
 * Resolves order QR securely via PostgreSQL RPC `public_resolve_order_qr`.
 * Uses `p_public_token` (persistent 128-bit capability identifier).
 */
export async function rpcResolveOrderQr(
  publicToken: string
): Promise<PublicOrderQrRpcResult | null> {
  const { data, error } = await invokeSupabaseRpc<PublicOrderQrRpcResult[]>(
    'public_resolve_order_qr',
    { p_public_token: publicToken }
  );

  if (error || !data || data.length === 0) {
    return null;
  }

  return data[0];
}

/**
 * Resolves the latest payment notification associated with a public order/customer QR token.
 * Only safe status, amount, method, timestamps, and approved balance snapshots are returned.
 */
export async function rpcResolveQrPaymentSubmission(
  publicToken: string
): Promise<PublicQrPaymentSubmissionRpcResult | null> {
  const { data, error } = await invokeSupabaseRpc<PublicQrPaymentSubmissionRpcResult>(
    'public_resolve_qr_payment_submission',
    { p_public_token: publicToken }
  );
  if (error || !data || !['PENDING', 'APPROVED', 'REJECTED'].includes(data.status)) {
    return null;
  }
  return data;
}

/**
 * Idempotently gets or creates the persistent public capability QR token for a customer.
 * Constant across all devices and sessions.
 */
export async function rpcGetOrCreateCustomerQr(
  customerId: string
): Promise<string | null> {
  const { data, error } = await invokeSupabaseRpc<string>(
    'get_or_create_customer_qr',
    { p_customer_id: customerId }
  );

  if (error || !data) {
    return null;
  }

  return data;
}

/**
 * Registers an existing device-local customer QR token with the central database
 * when possible, preserving previously shared links. This RPC requires an
 * authenticated admin session and is deliberately not listed among public RPCs.
 */
export async function rpcAdoptLegacyCustomerQrToken(
  customerId: string,
  publicToken: string
): Promise<string> {
  const { data, error } = await invokeSupabaseRpc<string>(
    'adopt_customer_qr_token',
    { p_customer_id: customerId, p_public_token: publicToken }
  );

  if (error) {
    throw new Error(`CUSTOMER_QR_LEGACY_ADOPTION_FAILED: ${error}`);
  }
  if (typeof data !== 'string' || !/^[A-Za-z0-9_-]{24,64}$/.test(data)) {
    throw new Error('CUSTOMER_QR_LEGACY_ADOPTION_FAILED: invalid server response');
  }

  return data;
}

/**
 * Explicitly rotates a customer QR token (invalidating previous ones).
 */
export async function rpcRotateCustomerQr(
  customerId: string
): Promise<string | null> {
  const { data, error } = await invokeSupabaseRpc<string>(
    'rotate_customer_qr',
    { p_customer_id: customerId }
  );

  if (error || !data) {
    return null;
  }

  return data;
}

export interface BinAttemptVerificationResult {
  success: boolean;
  status: 'ACTIVE' | 'LOCKED' | 'UNAUTHENTICATED' | 'INACTIVE' | 'ERROR';
  is_locked: boolean;
  remaining_attempts: number;
  failed_attempts: number;
  error?: string | null;
  isTechnicalError?: boolean;
}

/**
 * Server-Authoritative BIN Verification RPC with Atomic 3-Attempt Tracking and Lock Enforcement.
 * Never produces fake attempt counts or fake fallback success/failure states.
 */
export async function rpcVerifyAdminBinWithTracking(
  bin: string,
  customAuthToken?: string
): Promise<BinAttemptVerificationResult> {
  const cleanBin = bin ? bin.trim() : '';
  const { data, error } = await invokeSupabaseRpc<BinAttemptVerificationResult>(
    'verify_admin_bin_with_attempt_tracking',
    { p_bin: cleanBin },
    customAuthToken
  );

  if (error || !data || typeof data !== 'object') {
    return {
      success: false,
      status: 'ERROR',
      is_locked: false,
      remaining_attempts: -1,
      failed_attempts: -1,
      error: error || 'BIN_VERIFICATION_UNAVAILABLE',
      isTechnicalError: true,
    };
  }

  return data;
}

/**
 * Server-Authoritative Password-Authenticated BIN Recovery Proof Issuance RPC.
 * Validates current password server-side against auth.users and issues an ephemeral 2-minute single-use proof token.
 */
export async function rpcIssueBinRecoveryProof(
  currentPassword: string,
  customAuthToken?: string
): Promise<{ success: boolean; proofToken?: string; expiresInSeconds?: number; error: string | null }> {
  if (!currentPassword) {
    return {
      success: false,
      error: 'Current password is required',
    };
  }

  const { data, error } = await invokeSupabaseRpc<any>(
    'issue_bin_recovery_proof',
    { p_current_password: currentPassword },
    customAuthToken
  );

  if (error) {
    return { success: false, error };
  }

  if (!data || data.success !== true || !data.proof_token) {
    return {
      success: false,
      error: data?.error === 'INVALID_PASSWORD' ? 'كلمة المرور الحالية غير صحيحة' : data?.error || 'Failed to issue recovery proof',
    };
  }

  return {
    success: true,
    proofToken: data.proof_token,
    expiresInSeconds: data.expires_in_seconds || 120,
    error: null,
  };
}

/**
 * Server-Authoritative Password-Authenticated BIN Recovery RPC.
 * Requires both new BIN and a valid, server-issued single-use cryptographic recovery proof token.
 */
export async function rpcRecoverAndResetAdminBin(
  newBin: string,
  recoveryProof: string,
  customAuthToken?: string
): Promise<{ success: boolean; error: string | null }> {
  const cleanBin = newBin ? newBin.trim() : '';
  const cleanProof = recoveryProof ? recoveryProof.trim() : '';

  if (!cleanProof) {
    return {
      success: false,
      error: 'PROOF_REQUIRED: Valid recovery authorization proof is required',
    };
  }

  if (!cleanBin || !/^\d{4,}$/.test(cleanBin)) {
    return {
      success: false,
      error: 'رمز الأمان (BIN) يجب أن يتكون من 4 أرقام على الأقل',
    };
  }

  const { data, error } = await invokeSupabaseRpc<any>(
    'recover_and_reset_admin_bin',
    {
      p_new_bin: cleanBin,
      p_recovery_proof: cleanProof,
    },
    customAuthToken
  );

  if (error) {
    return { success: false, error };
  }

  if (data && typeof data === 'object' && data.success === false) {
    return { success: false, error: data.error || 'Failed to recover BIN' };
  }

  return { success: true, error: null };
}

/**
 * Server-Authoritative BIN Verification RPC.
 * Verifies admin credentials via server-side bcrypt crypt() on PostgreSQL.
 * bin_hash is never returned to the browser client.
 */
export async function rpcVerifyAdminBin(bin: string): Promise<boolean> {
  if (!bin || bin.trim().length < 4) {
    return false;
  }

  const { data, error } = await invokeSupabaseRpc<boolean>(
    'verify_admin_bin',
    { p_bin: bin.trim() }
  );

  if (error || data !== true) {
    return false;
  }

  return true;
}

/**
 * Server-Authoritative BIN Update RPC.
 * Invokes public.set_admin_bin(p_bin, p_admin_id) on PostgreSQL.
 * Securely hashes new BIN server-side using pgcrypto salted bcrypt.
 */
export async function rpcSetAdminBin(
  bin: string,
  targetAdminId?: string,
  customAuthToken?: string
): Promise<{ success: boolean; error: string | null }> {
  const cleanBin = bin ? bin.trim() : '';
  if (!cleanBin || !/^\d{4,}$/.test(cleanBin)) {
    return {
      success: false,
      error: 'رمز الأمان (BIN) يجب أن يتكون من 4 أرقام على الأقل',
    };
  }

  const payload: Record<string, unknown> = {
    p_bin: cleanBin,
  };
  if (targetAdminId && targetAdminId.trim()) {
    payload.p_admin_id = targetAdminId.trim();
  }

  const { data, error } = await invokeSupabaseRpc<boolean>('set_admin_bin', payload, customAuthToken);
  if (error) {
    return { success: false, error };
  }
  return { success: Boolean(data), error: null };
}

export interface TopUpAtomicResult {
  success: boolean;
  transactionId?: string;
  newBalanceMinor?: number;
  error?: string;
}

/**
 * Server-Authoritative Atomic Customer Top-up RPC.
 * Verifies BIN via bcrypt and applies financial ledger mutation in the same database transaction.
 * Eliminates TOCTOU vulnerabilities.
 */
export async function rpcExecuteCustomerTopUpAtomic(params: {
  commandId: string;
  customerId: string;
  amountMinor: number;
  bin: string;
  note?: string;
}): Promise<TopUpAtomicResult> {
  const { data, error } = await invokeSupabaseRpc<any>(
    'execute_customer_top_up_atomic',
    {
      p_command_id: params.commandId,
      p_customer_id: params.customerId,
      p_amount_minor: params.amountMinor,
      p_bin: params.bin.trim(),
      p_note: params.note || null,
    }
  );

  if (error) {
    return {
      success: false,
      error: typeof error === 'string' ? error : 'فشلت عملية التحقق أو الخصم على الخادم',
    };
  }

  return {
    success: true,
    transactionId: data?.transactionId,
    newBalanceMinor: data?.newBalanceMinor,
  };
}

/**
 * Idempotently gets or creates the persistent public capability QR token for an order.
 */
export async function rpcGetOrCreateOrderQr(
  orderId: string
): Promise<string | null> {
  const { data, error } = await invokeSupabaseRpc<string>(
    'get_or_create_order_qr',
    { p_order_id: orderId }
  );

  if (error || !data) {
    return null;
  }

  return data;
}

// Client stub for backward compatibility
export const createSupabaseClientStub = () => {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return null;
  }
  return {
    url: config.supabaseUrl,
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      signIn: async () => ({ data: null, error: 'Not implemented' }),
      signOut: async () => ({ error: null }),
    },
    from: (table: string) => ({
      select: () => Promise.resolve({ data: [], error: null }),
      insert: () => Promise.resolve({ data: null, error: null }),
      update: () => Promise.resolve({ data: null, error: null }),
      delete: () => Promise.resolve({ data: null, error: null }),
    }),
  };
};

export interface GlobalAppIdentityRpcResult {
  id: string;
  app_name: string;
  white_logo_url: string | null;
  dark_logo_url: string | null;
  // Backwards-compatible read support for legacy field names
  light_logo_url?: string | null;
  qr_white_logo_url?: string | null;
  version: number;
  updated_at: string;
  updated_by?: string | null;
  success?: boolean;
}

/**
 * Public RPC to fetch central Global App Identity metadata.
 */
export async function rpcGetGlobalAppIdentity(): Promise<{
  data: GlobalAppIdentityRpcResult | null;
  error: string | null;
}> {
  return invokeSupabaseRpc<GlobalAppIdentityRpcResult>(
    'get_global_app_identity',
    {},
    undefined,
    true // Allow anonymous / public read
  );
}

/**
 * Server-Authoritative Protected RPC to update central Global App Identity.
 * Requires active Super Admin authenticated session.
 */
export async function rpcUpdateGlobalAppIdentity(params: {
  appName?: string;
  whiteLogoUrl?: string | null;
  darkLogoUrl?: string | null;
}): Promise<{
  data: GlobalAppIdentityRpcResult | null;
  error: string | null;
}> {
  return invokeSupabaseRpc<GlobalAppIdentityRpcResult>(
    'update_global_app_identity',
    {
      p_app_name: params.appName || null,
      p_white_logo_url: params.whiteLogoUrl || null,
      p_dark_logo_url: params.darkLogoUrl || null,
    }
  );
}

/**
 * Uploads a brand identity logo to Supabase Storage in deterministic folder hierarchy:
 * - app-identity/white/
 * - app-identity/dark/
 * Returns public URL for storage in global_app_identity metadata.
 */
export async function uploadAppIdentityLogo(
  variant: 'white' | 'dark' | 'light' | 'qr',
  blobOrFile: Blob | File,
  contentType: string = 'image/png',
  isRetry: boolean = false
): Promise<{ url: string | null; error: string | null }> {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return { url: null, error: 'SUPABASE_NOT_CONFIGURED' };
  }

  const token = resolveAuthBearerToken() || config.supabaseAnonKey;
  if (!token) {
    return { url: null, error: 'AUTH_REQUIRED: Super Admin authentication token required to upload identity assets' };
  }

  try {
    const cleanUrl = config.supabaseUrl.replace(/\/+$/, '');
    const canonicalFolder = variant === 'light' || variant === 'qr' ? 'white' : variant;
    const filename = `logo_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.png`;
    const objectPath = `${canonicalFolder}/${filename}`;
    const bucket = 'app-identity';
    const endpoint = `${cleanUrl}/storage/v1/object/${bucket}/${objectPath}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'apikey': config.supabaseAnonKey,
        'Authorization': `Bearer ${token}`,
        'Content-Type': contentType,
        'x-upsert': 'true',
      },
      body: blobOrFile,
    });

    if (!res.ok) {
      const errText = await res.text();
      const isExpired = res.status === 401 && !isRetry && (
        errText.includes('JWT expired') ||
        errText.includes('PGRST303') ||
        errText.includes('token is expired') ||
        errText.includes('jwt')
      );
      if (isExpired) {
        const { session: refreshedSession } = await supabaseRefreshToken();
        if (refreshedSession?.access_token) {
          return uploadAppIdentityLogo(variant, blobOrFile, contentType, true);
        }
      }
      return { url: null, error: `Storage upload failed [${res.status}]: ${errText}` };
    }

    const publicUrl = `${cleanUrl}/storage/v1/object/public/${bucket}/${objectPath}`;
    return { url: publicUrl, error: null };
  } catch (err: any) {
    return { url: null, error: err?.message || 'Network error during storage upload' };
  }
}

/**
 * Deletes a brand identity asset from Supabase Storage (used for cleanup / transactional rollback).
 */
export async function deleteAppIdentityObject(
  publicUrlOrPath: string
): Promise<{ success: boolean; error: string | null }> {
  if (!config.supabaseUrl || !config.supabaseAnonKey || !publicUrlOrPath) {
    return { success: false, error: 'INVALID_PARAMS' };
  }

  const token = resolveAuthBearerToken() || config.supabaseAnonKey;
  if (!token) {
    return { success: false, error: 'AUTH_REQUIRED' };
  }

  try {
    const cleanUrl = config.supabaseUrl.replace(/\/+$/, '');
    const bucket = 'app-identity';

    // Extract object path relative to bucket
    let objectPath = publicUrlOrPath;
    if (publicUrlOrPath.includes(`/storage/v1/object/public/${bucket}/`)) {
      objectPath = publicUrlOrPath.split(`/storage/v1/object/public/${bucket}/`)[1];
    } else if (publicUrlOrPath.includes(`/storage/v1/object/${bucket}/`)) {
      objectPath = publicUrlOrPath.split(`/storage/v1/object/${bucket}/`)[1];
    }

    if (!objectPath) {
      return { success: false, error: 'INVALID_OBJECT_PATH' };
    }

    const endpoint = `${cleanUrl}/storage/v1/object/${bucket}`;
    const res = await fetch(endpoint, {
      method: 'DELETE',
      headers: {
        'apikey': config.supabaseAnonKey,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefixes: [objectPath] }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { success: false, error: `Storage delete failed [${res.status}]: ${errText}` };
    }

    return { success: true, error: null };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Network error during storage delete' };
  }
}

/**
 * Admin Management RPC and REST wrappers.
 */

export interface AdminRow {
  id: string;
  username: string;
  full_name: string | null;
  email: string | null;
  role: string;
  is_active: boolean;
  version: number;
  created_at: string;
  disabled_at?: string | null;
  disabled_by?: string | null;
}

export interface AuditLog {
  id: string;
  actor_admin_id: string | null;
  action: string;
  target_admin_id: string | null;
  metadata: any;
  created_at: string;
}

export interface CustomPermission {
  admin_id: string;
  permission: string;
  is_grant: boolean;
}

export async function rpcSuspendAdmin(targetAdminId: string, bin: string): Promise<{ success: boolean; error: string | null }> {
  const { error } = await invokeSupabaseRpc<void>('rpc_suspend_admin', {
    p_target_admin_id: targetAdminId,
    p_bin: bin,
  });
  return { success: !error, error };
}

export async function rpcActivateAdmin(targetAdminId: string, bin: string): Promise<{ success: boolean; error: string | null }> {
  const { error } = await invokeSupabaseRpc<void>('rpc_activate_admin', {
    p_target_admin_id: targetAdminId,
    p_bin: bin,
  });
  return { success: !error, error };
}

export async function rpcGrantCustomPermission(targetAdminId: string, permission: string, isGrant: boolean, bin: string): Promise<{ success: boolean; error: string | null }> {
  const { error } = await invokeSupabaseRpc<void>('rpc_grant_custom_permission', {
    p_target_admin_id: targetAdminId,
    p_permission: permission,
    p_is_grant: isGrant,
    p_bin: bin,
  });
  return { success: !error, error };
}

export async function rpcRevokeCustomPermission(targetAdminId: string, permission: string, bin: string): Promise<{ success: boolean; error: string | null }> {
  const { error } = await invokeSupabaseRpc<void>('rpc_revoke_custom_permission', {
    p_target_admin_id: targetAdminId,
    p_permission: permission,
    p_bin: bin,
  });
  return { success: !error, error };
}

export async function rpcSetAdminCustomPermissions(
  targetAdminId: string,
  permissions: string[],
  bin: string
): Promise<{ success: boolean; error: string | null }> {
  const { error } = await invokeSupabaseRpc<void>('rpc_set_admin_custom_permissions', {
    p_target_admin_id: targetAdminId,
    p_permissions: permissions,
    p_bin: bin,
  });
  return { success: !error, error };
}

export async function rpcCreateAdmin(payload: {
  username: string;
  email: string;
  password: string;
  fullName: string;
  role: string;
  bin: string;
  callerBin: string;
}): Promise<{ data: string | null; error: string | null }> {
  const { data, error } = await invokeSupabaseRpc<string>('rpc_create_admin', {
    p_username: payload.username,
    p_email: payload.email,
    p_password: payload.password,
    p_full_name: payload.fullName,
    p_role: payload.role,
    p_bin: payload.bin,
    p_caller_bin: payload.callerBin,
  });
  return { data, error };
}

export async function rpcUpdateAdminPassword(targetAdminId: string, newPassword: string, callerBin: string): Promise<{ success: boolean; error: string | null }> {
  const { error } = await invokeSupabaseRpc<void>('rpc_update_admin_password', {
    p_target_admin_id: targetAdminId,
    p_new_password: newPassword,
    p_caller_bin: callerBin,
  });
  return { success: !error, error };
}

export async function rpcUpdateAdminBin(targetAdminId: string, newBin: string, callerBin: string): Promise<{ success: boolean; error: string | null }> {
  const { error } = await invokeSupabaseRpc<void>('rpc_update_admin_bin', {
    p_target_admin_id: targetAdminId,
    p_new_bin: newBin,
    p_caller_bin: callerBin,
  });
  return { success: !error, error };
}

export async function rpcFetchAdmins(): Promise<{ data: AdminRow[] | null; error: string | null }> {
  const { data, error } = await invokeSupabaseRpc<AdminRow[]>('rpc_fetch_admins');
  return { data, error };
}

export async function rpcFetchAuditLogs(): Promise<{ data: AuditLog[] | null; error: string | null }> {
  const { data, error } = await invokeSupabaseRestGet<AuditLog>('admin_audit_logs', 'select=*&order=created_at.desc');
  return { data, error };
}

export async function rpcFetchCustomPermissions(): Promise<{ data: CustomPermission[] | null; error: string | null }> {
  // Custom permissions are security-sensitive admin data. Read them through the
  // authoritative SECURITY DEFINER RPC instead of direct PostgREST table access,
  // which is subject to table RLS and can return an empty set even when rows exist.
  const { data, error } = await invokeSupabaseRpc<CustomPermission[]>(
    'rpc_fetch_custom_permissions'
  );
  return { data, error };
}


