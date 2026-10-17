import { createClient } from "npm:@supabase/supabase-js@2";
import { escapeLikeLiteral, isTrustedClientIp, normalizeUsername } from "./requestValidation.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const respond = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const invalidCredentials = () =>
  respond(401, { session: null, error: "Invalid login credentials", isInvalidCredentials: true });

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return respond(405, { error: "Method not allowed" });

  const url = Deno.env.get("SUPABASE_URL");
  const secretKey = Deno.env.get("SUPABASE_SECRET_KEY");
  if (!url || !secretKey || !secretKey.startsWith("sb_secret_")) {
    // IP forwarding to Supabase Auth requires a modern secret API key. Do not silently
    // fall back to a legacy service_role key that cannot provide per-client rate limits.
    return respond(503, { error: "Username sign-in is temporarily unavailable" });
  }

  const clientIp = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  if (!isTrustedClientIp(clientIp)) {
    return respond(503, { error: "Username sign-in is temporarily unavailable" });
  }

  const input = await request.json().catch(() => null) as { username?: unknown; password?: unknown } | null;
  const username = normalizeUsername(input?.username);
  const password = typeof input?.password === "string" ? input.password : "";
  if (!username || !password || password.length > 1024) return invalidCredentials();

  const adminClient = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const escapedUsername = escapeLikeLiteral(username);
    const { data: matches, error: lookupError } = await adminClient
      .from("admins")
      .select("email")
      .ilike("username", escapedUsername)
      .eq("is_active", true)
      .limit(2);

    if (lookupError) {
      console.error("Username sign-in identity lookup failed");
      return respond(503, { error: "Username sign-in is temporarily unavailable" });
    }

    // Always invoke Supabase Auth, including for unknown/ambiguous usernames, to keep
    // account-existence information out of the response. Password verification is
    // exclusively performed by Supabase Auth; this function never compares passwords.
    const email = matches?.length === 1 && typeof matches[0]?.email === "string"
      ? matches[0].email
      : "unknown-username@invalid.example";
    const authResponse = await fetch(
      `${url.replace(/\/+$/, "")}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          apikey: secretKey,
          "Content-Type": "application/json",
          "Sb-Forwarded-For": clientIp,
        },
        body: JSON.stringify({ email, password }),
      },
    );

    if (authResponse.status === 429) {
      return respond(429, { session: null, error: "RATE_LIMIT", isRateLimited: true });
    }
    if (!authResponse.ok) {
      // Do not forward Auth's raw body: it can reveal confirmation/account state.
      return invalidCredentials();
    }

    const session = await authResponse.json().catch(() => null);
    if (!session || typeof session.access_token !== "string" || !session.user) {
      return respond(502, { error: "Username sign-in is temporarily unavailable" });
    }
    return respond(200, { session, error: null });
  } catch {
    console.error("Username sign-in request failed");
    return respond(503, { error: "Username sign-in is temporarily unavailable" });
  }
});
