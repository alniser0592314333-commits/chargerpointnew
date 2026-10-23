import { createClient } from "npm:@supabase/supabase-js@2";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const respond = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers });
const normalize = (v: unknown, max = 128) => typeof v === "string" && v.length <= max ? v.trim() : "";
const claimsOf = (token: string) => {
  try {
    const part = token.split(".")[1];
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
  } catch { return null; }
};

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return respond(405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("auth_supabase_secret_key");
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
  if (!url || !serviceKey || !bearer) return respond(401, { ok: false, error: "UNAUTHORIZED" });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth, error: authError } = await admin.auth.getUser(bearer);
  if (authError || !auth.user) return respond(401, { ok: false, error: "UNAUTHORIZED" });
  const claims = claimsOf(bearer);
  const sessionId = normalize(claims?.session_id, 64);
  const now = new Date();
  let input: Record<string, unknown>;
  try { input = await request.json(); } catch { return respond(400, { ok: false, error: "INVALID_REQUEST" }); }
  const action = normalize(input.action, 48);

  const requireAdmin = async () => {
    const res = await fetch(url.replace(/\/+$/, "") + "/rest/v1/rpc/get_current_admin_profile", {
      method: "POST", headers: { apikey: serviceKey, Authorization: "Bearer " + bearer, "Content-Type": "application/json" }, body: "{}",
    });
    if (!res.ok) return false;
    const raw = await res.json().catch(() => null);
    const p = Array.isArray(raw) ? raw[0] : raw;
    const permissions = Array.isArray(p?.permissions) ? p.permissions : [];
    const allowed = p?.is_admin === true && p?.is_active !== false &&
      (p.role === "SUPER_ADMIN" || permissions.some((v: string) =>
        ["customers:edit","customers:write","customers:manage","customer_accounts:manage","customer_accounts:reset","admin:manage"].includes(v)));
    return allowed && typeof p.admin_id === "string" ? p.admin_id : null;
  };

  if (action === "admin-list" || action === "admin-review") {
    const administratorId = await requireAdmin();
    if (!administratorId) return respond(403, { ok: false, error: "FORBIDDEN" });
    if (action === "admin-list") {
      const { data, error } = await admin.from("customer_history_access_requests")
        .select("id,customer_id,status,requested_at,customers(name)").eq("status", "PENDING")
        .order("requested_at", { ascending: true });
      if (error) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      return respond(200, { ok: true, requests: data ?? [] });
    }
    const id = normalize(input.requestId, 64);
    const decision = normalize(input.decision, 16).toUpperCase();
    if (!/^[0-9a-f-]{36}$/i.test(id) || !["APPROVE","REJECT"].includes(decision)) return respond(400, { ok: false, error: "INVALID_REQUEST" });
    const { data: changed, error } = await admin.from("customer_history_access_requests").update({
      status: decision === "APPROVE" ? "APPROVED" : "REJECTED",
      reviewed_at: now.toISOString(),
      reviewed_by: administratorId,
      access_expires_at: decision === "APPROVE" ? new Date(now.getTime() + 86400000).toISOString() : null,
    }).eq("id", id).eq("status", "PENDING").select("id,customer_id,status,access_expires_at").maybeSingle();
    if (error || !changed) return respond(409, { ok: false, error: "REQUEST_NO_LONGER_PENDING" });
    const { error: eventError } = await admin.from("customer_account_events").insert({
      customer_id: changed.customer_id,
      event_type: decision === "APPROVE" ? "HISTORY_ACCESS_APPROVED" : "HISTORY_ACCESS_REJECTED",
      payload: { request_id: id, access_expires_at: changed.access_expires_at },
    });
    if (eventError) return respond(503, { ok: false, error: "DECISION_SAVED_NOTIFICATION_PENDING" });
    return respond(200, { ok: true, status: changed.status, access_expires_at: changed.access_expires_at });
  }

  const { data: link, error: linkError } = await admin.from("customer_account_links")
    .select("customer_id,auth_user_id,account_status,must_change_password,terms_version")
    .eq("auth_user_id", auth.user.id).maybeSingle();
  if (linkError || !link || link.account_status !== "ACTIVE" || link.must_change_password || link.terms_version !== "2026-10-18-v1") return respond(403, { ok: false, error: "ACCOUNT_UNAVAILABLE" });
  const { data: customer, error: customerError } = await admin.from("customers")
    .select("is_active,status,deleted_at").eq("id", link.customer_id).maybeSingle();
  if (customerError || !customer || customer.is_active !== true || customer.deleted_at || customer.status === "DELETED") {
    return respond(403, { ok: false, error: "ACCOUNT_UNAVAILABLE" });
  }
  const { data: session } = await admin.from("customer_account_sessions")
    .select("session_id,expires_at,revoked_at").eq("customer_id", link.customer_id)
    .eq("auth_user_id", auth.user.id).maybeSingle();
  if (!session || session.revoked_at || session.session_id !== sessionId || new Date(session.expires_at).getTime() <= now.getTime()) {
    return respond(401, { ok: false, error: "SESSION_EXPIRED" });
  }

  const { data: latest, error: latestError } = await admin.from("customer_history_access_requests")
    .select("id,status,access_expires_at").eq("customer_id", link.customer_id)
    .in("status", ["PENDING","APPROVED","REJECTED"]).order("requested_at", { ascending: false }).limit(1).maybeSingle();
  if (latestError) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });

  if (action === "status") {
    return respond(200, { ok: true, status: latest?.status ?? null,
      access_expires_at: latest?.status === "APPROVED" && latest.access_expires_at && new Date(latest.access_expires_at).getTime() > now.getTime() ? latest.access_expires_at : null });
  }
  if (action === "request") {
    if (latest?.status === "PENDING") return respond(200, { ok: true, status: "PENDING" });
    if (latest?.status === "APPROVED" && latest.access_expires_at && new Date(latest.access_expires_at).getTime() > now.getTime()) {
      return respond(200, { ok: true, status: "APPROVED", access_expires_at: latest.access_expires_at });
    }
    const { data: created, error } = await admin.from("customer_history_access_requests").insert({ customer_id: link.customer_id, status: "PENDING" }).select("id").single();
    if (error || !created) return respond(503, { ok: false, error: "REQUEST_FAILED" });
    const { error: eventError } = await admin.from("customer_account_events").insert({
      customer_id: link.customer_id, event_type: "HISTORY_ACCESS_REQUESTED", payload: { request_id: created.id },
    });
    if (eventError) return respond(503, { ok: false, error: "REQUEST_SAVED_NOTIFICATION_PENDING" });
    return respond(200, { ok: true, status: "PENDING" });
  }
  if (action === "history-orders") {
    const expiry = latest?.status === "APPROVED" ? latest.access_expires_at : null;
    if (!expiry || new Date(expiry).getTime() <= now.getTime()) return respond(403, { ok: false, error: "HISTORY_ACCESS_NOT_ACTIVE" });
    const { data: qr, error: qrError } = await admin.from("qr_tokens").select("public_token")
      .eq("target_id", link.customer_id).eq("token_type", "CUSTOMER").eq("is_active", true).limit(1).maybeSingle();
    if (qrError || !qr) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
    const { data: projection, error: projectionError } = await admin.rpc("public_resolve_customer_portal", {
      p_public_token: qr.public_token, p_include_history: true,
    });
    if (projectionError || !projection || !Array.isArray(projection.orders)) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
    return respond(200, { ok: true, orders: projection.orders, access_expires_at: expiry });
  }
  return respond(400, { ok: false, error: "UNKNOWN_ACTION" });
});