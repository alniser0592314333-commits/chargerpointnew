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

  it("A: Login with username uses server-mediated sign-in without resolving email in the browser", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    const signInSpy = vi.spyOn(supabaseClient, "supabaseSignInWithUsername").mockResolvedValue({
      session: {
        access_token: "jwt_123",
        user: { id: "user_123", email: "al.niser.0592314333@gmail.com" },
      },
      error: null,
      statusCode: 200,
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

    expect(signInSpy).toHaveBeenCalledWith("superadmin", "validpass123", false);
    expect(session).not.toBeNull();
    expect(session?.email).toBe("al.niser.0592314333@gmail.com");
  });

  it("B: Login with email uses Supabase Auth directly", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    const usernameSignInSpy = vi.spyOn(supabaseClient, "supabaseSignInWithUsername");
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

    expect(usernameSignInSpy).not.toHaveBeenCalled();
    expect(signInSpy).toHaveBeenCalledWith("al.niser.0592314333@gmail.com", "validpass123", false);
    expect(session).not.toBeNull();
  });

  it("C: Invalid username returns generic invalid credentials without exposing an email", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    const signInSpy = vi.spyOn(supabaseClient, "supabaseSignInWithUsername").mockResolvedValue({
      session: null,
      error: "Invalid login credentials",
      statusCode: 401,
      isInvalidCredentials: true,
    });

    const session = await authService.login("invalid_user_name", "somepass");

    expect(signInSpy).toHaveBeenCalledWith("invalid_user_name", "somepass", false);
    expect(session).toBeNull();
  });

  it("D: Invalid password for valid identifier -> password authentication is actually attempted and returns null on failure", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    const usernameSignInSpy = vi.spyOn(supabaseClient, "supabaseSignInWithUsername");
    const signInSpy = vi.spyOn(supabaseClient, "supabaseSignInWithPassword").mockResolvedValue({
      session: null,
      error: "Invalid login credentials",
    });

    const session = await authService.login("al.niser.0592314333@gmail.com", "wrongpassword");

    expect(usernameSignInSpy).not.toHaveBeenCalled();
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
