import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  ensureStoreHydrated,
  createNewBusinessDay,
  addNewCustomer,
  createOrderWithPhase5Engine,
  updateOrderWithPhase5Engine,
  resetStoreMemory,
  clearAllOperationalData,
} from '../components/pages/dayOrdersStore';
import { globalSyncBridge } from '../infrastructure/sync/syncBridge';
import * as supabaseClient from '../services/supabase/client';
import { SupabaseSyncTransport } from '../infrastructure/sync/SupabaseSyncTransport';
import { SyncEngine } from '../infrastructure/sync/syncEngine';

const storageMap = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storageMap.get(key) || null,
  setItem: (key: string, val: string) => storageMap.set(key, String(val)),
  removeItem: (key: string) => storageMap.delete(key),
  clear: () => storageMap.clear(),
};
(globalThis as any).localStorage = localStorageMock;

describe('COMMAND IDENTITY VS ENTITY ID ARCHITECTURAL RESTORATION', () => {
  beforeEach(async () => {
    storageMap.clear();
    localStorageMock.setItem('sys_db_version', '6.10.3D');
    localStorageMock.setItem('app_device_id', 'test_device');
    localStorageMock.setItem('app_auth_session', JSON.stringify({ userId: 'test_admin_user' }));
    
    await clearAllOperationalData();
    resetStoreMemory();
    
    supabaseClient.clearStoredSupabaseAuthSession();
    supabaseClient.setSupabaseAuthToken('mock-jwt');
    vi.restoreAllMocks();
    vi.spyOn(supabaseClient, 'invokeSupabaseRestGet').mockImplementation(async (table: string) => {
      if (table === 'system_settings') {
        return { data: [{ value_number: 1 }], error: null };
      }
      return { data: [], error: null };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('verifies CREATE_ORDER gets fresh UUID on edit after original succeeds, stable order ID, and correct sync history', async () => {
    // 1. Mock supabase RPC calls
    let rpcCallCount = 0;
    const rpcCalls: any[] = [];
    vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockImplementation(async (fnName, payload: any) => {
      rpcCallCount++;
      rpcCalls.push({ fnName, payload });
      return {
        data: {
          success: true,
          command_id: payload.p_command_id,
          command_type: payload.p_command_type,
        },
        error: null,
      };
    });

    // 2. Prep devices and customer inside localDb
    await localDb.set('deviceTypes', '44444444-4444-4444-8444-444444444441', {
      id: '44444444-4444-4444-8444-444444444441', name: 'شاشة آيفون 13 برو', basePriceMinor: 40000, chargerFeeEnabled: true, isActive: true, sortOrder: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1
    });
    await localDb.set('deviceTypes', '55555555-5555-4555-8555-555555555552', {
      id: '55555555-5555-4555-8555-555555555552', name: 'بطارية آيفون 13', basePriceMinor: 25000, chargerFeeEnabled: false, isActive: true, sortOrder: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1
    });

    const dayId = '22222222-2222-4222-8222-222222222229';
    const customerId = '33333333-3333-4333-8333-333333331234';
    await localDb.set('businessDays', dayId, {
      id: dayId, date: '2029-09-29', status: 'OPEN',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1,
    });
    await localDb.set('customers', customerId, {
      id: customerId, name: 'Test Customer', phone: '123', isActive: true, debtLimitMinor: -10000, chargerFeeExempt: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1
    });

    // Now hydrate memory caches
    await ensureStoreHydrated();

    // A. Create Order
    const createRes = await createOrderWithPhase5Engine(dayId, customerId, [{ deviceTypeId: '44444444-4444-4444-8444-444444444441', hasCharger: true }], 'Initial notes');
    if (!createRes.success) {
      console.error('Create Order Error:', createRes.error);
    }
    expect(createRes.success).toBe(true);
    const orderId = createRes.order!.id;

    // Check Outbox
    let outbox = await localDb.listOutbox();
    const createCmd = outbox.find(o => o.commandType === 'CREATE_ORDER');
    expect(createCmd).toBeDefined();
    expect(createCmd?.commandId).toBe(orderId); // FIRST creation uses stable orderId for backward compatibility
    expect(createCmd?.aggregateId).toBe(orderId);  // STABLE AGGREGATE ID
    
    // Sync first command
    const transport = new SupabaseSyncTransport();
    const engine = new SyncEngine(transport);
    
    await engine.synchronize();
    
    let refreshedCreateCmd = await localDb.getOutbox(createCmd!.commandId);
    expect(refreshedCreateCmd).toBeUndefined();
    const createHistory = await localDb.getHistoryByCommandId(createCmd!.commandId);
    expect(['SUCCESS', 'SUCCEEDED']).toContain(createHistory?.state);

    // B. Edit notes (should get a NEW fresh command ID because original is accepted)
    const editRes = await updateOrderWithPhase5Engine(orderId, 'Updated notes', 'pending', [], []);
    expect(editRes.success).toBe(true);

    outbox = await localDb.listOutbox();
    const allCreateCmds = outbox.filter(o => o.commandType === 'CREATE_ORDER');
    
    // There must be exactly TWO CREATE_ORDER commands now:
    // 1. The original accepted one (stable historical record)
    // 2. The new pending edit one (with a different commandId)
    expect(allCreateCmds.length).toBe(1);
    
    const originalCmd = await localDb.getHistoryByCommandId(createCmd!.commandId);
    const editCmd = allCreateCmds.find(c => c.commandId !== createCmd!.commandId);
    
    expect(['SUCCESS', 'SUCCEEDED']).toContain(originalCmd?.state);
    expect(editCmd?.status).toBe('pending');      // Must be a new fresh command
    expect(editCmd?.commandId).not.toBe(originalCmd?.commandId);
    expect(editCmd?.aggregateId).toBe(orderId);   // Stable order ID
    expect((editCmd?.payload as any).notes).toBe('Updated notes');

    // Sync Edit
    await engine.synchronize();
    
    const refreshedEditCmd = await localDb.getOutbox(editCmd!.commandId);
    expect(refreshedEditCmd).toBeUndefined();
    const editHistory = await localDb.getHistoryByCommandId(editCmd!.commandId);
    expect(['SUCCESS', 'SUCCEEDED']).toContain(editHistory?.state);

    // C. Edit again (consecutive edit)
    const edit2Res = await updateOrderWithPhase5Engine(orderId, 'Second updated notes', 'pending', [], []);
    expect(edit2Res.success).toBe(true);

    outbox = await localDb.listOutbox();
    const allCreateCmdsAfter2 = outbox.filter(o => o.commandType === 'CREATE_ORDER');
    expect(allCreateCmdsAfter2.length).toBe(3); // Original, Edit 1, Edit 2

    const edit2Cmd = allCreateCmdsAfter2.find(c => c.commandId !== createCmd!.commandId && c.commandId !== editCmd!.commandId);
    expect(edit2Cmd?.status).toBe('pending');
    expect(edit2Cmd?.commandId).not.toBe(editCmd?.commandId);
    expect(edit2Cmd?.commandId).not.toBe(createCmd!.commandId);
  });
});
