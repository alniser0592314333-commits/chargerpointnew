// Contract checks for the server-side chat gateway; run in CI without production credentials.
import { readFileSync } from "node:fs";
import { describe,it,expect } from "vitest";
const source=readFileSync("supabase/functions/sarah-ai-chat/index.ts","utf8");
describe("Sarah chat gateway security contract",()=>{
 it("authenticates Supabase user and admin account server-side",()=>{expect(source).toContain("auth.getUser(bearer)");expect(source).toContain("get_current_admin_profile");expect(source).toContain("profile.auth_user_id!==userData.user.id");});
 it("enforces ai use permission and never accepts client role",()=>{expect(source).toContain('perms.includes("ai:use")');expect(source).not.toContain("body.role");});
 it("uses an atomic server-side actor quota before Gemini/provider secret access",()=>{expect(source).toContain("sarah_ai_consume_quota");expect(source).toContain("p_actor_auth_user_id:userData.user.id");expect(source).toContain("AI_RATE_LIMITED");expect(source.indexOf("sarah_ai_consume_quota")).toBeLessThan(source.indexOf("sarah_ai_get_provider_secret"));});
 it("limits prompt size and uses provider key server-side",()=>{expect(source).toContain("historyChars>12000");expect(source).toContain("item.text.length>6000");expect(source).toContain("MAX_BODY_BYTES");expect(source).toContain("safeText(body.text,20000)");expect(source).toContain("sarah_ai_get_provider_secret");expect(source).toContain("x-goog-api-key");});
 it("does not expose provider raw errors or response bodies",()=>{expect(source).toContain("GEMINI_PROVIDER_UNAVAILABLE");expect(source).not.toContain("resp.text()");});
 it("returns no cache headers and bounded timeout",()=>{expect(source).toContain('Cache-Control":"no-store"');expect(source).toContain("AbortController");});
});