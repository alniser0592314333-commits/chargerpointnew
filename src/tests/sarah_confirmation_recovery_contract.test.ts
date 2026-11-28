import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Sarah UI, secure confirmation, and actionable failure contract", () => {
  const page = read("src/components/pages/SarahChatPage.tsx");
  const service = read("src/services/ai/sarahChatService.ts");
  const edge = read("supabase/functions/sarah-ai-chat/index.ts");

  it("uses the Sarah brand as the only drawer trigger and centers the short exit action", () => {
    expect(page).not.toContain("Menu,");
    expect(page).not.toContain("<Menu");
    expect(page).toContain('aria-label="فتح محادثات سارة"');
    expect(page).toContain("justify-center border-t");
    expect(page).toContain("> خروج</button>");
    expect(page).not.toContain("خروج من سارة");
  });

  it("requires an explicit server acknowledgement before treating a BIN action as confirmed", () => {
    expect(service).toContain("confirmationApplied?: boolean");
    expect(service).toContain("confirmationApplied: confirmationAction ? data.confirmationApplied === true : false");
    expect(page).toContain('confirmationResponse.confirmationApplied !== true');
    expect(page).toContain("protectedActionConfirmed = true");
    expect(page).toContain("setPendingBinAction(null)");
    expect(page).toContain("pendingBinAction: undefined");
  });

  it("distinguishes a completed protected mutation from an interrupted final response", () => {
    expect(page).toContain("AI_TASK_INTERRUPTED_AFTER_CONFIRMED_ACTION");
    expect(page).toContain("تم تنفيذ العملية بعد التأكيد الأمني");
    expect(page).toContain("تم تنفيذ العملية المحمية؛ تعذر استكمال الرد النهائي");
    expect(page).toContain("لن أعيد تنفيذ العملية الناجحة عند المتابعة");
  });

  it("returns a server-side confirmation acknowledgement only after the protected RPC succeeds", () => {
    expect(edge).toContain("confirmationApplied: true");
    expect(edge).toContain("await checkpointTask(\"RUNNING\"");
    expect(edge).toContain("phase: \"CONFIRMED_ACTION\"");
    expect(edge).toContain("verifyPendingActionToken");
    expect(edge).toContain("signedAction.actorId !== userData.user.id");
    expect(edge).toContain("signedAction.sessionId !== authSessionId");
  });

  it("classifies database failures without exposing raw database messages or secrets", () => {
    expect(edge).toContain("classifyCapabilityFailure");
    expect(edge).toContain("AI_CAPABILITY_TARGET_NOT_FOUND");
    expect(edge).toContain("AI_CAPABILITY_STALE_DATA");
    expect(edge).toContain("AI_CAPABILITY_DATABASE_RULE_REJECTED");
    expect(edge).toContain('console.warn("Sarah capability execution failed"');
    expect(edge).not.toContain("console.warn(\"Sarah capability execution failed\", {\n        requestId,\n        capability: toolName,\n        args");
  });

  it("keeps internal UUIDs out of user-facing responses and tells Sarah to explain failures", () => {
    expect(edge).toContain("sanitizeAssistantAnswer");
    expect(edge).toContain("answer = sanitizeAssistantAnswer(answer)");
    expect(edge).toContain("Never expose UUIDs, internal database IDs");
    expect(edge).toContain("explicitly say what failed, why it failed");
    expect(service).toContain("AI_CAPABILITY_PERMISSION_REVOKED");
    expect(service).toContain("AI_CAPABILITY_TARGET_NOT_FOUND");
    expect(service).toContain("AI_CAPABILITY_STALE_DATA");
  });
});
