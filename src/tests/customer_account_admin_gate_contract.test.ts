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
});
