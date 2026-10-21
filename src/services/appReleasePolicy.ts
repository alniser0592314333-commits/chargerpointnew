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

export async function fetchAppReleasePolicy(channel: AppReleaseChannel): Promise<AppReleasePolicyResult> {
  const { data, error } = await invokeSupabaseRestGet<AppReleasePolicy>(
    'app_release_policies',
    'select=channel,latest_version,version_code,release_notes,download_url,grace_until,updated_at&channel=eq.' + channel + '&limit=1',
    undefined,
    true,
  );
  if (error) return { policy: null, error };
  const policy = data?.[0];
  if (!policy || policy.channel !== channel || !parseAppVersion(policy.latest_version)
      || !Number.isFinite(Number(policy.version_code)) || !Number.isFinite(Date.parse(policy.grace_until))) {
    return { policy: null, error: 'APP_RELEASE_POLICY_UNAVAILABLE' };
  }
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
