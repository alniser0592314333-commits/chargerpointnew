import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { authService, AUTHORIZED_OWNER_BOOTSTRAP_EMAIL } from "../services/auth/authService";
import * as supabaseClient from "../services/supabase/client";

const OWNER_EMAIL = AUTHORIZED_OWNER_BOOTSTRAP_EMAIL;

describe("Phase 6.12.32: Direct One-Time Super Admin Bootstrap Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    vi.spyOn(supabaseClient, "rpcGetCurrentAdminProfile").mockResolvedValue({
      profile: {
        authenticated: true,
        is_admin: true,
        is_active: true,
        is_email_confirmed: true,
        admin_id: "admin_row_01",
        auth_user_id: "auth_usr_confirmed_01",
        username: "superowner",
        full_name: "Super Owner",
        email: OWNER_EMAIL,
        role: "SUPER_ADMIN",
        permissions: ["orders:view", "orders:deliver", "finance:credit-adjustment"],
      },
      error: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("1. Direct bootstrap executes signup/signin and RPC successfully", async () => {
    vi.spyOn(supabaseClient, "supabaseSignUp").mockResolvedValue({
      session: {
        access_token: "valid_jwt_token_123",
        user: { id: "auth_usr_confirmed_01", email: OWNER_EMAIL },
      },
      userOnly: false,
      error: null,
    });
    const bootstrapRpcSpy = vi.spyOn(supabaseClient, "rpcBootstrapFirstSuperAdmin").mockResolvedValue({
      success: true,
      data: {
        admin_id: "admin_row_01",
        username: "superowner",
        email: OWNER_EMAIL,
        role: "SUPER_ADMIN",
      },
      error: null,
    });

    const res = await authService.bootstrapFirstSuperAdmin({
      username: "superowner",
      fullName: "Super Owner",
      email: OWNER_EMAIL,
      password: "correct_password_123",
      bin: "789012",
    });

    expect(bootstrapRpcSpy).toHaveBeenCalledWith(
      {
        username: "superowner",
        fullName: "Super Owner",
        bin: "789012",
      },
      "valid_jwt_token_123"
    );
    expect(res.success).toBe(true);
  });

  it("2. Successful bootstrap establishes active Super Admin session in authService", async () => {
    vi.spyOn(supabaseClient, "supabaseSignUp").mockResolvedValue({
      session: {
        access_token: "valid_jwt_token_999",
        user: { id: "auth_usr_final", email: OWNER_EMAIL },
      },
      userOnly: false,
      error: null,
    });
    vi.spyOn(supabaseClient, "rpcBootstrapFirstSuperAdmin").mockResolvedValue({
      success: true,
      data: {
        admin_id: "admin_row_final",
        username: "finalowner",
        email: OWNER_EMAIL,
        role: "SUPER_ADMIN",
      },
      error: null,
    });

    vi.spyOn(authService, "getSupabaseAuthSession").mockResolvedValue({
      access_token: "valid_jwt_token_999",
      user: { id: "auth_usr_final", email: OWNER_EMAIL },
    });

    const res = await authService.bootstrapFirstSuperAdmin({
      username: "finalowner",
      fullName: "Final Owner",
      email: OWNER_EMAIL,
      password: "password_123",
      bin: "789012",
    });

    expect(res.success).toBe(true);
    const currentSession = await authService.getCurrentSession();
    expect(currentSession).toBeDefined();
    expect(currentSession?.role).toBe("SUPER_ADMIN");
    expect(currentSession?.email).toBe(OWNER_EMAIL);
  });
});
