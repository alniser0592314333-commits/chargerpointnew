export interface BootstrapManifestV2 {
  schema_version: 2;
  captured_at: string;
  server_reset_generation: number;
  max_change_sequence: number;
  page_size: number;
  collections: string[];
}

export interface BootstrapStagingSession {
  key: 'active';
  sessionId: string;
  manifest: BootstrapManifestV2;
  cursors: Record<string, string | null>;
  completed: Record<string, boolean>;
  rowCounts: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

interface BootstrapStagingRow {
  key: string;
  sessionId: string;
  collection: string;
  rowId: string;
  item: unknown;
}

const DB_NAME = 'ChargingPointBootstrapStaging';
const DB_VERSION = 1;
let dbPromise: Promise<IDBDatabase | null> | null = null;
let memorySession: BootstrapStagingSession | null = null;
const memoryRows = new Map<string, BootstrapStagingRow>();

const createSessionId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {}
  return `bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const openStagingDb = async (): Promise<IDBDatabase | null> => {
  if (typeof indexedDB === 'undefined') return null;
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('rows')) db.createObjectStore('rows', { keyPath: 'key' });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
};

const cloneSession = (session: BootstrapStagingSession): BootstrapStagingSession =>
  JSON.parse(JSON.stringify(session)) as BootstrapStagingSession;

const compatibleManifest = (a: BootstrapManifestV2, b: BootstrapManifestV2): boolean =>
  a.schema_version === b.schema_version &&
  a.server_reset_generation === b.server_reset_generation &&
  a.page_size === b.page_size &&
  a.collections.length === b.collections.length &&
  a.collections.every((collection, index) => collection === b.collections[index]);

export const getActiveBootstrapStagingSession = async (): Promise<BootstrapStagingSession | null> => {
  const db = await openStagingDb();
  if (!db) return memorySession ? cloneSession(memorySession) : null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('meta', 'readonly');
      const request = tx.objectStore('meta').get('active');
      request.onsuccess = () => resolve(request.result ? request.result as BootstrapStagingSession : null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
};

export const beginOrResumeBootstrapStagingSession = async (
  manifest: BootstrapManifestV2
): Promise<{ session: BootstrapStagingSession; resumed: boolean }> => {
  const existing = await getActiveBootstrapStagingSession();
  const hasValidProgressState = Boolean(
    existing &&
    existing.cursors &&
    existing.completed &&
    existing.rowCounts &&
    manifest.collections.every((collection) =>
      Object.prototype.hasOwnProperty.call(existing.cursors, collection) &&
      typeof existing.completed[collection] === 'boolean' &&
      Number.isSafeInteger(existing.rowCounts[collection]) &&
      existing.rowCounts[collection] >= 0
    )
  );
  if (existing && hasValidProgressState && compatibleManifest(existing.manifest, manifest)) {
    return { session: existing, resumed: true };
  }

  if (existing) await clearBootstrapStagingSession(existing.sessionId);

  const cursors: Record<string, string | null> = {};
  const completed: Record<string, boolean> = {};
  const rowCounts: Record<string, number> = {};
  for (const collection of manifest.collections) {
    cursors[collection] = null;
    completed[collection] = false;
    rowCounts[collection] = 0;
  }
  const now = new Date().toISOString();
  const session: BootstrapStagingSession = {
    key: 'active',
    sessionId: createSessionId(),
    manifest,
    cursors,
    completed,
    rowCounts,
    createdAt: now,
    updatedAt: now,
  };

  const db = await openStagingDb();
  if (!db) {
    memorySession = cloneSession(session);
    return { session, resumed: false };
  }

  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(session);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('BOOTSTRAP_META_PERSIST_FAILED'));
      tx.onabort = () => reject(tx.error || new Error('BOOTSTRAP_META_ABORTED'));
    } catch (error) {
      reject(error);
    }
  });
  return { session, resumed: false };
};

export const persistBootstrapPage = async (args: {
  sessionId: string;
  collection: string;
  expectedCursor: string | null;
  rows: Array<{ rowId: string; item: unknown }>;
  nextCursor: string | null;
  hasMore: boolean;
}): Promise<{ committed: boolean; session: BootstrapStagingSession }> => {
  const db = await openStagingDb();
  if (!db) {
    if (!memorySession || memorySession.sessionId !== args.sessionId) {
      throw new Error('BOOTSTRAP_SESSION_SUPERSEDED');
    }
    const currentCursor = memorySession.cursors[args.collection] ?? null;
    if (currentCursor !== args.expectedCursor) {
      return { committed: false, session: cloneSession(memorySession) };
    }
    for (const row of args.rows) {
      const key = `${args.sessionId}:${args.collection}:${row.rowId}`;
      memoryRows.set(key, { key, sessionId: args.sessionId, collection: args.collection, rowId: row.rowId, item: row.item });
    }
    memorySession.cursors[args.collection] = args.nextCursor;
    memorySession.completed[args.collection] = !args.hasMore;
    memorySession.rowCounts[args.collection] = (memorySession.rowCounts[args.collection] || 0) + args.rows.length;
    memorySession.updatedAt = new Date().toISOString();
    return { committed: true, session: cloneSession(memorySession) };
  }

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(['rows', 'meta'], 'readwrite');
      const rowStore = tx.objectStore('rows');
      const metaStore = tx.objectStore('meta');
      const metaRequest = metaStore.get('active');
      let outcome: { committed: boolean; session: BootstrapStagingSession } | null = null;

      metaRequest.onsuccess = () => {
        const active = metaRequest.result as BootstrapStagingSession | undefined;
        if (!active || active.sessionId !== args.sessionId) {
          tx.abort();
          reject(new Error('BOOTSTRAP_SESSION_SUPERSEDED'));
          return;
        }
        const currentCursor = active.cursors[args.collection] ?? null;
        if (currentCursor !== args.expectedCursor) {
          outcome = { committed: false, session: active };
          return;
        }

        for (const row of args.rows) {
          const key = `${args.sessionId}:${args.collection}:${row.rowId}`;
          const record: BootstrapStagingRow = {
            key,
            sessionId: args.sessionId,
            collection: args.collection,
            rowId: row.rowId,
            item: row.item,
          };
          rowStore.put(record);
        }
        active.cursors[args.collection] = args.nextCursor;
        active.completed[args.collection] = !args.hasMore;
        active.rowCounts[args.collection] = (active.rowCounts[args.collection] || 0) + args.rows.length;
        active.updatedAt = new Date().toISOString();
        metaStore.put(active);
        outcome = { committed: true, session: active };
      };
      metaRequest.onerror = () => {
        tx.abort();
        reject(metaRequest.error || new Error('BOOTSTRAP_META_READ_FAILED'));
      };
      tx.oncomplete = () => {
        if (!outcome) {
          reject(new Error('BOOTSTRAP_PAGE_COMMIT_MISSING_RESULT'));
          return;
        }
        resolve({ committed: outcome.committed, session: cloneSession(outcome.session) });
      };
      tx.onerror = () => reject(tx.error || new Error('BOOTSTRAP_PAGE_PERSIST_FAILED'));
      tx.onabort = () => reject(tx.error || new Error('BOOTSTRAP_PAGE_ABORTED'));
    } catch (error) {
      reject(error);
    }
  });
};

export const readBootstrapStagedCollection = async (
  sessionId: string,
  collection: string
): Promise<any[]> => {
  const db = await openStagingDb();
  const prefix = `${sessionId}:${collection}:`;
  if (!db) {
    return Array.from(memoryRows.values())
      .filter((row) => row.sessionId === sessionId && row.collection === collection)
      .sort((a, b) => a.rowId.localeCompare(b.rowId))
      .map((row) => row.item);
  }

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('rows', 'readonly');
      const store = tx.objectStore('rows');
      const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
      const request = store.getAll(range);
      request.onsuccess = () => {
        const records = (request.result || []) as BootstrapStagingRow[];
        records.sort((a, b) => a.rowId.localeCompare(b.rowId));
        resolve(records.map((record) => record.item));
      };
      request.onerror = () => reject(request.error || new Error('BOOTSTRAP_STAGED_READ_FAILED'));
    } catch (error) {
      reject(error);
    }
  });
};

export const clearBootstrapStagingSession = async (sessionId: string): Promise<void> => {
  const db = await openStagingDb();
  if (!db) {
    const prefix = `${sessionId}:`;
    for (const key of memoryRows.keys()) if (key.startsWith(prefix)) memoryRows.delete(key);
    if (memorySession?.sessionId === sessionId) memorySession = null;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction(['rows', 'meta'], 'readwrite');
      const rowStore = tx.objectStore('rows');
      const range = IDBKeyRange.bound(`${sessionId}:`, `${sessionId}:\uffff`);
      rowStore.delete(range);
      const metaStore = tx.objectStore('meta');
      const request = metaStore.get('active');
      request.onsuccess = () => {
        const active = request.result as BootstrapStagingSession | undefined;
        if (active?.sessionId === sessionId) metaStore.delete('active');
      };
      request.onerror = () => {
        tx.abort();
        reject(request.error || new Error('BOOTSTRAP_META_READ_FAILED'));
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('BOOTSTRAP_STAGING_CLEAR_FAILED'));
      tx.onabort = () => reject(tx.error || new Error('BOOTSTRAP_STAGING_CLEAR_ABORTED'));
    } catch (error) {
      reject(error);
    }
  });
};

export const clearActiveBootstrapStagingSession = async (): Promise<void> => {
  const session = await getActiveBootstrapStagingSession();
  if (session) await clearBootstrapStagingSession(session.sessionId);
};
