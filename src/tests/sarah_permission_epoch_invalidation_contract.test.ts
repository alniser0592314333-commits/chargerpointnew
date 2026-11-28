import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("Sarah permission epoch invalidation", () => {
  const page = readFileSync("src/components/pages/SarahChatPage.tsx", "utf8");
  const app = readFileSync("src/App.tsx", "utf8");
  const client = readFileSync("src/services/supabase/client.ts", "utf8");
  const edge = readFileSync("supabase/functions/sarah-ai-chat/index.ts", "utf8");
  const migration = readFileSync("supabase/migrations/20261128110000_admin_permission_epoch_invalidation.sql", "utf8");

  it("subscribes only while Sarah is open and scopes the channel to the verified Auth subject", () => {
    expect(page).toContain("subscribeToOwnAdminPermissionEpoch(authUserId");
    expect(page).toContain('cp-admin-permissions-invalidated');
    expect(page).toContain("if (cancelled || !isCurrent(authUserId)) return");
    expect(page).toContain("permissions may have changed while Sarah");
    expect(page).toContain("detail: { authUserId }");
    expect(client).toContain("table: 'admin_permission_epochs'");
    expect(client).toContain("filter: `auth_user_id=eq.${authUserId}`");
    expect(client).toContain("getStoredSupabaseAuthSession()?.user?.id !== authUserId");
    expect(client).not.toContain("table: 'admins'");
  });

  it("uses Realtime only as an invalidation hint and never as an authorization source", () => {
    expect(client).toContain("client.realtime.setAuth(token)");
    expect(client).toContain("cp-supabase-auth-token-updated");
    expect(client).toContain("window.removeEventListener(\"cp-supabase-auth-token-updated\", onAuthTokenUpdated)");
    expect(client).toContain("event: 'UPDATE'");
    expect(client).toContain("No polling or service-role credential is used");
    expect(page).toContain("database still checks live permissions on every protected RPC");
    expect(app).toContain("detail.authUserId !== userSession?.authUserId");
    expect(app).toContain("void handleFocus()");
    expect(app).toContain("}, [userSession?.authUserId]);");
    expect(app).toContain("authService.getCurrentSession(true)");
    expect(edge).toContain('caller.rpc("sarah_ai_get_chat_access_context"');
    expect(edge).toContain("permissionSnapshotCache.get(userData.user.id)");
    expect(edge).toContain("p_cached_permissions_version: usableCachedSnapshot?.version ?? null");
    expect(edge).toContain("ADMIN_PERMISSION_CACHE_INCONSISTENT");
    expect(edge).toContain("usableCachedSnapshot.adminId");
    expect(edge).toContain("p_cached_permissions_version: null");
    expect(edge).toContain("adminId,\n      version: permissionVersion");
    expect(edge).toContain("PERMISSION_SNAPSHOT_CACHE_TTL_MS = 5 * 60 * 1000");
    expect(edge).not.toContain('caller.rpc("get_current_admin_profile")');
    expect(edge).toContain('admin.rpc("sarah_ai_task_gateway_resume"');
  });

  it("publishes only a minimal RLS-protected projection and increments on every permission source", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.admin_permission_epochs");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("auth_user_id = (SELECT auth.uid())");
    expect(migration).toContain("REVOKE ALL ON TABLE public.admin_permission_epochs FROM PUBLIC, anon, authenticated");
    expect(migration).toContain("GRANT SELECT ON TABLE public.admin_permission_epochs TO authenticated");
    expect(migration).toContain("ALTER PUBLICATION supabase_realtime ADD TABLE public.admin_permission_epochs");
    expect(migration).toContain("AFTER UPDATE OF role, permissions, is_active, disabled_at, auth_user_id ON public.admins");
    expect(migration).toContain("AFTER INSERT ON public.admin_custom_permissions");
    expect(migration).toContain("AFTER DELETE ON public.admin_custom_permissions");
    expect(migration).toContain("AFTER UPDATE ON public.admin_custom_permissions");
    expect(migration).toContain("REFERENCING NEW TABLE AS inserted_permissions");
    expect(migration).toContain("REFERENCING OLD TABLE AS deleted_permissions");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.sarah_ai_get_chat_access_context(");
    expect(migration).toContain("PERFORM public.assert_my_account_session_active()");
    expect(migration).toContain("p_cached_permissions_version = v_permissions_version");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.sarah_ai_get_chat_access_context(bigint) TO authenticated");
  });

  it("batches bulk permission replacement to avoid a Realtime event per permission", () => {
    const bulk = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION public.rpc_set_admin_custom_permissions__session_guarded_impl"));
    expect(bulk).toContain("DELETE FROM public.admin_custom_permissions");
    expect(bulk).toContain("FROM unnest(COALESCE(p_permissions, ARRAY[]::text[]))");
    expect(bulk).toContain("INSERT INTO public.admin_audit_logs");
    expect(bulk).not.toContain("FOREACH");
  });
});
