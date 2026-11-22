import { invokeSupabaseRpc } from '../../services/supabase/client';

export const BOOTSTRAP_PAGE_SIZE = 500;

export const BOOTSTRAP_COLLECTIONS = [
  'business_days',
  'customers',
  'device_types',
  'orders',
  'order_items',
  'financial_ledger',
  'payments',
  'payment_allocations',
  'order_number_reservations',
  'qr_tokens',
  'goals',
  'goal_requests',
  'system_settings',
  'purchase_suppliers',
  'purchase_items',
  'purchase_payment_methods',
  'purchase_months',
  'purchase_weeks',
  'purchase_days',
  'purchase_orders',
] as const;

export type BootstrapCollection = typeof BOOTSTRAP_COLLECTIONS[number];

export interface AuthoritativeBootstrapSnapshot {
  schema_version: 2;
  captured_at: string;
  server_reset_generation: number;
  max_change_sequence: number;
  [collection: string]: unknown;
}

type BootstrapProgress = (collection: BootstrapCollection, completedRows: number, completedCollections: number) => void;

const unwrapRpc = (value: any): any => Array.isArray(value) ? value[0] : value;

const isRetryableReadError = (error: string): boolean =>
  /timeout|network|fetch|\b500\b|\b502\b|\b503\b|\b504\b|57014|ECONNRESET|temporar/i.test(error);

const callBootstrapRpc = async (name: string, args: Record<string, unknown>): Promise<any> => {
  let lastError = 'UNKNOWN_BOOTSTRAP_RPC_ERROR';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await invokeSupabaseRpc<any>(name, args);
    if (!error) return unwrapRpc(data);
    lastError = String(error);
    if (attempt === 2 || !isRetryableReadError(lastError)) break;
    await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
  }
  throw new Error(`BOOTSTRAP_RPC_FAILED[${name}]: ${lastError}`);
};

/**
 * Builds the legacy snapshot shape from bounded, keyset-paginated RPC pages.
 *
 * The manifest fixes the reset generation and change-log high-water mark first.
 * Pages may observe newer row images while concurrent writes continue; those
 * writes are reconciled by the canonical change-log pull starting at the
 * manifest high-water mark after the snapshot has been installed.
 */
export const fetchAuthoritativeBootstrapSnapshot = async (
  onProgress?: BootstrapProgress
): Promise<AuthoritativeBootstrapSnapshot> => {
  const manifest = await callBootstrapRpc('begin_sync_bootstrap', {});
  const generation = Number(manifest?.server_reset_generation);
  const sequence = Number(manifest?.max_change_sequence);

  if (
    Number(manifest?.schema_version) !== 2 ||
    Number(manifest?.page_size) !== BOOTSTRAP_PAGE_SIZE ||
    !Array.isArray(manifest?.collections) ||
    manifest.collections.length !== BOOTSTRAP_COLLECTIONS.length ||
    !BOOTSTRAP_COLLECTIONS.every((collection, index) => manifest.collections[index] === collection) ||
    !Number.isSafeInteger(generation) || generation < 0 ||
    !Number.isSafeInteger(sequence) || sequence < 0 ||
    typeof manifest?.captured_at !== 'string'
  ) {
    throw new Error('BOOTSTRAP_MANIFEST_INVALID: missing protocol version or authoritative checkpoint');
  }

  const snapshot: Record<string, unknown> = {
    schema_version: 2,
    captured_at: manifest.captured_at,
    server_reset_generation: generation,
    max_change_sequence: sequence,
  };

  let completedRows = 0;
  let completedCollections = 0;
  const concurrency = 4;

  const fetchCollection = async (collection: BootstrapCollection): Promise<void> => {
    const rows: any[] = [];
    let cursor: string | null = null;
    let pageCount = 0;

    while (true) {
      pageCount += 1;
      if (pageCount > 100000) {
        throw new Error(`BOOTSTRAP_PAGE_LIMIT_EXCEEDED[${collection}]`);
      }

      const page = await callBootstrapRpc('read_sync_bootstrap_page', {
        p_entity_type: collection,
        p_after_id: cursor,
        p_limit: BOOTSTRAP_PAGE_SIZE,
      });

      if (
        !page ||
        page.entity_type !== collection ||
        !Array.isArray(page.rows) ||
        typeof page.has_more !== 'boolean'
      ) {
        throw new Error(`BOOTSTRAP_PAGE_INVALID[${collection}]: malformed page response`);
      }
      if (page.rows.length > BOOTSTRAP_PAGE_SIZE) {
        throw new Error(`BOOTSTRAP_PAGE_OVERSIZED[${collection}]: server exceeded the page limit`);
      }

      const keyName = collection === 'system_settings' ? 'key' : 'id';
      const pageKeys = new Set<string>();
      for (const row of page.rows) {
        const key = row?.[keyName];
        if (typeof key !== 'string' || !key) {
          throw new Error(`BOOTSTRAP_ROW_KEY_INVALID[${collection}]: row has no ${keyName}`);
        }
        if (pageKeys.has(key)) {
          throw new Error(`BOOTSTRAP_DUPLICATE_ROW[${collection}]: duplicate key within page`);
        }
        pageKeys.add(key);
      }

      if (page.rows.length > 0) {
        const lastKey = String(page.rows[page.rows.length - 1][keyName]);
        if (typeof page.next_cursor !== 'string' || page.next_cursor !== lastKey || page.next_cursor === cursor) {
          throw new Error(`BOOTSTRAP_CURSOR_INVALID[${collection}]: cursor does not match the last row`);
        }
        rows.push(...page.rows);
        completedRows += page.rows.length;
        cursor = page.next_cursor;
      } else if (page.next_cursor !== null && page.next_cursor !== undefined) {
        throw new Error(`BOOTSTRAP_CURSOR_INVALID[${collection}]: empty page advanced a cursor`);
      }

      onProgress?.(collection, completedRows, completedCollections);
      if (!page.has_more) break;
      if (page.rows.length !== BOOTSTRAP_PAGE_SIZE || !cursor) {
        throw new Error(`BOOTSTRAP_PAGE_TRUNCATED[${collection}]: server reported more rows without a full advancing page`);
      }
    }

    snapshot[collection] = rows;
    completedCollections += 1;
    onProgress?.(collection, completedRows, completedCollections);
  };

  // Bound concurrency across independent tables while keeping each table's
  // keyset pages sequential. This avoids both a request storm and hundreds of
  // serialized round trips on a fresh install.
  for (let offset = 0; offset < BOOTSTRAP_COLLECTIONS.length; offset += concurrency) {
    const batch = BOOTSTRAP_COLLECTIONS.slice(offset, offset + concurrency);
    await Promise.all(batch.map((collection) => fetchCollection(collection)));
  }

  return snapshot as AuthoritativeBootstrapSnapshot;
};
