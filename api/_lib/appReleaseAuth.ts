import type { IncomingMessage, ServerResponse } from 'node:http';
export type ReleaseChannel = 'customer' | 'admin';
export type ApiRequest = IncomingMessage & { body?: unknown };
export type ApiResponse = ServerResponse & { status(code: number): ApiResponse; json(value: unknown): void };

export function sendJson(res: ApiResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, private');
  res.end(JSON.stringify(body));
}

export function getSupabaseConfig() {
  const url = process.env.VITE_SUPABASE_URL || 'https://ydhcyamtgioyrxfarkwk.supabase.co';
  const key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_dXsrK8ltM6DCZ88HgfP27w_bxb3rvGN';
  return { url: url.replace(/\/$/, ''), key };
}

export async function requireSuperAdmin(req: ApiRequest): Promise<
  { ok: true; token: string; supabaseUrl: string; anonKey: string } |
  { ok: false; status: number; error: string }
> {
  const token = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const { url, key } = getSupabaseConfig();
  if (!token || !key) return { ok: false, status: 401, error: 'AUTHENTICATION_REQUIRED' };
  try {
    const user = await fetch(url + '/auth/v1/user', {
      headers: { apikey: key, Authorization: 'Bearer ' + token }, cache: 'no-store',
    });
    if (!user.ok) return { ok: false, status: 401, error: 'INVALID_SESSION' };
    const role = await fetch(url + '/rest/v1/rpc/is_active_super_admin_session', {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: '{}', cache: 'no-store',
    });
    if (!role.ok) return { ok: false, status: 403, error: 'SUPER_ADMIN_REQUIRED' };
    const allowed = await role.json();
    if (allowed !== true && !(Array.isArray(allowed) && allowed[0] === true)) {
      return { ok: false, status: 403, error: 'SUPER_ADMIN_REQUIRED' };
    }
    return { ok: true, token, supabaseUrl: url, anonKey: key };
  } catch {
    return { ok: false, status: 503, error: 'AUTHORIZATION_SERVICE_UNAVAILABLE' };
  }
}

export function parseReleaseVersion(value: unknown): { version: string; code: number } | null {
  if (typeof value !== 'string') return null;
  const match = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(value.trim());
  if (!match) return null;
  const [major, minor, patch] = match.slice(1).map(Number);
  const code = major * 1_000_000 + minor * 1_000 + patch;
  return Number.isSafeInteger(code) && code > 0 && code <= 2_100_000_000
    ? { version: value.trim(), code } : null;
}

export async function updateReleasePolicy(
  auth: { token: string; supabaseUrl: string; anonKey: string },
  channel: ReleaseChannel,
  values: { latest_version: string; version_code: number; release_notes: string; download_url: string; grace_until: string },
) {
  const response = await fetch(auth.supabaseUrl + '/rest/v1/app_release_policies?channel=eq.' + channel, {
    method: 'PATCH',
    headers: {
      apikey: auth.anonKey, Authorization: 'Bearer ' + auth.token,
      'Content-Type': 'application/json', Prefer: 'return=representation',
    },
    body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('RELEASE_POLICY_UPDATE_FAILED');
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('RELEASE_POLICY_ROW_NOT_FOUND');
  return rows[0];
}
