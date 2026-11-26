// Contract checks for the authenticated server-side chat gateway.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const source = read("supabase/functions/sarah-ai-chat/index.ts");
const quotaMigration = read("supabase/migrations/20261126170000_sarah_ai_atomic_actor_quota.sql");
const lookupMigration = read("supabase/migrations/20261126210000_sarah_ai_scoped_customer_lookup.sql");

describe("Sarah chat gateway security contract", () => {
  it("authenticates the bearer and derives the actor from the verified Auth identity", () => {
    expect(source).toContain("auth.getUser(bearer)");
    expect(source).toContain('caller.rpc("get_current_admin_profile")');
    expect(source).toContain("profile.auth_user_id !== userData.user.id");
    expect(source).toContain('permissions.includes("ai:use")');
    expect(source).not.toContain("body.role");
    expect(source).not.toContain("body.userId");
  });

  it("enforces atomic per-actor hourly and daily quotas before provider secret access", () => {
    expect(source).toContain('caller.rpc("sarah_ai_consume_my_quota", { p_period: "hour" })');
    expect(source).toContain('caller.rpc("sarah_ai_consume_my_quota", { p_period: "day" })');
    expect(source).toContain("AI_RATE_LIMITED");
    expect(source).toContain("AI_DAILY_LIMIT_REACHED");
    expect(source.indexOf("sarah_ai_consume_my_quota")).toBeLessThan(source.indexOf('admin.rpc("sarah_ai_get_provider_secret")'));
    expect(quotaMigration).toContain("ON CONFLICT(actor_auth_user_id, window_seconds, window_started_at)");
    expect(quotaMigration).toContain("DO UPDATE SET request_count = public.sarah_ai_usage_windows.request_count + 1");
    expect(quotaMigration).toContain("GRANT EXECUTE ON FUNCTION public.sarah_ai_consume_my_quota(text) TO authenticated");
    expect(quotaMigration).toContain("REVOKE ALL ON TABLE public.sarah_ai_usage_windows FROM PUBLIC, anon, authenticated, service_role");
    expect(quotaMigration).toContain("FORCE ROW LEVEL SECURITY");
    expect(quotaMigration).toContain("20, 3600");
    expect(quotaMigration).toContain("100, 86400");
  });

  it("enforces the request byte cap while streaming, before buffering the body", () => {
    expect(source).toContain('readBoundedRequestBody(req, MAX_BODY_BYTES)');
    expect(source).toContain("rawBytes === null");
    expect(source).not.toContain("req.text()");
    expect(source).not.toContain("req.json()");
  });

  it("keeps provider secrets server-side and bounds all model inputs and outputs", () => {
    expect(source).toContain('admin.rpc("sarah_ai_get_runtime_config")');
    expect(source).toContain('admin.rpc("sarah_ai_get_provider_secret")');
    expect(source).not.toContain('admin.from("sarah_ai_provider_config")');
    expect(source).toContain("MAX_BODY_BYTES");
    expect(source).toContain("safeText(body.text, 20000)");
    expect(source).toContain("historyChars > 12000");
    expect(source).toContain(").text as string).length > 6000");
    expect(source).toContain("AbortController");
    expect(source).toContain("maxOutputTokens");
    expect(source).toContain("x-goog-api-key");
    expect(source).not.toContain("console.log");
    expect(source).not.toContain("resp.text()");
  });

  it("exposes only one bounded read-only customer lookup tool and validates it in PostgreSQL", () => {
    expect(source).toContain('name: "lookup_customers"');
    expect(source).toContain('caller.rpc(\n        "sarah_ai_lookup_customers"');
    expect(source).toContain("functionCalls.length !== 1");
    expect(source).toContain("AI_TOOL_CALL_NOT_ALLOWED");
    expect(source).toContain("AI_TOOL_CALL_LIMIT_REACHED");
    expect(lookupMigration).toContain("public.sarah_ai_assert_use_permission()");
    expect(lookupMigration).toContain("public._cp_assert_active_admin_permission('customers:view')");
    expect(lookupMigration).toContain("LIMIT 6");
    expect(lookupMigration).toContain("match_number <= 5");
    expect(lookupMigration).not.toContain("phone");
    expect(lookupMigration).not.toContain("balance");
  });

  it("disables caching and never returns raw provider errors", () => {
    expect(source).toContain('"Cache-Control": "no-store"');
    expect(source).toContain("GEMINI_PROVIDER_UNAVAILABLE");
    expect(source).not.toContain("resp.text()");
    expect(source).not.toContain("error.message");
  });
});
