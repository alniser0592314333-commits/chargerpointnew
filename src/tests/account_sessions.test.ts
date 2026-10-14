import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { describeSessionUserAgent } from "../services/auth/accountSessionService";

describe("Account session management", () => {
  it("identifies Microsoft Edge before its Chromium Chrome token", () => {
    const result = describeSessionUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0");
    expect(result.browser).toBe("Microsoft Edge");
    expect(result.operatingSystem).toBe("Windows");
    expect(result.device).toBe("Computer");
  });

  it("identifies Samsung Internet and Android mobile devices", () => {
    const result = describeSessionUserAgent("Mozilla/5.0 (Linux; Android 12; SM-N975F) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36 SamsungBrowser/25.0");
    expect(result.browser).toBe("Samsung Internet");
    expect(result.operatingSystem).toBe("Android");
    expect(result.device).toBe("Mobile");
  });

  it("does not expose raw user-agent text as a display label", () => {
    const result = describeSessionUserAgent("unrecognized-private-user-agent");
    expect(result.device).toBe("Computer");
    expect(result.browser).toBe("Unknown browser");
    expect(JSON.stringify(result)).not.toContain("unrecognized-private-user-agent");
  });

  it("keeps session administration caller-scoped and revokes refresh credentials", () => {
    const sql = readFileSync("supabase/migrations/20261014130000_account_session_management.sql", "utf8");
    expect(sql).toContain("ALTER TABLE public.account_sessions ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("REVOKE ALL ON TABLE public.account_sessions FROM PUBLIC, anon, authenticated");
    expect(sql).toContain("auth.uid()");
    expect(sql).toContain("auth.jwt() ->> 'session_id'");
    expect(sql).toContain("UPDATE auth.refresh_tokens SET revoked = true");
    expect(sql).toContain("UPDATE auth.sessions SET not_after");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION public.get_my_account_sessions() FROM PUBLIC, anon");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.get_my_account_sessions() TO authenticated");
    expect(sql).toContain("p_session_id uuid");
  });
});
