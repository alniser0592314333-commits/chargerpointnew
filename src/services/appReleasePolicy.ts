import { invokeSupabaseRestGet, invokeSupabaseRestUpsert } from './supabase/client';

export type AppReleaseChannel = 'customer' | 'admin';

export interface AppReleasePolicy {
  channel: AppReleaseChannel;
  latest_version: string;
  version_code: number;
  release_notes: string;
  download_url: string;
  grace_until: string;
  updated_at: string;
}

export interface AppReleasePolicyResult {
  policy: AppReleasePolicy | null;
  error: string | null;
}

export function parseAppVersion(value: string): { major: number; minor: number; patch: number; code: number } | null {
  const match = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(value.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const code = major * 1_000_000 + minor * 1_000 + patch;
  if (!Number.isSafeInteger(code) || code < 1 || code > 2_100_000_000) return null;
  return { major, minor, patch, code };
}

/**
 * Resolve Dropbox shared-file URLs to the content host instead of the Dropbox
 * preview host. The rlkey must be preserved because it grants access to newer
 * /scl/fi shared links. Keep dl=1 as a download hint for browsers that honor it.
 *
 * This is intentionally centralized here so the customer download button and
 * version-update screens use the same resolved URL without changing the URL
 * stored in the release policy.
 */
export function resolveDirectAppDownloadUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') return value;
    if (url.hostname === 'www.dropbox.com' || url.hostname === 'dropbox.com') {
      url.hostname = 'dl.dropboxusercontent.com';
      url.searchParams.set('dl', '1');
    }
    return url.toString();
  } catch {
    return value;
  }
}

export async function fetchAppReleasePolicy(channel: AppReleaseChannel): Promise<AppReleasePolicyResult> {
  const { data, error } = await invokeSupabaseRestGet<AppReleasePolicy>(
    'app_release_policies',
    'select=channel,latest_version,version_code,release_notes,download_url,grace_until,updated_at&channel=eq.' + channel + '&limit=1',
    undefined,
    true,
  );
  if (error) return { policy: null, error };
  const row = data?.[0];
  if (!row || row.channel !== channel || !parseAppVersion(row.latest_version)
      || !Number.isFinite(Number(row.version_code)) || !Number.isFinite(Date.parse(row.grace_until))) {
    return { policy: null, error: 'APP_RELEASE_POLICY_UNAVAILABLE' };
  }
  const policy: AppReleasePolicy = {
    ...row,
    download_url: resolveDirectAppDownloadUrl(row.download_url || ''),
  };
  return { policy, error: null };
}

export async function publishAppReleasePolicy(
  policy: Omit<AppReleasePolicy, 'updated_at' | 'updated_by'>,
): Promise<{ success: boolean; error: string | null }> {
  const parsed = parseAppVersion(policy.latest_version);
  if (!parsed || parsed.code !== Number(policy.version_code)) {
    return { success: false, error: 'إصدار التطبيق أو رقم البناء غير صالح.' };
  }
  if (policy.download_url) {
    try {
      const url = new URL(policy.download_url);
      if (url.protocol !== 'https:') return { success: false, error: 'رابط التحديث يجب أن يبدأ بـ HTTPS.' };
    } catch {
      return { success: false, error: 'رابط التحديث غير صالح.' };
    }
  }
  if (!Number.isFinite(Date.parse(policy.grace_until))) {
    return { success: false, error: 'موعد انتهاء السماح غير صالح.' };
  }
  const { error } = await invokeSupabaseRestUpsert<AppReleasePolicy>(
    'app_release_policies',
    { ...policy, updated_at: new Date().toISOString() },
    'channel',
  );
  if (error) return { success: false, error };
  return { success: true, error: null };
}

export function formatLocalDateTimeInput(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function defaultGraceDeadline(): string {
  return formatLocalDateTimeInput(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
}
