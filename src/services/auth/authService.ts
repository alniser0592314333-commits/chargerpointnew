/**
 * Authentication & Authorization (RBAC) Architecture Layer
 * Provides user sessions, roles, Super Admin test account, and BIN security verification.
 * Phase 6.12.17: Server-Authoritative Identity Profile Resolution & Separated BIN Challenge.
 */

import { ID, Timestamp } from "../../types/common";
import {
  getSupabaseStatus,
  supabaseSignInWithPassword,
  supabaseSignUp,
  rpcCheckSystemBootstrapped,
  rpcBootstrapFirstSuperAdmin,
  rpcVerifyAdminBin,
  rpcVerifyAdminBinWithTracking,
  rpcIssueBinRecoveryProof,
  rpcRecoverAndResetAdminBin,
  rpcSetAdminBin,
  rpcGetCurrentAdminProfile,
  rpcGetEmailByUsername,
  rpcResolveEmailByUsername,
  getLastGetEmailError,
  AdminProfileRpcResult,
  setSupabaseAuthToken,
  getSupabaseAuthToken,
  getStoredSupabaseAuthSession,
  clearStoredSupabaseAuthSession,
  parseSupabaseAuthCallbackFromUrl,
  saveStoredSupabaseAuthSession,
  SupabaseAuthSession,
  supabaseVerifyEmailOtp,
  supabaseResendEmailOtp,
} from "../supabase/client";
import { config } from "../../config/env";

export type UserRole = "SUPER_ADMIN" | "ADMIN" | "MANAGER" | "STAFF" | "VIEWER" | "OPERATOR" | "FINANCE";

export type Permission =
  | "customers:read"
  | "customers:write"
  | "orders:read"
  | "orders:write"
  | "finances:read"
  | "finances:write"
  | "settings:manage"
  | "admin:manage"
  | "orders:view"
  | "orders:create"
  | "orders:edit"
  | "orders:deliver"
  | "orders:cancel"
  | "orders:correct"
  | "customers:view"
  | "customers:create"
  | "customers:edit"
  | "customers:deactivate"
  | "customers:debt-limit"
  | "customers:charger-exemption"
  | "customers:financial-view"
  | "finance:view"
  | "finance:create-payment"
  | "finance:approve-payment"
  | "finance:refund"
  | "finance:correction"
  | "finance:credit-adjustment"
  | "devices:view"
  | "devices:manage"
  | "devices:pricing"
  | "devices:charger-policy"
  | "sync:manage"
  | "sync:view";

export interface UserSession {
  userId: ID;
  email: string;
  fullName: string;
  role: UserRole;
  permissions: Permission[];
  tenantId?: ID;
  tokenExpiresAt: Timestamp;
}

export interface AdminProfileResult {
  authenticated: boolean;
  is_admin: boolean;
  is_active?: boolean;
  is_email_confirmed?: boolean;
  admin_id?: string;
  auth_user_id?: string;
  username?: string;
  full_name?: string;
  email?: string;
  role?: UserRole;
  permissions?: Permission[];
  error?: string | null;
}

export const AUTHORIZED_OWNER_BOOTSTRAP_EMAIL = "al.niser.0592314333@gmail.com";

export const SUPER_ADMIN_TEST_ACCOUNT = {
  id: "admin_super_01",
  email: "superadmin@system.local",
  fullName: "Super Admin",
  role: "SUPER_ADMIN" as UserRole,
  bin: "123456",
  pin: "123456",
  isActive: true,
  permissions: [
    "orders:view",
    "orders:create",
    "orders:edit",
    "orders:deliver",
    "orders:cancel",
    "orders:correct",
    "customers:view",
    "customers:create",
    "customers:edit",
    "customers:deactivate",
    "customers:debt-limit",
    "customers:charger-exemption",
    "customers:financial-view",
    "finance:view",
    "finance:create-payment",
    "finance:approve-payment",
    "finance:refund",
    "finance:correction",
    "finance:credit-adjustment",
    "devices:view",
    "devices:manage",
    "devices:pricing",
    "devices:charger-policy",
    "settings:manage",
    "admin:manage",
    "customers:read",
    "customers:write",
    "orders:read",
    "orders:write",
    "finances:read",
    "finances:write",
  ] as Permission[],
};

const SESSION_STORAGE_KEY = "app_auth_session";
let inMemorySession: UserSession | null = null;

interface PendingSuperAdminContext {
  token: string;
  session: SupabaseAuthSession;
  profile: AdminProfileResult;
  resolvedEmail: string;
  userRole: UserRole;
  expiresAt: number;
}

let pendingSuperAdminContext: PendingSuperAdminContext | null = null;

const getLocalStorage = () => {
  if (typeof localStorage !== "undefined") return localStorage;
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  if (typeof globalThis !== "undefined" && (globalThis as any).localStorage) return (globalThis as any).localStorage;
  return null;
};

export interface AuthService {
  login(email: string, passOrPin: string, bin?: string): Promise<UserSession | null>;
  logout(): Promise<void>;
  getCurrentSession(forceRefresh?: boolean): Promise<UserSession | null>;
  getSupabaseAuthSession(): Promise<SupabaseAuthSession | null>;
  captureAuthCallback(): Promise<{ session: SupabaseAuthSession | null; error: string | null; type?: string | null }>;
  hasPermission(session: UserSession | null, permission: Permission): boolean;
  hasRole(session: UserSession | null, role: UserRole): boolean;
  verifyBin(bin: string): boolean;
  isSupabaseConfigured(): boolean;
  checkSystemBootstrapped(): Promise<boolean>;
  getAdminProfile(customAuthToken?: string): Promise<AdminProfileResult | null>;
  registerSupabaseAccount(email: string, password: string): Promise<{
    session: SupabaseAuthSession | null;
    userOnly: boolean;
    error: string | null;
    isEmailUnconfirmed?: boolean;
  }>;
  verifyEmailOtp(
    email: string,
    token: string
  ): Promise<{ session: SupabaseAuthSession | null; error: string | null; errorCode?: string | null }>;
  resendEmailOtp(
    email: string
  ): Promise<{ success: boolean; error: string | null; errorCode?: string | null; isRateLimited?: boolean }>;
  recoverAndResetBin(
    emailOrUsername: string,
    currentPassword: string,
    newBin: string
  ): Promise<{ success: boolean; session?: UserSession | null; error?: string | null }>;
  verifyCurrentPassword(
    emailOrUsername: string,
    currentPassword: string
  ): Promise<{ success: boolean; error: string | null; token?: string }>;
  changeAdminBin(
    newBin: string,
    verifiedToken?: string
  ): Promise<{ success: boolean; error: string | null }>;
  bootstrapFirstSuperAdmin(payload: {
    username: string;
    fullName?: string;
    bin: string;
    email: string;
    password: string;
  }): Promise<{ success: boolean; error?: string | null }>;
  verifySuperAdminBin(bin: string): Promise<UserSession | null>;
  hasPendingSuperAdminContext(): boolean;
  clearPendingSuperAdminContext(): void;
}

class DefaultAuthService implements AuthService {
  isSupabaseConfigured(): boolean {
    return getSupabaseStatus().isConfigured;
  }

  async checkSystemBootstrapped(): Promise<boolean> {
    if (!this.isSupabaseConfigured()) {
      return false;
    }
    const { isBootstrapped } = await rpcCheckSystemBootstrapped();
    return isBootstrapped;
  }

  async getSupabaseAuthSession(): Promise<SupabaseAuthSession | null> {
    if (!this.isSupabaseConfigured()) {
      return null;
    }
    const token = getSupabaseAuthToken();
    const stored = getStoredSupabaseAuthSession();
    if (stored?.access_token) {
      if (!token) {
        setSupabaseAuthToken(stored.access_token);
      }
      return stored;
    }
    return null;
  }

  async captureAuthCallback(): Promise<{ session: SupabaseAuthSession | null; error: string | null; type?: string | null }> {
    if (!this.isSupabaseConfigured()) {
      return { session: null, error: null };
    }
    return parseSupabaseAuthCallbackFromUrl();
  }

  async registerSupabaseAccount(email: string, password: string): Promise<{
    session: SupabaseAuthSession | null;
    userOnly: boolean;
    error: string | null;
    isEmailUnconfirmed?: boolean;
  }> {
    if (!this.isSupabaseConfigured()) {
      return { session: null, userOnly: false, error: "Supabase is not configured" };
    }
    const cleanEmail = email.trim().toLowerCase();
    return supabaseSignUp(cleanEmail, password);
  }

  async verifyEmailOtp(
    email: string,
    token: string
  ): Promise<{ session: SupabaseAuthSession | null; error: string | null; errorCode?: string | null }> {
    if (!this.isSupabaseConfigured()) {
      return { session: null, error: "Supabase is not configured" };
    }
    const res = await supabaseVerifyEmailOtp(email, token);
    if (res.session) {
      setSupabaseAuthToken(res.session.access_token);
      saveStoredSupabaseAuthSession(res.session);
    }
    return res;
  }

  async resendEmailOtp(
    email: string
  ): Promise<{ success: boolean; error: string | null; errorCode?: string | null; isRateLimited?: boolean }> {
    if (!this.isSupabaseConfigured()) {
      return { success: false, error: "Supabase is not configured" };
    }
    return await supabaseResendEmailOtp(email);
  }

  async getAdminProfile(customAuthToken?: string): Promise<AdminProfileResult | null> {
    if (!this.isSupabaseConfigured()) {
      return null;
    }
    const { profile, error } = await rpcGetCurrentAdminProfile(customAuthToken);
    if (error || !profile) {
      return null;
    }
    return {
      authenticated: profile.authenticated,
      is_admin: profile.is_admin,
      is_active: profile.is_active,
      is_email_confirmed: profile.is_email_confirmed,
      admin_id: profile.admin_id,
      auth_user_id: profile.auth_user_id,
      username: profile.username,
      full_name: profile.full_name,
      email: profile.email,
      role: profile.role as UserRole,
      permissions: (profile.permissions as Permission[]) || [],
      error: null,
    };
  }

  async bootstrapFirstSuperAdmin(payload: {
    username: string;
    fullName?: string;
    bin: string;
    email: string;
    password: string;
  }): Promise<{ success: boolean; session?: UserSession | null; error?: string | null }> {
    if (!this.isSupabaseConfigured()) {
      return { success: false, error: "Supabase is not configured" };
    }

    const cleanEmail = payload.email.trim().toLowerCase();
    const cleanPassword = payload.password || "";
    const cleanUsername = payload.username.trim();
    const cleanFullName = payload.fullName?.trim() || cleanUsername;
    const cleanBin = payload.bin.trim();

    let authSession: SupabaseAuthSession | null = null;

    // 1. Resolve or acquire active Supabase Auth session via signup or signin
    const signUpRes = await supabaseSignUp(cleanEmail, cleanPassword);
    if (signUpRes.session?.access_token) {
      authSession = signUpRes.session;
    } else {
      // If sign up didn't return a session (e.g. user already exists or requires email verification), sign in
      const signInRes = await supabaseSignInWithPassword(cleanEmail, cleanPassword);
      if (signInRes.session?.access_token) {
        authSession = signInRes.session;
      } else {
        return {
          success: false,
          error: signUpRes.error || signInRes.error || "Authentication failed for Super Admin account.",
        };
      }
    }

    if (!authSession?.access_token) {
      return {
        success: false,
        error: "Failed to acquire authenticated Supabase session.",
      };
    }

    setSupabaseAuthToken(authSession.access_token);
    saveStoredSupabaseAuthSession(authSession);

    // 2. Execute server-authoritative bootstrap RPC
    const bootstrapRes = await rpcBootstrapFirstSuperAdmin(
      {
        username: cleanUsername,
        fullName: cleanFullName,
        bin: cleanBin,
      },
      authSession.access_token
    );

    if (!bootstrapRes.success) {
      return { success: false, error: bootstrapRes.error || "Bootstrap failed" };
    }

    // 3. Resolve server-authoritative profile
    const profileRes = await this.getAdminProfile(authSession.access_token);
    if (!profileRes || !profileRes.is_admin || profileRes.role !== "SUPER_ADMIN") {
      return { success: false, error: "Failed to verify newly bootstrapped Super Admin profile from server." };
    }

    // 4. Establish authoritative session
    const session: UserSession = {
      userId: profileRes.admin_id || bootstrapRes.data?.admin_id || authSession.user.id,
      email: cleanEmail,
      fullName: profileRes.full_name || cleanFullName,
      role: "SUPER_ADMIN",
      permissions: profileRes.permissions || [],
      tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };

    inMemorySession = session;
    const storage = getLocalStorage();
    if (storage) {
      storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    }

    return { success: true, session, error: null };
  }

  async recoverAndResetBin(
    emailOrUsername: string,
    currentPassword: string,
    newBin: string
  ): Promise<{ success: boolean; session?: UserSession | null; error?: string | null }> {
    const cleanIdentifier = emailOrUsername.trim();
    const cleanPass = currentPassword;
    const cleanBin = newBin.trim();

    if (!cleanBin || !/^\d{4,}$/.test(cleanBin)) {
      return {
        success: false,
        error: "رمز الأمان (BIN) يجب أن يتكون من 4 أرقام على الأقل",
      };
    }

    if (this.isSupabaseConfigured()) {
      let resolvedEmail = cleanIdentifier.toLowerCase();
      if (!cleanIdentifier.includes("@")) {
        const emailFromUsername = await rpcGetEmailByUsername(cleanIdentifier);
        if (!emailFromUsername) {
          return { success: false, error: "المستخدم غير موجود" };
        }
        resolvedEmail = emailFromUsername.toLowerCase();
      }

      // Step 1: Re-authenticate with current password
      const signInRes = await supabaseSignInWithPassword(resolvedEmail, cleanPass, false);
      if (signInRes.error || !signInRes.session) {
        return {
          success: false,
          error: "كلمة المرور الحالية غير صحيحة",
        };
      }

      // Step 2: Request Server-Authoritative Single-Use Recovery Proof Token
      const proofRes = await rpcIssueBinRecoveryProof(cleanPass, signInRes.session.access_token);
      if (!proofRes.success || !proofRes.proofToken) {
        return {
          success: false,
          error: proofRes.error || "كلمة المرور الحالية غير صحيحة",
        };
      }

      // Step 3: Call server-authoritative recovery RPC with proof token
      const resetRes = await rpcRecoverAndResetAdminBin(
        cleanBin,
        proofRes.proofToken,
        signInRes.session.access_token
      );
      if (!resetRes.success) {
        return {
          success: false,
          error: resetRes.error || "فشل تحديث رمز الأمان على الخادم",
        };
      }

      return {
        success: true,
        error: null,
      };
    }

    // Local fallback
    if (cleanPass === SUPER_ADMIN_TEST_ACCOUNT.pin || cleanPass === "123456") {
      return { success: true, error: null };
    }

    return { success: false, error: "كلمة المرور الحالية غير صحيحة" };
  }

    async verifyCurrentPassword(
    emailOrUsername: string,
    currentPassword: string
  ): Promise<{ success: boolean; error: string | null; token?: string }> {
    const cleanIdentifier = emailOrUsername.trim();
    const cleanPass = currentPassword;
    if (!cleanIdentifier || !cleanPass) {
      return {
        success: false,
        error: "يرجى إدخال اسم المستخدم وكلمة المرور الحالية",
      };
    }
    if (this.isSupabaseConfigured()) {
      let resolvedEmail = cleanIdentifier.toLowerCase();
      if (!cleanIdentifier.includes("@")) {
        const emailFromUsername = await rpcGetEmailByUsername(cleanIdentifier);
        if (!emailFromUsername) {
          return { success: false, error: "تعذر التحقق من بيانات الحساب." };
        }
        resolvedEmail = emailFromUsername.toLowerCase();
      }
      const signInRes = await supabaseSignInWithPassword(resolvedEmail, cleanPass, false);
      if (signInRes.error || !signInRes.session) {
        return {
          success: false,
          error: "تعذر التحقق من بيانات الحساب.",
        };
      }
      return {
        success: true,
        error: null,
        token: signInRes.session.access_token,
      };
    }
    // Local / test mode fallback
    if (cleanPass === SUPER_ADMIN_TEST_ACCOUNT.pin || cleanPass === "123456" || cleanPass === "correct_password") {
      return { success: true, error: null, token: "mock_verified_token" };
    }
    return { success: false, error: "تعذر التحقق من بيانات الحساب." };
  }

  async changeAdminBin(
    newBin: string,
    verifiedToken?: string
  ): Promise<{ success: boolean; error: string | null }> {
    const cleanBin = newBin.trim();
    if (!cleanBin || !/^\d{4,}$/.test(cleanBin)) {
      return {
        success: false,
        error: "رمز الأمان (BIN) يجب أن يتكون من 4 أرقام على الأقل",
      };
    }
    if (this.isSupabaseConfigured()) {
      const token = verifiedToken || getSupabaseAuthToken();
      const res = await rpcSetAdminBin(cleanBin, undefined, token || undefined);
      if (!res.success) {
        return { success: false, error: res.error || "فشل تحديث رمز الأمان" };
      }
      return { success: true, error: null };
    }
    // Local fallback
    return { success: true, error: null };
  }

  async login(emailOrUsername: string, passOrPin: string, bin?: string): Promise<UserSession | null> {
    const cleanIdentifier = emailOrUsername.trim();
    const cleanPass = passOrPin;
    const cleanBin = bin ? bin.trim() : "";

    // If cleanBin is provided AND we already have an active temporary context in memory:
    // Route directly to verifySuperAdminBin -> ZERO additional password authentication calls!
    if (cleanBin && pendingSuperAdminContext && Date.now() <= pendingSuperAdminContext.expiresAt) {
      return this.verifySuperAdminBin(cleanBin);
    }

    if (this.isSupabaseConfigured()) {
      // Clear any prior temporary context at the start of a fresh password authentication
      pendingSuperAdminContext = null;

      let resolvedEmail = cleanIdentifier.toLowerCase();
      if (!cleanIdentifier.includes("@")) {
        try {
          const emailFromUsername = await rpcGetEmailByUsername(cleanIdentifier);
          if (getLastGetEmailError()) {
            throw new Error("USERNAME_LOOKUP_FAILED");
          }
          if (!emailFromUsername) {
            // Username does not exist in system
            return null;
          }
          resolvedEmail = emailFromUsername.toLowerCase();
        } catch (err: any) {
          throw new Error("USERNAME_LOOKUP_FAILED");
        }
      }

      // Step 1: Authenticate Email + Password against Supabase Auth WITHOUT persisting yet.
      // EXACTLY ONE call to supabaseSignInWithPassword!
      const signInRes = await supabaseSignInWithPassword(resolvedEmail, cleanPass, false);
      if (signInRes.error || !signInRes.session) {
        if (signInRes.isRateLimited || signInRes.statusCode === 429) {
          throw new Error("RATE_LIMIT");
        }
        if (signInRes.isEmailUnconfirmed) {
          throw new Error("EMAIL_CONFIRMATION_REQUIRED");
        }
        if (signInRes.isNetworkError || signInRes.error?.toLowerCase().includes("failed to fetch") || signInRes.error?.toLowerCase().includes("network error")) {
          throw new Error("NETWORK_ERROR");
        }
        if (signInRes.error?.toLowerCase().includes("invalid api key") || signInRes.error === "SUPABASE_NOT_CONFIGURED") {
          throw new Error("INVALID_API_KEY");
        }
        if (signInRes.isInvalidCredentials || signInRes.statusCode === 400) {
          return null;
        }
        // Fallback for other credential failures
        return null;
      }

      // Step 2: Server-Authoritative Identity Profile Resolver
      const profile = await this.getAdminProfile(signInRes.session.access_token);
      if (!profile || !profile.authenticated) {
        setSupabaseAuthToken(null);
        console.warn(`[AUTH_DEBUG] getAdminProfile failed after successful password auth`);
        throw new Error("PROFILE_RPC_FAILED");
      }

      if (!profile.is_admin) {
        setSupabaseAuthToken(null);
        throw new Error("ACCESS_DENIED_NO_ADMIN");
      }

      if (profile.is_active === false) {
        setSupabaseAuthToken(null);
        throw new Error("ACCESS_DENIED_INACTIVE");
      }

      const userRole = (profile.role || "OPERATOR") as UserRole;

      // Step 3: BIN verification required ONLY for SUPER_ADMIN
      if (userRole === "SUPER_ADMIN") {
        // Cache temporary session in memory ONLY (never in localStorage before BIN)
        pendingSuperAdminContext = {
          token: signInRes.session.access_token,
          session: signInRes.session,
          profile,
          resolvedEmail,
          userRole: "SUPER_ADMIN",
          expiresAt: Date.now() + 5 * 60 * 1000,
        };

        if (!cleanBin) {
          // Tell UI to prompt for BIN
          throw new Error("SUPER_ADMIN_BIN_REQUIRED");
        }

        // If cleanBin was provided directly, complete BIN verification immediately with existing context
        return this.verifySuperAdminBin(cleanBin);
      }

      // Step 4 for non-super admins: Directly commit session
      saveStoredSupabaseAuthSession(signInRes.session);
      setSupabaseAuthToken(signInRes.session.access_token);

      const session: UserSession = {
        userId: profile.admin_id || signInRes.session.user.id,
        email: profile.email || signInRes.session.user.email || resolvedEmail,
        fullName: profile.full_name || profile.username || resolvedEmail.split("@")[0],
        role: userRole,
        permissions: profile.permissions || [],
        tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };

      inMemorySession = session;
      const storage = getLocalStorage();
      if (storage) {
        storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      }

      return session;
    }

    // Fallback: Local / test preview environment (ONLY when Supabase is NOT configured)
    const isSuperAdminEmail =
      cleanIdentifier.toLowerCase() === SUPER_ADMIN_TEST_ACCOUNT.email ||
      cleanIdentifier.toLowerCase() === "superadmin" ||
      cleanIdentifier.toLowerCase() === "admin@system.local" ||
      cleanIdentifier.toLowerCase() === "admin@test.com" ||
      cleanIdentifier.toLowerCase() === "super@system.com";

    const isValidPass =
      cleanPass === SUPER_ADMIN_TEST_ACCOUNT.pin ||
      cleanPass === "123456" ||
      cleanPass === "1234" ||
      cleanPass === "admin";

    if (isSuperAdminEmail && isValidPass) {
      pendingSuperAdminContext = {
        token: "mock_super_admin_token",
        session: {
          access_token: "mock_super_admin_token",
          user: { id: SUPER_ADMIN_TEST_ACCOUNT.id, email: SUPER_ADMIN_TEST_ACCOUNT.email },
        },
        profile: {
          authenticated: true,
          is_admin: true,
          is_active: true,
          admin_id: SUPER_ADMIN_TEST_ACCOUNT.id,
          email: SUPER_ADMIN_TEST_ACCOUNT.email,
          role: "SUPER_ADMIN",
          permissions: SUPER_ADMIN_TEST_ACCOUNT.permissions,
        },
        resolvedEmail: SUPER_ADMIN_TEST_ACCOUNT.email,
        userRole: "SUPER_ADMIN",
        expiresAt: Date.now() + 5 * 60 * 1000,
      };

      if (!cleanBin) {
        throw new Error("SUPER_ADMIN_BIN_REQUIRED");
      }

      return this.verifySuperAdminBin(cleanBin);
    }

    return null;
  }

  async verifySuperAdminBin(bin: string): Promise<UserSession | null> {
    const cleanBin = bin.trim();
    if (!cleanBin || !/^\d{4,}$/.test(cleanBin)) {
      throw new Error("WRONG_BIN");
    }

    if (!pendingSuperAdminContext || Date.now() > pendingSuperAdminContext.expiresAt) {
      pendingSuperAdminContext = null;
      throw new Error("SESSION_EXPIRED");
    }

    const { token, session: tempSession, profile, resolvedEmail, userRole } = pendingSuperAdminContext;

    if (this.isSupabaseConfigured()) {
      // Authoritative BIN verification using the exact same temporary token!
      // ZERO calls to supabaseSignInWithPassword!
      const trackingRes = await rpcVerifyAdminBinWithTracking(cleanBin, token);
      if (!trackingRes.success) {
        // Technical / infrastructure failure -> fail closed without consuming attempts
        if (trackingRes.isTechnicalError || trackingRes.status === "ERROR") {
          const err = new Error("BIN_VERIFICATION_UNAVAILABLE");
          (err as any).technicalError = trackingRes.error;
          throw err;
        }

        if (trackingRes.is_locked || trackingRes.status === "LOCKED") {
          pendingSuperAdminContext = null;
          saveStoredSupabaseAuthSession(tempSession);
          setSupabaseAuthToken(token);
          const err = new Error("BIN_LOCKED_FROZEN");
          (err as any).remainingAttempts = 0;
          (err as any).failedAttempts = trackingRes.failed_attempts || 3;
          throw err;
        }

        const err = new Error("WRONG_BIN");
        (err as any).remainingAttempts = trackingRes.remaining_attempts;
        (err as any).failedAttempts = trackingRes.failed_attempts;
        throw err;
      }
    } else {
      // Local test fallback
      const isValidBin =
        cleanBin === SUPER_ADMIN_TEST_ACCOUNT.bin ||
        cleanBin === "1234" ||
        cleanBin === "123456";
      if (!isValidBin) {
        throw new Error("WRONG_BIN");
      }
    }

    // Success: Commit final authoritative session to storage and memory
    saveStoredSupabaseAuthSession(tempSession);
    setSupabaseAuthToken(token);

    const session: UserSession = {
      userId: profile.admin_id || tempSession.user.id,
      email: profile.email || tempSession.user.email || resolvedEmail,
      fullName: profile.full_name || profile.username || resolvedEmail.split("@")[0],
      role: userRole,
      permissions: profile.permissions || [],
      tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };

    inMemorySession = session;
    const storage = getLocalStorage();
    if (storage) {
      storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    }

    // Temporary context consumed and wiped
    pendingSuperAdminContext = null;
    return session;
  }

  hasPendingSuperAdminContext(): boolean {
    return Boolean(pendingSuperAdminContext && Date.now() <= pendingSuperAdminContext.expiresAt);
  }

  clearPendingSuperAdminContext(): void {
    pendingSuperAdminContext = null;
  }

  async logout(): Promise<void> {
    clearStoredSupabaseAuthSession();
    inMemorySession = null;
    pendingSuperAdminContext = null;
    const storage = getLocalStorage();
    if (storage) {
      storage.removeItem(SESSION_STORAGE_KEY);
    }
  }

  async getCurrentSession(forceRefresh = false): Promise<UserSession | null> {
    if (this.isSupabaseConfigured()) {
      /*
       * Offline-first session rule:
       * absence of a currently hydrated Supabase token is not, by itself,
       * proof that the cached local admin session is invalid. Explicit logout
       * clears the cached app session as well, while an offline/reload path may
       * temporarily have no remote token available.
       *
       * Do not destroy the local session here. The cached session is evaluated
       * below using its own expiry. When a valid Supabase session is available,
       * the authoritative server profile is still checked and replaces the
       * cached permissions/identity.
       */
      const supabaseSession = await this.getSupabaseAuthSession();
      void supabaseSession;
    }

    if (!forceRefresh && inMemorySession && new Date(inMemorySession.tokenExpiresAt).getTime() > Date.now()) {
      return inMemorySession;
    }

    // Rehydrating from localStorage on page reload: verify authoritative profile against server if online
    let serverProfile: AdminProfileResult | null = null;
    if (this.isSupabaseConfigured()) {
      const supabaseSession = await this.getSupabaseAuthSession();
      if (supabaseSession?.access_token) {
        serverProfile = await this.getAdminProfile(supabaseSession.access_token);
        if (serverProfile) {
          if (!serverProfile.authenticated || !serverProfile.is_admin || serverProfile.is_active === false) {
            await this.logout();
            return null;
          }
        }
      }
    }

    const storage = getLocalStorage();
    if (storage) {
      const stored = storage.getItem(SESSION_STORAGE_KEY);
      if (stored) {
        try {
          const storedSession = JSON.parse(stored) as UserSession;
          if (new Date(storedSession.tokenExpiresAt).getTime() > Date.now()) {
            const session: UserSession = serverProfile ? {
              userId: serverProfile.admin_id || storedSession.userId,
              email: serverProfile.email || storedSession.email,
              fullName: serverProfile.full_name || serverProfile.username || storedSession.fullName,
              role: (serverProfile.role as UserRole) || storedSession.role,
              permissions: serverProfile.permissions || storedSession.permissions,
              tokenExpiresAt: storedSession.tokenExpiresAt,
            } : storedSession;

            inMemorySession = session;
            // Also sync back to storage if updated from server
            if (serverProfile) {
              storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
            }
            return session;
          }
        } catch {
          storage.removeItem(SESSION_STORAGE_KEY);
        }
      } else if (serverProfile && this.isSupabaseConfigured()) {
        // Fallback if session is not in localStorage but serverProfile is active (e.g. forced refresh without storage cache)
        const supabaseSession = await this.getSupabaseAuthSession();
        const session: UserSession = {
          userId: serverProfile.admin_id || supabaseSession?.user.id || "",
          email: serverProfile.email || supabaseSession?.user.email || "",
          fullName: serverProfile.full_name || serverProfile.username || "",
          role: serverProfile.role || "OPERATOR",
          permissions: serverProfile.permissions || [],
          tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        };
        inMemorySession = session;
        storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
        return session;
      }
    }
    return null;
  }

  hasPermission(session: UserSession | null, permission: Permission): boolean {
    if (!session) return false;
    const roleNormalized = String(session.role || '').toUpperCase().replace(/\s+/g, '_');
    if (roleNormalized === 'SUPER_ADMIN') return true;
    return Boolean(session.permissions?.includes(permission));
  }

  hasRole(session: UserSession | null, role: UserRole): boolean {
    if (!session) return false;
    const roleNormalized = String(session.role || '').toUpperCase().replace(/\s+/g, '_');
    if (roleNormalized === 'SUPER_ADMIN') return true;
    return roleNormalized === String(role).toUpperCase().replace(/\s+/g, '_');
  }

  verifyBin(bin: string): boolean {
    const cleanBin = bin.trim();
    return cleanBin === SUPER_ADMIN_TEST_ACCOUNT.bin || cleanBin === "1234" || cleanBin === "123456";
  }
}

export const authService: AuthService = new DefaultAuthService();
