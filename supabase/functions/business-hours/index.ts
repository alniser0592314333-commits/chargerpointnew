import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

type HoursConfig = {
  isActive: boolean;
  todayDate: string;
  todayOpenTime: string;
  todayCloseTime: string;
  tomorrowOpenTime: string;
  tomorrowCloseTime: string;
  chargerFeeMinor: number;
  lastUpdated: string;
};

const dateInBusinessTimezone = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
};

const defaults = (): HoursConfig => ({
  isActive: true,
  todayDate: dateInBusinessTimezone(),
  todayOpenTime: "08:00",
  todayCloseTime: "22:00",
  tomorrowOpenTime: "08:00",
  tomorrowCloseTime: "22:00",
  chargerFeeMinor: 50,
  lastUpdated: new Date().toISOString(),
});

const isTime = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") {
    return response({ error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return response({ error: "SERVER_NOT_CONFIGURED" }, 500);

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const settingKey = "business_hours_config";
  if (req.method === "GET") {
    const { data, error } = await adminClient
      .from("system_settings")
      .select("value_json")
      .eq("key", settingKey)
      .maybeSingle();

    if (error) return response({ error: "SETTINGS_READ_FAILED" }, 500);
    if (!data?.value_json || typeof data.value_json !== "object") {
      return response({ config: defaults(), exists: false });
    }
    const today = dateInBusinessTimezone();
    const shared = { ...defaults(), ...data.value_json } as HoursConfig;
    // Preserve the app's established midnight rollover rule using the business timezone.
    if (typeof shared.todayDate === "string" && shared.todayDate < today) {
      shared.todayOpenTime = shared.tomorrowOpenTime || "08:00";
      shared.todayCloseTime = shared.tomorrowCloseTime || "22:00";
      shared.todayDate = today;
      shared.lastUpdated = new Date().toISOString();
    }
    return response({ config: shared, exists: true });
  }

  const bearer = req.headers.get("Authorization") || "";
  const match = bearer.match(/^Bearer\s+(.+)$/i);
  if (!match) return response({ error: "ADMIN_AUTH_REQUIRED" }, 401);

  const { data: userResult, error: userError } = await adminClient.auth.getUser(match[1]);
  if (userError || !userResult?.user) return response({ error: "ADMIN_AUTH_REQUIRED" }, 401);

  const { data: admin, error: adminError } = await adminClient
    .from("admins")
    .select("id, role, permissions, is_active, disabled_at")
    .eq("auth_user_id", userResult.user.id)
    .maybeSingle();

  if (adminError || !admin || !admin.is_active || admin.disabled_at) {
    return response({ error: "SETTINGS_PERMISSION_DENIED" }, 403);
  }

  let canManage = admin.role === "SUPER_ADMIN" ||
    (Array.isArray(admin.permissions) && admin.permissions.includes("settings:manage"));

  if (!canManage) {
    const { data: custom } = await adminClient
      .from("admin_custom_permissions")
      .select("is_grant")
      .eq("admin_id", admin.id)
      .eq("permission", "settings:manage")
      .maybeSingle();

    if (custom) {
      canManage = custom.is_grant === true;
    } else {
      const { data: rolePermission } = await adminClient
        .from("role_permissions")
        .select("permission")
        .eq("role", admin.role)
        .eq("permission", "settings:manage")
        .maybeSingle();
      canManage = Boolean(rolePermission);
    }
  }

  if (!canManage) return response({ error: "SETTINGS_PERMISSION_DENIED" }, 403);

  let input: any;
  try {
    input = await req.json();
  } catch {
    return response({ error: "INVALID_JSON" }, 400);
  }

  const incoming = input?.config;
  if (
    !incoming ||
    typeof incoming.isActive !== "boolean" ||
    !isTime(incoming.todayOpenTime) ||
    !isTime(incoming.todayCloseTime) ||
    !isTime(incoming.tomorrowOpenTime) ||
    !isTime(incoming.tomorrowCloseTime)
  ) {
    return response({ error: "INVALID_BUSINESS_HOURS_CONFIG" }, 400);
  }

  const { data: existing } = await adminClient
    .from("system_settings")
    .select("value_json")
    .eq("key", settingKey)
    .maybeSingle();

  const config: HoursConfig = {
    ...defaults(),
    isActive: incoming.isActive,
    todayDate: dateInBusinessTimezone(),
    todayOpenTime: incoming.todayOpenTime,
    todayCloseTime: incoming.todayCloseTime,
    tomorrowOpenTime: incoming.tomorrowOpenTime,
    tomorrowCloseTime: incoming.tomorrowCloseTime,
    chargerFeeMinor: Number.isSafeInteger(existing?.value_json?.chargerFeeMinor)
      ? existing.value_json.chargerFeeMinor
      : 50,
    lastUpdated: new Date().toISOString(),
  };

  const { error: saveError } = await adminClient.from("system_settings").upsert({
    key: settingKey,
    value_type: "json",
    value_string: null,
    value_number: null,
    value_boolean: null,
    value_json: config,
    description: "Shared business hours configuration for the public landing page",
    updated_at: new Date().toISOString(),
    updated_by: userResult.user.id,
  }, { onConflict: "key" });

  if (saveError) return response({ error: "SETTINGS_SAVE_FAILED" }, 500);
  return response({ config, exists: true });
});
