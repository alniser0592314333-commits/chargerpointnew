import { describe, it, expect, beforeEach, vi } from 'vitest';
import { backupService } from '../services/backup/backupService';
import * as supabaseClient from '../services/supabase/client';
import { AuthorizationContext } from '../application/authContext';
import { localDb } from '../infrastructure/localDb/localDb';

const superAdminAuth = new AuthorizationContext(
  {
    id: 'admin_test_super',
    username: 'superadmin',
    fullName: 'Super Admin',
    role: 'SUPER_ADMIN',
    permissions: ['settings:manage'],
    isSuperAdmin: true,
  },
  (bin: string) => bin === '1234'
);

describe('SAFETY SNAPSHOT — STRICT PAGINATION & ZERO TRUNCATION AUDIT', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
  });

  // A. first-page failure does NOT fallback to unbounded select=*
  it('A. first-page failure does NOT fallback to unbounded select=* and throws an error', async () => {
    const requestedQueries: string[] = [];

    vi.spyOn(supabaseClient, 'invokeSupabaseRestGet').mockImplementation(async (table, query) => {
      requestedQueries.push(query || '');
      if (table === 'customers') {
        return { data: null, error: 'Network timeout on first page' };
      }
      return { data: [], error: null };
    });

    await expect(backupService.captureOnlineData()).rejects.toThrow(
      /Failed to fetch online table "customers" at offset 0/
    );

    // Verify select=* was never requested as an unbounded fallback
    expect(requestedQueries.some((q) => q === 'select=*')).toBe(false);
  });

  // B. first-page failure causes safe failure
  it('B. first-page failure causes safe failure preventing incomplete snapshot creation', async () => {
    vi.spyOn(supabaseClient, 'invokeSupabaseRestGet').mockImplementation(async (table) => {
      if (table === 'payment_allocations') {
        return { data: null, error: '500 Internal Server Error' };
      }
      return { data: [], error: null };
    });

    await expect(
      backupService.createSnapshot('ONLINE', superAdminAuth, { bin: '1234' })
    ).rejects.toThrow(/Failed to fetch online table "payment_allocations" at offset 0/);
  });

  // C. later-page failure does NOT return partial dataset
  it('C. later-page failure does NOT return partial dataset (rejects immediately)', async () => {
    const page1Data = Array.from({ length: 1000 }, (_, i) => ({
      id: crypto.randomUUID(),
      name: `Customer ${i}`,
    }));

    vi.spyOn(supabaseClient, 'invokeSupabaseRestGet').mockImplementation(async (table, query) => {
      if (table === 'customers') {
        if (query?.includes('offset=0')) {
          return { data: page1Data, error: null };
        }
        if (query?.includes('offset=1000')) {
          return { data: null, error: 'Connection reset on page 2' };
        }
      }
      return { data: [], error: null };
    });

    await expect(backupService.captureOnlineData()).rejects.toThrow(
      /Failed to fetch online table "customers" at offset 1000/
    );
  });

  // D. successful multi-page fetch returns all rows
  it('D. successful multi-page fetch returns all rows across multiple offsets', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      amount_minor: 100,
    }));
    const page2 = Array.from({ length: 1000 }, (_, i) => ({
      id: `00000000-0000-0000-0001-${String(i).padStart(12, '0')}`,
      amount_minor: 200,
    }));
    const page3 = Array.from({ length: 450 }, (_, i) => ({
      id: `00000000-0000-0000-0002-${String(i).padStart(12, '0')}`,
      amount_minor: 300,
    }));

    const queriedOffsets: number[] = [];

    vi.spyOn(supabaseClient, 'invokeSupabaseRestGet').mockImplementation(async (table, query) => {
      if (table === 'payment_allocations') {
        const match = query?.match(/offset=(\d+)/);
        const offset = match ? parseInt(match[1], 10) : 0;
        queriedOffsets.push(offset);

        if (offset === 0) return { data: page1, error: null };
        if (offset === 1000) return { data: page2, error: null };
        if (offset === 2000) return { data: page3, error: null };
      }
      return { data: [], error: null };
    });

    const onlineData = await backupService.captureOnlineData();

    expect(queriedOffsets).toEqual([0, 1000, 2000]);
    expect(onlineData.paymentAllocations.length).toBe(2450);
  });

  // E. count is based on complete dataset
  it('E. snapshot metadata counts are calculated strictly on complete dataset', async () => {
    const dummyAllocations = Array.from({ length: 1500 }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      payment_id: crypto.randomUUID(),
      order_id: crypto.randomUUID(),
      allocated_amount_minor: 500,
    }));

    vi.spyOn(supabaseClient, 'invokeSupabaseRestGet').mockImplementation(async (table, query) => {
      if (table === 'payment_allocations') {
        if (query?.includes('offset=0')) {
          return { data: dummyAllocations.slice(0, 1000), error: null };
        }
        if (query?.includes('offset=1000')) {
          return { data: dummyAllocations.slice(1000), error: null };
        }
      }
      return { data: [], error: null };
    });

    const snapshot = await backupService.createSnapshot('ONLINE', superAdminAuth, { bin: '1234' });

    expect(snapshot.metadata.recordCounts.paymentAllocations).toBe(1500);
    expect(snapshot.data.paymentAllocations.length).toBe(1500);
  });

  // F. payment_allocations uses complete pagination with order=id.asc
  it('F. payment_allocations queries enforce order=id.asc and pagination parameters', async () => {
    const queriesForAllocations: string[] = [];

    vi.spyOn(supabaseClient, 'invokeSupabaseRestGet').mockImplementation(async (table, query) => {
      if (table === 'payment_allocations') {
        queriesForAllocations.push(query || '');
      }
      return { data: [], error: null };
    });

    await backupService.captureOnlineData();

    expect(queriesForAllocations.length).toBeGreaterThanOrEqual(1);
    expect(queriesForAllocations[0]).toContain('order=id.asc');
    expect(queriesForAllocations[0]).toContain('limit=1000');
    expect(queriesForAllocations[0]).toContain('offset=0');
  });

  // G. No silent truncation on invalid return types
  it('G. Non-array response throws format exception instead of returning empty array', async () => {
    vi.spyOn(supabaseClient, 'invokeSupabaseRestGet').mockResolvedValue({
      data: { message: 'Unexpected object response' } as any,
      error: null,
    });

    await expect(backupService.captureOnlineData()).rejects.toThrow(
      /Invalid response format fetching online table/
    );
  });
});
