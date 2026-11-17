import { createClient } from "npm:@supabase/supabase-js@2";
import webPushModule from "npm:web-push@3.6.7";

const webPush = (webPushModule as unknown as { default?: typeof webPushModule }).default ?? webPushModule;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
type Json = Record<string, unknown>;
const reply = (status: number, body: Json) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });
const clean = (value: unknown, max = 500) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
const decodeClaims = (jwt: string): Record<string, unknown> | null => {
  try {
    const part = jwt.split(".")[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
  } catch { return null; }
};
const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return reply(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("auth_supabase_secret_key") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!url || !serviceKey || !anonKey) return reply(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
  if (!bearer || bearer.length > 8192) return reply(401, { ok: false, error: "AUTH_REQUIRED" });
  const claims = decodeClaims(bearer);
  const sessionId = clean(claims?.session_id, 64);
  const { data: authData, error: authError } = await admin.auth.getUser(bearer);
  if (authError || !authData.user || !isUuid(sessionId)) return reply(401, { ok: false, error: "AUTH_REQUIRED" });
  const user = authData.user;

  const bodyText = await request.text();
  if (new TextEncoder().encode(bodyText).byteLength > 96_000) return reply(413, { ok: false, error: "REQUEST_TOO_LARGE" });
  let input: (Json & { action?: string }) | null;
  try { input = JSON.parse(bodyText) as (Json & { action?: string }) | null; }
  catch { return reply(400, { ok: false, error: "INVALID_REQUEST" }); }
  if (!input || typeof input.action !== "string") return reply(400, { ok: false, error: "INVALID_REQUEST" });
  const action = input.action;

  const requireCustomer = async () => {
    const { data: link, error: linkError } = await admin.from("customer_account_links")
      .select("customer_id,auth_user_id,account_status")
      .eq("auth_user_id", user.id).eq("account_status", "ACTIVE").maybeSingle();
    if (linkError || !link || link.auth_user_id !== user.id) return null;
    const { data: session, error: sessionError } = await admin.from("customer_account_sessions")
      .select("session_id,expires_at,revoked_at")
      .eq("customer_id", link.customer_id).eq("auth_user_id", user.id).eq("session_id", sessionId).maybeSingle();
    if (sessionError || !session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) return null;
    const { data: customer, error: customerError } = await admin.from("customers")
      .select("id,is_active,status,deleted_at").eq("id", link.customer_id).maybeSingle();
    if (customerError || !customer || customer.is_active !== true || customer.deleted_at || customer.status === "DELETED") return null;
    return { customerId: String(link.customer_id) };
  };

  const requireAdmin = async () => {
    const response = await fetch(url.replace(/\/+$/, "") + "/rest/v1/rpc/get_current_admin_profile", {
      method: "POST",
      headers: { apikey: anonKey, Authorization: "Bearer " + bearer, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) return null;
    const raw = await response.json().catch(() => null);
    const profile = Array.isArray(raw) ? raw[0] : raw;
    if (!profile || profile.is_admin !== true || profile.is_active === false) return null;
    const permissions = Array.isArray(profile.permissions) ? profile.permissions : [];
    const role = String(profile.role || "").toUpperCase().replace(/\s+/g, "_");
    if (role !== "SUPER_ADMIN" && !permissions.includes("admin:manage") && !permissions.includes("events:manage")) return null;
    return { adminId: typeof profile.admin_id === "string" ? profile.admin_id : null };
  };

  const signEventMedia = async (rows: Array<Record<string, unknown>>) => {
    return await Promise.all(rows.map(async (row) => {
      const blocks = Array.isArray(row.content_blocks) ? row.content_blocks as Array<Record<string, unknown>> : [];
      const signedBlocks = await Promise.all(blocks.map(async (block) => {
        if (block.type !== "image" || typeof block.path !== "string") return block;
        const { data } = await admin.storage.from("customer-portal-events").createSignedUrl(block.path, 3600);
        return { ...block, url: data?.signedUrl ?? null };
      }));
      return { ...row, content_blocks: signedBlocks };
    }));
  };

  const vapidKeys = async () => {
    const { data, error } = await admin.rpc("get_customer_web_push_vapid_keys");
    if (error || !isObject(data) || typeof data.public_key !== "string" || typeof data.private_key !== "string") return null;
    return { publicKey: data.public_key, privateKey: data.private_key };
  };

  const dispatchWebPush = async (event: Record<string, unknown>) => {
    if (event.web_push_sent_at) return { attempted: false, sent: 0 };
    const keys = await vapidKeys();
    if (!keys) return { attempted: false, sent: 0, unavailable: true };
    const { data: links, error: linkError } = await admin.from("customer_account_links")
      .select("customer_id,customers!inner(id,is_active,status,deleted_at)")
      .eq("account_status", "ACTIVE");
    if (linkError) return { attempted: false, sent: 0, unavailable: true };
    const customerIds = [...new Set((links || [])
      .filter((row: any) => row.customers?.is_active === true && !row.customers?.deleted_at && row.customers?.status !== "DELETED")
      .map((row: any) => String(row.customer_id)).filter(isUuid))];
    if (!customerIds.length) {
      await admin.from("customer_portal_events").update({ web_push_sent_at: new Date().toISOString() }).eq("id", event.id);
      return { attempted: true, sent: 0 };
    }
    const { data: subscriptions, error: subscriptionError } = await admin.from("customer_push_subscriptions")
      .select("id,subscription").in("customer_id", customerIds);
    if (subscriptionError) return { attempted: false, sent: 0, unavailable: true };
    webPush.setVapidDetails("mailto:notifications@monther.work", keys.publicKey, keys.privateKey);
    let sent = 0;
    let failed = 0;
    for (const subscription of subscriptions || []) {
      try {
        const targetPath = clean((subscription.subscription as Record<string, unknown>)?.portal_url, 512);
        const safePath = /^\/c\/[A-Za-z0-9_-]{1,64}(?:\?[^\s]*)?$/.test(targetPath)
          ? targetPath : "/public/about?section=events";
        const english = (subscription.subscription as Record<string, unknown>)?.locale === "en";
        const title = english ? (clean(event.title_en, 120) || clean(event.title_ar, 120) || "New event") : (clean(event.title_ar, 120) || "حدث جديد");
        const body = english ? "A new event has been added to the events page." : "تمت إضافة حدث جديد إلى صفحة الأحداث.";
        const payload = JSON.stringify({ title, body, url: safePath, tag: "customer-event-" + String(event.id) });
        await webPush.sendNotification(subscription.subscription, payload, { TTL: 3600, urgency: "high" });
        sent += 1;
      } catch (error) {
        const status = Number((error as { statusCode?: number })?.statusCode || 0);
        if (status === 404 || status === 410) {
          await admin.from("customer_push_subscriptions").delete().eq("id", subscription.id);
        } else {
          failed += 1;
        }
      }
    }
    if (failed === 0) {
      await admin.from("customer_portal_events").update({ web_push_sent_at: new Date().toISOString() }).eq("id", event.id);
    }
    return { attempted: true, sent, failed };
  };

  try {
    if (action === "customer-list") {
      const customer = await requireCustomer();
      if (!customer) return reply(403, { ok: false, error: "ACTIVE_CUSTOMER_SESSION_REQUIRED" });
      const { data, error } = await admin.from("customer_portal_events")
        .select("id,title_ar,title_en,content_blocks,sort_order,published_at,created_at")
        .eq("is_published", true).is("archived_at", null)
        .order("sort_order", { ascending: true }).order("published_at", { ascending: false });
      if (error) return reply(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      return reply(200, { ok: true, events: await signEventMedia(data || []) });
    }

    if (action === "public-config") {
      const customer = await requireCustomer();
      if (!customer) return reply(403, { ok: false, error: "ACTIVE_CUSTOMER_SESSION_REQUIRED" });
      const keys = await vapidKeys();
      return reply(200, { ok: true, vapid_public_key: keys?.publicKey ?? null });
    }

    if (action === "subscribe") {
      const customer = await requireCustomer();
      if (!customer) return reply(403, { ok: false, error: "ACTIVE_CUSTOMER_SESSION_REQUIRED" });
      const subscription = input.subscription;
      if (!isObject(subscription) || typeof subscription.endpoint !== "string" ||
          subscription.endpoint.length < 30 || subscription.endpoint.length > 2048 ||
          !isObject(subscription.keys) || typeof subscription.keys.p256dh !== "string" ||
          typeof subscription.keys.auth !== "string") return reply(400, { ok: false, error: "INVALID_SUBSCRIPTION" });
      const portalToken = clean(input.portalToken, 64);
      const portalUrl = /^[A-Za-z0-9_-]{1,64}$/.test(portalToken)
        ? "/c/" + portalToken + "?tab=more&view=events"
        : "/public/about?section=events";
      const storedSubscription = { ...subscription, portal_url: portalUrl, locale: clean(input.locale, 2) === "en" ? "en" : "ar" };
      const { error } = await admin.from("customer_push_subscriptions").upsert({
        customer_id: customer.customerId,
        endpoint: subscription.endpoint,
        subscription: storedSubscription,
        updated_at: new Date().toISOString(),
      }, { onConflict: "endpoint" });
      return error ? reply(503, { ok: false, error: "SUBSCRIPTION_SAVE_FAILED" }) : reply(200, { ok: true });
    }

    if (action === "unsubscribe") {
      const customer = await requireCustomer();
      if (!customer) return reply(403, { ok: false, error: "ACTIVE_CUSTOMER_SESSION_REQUIRED" });
      const endpoint = clean(input.endpoint, 2048);
      if (!endpoint) return reply(400, { ok: false, error: "INVALID_ENDPOINT" });
      const { error } = await admin.from("customer_push_subscriptions").delete()
        .eq("customer_id", customer.customerId).eq("endpoint", endpoint);
      return error ? reply(503, { ok: false, error: "UNSUBSCRIBE_FAILED" }) : reply(200, { ok: true });
    }

    const administrator = await requireAdmin();
    if (!administrator) return reply(403, { ok: false, error: "ADMIN_EVENTS_PERMISSION_REQUIRED" });

    if (action === "admin-list") {
      const { data, error } = await admin.from("customer_portal_events")
        .select("*").is("archived_at", null)
        .order("sort_order", { ascending: true }).order("created_at", { ascending: false });
      if (error) return reply(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
      return reply(200, { ok: true, events: await signEventMedia(data || []) });
    }

    if (action === "upload-url") {
      const fileName = clean(input.fileName, 120);
      const contentType = clean(input.contentType, 40).toLowerCase();
      const ext = contentType === "image/jpeg" ? "jpg" : contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "";
      if (!ext || !fileName || !/\.(jpe?g|png|webp)$/i.test(fileName) || Number(input.size || 0) > 8 * 1024 * 1024) {
        return reply(400, { ok: false, error: "UNSUPPORTED_IMAGE" });
      }
      const path = "events/" + crypto.randomUUID() + "." + ext;
      const { data, error } = await admin.storage.from("customer-portal-events").createSignedUploadUrl(path);
      if (error || !data?.token) return reply(503, { ok: false, error: "UPLOAD_URL_FAILED" });
      return reply(200, { ok: true, path, token: data.token });
    }

    if (action === "save") {
      const id = clean(input.id, 64);
      if (id && !isUuid(id)) return reply(400, { ok: false, error: "INVALID_EVENT_ID" });
      const titleAr = clean(input.title_ar, 180);
      const titleEn = clean(input.title_en, 180);
      const blocks = Array.isArray(input.content_blocks) ? input.content_blocks : null;
      if (!blocks || blocks.length > 24) return reply(400, { ok: false, error: "INVALID_CONTENT_BLOCKS" });
      const normalizedBlocks: Array<Record<string, unknown>> = [];
      for (const raw of blocks) {
        if (!isObject(raw)) return reply(400, { ok: false, error: "INVALID_CONTENT_BLOCK" });
        if (raw.type === "text") {
          const textAr = clean(raw.text_ar, 6000);
          const textEn = clean(raw.text_en, 6000);
          if (!textAr && !textEn) return reply(400, { ok: false, error: "EMPTY_TEXT_BLOCK" });
          normalizedBlocks.push({ type: "text", text_ar: textAr, text_en: textEn });
        } else if (raw.type === "image") {
          const path = clean(raw.path, 300);
          if (!path.startsWith("events/") || path.includes("..")) return reply(400, { ok: false, error: "INVALID_IMAGE_PATH" });
          normalizedBlocks.push({ type: "image", path, alt_ar: clean(raw.alt_ar, 160), alt_en: clean(raw.alt_en, 160) });
        } else return reply(400, { ok: false, error: "INVALID_CONTENT_BLOCK_TYPE" });
      }
      if (!normalizedBlocks.length) return reply(400, { ok: false, error: "EVENT_CONTENT_REQUIRED" });
      const publish = input.is_published === true;
      const now = new Date().toISOString();
      let saved: Record<string, unknown> | null = null;
      if (id) {
        const { data: current, error: readError } = await admin.from("customer_portal_events")
          .select("id,is_published,notifications_sent_at,sort_order").eq("id", id).is("archived_at", null).maybeSingle();
        if (readError || !current) return reply(404, { ok: false, error: "EVENT_NOT_FOUND" });
        const { data, error } = await admin.from("customer_portal_events").update({
          title_ar: titleAr || null, title_en: titleEn || null, content_blocks: normalizedBlocks,
          is_published: publish, published_at: publish ? (current.is_published ? undefined : now) : null,
          updated_by: administrator.adminId, updated_at: now,
        }).eq("id", id).select("*").single();
        if (error) return reply(503, { ok: false, error: "EVENT_SAVE_FAILED" });
        saved = data;
      } else {
        const { data: last } = await admin.from("customer_portal_events").select("sort_order")
          .is("archived_at", null).order("sort_order", { ascending: false }).limit(1).maybeSingle();
        const { data, error } = await admin.from("customer_portal_events").insert({
          title_ar: titleAr || null, title_en: titleEn || null, content_blocks: normalizedBlocks,
          sort_order: Number(last?.sort_order ?? -1) + 1, is_published: publish,
          published_at: publish ? now : null, created_by: administrator.adminId, updated_by: administrator.adminId,
        }).select("*").single();
        if (error) return reply(503, { ok: false, error: "EVENT_CREATE_FAILED" });
        saved = data;
      }
      let notification = { success: true, already_sent: true, inserted_count: 0 };
      if (publish && saved) {
        const { data: current } = await admin.from("customer_portal_events").select("*").eq("id", saved.id).maybeSingle();
        if (current && !current.notifications_sent_at) {
          const { data: fanout, error: fanoutError } = await admin.rpc("publish_customer_portal_event", { p_event_id: saved.id });
          if (fanoutError) return reply(503, { ok: false, error: "EVENT_SAVED_NOTIFICATION_PENDING" });
          notification = isObject(fanout) ? fanout as typeof notification : notification;
        }
        const { data: latest } = await admin.from("customer_portal_events").select("*").eq("id", saved.id).maybeSingle();
        if (latest && !latest.web_push_sent_at) {
          const webPushResult = await dispatchWebPush(latest);
          return reply(200, { ok: true, event: (await signEventMedia([latest]))[0], notification, web_push: webPushResult });
        }
      }
      return reply(200, { ok: true, event: saved, notification });
    }

    if (action === "reorder") {
      const ids = Array.isArray(input.ids) ? input.ids.map((value) => clean(value, 64)) : [];
      if (!ids.length || ids.length > 200 || ids.some((id) => !isUuid(id)) || new Set(ids).size !== ids.length) {
        return reply(400, { ok: false, error: "INVALID_EVENT_ORDER" });
      }
      const { data: current, error: readError } = await admin.from("customer_portal_events")
        .select("id").is("archived_at", null);
      if (readError || !current || current.length !== ids.length || current.some((row) => !ids.includes(row.id))) {
        return reply(409, { ok: false, error: "EVENT_ORDER_CHANGED_REFRESH_REQUIRED" });
      }
      for (let index = 0; index < ids.length; index += 1) {
        const { error } = await admin.from("customer_portal_events")
          .update({ sort_order: index, updated_at: new Date().toISOString(), updated_by: administrator.adminId })
          .eq("id", ids[index]);
        if (error) return reply(503, { ok: false, error: "EVENT_REORDER_FAILED" });
      }
      return reply(200, { ok: true });
    }

    if (action === "archive") {
      const id = clean(input.id, 64);
      if (!isUuid(id)) return reply(400, { ok: false, error: "INVALID_EVENT_ID" });
      const { error } = await admin.from("customer_portal_events").update({
        is_published: false, archived_at: new Date().toISOString(),
        updated_at: new Date().toISOString(), updated_by: administrator.adminId,
      }).eq("id", id).is("archived_at", null);
      return error ? reply(503, { ok: false, error: "EVENT_ARCHIVE_FAILED" }) : reply(200, { ok: true });
    }

    if (action === "retry-web-push") {
      const id = clean(input.id, 64);
      if (!isUuid(id)) return reply(400, { ok: false, error: "INVALID_EVENT_ID" });
      const { data: event, error } = await admin.from("customer_portal_events").select("*")
        .eq("id", id).eq("is_published", true).is("archived_at", null).maybeSingle();
      if (error || !event) return reply(404, { ok: false, error: "EVENT_NOT_FOUND" });
      const result = await dispatchWebPush({ ...event, web_push_sent_at: null });
      if (result.unavailable) return reply(503, { ok: false, error: "WEB_PUSH_UNAVAILABLE" });
      return reply(200, { ok: true, web_push: result });
    }

    return reply(400, { ok: false, error: "UNKNOWN_ACTION" });
  } catch (error) {
    console.error("customer-portal-events request failed", error);
    return reply(500, { ok: false, error: "INTERNAL_ERROR" });
  }
});
