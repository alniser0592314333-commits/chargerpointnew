/**
 * Delta Pull Batch Size Canonical Verification Test Suite
 * Verifies that the canonical Delta Pull batch size is exactly 500.
 * Invariants tested:
 * 1. SYNC_PULL_BATCH_SIZE constant exported from SupabaseSyncTransport is 500.
 * 2. Default pullChanges(cursor) query parameters contain limit=500, sequence_id=gt.${cursor}, and order=sequence_id.asc.
 * 3. Upper-bound clamp: requests exceeding 500 are clamped to SYNC_PULL_BATCH_SIZE (500).
 * 4. Lower-bound clamp: requests with limit < 1 are clamped to 1.
 * 5. MockServerSyncTransport supports bounded pagination up to 500 items per pull.
 * 6. Sequential multi-page pagination consumes large delta feeds in 500-item bounded batches.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SupabaseSyncTransport,
  SYNC_PULL_BATCH_SIZE,
} from '../infrastructure/sync/SupabaseSyncTransport';
import {
  SyncEngine,
  MockServerSyncTransport,
} from '../infrastructure/sync/syncEngine';
import * as supabaseClientModule from '../services/supabase/client';
import { localDb } from '../infrastructure/localDb/localDb';

describe('Canonical Delta Pull Batch Size (500)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await localDb.clear();
  });

  it('1. Exported constant SYNC_PULL_BATCH_SIZE is exactly 500', () => {
    expect(SYNC_PULL_BATCH_SIZE).toBe(500);
  });

  it('2. pullChanges() defaults to limit=500 in the canonical RPC request', async () => {
    const transport = new SupabaseSyncTransport();
    let capturedFunction = '';
    let capturedArgs: Record<string, unknown> = {};

    vi.spyOn(supabaseClientModule, 'invokeSupabaseRpc').mockImplementation(
      async (functionName: string, args?: any) => {
        capturedFunction = functionName;
        capturedArgs = args || {};
        return { data: { changes: [], serverResetGeneration: 1 }, error: null } as any;
      }
    );

    const cursor = 125;
    const res = await transport.pullChanges(cursor);

    expect(capturedFunction).toBe('pull_canonical_changes');
    expect(capturedArgs.p_since_sequence).toBe(125);
    expect(capturedArgs.p_limit).toBe(500);
    expect(res.latestSequence).toBe(125);
    expect(res.serverResetGeneration).toBe(1);
  });

  it('3. Explicit limit > 500 is clamped to 500', async () => {
    const transport = new SupabaseSyncTransport();
    let capturedArgs: Record<string, unknown> = {};

    vi.spyOn(supabaseClientModule, 'invokeSupabaseRpc').mockImplementation(
      async (_functionName: string, args?: any) => {
        capturedArgs = args || {};
        return { data: { changes: [], serverResetGeneration: 1 }, error: null } as any;
      }
    );

    await transport.pullChanges(0, 1000);
    expect(capturedArgs.p_limit).toBe(500);
  });

  it('4. Explicit limit between 1 and 500 is respected', async () => {
    const transport = new SupabaseSyncTransport();
    let capturedArgs: Record<string, unknown> = {};

    vi.spyOn(supabaseClientModule, 'invokeSupabaseRpc').mockImplementation(
      async (_functionName: string, args?: any) => {
        capturedArgs = args || {};
        return { data: { changes: [], serverResetGeneration: 1 }, error: null } as any;
      }
    );

    await transport.pullChanges(0, 250);
    expect(capturedArgs.p_limit).toBe(250);
  });

  it('5. Explicit limit < 1 is clamped to minimum 1', async () => {
    const transport = new SupabaseSyncTransport();
    let capturedArgs: Record<string, unknown> = {};

    vi.spyOn(supabaseClientModule, 'invokeSupabaseRpc').mockImplementation(
      async (_functionName: string, args?: any) => {
        capturedArgs = args || {};
        return { data: { changes: [], serverResetGeneration: 1 }, error: null } as any;
      }
    );

    await transport.pullChanges(0, 0);
    expect(capturedArgs.p_limit).toBe(1);
  });

  it('6. MockServerSyncTransport enforces maximum 500 batch limit', async () => {
    const mockTransport = new MockServerSyncTransport();

    // Populate mock transport with 650 change entries
    for (let i = 1; i <= 650; i++) {
      await mockTransport.pushCommand({
        commandId: `cmd-${i}`,
        commandType: 'CREATE_CUSTOMER',
        payload: { id: `cust-${i}`, name: `Customer ${i}` },
        deviceId: 'dev-1',
        actorAdminId: 'admin-1',
      });
    }

    // Default pull from cursor 0
    const page1 = await mockTransport.pullChanges(0);
    expect(page1.changes.length).toBe(500);
    expect(page1.changes[0].sequenceId).toBe(1);
    expect(page1.changes[499].sequenceId).toBe(500);

    // Second pull from cursor 500
    const page2 = await mockTransport.pullChanges(500);
    expect(page2.changes.length).toBe(150);
    expect(page2.changes[0].sequenceId).toBe(501);
    expect(page2.changes[149].sequenceId).toBe(650);

    // Third pull from cursor 650 -> empty
    const page3 = await mockTransport.pullChanges(650);
    expect(page3.changes.length).toBe(0);
  });

  it('7. Multi-page delta pull correctly updates latestSequence in batches of 500', async () => {
    const transport = new SupabaseSyncTransport();

    // Generate mock batches
    const makeBatch = (startSeq: number, count: number) => {
      const items = [];
      for (let i = 0; i < count; i++) {
        const seq = startSeq + i;
        items.push({
          sequence_id: seq,
          entity_type: 'customers',
          entity_id: `cust-${seq}`,
          action: 'INSERT',
          payload: { id: `cust-${seq}`, name: `Cust ${seq}` },
          version: 1,
          changed_at: new Date().toISOString(),
        });
      }
      return items;
    };

    let currentCursor = 0;
    vi.spyOn(supabaseClientModule, 'invokeSupabaseRpc').mockImplementation(
      async (_functionName: string, args?: any) => {
        const cursorVal = Number(args?.p_since_sequence ?? 0);
        const changes = cursorVal === 0
          ? makeBatch(1, 500)
          : cursorVal === 500
            ? makeBatch(501, 500)
            : cursorVal === 1000
              ? makeBatch(1001, 200)
              : [];
        return { data: { changes, serverResetGeneration: 1 }, error: null } as any;
      }
    );

    // Page 1
    const p1 = await transport.pullChanges(currentCursor);
    expect(p1.changes.length).toBe(500);
    expect(p1.latestSequence).toBe(500);
    currentCursor = p1.latestSequence;

    // Page 2
    const p2 = await transport.pullChanges(currentCursor);
    expect(p2.changes.length).toBe(500);
    expect(p2.latestSequence).toBe(1000);
    currentCursor = p2.latestSequence;

    // Page 3
    const p3 = await transport.pullChanges(currentCursor);
    expect(p3.changes.length).toBe(200);
    expect(p3.latestSequence).toBe(1200);
    currentCursor = p3.latestSequence;

    // Page 4 -> no more
    const p4 = await transport.pullChanges(currentCursor);
    expect(p4.changes.length).toBe(0);
    expect(p4.latestSequence).toBe(1200);
  });
});
