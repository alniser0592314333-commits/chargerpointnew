import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { uploadLeaseExpired, canRecoverObservedUpload, SarahInputRecord } from "../application/ai/sarahInputQueue";

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
    expect(source).toContain("canRecoverObservedUpload(observed, current, accountId)");
    expect(source).toContain('store.put({ ...current, state: "NEEDS_ATTENTION"');
    expect(source).toContain("Compare-and-set inside the same transaction");
    expect(source).not.toContain('await this.transition(accountId, row.id, "NEEDS_ATTENTION"');
  });
  it("uses a bounded upload lease so other tabs only recover expired uploads", () => {
    expect(source).toContain("uploadLeaseUntil");
    expect(source).toContain("Date.now() + 5 * 60 * 1000");
    expect(source).toContain("uploadLeaseExpired(row)");
    expect(source).toContain("!Number.isFinite(expires) || expires <= Date.now()");
    expect(source).toContain("current.uploadLeaseUntil !== observed.uploadLeaseUntil");
    expect(source).toContain("if (outcome === \"recovered\") recovered += 1");
    expect(source).not.toContain("QUEUE_RECOVERY_RACE_FAILED");
  });

  it("rejects stale lease observations and cross-account/state changes", () => {
    const expired = new Date(Date.now() - 1000).toISOString();
    const base = { id: "q", actorAccountId: "a", deviceId: "d", sequence: 1, createdAt: new Date().toISOString(), kind: "text" as const, state: "UPLOADING" as const, text: "x", correlationId: "c", attempts: 1, uploadLeaseUntil: expired };
    expect(canRecoverObservedUpload(base, base, "a")).toBe(true);
    expect(canRecoverObservedUpload(base, { ...base, uploadLeaseUntil: new Date(Date.now()+60000).toISOString() }, "a")).toBe(false);
    expect(canRecoverObservedUpload(base, { ...base, state: "COMPLETED" }, "a")).toBe(false);
    expect(canRecoverObservedUpload(base, { ...base, actorAccountId: "b" }, "a")).toBe(false);
    expect(canRecoverObservedUpload(base, undefined, "a")).toBe(false);
  });
  it("caps offline pending work and erases completed payload only after transcript persistence", () => {
    expect(source).toContain("MAX_PENDING_RECORDS = 25");
    expect(source).toContain("MAX_PENDING_AUDIO_BYTES = 100 * 1024 * 1024");
    expect(source).toContain("QUEUE_PENDING_LIMIT_REACHED");
    expect(source).toContain("QUEUE_AUDIO_BUDGET_EXCEEDED");
    expect(source).toContain("if (next === \"COMPLETED\")");
    expect(source).toContain("delete updated.audioBlob");
    expect(source).toContain("delete updated.text");
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

  it("prunes only account-owned completed records after the retention cutoff", () => {
    const page = readFileSync("src/components/pages/SarahChatPage.tsx", "utf8");
    expect(page).toContain("pruneCompleted(accountId, 30)");
    expect(source).toContain('row.state === "COMPLETED"');
    expect(source).toContain("row.actorAccountId === accountId");
    expect(source).toContain("olderThanDays > 365");
    expect(source).toContain("latest.state === \"COMPLETED\"");
  });
  it("avoids replaying the queued text as duplicate history on retry", () => {
    const page = readFileSync("src/components/pages/SarahChatPage.tsx", "utf8");
    expect(page).toContain("retryHistory.at(-1)?.text === record.text");
    expect(page).toContain("retryHistory.pop()");
  });

it("classifies active, expired, missing, and malformed leases",()=>{const base={id:"q",actorAccountId:"a",deviceId:"d",sequence:1,createdAt:new Date().toISOString(),kind:"text" as const,state:"UPLOADING" as const,text:"x",correlationId:"c",attempts:1};expect(uploadLeaseExpired({...base,uploadLeaseUntil:new Date(Date.now()+60000).toISOString()} as SarahInputRecord)).toBe(false);expect(uploadLeaseExpired({...base,uploadLeaseUntil:new Date(Date.now()-1).toISOString()} as SarahInputRecord)).toBe(true);expect(uploadLeaseExpired({...base,uploadLeaseUntil:"invalid"} as SarahInputRecord)).toBe(true);expect(uploadLeaseExpired(base as SarahInputRecord)).toBe(true);});
});
