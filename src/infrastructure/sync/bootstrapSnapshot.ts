import { invokeSupabaseRpc } from '../../services/supabase/client';
import {
  beginOrResumeBootstrapStagingSession,
  getActiveBootstrapStagingSession,
  persistBootstrapPage,
  readBootstrapStagedCollection,
  countBootstrapStagedCollection,
  BootstrapManifestV2,
} from './bootstrapStagingStore';

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
  bootstrap_session_id: string;
  bootstrap_row_counts?: Record<string, number>;
  [collection: string]: unknown;
}

type BootstrapProgress = (collection: BootstrapCollection, completedRows: number, completedCollections: number) => void;

const unwrapRpc = (value: any): any => Array.isArray(value) ? value[0] : value;

const describeBootstrapError = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    const details = [value.message, value.code, value.details, value.hint]
      .filter((part) => typeof part === 'string' && part.length > 0)
      .join(' ');
    return details || JSON.stringify(value);
  }
  return String(error);
};

const isRetryableReadError = (error: string): boolean =>
  /timeout|network|fetch|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|57014|53300|57P01|ECONNRESET|temporar|connection/i.test(error);

const callBootstrapRpc = async (name: string, args: Record<string, unknown>): Promise<any> => {
  let lastError = 'UNKNOWN_BOOTSTRAP_RPC_ERROR';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await invokeSupabaseRpc<any>(name, args);
    if (!error) return unwrapRpc(data);
    lastError = describeBootstrapError(error);
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
  onProgress?: BootstrapProgress,
  expectedAdminId?: string,
  options: { materializeCollections?: boolean } = {}
): Promise<AuthoritativeBootstrapSnapshot> => {
  const isValidManifest = (candidate: any): candidate is BootstrapManifestV2 => {
    const generation = Number(candidate?.server_reset_generation);
    const sequence = Number(candidate?.max_change_sequence);
    return (
      Number(candidate?.schema_version) === 2 &&
      typeof candidate?.admin_id === 'string' && candidate.admin_id.length > 0 &&
      Number(candidate?.page_size) === BOOTSTRAP_PAGE_SIZE &&
      Array.isArray(candidate?.collections) &&
      candidate.collections.length === BOOTSTRAP_COLLECTIONS.length &&
      BOOTSTRAP_COLLECTIONS.every((collection, index) => candidate.collections[index] === collection) &&
      Number.isSafeInteger(generation) && generation >= 0 &&
      Number.isSafeInteger(sequence) && sequence >= 0 &&
      typeof candidate?.captured_at === 'string'
    );
  };

  const existingSession = await getActiveBootstrapStagingSession();
  const existingSessionComplete = Boolean(
    existingSession &&
    isValidManifest(existingSession.manifest) &&
    Boolean(expectedAdminId && existingSession.manifest.admin_id === expectedAdminId) &&
    existingSession.rowCounts &&
    BOOTSTRAP_COLLECTIONS.every((collection) =>
      existingSession.completed[collection] === true &&
      Number.isSafeInteger(existingSession.rowCounts[collection]) &&
      existingSession.rowCounts[collection] >= 0
    )
  );

  let session: Awaited<ReturnType<typeof beginOrResumeBootstrapStagingSession>>['session'];
  if (existingSessionComplete && existingSession) {
    // A fully staged snapshot can be installed even while offline. Its pinned
    // generation/cursor will be reconciled on the first successful online pull.
    session = existingSession;
  } else {
    const manifest = await callBootstrapRpc('begin_sync_bootstrap', {});
    if (!isValidManifest(manifest)) {
      throw new Error('BOOTSTRAP_MANIFEST_INVALID: missing protocol version or authoritative checkpoint');
    }
    if (expectedAdminId && manifest.admin_id !== expectedAdminId) {
      throw new Error('BOOTSTRAP_TENANT_MISMATCH: server manifest does not belong to the active admin');
    }
    const started = await beginOrResumeBootstrapStagingSession(manifest);
    session = started.session;
  }
  const pinnedManifest = session.manifest;

  const snapshot: Record<string, unknown> = {
    schema_version: 2,
    captured_at: pinnedManifest.captured_at,
    server_reset_generation: pinnedManifest.server_reset_generation,
    max_change_sequence: pinnedManifest.max_change_sequence,
    bootstrap_session_id: session.sessionId,
  };

  let completedRows = 0;
  let completedCollections = 0;
  const concurrency = 4;

  const fetchCollection = async (collection: BootstrapCollection): Promise<void> => {
    let cursor: string | null = session.cursors[collection] ?? null;
    let isComplete = session.completed[collection] === true;
    let pageCount = 0;

    while (!isComplete) {
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
      const stagedRows: Array<{ rowId: string; item: unknown }> = [];
      for (const row of page.rows) {
        const key = row?.[keyName];
        if (typeof key !== 'string' || !key) {
          throw new Error(`BOOTSTRAP_ROW_KEY_INVALID[${collection}]: row has no ${keyName}`);
        }
        if (pageKeys.has(key)) {
          throw new Error(`BOOTSTRAP_DUPLICATE_ROW[${collection}]: duplicate key within page`);
        }
        if (collection !== 'system_settings' && cursor !== null && key <= cursor) {
          throw new Error(`BOOTSTRAP_PAGE_ORDER_INVALID[${collection}]: key did not advance past cursor`);
        }
        pageKeys.add(key);
        stagedRows.push({ rowId: key, item: row });
      }

      let nextCursor: string | null = null;
      if (page.rows.length > 0) {
        const lastKey = String(page.rows[page.rows.length - 1][keyName]);
        if (typeof page.next_cursor !== 'string' || page.next_cursor !== lastKey || page.next_cursor === cursor) {
          throw new Error(`BOOTSTRAP_CURSOR_INVALID[${collection}]: cursor does not match the last row`);
        }
        nextCursor = page.next_cursor;
      } else if (page.next_cursor !== null && page.next_cursor !== undefined) {
        throw new Error(`BOOTSTRAP_CURSOR_INVALID[${collection}]: empty page advanced a cursor`);
      }

      if (page.has_more && (page.rows.length !== BOOTSTRAP_PAGE_SIZE || !nextCursor)) {
        throw new Error(`BOOTSTRAP_PAGE_TRUNCATED[${collection}]: server reported more rows without a full advancing page`);
      }

      const persisted = await persistBootstrapPage({
        sessionId: session.sessionId,
        collection,
        expectedCursor: cursor,
        rows: stagedRows,
        nextCursor,
        hasMore: page.has_more,
      });

      if (!persisted.committed) {
        cursor = persisted.session.cursors[collection] ?? null;
        isComplete = persisted.session.completed[collection] === true;
        continue;
      }

      completedRows += page.rows.length;
      cursor = nextCursor;
      isComplete = !page.has_more;
      onProgress?.(collection, completedRows, completedCollections);
    }

    completedCollections += 1;
    onProgress?.(collection, completedRows, completedCollections);
  };

  // Pages are committed to a separate IndexedDB staging database together
  // with their cursor. A closed tab can resume without re-downloading pages.
  // Independent collections run with bounded concurrency; pages within one
  // collection remain sequential and cursor-serialized across tabs.
  for (let offset = 0; offset < BOOTSTRAP_COLLECTIONS.length; offset += concurrency) {
    const batch = BOOTSTRAP_COLLECTIONS.slice(offset, offset + concurrency);
    await Promise.all(batch.map((collection) => fetchCollection(collection)));
  }

  const finalSession = await getActiveBootstrapStagingSession();
  if (!finalSession || finalSession.sessionId !== session.sessionId) {
    throw new Error('BOOTSTRAP_SESSION_SUPERSEDED: staging session changed before final validation');
  }

  const rowCounts: Record<string, number> = {};
  for (const collection of BOOTSTRAP_COLLECTIONS) {
    if (finalSession.completed[collection] !== true) {
      throw new Error(`BOOTSTRAP_COLLECTION_INCOMPLETE[${collection}]`);
    }
    const expectedCount = finalSession.rowCounts[collection] ?? 0;
    const actualCount = await countBootstrapStagedCollection(session.sessionId, collection);
    if (actualCount !== expectedCount) {
      throw new Error(`BOOTSTRAP_STAGING_COUNT_MISMATCH[${collection}]: expected ${expectedCount}, received ${actualCount}`);
    }
    rowCounts[collection] = expectedCount;
    if (options.materializeCollections !== false) {
      const rows = await readBootstrapStagedCollection(session.sessionId, collection);
      if (rows.length !== expectedCount) {
        throw new Error(`BOOTSTRAP_STAGING_READ_MISMATCH[${collection}]: expected ${expectedCount}, received ${rows.length}`);
      }
      snapshot[collection] = rows;
    }
  }
  snapshot.bootstrap_row_counts = rowCounts;

  return snapshot as AuthoritativeBootstrapSnapshot;
};
