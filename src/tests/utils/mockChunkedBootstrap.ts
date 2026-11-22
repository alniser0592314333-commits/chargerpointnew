import { vi } from 'vitest';
import * as supabaseClient from '../../services/supabase/client';
import { BOOTSTRAP_COLLECTIONS, BOOTSTRAP_PAGE_SIZE } from '../../infrastructure/sync/bootstrapSnapshot';

export const mockChunkedBootstrapRpc = (
  collections: Record<string, any[]> = {},
  manifest: Record<string, unknown> = {}
) => vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockImplementation(async (name: string, args: any) => {
  if (name === 'begin_sync_bootstrap') {
    return {
      data: {
        schema_version: 2,
        admin_id: 'admin_test_session',
        captured_at: '2026-11-22T00:00:00.000Z',
        server_reset_generation: 7,
        max_change_sequence: 42,
        page_size: BOOTSTRAP_PAGE_SIZE,
        collections: [...BOOTSTRAP_COLLECTIONS],
        ...manifest,
      },
      error: null,
    } as any;
  }

  if (name === 'read_sync_bootstrap_page') {
    const collection = String(args?.p_entity_type || '');
    const keyName = collection === 'system_settings' ? 'key' : 'id';
    const allRows = [...(collections[collection] || [])].sort((a, b) =>
      String(a[keyName]).localeCompare(String(b[keyName]))
    );
    const cursor = args?.p_after_id == null ? null : String(args.p_after_id);
    const start = cursor === null ? 0 : allRows.findIndex((row) => String(row[keyName]) === cursor) + 1;
    const limit = Number(args?.p_limit || 250);
    const pageRows = allRows.slice(Math.max(0, start), Math.max(0, start) + limit);
    const hasMore = Math.max(0, start) + pageRows.length < allRows.length;
    return {
      data: {
        entity_type: collection,
        rows: pageRows,
        next_cursor: pageRows.length ? String(pageRows[pageRows.length - 1][keyName]) : null,
        has_more: hasMore,
      },
      error: null,
    } as any;
  }

  return { data: null, error: `Unexpected RPC in bootstrap test: ${name}` } as any;
});
