import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const respond = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const RECEIPT_PATH_PATTERN =
  /^(?:orders|customers)\/[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,100}\.(?:jpg|jpeg|png|webp)$/i;

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return respond(405, { error: "Method not allowed" });
  const match = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!match) return respond(401, { error: "Authentication required" });

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return respond(500, { error: "Server is not configured" });

  const token = match[1].trim();
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const adminClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const { data: authData, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !authData.user) return respond(401, { error: "Authentication required" });
    const input = await request.json().catch(() => null) as { path?: unknown } | null;
    const path = typeof input?.path === "string" ? input.path.trim() : "";
    if (!path || path.length > 300 || path.startsWith("/") || path.includes("..") ||
        path.includes("\\") || !RECEIPT_PATH_PATTERN.test(path)) {
      return respond(400, { error: "Invalid receipt path" });
    }

    // The RPC verifies the caller has finance:approve-payment permission and returns
    // only submissions currently pending review. Exact path matching binds the object
    // to a reviewable submission, for both order-scoped and customer-scoped uploads.
    const { data: pending, error: pendingError } =
      await userClient.rpc("list_pending_qr_payment_submissions");
    if (pendingError || !Array.isArray(pending)) {
      console.warn("Receipt queue authorization failed", pendingError?.message ?? "Invalid queue response");
      return respond(403, { error: "Payment-review access could not be verified" });
    }
    if (!pending.some((row: Record<string, unknown>) =>
      typeof row?.receipt_path === "string" && row.receipt_path === path
    )) return respond(404, { error: "Pending receipt not found" });

    const { data: signed, error: signError } =
      await adminClient.storage.from("qr-payment-receipts").createSignedUrl(path, 300);
    if (signError || !signed?.signedUrl) {
      console.error("Receipt signing failed", signError?.message ?? "No signed URL");
      return respond(404, { error: "Receipt preview is temporarily unavailable" });
    }
    return respond(200, { signedURL: signed.signedUrl });
  } catch (error) {
    console.error("Receipt preview request failed", error instanceof Error ? error.message : String(error));
    return respond(500, { error: "Could not load receipt preview" });
  }
});
