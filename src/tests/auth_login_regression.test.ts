import { describe, it, expect, beforeEach, vi } from "vitest";
import { authService } from "../services/auth/authService";
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

describe("Auth Regression Fix Verification (A through F)", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    storageMap.clear();
    await authService.logout();
    config.supabaseUrl = "https://ydhcyamtgioyrxfarkwk.supabase.co";
    config.supabaseAnonKey = "sb_publishable_mock_key";
  });

  it("A: Login with username -> authService.login receives username and resolves email via rpcGetEmailByUsername", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    const rpcSpy = vi.spyOn(supabaseClient, "rpcGetEmailByUsername").mockResolvedValue("al.niser.0592314333@gmail.com");
    const signInSpy = vi.spyOn(supabaseClient, "supabaseSignInWithPassword").mockResolvedValue({
      session: {
        access_token: "jwt_123",
        user: { id: "user_123", email: "al.niser.0592314333@gmail.com" },
      },
      error: null,
    });
    vi.spyOn(authService, "getAdminProfile").mockResolvedValue({
      authenticated: true,
      is_admin: true,
      is_active: true,
      admin_id: "admin_123",
      role: "ADMIN",
      permissions: ["orders:view"],
    });

    const session = await authService.login("superadmin", "validpass123");

    expect(rpcSpy).toHaveBeenCalledWith("superadmin");
    expect(signInSpy).toHaveBeenCalledWith("al.niser.0592314333@gmail.com", "validpass123", false);
    expect(session).not.toBeNull();
    expect(session?.email).toBe("al.niser.0592314333@gmail.com");
  });

  it("B: Login with email -> authService.login receives email directly and rpcGetEmailByUsername is NOT called", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    const rpcSpy = vi.spyOn(supabaseClient, "rpcGetEmailByUsername");
    const signInSpy = vi.spyOn(supabaseClient, "supabaseSignInWithPassword").mockResolvedValue({
      session: {
        access_token: "jwt_456",
        user: { id: "user_456", email: "al.niser.0592314333@gmail.com" },
      },
      error: null,
    });
    vi.spyOn(authService, "getAdminProfile").mockResolvedValue({
      authenticated: true,
      is_admin: true,
      is_active: true,
      admin_id: "admin_456",
      role: "ADMIN",
      permissions: ["orders:view"],
    });

    const session = await authService.login("al.niser.0592314333@gmail.com", "validpass123");

    expect(rpcSpy).not.toHaveBeenCalled();
    expect(signInSpy).toHaveBeenCalledWith("al.niser.0592314333@gmail.com", "validpass123", false);
    expect(session).not.toBeNull();
  });

  it("C: Invalid username -> rpcGetEmailByUsername returns null and authService.login returns null", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    const rpcSpy = vi.spyOn(supabaseClient, "rpcGetEmailByUsername").mockResolvedValue(null);
    const signInSpy = vi.spyOn(supabaseClient, "supabaseSignInWithPassword");

    const session = await authService.login("invalid_user_name", "somepass");

    expect(rpcSpy).toHaveBeenCalledWith("invalid_user_name");
    expect(signInSpy).not.toHaveBeenCalled();
    expect(session).toBeNull();
  });

  it("D: Invalid password for valid identifier -> password authentication is actually attempted and returns null on failure", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    const rpcSpy = vi.spyOn(supabaseClient, "rpcGetEmailByUsername");
    const signInSpy = vi.spyOn(supabaseClient, "supabaseSignInWithPassword").mockResolvedValue({
      session: null,
      error: "Invalid login credentials",
    });

    const session = await authService.login("al.niser.0592314333@gmail.com", "wrongpassword");

    expect(rpcSpy).not.toHaveBeenCalled();
    expect(signInSpy).toHaveBeenCalledWith("al.niser.0592314333@gmail.com", "wrongpassword", false);
    expect(session).toBeNull();
  });

  it("E: Super Admin valid password -> throws SUPER_ADMIN_BIN_REQUIRED as expected", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    vi.spyOn(supabaseClient, "supabaseSignInWithPassword").mockResolvedValue({
      session: {
        access_token: "jwt_super",
        user: { id: "user_super", email: "al.niser.0592314333@gmail.com" },
      },
      error: null,
    });
    vi.spyOn(authService, "getAdminProfile").mockResolvedValue({
      authenticated: true,
      is_admin: true,
      is_active: true,
      admin_id: "admin_super",
      role: "SUPER_ADMIN",
      permissions: ["admin:manage"],
    });

    await expect(authService.login("al.niser.0592314333@gmail.com", "superpass")).rejects.toThrow(
      "SUPER_ADMIN_BIN_REQUIRED"
    );
  });

  it("F: Super Admin BIN verification -> second step continues normally with BIN validation", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    vi.spyOn(supabaseClient, "supabaseSignInWithPassword").mockResolvedValue({
      session: {
        access_token: "jwt_super_final",
        user: { id: "user_super", email: "al.niser.0592314333@gmail.com" },
      },
      error: null,
    });
    vi.spyOn(authService, "getAdminProfile").mockResolvedValue({
      authenticated: true,
      is_admin: true,
      is_active: true,
      admin_id: "admin_super",
      role: "SUPER_ADMIN",
      permissions: ["admin:manage"],
    });
    const verifyBinSpy = vi.spyOn(supabaseClient, "rpcVerifyAdminBinWithTracking").mockResolvedValue({
      success: true,
      status: "ACTIVE",
      is_locked: false,
      remaining_attempts: 3,
      failed_attempts: 0,
    });

    const session = await authService.login("al.niser.0592314333@gmail.com", "superpass", "123456");

    expect(verifyBinSpy).toHaveBeenCalledWith("123456", "jwt_super_final");
    expect(session).not.toBeNull();
    expect(session?.role).toBe("SUPER_ADMIN");
  });
});
