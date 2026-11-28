export type SarahConversationMessage = {
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
  status?: "sending" | "sent" | "offline" | "running" | "waiting_confirmation" | "failed";
  queueId?: string;
  statusText?: string;
};
export type SarahConversationSnapshot = { messages: SarahConversationMessage[]; generation: number };
export type SarahDailyConversation = {
  id: string;
  accountId: string;
  date: string;
  title: string;
  messages: SarahConversationMessage[];
  updatedAt: string;
  generation: number;
};
const DB = "SarahConversations";
const STORE = "conversations";
const DAILY_STORE = "dailyConversations";
const META = "meta";
type ClearNotice = { accountId: string; generation: number; date?: string };
const listeners = new Set<(notice: ClearNotice) => void>();
let channel: BroadcastChannel | null = null;
const ensureChannel = () => {
  if (channel || typeof BroadcastChannel === "undefined") return;
  channel = new BroadcastChannel("sarah-conversation-clear");
  channel.onmessage = (event: MessageEvent<ClearNotice>) => {
    const notice = event.data;
    if (notice && typeof notice.accountId === "string" && Number.isSafeInteger(notice.generation)) {
      listeners.forEach((listener) => listener(notice));
    }
  };
};
const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  if (typeof indexedDB === "undefined") return reject(new Error("DURABLE_STORAGE_UNAVAILABLE"));
  const request = indexedDB.open(DB, 3);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "accountId" });
    if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "accountId" });
    if (!db.objectStoreNames.contains(DAILY_STORE)) {
      const daily = db.createObjectStore(DAILY_STORE, { keyPath: "id" });
      daily.createIndex("account_date", ["accountId", "date"], { unique: true });
      daily.createIndex("account_updated", ["accountId", "updatedAt"]);
    }
  };
  request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  request.onerror = () => reject(request.error || new Error("DURABLE_STORAGE_UNAVAILABLE"));
});
const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date);
const dailyId = (accountId: string, date: string) => `${accountId}:${date}`;
const transactionResult = <T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction, resolve: (value: T) => void, reject: (error: unknown) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    run(tx, resolve, reject);
    tx.onerror = () => reject(tx.error || new Error("CONVERSATION_TRANSACTION_FAILED"));
    tx.onabort = () => reject(tx.error || new Error("CONVERSATION_TRANSACTION_ABORTED"));
  });

export const sarahConversationStore = {
  subscribeToClear(listener: (notice: ClearNotice) => void): () => void {
    ensureChannel();
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async load(accountId: string): Promise<SarahConversationSnapshot> {
    if (!accountId) throw new Error("ACCOUNT_REQUIRED");
    const db = await open();
    try {
      return await transactionResult(db, [STORE, META], "readonly", (tx, resolve) => {
        const rowRequest = tx.objectStore(STORE).get(accountId);
        const metaRequest = tx.objectStore(META).get(accountId);
        let row: any;
        let meta: any;
        rowRequest.onsuccess = () => { row = rowRequest.result; };
        metaRequest.onsuccess = () => { meta = metaRequest.result; };
        tx.oncomplete = () => resolve({
          messages: Array.isArray(row?.messages) ? row.messages : [],
          generation: Number.isSafeInteger(meta?.generation) && meta.generation >= 0 ? meta.generation : 0,
        });
      });
    } finally { db.close(); }
  },
  async save(accountId: string, messages: SarahConversationMessage[], generation: number): Promise<void> {
    if (!accountId) throw new Error("ACCOUNT_REQUIRED");
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("INVALID_CONVERSATION_GENERATION");
    if (messages.length > 500) messages = messages.slice(-500);
    const updatedAt = new Date().toISOString();
    const db = await open();
    try {
      await transactionResult(db, [STORE, META], "readwrite", (tx, resolve) => {
        const meta = tx.objectStore(META);
        const rows = tx.objectStore(STORE);
        const request = meta.get(accountId);
        request.onsuccess = () => {
          const current = Number.isSafeInteger(request.result?.generation) && request.result.generation >= 0 ? request.result.generation : 0;
          if (current === generation) rows.put({ accountId, messages, updatedAt, generation });
        };
        tx.oncomplete = () => resolve(undefined);
      });
    } finally { db.close(); }
  },
  async ensureDaily(accountId: string, date: string, title: string): Promise<SarahDailyConversation> {
    if (!accountId) throw new Error("ACCOUNT_REQUIRED");
    if (!validDate(date) || !title.trim()) throw new Error("INVALID_DAILY_CONVERSATION");
    const id = dailyId(accountId, date);
    const db = await open();
    try {
      return await transactionResult(db, [STORE, DAILY_STORE], "readwrite", (tx, resolve) => {
        const daily = tx.objectStore(DAILY_STORE);
        const request = daily.get(id);
        let result: SarahDailyConversation | undefined;
        request.onsuccess = () => {
          if (request.result) {
            result = request.result as SarahDailyConversation;
            return;
          }
          const legacyRequest = tx.objectStore(STORE).get(accountId);
          legacyRequest.onsuccess = () => {
            const legacy = legacyRequest.result;
            result = {
              id, accountId, date, title,
              messages: Array.isArray(legacy?.messages) ? legacy.messages : [],
              updatedAt: new Date().toISOString(),
              generation: 0,
            };
            daily.add(result);
          };
        };
        tx.oncomplete = () => {
          if (result) resolve(result);
          else throw new Error("DAILY_CONVERSATION_CREATE_FAILED");
        };
      });
    } finally { db.close(); }
  },
  async listDaily(accountId: string): Promise<SarahDailyConversation[]> {
    if (!accountId) throw new Error("ACCOUNT_REQUIRED");
    const db = await open();
    try {
      return await transactionResult(db, [DAILY_STORE], "readonly", (tx, resolve) => {
        const request = tx.objectStore(DAILY_STORE).index("account_date")
          .getAll(IDBKeyRange.bound([accountId, ""], [accountId, "\\uffff"]));
        request.onsuccess = () => resolve((request.result as SarahDailyConversation[]).sort((a, b) => b.date.localeCompare(a.date)));
      });
    } finally { db.close(); }
  },
  async loadDaily(accountId: string, date: string, title: string): Promise<SarahConversationSnapshot> {
    const conversation = await this.ensureDaily(accountId, date, title);
    return { messages: conversation.messages, generation: conversation.generation };
  },
  async saveDaily(accountId: string, date: string, messages: SarahConversationMessage[], generation: number, title: string): Promise<void> {
    if (!accountId || !validDate(date)) throw new Error("INVALID_DAILY_CONVERSATION");
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("INVALID_CONVERSATION_GENERATION");
    const bounded = messages.length > 500 ? messages.slice(-500) : messages;
    const db = await open();
    try {
      await transactionResult(db, [DAILY_STORE], "readwrite", (tx, resolve) => {
        const store = tx.objectStore(DAILY_STORE);
        const id = dailyId(accountId, date);
        const request = store.get(id);
        request.onsuccess = () => {
          const current = request.result as SarahDailyConversation | undefined;
          if (!current || current.generation !== generation) return;
          store.put({ ...current, title, messages: bounded, updatedAt: new Date().toISOString() });
        };
        tx.oncomplete = () => resolve(undefined);
      });
    } finally { db.close(); }
  },
  async clearDaily(accountId: string, date: string, title: string): Promise<number> {
    if (!accountId || !validDate(date)) throw new Error("INVALID_DAILY_CONVERSATION");
    const db = await open();
    let nextGeneration = 0;
    try {
      await transactionResult(db, [DAILY_STORE], "readwrite", (tx, resolve) => {
        const store = tx.objectStore(DAILY_STORE);
        const id = dailyId(accountId, date);
        const request = store.get(id);
        request.onsuccess = () => {
          const current = request.result as SarahDailyConversation | undefined;
          nextGeneration = (current?.generation || 0) + 1;
          store.put({
            id, accountId, date, title,
            messages: [],
            updatedAt: new Date().toISOString(),
            generation: nextGeneration,
          } satisfies SarahDailyConversation);
        };
        tx.oncomplete = () => resolve(undefined);
      });
    } finally { db.close(); }
    ensureChannel();
    channel?.postMessage({ accountId, generation: nextGeneration, date });
    return nextGeneration;
  },
  async clear(accountId: string): Promise<number> {
    if (!accountId) throw new Error("ACCOUNT_REQUIRED");
    const db = await open();
    try {
      return await transactionResult(db, [STORE, META], "readwrite", (tx, resolve) => {
        const rows = tx.objectStore(STORE), meta = tx.objectStore(META);
        const request = meta.get(accountId);
        let nextGeneration = 0;
        request.onsuccess = () => {
          const current = Number.isSafeInteger(request.result?.generation) && request.result.generation >= 0 ? request.result.generation : 0;
          if (current >= Number.MAX_SAFE_INTEGER) { tx.abort(); return; }
          nextGeneration = current + 1;
          rows.delete(accountId);
          meta.put({ accountId, generation: nextGeneration, clearedAt: new Date().toISOString() });
        };
        tx.oncomplete = () => { ensureChannel(); channel?.postMessage({ accountId, generation: nextGeneration }); resolve(nextGeneration); };
      });
    } finally { db.close(); }
  },
};
