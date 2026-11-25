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
}

const DB_NAME = "SarahDurableInputQueue";
const DB_VERSION = 1;
const STORE = "inputs";
const META = "meta";
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
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error("DURABLE_STORAGE_UNAVAILABLE"));
});

const transact = async <T>(stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction) => void): Promise<T> =>
  new Promise<T>(async (resolve, reject) => {
    let db: IDBDatabase;
    try { db = await openDb(); } catch (e) { reject(e); return; }
    try {
      const tx = db.transaction(stores, mode);
      let result: T;
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error("QUEUE_TRANSACTION_FAILED")); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error("QUEUE_TRANSACTION_ABORTED")); };
      // The callback may attach result capture via the transaction's object stores.
      run(tx);
    } catch (e) { db.close(); reject(e); }
  });

const requestValue = <T>(req: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export const sarahInputQueue = {
  async enqueue(input: Omit<SarahInputRecord, "sequence" | "createdAt" | "attempts">): Promise<SarahInputRecord> {
    if (!input.actorAccountId || !input.deviceId || !input.id || !input.correlationId) throw new Error("INVALID_QUEUE_INPUT");
    if (input.kind === "text" && !input.text?.trim()) throw new Error("EMPTY_TEXT_INPUT");
    if (input.kind === "audio" && !(input.audioBlob instanceof Blob)) throw new Error("AUDIO_BLOB_REQUIRED");
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, META], "readwrite");
      const store = tx.objectStore(STORE), meta = tx.objectStore(META);
      const key = "sequence";
      const get = meta.get(key);
      let record: SarahInputRecord;
      get.onsuccess = () => {
        const sequence = Number(get.result || 0) + 1;
        meta.put(sequence, key);
        record = { ...input, sequence, createdAt: new Date().toISOString(), attempts: 0 };
        store.add(record);
      };
      tx.oncomplete = () => { db.close(); resolve(record); };
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
        updated = { ...current, ...details, state: next, attempts: current.attempts + (next === "UPLOADING" ? 1 : 0) };
        store.put(updated);
      };
      tx.oncomplete = () => { db.close(); resolve(updated!); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error("QUEUE_TRANSITION_FAILED")); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error("QUEUE_TRANSITION_REJECTED")); };
    });
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
