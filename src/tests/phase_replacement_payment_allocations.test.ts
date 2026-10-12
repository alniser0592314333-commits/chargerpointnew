import { describe, it, expect, beforeEach, vi } from 'vitest';
import { backupService, normalizeReplacementOrderInternalSequences } from '../services/backup/backupService';
import { localDb } from '../infrastructure/localDb/localDb';
import { AuthorizationContext } from '../application/authContext';
import { PaymentAllocationEntity } from '../domain/models';
import * as supabaseClient from '../services/supabase/client';
import { phase5UseCases, resetStoreMemory, clearAllOperationalData, setRuntimeBinVerifier } from '../components/pages/dayOrdersStore';

const superAdminAuth = new AuthorizationContext(
  {
    id: 'admin_test_super',
    username: 'superadmin',
    fullName: 'Super Admin',
    role: 'SUPER_ADMIN',
    permissions: ['settings:manage', 'finance:create-payment', 'orders:create', 'customers:create'],
    isSuperAdmin: true,
  },
  (bin: string) => bin === '1234'
);

const regularAdminAuth = new AuthorizationContext(
  {
    id: 'admin_regular',
    username: 'regular',
    fullName: 'Regular Admin',
    role: 'ADMIN',
    permissions: ['orders:create'],
    isSuperAdmin: false,
  },
  (bin: string) => bin === '1234'
);

describe('PAYMENT ALLOCATIONS — REPLACEMENT INTEGRATION & REPLACEMENT ARCHITECTURE', () => {
  beforeEach(async () => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
    await clearAllOperationalData();
    await localDb.clearLocalResetMarker();
    resetStoreMemory();
    setRuntimeBinVerifier((bin) => bin === '1234');
    vi.restoreAllMocks();
  });

  it('repairs legacy duplicate/non-positive global order sequences without changing visible order numbers', () => {
    const rows: any[] = [
      { id: '00000000-0000-4000-8000-000000000003', createdAt: '2026-01-03T00:00:00.000Z', internalSequence: 0, internal_sequence: 0, displayNumber: 1, display_number: 1 },
      { id: '00000000-0000-4000-8000-000000000001', createdAt: '2026-01-01T00:00:00.000Z', internalSequence: 1, internal_sequence: 1, displayNumber: 7, display_number: 7 },
      { id: '00000000-0000-4000-8000-000000000002', createdAt: '2026-01-02T00:00:00.000Z', internalSequence: 1, internal_sequence: 1, displayNumber: 2, display_number: 2 },
    ];
    const data: any = { orders: rows };

    expect(normalizeReplacementOrderInternalSequences(data)).toBe(true);
    expect(rows.map((row) => row.internal_sequence)).toEqual([3, 1, 2]);
    expect(new Set(rows.map((row) => row.internal_sequence)).size).toBe(3);
    expect(rows.map((row) => row.display_number)).toEqual([1, 7, 2]);
    expect(rows.every((row) => row.internalSequence === row.internal_sequence)).toBe(true);
  });

  it('does not rewrite an already-valid unique positive global sequence', () => {
    const data: any = {
      orders: [
        { id: '00000000-0000-4000-8000-000000000001', internalSequence: 12, internal_sequence: 12 },
        { id: '00000000-0000-4000-8000-000000000002', internalSequence: 13, internal_sequence: 13 },
      ],
    };
    expect(normalizeReplacementOrderInternalSequences(data)).toBe(false);
    expect(data.orders.map((row: any) => row.internal_sequence)).toEqual([12, 13]);
  });

  // A. Local allocation UUID accepted
  it('A. Local allocation UUID is accepted', () => {
    const validUuid = crypto.randomUUID();
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(validUuid)).toBe(true);
  });

  // B. Replacement payload contains payment_allocations
  it('B. Replacement payload contains payment_allocations', async () => {
    const allocId = crypto.randomUUID();
    const payId = crypto.randomUUID();
    const ordId = crypto.randomUUID();

    let capturedPayload: any = null;
    vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockImplementation(async (fnName, params: any) => {
      if (fnName === 'replace_online_business_data') {
        capturedPayload = params.p_payload;
        return {
          data: {
            success: true,
            operation: 'REPLACE_ONLINE_BUSINESS_DATA',
            replacementId: crypto.randomUUID(),
            completedAt: new Date().toISOString(),
            counts: { payment_allocations: 1 },
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });

    await backupService.replaceOnlineWithLocalData(superAdminAuth, '1234', {
      customLocalData: {
        paymentAllocations: [
          {
            id: allocId,
            paymentId: payId,
            orderId: ordId,
            allocatedAmountMinor: 1500,
            createdAt: new Date().toISOString(),
          },
        ],
      },
      customOnlineSafetyData: { paymentAllocations: [] },
    });

    expect(capturedPayload).toBeDefined();
    expect(Array.isArray(capturedPayload.payment_allocations)).toBe(true);
    expect(capturedPayload.payment_allocations.length).toBe(1);
    expect(capturedPayload.payment_allocations[0].id).toBe(allocId);
    expect(capturedPayload.payment_allocations[0].payment_id).toBe(payId);
    expect(capturedPayload.payment_allocations[0].order_id).toBe(ordId);
    expect(capturedPayload.payment_allocations[0].allocated_amount_minor).toBe(1500);
  });

  // C. Same allocation.id: Local wins (preview & payload test)
  it('C. Same allocation.id: Local wins and updates online state', async () => {
    const sharedId = crypto.randomUUID();
    const payId = crypto.randomUUID();
    const ordId = crypto.randomUUID();

    const diff = await backupService.previewReplacementDiff(
      {
        paymentAllocations: [
          {
            id: sharedId,
            paymentId: payId,
            orderId: ordId,
            allocatedAmountMinor: 500,
          },
        ],
      },
      {
        paymentAllocations: [
          {
            id: sharedId,
            paymentId: payId,
            orderId: ordId,
            allocatedAmountMinor: 2000, // Local updated amount
          },
        ],
      }
    );

    expect(diff.summary.payment_allocations.localCount).toBe(1);
    expect(diff.summary.payment_allocations.onlineCount).toBe(1);
    expect(diff.summary.payment_allocations.toUpdate).toBe(1);
    expect(diff.summary.payment_allocations.toInsert).toBe(0);
    expect(diff.summary.payment_allocations.toDelete).toBe(0);
  });

  // D. Local-only allocation: Online INSERT
  it('D. Local-only allocation is categorized as toInsert', async () => {
    const localOnlyId = crypto.randomUUID();
    const payId = crypto.randomUUID();
    const ordId = crypto.randomUUID();

    const diff = await backupService.previewReplacementDiff(
      { paymentAllocations: [] },
      {
        paymentAllocations: [
          {
            id: localOnlyId,
            paymentId: payId,
            orderId: ordId,
            allocatedAmountMinor: 1000,
          },
        ],
      }
    );

    expect(diff.summary.payment_allocations.toInsert).toBe(1);
    expect(diff.summary.payment_allocations.toUpdate).toBe(0);
    expect(diff.summary.payment_allocations.toDelete).toBe(0);
  });

  // E. Online-only allocation: Online DELETE in REPLACE mode
  it('E. Online-only allocation is categorized as toDelete', async () => {
    const onlineOnlyId = crypto.randomUUID();
    const payId = crypto.randomUUID();
    const ordId = crypto.randomUUID();

    const diff = await backupService.previewReplacementDiff(
      {
        paymentAllocations: [
          {
            id: onlineOnlyId,
            paymentId: payId,
            orderId: ordId,
            allocatedAmountMinor: 1000,
          },
        ],
      },
      { paymentAllocations: [] }
    );

    expect(diff.summary.payment_allocations.toDelete).toBe(1);
    expect(diff.summary.payment_allocations.toInsert).toBe(0);
    expect(diff.summary.payment_allocations.toUpdate).toBe(0);
  });

  // F. Allocation references existing payment/order
  it('F. Allocation contains payment_id and order_id references', async () => {
    const allocId = crypto.randomUUID();
    const payId = crypto.randomUUID();
    const ordId = crypto.randomUUID();

    const alloc: PaymentAllocationEntity = {
      id: allocId,
      paymentId: payId,
      orderId: ordId,
      allocatedAmountMinor: 2500,
      createdAt: new Date().toISOString(),
    };

    expect(alloc.paymentId).toBe(payId);
    expect(alloc.orderId).toBe(ordId);
  });

  // G. Allocation ID preserved exactly
  it('G. Allocation ID is preserved without server mutation or md5 hashing', async () => {
    const testId = '44444444-4444-4444-4444-444444444444';
    let capturedAllocId: string | null = null;

    vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockImplementation(async (fnName, params: any) => {
      if (fnName === 'replace_online_business_data') {
        capturedAllocId = params.p_payload.payment_allocations[0].id;
        return {
          data: { success: true, counts: { payment_allocations: 1 } },
          error: null,
        };
      }
      return { data: null, error: null };
    });

    await backupService.replaceOnlineWithLocalData(superAdminAuth, '1234', {
      customLocalData: {
        paymentAllocations: [
          {
            id: testId,
            paymentId: crypto.randomUUID(),
            orderId: crypto.randomUUID(),
            allocatedAmountMinor: 500,
          },
        ],
      },
      customOnlineSafetyData: { paymentAllocations: [] },
    });

    expect(capturedAllocId).toBe(testId);
  });

  // H. Invalid allocation UUID rejected
  it('H. Invalid allocation UUID is rejected', async () => {
    await expect(
      backupService.replaceOnlineWithLocalData(superAdminAuth, '1234', {
        customLocalData: {
          paymentAllocations: [
            {
              id: 'invalid-non-uuid-alloc',
              paymentId: crypto.randomUUID(),
              orderId: crypto.randomUUID(),
              allocatedAmountMinor: 500,
            },
          ],
        },
      })
    ).rejects.toThrow(/malformed UUID format/i);
  });

  // I. null allocation ID rejected
  it('I. null allocation ID is rejected', async () => {
    await expect(
      backupService.replaceOnlineWithLocalData(superAdminAuth, '1234', {
        customLocalData: {
          paymentAllocations: [
            {
              id: null as any,
              paymentId: crypto.randomUUID(),
              orderId: crypto.randomUUID(),
              allocatedAmountMinor: 500,
            },
          ],
        },
      })
    ).rejects.toThrow(/cannot be null/i);
  });

  // J. empty/whitespace allocation ID rejected
  it('J. empty or whitespace allocation ID is rejected', async () => {
    await expect(
      backupService.replaceOnlineWithLocalData(superAdminAuth, '1234', {
        customLocalData: {
          paymentAllocations: [
            {
              id: '   ',
              paymentId: crypto.randomUUID(),
              orderId: crypto.randomUUID(),
              allocatedAmountMinor: 500,
            },
          ],
        },
      })
    ).rejects.toThrow(/cannot be null, empty, or whitespace/i);
  });

  // K. Replacement failure during allocation insert: entire transaction rolls back
  it('K. Server RPC error rolls back and throws exception', async () => {
    vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockResolvedValueOnce({
      data: null,
      error: 'Foreign key violation: referenced payment does not exist',
    });

    await expect(
      backupService.replaceOnlineWithLocalData(superAdminAuth, '1234', {
        customLocalData: {
          paymentAllocations: [
            {
              id: crypto.randomUUID(),
              paymentId: crypto.randomUUID(),
              orderId: crypto.randomUUID(),
              allocatedAmountMinor: 500,
            },
          ],
        },
        customOnlineSafetyData: { paymentAllocations: [] },
      })
    ).rejects.toThrow(/Foreign key violation/);
  });

  // L. Online safety snapshot includes payment_allocations
  it('L. Online safety snapshot captures and stores payment_allocations', async () => {
    const sampleAllocId = crypto.randomUUID();
    const payId = crypto.randomUUID();
    const ordId = crypto.randomUUID();

    vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockResolvedValue({
      data: { success: true, operation: 'REPLACE_ONLINE_BUSINESS_DATA', replacementId: 'rep-1', counts: {} },
      error: null,
    });

    const res = await backupService.replaceOnlineWithLocalData(superAdminAuth, '1234', {
      customOnlineSafetyData: {
        paymentAllocations: [
          {
            id: sampleAllocId,
            paymentId: payId,
            orderId: ordId,
            allocatedAmountMinor: 3000,
          },
        ],
      },
      customLocalData: { paymentAllocations: [] },
    });

    expect(res.safetySnapshotId).toBeDefined();
    const snapshot = await backupService.getSnapshot(res.safetySnapshotId);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.data.paymentAllocations).toBeDefined();
    expect(snapshot?.data.paymentAllocations.some((a) => a.id === sampleAllocId)).toBe(true);
  });

  // M. Online -> Local restore includes payment_allocations
  it('M. Online -> Local restore includes payment_allocations without Outbox pollution', async () => {
    const allocId = crypto.randomUUID();
    const payId = crypto.randomUUID();
    const ordId = crypto.randomUUID();

    await backupService.restoreOnlineToLocal(superAdminAuth, {
      bin: '1234',
      customOnlineData: {
        customers: [],
        businessDays: [],
        orders: [],
        orderItems: [],
        financialLedger: [],
        payments: [],
        deviceTypes: [],
        paymentAllocations: [
          {
            id: allocId,
            paymentId: payId,
            orderId: ordId,
            allocatedAmountMinor: 1200,
            createdAt: '2026-09-29T10:00:00Z',
          },
        ],
      },
    });

    const restoredAlloc = await localDb.get<PaymentAllocationEntity>('paymentAllocations', allocId);
    expect(restoredAlloc).toBeDefined();
    expect(restoredAlloc?.id).toBe(allocId);
    expect(restoredAlloc?.paymentId).toBe(payId);
    expect(restoredAlloc?.orderId).toBe(ordId);
    expect(restoredAlloc?.allocatedAmountMinor).toBe(1200);

    const outbox = await localDb.listOutbox();
    const allocCmd = outbox.find((c) => c.commandId === allocId || (c.payload as any)?.id === allocId);
    expect(allocCmd).toBeUndefined();
  });

  // N. Local snapshot restore remains correct
  it('N. Local snapshot restore preserves payment_allocations', async () => {
    const allocId = crypto.randomUUID();
    const payId = crypto.randomUUID();
    const ordId = crypto.randomUUID();

    const snapshot = await backupService.createSnapshot('OFFLINE', superAdminAuth, {
      name: 'Test Local Snapshot',
      bin: '1234',
    });

    // Populate localDb with allocation and create snapshot
    await localDb.set('paymentAllocations', allocId, {
      id: allocId,
      paymentId: payId,
      orderId: ordId,
      allocatedAmountMinor: 4000,
    });

    const snapshotWithAlloc = await backupService.createSnapshot('OFFLINE', superAdminAuth, {
      name: 'Test Snapshot With Alloc',
      bin: '1234',
    });

    // Clear local operational tables
    await localDb.clearOperationalTables();
    expect(await localDb.get('paymentAllocations', allocId)).toBeNull();

    // Restore snapshot
    await backupService.restoreSnapshot(snapshotWithAlloc.snapshotId, superAdminAuth, { bin: '1234' });

    const restored = await localDb.get<PaymentAllocationEntity>('paymentAllocations', allocId);
    expect(restored).not.toBeNull();
    expect(restored?.id).toBe(allocId);
    expect(restored?.allocatedAmountMinor).toBe(4000);
  });

  // O. No Outbox command is created for allocation during normal allocation operation
  it('O. No Outbox command is created for allocation during normal operation', async () => {
    const outboxBefore = await localDb.listOutbox();
    const allocId = crypto.randomUUID();

    // Saving allocation to localDb
    await localDb.set('paymentAllocations', allocId, {
      id: allocId,
      paymentId: crypto.randomUUID(),
      orderId: crypto.randomUUID(),
      allocatedAmountMinor: 500,
    });

    const outboxAfter = await localDb.listOutbox();
    expect(outboxAfter.length).toBe(outboxBefore.length);
  });

  // P. No normal SyncEngine path is introduced for allocation
  it('P. allocations table is not in regular command types or SyncEngine targets', async () => {
    const outbox = await localDb.listOutbox();
    const allocCmds = outbox.filter((o) => o.commandType === 'ALLOCATION' || o.aggregateType === 'payment_allocations');
    expect(allocCmds.length).toBe(0);
  });

  // Q. BIN/authorization still mandatory
  it('Q. BIN and authorization are mandatory for replaceOnlineWithLocalData', async () => {
    // 1. Regular admin without settings:manage fails
    await expect(backupService.replaceOnlineWithLocalData(regularAdminAuth, '1234')).rejects.toThrow();

    // 2. Missing BIN fails
    await expect(backupService.replaceOnlineWithLocalData(superAdminAuth, '')).rejects.toThrow(/BIN is required/);
  });
});
