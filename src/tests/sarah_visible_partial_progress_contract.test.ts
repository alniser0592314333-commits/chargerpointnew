import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const gateway = readFileSync("supabase/functions/sarah-ai-chat/index.ts", "utf8");
const service = readFileSync("src/services/ai/sarahChatService.ts", "utf8");
const page = readFileSync("src/components/pages/SarahChatPage.tsx", "utf8");

describe("Sarah visible partial execution reports", () => {
  it("derives a minimal progress report from durable call results without exposing tool arguments", () => {
    expect(gateway).toContain("const buildPartialProgress = () =>");
    expect(gateway).toContain("const results = taskState.resultsByIndex");
    expect(gateway).toContain('status: "succeeded" as const');
    expect(gateway).toContain('status: "failed" as const');
    expect(gateway).toContain('status: "not_executed" as const');
    expect(gateway).toContain("partialProgress: buildPartialProgress()");
    expect(gateway).not.toContain("partialProgress: { requestedCalls");
  });

  it("returns partial progress for provider failure after tools were checkpointed and for exhausted timeouts", () => {
    const followUp = gateway.indexOf("const followUpResponse = await callGemini");
    const followUpError = gateway.indexOf("partialProgress: buildPartialProgress()", followUp);
    const timeout = gateway.indexOf('error: "AI_REQUEST_TIMEOUT"');
    const timeoutProgress = gateway.indexOf("partialProgress: buildPartialProgress()", timeout);
    expect(followUpError).toBeGreaterThan(followUp);
    expect(timeoutProgress).toBeGreaterThan(timeout);
  });

  it("formats only capability labels and outcome categories for the user", () => {
    expect(service).toContain("const formatPartialProgress = (value: unknown)");
    expect(service).toContain("نجح:");
    expect(service).toContain("فشل:");
    expect(service).toContain("لم يُنفّذ بعد:");
    expect(service).toContain("حُفظ تقدم المهمة");
    expect(service).toContain("class SarahPartialTaskError");
    expect(service).not.toContain("step.args");
  });

  it("persists the partial report in the same transcript and leaves the task retryable", () => {
    expect(page).toContain("err instanceof SarahPartialTaskError");
    expect(page).toContain("توقفت بعد تنفيذ بعض الخطوات؛ راجع التقرير");
    expect(page).toContain("queueId: id");
    expect(page).toContain("queueId: record.id");
    expect(page).toContain('transition(accountId, id, offline ? "QUEUED_OFFLINE" : "NEEDS_ATTENTION"');
    expect(page).toContain('transition(accountId, record.id, offline ? "QUEUED_OFFLINE" : "NEEDS_ATTENTION"');
  });

  it("keeps a partial report when retrying and replaces the previous report for that task", () => {
    expect(page).toContain('item.role === "assistant" && item.queueId === record.id');
    expect(page).toContain("partialSummary, createdAt: new Date().toISOString(), queueId: record.id");
    expect(page).toContain("سأستكمل الخطوات غير المكتملة فقط");
  });
});
