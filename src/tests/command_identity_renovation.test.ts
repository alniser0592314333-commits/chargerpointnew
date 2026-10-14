import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  clearAllOperationalData,
  createOrderWithPhase5Engine,
  ensureStoreHydrated,
  resetCanonicalReadModelsForReplay,
  resetStoreMemory,
  applyRemoteChange,
  updateOrderWithPhase5Engine,
} from '../components/pages/dayOrdersStore';
import * as supabaseClient from '../services/supabase/client';
import { SupabaseSyncTransport } from '../infrastructure/sync/SupabaseSyncTransport';
import { SyncEngine } from '../infrastructure/sync/syncEngine';
import { initializeCanonicalSyncState, setTestAppAuthSession } from './utils/testSetup';

const storageMap = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storageMap.get(key) || null,
  setItem: (key: string, val: string) => storageMap.set(key, String(val)),
  removeItem: (key: string) => storageMap.delete(key),
  clear: () => storageMap.clear(),
};
(globalThis as any).localStorage = localStorageMock;

type MockChange = {
  sequence_id: number;
  entity_type: string;
  entity_id: string;
  action: string;
  payload: Record<string, unknown>;
  version: number;
  changed_at: string;
};

const serverChangeLog: MockChange[] = [];
let serverSequence = 0;

function appendChange(entityType: string, entityId: string, payload: Record<string, unknown>) {
  serverSequence += 1;
  serverChangeLog.push({
    sequence_id: serverSequence,
    entity_type: entityType,
    entity_id: entityId,
    action: 'UPSERT',
    payload,
    version: Number(payload.version ?? 1),
    changed_at: new Date().toISOString(),
  });
}

describe('COMMAND IDENTITY VS ENTITY ID ARCHITECTURAL RESTORATION', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    storageMap.clear();
    await clearAllOperationalData();
    await localDb.clear();
    resetStoreMemory();
    await initializeCanonicalSyncState();
    setTestAppAuthSession();
    supabaseClient.clearStoredSupabaseAuthSession();
    supabaseClient.setSupabaseAuthToken('mock-jwt');
    serverChangeLog.length = 0;
    serverSequence = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps entity identity stable while each accepted edit gets a fresh command UUID', async () => {
    const now = new Date().toISOString();
    const dayId = '10000000-0000-4000-8000-000000000001';
    const customerId = '10000000-0000-4000-8000-000000000002';
    const deviceTypeId = '10000000-0000-4000-8000-000000000003';

    await localDb.set('businessDays', dayId, {
      id: dayId,
      businessDate: '2029-09-29',
      status: 'OPEN',
      isClosed: false,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    await localDb.set('customers', customerId, {
      id: customerId,
      name: 'Test Customer',
      phone: '123',
      status: 'ACTIVE',
      isActive: true,
      debtLimitMinor: 100000,
      chargerFeeExempt: false,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    await localDb.set('deviceTypes', deviceTypeId, {
      id: deviceTypeId,
      name: 'شاشة آيفون 13 برو',
      nameAr: 'شاشة آيفون 13 برو',
      icon: 'smartphone',
      status: 'ACTIVE',
      basePriceMinor: 40000,
      chargerFeeEnabled: true,
      chargerFeeApplicable: true,
      isActive: true,
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    await ensureStoreHydrated();

    vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockImplementation(async (fnName, rpcPayload: any) => {
      if (fnName === 'pull_canonical_changes') {
        const afterSequence = Number(rpcPayload?.p_since_sequence ?? 0);
        const changes = serverChangeLog.filter((change) => change.sequence_id > afterSequence);
        return {
          data: {
            changes,
            latestSequence: changes.length ? changes[changes.length - 1].sequence_id : afterSequence,
            serverResetGeneration: 1,
          },
          error: null,
        };
      }

      if (fnName !== 'execute_sync_command') {
        return { data: null, error: `Unexpected RPC: ${fnName}` };
      }

      const commandType = String(rpcPayload?.p_command_type ?? '');
      const payload = (rpcPayload?.p_payload ?? {}) as Record<string, any>;
      const now = new Date().toISOString();

      if (commandType === 'CREATE_ORDER' || commandType === 'UPDATE_ORDER') {
        const orderId = String(payload.id ?? payload.orderId ?? '');
        if (orderId) {
          const previous = [...serverChangeLog].reverse().find(
            (change) => change.entity_type === 'orders' && change.entity_id === orderId,
          );
          const previousPayload = previous?.payload ?? {};
          const version = Number(previousPayload.version ?? 0) + 1;
          appendChange('orders', orderId, {
            ...previousPayload,
            id: orderId,
            day_id: payload.dayId ?? payload.day_id ?? previousPayload.day_id ?? dayId,
            customer_id: payload.customerId ?? payload.customer_id ?? previousPayload.customer_id ?? customerId,
            display_number: payload.displayNumber ?? payload.display_number ?? previousPayload.display_number ?? 1,
            internal_sequence: payload.internalSequence ?? payload.internal_sequence ?? previousPayload.internal_sequence ?? 1,
            status: payload.status ?? previousPayload.status ?? 'pending',
            customer_balance_snapshot_minor: payload.customerBalanceSnapshotMinor
              ?? payload.customer_balance_snapshot_minor
              ?? previousPayload.customer_balance_snapshot_minor
              ?? 0,
            notes: payload.notes ?? previousPayload.notes,
            created_at: previousPayload.created_at ?? now,
            updated_at: now,
            version,
          });
        }
      } else if (commandType === 'ADD_ORDER_ITEM') {
        const itemId = String(payload.id ?? '');
        if (itemId) {
          appendChange('order_items', itemId, {
            id: itemId,
            order_id: payload.orderId ?? payload.order_id,
            device_type_id: payload.deviceTypeId ?? payload.device_type_id,
            item_sequence: payload.itemSequence ?? payload.item_sequence ?? 1,
            status: payload.status ?? 'charging',
            device_name_snapshot: payload.deviceNameSnapshot ?? payload.device_name_snapshot ?? 'Test device',
            device_icon_snapshot: payload.deviceIconSnapshot ?? payload.device_icon_snapshot ?? 'smartphone',
            base_price_snapshot_minor: payload.basePriceSnapshotMinor ?? payload.base_price_snapshot_minor ?? 40000,
            charger_fee_enabled_snapshot: payload.chargerFeeEnabledSnapshot ?? payload.charger_fee_enabled_snapshot ?? true,
            customer_charger_fee_exempt_snapshot: payload.customerChargerFeeExemptSnapshot ?? payload.customer_charger_fee_exempt_snapshot ?? false,
            charger_fee_snapshot_minor: payload.chargerFeeSnapshotMinor ?? payload.charger_fee_snapshot_minor ?? 0,
            has_charger: payload.hasCharger ?? payload.has_charger ?? false,
            unit_price_minor: payload.unitPriceMinor ?? payload.unit_price_minor ?? 40000,
            total_price_minor: payload.totalPriceMinor ?? payload.total_price_minor ?? 40000,
            created_at: now,
            updated_at: now,
            version: 1,
          });
        }
      }

      return {
        data: {
          success: true,
          command_id: rpcPayload.p_command_id,
          command_type: commandType,
        },
        error: null,
      };
    });

    const createRes = await createOrderWithPhase5Engine(
      dayId,
      customerId,
      [{ deviceTypeId, hasCharger: true }],
      'Initial notes',
    );
    expect(createRes.success, createRes.error).toBe(true);
    const orderId = createRes.order!.id;

    let outbox = await localDb.listOutbox();
    const createCmd = outbox.find((command) => command.commandType === 'CREATE_ORDER');
    expect(createCmd).toBeDefined();
    expect(createCmd?.commandId).toBe(orderId);
    expect(createCmd?.aggregateId).toBe(orderId);

    const transport = new SupabaseSyncTransport();
    const engine = new SyncEngine(transport);
    // Mirror the production SyncBridge wiring so this test exercises canonical
    // delta normalization and read-model reset, not the engine's generic fallback.
    engine.onDeltaApplied = applyRemoteChange;
    engine.onAuthoritativeReset = resetCanonicalReadModelsForReplay;
    await engine.synchronize();

    const refreshedCreateCmd = await localDb.getOutbox(createCmd!.commandId);
    expect(refreshedCreateCmd?.status).toBe('accepted');

    const editRes = await updateOrderWithPhase5Engine(orderId, 'Updated notes', 'pending', [], []);
    expect(editRes.success, editRes.error).toBe(true);

    outbox = await localDb.listOutbox();
    const allCreateCmds = outbox.filter((command) => command.commandType === 'CREATE_ORDER');
    expect(allCreateCmds.length).toBe(2);

    const originalCmd = allCreateCmds.find((command) => command.commandId === createCmd!.commandId);
    const editCmd = allCreateCmds.find((command) => command.commandId !== createCmd!.commandId);
    expect(originalCmd?.status).toBe('accepted');
    expect(editCmd?.status).toBe('pending');
    expect(editCmd?.commandId).not.toBe(originalCmd?.commandId);
    expect(editCmd?.aggregateId).toBe(orderId);
    expect((editCmd?.payload as any).notes).toBe('Updated notes');

    await engine.synchronize();
    const refreshedEditCmd = await localDb.getOutbox(editCmd!.commandId);
    expect(refreshedEditCmd?.status).toBe('accepted');

    const edit2Res = await updateOrderWithPhase5Engine(orderId, 'Second updated notes', 'pending', [], []);
    expect(edit2Res.success, edit2Res.error).toBe(true);

    outbox = await localDb.listOutbox();
    const allCreateCmdsAfter2 = outbox.filter((command) => command.commandType === 'CREATE_ORDER');
    expect(allCreateCmdsAfter2.length).toBe(3);

    const edit2Cmd = allCreateCmdsAfter2.find(
      (command) => command.commandId !== createCmd!.commandId && command.commandId !== editCmd!.commandId,
    );
    expect(edit2Cmd?.status).toBe('pending');
    expect(edit2Cmd?.commandId).not.toBe(editCmd?.commandId);
    expect(edit2Cmd?.commandId).not.toBe(createCmd!.commandId);
  });
});
