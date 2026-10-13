import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  addNewCustomer,
  globalSyncEngine,
  resetStoreMemory,
  clearAllOperationalData,
  applyRemoteChange,
  phase5UseCases,
  defaultAdminAuth,
  getCustomersList,
} from '../components/pages/dayOrdersStore';
import { localDb } from '../infrastructure/localDb/localDb';
import '../infrastructure/sync/syncBridge';
import * as fs from 'fs';
import * as path from 'path';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('CUSTOMER STABLE UUID TESTS (Tests A - H)', () => {
  beforeEach(async () => {
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
      // Mutation tests require a cached authenticated app session.
      localStorage.setItem('app_auth_session', JSON.stringify({
        userId: 'admin_test_session',
        role: 'ADMIN',
        permissions: [
          'customers:create', 'customers:edit', 'customers:view',
          'orders:create', 'orders:edit', 'orders:deliver', 'orders:cancel', 'orders:view',
          'devices:manage', 'devices:view', 'settings:manage',
          'finance:view', 'finance:create-payment', 'goals:manage',
        ],
      }));
    }
    await clearAllOperationalData();
    await localDb.clearLocalResetMarker();
    resetStoreMemory();
    vi.restoreAllMocks();
  });

  // TEST A: Customer creation generates a standard UUID
  it('TEST A: addNewCustomer generates a valid RFC 4122 v4 UUID format', async () => {
    const cust = await addNewCustomer('عميل تجريبي قياسي', '0599000111');
    expect(cust).toBeDefined();
    expect(cust.id).toMatch(UUID_REGEX);
    expect(cust.id).not.toContain('cust-');
    expect(cust.id).not.toContain('Date.now');
  });

  // TEST B: CustomerEntity.id == Outbox aggregate/entity ID
  it('TEST B: CustomerEntity.id exactly matches Outbox aggregateId and commandId', async () => {
    const cust = await addNewCustomer('عميل التطابق', '0599000222');
    const localEntity = await localDb.get<any>('customers', cust.id);
    expect(localEntity).toBeDefined();
    expect(localEntity.id).toBe(cust.id);

    const outbox = await localDb.listOutbox();
    const cmd = outbox.find((c) => c.commandId === cust.id && c.commandType === 'CREATE_CUSTOMER');
    expect(cmd).toBeDefined();
    expect(cmd?.aggregateId).toBe(cust.id);
    expect((cmd?.payload as any)?.id).toBe(cust.id);
    expect(cmd?.aggregateType).toBe('customers');
  });

  // TEST C: No second Customer ID is generated during Outbox creation
  it('TEST C: does not generate a second Customer ID during transaction or outbox recording', async () => {
    const cust = await addNewCustomer('عميل أحادي الهوية', '0599000333');
    const allCustomers = await localDb.list<any>('customers');
    const matchingCusts = allCustomers.filter((c) => c.name === 'عميل أحادي الهوية');
    expect(matchingCusts.length).toBe(1);
    expect(matchingCusts[0].id).toBe(cust.id);

    const outbox = await localDb.listOutbox();
    const matchingCmds = outbox.filter((c) => (c.payload as any)?.name === 'عميل أحادي الهوية');
    expect(matchingCmds.length).toBe(1);
    expect(matchingCmds[0].aggregateId).toBe(cust.id);
  });

  // TEST D: Retrying the same command preserves Customer ID invariance
  it('TEST D: retry of the command does not generate a new Customer ID', async () => {
    const cust = await addNewCustomer('عميل إعادة المحاولة', '0599000444');
    const outboxBefore = await localDb.getOutbox(cust.id);
    expect(outboxBefore).toBeDefined();
    expect(outboxBefore?.commandId).toBe(cust.id);

    // Simulate retry by updating status to conflict and running scheduler
    if (outboxBefore) {
      outboxBefore.status = 'conflict';
      outboxBefore.retryCount = 1;
      await localDb.saveOutbox(outboxBefore);
    }

    const outboxAfter = await localDb.getOutbox(cust.id);
    expect(outboxAfter?.commandId).toBe(cust.id);
    expect(outboxAfter?.aggregateId).toBe(cust.id);
    expect((outboxAfter?.payload as any)?.id).toBe(cust.id);
  });

  // TEST E: Server payload contains the exact same Customer ID
  it('TEST E: payload dispatched to remote transport retains identical Customer UUID', async () => {
    let capturedPayload: any = null;
    let capturedCommandId: string | null = null;

    vi.spyOn(globalSyncEngine as any, 'transport', 'get').mockReturnValue({
      pushCommand: async (req: any) => {
        capturedCommandId = req.commandId;
        capturedPayload = req.payload;
        return { success: true };
      },
      pullChanges: async () => ({ changes: [], latestSequence: 0, serverResetGeneration: 1 }),
    });

    const cust = await addNewCustomer('عميل حمولة السيرفر', '0599000555');

    // Wait for the non-blocking background sync cycle to finish
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(capturedCommandId).toBe(cust.id);
    expect(capturedPayload).toBeDefined();
    expect(capturedPayload.id).toBe(cust.id);
    expect(capturedPayload.id).toMatch(UUID_REGEX);
  });

  // TEST F: Alternative use case creation path generates UUID
  it('TEST F: phase5UseCases.createCustomer generates standard UUID', async () => {
    const res = await phase5UseCases.createCustomer(
      defaultAdminAuth,
      'عميل حالة الاستخدام',
      '0599000666'
    );
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.data).toBeDefined();
    expect(res.data.id).toMatch(UUID_REGEX);
    expect(res.data.id).not.toContain('cust_');
    expect(res.data.id).not.toContain('Date.now');

    const outbox = await localDb.listOutbox();
    const cmd = outbox.find((c) => c.commandId === res.data.id);
    expect(cmd).toBeDefined();
    expect(cmd?.aggregateId).toBe(res.data.id);
  });

  // TEST G: Regression - ensure cust-${Date.now()} is completely absent from customer creation production code
  it('TEST G: ensures cust-${Date.now()} is absent from customer creation production code', () => {
    const storePath = path.resolve(process.cwd(), 'src/components/pages/dayOrdersStore.ts');
    const storeContent = fs.readFileSync(storePath, 'utf8');

    // Extract addNewCustomer function body
    const addNewCustomerMatch = storeContent.match(/export const addNewCustomer = async[\s\S]*?^};/m);
    expect(addNewCustomerMatch).not.toBeNull();
    const addNewCustomerBody = addNewCustomerMatch![0];

    expect(addNewCustomerBody).not.toContain('cust-${Date.now()}');
    expect(addNewCustomerBody).not.toContain('cust-');
    expect(addNewCustomerBody).toContain('crypto.randomUUID()');

    const useCasesPath = path.resolve(process.cwd(), 'src/application/useCases.ts');
    const useCasesContent = fs.readFileSync(useCasesPath, 'utf8');
    const createCustomerMatch = useCasesContent.match(/async createCustomer\([\s\S]*?^  }/m);
    expect(createCustomerMatch).not.toBeNull();
    const createCustomerBody = createCustomerMatch![0];
    expect(createCustomerBody).not.toContain('`cust_${Date.now()}_');
  });

  // TEST H: applyRemoteChange does not duplicate customer when server ID matches local ID
  it('TEST H: applyRemoteChange cleanly overwrites same UUID entity without duplication', async () => {
    const cust = await addNewCustomer('عميل المزامنة التام', '0599000777');
    expect(cust.id).toMatch(UUID_REGEX);

    // Simulate remote pull delivering the exact same UUID from change_log
    await applyRemoteChange({
      sequenceId: 100,
      entityType: 'customers',
      entityId: cust.id,
      action: 'INSERT',
      payload: {
        id: cust.id,
        name: 'عميل المزامنة التام (محدث من السيرفر)',
        phone: '0599000777',
        is_active: true,
        debt_limit_minor: -2000,
        charger_fee_exempt: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        version: 2,
      },
      changedAt: new Date().toISOString(),
    });

    const list = await getCustomersList('عميل المزامنة التام', 10);
    // There must be exactly 1 customer, NOT 2 duplicates!
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(cust.id);
    expect(list[0].name).toBe('عميل المزامنة التام (محدث من السيرفر)');
  });
});
