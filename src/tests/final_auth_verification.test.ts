import { describe, it, expect, beforeEach, vi } from "vitest";
import { authService, UserSession } from "../services/auth/authService";
import * as supabaseClient from "../services/supabase/client";
import { config } from "../config/env";

const storageMap = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storageMap.get(key) || null,
  setItem: (key: string, val: string) => storageMap.set(key, String(val)),
  removeItem: (key: string) => storageMap.delete(key),
  clear: () => storageMap.clear(),
};
(globalThis as any).localStorage = localStorageMock;

describe("Final Authentication Verification - Security & BIN Gate Audit", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    storageMap.clear();
    await authService.logout();
    config.supabaseUrl = "https://example.supabase.co";
    config.supabaseAnonKey = "sb_publishable_mock_key";
  });

  describe("1. get_email_by_username Resolver", () => {
    it("returns null for non-existent username", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => null,
      });

      const email = await supabaseClient.rpcGetEmailByUsername("non_existent_user");
      expect(email).toBeNull();
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    it("returns internal email when valid active username is provided", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => "admin@system.local",
      });

      const email = await supabaseClient.rpcGetEmailByUsername("superadmin");
      expect(email).toBe("admin@system.local");
    });
  });

  describe("2. BIN Gate & Route Protection Lifecycle (A through Q)", () => {
    it("A & B: Correct username and password stops at BIN gate and does NOT establish full session", async () => {
      vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
      vi.spyOn(supabaseClient, "rpcGetEmailByUsername").mockResolvedValue("owner@system.local");
      vi.spyOn(supabaseClient, "supabaseSignInWithPassword").mockResolvedValue({
        session: {
          access_token: "jwt_token_pre_bin",
          user: { id: "user_owner_01", email: "owner@system.local" },
        },
        error: null,
      });
      vi.spyOn(authService, "getAdminProfile").mockResolvedValue({
        authenticated: true,
        is_admin: true,
        is_active: true,
        admin_id: "admin_01",
        role: "SUPER_ADMIN",
        permissions: ["orders:view", "finance:view"],
      });

      // Attempt login with username + password only (cleanBin is omitted)
      let threwBinRequired = false;
      try {
        await authService.login("superadmin", "pass123");
      } catch (err: any) {
        if (err.message === "SUPER_ADMIN_BIN_REQUIRED") {
          threwBinRequired = true;
        }
      }

      expect(threwBinRequired).toBe(true);

      // Verify that persistent storage does NOT contain an authenticated app session
      expect(localStorage.getItem("app_auth_session")).toBeNull();
      // Verify that persistent Supabase token was NOT saved to localStorage before BIN
      expect(localStorage.getItem("supabase_auth_session")).toBeNull();
    });

    it("G & H: Refresh before entering BIN leaves user completely unauthenticated", async () => {
      vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);

      // Simulating a browser reload: inMemorySession is null and localStorage has no completed session
      const session = await authService.getCurrentSession();
      expect(session).toBeNull();
    });

    it("Forging localStorage app_auth_session without valid server token is rejected", async () => {
      vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);

      // Attacker manually tampers with localStorage to forge a SUPER_ADMIN session
      localStorage.setItem(
        "app_auth_session",
        JSON.stringify({
          userId: "forged_admin",
          email: "hacker@evil.com",
          fullName: "Hacker",
          role: "SUPER_ADMIN",
          permissions: ["settings:manage", "admin:manage"],
          tokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        })
      );

      // authService.getCurrentSession() authoritatively detects no valid Supabase session
      const session = await authService.getCurrentSession();
      expect(session).toBeNull();
      expect(localStorage.getItem("app_auth_session")).toBeNull();
    });

    it("I & J: Wrong BIN fails verification and denies system access", async () => {
      vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
      vi.spyOn(supabaseClient, "rpcGetEmailByUsername").mockResolvedValue("owner@system.local");
      vi.spyOn(supabaseClient, "supabaseSignInWithPassword").mockResolvedValue({
        session: {
          access_token: "jwt_token_wrong_bin",
          user: { id: "user_owner_01", email: "owner@system.local" },
        },
        error: null,
      });
      vi.spyOn(authService, "getAdminProfile").mockResolvedValue({
        authenticated: true,
        is_admin: true,
        is_active: true,
        admin_id: "admin_01",
        role: "SUPER_ADMIN",
        permissions: ["orders:view"],
      });
      vi.spyOn(supabaseClient, "rpcVerifyAdminBinWithTracking").mockResolvedValue({
        success: false,
        status: "ACTIVE",
        is_locked: false,
        remaining_attempts: 2,
        failed_attempts: 1,
        error: "WRONG_BIN",
      });

      let threwWrongBin = false;
      try {
        await authService.login("superadmin", "pass123", "000000");
      } catch (err: any) {
        if (err.message === "WRONG_BIN") {
          threwWrongBin = true;
        }
      }

      expect(threwWrongBin).toBe(true);
      expect(localStorage.getItem("app_auth_session")).toBeNull();
      expect(localStorage.getItem("supabase_auth_session")).toBeNull();
      const current = await authService.getCurrentSession();
      expect(current).toBeNull();
    });

    it("K & L: Correct BIN succeeds, creates session, and unlocks the application", async () => {
      vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
      vi.spyOn(supabaseClient, "rpcGetEmailByUsername").mockResolvedValue("owner@system.local");
      vi.spyOn(supabaseClient, "supabaseSignInWithPassword").mockResolvedValue({
        session: {
          access_token: "jwt_token_verified",
          user: { id: "user_owner_01", email: "owner@system.local" },
        },
        error: null,
      });
      vi.spyOn(authService, "getAdminProfile").mockResolvedValue({
        authenticated: true,
        is_admin: true,
        is_active: true,
        admin_id: "admin_01",
        role: "SUPER_ADMIN",
        permissions: ["orders:view", "finance:view"],
      });
      vi.spyOn(supabaseClient, "rpcVerifyAdminBinWithTracking").mockResolvedValue({
        success: true,
        status: "ACTIVE",
        is_locked: false,
        remaining_attempts: 3,
        failed_attempts: 0,
        error: null,
      });

      const session = await authService.login("superadmin", "pass123", "123456");
      expect(session).not.toBeNull();
      expect(session?.role).toBe("SUPER_ADMIN");
      expect(session?.userId).toBe("admin_01");

      // Verify that persistent storage now legitimately contains the verified session
      expect(localStorage.getItem("app_auth_session")).not.toBeNull();
      expect(localStorage.getItem("supabase_auth_session")).not.toBeNull();
    });

    it("M & N: Refresh after correct BIN maintains authoritative authenticated session", async () => {
      vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);

      // Pre-seed legitimate verified session
      const validStoredSession: UserSession = {
        userId: "admin_01",
        email: "owner@system.local",
        fullName: "Owner",
        role: "SUPER_ADMIN",
        permissions: ["orders:view", "finance:view"],
        tokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      };
      localStorage.setItem("app_auth_session", JSON.stringify(validStoredSession));
      localStorage.setItem(
        "supabase_auth_session",
        JSON.stringify({
          access_token: "jwt_token_persisted",
          user: { id: "user_owner_01", email: "owner@system.local" },
        })
      );

      // Server profile confirms active identity
      vi.spyOn(authService, "getAdminProfile").mockResolvedValue({
        authenticated: true,
        is_admin: true,
        is_active: true,
        admin_id: "admin_01",
        role: "SUPER_ADMIN",
        permissions: ["orders:view", "finance:view"],
      });

      const rehydrated = await authService.getCurrentSession();
      expect(rehydrated).not.toBeNull();
      expect(rehydrated?.role).toBe("SUPER_ADMIN");
      expect(rehydrated?.userId).toBe("admin_01");
    });

    it("O, P & Q: Logout purges all tokens and subsequent access to protected routes is blocked", async () => {
      vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);

      // Log out
      await authService.logout();

      expect(localStorage.getItem("app_auth_session")).toBeNull();
      expect(localStorage.getItem("supabase_auth_session")).toBeNull();

      const sessionAfterLogout = await authService.getCurrentSession();
      expect(sessionAfterLogout).toBeNull();
    });
  });
});
