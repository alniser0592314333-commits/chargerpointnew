import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { authService } from "../services/auth/authService";
import * as supabaseClient from "../services/supabase/client";
import * as accountSessionService from "../services/auth/accountSessionService";
import { config } from "../config/env";

const storageMap = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storageMap.get(key) || null,
  setItem: (key: string, value: string) => storageMap.set(key, String(value)),
  removeItem: (key: string) => storageMap.delete(key),
  clear: () => storageMap.clear(),
};
(globalThis as any).localStorage = localStorageMock;

const adminProfile = (overrides: Record<string, unknown> = {}) => ({
  authenticated: true,
  is_admin: true,
  is_active: true,
  admin_id: "admin-lifecycle-01",
  auth_user_id: "auth-lifecycle-01",
  email: "admin@example.test",
  username: "admin",
  full_name: "Admin User",
  role: "ADMIN",
  permissions: ["orders:view"],
  ...overrides,
});

const authSession: supabaseClient.SupabaseAuthSession = {
  access_token: "valid-access-token",
  refresh_token: "valid-refresh-token",
  token_type: "bearer",
  expires_in: 3600,
  user: { id: "auth-lifecycle-01", email: "admin@example.test" },
};

describe("Admin session lifecycle root-cause regressions", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    storageMap.clear();
    await authService.logout();
    config.supabaseUrl = "https://ydhcyamtgioyrxfarkwk.supabase.co";
    config.supabaseAnonKey = "sb_publishable_mock_key";
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rehydrates an expired local session from a valid server profile and refreshes permissions", async () => {
    supabaseClient.saveStoredSupabaseAuthSession(authSession);
    storageMap.set("app_auth_session", JSON.stringify({
      userId: "admin-lifecycle-01",
      email: "admin@example.test",
      fullName: "Old Cached Name",
      role: "ADMIN",
      permissions: ["orders:view"],
      tokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    vi.spyOn(authService, "getAdminProfile").mockResolvedValue(adminProfile({
      full_name: "Current Server Name",
      role: "FINANCE",
      permissions: ["finances:read", "finances:write"],
    }) as any);

    const session = await authService.getCurrentSession(true);

    expect(session?.fullName).toBe("Current Server Name");
    expect(session?.role).toBe("FINANCE");
    expect(session?.permissions).toEqual(["finances:read", "finances:write"]);
    expect(Date.parse(session!.tokenExpiresAt)).toBeGreaterThan(Date.now());
    expect(JSON.parse(storageMap.get("app_auth_session")!).permissions).toEqual(["finances:read", "finances:write"]);
  });

  it("replaces stale cached permissions whenever the server profile is refreshed", async () => {
    supabaseClient.saveStoredSupabaseAuthSession(authSession);
    storageMap.set("app_auth_session", JSON.stringify({
      userId: "admin-lifecycle-01",
      email: "admin@example.test",
      fullName: "Admin User",
      role: "ADMIN",
      permissions: ["orders:view", "orders:write"],
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }));
    vi.spyOn(authService, "getAdminProfile").mockResolvedValue(adminProfile({
      permissions: ["orders:view"],
    }) as any);

    const session = await authService.getCurrentSession(true);

    expect(session?.permissions).toEqual(["orders:view"]);
    expect(JSON.parse(storageMap.get("app_auth_session")!).permissions).toEqual(["orders:view"]);
  });

  it("does not persist a Super Admin biometric session until BIN succeeds", async () => {
    vi.spyOn(authService, "getAdminProfile").mockResolvedValue(adminProfile({
      role: "SUPER_ADMIN",
      permissions: ["admin:manage", "settings:manage"],
    }) as any);
    vi.spyOn(accountSessionService, "reactivateMyAccountSession").mockResolvedValue();

    await expect(authService.acceptBiometricSession(authSession)).rejects.toThrow("SUPER_ADMIN_BIN_REQUIRED");

    expect(authService.hasPendingSuperAdminContext()).toBe(true);
    expect(supabaseClient.getStoredSupabaseAuthSession()).toBeNull();
    expect(storageMap.get("app_auth_session")).toBeUndefined();

    vi.spyOn(supabaseClient, "rpcVerifyAdminBinWithTracking").mockResolvedValue({
      success: true,
      status: "ACTIVE",
      is_locked: false,
      remaining_attempts: 3,
      failed_attempts: 0,
      error: null,
    } as any);

    const session = await authService.verifySuperAdminBin("1234");

    expect(session?.role).toBe("SUPER_ADMIN");
    expect(supabaseClient.getStoredSupabaseAuthSession()?.access_token).toBe("valid-access-token");
    expect(storageMap.get("app_auth_session")).toBeTruthy();
    expect(accountSessionService.reactivateMyAccountSession).toHaveBeenCalledWith("valid-access-token");
    expect(authService.hasPendingSuperAdminContext()).toBe(false);
  });

  it("keeps the server-enforced client-specific idle policy and five-minute activity write throttle", () => {
    const migration = readFileSync("supabase/migrations/20261122120000_admin_session_idle_expiry_policy.sql", "utf8");
    expect(migration).toContain("interval '30 days'");
    expect(migration).toContain("interval '7 days'");
    expect(migration).toContain("interval '5 minutes'");
    expect(migration).toContain("SESSION_IDLE_EXPIRED");
    expect(migration).toContain("reactivate_my_account_session");
    expect(migration).toContain("session_expires_at <= now()");
  });

  it("checks the native vault commit result and verifies persisted ciphertext", () => {
    const java = readFileSync("scripts/android/AccountBiometricPlugin.java", "utf8");
    expect(java).toContain("boolean committed = preferences.edit()");
    expect(java).toContain("if (!committed) throw new IllegalStateException");
    expect(java).toContain("if (!packed.equals(persisted)) throw new IllegalStateException");
  });

  it("routes biometric Super Admin login through the existing BIN screen", () => {
    const loginPage = readFileSync("src/components/pages/LoginPage.tsx", "utf8");
    expect(loginPage).toContain('if (code === "SUPER_ADMIN_BIN_REQUIRED")');
    expect(loginPage).toContain('setUiState("SUPER_ADMIN_BIN_REQUIRED")');
    expect(loginPage).toContain("setIsSavedQuickLogin(true)");
  });

  it("applies refreshed server permissions to the authenticated React session", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    expect(app).toContain("const session = await authService.getCurrentSession(true)");
    expect(app).toContain("setUserSession(session)");
  });
});
