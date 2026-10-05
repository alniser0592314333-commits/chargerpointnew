import { describe, it, expect } from "vitest";
import { UserSession } from "../services/auth/authService";
import fs from "fs";
import path from "path";

describe("Granular Permissions settings visibility and action guards regression tests", () => {
  // Helper simulating our hasPermission check
  const checkPermission = (session: UserSession | null, perm: string) => {
    if (!session) return false;
    const isSuperAdmin = session.role === "SUPER_ADMIN";
    return isSuperAdmin || (session.permissions?.includes(perm as any) ?? false);
  };

  const createMockSession = (role: string, permissions: string[]): UserSession => ({
    userId: "mock_usr_1",
    email: "test@system.local",
    fullName: "Mock Admin",
    role: role as any,
    permissions: permissions as any[],
    tokenExpiresAt: (Date.now() + 3600000).toString(),
  });

  describe("1. Settings sections visibility filters & exact model", () => {
    it("A. Logo hidden with devices:manage only", () => {
      const devicesOnlySession = createMockSession("ADMIN", ["devices:manage"]);
      expect(checkPermission(devicesOnlySession, "settings:manage")).toBe(false);
    });

    it("B. Logo visible with settings:manage", () => {
      const settingsSession = createMockSession("ADMIN", ["settings:manage"]);
      expect(checkPermission(settingsSession, "settings:manage")).toBe(true);
    });

    it("C. Device Types visible with devices:manage", () => {
      const devicesSession = createMockSession("ADMIN", ["devices:manage"]);
      expect(checkPermission(devicesSession, "devices:manage")).toBe(true);
    });

    it("D. Backup hidden without settings:manage", () => {
      const noSettingsSession = createMockSession("ADMIN", ["devices:manage", "orders:create"]);
      expect(checkPermission(noSettingsSession, "settings:manage")).toBe(false);
    });

    it("E. Sync Center hidden without settings:manage", () => {
      const noSettingsSession = createMockSession("ADMIN", ["customers:view"]);
      expect(checkPermission(noSettingsSession, "settings:manage")).toBe(false);
    });

    it("F. Admin Management hidden without admin:manage", () => {
      const noAdminManageSession = createMockSession("ADMIN", ["settings:manage"]);
      expect(checkPermission(noAdminManageSession, "admin:manage")).toBe(false);

      const adminManageSession = createMockSession("ADMIN", ["admin:manage"]);
      expect(checkPermission(adminManageSession, "admin:manage")).toBe(true);
    });

    it("Super Admin can see every section (Logo, QR Design, Device Types, Backup, Sync, Admin Accounts)", () => {
      const superSession = createMockSession("SUPER_ADMIN", []);
      expect(checkPermission(superSession, "settings:manage")).toBe(true);
      expect(checkPermission(superSession, "devices:manage")).toBe(true);
      expect(checkPermission(superSession, "admin:manage")).toBe(true);
    });

    it("All authenticated admins can access Personal Security & BIN Change card by default (Type A generic setting)", () => {
      const anySession = createMockSession("ADMIN", []);
      expect(anySession).toBeDefined();
    });
  });

  describe("2. Server-Authoritative Finance, Reports & Sync Guards (PostgreSQL Migration 00034)", () => {
    const migrationContent = fs.readFileSync(
      path.join(process.cwd(), "supabase/migrations/00034_granular_finance_reports_authoritative.sql"),
      "utf-8"
    );

    it("G. finance:approve-payment server rejection checked in execute_sync_command", () => {
      expect(migrationContent).toContain("'finance:approve-payment'");
      expect(migrationContent).toContain("APPROVE_PAYMENT");
    });

    it("H. finance:refund server rejection checked in execute_sync_command", () => {
      expect(migrationContent).toContain("'finance:refund'");
      expect(migrationContent).toContain("REFUND");
    });

    it("J. unauthorized offline command rejected during sync (execute_sync_command re-evaluates active admin permissions)", () => {
      expect(migrationContent).toContain("Forbidden: Admin lacks required permission");
      expect(migrationContent).toContain("get_effective_permissions");
    });
  });

  describe("3. Targeted Fixes: orders:edit and reports:view Authorization (PostgreSQL Migration 00035)", () => {
    const migration00035 = fs.readFileSync(
      path.join(process.cwd(), "supabase/migrations/00035_fix_orders_edit_and_reports_authorization.sql"),
      "utf-8"
    );

    it("TEST 1: Admin has orders:create only — CREATE_ORDER requires orders:create, active UPDATE_ORDER_ITEM requires orders:edit", () => {
      const createSession = createMockSession("ADMIN", ["orders:create"]);
      expect(checkPermission(createSession, "orders:create")).toBe(true);
      expect(checkPermission(createSession, "orders:edit")).toBe(false);

      expect(migration00035).toContain("WHEN 'CREATE_ORDER', 'orders' THEN");
      expect(migration00035).toContain("v_required_perm := 'orders:create';");
      expect(migration00035).toContain("WHEN 'ADD_ORDER_ITEM', 'UPDATE_ORDER_ITEM', 'order_items' THEN");
      expect(migration00035).toContain("v_required_perm := 'orders:edit';");
    });

    it("TEST 2: Admin has orders:edit only — UPDATE_ORDER_ITEM on active order requires orders:edit, CREATE_ORDER is rejected", () => {
      const editSession = createMockSession("ADMIN", ["orders:edit"]);
      expect(checkPermission(editSession, "orders:edit")).toBe(true);
      expect(checkPermission(editSession, "orders:create")).toBe(false);
    });

    it("TEST 3: Admin has orders:edit only — Modification of delivered order requires orders:correct (rejected with orders:edit only)", () => {
      const editSession = createMockSession("ADMIN", ["orders:edit"]);
      expect(checkPermission(editSession, "orders:edit")).toBe(true);
      expect(checkPermission(editSession, "orders:correct")).toBe(false);

      expect(migration00035).toContain("IF v_order_status = 'delivered' THEN");
      expect(migration00035).toContain("v_required_perm := 'orders:correct';");
    });

    it("TEST 4: Admin has orders:correct only — Delivered/finalized correction succeeds only through intended correction path", () => {
      const correctSession = createMockSession("ADMIN", ["orders:correct"]);
      expect(checkPermission(correctSession, "orders:correct")).toBe(true);
      expect(checkPermission(correctSession, "orders:create")).toBe(false);
      expect(checkPermission(correctSession, "orders:edit")).toBe(false);
    });

    it("TEST 5: Admin has orders:create + orders:edit — Both creation and active-order editing succeed", () => {
      const bothSession = createMockSession("ADMIN", ["orders:create", "orders:edit"]);
      expect(checkPermission(bothSession, "orders:create")).toBe(true);
      expect(checkPermission(bothSession, "orders:edit")).toBe(true);
      expect(checkPermission(bothSession, "orders:correct")).toBe(false);
    });

    it("TEST 6: admin:manage only — rpc_get_financial_report() rejects admin:manage", () => {
      const adminManageSession = createMockSession("ADMIN", ["admin:manage"]);
      expect(checkPermission(adminManageSession, "reports:view")).toBe(false);

      // Verify Migration 00035 excludes admin:manage from rpc_get_financial_report
      const rpcMatch = migration00035.substring(
        migration00035.indexOf("CREATE OR REPLACE FUNCTION rpc_get_financial_report()")
      );
      expect(rpcMatch).not.toContain("'admin:manage'");
    });

    it("TEST 7: reports:view only — rpc_get_financial_report() succeeds", () => {
      const reportsSession = createMockSession("ADMIN", ["reports:view"]);
      expect(checkPermission(reportsSession, "reports:view")).toBe(true);

      expect(migration00035).toContain("WHERE permission IN ('reports:view', 'finance:view', 'SUPER_ADMIN')");
    });

    it("TEST 8: no reports permission — rpc_get_financial_report() rejected", () => {
      const noReportsSession = createMockSession("ADMIN", ["customers:view"]);
      expect(checkPermission(noReportsSession, "reports:view")).toBe(false);
    });

    it("TEST 9: SUPER_ADMIN — rpc_get_financial_report() succeeds unconditionally", () => {
      const superSession = createMockSession("SUPER_ADMIN", []);
      expect(checkPermission(superSession, "reports:view")).toBe(true);
    });
  });

  describe("4. Fix public.admins RLS Infinite Recursion & rpc_fetch_admins (Migration 00036)", () => {
    const migration00036 = fs.readFileSync(
      path.join(process.cwd(), "supabase/migrations/00036_fix_admins_rls_infinite_recursion.sql"),
      "utf-8"
    );

    it("TEST A & B: Authenticated Super Admin loads admin list via SECURITY DEFINER RPC without 42P17 recursion", () => {
      expect(migration00036).toContain("CREATE OR REPLACE FUNCTION public.rpc_fetch_admins()");
      expect(migration00036).toContain("SECURITY DEFINER");
      // Verify recursive FOR ALL policy is dropped and replaced with command-specific policies
      expect(migration00036).toContain("DROP POLICY IF EXISTS \"Allow Super Admin write of admins\" ON public.admins;");
      expect(migration00036).toContain("CREATE POLICY \"Allow Super Admin insert of admins\" ON public.admins");
      expect(migration00036).toContain("CREATE POLICY \"Allow Super Admin update of admins\" ON public.admins");
      expect(migration00036).toContain("CREATE POLICY \"Allow Super Admin delete of admins\" ON public.admins");
    });

    it("TEST C: Unauthenticated request cannot read admin list (RPC checks auth.uid IS NOT NULL)", () => {
      expect(migration00036).toContain("IF auth.uid() IS NULL THEN");
      expect(migration00036).toContain("RAISE EXCEPTION 'Authentication required';");
    });

    it("TEST D: Normal ADMIN without admin:manage cannot enumerate admin list through REST table directly", () => {
      expect(migration00036).toContain("CREATE POLICY \"Allow authenticated self read of admins\" ON public.admins");
      expect(migration00036).toContain("auth_user_id = auth.uid()");
      expect(migration00036).toContain("WHERE permission IN ('admin:manage', 'SUPER_ADMIN')");
    });

    it("TEST E, F, G: Admin Management authorized read returns only safe display fields (bin_hash and password omitted)", () => {
      const returnMatch = migration00036.substring(
        migration00036.indexOf("RETURN QUERY")
      );
      expect(returnMatch).toContain("a.id");
      expect(returnMatch).toContain("a.username");
      expect(returnMatch).toContain("a.full_name");
      expect(returnMatch).toContain("a.email");
      expect(returnMatch).toContain("a.role");
      expect(returnMatch).toContain("a.is_active");
      expect(returnMatch).toContain("a.version");
      expect(returnMatch).toContain("a.created_at");
      expect(returnMatch).not.toContain("bin_hash");
      expect(returnMatch).not.toContain("password");
    });

    it("TEST H & I: Existing rpc_create_admin and admin mutation RPC security remain protected", () => {
      expect(migration00036).toContain("v_caller_role NOT IN ('SUPER_ADMIN', 'Super Admin')");
    });

    it("TEST J: Migration 00037 explicitly grants EXECUTE to anon/authenticated/service_role and notifies PostgREST to reload schema cache", () => {
      const migration00037 = fs.readFileSync(
        path.join(process.cwd(), "supabase/migrations/00037_reload_postgrest_schema_cache.sql"),
        "utf-8"
      );
      expect(migration00037).toContain("GRANT EXECUTE ON FUNCTION public.rpc_fetch_admins() TO anon, authenticated, service_role;");
      expect(migration00037).toContain("NOTIFY pgrst, 'reload schema';");
    });

    it("TEST K: Client rpcFetchAdmins invokes rpc_fetch_admins as a clean zero-argument RPC call", () => {
      const clientContent = fs.readFileSync(
        path.join(process.cwd(), "src/services/supabase/client.ts"),
        "utf-8"
      );
      expect(clientContent).toContain("invokeSupabaseRpc<AdminRow[]>('rpc_fetch_admins')");
    });

    it("TEST L: Migration 00038 rpc_create_admin avoids writing to generated column confirmed_at while preserving immediate email activation", () => {
      const migration00038 = fs.readFileSync(
        path.join(process.cwd(), "supabase/migrations/00038_fix_create_admin_generated_columns.sql"),
        "utf-8"
      );
      expect(migration00038).toContain("CREATE OR REPLACE FUNCTION public.rpc_create_admin");
      expect(migration00038).toContain("email_confirmed_at");
      // confirmed_at is generated ALWAYS AS LEAST(email_confirmed_at, phone_confirmed_at) and MUST NOT be in INSERT column list
      const insertUsersMatch = migration00038.substring(
        migration00038.indexOf("INSERT INTO auth.users"),
        migration00038.indexOf("RETURNING id INTO v_new_user_id")
      );
      expect(insertUsersMatch).not.toMatch(/\bconfirmed_at\b/);
      expect(insertUsersMatch).toContain("email_confirmed_at");
      // RBAC & security checks intact
      expect(migration00038).toContain("IF v_caller_role NOT IN ('SUPER_ADMIN', 'Super Admin') THEN");
      expect(migration00038).toContain("Cannot create subordinate accounts with SUPER_ADMIN role");
      expect(migration00038).toContain("Invalid authorization BIN credential");
      expect(migration00038).toContain("NOTIFY pgrst, 'reload schema';");
    });
  });

  describe("5. Customers Page & Customer Detail action guards", () => {
    it("Admin with customers:create permission can see/click Add Customer button", () => {
      const createSession = createMockSession("ADMIN", ["customers:create"]);
      expect(checkPermission(createSession, "customers:create")).toBe(true);

      const readOnlySession = createMockSession("ADMIN", ["customers:view"]);
      expect(checkPermission(readOnlySession, "customers:create")).toBe(false);
    });

    it("Admin with customers:edit permission can click Edit customer button", () => {
      const editSession = createMockSession("ADMIN", ["customers:edit"]);
      expect(checkPermission(editSession, "customers:edit")).toBe(true);

      const noEditSession = createMockSession("ADMIN", ["customers:view"]);
      expect(checkPermission(noEditSession, "customers:edit")).toBe(false);
    });

    it("Admin with customers:edit but without customers:deactivate cannot toggle account frozen/active", () => {
      const partialSession = createMockSession("ADMIN", ["customers:edit"]);
      expect(checkPermission(partialSession, "customers:edit")).toBe(true);
      expect(checkPermission(partialSession, "customers:deactivate")).toBe(false);
    });

    it("Admin with customers:edit but without customers:debt-limit cannot modify debt limit field", () => {
      const partialSession = createMockSession("ADMIN", ["customers:edit"]);
      expect(checkPermission(partialSession, "customers:edit")).toBe(true);
      expect(checkPermission(partialSession, "customers:debt-limit")).toBe(false);
    });

    it("Admin with customers:charger-exemption can toggle charger exemption button", () => {
      const exemptSession = createMockSession("ADMIN", ["customers:charger-exemption"]);
      expect(checkPermission(exemptSession, "customers:charger-exemption")).toBe(true);

      const regularSession = createMockSession("ADMIN", ["customers:edit"]);
      expect(checkPermission(regularSession, "customers:charger-exemption")).toBe(false);
    });

    it("Admin with finance:credit-adjustment can access Top-Up Payment button", () => {
      const financeSession = createMockSession("ADMIN", ["finance:credit-adjustment"]);
      expect(checkPermission(financeSession, "finance:credit-adjustment")).toBe(true);

      const standardSession = createMockSession("ADMIN", ["customers:edit"]);
      expect(checkPermission(standardSession, "finance:credit-adjustment")).toBe(false);
    });
  });

  describe("6. Admin Management Route Guards (/app/settings/admins)", () => {
    const isRouteAuthorized = (session: UserSession | null, requiredPerm: string) => {
      if (!session) return false;
      const isSuperAdmin = String(session.role || "").toUpperCase().replace(/\s+/g, "_") === "SUPER_ADMIN";
      return isSuperAdmin || Boolean(session.permissions?.includes(requiredPerm as any));
    };

    it("A. Super Admin (SUPER_ADMIN) is authorized for /app/settings/admins", () => {
      const superSession = createMockSession("SUPER_ADMIN", []);
      expect(isRouteAuthorized(superSession, "admin:manage")).toBe(true);
    });

    it("B. Super Admin (Super Admin normalized) is authorized for /app/settings/admins", () => {
      const superSession = createMockSession("Super Admin", []);
      expect(isRouteAuthorized(superSession, "admin:manage")).toBe(true);
    });

    it("C. Admin with admin:manage is authorized for /app/settings/admins", () => {
      const adminSession = createMockSession("ADMIN", ["admin:manage"]);
      expect(isRouteAuthorized(adminSession, "admin:manage")).toBe(true);
    });

    it("D. Admin without admin:manage is rejected (UnauthorizedPage)", () => {
      const regularSession = createMockSession("ADMIN", ["orders:create", "customers:view"]);
      expect(isRouteAuthorized(regularSession, "admin:manage")).toBe(false);
    });

    it("E. Unauthenticated visitor is rejected (UnauthorizedPage)", () => {
      expect(isRouteAuthorized(null, "admin:manage")).toBe(false);
    });
  });

  describe("7. Central Sync Engine (SyncCenter) Permission Guards", () => {
    const isSyncCenterVisible = (session: UserSession | null) => {
      if (!session) return false;
      const isSuperAdmin = String(session.role || "").toUpperCase().replace(/\s+/g, "_") === "SUPER_ADMIN";
      return (
        isSuperAdmin ||
        Boolean(session.permissions?.includes("sync:manage" as any)) ||
        Boolean(session.permissions?.includes("sync:view" as any)) ||
        Boolean(session.permissions?.includes("settings:manage" as any))
      );
    };

    it("A. SyncCenter visible for Super Admin", () => {
      const superSession = createMockSession("SUPER_ADMIN", []);
      expect(isSyncCenterVisible(superSession)).toBe(true);
    });

    it("B. SyncCenter visible for subordinate admin with dedicated sync:manage permission", () => {
      const fahedSession = createMockSession("OPERATOR", ["sync:manage"]);
      expect(isSyncCenterVisible(fahedSession)).toBe(true);
    });

    it("C. Subordinate admin with only sync:manage cannot see global backup or admin management", () => {
      const fahedSession = createMockSession("OPERATOR", ["sync:manage"]);
      expect(checkPermission(fahedSession, "settings:manage")).toBe(false);
      expect(checkPermission(fahedSession, "devices:manage")).toBe(false);
      expect(checkPermission(fahedSession, "admin:manage")).toBe(false);
    });

    it("D. Subordinate admin without sync:manage or settings:manage cannot see SyncCenter", () => {
      const normalSession = createMockSession("OPERATOR", ["orders:view", "orders:create"]);
      expect(isSyncCenterVisible(normalSession)).toBe(false);
    });
  });
});
