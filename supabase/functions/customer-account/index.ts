import { createClient } from "npm:@supabase/supabase-js@2";
import { CUSTOMER_ACCOUNT_TERMS_VERSION } from "../_shared/customerAccountTerms.ts";

const TERMS_VERSION = CUSTOMER_ACCOUNT_TERMS_VERSION;
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
  const common = new Set(["password", "password123", "12345678", "qwerty123", "11111111", "123456789", "1234567890", "qwertyuiop", "abc12345", "letmein123", "iloveyou", "admin123", "welcome1", "monkey123", "dragon123"]);
  return !common.has(value.trim().toLowerCase()) && !/^(.)(\1){7,}$/.test(value);
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
  const serviceUrl: string = url;
  const serviceSecret: string = secret;
  const publicApiKey: string = anonKey;

  const admin = createClient(serviceUrl, serviceSecret, { auth: { persistSession: false, autoRefreshToken: false } });
  const authClient = createClient(serviceUrl, publicApiKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > 16384) return respond(413, { ok: false, error: "REQUEST_TOO_LARGE" });
  const bodyText = await request.text();
  if (new TextEncoder().encode(bodyText).byteLength > 16384) return respond(413, { ok: false, error: "REQUEST_TOO_LARGE" });
  let input: (Json & { action?: string }) | null;
  try { input = JSON.parse(bodyText) as (Json & { action?: string }) | null; }
  catch { return respond(400, { ok: false, error: "INVALID_REQUEST" }); }
  if (!input || typeof input.action !== "string") return respond(400, { ok: false, error: "INVALID_REQUEST" });
  const action = input.action;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
  const now = new Date();

  async function resolveQr(rawToken: unknown) {
    const token = normalize(rawToken, 64);
    if (!token || !/^[A-Za-z0-9_-]+$/.test(token)) return null;

    // Customer UUIDs are login identifiers, not QR capabilities. They can only
    // identify the account; password/session checks remain mandatory.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
      const { data: customer, error: customerError } = await admin.from("customers")
        .select("id,name,is_active,status,deleted_at").eq("id", token).maybeSingle();
      if (customerError || !customer || customer.is_active !== true || customer.deleted_at ||
        customer.status === "DELETED") return null;
      return { token, customer, isQrToken: false };
    }

    // Only opaque public customer QR capabilities may authorize first-time activation.
    if (token.length >= 24) {
      const { data: qr, error: qrError } = await admin.from("qr_tokens")
        .select("target_id,expires_at").eq("public_token", token).eq("token_type", "CUSTOMER")
        .eq("is_active", true).maybeSingle();
      if (qrError || !qr || (qr.expires_at && new Date(qr.expires_at).getTime() <= Date.now())) return null;
      const { data: customer, error: customerError } = await admin.from("customers")
        .select("id,name,is_active,status,deleted_at").eq("id", qr.target_id).maybeSingle();
      if (customerError || !customer || customer.is_active !== true || customer.deleted_at ||
        customer.status === "DELETED") return null;
      return { token, customer, isQrToken: true };
    }

    return null;
  }

  async function getCustomerQrToken(customerId: string): Promise<string | null> {
    const { data } = await admin.from("qr_tokens")
      .select("public_token").eq("target_id", customerId).eq("token_type", "CUSTOMER")
      .eq("is_active", true).maybeSingle();
    return typeof data?.public_token === "string" && data.public_token.length >= 24
      ? data.public_token
      : null;
  }

  async function userFromBearer() {
    if (!bearer || bearer === anonKey) return null;
    const { data, error } = await admin.auth.getUser(bearer);
    return error || !data.user ? null : { user: data.user, claims: decodeClaims(bearer) };
  }

  async function linkForUser(userId: string) {
    const { data, error } = await admin.from("customer_account_links")
      .select("customer_id,auth_user_id,login_email,auth_provider,account_status,must_change_password,email_verified,terms_version")
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

  async function activeSessionExpiresAt(link: any, userId: string, claims: Record<string, unknown> | null): Promise<string | null> {
    const sessionId = normalize(claims?.session_id, 64);
    const { data: registered, error } = await admin.from("customer_account_sessions")
      .select("session_id,expires_at,revoked_at").eq("customer_id", link.customer_id)
      .eq("auth_user_id", userId).maybeSingle();
    if (error || !registered || registered.revoked_at || registered.session_id !== sessionId ||
      new Date(registered.expires_at).getTime() <= Date.now()) return null;
    return registered.expires_at;
  }

  async function sessionIsActive(link: any, userId: string, claims: Record<string, unknown> | null) {
    return Boolean(await activeSessionExpiresAt(link, userId, claims));
  }


  async function rateLimit(customerId: string, actionName: string, maxAttempts: number, windowSeconds: number, reset = false) {
    const { data, error } = await admin.rpc("customer_account_consume_rate_limit", {
      p_rate_key: customerId, p_action: actionName, p_max_attempts: maxAttempts,
      p_window_seconds: windowSeconds, p_reset: reset,
    });
    return !error && data === true;
  }

  async function requireAdmin() {
    const authenticated = await userFromBearer();
    if (!authenticated) return null;
    const response = await fetch(serviceUrl.replace(/\/+$/, "") + "/rest/v1/rpc/get_current_admin_profile", {
      method: "POST",
      headers: { apikey: serviceSecret, Authorization: "Bearer " + bearer, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) return null;
    const raw = await response.json().catch(() => null);
    const profile = Array.isArray(raw) ? raw[0] : raw;
    if (!profile || profile.is_admin !== true || profile.is_active === false) return null;
    const permissions = Array.isArray(profile.permissions) ? profile.permissions : [];
    const authorized = profile.role === "SUPER_ADMIN" ||
      permissions.includes("customers:edit") || permissions.includes("customers:write") ||
      permissions.includes("customers:manage") || permissions.includes("customer_accounts:manage") ||
      permissions.includes("customer_accounts:reset") || permissions.includes("admin:manage");
    if (!authorized) return null;
    return { adminId: typeof profile.admin_id === "string" ? profile.admin_id : null };
  }

  try {
    if (action === "resolve-order-customer-id") {
      const orderToken = normalize(input.token, 128);
      if (!orderToken || orderToken.length < 20 || !/^[A-Za-z0-9_-]+$/.test(orderToken)) return genericFailure();
      const { data: qr, error: qrError } = await admin.from("qr_tokens")
        .select("target_id,expires_at").eq("public_token", orderToken).eq("token_type", "ORDER")
        .eq("is_active", true).maybeSingle();
      if (qrError || !qr || (qr.expires_at && new Date(qr.expires_at).getTime() <= Date.now())) return genericFailure();
      const { data: order, error: orderError } = await admin.from("orders")
        .select("customer_id,deleted_at,cancelled_at").eq("id", qr.target_id).maybeSingle();
      if (orderError || !order || order.deleted_at || order.cancelled_at || !order.customer_id) return genericFailure();
      const { data: customer, error: customerError } = await admin.from("customers")
        .select("id,is_active,status,deleted_at").eq("id", order.customer_id).maybeSingle();
      if (customerError || !customer || customer.is_active !== true || customer.deleted_at || customer.status === "DELETED") return genericFailure();
      return respond(200, { ok: true, customer_id: customer.id });
    }

    if (action === "entry") {
      const resolved = await resolveQr(input.token);
      if (!resolved) return genericFailure();
      const { data: link, error } = await admin.from("customer_account_links")
        .select("account_status,must_change_password,email_verified,login_email,auth_provider,terms_version")
        .eq("customer_id", resolved.customer.id).maybeSingle();
      if (error) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      if (link && link.account_status !== "ACTIVE") return genericFailure();
      return respond(200, {
        ok: true, valid: true, activated: Boolean(link),
        customer_name: resolved.customer.name,
        email_recovery_available: Boolean(link?.email_verified && link?.login_email &&
          !String(link.login_email).endsWith(".invalid")),
        auth_provider: link?.auth_provider ?? null,
        terms_version: link?.terms_version ?? null,
      });
    }

    if (action === "activate-password") {
      const resolved = await resolveQr(input.token);
      const password = rawPassword(input.password);
      if (!resolved || !resolved.isQrToken || !(await rateLimit(resolved.customer.id, "ACTIVATE", 5, 3600)) ||
        !strongPassword(password) || input.confirmPassword !== password ||
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
        account_status: "ACTIVE", auth_provider: "password", must_change_password: false, email_verified: false,
        terms_version: TERMS_VERSION, terms_accepted_at: now.toISOString(), password_changed_at: now.toISOString(),
      });
      if (linkError) {
        await admin.auth.admin.deleteUser(created.user.id);
        return respond(409, { ok: false, error: "ACCOUNT_ALREADY_ACTIVATED" });
      }
      const { data: signedIn, error: signInError } = await authClient.auth.signInWithPassword({ email: loginEmail, password });
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
      await rateLimit(resolved.customer.id, "ACTIVATE", 5, 3600, true);
      return respond(200, { ok: true, session: signedIn.session, session_expires_at: await activeSessionExpiresAt(link, created.user.id, claims) });
    }

    if (action === "login") {
      const resolved = await resolveQr(input.token);
      const password = rawPassword(input.password);
      if (!resolved || !password || !(await rateLimit(resolved.customer.id, "LOGIN", 8, 900))) return genericFailure();
      const { data: link, error: linkError } = await admin.from("customer_account_links")
        .select("customer_id,auth_user_id,login_email,account_status,must_change_password,email_verified,terms_version,auth_provider")
        .eq("customer_id", resolved.customer.id).maybeSingle();
      if (linkError || !link || link.account_status !== "ACTIVE") return genericFailure();
      const { data: signedIn, error: signInError } = await authClient.auth.signInWithPassword({
        email: link.login_email, password,
      });
      if (signInError || !signedIn.session || signedIn.user?.id !== link.auth_user_id) return genericFailure();
      await rateLimit(resolved.customer.id, "LOGIN", 8, 900, true);
      const claims = decodeClaims(signedIn.session.access_token);
      if (!(await registerSession(link, signedIn.user.id, claims))) {
        return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      }
      return respond(200, {
        ok: true, session: signedIn.session, must_change_password: link.must_change_password,
        terms_version: link.terms_version, auth_provider: link.auth_provider,
        customer_qr_token: await getCustomerQrToken(resolved.customer.id),
        session_expires_at: await activeSessionExpiresAt(link, signedIn.user.id, claims),
      });
    }

    if (action === "activate-social") {
      const authenticated = await userFromBearer();
      const resolved = await resolveQr(input.token);
      if (!authenticated || !resolved || !resolved.isQrToken ||
        !(await rateLimit(resolved.customer.id, "SOCIAL_ACTIVATE", 5, 3600)) ||
        input.termsAccepted !== true || input.termsVersion !== TERMS_VERSION || !authenticated.user.email) return genericFailure();
      const { data: existing, error } = await admin.from("customer_account_links")
        .select("customer_id").eq("customer_id", resolved.customer.id).maybeSingle();
      if (error) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      if (existing) return respond(409, { ok: false, error: "ACCOUNT_ALREADY_ACTIVATED" });
      const { error: linkError } = await admin.from("customer_account_links").insert({
        customer_id: resolved.customer.id, auth_user_id: authenticated.user.id,
        login_email: authenticated.user.email.toLowerCase(),
        auth_provider: ["google", "apple", "facebook"].includes(String(authenticated.user.app_metadata?.provider))
          ? String(authenticated.user.app_metadata?.provider) : "password",
        account_status: "ACTIVE",
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
      await rateLimit(resolved.customer.id, "SOCIAL_ACTIVATE", 5, 3600, true);
      return respond(200, { ok: true, must_change_password: false, session_expires_at: await activeSessionExpiresAt(link, authenticated.user.id, authenticated.claims) });
    }

    if (action === "register-session" || action === "verify-session" || action === "portal-data" || action === "complete-password-change" || action === "logout" || action === "accept-terms") {
      const authenticated = await userFromBearer();
      if (!authenticated) return genericFailure();
      const link = await linkForUser(authenticated.user.id);
      if (!link) return genericFailure();

      if (action === "register-session") {
        const resolved = await resolveQr(input.token);
        const provider = normalize(authenticated.user.app_metadata?.provider, 32);
        if (!resolved || resolved.customer.id !== link.customer_id ||
          !["google", "apple", "facebook"].includes(provider) || link.auth_provider !== provider ||
          !(await registerSession(link, authenticated.user.id, authenticated.claims))) return genericFailure();
        return respond(200, {
          ok: true, customer_name: link.customer.name,
          auth_provider: link.auth_provider,
          terms_version: link.terms_version,
          must_change_password: link.must_change_password,
          session_expires_at: await activeSessionExpiresAt(link, authenticated.user.id, authenticated.claims),
          email_recovery_available: Boolean(link.email_verified && !String(link.login_email).endsWith(".invalid")),
        });
      }

      if (action === "verify-session") {
        const resolved = await resolveQr(input.token);
        if (!resolved || resolved.customer.id !== link.customer_id ||
          !(await sessionIsActive(link, authenticated.user.id, authenticated.claims))) return genericFailure();
        return respond(200, {
          ok: true, customer_name: link.customer.name,
          terms_version: link.terms_version,
          must_change_password: link.must_change_password,
          customer_qr_token: await getCustomerQrToken(link.customer_id),
          session_expires_at: await activeSessionExpiresAt(link, authenticated.user.id, authenticated.claims),
          email_recovery_available: Boolean(link.email_verified && !String(link.login_email).endsWith(".invalid")),
        });
      }

      if (action === "accept-terms") {
        const resolved = await resolveQr(input.token);
        if (!resolved || resolved.customer.id !== link.customer_id || input.termsAccepted !== true ||
          input.termsVersion !== TERMS_VERSION || !(await sessionIsActive(link, authenticated.user.id, authenticated.claims)) ||
          link.must_change_password) return genericFailure();
        const { error: termsError } = await admin.from("customer_account_links").update({
          terms_version: TERMS_VERSION, terms_accepted_at: now.toISOString(), updated_at: now.toISOString(),
        }).eq("customer_id", link.customer_id).eq("auth_user_id", authenticated.user.id);
        if (termsError) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
        const { error: eventError } = await admin.from("customer_account_events").insert({
          customer_id: link.customer_id, event_type: "TERMS_ACCEPTED",
          payload: { terms_version: TERMS_VERSION },
        });
        if (eventError) return respond(503, { ok: false, error: "TERMS_ACCEPTED_AUDIT_PENDING" });
        return respond(200, { ok: true, terms_version: TERMS_VERSION });
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
        return respond(200, { ok: true, session_expires_at: await activeSessionExpiresAt(link, authenticated.user.id, authenticated.claims), terms_version: link.terms_version });
      }

      const resolved = await resolveQr(input.token);
      if (!resolved || resolved.customer.id !== link.customer_id || link.must_change_password ||
        link.terms_version !== TERMS_VERSION) return genericFailure();
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
      const limitAction = action === "email-reset" ? "EMAIL_RESET" : "RESET_REQUEST";
      if (!(await rateLimit(resolved.customer.id, limitAction, 3, 3600))) {
        return respond(200, { ok: true, message: "If the account is eligible, the request has been recorded." });
      }
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
        let allowedRedirect: string | undefined;
        const configuredOrigins = (Deno.env.get("CUSTOMER_PORTAL_ORIGINS") || "")
          .split(",").map((value) => value.trim()).filter(Boolean);
        const allowedOrigins = new Set<string>();
        for (const configuredOrigin of configuredOrigins) {
          try {
            const parsedOrigin = new URL(configuredOrigin);
            if (parsedOrigin.origin === configuredOrigin && parsedOrigin.pathname === "/" &&
                parsedOrigin.search === "" && parsedOrigin.hash === "") {
              allowedOrigins.add(parsedOrigin.origin);
            }
          } catch { /* Invalid configured origins are ignored; recovery fails closed. */ }
        }
        try {
          const parsedRedirect = new URL(redirectTo);
          if (allowedOrigins.has(parsedRedirect.origin) && parsedRedirect.pathname === "/c/" + resolved.token &&
              parsedRedirect.search === "?customer_recovery=1" && parsedRedirect.hash === "") {
            allowedRedirect = parsedRedirect.toString();
          }
        } catch { allowedRedirect = undefined; }
        if (!allowedRedirect) return respond(503, { ok: false, error: "EMAIL_RECOVERY_UNAVAILABLE" });
        const { error: mailError } = await authClient.auth.resetPasswordForEmail(link.login_email, {
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
        .in("status", ["PENDING", "PROCESSING"]).lt("expires_at", now.toISOString());
      const { data: requests, error: requestError } = await admin.from("customer_account_reset_requests")
        .select("id,customer_id,status,requested_at,expires_at,customers(name)")
        .eq("status", "PENDING").gt("expires_at", now.toISOString()).order("requested_at", { ascending: true });
      const { data: events, error: eventError } = await admin.from("customer_account_events")
        .select("id,customer_id,event_type,request_id,is_read,created_at,customers(name)")
        .order("created_at", { ascending: false }).limit(50);
      const { data: accounts, error: accountsError } = await admin.from("customer_account_links")
        .select("customer_id,account_status,auth_provider,must_change_password,created_at,customers(name)")
        .order("created_at", { ascending: false }).limit(200);
      if (requestError || eventError || accountsError) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      return respond(200, { ok: true, requests: requests ?? [], events: events ?? [], accounts: accounts ?? [] });
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
      const { error: requireChangeError } = await admin.from("customer_account_links")
        .update({ must_change_password: true, updated_at: now.toISOString() })
        .eq("customer_id", claimed.customer_id);
      if (requireChangeError) {
        await admin.from("customer_account_reset_requests").update({ status: "PENDING" })
          .eq("id", requestId).eq("status", "PROCESSING");
        return respond(503, { ok: false, error: "PASSWORD_RESET_FAILED" });
      }
      const { error: revokeError } = await admin.from("customer_account_sessions")
        .update({ revoked_at: now.toISOString() }).eq("customer_id", claimed.customer_id).is("revoked_at", null);
      if (revokeError) {
        await admin.from("customer_account_links").update({ must_change_password: false, updated_at: now.toISOString() })
          .eq("customer_id", claimed.customer_id);
        await admin.from("customer_account_reset_requests").update({ status: "PENDING" })
          .eq("id", requestId).eq("status", "PROCESSING");
        return respond(503, { ok: false, error: "PASSWORD_RESET_FAILED" });
      }
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

    if (action === "admin-set-status") {
      const administrator = await requireAdmin();
      if (!administrator) return respond(403, { ok: false, error: "FORBIDDEN" });
      const customerId = normalize(input.customerId, 64);
      const nextStatus = normalize(input.status, 16);
      if (!/^[0-9a-f-]{36}$/i.test(customerId) || !["ACTIVE", "FROZEN", "CANCELLED"].includes(nextStatus)) {
        return respond(400, { ok: false, error: "INVALID_REQUEST" });
      }
      const { data: account, error: accountError } = await admin.from("customer_account_links")
        .select("customer_id,account_status").eq("customer_id", customerId).maybeSingle();
      if (accountError || !account) return genericFailure();
      const { error: updateError } = await admin.from("customer_account_links")
        .update({ account_status: nextStatus, updated_at: now.toISOString() }).eq("customer_id", customerId);
      if (updateError) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      if (nextStatus !== "ACTIVE") {
        const { error: revokeError } = await admin.from("customer_account_sessions")
          .update({ revoked_at: now.toISOString() }).eq("customer_id", customerId).is("revoked_at", null);
        if (revokeError) {
          // The frozen account status itself blocks every subsequent server-side read.
          console.error("Customer session revocation needs reconciliation");
          return respond(503, { ok: false, error: "STATUS_APPLIED_SESSION_REVOCATION_PENDING" });
        }
      }
      const eventType = nextStatus === "FROZEN" ? "ACCOUNT_FROZEN" : nextStatus === "CANCELLED" ? "ACCOUNT_CANCELLED" : "ACCOUNT_REACTIVATED";
      const { error: eventError } = await admin.from("customer_account_events").insert({
        customer_id: customerId, event_type: eventType,
        payload: { previous_status: account.account_status, next_status: nextStatus },
      });
      if (eventError) return respond(503, { ok: false, error: "STATUS_APPLIED_AUDIT_PENDING" });
      return respond(200, { ok: true, account_status: nextStatus });
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
