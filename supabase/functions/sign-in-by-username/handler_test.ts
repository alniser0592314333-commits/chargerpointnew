import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createUsernameSignInHandler } from "./handler.ts";

const validEnv: Record<string, string> = {
  SUPABASE_URL: "https://project.example",
  auth_supabase_secret_key: "sb_secret_test_only",
  username_signin_rate_limit_secret: "x".repeat(40),
};

function setup(options: {
  env?: Record<string, string | undefined>;
  rateLimit?: { allowed: boolean; retry_after_seconds?: number } | null;
  rateLimitError?: unknown;
  matches?: Array<{ email: string }>;
  lookupError?: unknown;
  clientCreationError?: boolean;
  authStatus?: number;
  authBody?: unknown;
} = {}) {
  const calls = {
    clientCreated: 0,
    rateLimit: 0,
    lookup: 0,
    auth: 0,
    authUrl: "",
    authHeaders: new Headers(),
    authBody: null as Record<string, unknown> | null,
    lookupPattern: "",
  };
  const env = { ...validEnv, ...options.env };
  const handler = createUsernameSignInHandler({
    getEnv: (name) => env[name],
    createAdminClient: (_url, _key) => {
      calls.clientCreated++;
      if (options.clientCreationError) throw new Error("invalid client configuration");
      return {
        rpc: async (name: string, args: Record<string, unknown>) => {
          assertEquals(name, "consume_username_signin_attempt");
          assertEquals(typeof args.p_ip_key, "string");
          assertEquals(String(args.p_ip_key).length, 64);
          assertEquals(typeof args.p_username_key, "string");
          assertEquals(String(args.p_username_key).length, 64);
          calls.rateLimit++;
          return {
            data: options.rateLimit === undefined ? { allowed: true, retry_after_seconds: 0 } : options.rateLimit,
            error: options.rateLimitError ?? null,
          };
        },
        from: (table: string) => {
          assertEquals(table, "admins");
          return {
            select: (columns: string) => {
              assertEquals(columns, "email");
              return {
                ilike: (column: string, pattern: string) => {
                  assertEquals(column, "username");
                  calls.lookupPattern = pattern;
                  return {
                    eq: (activeColumn: string, activeValue: boolean) => {
                      assertEquals(activeColumn, "is_active");
                      assertEquals(activeValue, true);
                      return {
                        limit: async (limit: number) => {
                          assertEquals(limit, 2);
                          calls.lookup++;
                          return { data: options.matches ?? [{ email: "private-admin@example.test" }], error: options.lookupError ?? null };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      } as any;
    },
    authFetch: async (input, init) => {
      calls.auth++;
      calls.authUrl = String(input);
      calls.authHeaders = new Headers(init?.headers);
      calls.authBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(options.authBody ?? (
        options.authStatus === undefined || options.authStatus < 400
          ? { access_token: "test-access-token", user: { id: "test-user", email: "private-admin@example.test" } }
          : { msg: "internal auth detail: account state must not leak" }
      )), { status: options.authStatus ?? 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const request = (body: unknown = { username: "operator", password: "correct horse" }) =>
    new Request("https://function.example/sign-in-by-username", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.8",
        "x-forwarded-for": "198.51.100.99",
      },
      body: JSON.stringify(body),
    });
  return { handler, calls, request };
}

Deno.test("username sign-in fails closed when required server configuration is missing", async () => {
  const { handler, calls, request } = setup({ env: { auth_supabase_secret_key: "legacy-service-role-key" } });
  const response = await handler(request());
  assertEquals(response.status, 503);
  assertEquals(calls.clientCreated, 0);
  assertEquals(calls.auth, 0);
});

Deno.test("Supabase client initialization failure returns a controlled unavailable response", async () => {
  const { handler, calls, request } = setup({ clientCreationError: true });
  const response = await handler(request());
  const body = await response.text();
  assertEquals(response.status, 503);
  assertStringIncludes(body, "temporarily unavailable");
  assertEquals(body.includes("invalid client configuration"), false);
  assertEquals(calls.auth, 0);
});

Deno.test("rate-limit backend failure stops before identity lookup or Auth", async () => {
  const { handler, calls, request } = setup({ rateLimitError: new Error("database unavailable") });
  const response = await handler(request());
  assertEquals(response.status, 503);
  assertEquals(calls.rateLimit, 1);
  assertEquals(calls.lookup, 0);
  assertEquals(calls.auth, 0);
});

Deno.test("blocked username/IP bucket returns 429 and does not call Auth", async () => {
  const { handler, calls, request } = setup({ rateLimit: { allowed: false, retry_after_seconds: 120 } });
  const response = await handler(request());
  assertEquals(response.status, 429);
  assertEquals(response.headers.get("Retry-After"), "120");
  assertEquals(calls.lookup, 0);
  assertEquals(calls.auth, 0);
});

Deno.test("unknown username still reaches Auth with a dummy email and returns generic failure", async () => {
  const { handler, calls, request } = setup({
    matches: [],
    authStatus: 400,
    authBody: { msg: "specific internal account-state detail" },
  });
  const response = await handler(request());
  const body = await response.text();
  assertEquals(response.status, 401);
  assertEquals(calls.auth, 1);
  const firstDummyEmail = String(calls.authBody?.email ?? "");
  assertEquals(/^unknown-[0-9a-f-]{36}@invalid\.example$/.test(firstDummyEmail), true);
  assertEquals(calls.authHeaders.get("Sb-Forwarded-For"), "203.0.113.8");
  assertEquals(calls.authHeaders.get("Sb-Forwarded-For") === "198.51.100.99", false);
  assertEquals(body.includes("private-admin@example.test"), false);
  assertEquals(body.includes("specific internal account-state detail"), false);
  assertStringIncludes(body, "Invalid login credentials");
  await handler(request());
  const secondDummyEmail = String(calls.authBody?.email ?? "");
  assertEquals(firstDummyEmail === secondDummyEmail, false);
});

Deno.test("successful username sign-in returns the Auth session only after Auth succeeds", async () => {
  const { handler, calls, request } = setup();
  const response = await handler(request({ username: " operator ", password: "correct horse" }));
  const body = await response.json();
  assertEquals(response.status, 200);
  assertEquals(calls.lookup, 1);
  assertEquals(calls.auth, 1);
  assertEquals(calls.authBody?.email, "private-admin@example.test");
  assertEquals(calls.authBody?.password, "correct horse");
  assertEquals(body.session.access_token, "test-access-token");
  assertEquals(body.error, null);
});

Deno.test("identity lookup failure fails closed instead of authenticating an unresolved identity", async () => {
  const { handler, calls, request } = setup({ lookupError: new Error("database unavailable") });
  const response = await handler(request());
  assertEquals(response.status, 503);
  assertEquals(calls.lookup, 1);
  assertEquals(calls.auth, 0);
});

Deno.test("Auth infrastructure errors are normalized and do not leak upstream response bodies", async () => {
  const { handler, request } = setup({ authStatus: 500, authBody: { msg: "secret internal error" } });
  const response = await handler(request());
  const body = await response.text();
  assertEquals(response.status, 503);
  assertEquals(body.includes("secret internal error"), false);
  assertStringIncludes(body, "temporarily unavailable");
});
