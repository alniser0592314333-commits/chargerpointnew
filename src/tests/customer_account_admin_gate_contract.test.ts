import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("customer edge-function admin identity gates", () => {
  it("requires the customer-account admin profile to match the verified bearer subject", () => {
    const source = readFileSync("supabase/functions/customer-account/index.ts", "utf8");
    expect(source).toContain("profile.auth_user_id !== authenticated.user.id");
    expect(source).toContain("profile.is_admin !== true");
    expect(source).toContain("profile.is_active !== true");
  });

  it("requires the customer-history admin profile to match the verified bearer subject", () => {
    const source = readFileSync("supabase/functions/customer-history/index.ts", "utf8");
    expect(source).toContain("p?.auth_user_id === auth.user.id");
    expect(source).toContain("p?.is_admin === true");
    expect(source).toContain("p?.is_active === true");
  });
  it("bounds privileged edge request bodies while streaming instead of buffering untrusted input", () => {
    const paths = [
      "supabase/functions/account-biometric/index.ts",
      "supabase/functions/customer-account/index.ts",
      "supabase/functions/customer-history/index.ts",
      "supabase/functions/customer-portal-events/index.ts",
      "supabase/functions/native-push/index.ts",
      "supabase/functions/wallet-service/index.ts",
      "supabase/functions/sign-in-by-username/handler.ts",
    ];
    for (const path of paths) {
      const source = readFileSync(path, "utf8");
      expect(source).toContain("readBoundedRequestBody");
      expect(source).not.toContain("request.json()");
      expect(source).not.toContain("request.text()");
      expect(source).not.toContain("req.text()");
    }
  });

  it("binds elevated admin Edge Function actions to the verified subject and active state", () => {
    const portal = readFileSync("supabase/functions/customer-portal-events/index.ts", "utf8");
    const reminders = readFileSync("supabase/functions/debt-reminders/index.ts", "utf8");
    const push = readFileSync("supabase/functions/native-push/index.ts", "utf8");
    expect(portal).toContain("profile.auth_user_id !== user.id");
    expect(portal).toContain("profile.is_active !== true");
    expect(reminders).toContain("profile?.auth_user_id === authData.user.id");
    expect(reminders).toContain("profile?.is_active === true");
    expect(push).toContain("row?.auth_user_id !== user.id");
    expect(push).toContain("row?.is_active !== true");
  });

  it("blocks disabled admins in biometric identity and proof flows", () => {
    const source = readFileSync("supabase/functions/account-biometric/index.ts", "utf8");
    expect(source).toContain("adminRow?.is_active === true && !adminRow.disabled_at");
    expect(source).toContain("row?.is_active === true && !row.disabled_at");
    expect(source).toContain("adminRow.disabled_at");
  });


});
