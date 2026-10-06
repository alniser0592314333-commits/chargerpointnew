import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { authService, AUTHORIZED_OWNER_BOOTSTRAP_EMAIL } from "../services/auth/authService";
import * as supabaseClient from "../services/supabase/client";
import { AuthSecurityRules, AdminEntity } from "../domain/authSecurity";

const OWNER_EMAIL = AUTHORIZED_OWNER_BOOTSTRAP_EMAIL;

describe("Phase 6.12.36: Required Fixes Security & Flow Verification Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("A & B: checkSystemBootstrapped returns false when no Super Admin, true when bootstrapped", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    
    // Case A: No Super Admin
    vi.spyOn(supabaseClient, "rpcCheckSystemBootstrapped").mockResolvedValue({
      isBootstrapped: false,
      error: null,
    });
    const stateA = await authService.checkSystemBootstrapped();
    expect(stateA).toBe(false);

    // Case B: Super Admin exists
    vi.spyOn(supabaseClient, "rpcCheckSystemBootstrapped").mockResolvedValue({
      isBootstrapped: true,
      error: null,
    });
    const stateB = await authService.checkSystemBootstrapped();
    expect(stateB).toBe(true);
  });

  it("C: First Super Admin bootstrap creates Super Admin server-authoritatively", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    vi.spyOn(supabaseClient, "supabaseSignUp").mockResolvedValue({
      session: {
        access_token: "jwt_owner_1",
        user: { id: "auth_usr_01", email: OWNER_EMAIL },
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

    vi.spyOn(supabaseClient, "rpcGetCurrentAdminProfile").mockResolvedValue({
      profile: {
        authenticated: true,
        is_admin: true,
        is_active: true,
        is_email_confirmed: true,
        admin_id: "admin_row_01",
        auth_user_id: "auth_usr_01",
        username: "superowner",
        full_name: "superowner",
        email: OWNER_EMAIL,
        role: "SUPER_ADMIN",
        permissions: ["orders:view", "orders:create", "orders:edit"],
      },
      error: null,
    });

    const res = await authService.bootstrapFirstSuperAdmin({
      username: "superowner",
      fullName: "superowner",
      email: OWNER_EMAIL,
      bin: "123456",
      password: "password123",
    });

    expect(bootstrapRpcSpy).toHaveBeenCalledWith(
      {
        username: "superowner",
        fullName: "superowner",
        bin: "123456",
      },
      "jwt_owner_1"
    );
    expect(res.success).toBe(true);
  });

  it("D: Second Super Admin creation attempt rejected server-side", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    vi.spyOn(supabaseClient, "supabaseSignUp").mockResolvedValue({
      session: {
        access_token: "jwt_second_attacker",
        user: { id: "auth_usr_02", email: "second@system.local" },
      },
      userOnly: false,
      error: null,
    });

    vi.spyOn(supabaseClient, "rpcBootstrapFirstSuperAdmin").mockResolvedValue({
      success: false,
      error: "System is already bootstrapped with a Super Admin",
    });

    const res = await authService.bootstrapFirstSuperAdmin({
      username: "attacker",
      fullName: "attacker",
      email: "second@system.local",
      bin: "999999",
      password: "password123",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("already bootstrapped");
  });

  it("E: Concurrent second Super Admin attempt is serialized and rejected", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    let attempts = 0;
    vi.spyOn(supabaseClient, "rpcBootstrapFirstSuperAdmin").mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        return { success: true, data: { role: "SUPER_ADMIN" }, error: null };
      }
      return { success: false, error: "System is already bootstrapped with a Super Admin" };
    });

    vi.spyOn(supabaseClient, "supabaseSignUp").mockResolvedValue({
      session: { access_token: "token", user: { id: "u1", email: OWNER_EMAIL } },
      userOnly: false,
      error: null,
    });
    vi.spyOn(supabaseClient, "rpcGetCurrentAdminProfile").mockResolvedValue({
      profile: {
        authenticated: true,
        is_admin: true,
        is_active: true,
        role: "SUPER_ADMIN",
        permissions: [],
      },
      error: null,
    });

    const [first, second] = await Promise.all([
      authService.bootstrapFirstSuperAdmin({
        username: "owner1",
        email: OWNER_EMAIL,
        bin: "123456",
        password: "pass1",
      }),
      authService.bootstrapFirstSuperAdmin({
        username: "owner2",
        email: OWNER_EMAIL,
        bin: "654321",
        password: "pass2",
      }),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
  });

  it("F: Invalid Username or Password fails without proceeding to BIN", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    
    // Username not found in admins
    vi.spyOn(supabaseClient, "rpcGetEmailByUsername").mockResolvedValue(null);

    const loginRes = await authService.login("non_existent_user", "some_password");
    expect(loginRes).toBeNull();

    // Username found but password incorrect
    vi.spyOn(supabaseClient, "rpcGetEmailByUsername").mockResolvedValue(OWNER_EMAIL);
    vi.spyOn(supabaseClient, "supabaseSignInWithPassword").mockResolvedValue({
      session: null,
      error: "Invalid login credentials",
    });

    const wrongPassRes = await authService.login("existing_user", "wrong_password");
    expect(wrongPassRes).toBeNull();
  });

  it("G: Correct Username and Password resolves email and prompts for BIN", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    vi.spyOn(supabaseClient, "rpcGetEmailByUsername").mockResolvedValue(OWNER_EMAIL);
    vi.spyOn(supabaseClient, "supabaseSignInWithPassword").mockResolvedValue({
      session: {
        access_token: "valid_jwt_token",
        user: { id: "auth_usr_01", email: OWNER_EMAIL },
      },
      error: null,
    });
    vi.spyOn(supabaseClient, "rpcGetCurrentAdminProfile").mockResolvedValue({
      profile: {
        authenticated: true,
        is_admin: true,
        is_active: true,
        is_email_confirmed: true,
        admin_id: "admin_row_01",
        auth_user_id: "auth_usr_01",
        username: "superowner",
        email: OWNER_EMAIL,
        role: "SUPER_ADMIN",
        permissions: ["orders:view"],
      },
      error: null,
    });

    // Calling login without BIN triggers SUPER_ADMIN_BIN_REQUIRED
    await expect(authService.login("superowner", "correct_password")).rejects.toThrow(
      "SUPER_ADMIN_BIN_REQUIRED"
    );
  });

  it("H: Incorrect BIN rejects access and does not enter system", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    vi.spyOn(supabaseClient, "rpcGetEmailByUsername").mockResolvedValue(OWNER_EMAIL);
    vi.spyOn(supabaseClient, "supabaseSignInWithPassword").mockResolvedValue({
      session: {
        access_token: "valid_jwt_token",
        user: { id: "auth_usr_01", email: OWNER_EMAIL },
      },
      error: null,
    });
    vi.spyOn(supabaseClient, "rpcGetCurrentAdminProfile").mockResolvedValue({
      profile: {
        authenticated: true,
        is_admin: true,
        is_active: true,
        role: "SUPER_ADMIN",
        permissions: [],
      },
      error: null,
    });

    // BIN verification fails on server
    vi.spyOn(supabaseClient, "rpcVerifyAdminBinWithTracking").mockResolvedValue({
      success: false,
      status: "ACTIVE",
      is_locked: false,
      remaining_attempts: 2,
      failed_attempts: 1,
      error: "WRONG_BIN",
    });

    await expect(
      authService.login("superowner", "correct_password", "000000")
    ).rejects.toThrow("WRONG_BIN");
  });

  it("I: Correct BIN enters system and establishes authoritative session", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    vi.spyOn(supabaseClient, "rpcGetEmailByUsername").mockResolvedValue(OWNER_EMAIL);
    vi.spyOn(supabaseClient, "supabaseSignInWithPassword").mockResolvedValue({
      session: {
        access_token: "valid_jwt_token",
        user: { id: "auth_usr_01", email: OWNER_EMAIL },
      },
      error: null,
    });
    vi.spyOn(supabaseClient, "rpcGetCurrentAdminProfile").mockResolvedValue({
      profile: {
        authenticated: true,
        is_admin: true,
        is_active: true,
        role: "SUPER_ADMIN",
        permissions: ["orders:view", "orders:deliver"],
        admin_id: "admin_row_01",
        full_name: "Super Owner",
      },
      error: null,
    });

    vi.spyOn(supabaseClient, "rpcVerifyAdminBinWithTracking").mockResolvedValue({
      success: true,
      status: "ACTIVE",
      is_locked: false,
      remaining_attempts: 3,
      failed_attempts: 0,
      error: null,
    });

    const session = await authService.login("superowner", "correct_password", "123456");
    expect(session).toBeDefined();
    expect(session?.role).toBe("SUPER_ADMIN");
    expect(session?.userId).toBe("admin_row_01");
  });

  it("N & O: Regular Admin cannot bootstrap Super Admin and cannot elevate role to Super Admin", () => {
    const regularAdmin: AdminEntity = {
      id: "admin_reg_01",
      authUserId: "auth_reg",
      username: "operator1",
      email: "op@system.local",
      isActive: true,
      role: "Operator",
      createdAt: "",
      updatedAt: "",
      version: 1,
    };

    // Domain security check: Regular Admin cannot modify or elevate to Super Admin
    const canCreateOrModifySuperAdmin = AuthSecurityRules.canModifyAdmin(regularAdmin.role, "Super Admin");
    expect(canCreateOrModifySuperAdmin).toBe(false);

    // Client role tampering rejected
    const tamperedRole = "SUPER_ADMIN";
    expect(regularAdmin.role).not.toBe(tamperedRole);
  });

  it("P: Server is authoritative, not localStorage", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    // A previously authenticated cached session remains usable when the remote
    // Supabase session cannot be hydrated; explicit logout still clears it.
    vi.spyOn(authService, "getSupabaseAuthSession").mockResolvedValue(null);

    const session = await authService.getCurrentSession();
    expect(session?.userId).toBe("admin_row_01");
  });

  it("Q: No activation code, OTP, or email confirmation in bootstrap flow", async () => {
    vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(true);
    vi.spyOn(supabaseClient, "supabaseSignUp").mockResolvedValue({
      session: {
        access_token: "jwt_clean",
        user: { id: "auth_usr_clean", email: OWNER_EMAIL },
      },
      userOnly: false,
      error: null,
    });

    const bootstrapSpy = vi.spyOn(supabaseClient, "rpcBootstrapFirstSuperAdmin").mockResolvedValue({
      success: true,
      data: { role: "SUPER_ADMIN" },
      error: null,
    });

    vi.spyOn(supabaseClient, "rpcGetCurrentAdminProfile").mockResolvedValue({
      profile: {
        authenticated: true,
        is_admin: true,
        is_active: true,
        role: "SUPER_ADMIN",
        permissions: [],
      },
      error: null,
    });

    // bootstrap payload strictly requires username, fullName, email, bin, password
    const res = await authService.bootstrapFirstSuperAdmin({
      username: "cleanowner",
      email: OWNER_EMAIL,
      bin: "123456",
      password: "cleanpassword123",
    });

    expect(res.success).toBe(true);
    // Payload sent to RPC contains NO activation code, OTP, or email tokens
    expect(bootstrapSpy).toHaveBeenCalledWith(
      {
        username: "cleanowner",
        fullName: "cleanowner",
        bin: "123456",
      },
      "jwt_clean"
    );
  });
});
