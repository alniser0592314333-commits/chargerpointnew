import { createClient } from "npm:@supabase/supabase-js@2.117.2";

type Json = Record<string, unknown>;
type Variant = "admin" | "customer";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-push-dispatch-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const json = (status: number, body: Json) => new Response(JSON.stringify(body), { status, headers: corsHeaders });
const normalize = (value: unknown, max = 256) =>
  typeof value === "string" && value.length <= max ? value.trim() : "";
const formatMoney = (minor: unknown, locale: string) => {
  const value = Number(minor);
  if (!Number.isFinite(value)) return locale === "en" ? "an unspecified amount" : "مبلغ غير محدد";
  return new Intl.NumberFormat(locale === "en" ? "en-GB" : "ar-PS", {
    style: "currency", currency: "ILS", minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(value / 100);
};
const formatDate = (value: unknown, locale: string) => {
  const date = new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime())) return locale === "en" ? "date unavailable" : "التاريخ غير متاح";
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "ar-PS", {
    timeZone: "Asia/Gaza", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: true,
  }).format(date);
};
const decodeClaims = (token: string): Record<string, unknown> | null => {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
  } catch { return null; }
};
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const encode = (value: string) => base64url(new TextEncoder().encode(value));

let cachedGoogleToken: { value: string; expiresAt: number } | null = null;
async function getGoogleAccessToken() {
  if (cachedGoogleToken && cachedGoogleToken.expiresAt > Date.now() + 60_000) return cachedGoogleToken.value;
  const projectId = Deno.env.get("FCM_PROJECT_ID") || "";
  const clientEmail = Deno.env.get("FCM_CLIENT_EMAIL") || "";
  const privateKeyPem = (Deno.env.get("FCM_PRIVATE_KEY") || "").replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKeyPem.includes("PRIVATE KEY")) throw new Error("FCM_NOT_CONFIGURED");
  const pem = privateKeyPem.replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "").replace(/\s/g, "");
  const binary = Uint8Array.from(atob(pem), (char) => char.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey(
    "pkcs8", binary, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const unsigned = encode(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + encode(JSON.stringify({
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(unsigned)));
  const assertion = unsigned + "." + base64url(signature);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.access_token !== "string") throw new Error("FCM_OAUTH_FAILED");
  cachedGoogleToken = { value: result.access_token, expiresAt: Date.now() + Number(result.expires_in || 3600) * 1000 };
  return cachedGoogleToken.value;
}

async function sendFcm(token: string, projectId: string, title: string, body: string, eventId: string, targetPath: string) {
  const accessToken = await getGoogleAccessToken();
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
    method: "POST",
    headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        data: { eventId, targetPath },
        android: {
          priority: "HIGH",
          notification: { channel_id: "charging-point-events", tag: eventId, click_action: "FCM_PLUGIN_ACTIVITY" },
        },
      },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = Array.isArray(result?.error?.details) ? result.error.details : [];
    const errorInfo = details.find((item: Record<string, unknown>) =>
      typeof item["@type"] === "string" && String(item["@type"]).includes("ErrorInfo"));
    const typedCode = details.find((item: Record<string, unknown>) => typeof item.errorCode === "string");
    const code = String(typedCode?.errorCode ?? errorInfo?.reason ?? result?.error?.status ?? "UNKNOWN");
    const providerMessage = String(result?.error?.message ?? "No provider message")
      .replace(/\\s+/g, " ").slice(0, 180);
    throw Object.assign(new Error("FCM_SEND_FAILED"), {
      status: response.status, code, providerMessage,
    });
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("auth_supabase_secret_key");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!url || !serviceKey || !anonKey) return json(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > 8192) return json(413, { ok: false, error: "REQUEST_TOO_LARGE" });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 8192) return json(413, { ok: false, error: "REQUEST_TOO_LARGE" });
  let input: Json;
  try { input = JSON.parse(raw) as Json; } catch { return json(400, { ok: false, error: "INVALID_REQUEST" }); }
  const action = normalize(input.action, 16);
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: bearer ? { Authorization: "Bearer " + bearer } : {} },
  });

  if (action === "register" || action === "unregister") {
    if (!bearer || bearer === anonKey) return json(401, { ok: false, error: "AUTH_REQUIRED" });
    const { data: authResult, error: authError } = await admin.auth.getUser(bearer);
    const user = authResult?.user;
    if (authError || !user) return json(401, { ok: false, error: "AUTH_REQUIRED" });
    const device = normalize(input.deviceId, 64);
    const variant = normalize(input.appVariant, 16) as Variant;
    const platform = normalize(input.platform, 16);
    const token = normalize(input.token, 4096);
    if (!/^[0-9a-f-]{36}$/i.test(device) || !["admin", "customer"].includes(variant) ||
        !["android", "ios"].includes(platform) || (action === "register" && token.length < 32)) {
      return json(400, { ok: false, error: "INVALID_REQUEST" });
    }
    const claims = decodeClaims(bearer);
    const sessionId = normalize(claims?.session_id, 64);
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return json(403, { ok: false, error: "ACTIVE_SESSION_REQUIRED" });
    let principalId = "";
    let customerId: string | null = null;

    if (variant === "admin") {
      const { data: active, error: activeError } = await supabase.rpc("is_active_admin_session");
      const { data: profile, error: profileError } = await supabase.rpc("get_current_admin_profile");
      const row = Array.isArray(profile) ? profile[0] : profile;
      if (activeError || active !== true || profileError || !row?.is_admin || !row?.admin_id) {
        return json(403, { ok: false, error: "ACTIVE_ADMIN_SESSION_REQUIRED" });
      }
      principalId = String(row.admin_id);
    } else {
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return json(403, { ok: false, error: "ACTIVE_CUSTOMER_SESSION_REQUIRED" });
      const { data: link, error: linkError } = await admin.from("customer_account_links")
        .select("customer_id,account_status,auth_user_id")
        .eq("auth_user_id", user.id).eq("account_status", "ACTIVE").maybeSingle();
      if (linkError || !link) return json(403, { ok: false, error: "ACTIVE_CUSTOMER_SESSION_REQUIRED" });
      const { data: session, error: sessionError } = await admin.from("customer_account_sessions")
        .select("session_id,expires_at,revoked_at").eq("customer_id", link.customer_id)
        .eq("auth_user_id", user.id).eq("session_id", sessionId).maybeSingle();
      if (sessionError || !session || session.revoked_at || session.session_id !== sessionId ||
          new Date(session.expires_at).getTime() <= Date.now()) {
        return json(403, { ok: false, error: "ACTIVE_CUSTOMER_SESSION_REQUIRED" });
      }
      const { data: customer, error: customerError } = await admin.from("customers")
        .select("id,is_active,status,deleted_at").eq("id", link.customer_id).maybeSingle();
      if (customerError || !customer || customer.is_active !== true || customer.deleted_at || customer.status === "DELETED") {
        return json(403, { ok: false, error: "ACTIVE_CUSTOMER_SESSION_REQUIRED" });
      }
      principalId = user.id;
      customerId = String(link.customer_id);
    }

    if (action === "unregister") {
      const { error } = await admin.from("native_push_devices").delete()
        .eq("device_id", device).eq("app_variant", variant).eq("principal_id", principalId);
      return error ? json(503, { ok: false, error: "SERVICE_UNAVAILABLE" }) : json(200, { ok: true });
    }

    const locale = normalize(input.locale, 8) === "en" ? "en" : "ar";
    const { data: existingDevice, error: existingDeviceError } = await admin.from("native_push_devices")
      .select("id").eq("device_id", device).eq("app_variant", variant)
      .eq("principal_id", principalId).maybeSingle();
    if (existingDeviceError) return json(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
    if (!existingDevice) {
      const { count, error: countError } = await admin.from("native_push_devices")
        .select("id", { count: "exact", head: true })
        .eq("app_variant", variant).eq("principal_id", principalId).is("disabled_at", null);
      if (countError) return json(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      if ((count ?? 0) >= 5) return json(429, { ok: false, error: "DEVICE_LIMIT_REACHED" });
    }
    const now = new Date().toISOString();
    // Rebind only after the caller's active server-side session has been verified.
    const { error: removeError } = await admin.from("native_push_devices").delete()
      .eq("device_id", device).eq("app_variant", variant).eq("principal_id", principalId);
    if (removeError) return json(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
    const { error: upsertError } = await admin.from("native_push_devices").upsert({
      device_id: device,
      token,
      app_variant: variant,
      principal_id: principalId,
      customer_id: customerId,
      auth_session_id: sessionId || null,
      platform,
      locale,
      created_at: now,
      updated_at: now,
      last_seen_at: now,
      disabled_at: null,
    }, { onConflict: "token" });
    if (upsertError) return json(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
    return json(200, { ok: true });
  }

  const suppliedSecret = request.headers.get("x-push-dispatch-secret") || "";
  if (!suppliedSecret || suppliedSecret.length > 256) {
    return json(401, { ok: false, error: "UNAUTHORIZED" });
  }
  const { data: secretValid, error: secretCheckError } = await admin.rpc(
    "verify_native_push_dispatch_secret",
    { p_secret: suppliedSecret },
  );
  if (secretCheckError || secretValid !== true) {
    return json(401, { ok: false, error: "UNAUTHORIZED" });
  }

  if (action !== "dispatch") return json(400, { ok: false, error: "UNKNOWN_ACTION" });
  const source = normalize(input.source, 64);
  const recordId = normalize(input.recordId, 64);
  const operation = normalize(input.operation, 16);
  const eventStatus = normalize(input.newStatus, 64);
  if (!/^[0-9a-f-]{36}$/i.test(recordId) ||
      !["qr_payment_submissions", "customer_account_events", "goal_requests", "orders", "financial_ledger"].includes(source) ||
      !["INSERT", "UPDATE"].includes(operation)) return json(400, { ok: false, error: "INVALID_EVENT" });

  let recipients: Array<Record<string, unknown>> = [];
  let titleAr = "";
  let titleEn = "";
  let bodyAr = "";
  let bodyEn = "";
  let targetPath = "/app/notifications";
  let eventKey = source + ":" + recordId;
  let allowRevokedCustomerNotice = false;

  if (source === "qr_payment_submissions") {
    const { data: submission, error } = await admin.from("qr_payment_submissions")
      .select("id,customer_id,status,created_at,amount_minor,reviewed_at").eq("id", recordId).maybeSingle();
    if (error || !submission || (eventStatus && eventStatus !== String(submission.status))) return json(200, { ok: true, skipped: true });
    if (operation === "INSERT" && submission.status === "PENDING") {
      titleAr = "طلب دفع جديد • " + formatMoney(submission.amount_minor, "ar");
      titleEn = "New payment • " + formatMoney(submission.amount_minor, "en");
      bodyAr = "قيمة الدفعة: " + formatMoney(submission.amount_minor, "ar") + "\nتاريخ الإرسال: " + formatDate(submission.created_at, "ar") + "\nبانتظار مراجعة الإدارة.";
      bodyEn = "Amount: " + formatMoney(submission.amount_minor, "en") + "\nSubmitted: " + formatDate(submission.created_at, "en") + "\nWaiting for administrator review.";
      targetPath = "/app/notifications";
    } else if (operation === "UPDATE" && ["APPROVED", "REJECTED"].includes(String(submission.status))) {
      eventKey += ":" + submission.status;
      titleAr = submission.status === "APPROVED"
        ? "تم اعتماد دفعتك • " + formatMoney(submission.amount_minor, "ar")
        : "لم يتم اعتماد الدفعة";
      titleEn = submission.status === "APPROVED"
        ? "Payment approved • " + formatMoney(submission.amount_minor, "en")
        : "Payment not approved";
      bodyAr = submission.status === "APPROVED"
        ? "قيمة الدفعة: " + formatMoney(submission.amount_minor, "ar") + "\nتاريخ الدفعة: " + formatDate(submission.created_at, "ar") + "\nتم تحديث حسابك."
        : "لم يتم اعتماد دفعتك. افتح التطبيق لمراجعة التفاصيل.";
      bodyEn = submission.status === "APPROVED"
        ? "Amount: " + formatMoney(submission.amount_minor, "en") + "\nPayment date: " + formatDate(submission.created_at, "en") + "\nYour account has been updated."
        : "Your payment was not approved. Open the app for details.";
      targetPath = "/public/about";
      const { data, error: recipientError } = await admin.from("native_push_devices")
        .select("id,device_id,token,locale,app_variant,principal_id,customer_id")
        .eq("app_variant", "customer").eq("customer_id", submission.customer_id).is("disabled_at", null);
      if (recipientError) return json(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      recipients = data ?? [];
    } else {
      return json(200, { ok: true, skipped: true });
    }
  } else if (source === "customer_account_events") {
    const { data: event, error } = await admin.from("customer_account_events")
      .select("id,customer_id,event_type,created_at,is_read").eq("id", recordId).maybeSingle();
    if (error || !event || (eventStatus && eventStatus !== String(event.event_type))) return json(200, { ok: true, skipped: true });
    const eventType = String(event.event_type || "");
    eventKey += ":" + eventType;
    if (eventType === "RESET_REQUESTED") {
      titleAr = "طلب إعادة تعيين كلمة المرور";
      titleEn = "Password reset request";
      bodyAr = "يوجد طلب جديد بانتظار مراجعة الإدارة.";
      bodyEn = "A new request is waiting for administrator review.";
      targetPath = "/app/notifications";
      const { data, error: recipientError } = await admin.from("native_push_devices")
        .select("id,device_id,token,locale,app_variant,principal_id,customer_id")
        .eq("app_variant", "admin").is("disabled_at", null);
      if (recipientError) return json(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      recipients = data ?? [];
    } else {
      const messages: Record<string, [string, string, string, string]> = {
        TEMP_PASSWORD_ISSUED: ["تمت الموافقة على إعادة تعيين كلمة المرور", "Password reset approved", "راجع تعليمات الدخول الآمن في حسابك.", "Review the secure sign-in instructions in your account."],
        ACCOUNT_FROZEN: ["تم إيقاف الحساب مؤقتًا", "Account temporarily frozen", "تواصل مع الإدارة لمعرفة التفاصيل.", "Contact the administrator for details."],
        ACCOUNT_CANCELLED: ["تم إلغاء الحساب", "Account cancelled", "تواصل مع الإدارة إذا كنت تعتقد أن هذا خطأ.", "Contact the administrator if you believe this is an error."],
        ACCOUNT_REACTIVATED: ["تمت إعادة تفعيل الحساب", "Account reactivated", "يمكنك تسجيل الدخول مجددًا.", "You can sign in again."],
        PASSWORD_CHANGED: ["تم تغيير كلمة المرور", "Password changed", "تم تسجيل تغيير كلمة المرور لحسابك.", "A password change was recorded for your account."],
        EMAIL_RESET_SENT: ["تم إرسال رابط استعادة كلمة المرور", "Password recovery link sent", "تحقق من بريدك الإلكتروني.", "Check your email for the recovery link."],
      };
      const message = messages[eventType];
      if (!message) return json(200, { ok: true, skipped: true });
      allowRevokedCustomerNotice = ["TEMP_PASSWORD_ISSUED", "EMAIL_RESET_SENT", "ACCOUNT_FROZEN", "ACCOUNT_CANCELLED", "ACCOUNT_REACTIVATED"].includes(eventType);
      titleAr = message[0]; titleEn = message[1]; bodyAr = message[2]; bodyEn = message[3];
      targetPath = "/public/about";
      const { data, error: recipientError } = await admin.from("native_push_devices")
        .select("id,device_id,token,locale,app_variant,principal_id,customer_id")
        .eq("app_variant", "customer").eq("customer_id", event.customer_id).is("disabled_at", null);
      if (recipientError) return json(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      recipients = data ?? [];
    }
  } else if (source === "goal_requests") {
    const { data: goalRequest, error } = await admin.from("goal_requests")
      .select("id,customer_id,status,updated_at").eq("id", recordId).maybeSingle();
    if (error || !goalRequest || (eventStatus && eventStatus !== String(goalRequest.status))) {
      return json(200, { ok: true, skipped: true });
    }
    if (operation === "INSERT" && goalRequest.status === "PENDING") {
      eventKey += ":PENDING";
      titleAr = "طلب هدف جديد";
      titleEn = "New goal request";
      bodyAr = "أرسل أحد العملاء طلب إنشاء هدف جديد بانتظار المراجعة.";
      bodyEn = "A customer submitted a new goal request for review.";
      targetPath = "/app/goals";
      const { data, error: recipientError } = await admin.from("native_push_devices")
        .select("id,device_id,token,locale,app_variant,principal_id,customer_id")
        .eq("app_variant", "admin").is("disabled_at", null);
      if (recipientError) return json(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      recipients = data ?? [];
    } else if (operation === "UPDATE" && ["APPROVED", "REJECTED"].includes(String(goalRequest.status))) {
      eventKey += ":" + String(goalRequest.status);
      titleAr = goalRequest.status === "APPROVED" ? "تمت الموافقة على طلب الهدف" : "تم رفض طلب الهدف";
      titleEn = goalRequest.status === "APPROVED" ? "Goal request approved" : "Goal request rejected";
      bodyAr = goalRequest.status === "APPROVED" ? "وافقت الإدارة على طلب إنشاء الهدف." : "لم تتم الموافقة على طلب إنشاء الهدف.";
      bodyEn = goalRequest.status === "APPROVED" ? "The administrator approved your goal request." : "The administrator did not approve your goal request.";
      targetPath = "/public/about";
      const { data, error: recipientError } = await admin.from("native_push_devices")
        .select("id,device_id,token,locale,app_variant,principal_id,customer_id")
        .eq("app_variant", "customer").eq("customer_id", goalRequest.customer_id).is("disabled_at", null);
      if (recipientError) return json(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      recipients = data ?? [];
    } else {
      return json(200, { ok: true, skipped: true });
    }
  } else if (source === "financial_ledger") {
    const { data: entry, error } = await admin.from("financial_ledger")
      .select("id,customer_id,event_type,amount_minor,reference_id,created_at")
      .eq("id", recordId).maybeSingle();
    if (operation !== "INSERT" || error || !entry || entry.event_type !== "PAYMENT" || !entry.customer_id ||
        (eventStatus && eventStatus !== String(entry.event_type))) {
      return json(200, { ok: true, skipped: true });
    }
    // QR-approved payments already have their own approval notification. Suppress
    // the ledger event for those rows to avoid duplicate customer pushes.
    if (entry.reference_id) {
      const { data: qrLinked, error: qrLinkError } = await admin.from("qr_payment_submissions")
        .select("id").eq("payment_id", entry.reference_id).limit(1);
      if (qrLinkError) return json(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      if (qrLinked?.length) return json(200, { ok: true, skipped: true, reason: "QR_PAYMENT_ALREADY_NOTIFIED" });
    }
    eventKey += ":MANUAL_PAYMENT";
    titleAr = "تم شحن رصيدك • " + formatMoney(entry.amount_minor, "ar");
    titleEn = "Your balance was topped up • " + formatMoney(entry.amount_minor, "en");
    bodyAr = "قيمة الشحن: " + formatMoney(entry.amount_minor, "ar") + "\nتاريخ الشحن: " + formatDate(entry.created_at, "ar");
    bodyEn = "Amount added: " + formatMoney(entry.amount_minor, "en") + "\nDate: " + formatDate(entry.created_at, "en");
    targetPath = "/public/about";
    const { data, error: recipientError } = await admin.from("native_push_devices")
      .select("id,device_id,token,locale,app_variant,principal_id,customer_id")
      .eq("app_variant", "customer").eq("customer_id", entry.customer_id).is("disabled_at", null);
    if (recipientError) return json(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
    recipients = data ?? [];
  } else {
    const { data: order, error: orderError } = await admin.from("orders")
      .select("id,customer_id").eq("id", recordId).maybeSingle();
    if (orderError || !order || !order.customer_id || order.deleted_at) return json(200, { ok: true, skipped: true });
    if (operation === "INSERT" && eventStatus === "CREATED") {
      eventKey += ":CREATED";
      titleAr = "تم إنشاء طلب شحن جديد"; titleEn = "A new charging order was created";
      bodyAr = "تم تسجيل طلب شحن جديد لحسابك."; bodyEn = "A new charging order has been added to your account.";
    } else if (operation === "UPDATE" && eventStatus === "DELIVERED") {
      const { data: items, error: itemsError } = await admin.from("order_items")
        .select("id,operational_status,deleted_at,cancelled_at").eq("order_id", recordId);
      if (itemsError || !items) return json(200, { ok: true, skipped: true });
      const activeItems = items.filter((item) => !item.deleted_at && !item.cancelled_at);
      if (!activeItems.length || activeItems.some((item) => item.operational_status !== "DELIVERED")) return json(200, { ok: true, skipped: true });
      eventKey += ":DELIVERED";
      titleAr = "تم تسليم طلب الشحن"; titleEn = "Charging order delivered";
      bodyAr = "تم تسليم طلب الشحن وتحديث حالته."; bodyEn = "Your charging order has been delivered and its status updated.";
    } else {
      return json(200, { ok: true, skipped: true });
    }
    targetPath = "/public/about";
    const { data, error: recipientError } = await admin.from("native_push_devices")
      .select("id,device_id,token,locale,app_variant,principal_id,customer_id")
      .eq("app_variant", "customer").eq("customer_id", order.customer_id).is("disabled_at", null);
    if (recipientError) return json(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
    recipients = data ?? [];
  }

  if (!recipients.length && targetPath === "/app/notifications") {
    const { data, error } = await admin.from("native_push_devices")
      .select("id,device_id,token,locale,app_variant,principal_id,customer_id")
      .eq("app_variant", "admin").is("disabled_at", null);
    if (error) return json(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
    recipients = data ?? [];
  }
  const projectId = Deno.env.get("FCM_PROJECT_ID") || "";
  if (!projectId) return json(503, { ok: false, error: "PUSH_PROVIDER_NOT_CONFIGURED" });
  let sent = 0;
  let failed = 0;
  for (const recipient of recipients) {
    const deviceRowId = String(recipient.id ?? "");
    const token = String(recipient.token ?? "");
    const locale = recipient.locale === "en" ? "en" : "ar";
    if (!deviceRowId || !token) continue;
    const { data: deviceIsCurrent, error: deviceCheckError } = await admin.rpc("native_push_device_is_current", {
      p_device_id: deviceRowId,
      p_allow_account_status_notice: allowRevokedCustomerNotice,
    });
    if (deviceCheckError) {
      // A transient verifier/database error is not proof that the session was revoked.
      // Keep the binding and let a later event retry rather than disabling valid devices.
      failed += 1;
      continue;
    }
    // An expired/revoked app session should suppress this delivery, not permanently
    // disable the FCM token: account recovery/reactivation notices may still qualify.
    if (deviceIsCurrent !== true) continue;
    const { data: claimed, error: claimError } = await admin.rpc("claim_native_push_delivery", {
      p_event_key: eventKey,
      p_device_id: recipient.device_id,
    });
    if (claimError) { failed += 1; continue; }
    if (claimed !== true) continue;
    try {
      await sendFcm(token, projectId, locale === "en" ? titleEn : titleAr,
        locale === "en" ? bodyEn : bodyAr, eventKey, targetPath);
      await admin.from("native_push_delivery_attempts").update({
        status: "SENT", sent_at: new Date().toISOString(), error_code: null,
      }).eq("event_key", eventKey).eq("device_id", recipient.device_id);
      sent += 1;
    } catch (error) {
      const detail = error as { status?: number; code?: string; providerMessage?: string };
      const status = Number(detail.status ?? 0);
      const code = String(detail.code ?? "SEND_FAILED").slice(0, 80);
      const diagnostic = [status || "", code, String(detail.providerMessage ?? "").replace(/\\s+/g, " ").slice(0, 180)]
        .filter(Boolean).join(":").slice(0, 300);
      await admin.from("native_push_delivery_attempts").update({
        status: "FAILED", error_code: diagnostic, updated_at: new Date().toISOString(),
      }).eq("event_key", eventKey).eq("device_id", recipient.device_id);
      if (status === 404 || code === "UNREGISTERED") {
        await admin.from("native_push_devices").update({ disabled_at: new Date().toISOString() }).eq("id", deviceRowId);
      }
      failed += 1;
    }
  }
  return json(200, { ok: true, sent, failed });
});
