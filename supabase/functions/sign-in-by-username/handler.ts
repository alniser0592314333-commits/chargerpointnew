import {
  escapeLikeLiteral,
  hashRateLimitKey,
  isTrustedClientIp,
  normalizeUsername,
  publicAuthFailure,
} from "./requestValidation.ts";

type AdminClient = {
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: any; error: any }>;
  from: (table: string) => any;
};

export type UsernameSignInDependencies = {
  getEnv: (name: string) => string | undefined;
  createAdminClient: (url: string, secretKey: string) => AdminClient;
  authFetch?: typeof fetch;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const respond = (
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, ...extraHeaders },
});

const invalidCredentials = () => {
  const failure = publicAuthFailure(401);
  return respond(failure.status, failure.body);
};

/**
 * Build the handler separately from Deno.serve so the entire request-to-Auth
 * boundary can be tested with deterministic upstream fakes in CI.
 */
export function createUsernameSignInHandler(deps: UsernameSignInDependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (request.method !== "POST") return respond(405, { error: "Method not allowed" });

    const url = deps.getEnv("SUPABASE_URL");
    const secretKey = deps.getEnv("SUPABASE_SECRET_KEY");
    const rateLimitSecret = deps.getEnv("USERNAME_SIGNIN_RATE_LIMIT_SECRET");
    const ipForwardingEnabled = deps.getEnv("SUPABASE_AUTH_IP_FORWARDING_ENABLED") === "true";
    if (!url || !secretKey || !secretKey.startsWith("sb_secret_")
      || !rateLimitSecret || rateLimitSecret.length < 32 || !ipForwardingEnabled) {
      // Fail closed unless Auth IP forwarding and modern server-only API credentials
      // are explicitly configured. Never trust the shared Edge egress IP.
      return respond(503, { error: "Username sign-in is temporarily unavailable" });
    }

    // Supabase's Cloudflare edge supplies this header. Do not fall back to any
    // client-controlled X-Forwarded-For value for authentication throttling.
    const clientIp = request.headers.get("cf-connecting-ip")?.trim() ?? "";
    if (!isTrustedClientIp(clientIp)) {
      return respond(503, { error: "Username sign-in is temporarily unavailable" });
    }

    const input = await request.json().catch(() => null) as
      { username?: unknown; password?: unknown } | null;
    const username = normalizeUsername(input?.username);
    const password = typeof input?.password === "string" ? input.password : "";
    if (!username || !password || password.length > 1024) return invalidCredentials();

    const adminClient = deps.createAdminClient(url, secretKey);

    try {
      // Atomic shared rate limits prevent brute force across Edge Function instances.
      // Persist only keyed HMAC digests, never raw IP addresses or usernames.
      const [ipKey, usernameKey] = await Promise.all([
        hashRateLimitKey(rateLimitSecret, `ip:${clientIp}`),
        hashRateLimitKey(rateLimitSecret, `username:${username.toLowerCase()}`),
      ]);
      const { data: rateLimit, error: rateLimitError } = await adminClient.rpc(
        "consume_username_signin_attempt",
        { p_ip_key: ipKey, p_username_key: usernameKey },
      );
      if (rateLimitError || !rateLimit || typeof rateLimit.allowed !== "boolean") {
        console.error("Username sign-in rate limit check failed");
        return respond(503, { error: "Username sign-in is temporarily unavailable" });
      }
      if (!rateLimit.allowed) {
        const retryAfter = Math.max(1, Math.min(900, Number(rateLimit.retry_after_seconds) || 900));
        return respond(429, { session: null, error: "RATE_LIMIT", isRateLimited: true }, {
          "Retry-After": String(retryAfter),
        });
      }

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

      // Always invoke Supabase Auth, including unknown/ambiguous usernames, to avoid
      // disclosing account existence. Supabase Auth alone verifies the password.
      const email = matches?.length === 1 && typeof matches[0]?.email === "string"
        ? matches[0].email
        : `unknown-${crypto.randomUUID()}@invalid.example`;
      const authFetch = deps.authFetch ?? fetch;
      const authResponse = await authFetch(
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
        // Never forward Auth's raw response body; it may reveal account state.
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
  };
}
