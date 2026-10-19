import { createClient } from "npm:@supabase/supabase-js@2";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers });

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, "0")).join("");
}
function commandUuid(hex: string): string {
  const chars = hex.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((parseInt(chars[16], 16) & 3) | 8).toString(16);
  const value = chars.join("");
  return value.slice(0, 8) + "-" + value.slice(8, 12) + "-" + value.slice(12, 16) +
    "-" + value.slice(16, 20) + "-" + value.slice(20);
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return reply(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return reply(503, { ok: false, error: "SERVICE_UNAVAILABLE" });

  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (token.length !== serviceKey.length) return reply(401, { ok: false, error: "UNAUTHORIZED" });
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) mismatch |= token.charCodeAt(i) ^ serviceKey.charCodeAt(i);
  if (mismatch !== 0) return reply(401, { ok: false, error: "UNAUTHORIZED" });

  const localTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Gaza", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date());
  const [hour] = localTime.split(":").map(Number);
  if (hour < 17) return reply(200, { ok: true, skipped: "BEFORE_17_LOCAL", local_time: localTime });

  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: setting, error: settingError } = await db.from("system_settings")
    .select("value_number").eq("key", "server_reset_generation").maybeSingle();
  if (settingError) return reply(503, { ok: false, error: "SETTINGS_UNAVAILABLE" });
  const generation = Number(setting?.value_number ?? 1);

  const { data: items, error } = await db.from("order_items")
    .select("id,order_id,version,orders!inner(id,deleted_at,cancelled_at,customers!inner(status,is_active,deleted_at))")
    .eq("operational_status", "CHARGING")
    .eq("financial_status", "UNRECOGNIZED")
    .is("deleted_at", null)
    .is("cancelled_at", null)
    .is("orders.deleted_at", null)
    .is("orders.cancelled_at", null)
    .neq("orders.status", "cancelled")
    .neq("orders.status", "CANCELLED")
    .eq("orders.customers.is_active", true)
    .is("orders.customers.deleted_at", null)
    .neq("orders.customers.status", "DELETED")
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) {
    console.error("Auto-delivery candidate query failed", error.code ?? "unknown");
    return reply(503, { ok: false, error: "CANDIDATES_UNAVAILABLE" });
  }

  let delivered = 0;
  let failed = 0;
  const failures: Array<{ item_id: string; code: string }> = [];
  for (const item of items ?? []) {
    const payload = {
      itemId: item.id,
      expectedVersion: item.version,
      autoDelivery: true,
      resetGeneration: generation,
    };
    const payloadHash = await sha256(JSON.stringify(payload));
    const commandId = commandUuid(await sha256(
      "chargerpoint:auto-delivery:v1:" + item.id + ":" + item.version
    ));
    const { data: rpcData, error: rpcError } = await db.rpc("execute_canonical_sync_command", {
      p_command_id: commandId,
      p_command_type: "DELIVER_ORDER_ITEM",
      p_payload: payload,
      p_payload_hash: payloadHash,
      p_device_id: "server-auto-delivery",
      p_actor_id: null,
    });
    if (rpcError || rpcData?.success !== true) {
      failed++;
      const failureCode = rpcError?.code ?? (typeof rpcData?.error === "string" ? rpcData.error : "DELIVERY_NOT_CONFIRMED");
      failures.push({ item_id: item.id, code: failureCode });
      console.error("Auto-delivery item failed", item.id, failureCode);
    } else {
      delivered++;
    }
  }

  return reply(failed ? 500 : 200, {
    ok: failed === 0,
    local_time: localTime,
    considered: items?.length ?? 0,
    delivered,
    failed,
    failures: failures.slice(0, 25),
    truncated_failures: Math.max(0, failures.length - 25),
  });
});
