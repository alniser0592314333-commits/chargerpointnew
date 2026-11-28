import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const gateway = readFileSync("supabase/functions/sarah-ai-chat/index.ts", "utf8");
const page = readFileSync("src/components/pages/SarahChatPage.tsx", "utf8");

describe("Sarah checkpointed partial execution recovery", () => {
  it("derives mutation idempotency keys from the independent task request identity", () => {
    expect(gateway).toContain('${requestId}:${toolName}:${stableSerialize(args)}');
    expect(gateway).toContain("const actionRequestId = confirmedActionRequestId || await deriveActionRequestId(toolName, args)");
    expect(gateway).toContain("p_request_id: actionRequestId");
  });

  it("restores completed tool results and skips those exact call indexes after interruption", () => {
    expect(gateway).toContain("const savedResults = taskState.resultsByIndex");
    expect(gateway).toContain("executionCalls = executionCalls.filter((call) => !resultsByIndex.has(call.index))");
    expect(gateway).toContain("resultsByIndex: Object.fromEntries(resultsByIndex)");
  });

  it("checkpoints each tool result before asking Gemini to continue", () => {
    const execute = gateway.indexOf("for (const requestedCall of executionCalls)");
    const save = gateway.indexOf('await checkpointTask("RUNNING", {', execute);
    const response = gateway.indexOf("const followUpResponse = await callGemini", save);
    expect(execute).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(execute);
    expect(response).toBeGreaterThan(save);
  });

  it("preserves failed and deferred tool results in the function-response batch", () => {
    expect(gateway).toContain('error: "ACTION_FAILED"');
    expect(gateway).toContain('error: "MUTATION_DEFERRED_UNTIL_READS_COMPLETE"');
    expect(gateway).toContain("response: { result: resultsByIndex.get(index) }");
  });

  it("does not resume a prior task merely because a new message was sent", () => {
    expect(page).toContain("const correlationId = crypto.randomUUID()");
    expect(page).toContain("const retryIntent =");
    expect(page).toContain("if (retryIntent)");
    expect(page).toContain("void retryQueued(failedTasks[0])");
  });

  it("requires explicit user action to retry a task in NEEDS_ATTENTION", () => {
    const onlineHandler = page.slice(page.indexOf("const handleOnline = async () =>"), page.indexOf('window.addEventListener("online", handleOnline)'));
    expect(onlineHandler).not.toContain('row.state === "NEEDS_ATTENTION"');
    expect(page).toContain("onClick={() => {");
    expect(page).toContain("if (row) void retryQueued(row)");
  });
});
