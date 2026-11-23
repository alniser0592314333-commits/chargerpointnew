import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/supabase/client', () => ({
  invokeSupabaseRpc: vi.fn(),
}));

import { invokeSupabaseRpc } from '../services/supabase/client';
import {
  BOOTSTRAP_COLLECTIONS,
  fetchAuthoritativeBootstrapSnapshot,
} from '../infrastructure/sync/bootstrapSnapshot';
import { clearActiveBootstrapStagingSession } from '../infrastructure/sync/bootstrapStagingStore';

describe('streamed authoritative bootstrap snapshot', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', undefined);
    vi.mocked(invokeSupabaseRpc).mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'begin_sync_bootstrap') {
        return {
          data: {
            schema_version: 2,
            admin_id: 'admin-stream-test',
            captured_at: '2026-11-23T00:00:00.000Z',
            server_reset_generation: 7,
            max_change_sequence: 1200,
            page_size: 500,
            collections: [...BOOTSTRAP_COLLECTIONS],
          },
          error: null,
        } as any;
      }
      if (name === 'read_sync_bootstrap_page') {
        return {
          data: {
            entity_type: args.p_entity_type,
            rows: [],
            has_more: false,
            next_cursor: null,
          },
          error: null,
        } as any;
      }
      throw new Error(`Unexpected bootstrap RPC: ${name}`);
    });
  });

  afterEach(async () => {
    await clearActiveBootstrapStagingSession();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('validates staged row counts without materializing all collection arrays', async () => {
    const snapshot = await fetchAuthoritativeBootstrapSnapshot(
      undefined,
      'admin-stream-test',
      { materializeCollections: false },
    );

    expect(snapshot.bootstrap_row_counts).toBeDefined();
    expect(Object.keys(snapshot.bootstrap_row_counts || {})).toHaveLength(BOOTSTRAP_COLLECTIONS.length);
    expect(snapshot.bootstrap_row_counts?.orders).toBe(0);
    expect(snapshot.bootstrap_session_id).toBeTruthy();
    expect(snapshot.orders).toBeUndefined();
    expect(snapshot.financial_ledger).toBeUndefined();
  });

  it('keeps the default materialized snapshot contract available to legacy callers', async () => {
    const snapshot = await fetchAuthoritativeBootstrapSnapshot(undefined, 'admin-stream-test');

    expect(snapshot.orders).toEqual([]);
    expect(snapshot.customers).toEqual([]);
    expect(snapshot.purchase_orders).toEqual([]);
  });
});
