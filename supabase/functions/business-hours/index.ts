import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store, max-age=0",
};

type HoursConfig = {
  isActive: boolean;
  todayDate: string;
  todayOpenTime: string;
  todayCloseTime: string;
  tomorrowOpenTime: string;
  tomorrowCloseTime: string;
  tomorrowDescription: string;
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
  tomorrowDescription: "",
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
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
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
    shared.tomorrowDescription = typeof shared.tomorrowDescription === "string" ? shared.tomorrowDescription.slice(0, 300) : "";
    // Preserve the app's established midnight rollover rule using the business timezone.
    if (typeof shared.todayDate === "string" && shared.todayDate < today) {
      shared.todayOpenTime = shared.tomorrowOpenTime || "08:00";
      shared.todayCloseTime = shared.tomorrowCloseTime || "22:00";
      // The custom note belongs to tomorrow only; expire it at the business-day rollover.
      shared.tomorrowDescription = "";
      shared.todayDate = today;
      shared.lastUpdated = new Date().toISOString();
    }
    return response({ config: shared, exists: true });
  }

  const bearer = req.headers.get("Authorization") || "";
  const match = bearer.match(/^Bearer\s+(.+)$/i);
  if (!match) return response({ error: "ADMIN_AUTH_REQUIRED" }, 401);
  if (!anonKey) return response({ error: "SERVER_NOT_CONFIGURED" }, 500);

  // All authorization and the write itself use the caller JWT. The service-role
  // client below is read-only (existing config + reset generation only).
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${match[1]}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userResult, error: userError } = await callerClient.auth.getUser(match[1]);
  if (userError || !userResult?.user) return response({ error: "ADMIN_AUTH_REQUIRED" }, 401);

  const { data: activeSession, error: activeSessionError } =
    await callerClient.rpc("is_active_admin_session");
  if (activeSessionError || activeSession !== true) {
    return response({ error: "ADMIN_SESSION_REQUIRED" }, 401);
  }

  const { data: profile, error: profileError } = await callerClient.rpc("get_current_admin_profile");
  if (
    profileError ||
    profile?.authenticated !== true ||
    profile?.is_admin !== true ||
    profile?.is_active !== true ||
    profile?.auth_user_id !== userResult.user.id ||
    typeof profile?.admin_id !== "string"
  ) {
    return response({ error: "SETTINGS_PERMISSION_DENIED" }, 403);
  }

  const { data: effectivePermissions, error: permissionsError } =
    await callerClient.rpc("get_effective_permissions", { p_admin_id: profile.admin_id });
  if (permissionsError) return response({ error: "SETTINGS_PERMISSION_CHECK_FAILED" }, 403);
  const canManage = Array.isArray(effectivePermissions) &&
    effectivePermissions.some((row: { permission?: string }) => row.permission === "settings:manage");
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

  const { data: existing, error: existingError } = await adminClient
    .from("system_settings")
    .select("value_json")
    .eq("key", settingKey)
    .maybeSingle();
  if (existingError) return response({ error: "SETTINGS_READ_FAILED" }, 500);

  const { data: generationRow, error: generationError } = await adminClient
    .from("system_settings")
    .select("value_number")
    .eq("key", "server_reset_generation")
    .maybeSingle();
  if (generationError) return response({ error: "SETTINGS_READ_FAILED" }, 500);

  const resetGeneration = Number.isSafeInteger(generationRow?.value_number)
    ? Number(generationRow.value_number)
    : 1;
  const config: HoursConfig = {
    ...defaults(),
    isActive: incoming.isActive,
    todayDate: dateInBusinessTimezone(),
    todayOpenTime: incoming.todayOpenTime,
    todayCloseTime: incoming.todayCloseTime,
    tomorrowOpenTime: incoming.tomorrowOpenTime,
    tomorrowCloseTime: incoming.tomorrowCloseTime,
    tomorrowDescription: typeof incoming.tomorrowDescription === "string"
      ? incoming.tomorrowDescription.slice(0, 300)
      : (existing?.value_json?.todayDate === dateInBusinessTimezone() && typeof existing?.value_json?.tomorrowDescription === "string" ? existing.value_json.tomorrowDescription.slice(0, 300) : ""),
    chargerFeeMinor: Number.isSafeInteger(existing?.value_json?.chargerFeeMinor)
      ? existing?.value_json?.chargerFeeMinor ?? 50
      : 50,
    lastUpdated: new Date().toISOString(),
  };

  const requestId = typeof input.requestId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)
    ? input.requestId
    : crypto.randomUUID();
  const payloadForHash = JSON.stringify({ key: settingKey, config, resetGeneration });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payloadForHash));
  const payloadHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");

  // SET_SYSTEM_SETTING is the app's canonical command. Its database wrapper
  // rechecks the current account session and settings:manage permission.
  const { data: commandResult, error: commandError } = await callerClient.rpc("execute_sync_command", {
    p_command_id: requestId,
    p_command_type: "SET_SYSTEM_SETTING",
    p_aggregate_type: "system_settings",
    p_aggregate_id: crypto.randomUUID(),
    p_payload: {
      key: settingKey,
      valueType: "json",
      valueString: null,
      valueNumber: null,
      valueBoolean: null,
      valueJson: config,
      resetGeneration,
      deviceId: "business-hours-edge",
      payloadHash,
    },
    p_expected_version: null,
  });

  if (commandError) {
    const code = String(commandError.code || "");
    if (code === "42501" || code === "P4003") return response({ error: "SETTINGS_PERMISSION_DENIED" }, 403);
    if (code === "28000") return response({ error: "ADMIN_SESSION_REQUIRED" }, 401);
    if (code === "22023" || code === "P2201") return response({ error: "INVALID_BUSINESS_HOURS_CONFIG" }, 400);
    if (code === "P0409" || code === "23505") return response({ error: "SETTINGS_UPDATE_CONFLICT" }, 409);
    return response({ error: "SETTINGS_SAVE_FAILED" }, 500);
  }
  if (commandResult?.success !== true) return response({ error: "SETTINGS_SAVE_FAILED" }, 500);

  return response({ config, exists: true });
});
