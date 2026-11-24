import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Sarah AI provider settings security contract", () => {
  const migration = read("supabase/migrations/20261124130000_sarah_ai_provider_configuration.sql");
  const edgeFunction = read("supabase/functions/sarah-ai-settings/index.ts");
  const clientService = read("src/services/ai/aiSettingsService.ts");
  const settingsPage = read("src/components/pages/SettingsPage.tsx");
  const settingsSection = read("src/components/settings/AISettingsSection.tsx");
  const integrationPackage = read("src/application/ai/sarahIntegrationPackage.ts");

  it("adds dedicated permissions and limits their default grant to Super Admin", () => {
    expect(migration).toContain("'ai:use'");
    expect(migration).toContain("'ai:manage'");
    expect(migration).toContain("('SUPER_ADMIN', 'ai:use')");
    expect(migration).toContain("('SUPER_ADMIN', 'ai:manage')");
    expect(migration).not.toContain("('ADMIN', 'ai:manage')");
    expect(migration).not.toContain("('MANAGER', 'ai:manage')");
  });

  it("keeps provider secrets out of the configuration table and browser roles", () => {
    const tableDefinition = migration.split("CREATE TABLE IF NOT EXISTS public.sarah_ai_provider_config")[1]
      ?.split(");")[0] || "";
    expect(tableDefinition).toContain("secret_id uuid");
    expect(tableDefinition).not.toMatch(/api[_A-Za-z]*key\s+text/i);
    expect(migration).toContain("ALTER TABLE public.sarah_ai_provider_config ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("REVOKE ALL ON TABLE public.sarah_ai_provider_config FROM PUBLIC, anon, authenticated");
    expect(migration).toContain("GRANT ALL ON TABLE public.sarah_ai_provider_config TO service_role");
    expect(migration).toContain("vault.create_secret");
    expect(migration).toContain("vault.update_secret");
    expect(migration).toContain("DELETE FROM vault.secrets");
  });

  it("validates the active admin session and ai:manage on the server before service-role access", () => {
    expect(edgeFunction).toContain('caller.rpc("get_current_admin_profile")');
    expect(edgeFunction).toContain('permissions.includes("ai:manage")');
    expect(edgeFunction).toContain("profile.auth_user_id !== authData.user.id");
    expect(edgeFunction).toContain("createClient(url, serviceKey");
    expect(edgeFunction).toContain("body.apiKey");
    expect(edgeFunction).toContain('admin.rpc("sarah_ai_get_provider_secret")');
    expect(edgeFunction).toContain('"x-goog-api-key": secret');
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
