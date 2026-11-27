import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("Business-hours elevated-write session guard", () => {
  it("routes writes through the caller's session-guarded canonical settings command", () => {
    const source = readFileSync("supabase/functions/business-hours/index.ts", "utf8");
    const callerClient = source.indexOf("const callerClient = createClient");
    const sessionCheck = source.indexOf('callerClient.rpc("is_active_admin_session")');
    const profileLookup = source.indexOf('callerClient.rpc("get_current_admin_profile")');
    const effectivePermission = source.indexOf('callerClient.rpc("get_effective_permissions", { p_admin_id: profile.admin_id })');
    const canonicalWrite = source.indexOf('callerClient.rpc("execute_sync_command"');

    expect(callerClient).toBeGreaterThan(-1);
    expect(sessionCheck).toBeGreaterThan(callerClient);
    expect(profileLookup).toBeGreaterThan(sessionCheck);
    expect(effectivePermission).toBeGreaterThan(profileLookup);
    expect(canonicalWrite).toBeGreaterThan(effectivePermission);
    expect(source).toContain('p_command_type: "SET_SYSTEM_SETTING"');
    expect(source).toContain('key: settingKey');
    expect(source).toContain('payloadHash');
    expect(source).toContain('resetGeneration');
    expect(source).not.toContain('adminClient.from("admins")');
    expect(source).not.toContain('adminClient.from("system_settings").upsert');
    expect(source).not.toContain('.from("admin_custom_permissions")');
    expect(source).not.toContain('.from("role_permissions")');
  });
});
