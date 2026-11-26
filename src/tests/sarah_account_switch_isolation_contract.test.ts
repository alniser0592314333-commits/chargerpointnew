import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("Sarah account-switch asynchronous isolation", () => {
  const page = readFileSync("src/components/pages/SarahChatPage.tsx", "utf8");
  it("invalidates asynchronous work when account identity changes", () => {
    expect(page).toContain("activeAccountRef");
    expect(page).toContain("operationRef.current += 1");
    expect(page).toContain("isCurrent(accountId, operation)");
  });
  it("clears cross-account UI state on identity change", () => {
    for (const state of ["setMessages([])", "setText(\"\")", "setBusy(false)", "setError(\"\")", "setPending([])", "setHydratedAccount(null)"]) expect(page).toContain(state);
  });
  it("binds transcript hydration and persistence to the hydrated account", () => {
    expect(page).toContain("if (!accountId || hydratedAccount !== accountId");
    expect(page).toContain("activeAccountRef.current !== accountId");
  });
  it("guards post-await queue and chat state updates", () => {
    expect(page).toContain("refreshQueue(accountId, operation)");
    expect(page).toContain("if (!isCurrent(accountId, operation)) return");
    expect(page).toContain("if (isCurrent(accountId, operation)) setMessages");
    expect(page).toContain("if (isCurrent(accountId, operation)) setBusy(false)");
  });
  it("does not retry another account's queued record", () => {
    expect(page).toContain("record.actorAccountId !== accountId");
    expect(page).toContain("activeAccountRef.current !== accountId");
    expect(page).toContain("hydratedAccount !== accountId");
  });
});
