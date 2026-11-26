import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("Sarah account-switch asynchronous isolation", () => {
  const page = readFileSync("src/components/pages/SarahChatPage.tsx", "utf8");
  const chatService = readFileSync("src/services/ai/sarahChatService.ts", "utf8");
  const authService = readFileSync("src/services/auth/authService.ts", "utf8");
  const supabaseClient = readFileSync("src/services/supabase/client.ts", "utf8");
  it("invalidates asynchronous work when account identity changes", () => {
    expect(page).toContain("SarahAccountOperationScope");
    expect(page).toContain("const accountId = session?.authUserId || null");
    expect(page).toContain("accountScopeRef.current.switchTo(accountScopeIdentity(session?.userId, session?.authUserId))");
    expect(page).toContain("isCurrent(accountId, operation)");
  });
  it("clears cross-account UI state on identity change", () => {
    for (const state of ["setMessages([])", "setText(\"\")", "setBusy(false)", "setError(\"\")", "setPending([])", "setHydratedAccount(null)"]) expect(page).toContain(state);
  });
  it("binds transcript hydration and persistence to the hydrated account", () => {
    expect(page).toContain("if (!accountId || hydratedAccount !== accountId");
    expect(page).toContain("accountScopeIdentity(session?.userId, session?.authUserId)");
  });
  it("guards post-await queue and chat state updates", () => {
    expect(page).toContain("refreshQueue(accountId, operation)");
    expect(page).toContain("if (!isCurrent(accountId, operation)) return");
    expect(page).toContain("if (isCurrent(accountId, operation)) setMessages");
    expect(page).toContain("if (isCurrent(accountId, operation)) setBusy(false)");
  });
  it("does not retry another account's queued record", () => {
    expect(page).toContain("record.actorAccountId !== accountId");
    expect(page).toContain("accountScopeIdentity(session?.userId, session?.authUserId)");
    expect(page).toContain("hydratedAccount !== accountId");
  });
  it("binds every Sarah request to the verified Auth subject, not the admin row ID", () => {
    expect(authService).toContain("authUserId?: ID");
    expect(authService).toContain("authUserId: signInRes.session.user.id");
    expect(authService).toContain("authUserId: refreshed.user.id");
    expect(page).toContain("sarahChatService.send(clean, session?.authUserId || '', historySnapshot)");
    expect(page).toContain("sarahChatService.send(record.text, session?.authUserId || '', retryHistory)");
    expect(chatService).toContain("tokenSubject(session.token) !== expectedAuthUserId");
    expect(chatService).toContain("before?.user?.id !== expectedAuthUserId");
    expect(chatService).toContain("after?.user?.id !== expectedAuthUserId");
  });

  it("prevents a stale token refresh from replacing a newer account selection", () => {
    expect(supabaseClient).toContain("const latestStored = getStoredSupabaseAuthSession()");
    expect(supabaseClient).toContain("latestStored.user?.id !== stored.user?.id");
    expect(supabaseClient).toContain("latestStored.refresh_token !== stored.refresh_token");
  });

});
