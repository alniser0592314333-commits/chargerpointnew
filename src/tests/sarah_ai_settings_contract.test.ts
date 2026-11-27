import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Sarah AI provider settings security contract", () => {
  const migration = read("supabase/migrations/20261126080000_sarah_ai_provider_configuration.sql");
  const quotaMigration = read("supabase/migrations/20261126170000_sarah_ai_atomic_actor_quota.sql");
  const edgeFunction = read("supabase/functions/sarah-ai-settings/index.ts");
  const chatFunction = read("supabase/functions/sarah-ai-chat/index.ts");
  const geminiAdapter = read("supabase/functions/_shared/ai/geminiProviderAdapter.ts");
  const clientService = read("src/services/ai/aiSettingsService.ts");
  const settingsPage = read("src/components/pages/SettingsPage.tsx");
  const adminManagementPage = read("src/components/pages/AdminManagementPage.tsx");
  const settingsSection = read("src/components/settings/AISettingsSection.tsx");
  const integrationPackage = read("src/application/ai/sarahIntegrationPackage.ts");

  it("adds dedicated permissions and limits their default grant to Super Admin", () => {
    expect(migration).toContain("v_role <> 'SUPER_ADMIN' AND NOT EXISTS");
    expect(migration).toContain("permission_item.permission = 'ai:manage'");
    expect(migration).not.toContain("INSERT INTO public.role_permissions");
    expect(quotaMigration).toContain("permission_item.permission = 'ai:use'");
    expect(quotaMigration).toContain("v_role <> 'SUPER_ADMIN'");
    expect(migration).not.toContain("('ADMIN', 'ai:manage')");
    expect(migration).not.toContain("('MANAGER', 'ai:manage')");
  });

  it("keeps provider secrets out of the configuration table and browser roles", () => {
    const tableDefinition = migration.split("CREATE TABLE IF NOT EXISTS public.sarah_ai_provider_config")[1]
      ?.split(");")[0] || "";
    expect(tableDefinition).toContain("secret_id uuid");
    expect(tableDefinition).not.toMatch(/api[_A-Za-z]*key\s+text/i);
    expect(migration).toContain("ALTER TABLE public.sarah_ai_provider_config ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("REVOKE ALL ON TABLE public.sarah_ai_provider_config FROM PUBLIC, anon, authenticated, service_role");
    expect(migration).not.toContain("GRANT ALL ON TABLE public.sarah_ai_provider_config TO service_role");
    expect(migration).toContain("vault.create_secret");
    expect(migration).toContain("vault.update_secret");
    expect(migration).toContain("DELETE FROM vault.secrets");
    expect(migration.match(/COMMIT;/g) || []).toHaveLength(1);
    expect(migration).toContain("maxOutputTokens must be an integer");
    expect(migration).toContain("maxOutputTokens must be between 1 and 4096");
    expect(edgeFunction).toContain("Number(input.maxOutputTokens) > 4096");
    expect(edgeFunction).toContain("readBoundedRequestBody(request, MAX_BODY_BYTES)");
    expect(edgeFunction).not.toContain("request.text()");
    expect(migration).toContain("timeoutMs must be between 5000 and 120000");
  });

  it("enforces ai:manage inside the database and uses caller-scoped settings RPCs", () => {
    expect(migration).toContain("sarah_ai_assert_manage_permission");
    expect(migration).toContain('public.get_current_admin_profile()');
    expect(migration).toContain("AI_MANAGE_PERMISSION_REQUIRED");
    expect(adminManagementPage).toContain('key: "ai:use"');
    expect(adminManagementPage).toContain('key: "ai:manage"');
    expect(migration).toContain("disabled_at IS NOT NULL");
    expect(migration).toContain("sarah_ai_get_runtime_config");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("REVOKE ALL ON TABLE public.sarah_ai_provider_config FROM PUBLIC, anon, authenticated, service_role");
    expect(chatFunction).toContain('admin.rpc("sarah_ai_get_runtime_config")');
    expect(chatFunction).not.toContain('admin.from("sarah_ai_provider_config")');
    expect(chatFunction).toContain('name: "lookup_customers"');
    expect(chatFunction).toContain('caller.rpc("sarah_ai_lookup_customers"');
    expect(chatFunction).toContain('caller.rpc("sarah_ai_get_customer_profile"');
    expect(chatFunction).toContain("calls.length !== 1");
    expect(chatFunction).toContain("for (let toolStep = 0; toolStep < 4; toolStep++)");
    expect(chatFunction).toContain('toolConfig: { functionCallingConfig: { mode: "AUTO" } }');
    expect(chatFunction).toContain("AI_TOOL_CALL_LIMIT_REACHED");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.sarah_ai_save_provider_config(text, text, text, jsonb, text) TO authenticated");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.sarah_ai_get_provider_config() TO authenticated");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.sarah_ai_save_provider_config(text, text, text, jsonb, text) FROM PUBLIC, anon, service_role");
    expect(edgeFunction).toContain('caller.rpc("get_current_admin_profile")');
    expect(edgeFunction).toContain('permissions.includes("ai:manage")');
    expect(edgeFunction).toContain("profile.auth_user_id !== authData.user.id");
    expect(edgeFunction).toContain("profile.is_active !== true");
    expect(edgeFunction).toContain('caller.rpc("sarah_ai_get_provider_config")');
    expect(edgeFunction).toContain('caller.rpc("sarah_ai_save_provider_config"');
    expect(edgeFunction).toContain('caller.rpc("sarah_ai_clear_provider_config")');
    expect(edgeFunction).toContain('admin.rpc("sarah_ai_get_provider_secret")');
    expect(edgeFunction).toContain("sarah_ai_consume_my_manage_quota");
    expect(chatFunction).toContain('caller.rpc("sarah_ai_consume_my_quota"');
    expect(chatFunction).toContain('p_period: "hour"');
    expect(chatFunction).toContain('p_period: "day"');
    expect(chatFunction).toContain("AI_DAILY_LIMIT_REACHED");
    expect(chatFunction).toContain("Math.min(Math.max(configuredOutputTokens, 1), 4096)");
    expect(geminiAdapter).toContain('"x-goog-api-key": apiKey');
    expect(edgeFunction).not.toContain("console.log");
  });

  it("routes settings through the authenticated Edge Function and never stores the key in browser storage", () => {
    expect(clientService).toContain("/functions/v1/sarah-ai-settings");
    expect(clientService).toContain("Authorization:");
    expect(clientService).not.toContain("localStorage");
    expect(settingsPage).toContain('activeSettingsSection === "ai"');
    expect(settingsPage).toContain('hasPermission("ai:manage")');
    expect(settingsSection).toContain('type="password"');
    expect(settingsSection).toContain("aiSettingsService.save");
  });

  it("exports a portable integration contract without credentials or unimplemented tool schemas", () => {
    expect(integrationPackage).toContain("apiKeyIncluded: false");
    expect(integrationPackage).toContain("toolSchemasIncluded: false");
    expect(integrationPackage).toContain("No model-generated SQL");
    expect(integrationPackage).toContain("credentials must be entered again");
  });
});
