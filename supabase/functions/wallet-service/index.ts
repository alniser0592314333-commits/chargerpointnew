import { createClient } from "npm:@supabase/supabase-js@2";
import { CUSTOMER_ACCOUNT_TERMS_VERSION } from "../_shared/customerAccountTerms.ts";

const TERMS_VERSION = CUSTOMER_ACCOUNT_TERMS_VERSION;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
type Json = Record<string, unknown>;
const respond = (status: number, body: Json) => new Response(JSON.stringify(body), { status, headers: corsHeaders });
const normalize = (value: unknown, max = 256) => typeof value === "string" && value.length <= max ? value.trim() : "";
const genericFailure = () => respond(401, { ok: false, error: "ACCOUNT_UNAVAILABLE_OR_INVALID" });
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
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > 16384) return respond(413, { ok: false, error: "REQUEST_TOO_LARGE" });
  const bodyText = await request.text();
  if (new TextEncoder().encode(bodyText).byteLength > 16384) return respond(413, { ok: false, error: "REQUEST_TOO_LARGE" });
  let input: Json & { action?: string };
  try { input = JSON.parse(bodyText) as Json & { action?: string }; }
  catch { return respond(400, { ok: false, error: "INVALID_REQUEST" }); }
  if (!input || typeof input.action !== "string") return respond(400, { ok: false, error: "INVALID_REQUEST" });
  const action = input.action;
  if (!["wallet-activation-status", "wallet-request-activation", "wallet-management-access", "wallet-snapshot", "wallet-create-account", "wallet-record-transaction"].includes(action)) {
    return respond(404, { ok: false, error: "UNKNOWN_WALLET_ACTION" });
  }
  if (!bearer || bearer === anonKey) return genericFailure();
  const { data: authData, error: authError } = await admin.auth.getUser(bearer);
  if (authError || !authData.user) return genericFailure();
  const claims = decodeClaims(bearer);
  const { data: link, error: linkError } = await admin.from("customer_account_links")
    .select("customer_id,auth_user_id,account_status,must_change_password,terms_version")
    .eq("auth_user_id", authData.user.id).maybeSingle();
  if (linkError || !link || link.auth_user_id !== authData.user.id || link.account_status !== "ACTIVE") return genericFailure();
  const { data: customer, error: customerError } = await admin.from("customers")
    .select("id,name,is_active,status,deleted_at").eq("id", link.customer_id).maybeSingle();
  if (customerError || !customer || customer.is_active !== true || customer.deleted_at || customer.status === "DELETED") return genericFailure();
  const sessionId = normalize(claims?.session_id, 64);
  const { data: registered, error: sessionError } = await admin.from("customer_account_sessions")
    .select("session_id,auth_user_id,expires_at,revoked_at")
    .eq("customer_id", link.customer_id).eq("auth_user_id", authData.user.id).eq("session_id", sessionId).maybeSingle();
  if (sessionError || !registered || registered.revoked_at || registered.session_id !== sessionId ||
    new Date(registered.expires_at).getTime() <= Date.now() || link.must_change_password ||
    link.terms_version !== TERMS_VERSION) return genericFailure();
  // Activation request/status are available to an authenticated customer before
  // entitlement is granted. Financial wallet operations remain behind the entitlement.
  if (action === "wallet-activation-status") {
    const { data: entitlement, error: entitlementError } = await admin.from("wallet_service_entitlements")
      .select("enabled").eq("customer_id", link.customer_id).eq("service_key", "wallet_management").maybeSingle();
    const { data: requests, error: requestError } = await admin.from("wallet_activation_requests")
      .select("id,status,requested_at,decided_at,rejection_reason")
      .eq("customer_id", link.customer_id).order("requested_at", { ascending: false }).limit(1);
    if (entitlementError || requestError) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
    const latest = requests?.[0] ?? null;
    return respond(200, {
      ok: true,
      wallet_management_enabled: entitlement?.enabled === true,
      request: latest ? {
        id: latest.id, status: latest.status, requested_at: latest.requested_at,
        decided_at: latest.decided_at, rejection_reason: latest.rejection_reason,
      } : null,
    });
  }
  if (action === "wallet-request-activation") {
    const { data: entitlement, error: entitlementError } = await admin.from("wallet_service_entitlements")
      .select("enabled").eq("customer_id", link.customer_id).eq("service_key", "wallet_management").maybeSingle();
    if (entitlementError) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
    if (entitlement?.enabled === true) return respond(200, { ok: true, status: "APPROVED", wallet_management_enabled: true });
    const { data: pending, error: pendingError } = await admin.from("wallet_activation_requests")
      .select("id,status,requested_at").eq("customer_id", link.customer_id).eq("status", "PENDING").maybeSingle();
    if (pendingError) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
    if (pending) return respond(200, { ok: true, status: "PENDING", request: pending, already_pending: true });
    const { data: created, error: createError } = await admin.from("wallet_activation_requests")
      .insert({ customer_id: link.customer_id, status: "PENDING" })
      .select("id,status,requested_at").single();
    if (createError) {
      if (createError.code === "23505") {
        const { data: raced } = await admin.from("wallet_activation_requests")
          .select("id,status,requested_at").eq("customer_id", link.customer_id).eq("status", "PENDING").maybeSingle();
        if (raced) return respond(200, { ok: true, status: "PENDING", request: raced, already_pending: true });
      }
      console.error("Wallet activation request could not be recorded", createError.code ?? "unknown");
      return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
    }
    const { error: eventError } = await admin.from("customer_account_events").insert({
      customer_id: link.customer_id,
      event_type: "WALLET_ACTIVATION_REQUESTED",
      payload: { wallet_activation_request_id: created.id },
    });
    if (eventError) {
      // Keep the request durable, but report that notification delivery needs attention.
      console.error("Wallet activation request saved but admin notification event failed");
      return respond(503, { ok: false, error: "REQUEST_SAVED_NOTIFICATION_PENDING", request: created });
    }
    return respond(200, { ok: true, status: "PENDING", request: created });
  }

  const { data: entitlement, error: entitlementError } = await admin.from("wallet_service_entitlements")
    .select("enabled").eq("customer_id", link.customer_id).eq("service_key", "wallet_management").maybeSingle();
  if (entitlementError) return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
  if (!entitlement || entitlement.enabled !== true) return respond(403, { ok: false, error: "SERVICE_NOT_ENABLED" });
  if (action === "wallet-management-access") {
    return respond(200, { ok: true, wallet_management_enabled: true, customer_name: customer.name });
  }
  if (action === "wallet-snapshot") {
    const limit = Number(input.limit ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return respond(400, { ok: false, error: "INVALID_WALLET_QUERY" });
    const before = input.before == null ? null : normalize(input.before, 64);
    if (before && !Number.isFinite(Date.parse(before))) return respond(400, { ok: false, error: "INVALID_WALLET_QUERY" });
    const { data, error } = await admin.rpc("wallet_get_snapshot", { p_customer_id: link.customer_id, p_limit: limit, p_before: before });
    if (error || !data || data.ok !== true) {
      console.error("Wallet snapshot unavailable", error?.code ?? "unknown");
      return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
    }
    return respond(200, { ok: true, snapshot: data });
  }
  if (action === "wallet-create-account") {
    const provider = normalize(input.provider, 32);
    const walletNumber = normalize(input.walletNumber, 64);
    const displayName = normalize(input.displayName, 120);
    const currency = normalize(input.currency ?? "ILS", 3).toUpperCase();
    if (!["PalPay", "Jawwal Pay", "Bank of Palestine"].includes(provider) || !walletNumber || !displayName ||
      !["ILS", "USD", "JOD"].includes(currency)) return respond(400, { ok: false, error: "INVALID_WALLET_ACCOUNT" });
    const { data, error } = await admin.from("wallet_accounts").insert({
      customer_id: link.customer_id, provider, wallet_number: walletNumber, display_name: displayName, currency, is_active: true,
    }).select("id,provider,wallet_number,display_name,currency,is_active,created_at").single();
    if (error) {
      if (error.code === "23505") return respond(409, { ok: false, error: "WALLET_ACCOUNT_EXISTS" });
      console.error("Wallet account creation failed", error.code ?? "unknown");
      return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
    }
    return respond(200, { ok: true, account: data });
  }
  const transactionType = normalize(input.transactionType, 16);
  const sourceWalletId = input.sourceWalletId == null ? null : normalize(input.sourceWalletId, 36);
  const destinationWalletId = input.destinationWalletId == null ? null : normalize(input.destinationWalletId, 36);
  const amountMinor = Number(input.amountMinor);
  const currency = normalize(input.currency, 3).toUpperCase();
  const idempotencyKey = normalize(input.idempotencyKey, 36);
  const reference = input.reference == null ? null : normalize(input.reference, 160);
  const note = input.note == null ? null : normalize(input.note, 1000);
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!["INCOME", "EXPENSE", "TRANSFER"].includes(transactionType) ||
    (sourceWalletId !== null && !uuidPattern.test(sourceWalletId)) ||
    (destinationWalletId !== null && !uuidPattern.test(destinationWalletId)) ||
    !Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !["ILS", "USD", "JOD"].includes(currency) ||
    !uuidPattern.test(idempotencyKey) || (reference !== null && reference.length > 160) || (note !== null && note.length > 1000)) {
    return respond(400, { ok: false, error: "INVALID_WALLET_TRANSACTION" });
  }
  const { data, error } = await admin.rpc("wallet_record_transaction", {
    p_customer_id: link.customer_id, p_actor_auth_user_id: authData.user.id,
    p_transaction_type: transactionType, p_source_wallet_id: sourceWalletId,
    p_destination_wallet_id: destinationWalletId, p_amount_minor: amountMinor,
    p_currency: currency, p_idempotency_key: idempotencyKey, p_reference: reference, p_note: note,
  });
  if (error || !data || data.ok !== true) {
    const code = error?.message ?? "";
    if (code.includes("INSUFFICIENT_WALLET_BALANCE")) return respond(409, { ok: false, error: "INSUFFICIENT_WALLET_BALANCE" });
    if (code.includes("IDEMPOTENCY_KEY_REUSED")) return respond(409, { ok: false, error: "IDEMPOTENCY_KEY_REUSED" });
    if (code.includes("WALLET_SERVICE_NOT_ENABLED")) return respond(403, { ok: false, error: "SERVICE_NOT_ENABLED" });
    if (code.includes("SOURCE_WALLET_UNAVAILABLE") || code.includes("DESTINATION_WALLET_UNAVAILABLE")) return respond(400, { ok: false, error: "WALLET_UNAVAILABLE" });
    console.error("Wallet transaction failed", error?.code ?? "unknown");
    return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
  }
  return respond(200, { ok: true, transaction: data });
});
