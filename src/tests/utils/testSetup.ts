import { localDb } from '../../infrastructure/localDb/localDb';
import { CURRENT_MIGRATION_VERSION } from '../../components/pages/dayOrdersStore';
import { saveStoredSupabaseAuthSession, setSupabaseAuthToken } from '../../services/supabase/client';

function ensureTestLocalStorage(): Storage {
  if (typeof globalThis.localStorage !== 'undefined') return globalThis.localStorage;

  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.has(String(key)) ? values.get(String(key))! : null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => { values.delete(String(key)); },
    setItem: (key: string, value: string) => { values.set(String(key), String(value)); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  return storage;
}

/** Provide a real storage surface for Node-based Vitest runs and an authenticated app-session fixture. */
export function setTestAppAuthSession() {
  const storage = ensureTestLocalStorage();
  const testAccessToken = 'test-only-access-token';
  storage.setItem('sys_db_version', CURRENT_MIGRATION_VERSION);
  storage.setItem('app_auth_session', JSON.stringify({
    userId: 'admin_test_session',
    role: 'ADMIN',
    permissions: [
      'customers:create', 'customers:edit', 'customers:view',
      'orders:create', 'orders:edit', 'orders:deliver', 'orders:cancel', 'orders:view',
      'devices:manage', 'devices:view', 'settings:manage',
      'finance:view', 'finance:create-payment', 'goals:manage',
    ],
  }));
  // The app authorization cache is not a Supabase bearer session. Tests that
  // exercise authenticated RPC paths must explicitly seed both layers.
  saveStoredSupabaseAuthSession({ access_token: testAccessToken, user: { id: 'admin_test_session' } });
  setSupabaseAuthToken(testAccessToken);
}

export async function initializeCanonicalSyncState() {
  ensureTestLocalStorage().setItem('sys_db_version', CURRENT_MIGRATION_VERSION);
  await localDb.setSyncState({
    table: 'global',
    lastAppliedChangeSequence: 0,
    lastPulledAt: '',
    resetGeneration: 1,
    status: 'READY',
  });
}
