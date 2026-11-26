/**
 * Sarah's pre-execution durable input queue.
 * This is intentionally separate from the operational Outbox and fails closed
 * when IndexedDB is unavailable. It never stores credentials or BINs.
 */
export type SarahInputKind = "text" | "audio";
export type SarahInputState =
  | "QUEUED_OFFLINE" | "READY_TO_SEND" | "UPLOADING" | "SENT_TO_AI"
  | "WAITING_FOR_TOOL_EXECUTION" | "WAITING_FOR_CONFIRMATION"
  | "WAITING_FOR_CLARIFICATION" | "COMPLETED" | "NEEDS_ATTENTION";

export interface SarahInputRecord {
  id: string;
  actorAccountId: string;
  deviceId: string;
  sequence: number;
  createdAt: string;
  kind: SarahInputKind;
  state: SarahInputState;
  text?: string;
  audioBlob?: Blob;
  audioMimeType?: string;
  correlationId: string;
  aiRequestId?: string;
  resultRef?: string;
  lastErrorCode?: string;
  attempts: number;
  /** Lease expiry prevents other tabs from treating an active provider call as interrupted. */
  uploadLeaseUntil?: string;
}

const DB_NAME = "SarahDurableInputQueue";
const DB_VERSION = 1;
const STORE = "inputs";
const META = "meta";
const MAX_TEXT_CHARS = 20_000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const allowed: Record<SarahInputState, SarahInputState[]> = {
  QUEUED_OFFLINE: ["READY_TO_SEND", "NEEDS_ATTENTION"],
  READY_TO_SEND: ["UPLOADING", "QUEUED_OFFLINE", "NEEDS_ATTENTION"],
  UPLOADING: ["SENT_TO_AI", "READY_TO_SEND", "QUEUED_OFFLINE", "NEEDS_ATTENTION"],
  SENT_TO_AI: ["WAITING_FOR_TOOL_EXECUTION", "WAITING_FOR_CONFIRMATION", "WAITING_FOR_CLARIFICATION", "COMPLETED", "NEEDS_ATTENTION"],
  WAITING_FOR_TOOL_EXECUTION: ["WAITING_FOR_CONFIRMATION", "WAITING_FOR_CLARIFICATION", "COMPLETED", "NEEDS_ATTENTION"],
  WAITING_FOR_CONFIRMATION: ["READY_TO_SEND", "COMPLETED", "NEEDS_ATTENTION"],
  WAITING_FOR_CLARIFICATION: ["READY_TO_SEND", "COMPLETED", "NEEDS_ATTENTION"],
  COMPLETED: [],
  NEEDS_ATTENTION: ["READY_TO_SEND", "COMPLETED"],
};

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  if (typeof indexedDB === "undefined") return reject(new Error("DURABLE_STORAGE_UNAVAILABLE"));
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE)) {
      const store = db.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("account_sequence", ["actorAccountId", "sequence"], { unique: true });
      store.createIndex("account_state", ["actorAccountId", "state"]);
    }
    if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
  };
  request.onblocked = () => reject(new Error("DURABLE_STORAGE_UPGRADE_BLOCKED"));
  request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  request.onerror = () => reject(request.error || new Error("DURABLE_STORAGE_UNAVAILABLE"));
});

const requestValue = <T>(req: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export const sarahInputQueue = {
  async enqueue(input: Omit<SarahInputRecord, "sequence" | "createdAt" | "attempts">): Promise<SarahInputRecord> {
    if (!input.actorAccountId || !input.deviceId || !input.id || !input.correlationId) throw new Error("INVALID_QUEUE_INPUT");
    if (input.kind !== "text" && input.kind !== "audio") throw new Error("INVALID_QUEUE_KIND");
    if (input.state !== "QUEUED_OFFLINE" && input.state !== "READY_TO_SEND") throw new Error("INVALID_INITIAL_QUEUE_STATE");
    if (input.kind === "text" && input.audioBlob) throw new Error("TEXT_INPUT_CANNOT_INCLUDE_AUDIO");
    if (input.kind === "audio" && input.text) throw new Error("AUDIO_INPUT_CANNOT_INCLUDE_TEXT");
    if (input.kind === "text" && !input.text?.trim()) throw new Error("EMPTY_TEXT_INPUT");
    if (input.kind === "text" && (input.text?.length ?? 0) > MAX_TEXT_CHARS) throw new Error("TEXT_INPUT_TOO_LARGE");
    if (input.kind === "audio" && !(input.audioBlob instanceof Blob)) throw new Error("AUDIO_BLOB_REQUIRED");
    if (input.kind === "audio" && input.audioBlob && input.audioBlob.size > MAX_AUDIO_BYTES) throw new Error("AUDIO_INPUT_TOO_LARGE");
    if (input.kind === "audio" && !input.audioMimeType) throw new Error("AUDIO_MIME_TYPE_REQUIRED");
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, META], "readwrite");
      const store = tx.objectStore(STORE), meta = tx.objectStore(META);
      const key = `sequence:${input.actorAccountId}`;
      const get = meta.get(key);
      let record: SarahInputRecord | undefined;
      get.onerror = () => { tx.abort(); };
      get.onsuccess = () => {
        const sequence = Number(get.result || 0) + 1;
        meta.put(sequence, key);
        record = { ...input, sequence, createdAt: new Date().toISOString(), attempts: 0 };
        store.add(record);
      };
      tx.oncomplete = () => { db.close(); if (record) resolve(record); else reject(new Error("QUEUE_WRITE_INCOMPLETE")); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error("QUEUE_WRITE_FAILED")); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error("QUEUE_WRITE_ABORTED")); };
    });
  },

  async list(accountId: string): Promise<SarahInputRecord[]> {
    if (!accountId) throw new Error("ACCOUNT_REQUIRED");
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readonly");
      const rows = await requestValue(tx.objectStore(STORE).index("account_sequence").getAll(IDBKeyRange.bound([accountId, 0], [accountId, Number.MAX_SAFE_INTEGER])));
      return rows as SarahInputRecord[];
    } finally { db.close(); }
  },

  async transition(accountId: string, id: string, next: SarahInputState, details: Partial<Pick<SarahInputRecord, "aiRequestId" | "resultRef" | "lastErrorCode">> = {}): Promise<SarahInputRecord> {
    if (!accountId) throw new Error("ACCOUNT_REQUIRED");
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite"), store = tx.objectStore(STORE);
      const get = store.get(id); let updated: SarahInputRecord | undefined;
      get.onsuccess = () => {
        const current = get.result as SarahInputRecord | undefined;
        if (!current || current.actorAccountId !== accountId) { tx.abort(); return; }
        if (!allowed[current.state].includes(next)) { tx.abort(); return; }
        updated = { ...current, ...details, state: next, uploadLeaseUntil: next === "UPLOADING" ? new Date(Date.now() + 5 * 60 * 1000).toISOString() : undefined, lastErrorCode: next === "READY_TO_SEND" || next === "COMPLETED" ? undefined : details.lastErrorCode ?? current.lastErrorCode, attempts: current.attempts + (next === "UPLOADING" ? 1 : 0) };
        store.put(updated);
      };
      tx.oncomplete = () => { db.close(); if (updated) resolve(updated); else reject(new Error("QUEUE_TRANSITION_REJECTED")); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error("QUEUE_TRANSITION_FAILED")); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error("QUEUE_TRANSITION_REJECTED")); };
    });
  },

  /**
   * On restart, an upload may have reached the provider before the app closed.
   * Without server idempotency, do not auto-resend: surface it for review.
   */
  async recoverInterruptedUploads(accountId: string): Promise<number> {
    if (!accountId) throw new Error("ACCOUNT_REQUIRED");
    const pending = await this.list(accountId);
    const interrupted = pending.filter((row) => row.state === "UPLOADING" && (!row.uploadLeaseUntil || Date.parse(row.uploadLeaseUntil) <= Date.now()));
    let recovered = 0;
    for (const row of interrupted) {
      try {
        await this.transition(accountId, row.id, "NEEDS_ATTENTION", {
          lastErrorCode: "UPLOAD_INTERRUPTED_REQUIRES_REVIEW",
        });
        recovered += 1;
      } catch {
        // Another tab may have completed or changed this record since the listing.
        // Re-read before treating the race as an actual queue failure.
        const latest = await this.list(accountId);
        if (latest.some((item) => item.id === row.id && item.actorAccountId === accountId && item.state === "UPLOADING" && (!item.uploadLeaseUntil || Date.parse(item.uploadLeaseUntil) <= Date.now()))) {
          throw new Error("QUEUE_RECOVERY_RACE_FAILED");
        }
      }
    }
    return recovered;
  },

  async remove(accountId: string, id: string): Promise<boolean> {
    if (!accountId) throw new Error("ACCOUNT_REQUIRED");
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite"), store = tx.objectStore(STORE);
      const get = store.get(id); let removed = false;
      get.onsuccess = () => { const row = get.result as SarahInputRecord | undefined; if (row?.actorAccountId === accountId) { store.delete(id); removed = true; } };
      tx.oncomplete = () => { db.close(); resolve(removed); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error("QUEUE_REMOVE_FAILED")); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error("QUEUE_REMOVE_ABORTED")); };
    });
  },
};
