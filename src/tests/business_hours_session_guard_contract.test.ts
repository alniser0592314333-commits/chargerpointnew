import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("Business-hours elevated-write session guard", () => {
  it("checks the caller's registered active admin session before service-role settings access", () => {
    const source = readFileSync("supabase/functions/business-hours/index.ts", "utf8");
    const callerClient = source.indexOf("const callerClient = createClient");
    const sessionCheck = source.indexOf('callerClient.rpc("is_active_admin_session")');
    const adminLookup = source.indexOf('adminClient\n    .from("admins")');
    const denial = source.indexOf('error: "ADMIN_SESSION_REQUIRED"');

    expect(callerClient).toBeGreaterThan(-1);
    expect(sessionCheck).toBeGreaterThan(callerClient);
    expect(adminLookup).toBeGreaterThan(sessionCheck);
    expect(denial).toBeGreaterThan(sessionCheck);
    expect(source).toContain('callerClient.rpc("get_effective_permissions", { p_admin_id: admin.id })');
    expect(source).not.toContain('admin.permissions.includes("settings:manage")');
    expect(source).not.toContain('.from("admin_custom_permissions")');
    expect(source).not.toContain('.from("role_permissions")');
  });
});
