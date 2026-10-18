import { createClient } from "npm:@supabase/supabase-js@2";

const TERMS_VERSION = "2026-10-18-v1";
const SESSION_DAYS = 7;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
type Json = Record<string, unknown>;
const respond = (status: number, body: Json) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });
const genericFailure = () => respond(401, { ok: false, error: "ACCOUNT_UNAVAILABLE_OR_INVALID" });
const normalize = (value: unknown, max = 256) =>
  typeof value === "string" && value.length <= max ? value.trim() : "";
const rawPassword = (value: unknown) => typeof value === "string" && value.length <= 128 ? value : "";
const strongPassword = (value: string) => {
  if (value.length < 8 || value.length > 128) return false;
  const common = new Set(["password", "password123", "12345678", "qwerty123", "11111111", "123456789"]);
  return !common.has(value.toLowerCase()) && !/^(.)(\1){7,}$/.test(value);
};
const decodeClaims = (jwt: string): Record<string, unknown> | null => {
  try {
    const part = jwt.split(".")[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
  } catch { return null; }
};

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return respond(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  const url = Deno.env.get("SUPABASE_URL");
  const secret = Deno.env.get("auth_supabase_secret_key") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!url || !secret || !anonKey) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });

  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const input = await request.json().catch(() => null) as (Json & { action?: string }) | null;
  if (!input || typeof input.action !== "string") return respond(400, { ok: false, error: "INVALID_REQUEST" });
  const action = input.action;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
  const now = new Date();

  async function resolveQr(rawToken: unknown) {
    const token = normalize(rawToken, 64);
    if (token.length < 24 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const { data: qr, error: qrError } = await admin.from("qr_tokens")
      .select("target_id,expires_at").eq("public_token", token).eq("token_type", "CUSTOMER")
      .eq("is_active", true).maybeSingle();
    if (qrError || !qr || (qr.expires_at && new Date(qr.expires_at).getTime() <= Date.now())) return null;
    const { data: customer, error: customerError } = await admin.from("customers")
      .select("id,name,is_active,status,deleted_at").eq("id", qr.target_id).maybeSingle();
    if (customerError || !customer || customer.is_active !== true || customer.deleted_at ||
      customer.status === "DELETED") return null;
    return { token, customer };
  }

  async function userFromBearer() {
    if (!bearer || bearer === anonKey) return null;
    const { data, error } = await admin.auth.getUser(bearer);
    return error || !data.user ? null : { user: data.user, claims: decodeClaims(bearer) };
  }

  async function linkForUser(userId: string) {
    const { data, error } = await admin.from("customer_account_links")
      .select("customer_id,auth_user_id,login_email,account_status,must_change_password,email_verified")
      .eq("auth_user_id", userId).maybeSingle();
    if (error || !data) return null;
    const { data: customer, error: customerError } = await admin.from("customers")
      .select("id,name,is_active,status,deleted_at").eq("id", data.customer_id).maybeSingle();
    if (customerError || !customer || customer.is_active !== true || customer.deleted_at ||
      customer.status === "DELETED" || data.account_status !== "ACTIVE") return null;
    return { ...data, customer };
  }

  async function registerSession(link: any, userId: string, claims: Record<string, unknown> | null) {
    const sessionId = normalize(claims?.session_id, 64);
    const issuedAt = Number(claims?.iat);
    if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !Number.isSafeInteger(issuedAt) || issuedAt <= 0) return false;
    const { data: existing, error: existingError } = await admin.from("customer_account_sessions")
      .select("session_id,auth_issued_at,expires_at,revoked_at")
      .eq("customer_id", link.customer_id).maybeSingle();
    if (existingError) return false;
    if (existing && existing.session_id === sessionId) {
      return existing.revoked_at == null && new Date(existing.expires_at).getTime() > Date.now();
    }
    // A stale, previously issued access token cannot reclaim the single-device slot.
    // A newly authenticated session must have a strictly newer Auth-issued iat.
    if (existing && issuedAt <= Number(existing.auth_issued_at)) return false;
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await admin.from("customer_account_sessions").upsert({
      customer_id: link.customer_id, auth_user_id: userId, session_id: sessionId,
      auth_issued_at: issuedAt, created_at: now.toISOString(), expires_at: expiresAt, revoked_at: null,
    }, { onConflict: "customer_id" });
    return !error;
  }

  async function sessionIsActive(link: any, userId: string, claims: Record<string, unknown> | null) {
    const sessionId = normalize(claims?.session_id, 64);
    const { data: registered, error } = await admin.from("customer_account_sessions")
      .select("session_id,expires_at,revoked_at").eq("customer_id", link.customer_id)
      .eq("auth_user_id", userId).maybeSingle();
    return !error && Boolean(registered) && !registered.revoked_at &&
      registered.session_id === sessionId && new Date(registered.expires_at).getTime() > Date.now();
  }

  async function requireAdmin() {
    const authenticated = await userFromBearer();
    if (!authenticated) return null;
    const response = await fetch(url.replace(/\/+$/, "") + "/rest/v1/rpc/get_current_admin_profile", {
      method: "POST",
      headers: { apikey: secret, Authorization: "Bearer " + bearer, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) return null;
    const raw = await response.json().catch(() => null);
    const profile = Array.isArray(raw) ? raw[0] : raw;
    if (!profile || profile.is_admin !== true || profile.is_active === false) return null;
    const permissions = Array.isArray(profile.permissions) ? profile.permissions : [];
    const authorized = profile.role === "SUPER_ADMIN" ||
      permissions.includes("customers:edit") || permissions.includes("customers:write") ||
      permissions.includes("admin:manage");
    if (!authorized) return null;
    return { adminId: typeof profile.admin_id === "string" ? profile.admin_id : null };
  }

  try {
    if (action === "entry") {
      const resolved = await resolveQr(input.token);
      if (!resolved) return genericFailure();
      const { data: link, error } = await admin.from("customer_account_links")
        .select("account_status,must_change_password,email_verified,login_email")
        .eq("customer_id", resolved.customer.id).maybeSingle();
      if (error) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      if (link && link.account_status !== "ACTIVE") return genericFailure();
      return respond(200, {
        ok: true, valid: true, activated: Boolean(link),
        customer_name: resolved.customer.name,
        email_recovery_available: Boolean(link?.email_verified && link?.login_email &&
          !String(link.login_email).endsWith(".invalid")),
      });
    }

    if (action === "activate-password") {
      const resolved = await resolveQr(input.token);
      const password = rawPassword(input.password);
      if (!resolved || !strongPassword(password) || input.confirmPassword !== password ||
        input.termsAccepted !== true || input.termsVersion !== TERMS_VERSION) return genericFailure();
      const { data: existing, error: existingError } = await admin.from("customer_account_links")
        .select("customer_id").eq("customer_id", resolved.customer.id).maybeSingle();
      if (existingError) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      if (existing) return respond(409, { ok: false, error: "ACCOUNT_ALREADY_ACTIVATED" });
      const loginEmail = "cp-customer-" + resolved.customer.id + "@accounts.chargerpoint.invalid";
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email: loginEmail, password, email_confirm: true,
        user_metadata: { account_type: "customer" },
      });
      if (createError || !created.user) {
        console.error("Customer account activation failed", createError?.status ?? "unknown");
        return respond(503, { ok: false, error: "ACTIVATION_UNAVAILABLE" });
      }
      const { error: linkError } = await admin.from("customer_account_links").insert({
        customer_id: resolved.customer.id, auth_user_id: created.user.id, login_email: loginEmail,
        account_status: "ACTIVE", must_change_password: false, email_verified: false,
        terms_version: TERMS_VERSION, terms_accepted_at: now.toISOString(), password_changed_at: now.toISOString(),
      });
      if (linkError) {
        await admin.auth.admin.deleteUser(created.user.id);
        return respond(409, { ok: false, error: "ACCOUNT_ALREADY_ACTIVATED" });
      }
      const { data: signedIn, error: signInError } = await admin.auth.signInWithPassword({ email: loginEmail, password });
      if (signInError || !signedIn.session) {
        await admin.from("customer_account_links").delete().eq("customer_id", resolved.customer.id);
        await admin.auth.admin.deleteUser(created.user.id);
        return respond(503, { ok: false, error: "ACTIVATION_UNAVAILABLE" });
      }
      const claims = decodeClaims(signedIn.session.access_token);
      const { data: link } = await admin.from("customer_account_links").select("customer_id").eq("customer_id", resolved.customer.id).single();
      if (!link || !(await registerSession(link, created.user.id, claims))) {
        await admin.from("customer_account_links").delete().eq("customer_id", resolved.customer.id);
        await admin.auth.admin.deleteUser(created.user.id);
        return respond(503, { ok: false, error: "ACTIVATION_UNAVAILABLE" });
      }
      return respond(200, { ok: true, session: signedIn.session });
    }

    if (action === "login") {
      const resolved = await resolveQr(input.token);
      const password = normalize(input.password, 128);
      if (!resolved || !password) return genericFailure();
      const { data: link, error: linkError } = await admin.from("customer_account_links")
        .select("customer_id,auth_user_id,login_email,account_status,must_change_password,email_verified")
        .eq("customer_id", resolved.customer.id).maybeSingle();
      if (linkError || !link || link.account_status !== "ACTIVE") return genericFailure();
      const { data: signedIn, error: signInError } = await admin.auth.signInWithPassword({
        email: link.login_email, password,
      });
      if (signInError || !signedIn.session || signedIn.user?.id !== link.auth_user_id) return genericFailure();
      const claims = decodeClaims(signedIn.session.access_token);
      if (!(await registerSession(link, signedIn.user.id, claims))) {
        return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      }
      return respond(200, { ok: true, session: signedIn.session, must_change_password: link.must_change_password });
    }

    if (action === "activate-social") {
      const authenticated = await userFromBearer();
      const resolved = await resolveQr(input.token);
      if (!authenticated || !resolved || input.termsAccepted !== true ||
        input.termsVersion !== TERMS_VERSION || !authenticated.user.email) return genericFailure();
      const { data: existing, error } = await admin.from("customer_account_links")
        .select("customer_id").eq("customer_id", resolved.customer.id).maybeSingle();
      if (error) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      if (existing) return respond(409, { ok: false, error: "ACCOUNT_ALREADY_ACTIVATED" });
      const { error: linkError } = await admin.from("customer_account_links").insert({
        customer_id: resolved.customer.id, auth_user_id: authenticated.user.id,
        login_email: authenticated.user.email.toLowerCase(), account_status: "ACTIVE",
        must_change_password: false, email_verified: Boolean(authenticated.user.email_confirmed_at),
        terms_version: TERMS_VERSION, terms_accepted_at: now.toISOString(), password_changed_at: now.toISOString(),
      });
      if (linkError) return respond(409, { ok: false, error: "ACCOUNT_ALREADY_ACTIVATED" });
      const { data: link } = await admin.from("customer_account_links")
        .select("customer_id").eq("customer_id", resolved.customer.id).single();
      if (!link || !(await registerSession(link, authenticated.user.id, authenticated.claims))) {
        await admin.from("customer_account_links").delete().eq("customer_id", resolved.customer.id);
        return respond(503, { ok: false, error: "ACTIVATION_UNAVAILABLE" });
      }
      return respond(200, { ok: true, must_change_password: false });
    }

    if (action === "register-session" || action === "verify-session" || action === "portal-data" || action === "complete-password-change" || action === "logout") {
      const authenticated = await userFromBearer();
      if (!authenticated) return genericFailure();
      const link = await linkForUser(authenticated.user.id);
      if (!link) return genericFailure();

      if (action === "register-session") {
        if (!(await registerSession(link, authenticated.user.id, authenticated.claims))) return genericFailure();
        return respond(200, {
          ok: true, customer_name: link.customer.name,
          must_change_password: link.must_change_password,
          email_recovery_available: Boolean(link.email_verified && !String(link.login_email).endsWith(".invalid")),
        });
      }

      if (action === "verify-session") {
        if (!(await sessionIsActive(link, authenticated.user.id, authenticated.claims))) return genericFailure();
        return respond(200, {
          ok: true, customer_name: link.customer.name,
          must_change_password: link.must_change_password,
          email_recovery_available: Boolean(link.email_verified && !String(link.login_email).endsWith(".invalid")),
        });
      }

      if (action === "logout") {
        const { error } = await admin.from("customer_account_sessions").update({ revoked_at: now.toISOString() })
          .eq("customer_id", link.customer_id).eq("auth_user_id", authenticated.user.id)
          .eq("session_id", normalize(authenticated.claims?.session_id, 64));
        return error ? respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" }) : respond(200, { ok: true });
      }

      if (action === "complete-password-change") {
        const methods = Array.isArray(authenticated.claims?.amr)
          ? (authenticated.claims!.amr as unknown[]).map((item) =>
              typeof item === "string" ? item : item && typeof item === "object" && "method" in item ? String((item as { method: unknown }).method) : "")
          : [];
        const recoverySession = methods.includes("recovery");
        if (!recoverySession && !(await sessionIsActive(link, authenticated.user.id, authenticated.claims))) return genericFailure();
        if (recoverySession && !link.email_verified) return genericFailure();
        const { error: updateError } = await admin.from("customer_account_links").update({
          must_change_password: false, password_changed_at: now.toISOString(), updated_at: now.toISOString(),
        }).eq("customer_id", link.customer_id).eq("auth_user_id", authenticated.user.id);
        if (updateError) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
        await admin.from("customer_account_events").insert({ customer_id: link.customer_id, event_type: "PASSWORD_CHANGED" });
        if (!(await registerSession(link, authenticated.user.id, authenticated.claims))) {
          return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
        }
        return respond(200, { ok: true });
      }

      const resolved = await resolveQr(input.token);
      if (!resolved || resolved.customer.id !== link.customer_id || link.must_change_password) return genericFailure();
      const { data: registered, error: sessionError } = await admin.from("customer_account_sessions")
        .select("session_id,expires_at,revoked_at").eq("customer_id", link.customer_id).eq("auth_user_id", authenticated.user.id).maybeSingle();
      const currentSessionId = normalize(authenticated.claims?.session_id, 64);
      if (sessionError || !registered || registered.revoked_at ||
        registered.session_id !== currentSessionId || new Date(registered.expires_at).getTime() <= Date.now()) return genericFailure();
      const { data: qr, error: qrError } = await admin.from("qr_tokens")
        .select("public_token").eq("target_id", link.customer_id).eq("token_type", "CUSTOMER")
        .eq("is_active", true).limit(1).maybeSingle();
      if (qrError || !qr) return genericFailure();
      const { data: projection, error: projectionError } = await admin.rpc("public_resolve_customer_portal", {
        p_public_token: qr.public_token,
      });
      if (projectionError || !projection) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      return respond(200, { ok: true, data: projection });
    }

    if (action === "request-reset" || action === "email-reset") {
      const resolved = await resolveQr(input.token);
      if (!resolved) return respond(200, { ok: true, message: "If the account is eligible, the request has been recorded." });
      const { data: link, error } = await admin.from("customer_account_links")
        .select("customer_id,login_email,email_verified,account_status")
        .eq("customer_id", resolved.customer.id).maybeSingle();
      if (error || !link || link.account_status !== "ACTIVE") {
        return respond(200, { ok: true, message: "If the account is eligible, the request has been recorded." });
      }
      if (action === "email-reset") {
        if (!link.email_verified || String(link.login_email).endsWith(".invalid")) {
          return respond(200, { ok: true, message: "If a verified email is available, a reset link will be sent." });
        }
        const redirectTo = normalize(input.redirectTo, 512);
        const safeRedirect = /^https:\/\/ais-(?:dev|pre)-ysj6qxp5jjdotuhhmuwlez-886408646256\.europe-west2\.run\.app\/c\/[A-Za-z0-9_-]+\?customer_recovery=1$/.test(redirectTo)
          || /^http:\/\/localhost:3000\/c\/[A-Za-z0-9_-]+\?customer_recovery=1$/.test(redirectTo);
        const allowedRedirect = safeRedirect ? redirectTo : undefined;
        const { error: mailError } = await admin.auth.resetPasswordForEmail(link.login_email, {
          ...(allowedRedirect ? { redirectTo: allowedRedirect } : {}),
        });
        if (mailError) {
          console.error("Customer email recovery could not be initiated");
          return respond(503, { ok: false, error: "EMAIL_RECOVERY_UNAVAILABLE" });
        }
        await admin.from("customer_account_sessions").update({ revoked_at: now.toISOString() }).eq("customer_id", link.customer_id);
        await admin.from("customer_account_events").insert({ customer_id: link.customer_id, event_type: "EMAIL_RESET_SENT" });
        return respond(200, { ok: true });
      }
      await admin.from("customer_account_reset_requests").update({ status: "EXPIRED" })
        .eq("customer_id", link.customer_id).in("status", ["PENDING", "PROCESSING"]).lt("expires_at", now.toISOString());
      const { data: created, error: createError } = await admin.from("customer_account_reset_requests")
        .insert({ customer_id: link.customer_id, status: "PENDING" }).select("id").single();
      if (createError) {
        // One active request per customer. A duplicate click remains an idempotent success.
        if (createError.code === "23505") return respond(200, { ok: true });
        return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      }
      await admin.from("customer_account_events").insert({
        customer_id: link.customer_id, event_type: "RESET_REQUESTED", request_id: created.id,
      });
      return respond(200, { ok: true });
    }

    if (action === "admin-list") {
      const administrator = await requireAdmin();
      if (!administrator) return respond(403, { ok: false, error: "FORBIDDEN" });
      await admin.from("customer_account_reset_requests").update({ status: "EXPIRED" })
        .eq("status", "PENDING").lt("expires_at", now.toISOString());
      const { data: requests, error: requestError } = await admin.from("customer_account_reset_requests")
        .select("id,customer_id,status,requested_at,expires_at,customers(name)")
        .eq("status", "PENDING").gt("expires_at", now.toISOString()).order("requested_at", { ascending: true });
      const { data: events, error: eventError } = await admin.from("customer_account_events")
        .select("id,customer_id,event_type,request_id,is_read,created_at,customers(name)")
        .order("created_at", { ascending: false }).limit(50);
      if (requestError || eventError) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      return respond(200, { ok: true, requests: requests ?? [], events: events ?? [] });
    }

    if (action === "admin-reset") {
      const administrator = await requireAdmin();
      if (!administrator) return respond(403, { ok: false, error: "FORBIDDEN" });
      const requestId = normalize(input.requestId, 64);
      const temporaryPassword = rawPassword(input.temporaryPassword);
      if (!/^[0-9a-f-]{36}$/i.test(requestId) || !strongPassword(temporaryPassword)) {
        return respond(400, { ok: false, error: "INVALID_REQUEST" });
      }
      const { data: claimed, error: claimError } = await admin.from("customer_account_reset_requests")
        .update({ status: "PROCESSING" }).eq("id", requestId).eq("status", "PENDING")
        .gt("expires_at", now.toISOString()).select("id,customer_id").maybeSingle();
      if (claimError || !claimed) return respond(409, { ok: false, error: "REQUEST_NO_LONGER_PENDING" });
      const { data: link, error: linkError } = await admin.from("customer_account_links")
        .select("auth_user_id").eq("customer_id", claimed.customer_id).eq("account_status", "ACTIVE").maybeSingle();
      if (linkError || !link) {
        await admin.from("customer_account_reset_requests").update({ status: "REJECTED", processed_at: now.toISOString(), processed_by: administrator.adminId }).eq("id", requestId);
        return respond(409, { ok: false, error: "ACCOUNT_UNAVAILABLE" });
      }
      await admin.from("customer_account_links").update({ must_change_password: true, updated_at: now.toISOString() })
        .eq("customer_id", claimed.customer_id);
      await admin.from("customer_account_sessions").update({ revoked_at: now.toISOString() })
        .eq("customer_id", claimed.customer_id);
      const { error: passwordError } = await admin.auth.admin.updateUserById(link.auth_user_id, { password: temporaryPassword });
      if (passwordError) {
        await admin.from("customer_account_links").update({ must_change_password: false, updated_at: now.toISOString() }).eq("customer_id", claimed.customer_id);
        await admin.from("customer_account_reset_requests").update({ status: "PENDING" }).eq("id", requestId).eq("status", "PROCESSING");
        return respond(503, { ok: false, error: "PASSWORD_RESET_FAILED" });
      }
      const { error: finishError } = await admin.from("customer_account_reset_requests").update({
        status: "APPROVED", processed_at: now.toISOString(), processed_by: administrator.adminId,
      }).eq("id", requestId).eq("status", "PROCESSING");
      if (finishError) return respond(503, { ok: false, error: "RESET_APPLIED_CONFIRMATION_PENDING" });
      await admin.from("customer_account_events").insert({
        customer_id: claimed.customer_id, event_type: "TEMP_PASSWORD_ISSUED", request_id: requestId,
      });
      return respond(200, { ok: true });
    }

    if (action === "admin-mark-event-read") {
      const administrator = await requireAdmin();
      if (!administrator) return respond(403, { ok: false, error: "FORBIDDEN" });
      const eventId = normalize(input.eventId, 64);
      if (!/^[0-9a-f-]{36}$/i.test(eventId)) return respond(400, { ok: false, error: "INVALID_REQUEST" });
      const { error } = await admin.from("customer_account_events").update({
        is_read: true, read_at: now.toISOString(), read_by: administrator.adminId,
      }).eq("id", eventId);
      return error ? respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" }) : respond(200, { ok: true });
    }

    return respond(400, { ok: false, error: "UNKNOWN_ACTION" });
  } catch (error) {
    console.error("Customer account operation failed", action, error instanceof Error ? error.name : "unknown");
    return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
  }
});
