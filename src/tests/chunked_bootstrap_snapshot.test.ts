import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearActiveBootstrapStagingSession } from '../infrastructure/sync/bootstrapStagingStore';
import * as supabaseClient from '../services/supabase/client';
import {
  BOOTSTRAP_COLLECTIONS,
  BOOTSTRAP_PAGE_SIZE,
  fetchAuthoritativeBootstrapSnapshot,
} from '../infrastructure/sync/bootstrapSnapshot';

describe('Chunked authoritative bootstrap protocol', () => {
  beforeEach(async () => { await clearActiveBootstrapStagingSession(); });
  afterEach(async () => { vi.restoreAllMocks(); await clearActiveBootstrapStagingSession(); });

  it('pins one manifest and fetches every allow-listed collection using bounded pages', async () => {
    const calls: Array<{ name: string; args: any }> = [];
    const customerRows = Array.from({ length: BOOTSTRAP_PAGE_SIZE + 1 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      name: `Customer ${index + 1}`,
    }));

    vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockImplementation(async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === 'begin_sync_bootstrap') {
        return {
          data: {
            schema_version: 2,
            captured_at: '2026-11-22T00:00:00.000Z',
            server_reset_generation: 9,
            max_change_sequence: 700,
            page_size: BOOTSTRAP_PAGE_SIZE,
            collections: [...BOOTSTRAP_COLLECTIONS],
          },
          error: null,
        } as any;
      }

      const collection = args.p_entity_type;
      const rows = collection === 'customers' ? customerRows : [];
      const cursor = args.p_after_id;
      const start = cursor ? rows.findIndex((row) => row.id === cursor) + 1 : 0;
      const pageRows = rows.slice(start, start + args.p_limit);
      const hasMore = start + pageRows.length < rows.length;
      return {
        data: {
          entity_type: collection,
          rows: pageRows,
          next_cursor: pageRows.length ? pageRows[pageRows.length - 1].id : null,
          has_more: hasMore,
        },
        error: null,
      } as any;
    });

    const snapshot = await fetchAuthoritativeBootstrapSnapshot();

    expect(snapshot.schema_version).toBe(2);
    expect(snapshot.server_reset_generation).toBe(9);
    expect(snapshot.max_change_sequence).toBe(700);
    expect((snapshot.customers as any[])).toHaveLength(BOOTSTRAP_PAGE_SIZE + 1);
    expect(calls.filter((call) => call.name === 'begin_sync_bootstrap')).toHaveLength(1);
    const pageCalls = calls.filter((call) => call.name === 'read_sync_bootstrap_page');
    expect(new Set(pageCalls.map((call) => call.args.p_entity_type))).toEqual(new Set(BOOTSTRAP_COLLECTIONS));
    expect(pageCalls.filter((call) => call.args.p_entity_type === 'customers')).toHaveLength(2);
    expect(calls.filter((call) => call.name === 'read_sync_bootstrap_page').every((call) => call.args.p_limit === BOOTSTRAP_PAGE_SIZE)).toBe(true);
    expect(calls.find((call) => call.name === 'read_sync_bootstrap_page' && call.args.p_entity_type === 'customers' && call.args.p_after_id !== null)?.args.p_after_id).toBe(customerRows[BOOTSTRAP_PAGE_SIZE - 1].id);
  });

  it('finishes an already-complete staged snapshot without requiring a live connection', async () => {
    const firstRpc = vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockImplementation(async (name: string, args: any) => {
      if (name === 'begin_sync_bootstrap') {
        return {
          data: {
            schema_version: 2,
            captured_at: '2026-11-22T00:00:00.000Z',
            server_reset_generation: 11,
            max_change_sequence: 1200,
            page_size: BOOTSTRAP_PAGE_SIZE,
            collections: [...BOOTSTRAP_COLLECTIONS],
          },
          error: null,
        } as any;
      }
      return {
        data: { entity_type: args.p_entity_type, rows: [], next_cursor: null, has_more: false },
        error: null,
      } as any;
    });

    const first = await fetchAuthoritativeBootstrapSnapshot();
    expect(first.max_change_sequence).toBe(1200);
    expect(firstRpc).toHaveBeenCalled();

    vi.restoreAllMocks();
    const offlineRpc = vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockResolvedValue({
      data: null,
      error: 'network offline',
    } as any);

    const resumed = await fetchAuthoritativeBootstrapSnapshot();
    expect(resumed.max_change_sequence).toBe(1200);
    expect(offlineRpc).not.toHaveBeenCalled();
  });

  it('resumes from the last durably committed page and retains the original high-water mark', async () => {
    let attempt = 1;
    let firstPageCalls = 0;
    let interruptedPageCalls = 0;
    let resumedPageCalls = 0;
    const rows = Array.from({ length: BOOTSTRAP_PAGE_SIZE + 1 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      name: `Day ${index + 1}`,
    }));

    vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockImplementation(async (name: string, args: any) => {
      if (name === 'begin_sync_bootstrap') {
        return {
          data: {
            schema_version: 2,
            captured_at: `2026-11-22T00:00:0${attempt}.000Z`,
            server_reset_generation: 9,
            max_change_sequence: attempt === 1 ? 700 : 900,
            page_size: BOOTSTRAP_PAGE_SIZE,
            collections: [...BOOTSTRAP_COLLECTIONS],
          },
          error: null,
        } as any;
      }

      const collection = args.p_entity_type;
      if (collection !== 'business_days') {
        return {
          data: { entity_type: collection, rows: [], next_cursor: null, has_more: false },
          error: null,
        } as any;
      }

      if (args.p_after_id === null) {
        firstPageCalls += 1;
        return {
          data: {
            entity_type: collection,
            rows: rows.slice(0, BOOTSTRAP_PAGE_SIZE),
            next_cursor: rows[BOOTSTRAP_PAGE_SIZE - 1].id,
            has_more: true,
          },
          error: null,
        } as any;
      }

      if (attempt === 1) {
        interruptedPageCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { data: null, error: 'simulated interruption' } as any;
      }

      resumedPageCalls += 1;
      return {
        data: {
          entity_type: collection,
          rows: rows.slice(BOOTSTRAP_PAGE_SIZE),
          next_cursor: rows[BOOTSTRAP_PAGE_SIZE].id,
          has_more: false,
        },
        error: null,
      } as any;
    });

    await expect(fetchAuthoritativeBootstrapSnapshot()).rejects.toThrow(/simulated interruption/);
    attempt = 2;

    const resumed = await fetchAuthoritativeBootstrapSnapshot();
    expect(resumed.max_change_sequence).toBe(700);
    expect(resumed.server_reset_generation).toBe(9);
    expect((resumed.business_days as any[])).toHaveLength(BOOTSTRAP_PAGE_SIZE + 1);
    expect(firstPageCalls).toBe(1);
    expect(interruptedPageCalls).toBe(1);
    expect(resumedPageCalls).toBe(1);
  });

  it('rejects a manifest that omits or reorders a required collection', async () => {
    vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockResolvedValue({
      data: {
        schema_version: 2,
        captured_at: '2026-11-22T00:00:00.000Z',
        server_reset_generation: 1,
        max_change_sequence: 0,
        page_size: BOOTSTRAP_PAGE_SIZE,
        collections: [...BOOTSTRAP_COLLECTIONS].reverse(),
      },
      error: null,
    } as any);

    await expect(fetchAuthoritativeBootstrapSnapshot()).rejects.toThrow(/BOOTSTRAP_MANIFEST_INVALID/);
  });

  it('rejects a malformed or non-advancing page instead of accepting a partial snapshot', async () => {
    vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockImplementation(async (name: string) => {
      if (name === 'begin_sync_bootstrap') {
        return {
          data: { schema_version: 2, captured_at: '2026-11-22T00:00:00.000Z', server_reset_generation: 1, max_change_sequence: 0, page_size: BOOTSTRAP_PAGE_SIZE, collections: [...BOOTSTRAP_COLLECTIONS] },
          error: null,
        } as any;
      }
      return {
        data: { entity_type: 'business_days', rows: [{ id: 'day-1' }], next_cursor: 'day-1', has_more: true },
        error: null,
      } as any;
    });

    await expect(fetchAuthoritativeBootstrapSnapshot()).rejects.toThrow(/BOOTSTRAP_PAGE_TRUNCATED/);
  });

  it('retries transient manifest failures with a bounded retry count', async () => {
    let manifestAttempts = 0;
    vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockImplementation(async (name: string, args: any) => {
      if (name === 'begin_sync_bootstrap') {
        manifestAttempts += 1;
        if (manifestAttempts === 1) return { data: null, error: 'HTTP 500 statement timeout' } as any;
        return {
          data: { schema_version: 2, captured_at: '2026-11-22T00:00:00.000Z', server_reset_generation: 2, max_change_sequence: 4, page_size: BOOTSTRAP_PAGE_SIZE, collections: [...BOOTSTRAP_COLLECTIONS] },
          error: null,
        } as any;
      }
      return {
        data: { entity_type: args.p_entity_type, rows: [], next_cursor: null, has_more: false },
        error: null,
      } as any;
    });

    const snapshot = await fetchAuthoritativeBootstrapSnapshot();
    expect(snapshot.max_change_sequence).toBe(4);
    expect(manifestAttempts).toBe(2);
  });
});
