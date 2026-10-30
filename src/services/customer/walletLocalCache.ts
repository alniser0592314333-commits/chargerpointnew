import { customerAuth } from './customerAuth';

export type CachedWalletSnapshot<T> = { snapshot: T; savedAt: number };
export type PendingWalletTransaction = {
  queueId: string;
  ownerId: string;
  queuedAt: number;
  transactionType: 'INCOME' | 'EXPENSE' | 'TRANSFER';
  sourceWalletId: string | null;
  destinationWalletId: string | null;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  reference: string | null;
  note: string | null;
  status: 'pending' | 'blocked';
  lastError?: string;
};

const DB_NAME = 'chargerpoint-customer-wallet';
const STORE_NAME = 'snapshots';
const DB_VERSION = 1;

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function currentUserId(): Promise<string | null> {
  try {
    const { data } = await customerAuth.auth.getSession();
    return data.session?.user?.id ?? null;
  } catch {
    return null;
  }
}

async function withStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDatabase();
  if (!db) return null;
  try {
    return await new Promise<T | null>((resolve) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = operation(tx.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    });
  } finally {
    db.close();
  }
}

export async function saveWalletSnapshot<T>(snapshot: T): Promise<void> {
  const userId = await currentUserId();
  if (!userId) return;
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ snapshot, savedAt: Date.now() } satisfies CachedWalletSnapshot<T>, 'wallet-snapshot:' + userId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  db.close();
}

export async function readWalletSnapshot<T>(): Promise<CachedWalletSnapshot<T> | null> {
  const userId = await currentUserId();
  if (!userId) return null;
  return await withStore<CachedWalletSnapshot<T>>('readonly', store => store.get('wallet-snapshot:' + userId));
}

export async function enqueueWalletTransaction(input: Omit<PendingWalletTransaction, 'queueId' | 'ownerId' | 'queuedAt' | 'status'>): Promise<boolean> {
  const userId = await currentUserId();
  if (!userId) return false;
  const db = await openDatabase();
  if (!db) return false;
  const item: PendingWalletTransaction = { ...input, queueId: input.idempotencyKey, ownerId: userId, queuedAt: Date.now(), status: 'pending' };
  const ok = await new Promise<boolean>((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(item, 'wallet-queue:' + userId + ':' + item.queueId);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
  db.close();
  return ok;
}

export async function listPendingWalletTransactions(): Promise<PendingWalletTransaction[]> {
  const userId = await currentUserId();
  if (!userId) return [];
  const db = await openDatabase();
  if (!db) return [];
  const items = await new Promise<PendingWalletTransaction[]>((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).openCursor();
    const found: PendingWalletTransaction[] = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(found.sort((a, b) => a.queuedAt - b.queuedAt)); return; }
      const key = String(cursor.key);
      const value = cursor.value as Partial<PendingWalletTransaction>;
      if (key.startsWith('wallet-queue:' + userId + ':') && value.ownerId === userId && typeof value.idempotencyKey === 'string') found.push(value as PendingWalletTransaction);
      cursor.continue();
    };
    request.onerror = () => resolve([]);
    tx.onabort = () => resolve([]);
  });
  db.close();
  return items;
}

export async function removePendingWalletTransaction(item: PendingWalletTransaction): Promise<void> {
  if (item.ownerId !== await currentUserId()) return;
  await withStore<undefined>('readwrite', store => store.delete('wallet-queue:' + item.ownerId + ':' + item.queueId));
}

export async function blockPendingWalletTransaction(item: PendingWalletTransaction, error: string): Promise<void> {
  if (item.ownerId !== await currentUserId()) return;
  const updated = { ...item, status: 'blocked' as const, lastError: error };
  await withStore<IDBValidKey>('readwrite', store => store.put(updated, 'wallet-queue:' + item.ownerId + ':' + item.queueId));
}
