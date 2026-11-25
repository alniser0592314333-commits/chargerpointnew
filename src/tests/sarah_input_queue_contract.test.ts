import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("Sarah durable input queue architecture contract", () => {
  const source = readFileSync("src/application/ai/sarahInputQueue.ts", "utf8");
  it("uses an independent IndexedDB store and never memory fallback", () => {
    expect(source).toContain('SarahDurableInputQueue');
    expect(source).toContain('const STORE = "inputs"');
    expect(source).toContain('createObjectStore(STORE');
    expect(source).toContain('DURABLE_STORAGE_UNAVAILABLE');
    expect(source).not.toContain("localDb");
  });
  it("stores account identity, sequence, original audio Blob, and correlation", () => {
    for (const field of ["actorAccountId", "sequence", "audioBlob", "correlationId", "deviceId"]) expect(source).toContain(field);
  });
  it("guards state transitions and account-scoped access", () => {
    expect(source).toContain("allowed[current.state].includes(next)");
    expect(source).toContain("current.actorAccountId !== accountId");
    expect(source).toContain("row?.actorAccountId === accountId");
  });
  it("does not blindly retry uploads interrupted by app shutdown", () => {
    expect(source).toContain("recoverInterruptedUploads");
    expect(source).toContain("UPLOAD_INTERRUPTED_REQUIRES_REVIEW");
    expect(source).toContain("UPLOADING");
    expect(source).toContain('lastErrorCode: "UPLOAD_INTERRUPTED_REQUIRES_REVIEW"');
    expect(source).toContain('await this.transition(accountId, row.id, "NEEDS_ATTENTION"');
  });
  it("limits stored text and audio payload sizes", () => {
    expect(source).toContain("MAX_TEXT_CHARS");
    expect(source).toContain("MAX_AUDIO_BYTES");
    expect(source).toContain("TEXT_INPUT_TOO_LARGE");
    expect(source).toContain("AUDIO_INPUT_TOO_LARGE");
    expect(source).toContain("QUEUE_WRITE_INCOMPLETE");
    expect(source).toContain("let record: SarahInputRecord | undefined");
  });
  it("keeps the operational outbox separate and limits metadata fields", () => {
    expect(source).toContain("pre-execution durable input queue");
    expect(source).toContain("aiRequestId");
    expect(source).toContain("resultRef");
  });
  it("avoids replaying the queued text as duplicate history on retry", () => {
    const page = readFileSync("src/components/pages/SarahChatPage.tsx", "utf8");
    expect(page).toContain("retryHistory.at(-1)?.text === record.text");
    expect(page).toContain("retryHistory.pop()");
  });
});
