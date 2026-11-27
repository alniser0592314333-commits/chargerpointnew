import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("Sarah local Sync Center bridge", () => {
  it("sends only a sanitized local snapshot and runs the existing manual sync action", () => {
    const page = readFileSync("src/components/pages/SarahChatPage.tsx", "utf8");
    const service = readFileSync("src/services/ai/sarahChatService.ts", "utf8");
    const edge = readFileSync("supabase/functions/sarah-ai-chat/index.ts", "utf8");

    expect(page).toContain('session.permissions.includes("sync:manage")');
    expect(page).toContain("localDb.listOutbox()");
    expect(page).toContain("localDb.listHistory()");
    expect(page).toContain('localDb.getSyncState("global")');
    expect(page).toContain("globalSyncBridge.requestManualSync()");
    expect(page).toContain("recentErrorClasses");
    expect(page).not.toContain("requestBody.bin =");
    expect(service).toContain('data.error === "LOCAL_SYNC_REQUIRED"');
    expect(service).toContain("requestBody.localSyncContext");
    expect(service).toContain("requestBody.localSyncActionResult");
    expect(edge).toContain('caller.rpc("begin_sync_bootstrap")');
    expect(edge).toContain('name: "request_manual_sync"');
    expect(edge).toContain("never as authorization");
  });
});
