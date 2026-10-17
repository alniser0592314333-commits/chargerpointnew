import { createClient } from "npm:@supabase/supabase-js@2";
import { escapeLikeLiteral, isTrustedClientIp, normalizeUsername, publicAuthFailure } from "./requestValidation.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const respond = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const invalidCredentials = () => {
  const failure = publicAuthFailure(401);
  return respond(failure.status, failure.body);
};

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return respond(405, { error: "Method not allowed" });

  const url = Deno.env.get("SUPABASE_URL");
  const secretKey = Deno.env.get("SUPABASE_SECRET_KEY");
  const ipForwardingEnabled = Deno.env.get("SUPABASE_AUTH_IP_FORWARDING_ENABLED") === "true";
  if (!url || !secretKey || !secretKey.startsWith("sb_secret_") || !ipForwardingEnabled) {
    // Deployment must explicitly attest that Auth IP forwarding was enabled in the
    // project settings. Never silently fall back to a shared Edge Function egress IP
    // or a legacy service_role key for per-client rate limiting.
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

    if (!authResponse.ok) {
      // Do not forward Auth's raw body: it can reveal confirmation/account state.
      const failure = publicAuthFailure(authResponse.status);
      return respond(failure.status, failure.body);
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
