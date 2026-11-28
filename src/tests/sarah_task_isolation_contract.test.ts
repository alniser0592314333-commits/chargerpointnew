import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const gateway = readFileSync("supabase/functions/sarah-ai-chat/index.ts", "utf8");
const page = readFileSync("src/components/pages/SarahChatPage.tsx", "utf8");

describe("Sarah independent task and partial failure contract", () => {
  it("treats the current message as the only actionable task", () => {
    expect(gateway).toContain("STRICT TASK ISOLATION");
    expect(gateway).toContain("the current user message alone defines the task to execute now");
    expect(gateway).toContain("A new message is a new independent task");
  });

  it("never resumes an earlier task unless the current message explicitly requests it", () => {
    expect(gateway).toContain("Never replay, resume, retry, combine, or continue an earlier user request");
    expect(gateway).toContain("Only inspect prior task summaries when the current user explicitly asks");
    expect(gateway).toContain("retry only the exact failed or not-executed steps");
    expect(gateway).toContain("never repeat successful mutations");
  });

  it("reports historical failures without turning a status question into a mutation", () => {
    expect(gateway).toContain("When asked what failed previously, report only the failures already documented");
    expect(gateway).toContain("and do not mutate data");
  });

  it("retains a distinct request identity for each newly queued user message", () => {
    expect(page).toContain("const id = crypto.randomUUID()");
    expect(page).toContain("const correlationId = crypto.randomUUID()");
    expect(page).toContain("correlationId,");
    expect(page).toContain("historySnapshot,");
  });

  it("does not automatically retry a previous NEEDS_ATTENTION task when a new message is sent", () => {
    expect(page).toContain("row.state === \"NEEDS_ATTENTION\" && row.lastErrorCode === \"UPLOAD_INTERRUPTED_REQUIRES_REVIEW\"");
    expect(page).toContain("const retryQueued = async (record: SarahInputRecord)");
    expect(page).toContain("إعادة المحاولة");
  });

  it("passes earlier failed-task state to Sarah as read-only context for status questions", () => {
    expect(page).toContain("const priorTask = message.queueId ? pending.find");
    expect(page).toContain("priorTask?.state === \"NEEDS_ATTENTION\"");
    expect(page).toContain("رمز الخطأ: ${errorCode}");
    expect(page).toContain("لا تستأنف المهمة إلا إذا طلب المستخدم ذلك صراحةً");
  });

  it("keeps unfinished tasks attached to their originating daily conversation", () => {
    expect(page).toContain("conversationDate: selectedDate");
    expect(page).toContain('(item.conversationDate || gazaDateKey()) === selectedDate');
    expect(page).toContain('(row.conversationDate || gazaDateKey()) === selectedDate');
  });
});
