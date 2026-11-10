
import { config } from "../config/env";
import { getFreshSupabaseAuthToken } from "./supabase/client";

export interface PublicAnnouncement {
  id: string;
  title: string;
  body: string;
  image_url: string | null;
  starts_at: string;
  ends_at: string;
  is_enabled?: boolean;
}

const endpoint = () => config.supabaseUrl
  ? `${config.supabaseUrl.replace(/\/+$/, "")}/functions/v1/public-announcements`
  : null;

export async function fetchPublicAnnouncements(): Promise<PublicAnnouncement[]> {
  const url = endpoint();
  if (!url || (typeof navigator !== "undefined" && !navigator.onLine)) return [];
  const response = await fetch(url, { headers: { apikey: config.supabaseAnonKey }, cache: "no-store" });
  if (!response.ok) throw new Error("ANNOUNCEMENTS_READ_FAILED");
  const data = await response.json();
  return Array.isArray(data.announcements) ? data.announcements : [];
}

export async function managePublicAnnouncement(payload: Record<string, unknown>): Promise<any> {
  const url = endpoint();
  if (!url) throw new Error("SUPABASE_NOT_CONFIGURED");
  const auth = await getFreshSupabaseAuthToken();
  if (!auth.token) throw new Error(auth.reason || "ADMIN_AUTH_REQUIRED");
  const response = await fetch(url, {
    method: "POST",
    headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "ANNOUNCEMENT_SAVE_FAILED");
  return result;
}
