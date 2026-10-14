import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as supabaseClient from '../services/supabase/client';
import { SyncEngine } from '../infrastructure/sync/syncEngine';
import { setTestAppAuthSession } from './utils/testSetup';
import { SupabaseSyncTransport } from '../infrastructure/sync/SupabaseSyncTransport';
import { localDb } from '../infrastructure/localDb/localDb';
import { globalSyncBridge } from '../infrastructure/sync/syncBridge';
import {
  addDeviceTypeWithPhase5,
  updateDeviceTypeWithPhase5,
  deleteDeviceTypeWithPhase5,
  getAllDeviceTypes,
  resetStoreMemory,
  ensureStoreHydrated,
  applyRemoteChange,
  setTransactionCommittedHook,
} from '../components/pages/dayOrdersStore';

describe('UPDATE_DEVICE_TYPE Canonical Command Repair & Verification Suite', () => {
  let serverDeviceTypes: Map<string, any>;
  let serverProcessedCommands: Map<string, any>;
  let serverChangeLog: any[];
  let serverResetGeneration: number;

  const storageMap = new Map<string, string>();
  const localStorageMock = {
    getItem: (key: string) => storageMap.get(key) || null,
    setItem: (key: string, val: string) => storageMap.set(key, String(val)),
    removeItem: (key: string) => storageMap.delete(key),
    clear: () => storageMap.clear(),
  };

  beforeEach(async () => {
    setTransactionCommittedHook(() => {});
    (globalThis as any).localStorage = localStorageMock;
    storageMap.clear();
    localStorageMock.setItem('sys_db_version', '6.10.3D');
    localStorageMock.setItem('app_device_id', 'test_device');
    setTestAppAuthSession();

    await localDb.init();
    await localDb.clear();
    resetStoreMemory();
    await ensureStoreHydrated();

    serverDeviceTypes = new Map();
    serverProcessedCommands = new Map();
    serverChangeLog = [];
    serverResetGeneration = 15;

    await localDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 0,
      lastPulledAt: '',
      resetGeneration: 15,
      status: 'READY',
    });

    supabaseClient.clearStoredSupabaseAuthSession();
    supabaseClient.setSupabaseAuthToken('mock-jwt');
    vi.restoreAllMocks();

    // 1. Mock invokeSupabaseRpc to match exact execute_canonical_sync_command update logic
    vi.spyOn(supabaseClient, 'invokeSupabaseRpc').mockImplementation(async (fnName, payload: any) => {
      if (fnName === 'pull_canonical_changes') {
        const afterSequence = Number(payload?.p_since_sequence ?? 0);
        const changes = serverChangeLog.filter(
          (change) => Number(change.sequence_id) > afterSequence,
        );
        const latestSequence = changes.length
          ? Math.max(...changes.map((change) => Number(change.sequence_id)))
          : afterSequence;
        return {
          data: {
            changes,
            latestSequence,
            serverResetGeneration,
          },
          error: null,
        };
      }
      if (fnName === 'execute_sync_command') {
        const { p_command_id, p_command_type, p_payload } = payload;
        const p_expected_version = payload.p_expected_version;

        // Idempotency check
        if (serverProcessedCommands.has(p_command_id)) {
          return {
            data: {
              success: true,
              commandId: p_command_id,
              commandType: p_command_type,
              result: serverProcessedCommands.get(p_command_id),
            },
            error: null,
          };
        }

        // Stale generation check
        const cmdGen = p_payload.resetGeneration || 1;
        if (cmdGen < serverResetGeneration) {
          return {
            data: null,
            error: `Reset Generation Mismatch [P0002]: Command generation ${cmdGen} is older than server reset generation ${serverResetGeneration}`,
          };
        }

        if (p_command_type === 'CREATE_DEVICE_TYPE') {
          const id = p_payload.id || p_command_id;
          const current = serverDeviceTypes.get(id) || { version: 0 };
          const updated = {
            id,
            name: p_payload.name,
            nameAr: p_payload.nameAr || p_payload.name,
            nameEn: p_payload.nameEn || p_payload.name,
            icon: p_payload.icon || 'smartphone',
            base_price_minor: p_payload.basePriceMinor || 0,
            charger_fee_enabled: p_payload.chargerFeeEnabled !== false,
            is_active: p_payload.isActive !== false,
            sort_order: p_payload.sortOrder || 0,
            version: current.version + 1,
          };
          serverDeviceTypes.set(id, updated);
          serverProcessedCommands.set(p_command_id, { deviceTypeId: id });
          serverChangeLog.push({
            sequence_id: serverChangeLog.length + 1,
            entity_type: 'device_types',
            entity_id: id,
            action: 'INSERT',
            payload: updated,
            version: updated.version,
          });
          return {
            data: { success: true, commandId: p_command_id, commandType: p_command_type, result: { deviceTypeId: id } },
            error: null,
          };
        }

        if (p_command_type === 'UPDATE_DEVICE_TYPE') {
          const id = p_payload.id || payload.p_aggregate_id || payload.p_entity_id;
          if (!id) {
            return { data: null, error: 'Validation Error [P2201]: Device Type ID must be a valid UUID' };
          }
          const current = serverDeviceTypes.get(id);
          if (!current) {
            return { data: null, error: `Device Type Not Found [23503]: ID ${id}` };
          }

          // Expected version check
          if (p_expected_version !== null && p_expected_version !== undefined) {
            if (current.version !== p_expected_version) {
              return {
                data: null,
                error: `VERSION_CONFLICT [409]: Aggregate version mismatch on device type ${id}. Expected version ${p_expected_version}, current server version is ${current.version}`,
              };
            }
          }

          const updated = {
            ...current,
            name: p_payload.name || current.name,
            nameAr: p_payload.nameAr || p_payload.name_ar || current.nameAr,
            nameEn: p_payload.nameEn || p_payload.name_en || current.nameEn,
            base_price_minor: p_payload.basePriceMinor !== undefined ? p_payload.basePriceMinor : current.base_price_minor,
            charger_fee_enabled: p_payload.chargerFeeEnabled !== undefined ? p_payload.chargerFeeEnabled : current.charger_fee_enabled,
            is_active: p_payload.isActive !== undefined ? p_payload.isActive : current.is_active,
            sort_order: p_payload.sortOrder !== undefined ? p_payload.sortOrder : current.sort_order,
            version: current.version + 1,
          };
          serverDeviceTypes.set(id, updated);
          serverProcessedCommands.set(p_command_id, { deviceTypeId: id, version: updated.version });
          serverChangeLog.push({
            sequence_id: serverChangeLog.length + 1,
            entity_type: 'device_types',
            entity_id: id,
            action: 'UPDATE',
            payload: updated,
            version: updated.version,
          });
          return {
            data: { success: true, commandId: p_command_id, commandType: p_command_type, result: { deviceTypeId: id, version: updated.version } },
            error: null,
          };
        }

        if (p_command_type === 'RETIRE_DEVICE_TYPE' || p_command_type === 'DELETE_DEVICE_TYPE') {
          const id = p_payload.id || payload.p_aggregate_id || payload.p_entity_id;
          const current = serverDeviceTypes.get(id);
          if (!current) {
            return { data: null, error: 'Device Type Not Found [23503]' };
          }
          const updated = { ...current, status: 'RETIRED', is_active: false, version: current.version + 1 };
          serverDeviceTypes.set(id, updated);
          serverProcessedCommands.set(p_command_id, { deviceTypeId: id, status: 'RETIRED' });
          serverChangeLog.push({
            sequence_id: serverChangeLog.length + 1,
            entity_type: 'device_types',
            entity_id: id,
            action: 'UPDATE',
            payload: { id, status: 'RETIRED' },
            version: updated.version,
          });
          return {
            data: { success: true, commandId: p_command_id, commandType: p_command_type, result: { deviceTypeId: id, status: 'RETIRED' } },
            error: null,
          };
        }

        return {
          data: null,
          error: `Unknown Canonical Command Type [P0001]: ${p_command_type}`,
        };
      }
      return { data: null, error: 'Unknown RPC' };
    });

    // 2. Mock invokeSupabaseRestGet to simulate system settings and change log deltas
    vi.spyOn(supabaseClient, 'invokeSupabaseRestGet').mockImplementation(async (table: string, queryParams?: string) => {
      if (table === 'system_settings') {
        return { data: [{ value_number: serverResetGeneration }], error: null };
      }
      if (table === 'change_log') {
        let seq = 0;
        if (queryParams && queryParams.includes('sequence_id=gt.')) {
          const match = queryParams.match(/sequence_id=gt\.(\d+)/);
          if (match) seq = parseInt(match[1], 10);
        }
        const filtered = serverChangeLog.filter(c => c.sequence_id > seq);
        return { data: filtered, error: null };
      }
      return { data: [], error: null };
    });
  });

  afterEach(() => {
    setTransactionCommittedHook(() => {
      globalSyncBridge.notifyOutboxWorkAvailable().catch(() => {});
    });
    vi.restoreAllMocks();
  });

  // TEST A: UPDATE DEVICE TYPE SUCCESS
  it('TEST A — UPDATE DEVICE TYPE SUCCESS: updates fields, triggers change log, increments version', async () => {
    // 1. Create a device type
    const createRes = await addDeviceTypeWithPhase5('شاشة آيفون', 450, true, true as any, 5 as any);
    expect(createRes.success).toBe(true);
    const id = createRes.data!.id;

    // 2. Perform outbox sync so it exists on our mock server
    const transport = new SupabaseSyncTransport();
    const engine = new SyncEngine(transport);
    const syncRes1 = await engine.synchronize();
    expect(syncRes1.pushed).toBe(1); // single CREATE_DEVICE_TYPE mutation

    // Verify it exists on mock server with version 1
    const serverDevBefore = serverDeviceTypes.get(id);
    expect(serverDevBefore).toBeDefined();
    expect(serverDevBefore.nameAr).toBe('شاشة آيفون');
    expect(serverDevBefore.version).toBe(1);

    // 3. Edit/Update Device Type
    const editRes = await updateDeviceTypeWithPhase5(id, {
      nameAr: 'شاشة آيفون معدلة',
      nameEn: 'iPhone Screen Edited',
      priceMinor: 50000,
      chargerFeeEnabled: false,
      isActive: true,
      sortOrder: 10,
    });
    expect(editRes.success).toBe(true);

    // Wait for the non-blocking background IndexedDB transaction to settle
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Local DB updated immediately (offline-first)
    const localDev = (await localDb.get('deviceTypes', id)) as any;
    expect(localDev.nameAr).toBe('شاشة آيفون معدلة');
    expect(localDev.nameEn).toBe('iPhone Screen Edited');
    expect(localDev.basePriceMinor).toBe(50000);
    expect(localDev.version).toBe(2);

    // Outbox contains UPDATE_DEVICE_TYPE command
    const outboxBefore = await localDb.listOutbox();
    const updateCmd = outboxBefore.find(o => o.commandType === 'UPDATE_DEVICE_TYPE' && o.status === 'pending');
    expect(updateCmd).toBeDefined();
    expect(updateCmd?.expectedVersion).toBe(1);

    // 4. Synchronize to Server
    const syncRes2 = await engine.synchronize();
    expect(syncRes2.pushed).toBe(1);

    // Server accepted successfully
    const serverDevAfter = serverDeviceTypes.get(id);
    expect(serverDevAfter.nameAr).toBe('شاشة آيفون معدلة');
    expect(serverDevAfter.version).toBe(2);

    // Change log contains UPDATE action
    const latestChange = serverChangeLog[serverChangeLog.length - 1];
    expect(latestChange.action).toBe('UPDATE');
    expect(latestChange.entity_id).toBe(id);
  });

  // TEST B: UNKNOWN COMMAND REGRESSION
  it('TEST B — UNKNOWN COMMAND REGRESSION: UPDATE_DEVICE_TYPE is handled on execute_sync_command path without errors', async () => {
    // 1. Create a device type
    const createRes = await addDeviceTypeWithPhase5('شاشة سامسونج', 300, true, true as any, 1 as any);
    const id = createRes.data!.id;

    const transport = new SupabaseSyncTransport();
    const engine = new SyncEngine(transport);
    await engine.synchronize();

    // 2. Update it
    await updateDeviceTypeWithPhase5(id, { nameAr: 'شاشة سامسونج حديثة' });

    // Wait for local DB to settle
    await new Promise((resolve) => setTimeout(resolve, 80));

    const syncRes = await engine.synchronize();
    expect(syncRes.pushed).toBe(1); // pushes the 1 update command (the previous 2 create/update are already synced)

    const outboxAfter = await localDb.listOutbox();
    expect(outboxAfter.every(o => o.status === 'accepted')).toBe(true);
  });

  // TEST C: VERSION CONFLICT
  it('TEST C — VERSION CONFLICT: rejects update if client version is stale and prevents duplicate logs', async () => {
    // 1. Setup device type on server with version 2
    const id = '00000000-0000-4000-a000-000000000001';
    serverDeviceTypes.set(id, { id, nameAr: 'شاشة', version: 2 });

    // 2. Queue command on local outbox with expectedVersion = 1 (stale version conflict)
    await localDb.set('deviceTypes', id, { id, nameAr: 'شاشة معدلة', version: 1 });
    await localDb.saveOutbox({
      commandId: 'cmd-conflict-1',
      commandType: 'UPDATE_DEVICE_TYPE',
      aggregateType: 'device_types',
      aggregateId: id,
      payload: { id, nameAr: 'شاشة معدلة', name: 'شاشة معدلة' },
      expectedVersion: 1,
      status: 'pending',
      resetGeneration: 15,
      createdAt: new Date().toISOString(),
      deviceId: 'test_device',
      actorAdminId: 'test_admin_user',
      retryCount: 0,
    });

    const transport = new SupabaseSyncTransport();
    const engine = new SyncEngine(transport);

    const initialChangeLogLength = serverChangeLog.length;

    // 3. Synchronize -> must fail with VERSION_CONFLICT
    const syncRes = await engine.synchronize();
    expect(syncRes.pushed).toBe(0); // Not pushed successfully

    const outbox = await localDb.listOutbox();
    expect(outbox[0].status).toBe('conflict');
    expect(outbox[0].lastError).toContain('VERSION_CONFLICT');

    // Verify server state preserved and no duplicate change log
    expect(serverDeviceTypes.get(id).version).toBe(2);
    expect(serverChangeLog.length).toBe(initialChangeLogLength);
  });

  // TEST D: IDEMPOTENCY
  it('TEST D — IDEMPOTENCY: prevents duplicate updates on replay of same command ID', async () => {
    const id = '00000000-0000-4000-a000-000000000002';
    serverDeviceTypes.set(id, { id, nameAr: 'قديم', version: 1 });

    const transport = new SupabaseSyncTransport();

    // 1. Dispatch first time
    const res1 = await transport.pushCommand({
      commandId: 'cmd-idempotent-2',
      commandType: 'UPDATE_DEVICE_TYPE',
      payload: { id, nameAr: 'جديد', name: 'جديد' },
      expectedVersion: 1,
      deviceId: 'device-1',
      actorAdminId: 'admin-1',
      resetGeneration: 15,
    });
    expect(res1.success).toBe(true);
    expect(serverDeviceTypes.get(id).version).toBe(2);
    const initialChangeLogLength = serverChangeLog.length;

    // 2. Dispatch second time (replay)
    const res2 = await transport.pushCommand({
      commandId: 'cmd-idempotent-2',
      commandType: 'UPDATE_DEVICE_TYPE',
      payload: { id, nameAr: 'جديد', name: 'جديد' },
      expectedVersion: 1,
      deviceId: 'device-1',
      actorAdminId: 'admin-1',
      resetGeneration: 15,
    });
    expect(res2.success).toBe(true);

    // No duplicate increment, no duplicate change log
    expect(serverDeviceTypes.get(id).version).toBe(2);
    expect(serverChangeLog.length).toBe(initialChangeLogLength);
  });

  // TEST E: INVALID UUID
  it('TEST E — INVALID UUID: validates device ID format before dispatch', async () => {
    const invalidId = 'not-a-valid-uuid-1234';
    const res = await updateDeviceTypeWithPhase5(invalidId, { nameAr: 'جهاز' });
    expect(res.success).toBe(false);
    expect(res.error).toBeDefined(); // Clean local validation check prevents sending invalid UUID to server!
  });

  // TEST F: RESET GENERATION
  it('TEST F — RESET GENERATION: allows current generation, rejects stale generation', async () => {
    // 1. Current generation works
    const createRes = await addDeviceTypeWithPhase5('جهاز صالح', 200, true, true as any, 1 as any);
    expect(createRes.success).toBe(true);

    const transport = new SupabaseSyncTransport();
    const engine = new SyncEngine(transport);
    const syncRes1 = await engine.synchronize();
    expect(syncRes1.pushed).toBe(1);

    // 2. Stale generation rejects (Server Gen has advanced to 16, client stays at 15)
    serverResetGeneration = 16;
    await updateDeviceTypeWithPhase5(createRes.data!.id, { nameAr: 'تعديل جيل قديم' });

    // Wait for local DB to settle
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Since our syncState is still at resetGeneration: 15, synchronize will trigger quarantine protection
    const syncRes2 = await engine.synchronize();
    expect(syncRes2.pushed).toBe(0);

    const outbox = await localDb.listOutbox();
    const staleCmd = outbox.find(o => o.payload && ((o.payload as any).nameAr === 'تعديل جيل قديم' || (o.payload as any).name_ar === 'تعديل جيل قديم'));
    expect(staleCmd?.status).toBe('rejected');
    expect(staleCmd?.lastError).toContain('RESET_GENERATION_MISMATCH');
  });

  // TEST G: MULTI-DEVICE DELTA
  it('TEST G — MULTI-DEVICE DELTA: Device B receives delta updates correctly without reloading the whole table', async () => {
    // 1. Device A creates and updates device type on server
    const id = '00000000-0000-4000-a000-000000000003';
    serverDeviceTypes.set(id, { id, name: 'جهاز مشترك', nameAr: 'جهاز مشترك', version: 1 });
    serverChangeLog.push({
      sequence_id: 1,
      entity_type: 'device_types',
      entity_id: id,
      action: 'INSERT',
      payload: { id, name: 'جهاز مشترك', nameAr: 'جهاز مشترك', version: 1 },
      version: 1,
    });

    // Device A updates it
    serverDeviceTypes.set(id, { id, name: 'جهاز مشترك معدل من A', nameAr: 'جهاز مشترك معدل من A', version: 2 });
    serverChangeLog.push({
      sequence_id: 2,
      entity_type: 'device_types',
      entity_id: id,
      action: 'UPDATE',
      payload: { id, name: 'جهاز مشترك معدل من A', nameAr: 'جهاز مشترك معدل من A', version: 2 },
      version: 2,
    });

    // 2. Device B has original state (version 1)
    await localDb.set('deviceTypes', id, { id, nameAr: 'جهاز مشترك', version: 1 });

    const transport = new SupabaseSyncTransport();
    const engine = new SyncEngine(transport);
    engine.onDeltaApplied = applyRemoteChange;

    // 3. Device B synchronizes (performs pullChanges delta pull)
    await engine.synchronize();

    // Wait for the non-blocking background IndexedDB transaction to settle
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Device B has now synchronized the updated fields without full table refresh
    const localDevB = (await localDb.get('deviceTypes', id)) as any;
    expect(localDevB).toBeDefined();
    expect(localDevB.nameAr).toBe('جهاز مشترك معدل من A');
    expect(localDevB.version).toBe(2);
  });

  // TEST H: RETIRE SEPARATION
  it('TEST H — RETIRE SEPARATION: UPDATE_DEVICE_TYPE and RETIRE_DEVICE_TYPE remain separate semantic operations', async () => {
    const id = '00000000-0000-4000-a000-000000000004';
    serverDeviceTypes.set(id, { id, nameAr: 'جهاز نشط', version: 1, is_active: true, status: 'ACTIVE' });

    const transport = new SupabaseSyncTransport();
    const engine = new SyncEngine(transport);
    engine.onDeltaApplied = applyRemoteChange;

    // 1. UPDATE_DEVICE_TYPE doesn't retire
    await localDb.set('deviceTypes', id, { id, nameAr: 'جهاز نشط معدل', version: 1, is_active: true, status: 'ACTIVE' });
    resetStoreMemory();
    await ensureStoreHydrated();
    await updateDeviceTypeWithPhase5(id, { nameAr: 'جهاز نشط معدل' });

    // Wait for local DB to settle
    await new Promise((resolve) => setTimeout(resolve, 80));

    await engine.synchronize();

    expect(serverDeviceTypes.get(id).status).toBe('ACTIVE');
    expect(serverDeviceTypes.get(id).is_active).toBe(true);

    // 2. deleteDeviceTypeWithPhase5 produces DELETE_DEVICE_TYPE command
    await deleteDeviceTypeWithPhase5(id);

    // Wait for local DB to settle
    await new Promise((resolve) => setTimeout(resolve, 80));

    const outbox = await localDb.listOutbox();
    const deleteCmd = outbox.find(o => o.commandType === 'DELETE_DEVICE_TYPE');
    expect(deleteCmd).toBeDefined();

    await engine.synchronize();
    expect(serverDeviceTypes.get(id).status).toBe('RETIRED');
    expect(serverDeviceTypes.get(id).is_active).toBe(false);
  });
});
