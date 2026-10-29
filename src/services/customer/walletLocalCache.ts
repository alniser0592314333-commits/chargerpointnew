import { customerAuth } from './customerAuth';

export type CachedWalletSnapshot<T> = { snapshot: T; savedAt: number };

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

async function currentUserKey(): Promise<string | null> {
  try {
    const { data } = await customerAuth.auth.getSession();
    const userId = data.session?.user?.id;
    return userId ? 'wallet-snapshot:' + userId : null;
  } catch {
    return null;
  }
}

export async function saveWalletSnapshot<T>(snapshot: T): Promise<void> {
  const key = await currentUserKey();
  if (!key) return;
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ snapshot, savedAt: Date.now() } satisfies CachedWalletSnapshot<T>, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  db.close();
}

export async function readWalletSnapshot<T>(): Promise<CachedWalletSnapshot<T> | null> {
  const key = await currentUserKey();
  if (!key) return null;
  const db = await openDatabase();
  if (!db) return null;
  const result = await new Promise<CachedWalletSnapshot<T> | null>((resolve) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => resolve(null);
  });
  db.close();
  return result;
}
