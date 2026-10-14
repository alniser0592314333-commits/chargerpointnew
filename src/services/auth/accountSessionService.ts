import { invokeSupabaseRpc } from "../supabase/client";

export interface AccountSession {
  session_id: string;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  is_current: boolean;
}

export interface SessionDeviceDescription {
  device: string;
  browser: string;
  operatingSystem: string;
}

export function describeSessionUserAgent(userAgent: string | null | undefined): SessionDeviceDescription {
  const ua = userAgent || "";
  const lower = ua.toLowerCase();

  let operatingSystem = "Unknown OS";
  if (/windows nt/i.test(ua)) operatingSystem = "Windows";
  else if (/android/i.test(ua)) operatingSystem = "Android";
  else if (/(iphone|ipad|ipod)/i.test(ua)) operatingSystem = "iOS";
  else if (/macintosh|mac os x/i.test(ua)) operatingSystem = "macOS";
  else if (/linux/i.test(ua)) operatingSystem = "Linux";

  let browser = "Unknown browser";
  if (/edg\//i.test(ua)) browser = "Microsoft Edge";
  else if (/samsungbrowser\//i.test(ua)) browser = "Samsung Internet";
  else if (/opr\//i.test(ua) || /opera/i.test(ua)) browser = "Opera";
  else if (/firefox\//i.test(ua)) browser = "Firefox";
  else if (/crios\//i.test(ua)) browser = "Chrome (iOS)";
  else if (/chrome\//i.test(ua) && !/edg\//i.test(ua)) browser = "Google Chrome";
  else if (/safari\//i.test(ua) && !/chrome\//i.test(ua)) browser = "Safari";

  let device = "Computer";
  if (/ipad|tablet/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) device = "Tablet";
  else if (/mobile|iphone|ipod|android/i.test(ua)) device = "Mobile";
  else if (!ua) device = "Unknown device";

  // Avoid returning or displaying the raw user-agent string to the user.
  void lower;
  return { device, browser, operatingSystem };
}

function getBrowserUserAgent(): string | null {
  return typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 1000) : null;
}

export async function registerCurrentAccountSession(): Promise<void> {
  const { error } = await invokeSupabaseRpc("register_my_account_session", {
    p_user_agent: getBrowserUserAgent(),
  });
  if (error) throw new Error(error);
}

export async function getAccountSessions(): Promise<AccountSession[]> {
  const { data, error } = await invokeSupabaseRpc<AccountSession[]>("get_my_account_sessions");
  if (error) throw new Error(error);
  if (!Array.isArray(data)) throw new Error("Unexpected session-list response");
  return data;
}

export async function isCurrentAccountSessionActive(): Promise<boolean> {
  const { data, error } = await invokeSupabaseRpc<boolean>("is_my_account_session_active");
  if (error) throw new Error(error);
  return data === true;
}

export async function revokeAccountSession(sessionId: string): Promise<{ revoked_current: boolean }> {
  const { data, error } = await invokeSupabaseRpc<{ success: boolean; revoked_current?: boolean }>(
    "revoke_my_account_session",
    { p_session_id: sessionId },
  );
  if (error) throw new Error(error);
  if (!data?.success) throw new Error("Session revocation was not confirmed");
  return { revoked_current: data.revoked_current === true };
}

export async function revokeOtherAccountSessions(): Promise<number> {
  const { data, error } = await invokeSupabaseRpc<{ success: boolean; revoked_count?: number }>(
    "revoke_other_account_sessions",
  );
  if (error) throw new Error(error);
  if (!data?.success) throw new Error("Revocation of other sessions was not confirmed");
  return Number(data.revoked_count || 0);
}

export async function revokeAllAccountSessions(): Promise<number> {
  const { data, error } = await invokeSupabaseRpc<{ success: boolean; revoked_count?: number; revoked_current?: boolean }>(
    "revoke_all_account_sessions",
  );
  if (error) throw new Error(error);
  if (!data?.success || data.revoked_current !== true) {
    throw new Error("Revocation of all sessions was not confirmed");
  }
  return Number(data.revoked_count || 0);
}
