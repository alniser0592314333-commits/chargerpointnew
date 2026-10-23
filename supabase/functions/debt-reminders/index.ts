import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const respond = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return respond(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("auth_supabase_secret_key");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
  if (!url || !serviceKey || !anonKey || !bearer) return respond(401, { ok: false, error: "UNAUTHORIZED" });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(bearer);
  if (authError || !authData.user) return respond(401, { ok: false, error: "UNAUTHORIZED" });

  const profileResponse = await fetch(url.replace(/\/+$/, "") + "/rest/v1/rpc/get_current_admin_profile", {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: "Bearer " + bearer, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!profileResponse.ok) return respond(403, { ok: false, error: "FORBIDDEN" });
  const profileRaw = await profileResponse.json().catch(() => null);
  const profile = Array.isArray(profileRaw) ? profileRaw[0] : profileRaw;
  const permissions = Array.isArray(profile?.permissions) ? profile.permissions : [];
  const allowed = profile?.is_admin === true && profile?.is_active !== false &&
    (profile.role === "SUPER_ADMIN" || permissions.some((p: string) =>
      ["customers:edit", "customers:write", "customers:manage", "customer_accounts:manage", "customer_accounts:reset", "admin:manage"].includes(p)));
  if (!allowed) return respond(403, { ok: false, error: "FORBIDDEN" });

  const { data: sentCount, error } = await admin.rpc("dispatch_customer_debt_reminders", {
    p_reminder_key: "manual-" + crypto.randomUUID(),
    p_force: true,
  });
  if (error || typeof sentCount !== "number") {
    console.error("Manual debt reminder dispatch failed");
    return respond(503, { ok: false, error: "REMINDER_SEND_FAILED" });
  }
  return respond(200, { ok: true, sent_count: sentCount });
});