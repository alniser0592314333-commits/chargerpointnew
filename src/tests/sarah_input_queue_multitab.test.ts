import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  sarahInputQueue,
  type SarahInputRecord,
} from "../application/ai/sarahInputQueue";

const DB_NAME = "SarahDurableInputQueue";
const STORE = "inputs";

const deleteQueueDatabase = () => new Promise<void>((resolve, reject) => {
  const request = indexedDB.deleteDatabase(DB_NAME);
  request.onsuccess = () => resolve();
  request.onerror = () => reject(request.error || new Error("TEST_DATABASE_DELETE_FAILED"));
  request.onblocked = () => reject(new Error("TEST_DATABASE_DELETE_BLOCKED"));
});

const makeInput = (
  actorAccountId: string,
  id: string,
): Omit<SarahInputRecord, "sequence" | "createdAt" | "attempts"> => ({
  id,
  actorAccountId,
  deviceId: `device-${actorAccountId}`,
  kind: "text",
  state: "READY_TO_SEND",
  text: `message-${id}`,
  correlationId: `correlation-${id}`,
});

const openQueueDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 2);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error("TEST_DATABASE_OPEN_FAILED"));
});

const replaceRecord = async (record: SarahInputRecord): Promise<void> => {
  const db = await openQueueDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("TEST_RECORD_WRITE_FAILED"));
      tx.onabort = () => reject(tx.error || new Error("TEST_RECORD_WRITE_ABORTED"));
    });
  } finally {
    db.close();
  }
};

describe("Sarah durable queue multi-context IndexedDB behavior", () => {
  beforeEach(async () => {
    expect(typeof indexedDB).toBe("object");
    await deleteQueueDatabase();
  });

  afterEach(async () => {
    await deleteQueueDatabase();
  });

  it("serializes concurrent enqueue operations and enforces one account-wide pending cap", async () => {
    // Each enqueue opens its own IndexedDB connection, like independent tabs.
    const independentCallers = [
      ...Array.from({ length: 20 }, (_, index) =>
        sarahInputQueue.enqueue(makeInput("account-a", `tab-a-${index}`))),
      ...Array.from({ length: 20 }, (_, index) =>
        sarahInputQueue.enqueue(makeInput("account-a", `tab-b-${index}`))),
    ];
    const outcomes = await Promise.allSettled(independentCallers);
    const inserted = outcomes.filter(
      (result): result is PromiseFulfilledResult<SarahInputRecord> => result.status === "fulfilled",
    );
    const rejected = outcomes.filter((result) => result.status === "rejected");

    expect(inserted).toHaveLength(25);
    expect(rejected).toHaveLength(15);
    expect(rejected.every((result) =>
      result.reason instanceof Error && result.reason.message === "QUEUE_PENDING_LIMIT_REACHED"
    )).toBe(true);

    const rows = await sarahInputQueue.list("account-a");
    const sequences = rows.map((row) => row.sequence).sort((a, b) => a - b);
    expect(rows).toHaveLength(25);
    expect(new Set(sequences).size).toBe(25);
    expect(sequences).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
  });

  it("keeps sequence counters and reads isolated between accounts sharing the same database", async () => {
    const accountA = await sarahInputQueue.enqueue(makeInput("account-a", "a-1"));
    const accountB = await sarahInputQueue.enqueue(makeInput("account-b", "b-1"));

    expect(accountA.sequence).toBe(1);
    expect(accountB.sequence).toBe(1);
    expect(await sarahInputQueue.list("account-a")).toEqual([accountA]);
    expect(await sarahInputQueue.list("account-b")).toEqual([accountB]);
    expect(await sarahInputQueue.remove("account-a", accountB.id)).toBe(false);
    expect(await sarahInputQueue.list("account-b")).toEqual([accountB]);
  });

  it("allows only one concurrent caller to claim an item for upload", async () => {
    const queued = await sarahInputQueue.enqueue(makeInput("account-a", "claim-race"));
    const outcomes = await Promise.allSettled([
      sarahInputQueue.transition("account-a", queued.id, "UPLOADING"),
      sarahInputQueue.transition("account-a", queued.id, "UPLOADING"),
    ]);

    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    const [current] = await sarahInputQueue.list("account-a");
    expect(current.state).toBe("UPLOADING");
    expect(current.attempts).toBe(1);
    expect(current.uploadLeaseUntil).toBeTruthy();
  });

  it("recovers one expired upload exactly once when two tabs race", async () => {
    const queued = await sarahInputQueue.enqueue(makeInput("account-a", "recover-race"));
    await replaceRecord({
      ...queued,
      state: "UPLOADING",
      uploadLeaseUntil: new Date(Date.now() - 1_000).toISOString(),
    });

    const recovered = await Promise.all([
      sarahInputQueue.recoverInterruptedUploads("account-a"),
      sarahInputQueue.recoverInterruptedUploads("account-a"),
    ]);

    expect(recovered.reduce((sum, count) => sum + count, 0)).toBe(1);
    const [current] = await sarahInputQueue.list("account-a");
    expect(current.state).toBe("NEEDS_ATTENTION");
    expect(current.lastErrorCode).toBe("UPLOAD_INTERRUPTED_REQUIRES_REVIEW");
    expect(await sarahInputQueue.recoverInterruptedUploads("account-a")).toBe(0);
  });
});
