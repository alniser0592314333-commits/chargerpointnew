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

  it("switches the active identity instead of returning the previous account's in-memory permissions", async () => {
    const accountA: supabaseClient.SupabaseAuthSession = {
      ...authSession,
      access_token: "access-token-account-a",
      refresh_token: "refresh-token-account-a",
      user: { id: "auth-account-a", email: "account-a@example.test" },
    };
    const accountB: supabaseClient.SupabaseAuthSession = {
      ...authSession,
      access_token: "access-token-account-b",
      refresh_token: "refresh-token-account-b",
      user: { id: "auth-account-b", email: "account-b@example.test" },
    };

    supabaseClient.saveStoredSupabaseAuthSession(accountA);
    const profileSpy = vi.spyOn(authService, "getAdminProfile")
      .mockResolvedValueOnce(adminProfile({
        admin_id: "admin-account-a",
        auth_user_id: "auth-account-a",
        email: "account-a@example.test",
        permissions: ["orders:view"],
      }) as any)
      .mockResolvedValueOnce(adminProfile({
        admin_id: "admin-account-b",
        auth_user_id: "auth-account-b",
        email: "account-b@example.test",
        permissions: ["finances:read"],
      }) as any);

    const first = await authService.getCurrentSession(true);
    expect(first?.userId).toBe("admin-account-a");

    // Simulate another same-origin tab replacing the shared Supabase session.
    storageMap.set("supabase_auth_session", JSON.stringify(accountB));
    const second = await authService.getCurrentSession();

    expect(second?.userId).toBe("admin-account-b");
    expect(second?.email).toBe("account-b@example.test");
    expect(second?.permissions).toEqual(["finances:read"]);
    expect(profileSpy).toHaveBeenLastCalledWith("access-token-account-b");
    expect(supabaseClient.getSupabaseAuthToken()).toBe("access-token-account-b");
    expect(JSON.parse(storageMap.get("app_auth_session")!).email).toBe("account-b@example.test");
  });

  it("never falls back to the previous account's cached role when the newly selected account profile is unavailable", async () => {
    const accountA: supabaseClient.SupabaseAuthSession = {
      ...authSession,
      access_token: "access-token-account-a",
      user: { id: "auth-account-a", email: "account-a@example.test" },
    };
    const accountB: supabaseClient.SupabaseAuthSession = {
      ...authSession,
      access_token: "access-token-account-b",
      user: { id: "auth-account-b", email: "account-b@example.test" },
    };

    supabaseClient.saveStoredSupabaseAuthSession(accountA);
    vi.spyOn(authService, "getAdminProfile")
      .mockResolvedValueOnce(adminProfile({
        admin_id: "admin-account-a",
        auth_user_id: "auth-account-a",
        email: "account-a@example.test",
      }) as any)
      .mockResolvedValueOnce(null);

    const first = await authService.getCurrentSession(true);
    expect(first?.userId).toBe("admin-account-a");

    storageMap.set("supabase_auth_session", JSON.stringify(accountB));
    const switched = await authService.getCurrentSession();

    expect(switched).toBeNull();
    expect(storageMap.has("app_auth_session")).toBe(false);
  });

  it("prefers the latest persisted Supabase token over a stale module-level token", () => {
    supabaseClient.setSupabaseAuthToken("stale-account-a-token");
    const accountB = {
      ...authSession,
      access_token: "current-account-b-token",
      user: { id: "auth-account-b", email: "account-b@example.test" },
    };
    // A storage event updates localStorage in this context without updating
    // this module's private variable, exactly as happens in another tab.
    storageMap.set("supabase_auth_session", JSON.stringify(accountB));

    expect(supabaseClient.resolveAuthBearerToken()).toBe("current-account-b-token");
    expect(supabaseClient.getSupabaseAuthToken()).toBe("current-account-b-token");
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
    vi.spyOn(authService as any, "getAdminLoginGate").mockResolvedValue(adminProfile({
      role: "SUPER_ADMIN",
      permissions: [],
    }) as any);
    vi.spyOn(authService, "getAdminProfile").mockResolvedValue(adminProfile({
      role: "SUPER_ADMIN",
      permissions: ["admin:manage", "settings:manage"],
    }) as any);
    vi.spyOn(accountSessionService, "reactivateMyAccountSession").mockResolvedValue(undefined);

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
    expect(migration).toContain("get_my_admin_login_gate");
    expect(migration).toContain("session_expires_at <= now()");
  });


  it("blocks caller-selected native reactivation of an idle-expired existing session", () => {
    const migration = readFileSync("supabase/migrations/20261126193000_secure_idle_session_reactivation.sql", "utf8");
    const reactivation = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION public.reactivate_my_account_session"));
    expect(reactivation).toContain("a.session_expires_at <= now()");
    expect(reactivation).toContain("SESSION_IDLE_EXPIRED_REQUIRES_FRESH_AUTH");
    expect(reactivation).toContain("creates a new session ID");
    expect(reactivation).not.toContain("IF v_client_type = 'browser' AND EXISTS");
  });
  it("validates session identity in read-only transactions without attempting session writes", () => {
    const migration = readFileSync("supabase/migrations/20261122120000_admin_session_idle_expiry_policy.sql", "utf8");
    const activeSessionFunction = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION public.is_my_account_session_active"),
      migration.indexOf("CREATE OR REPLACE FUNCTION public.get_my_account_sessions"),
    );
    expect(activeSessionFunction).toContain("v_read_only boolean := current_setting('transaction_read_only', true) = 'on'");
    expect(activeSessionFunction).toContain("IF v_read_only THEN");
    expect(activeSessionFunction).toContain("IF NOT v_read_only AND");
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
    expect(app).toContain("checkingSession = true");
    expect(app).toContain("onVisibilityChange");
  });
  it("keeps native saved-account refresh tokens synchronized after every rotation", () => {
    const client = readFileSync("src/services/supabase/client.ts", "utf8");
    const vault = readFileSync("src/services/auth/accountBiometric.ts", "utf8");
    expect(client).toContain("syncSavedAdminQuickLoginTokenForSession(newSession)");
    expect(client).toContain("removeSavedAdminQuickLoginTokensForUser(newSession.user.id");
    expect(vault).toContain("mapping[cleanIdentifier.toLowerCase()] = authUserId");
    expect(vault).toContain("verified.value !== refreshToken");
  });

  it("uses the server RPC for per-client idle expiry and saved-login reactivation", () => {
    const service = readFileSync("src/services/auth/accountSessionService.ts", "utf8");
    const auth = readFileSync("src/services/auth/authService.ts", "utf8");
    expect(service).toContain('"register_my_account_session_v2"');
    expect(service).toContain('"reactivate_my_account_session"');
    expect(auth).toContain("await reactivateMyAccountSession(refreshed.access_token)");
    expect(auth).toContain("await reactivateMyAccountSession(token)");
  });

  it("provides separate save-and-sign-out and revoke-and-sign-out choices", () => {
    const settings = readFileSync("src/components/pages/SettingsPage.tsx", "utf8");
    const app = readFileSync("src/App.tsx", "utf8");
    expect(settings).toContain('completeLogout("save")');
    expect(settings).toContain('completeLogout("forget")');
    expect(app).toContain("authService.logout({ revokeCurrentSession: true })");
    expect(app).toContain("saveAdminQuickLoginToken(identifier, currentAuth.refresh_token, currentAuth.user.id)");
  });

  it("rechecks administrator activation at the time a biometric challenge is consumed", () => {
    const edge = readFileSync("supabase/functions/account-biometric/index.ts", "utf8");
    expect(edge).toContain('if (cred.account_type === "admin")');
    expect(edge).toContain("adminRow?.is_active !== true");
  });

});
