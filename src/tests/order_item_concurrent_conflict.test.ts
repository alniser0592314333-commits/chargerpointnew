/**
 * Multi-Device Same-Order-Item Concurrent Conflict Integration & Regression Suite
 * Tests concurrent update conflicts on the same Order Item across independent client device contexts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { localDb, IndexedDBLocalDatabase } from '../infrastructure/localDb/localDb';
import { SyncEngine, ServerSyncTransport, SyncCommandRequest, SyncCommandResponse, SyncPullResponse, ChangeLogEntry } from '../infrastructure/sync/syncEngine';
import { initializeCanonicalSyncState } from './utils/testSetup';

interface ServerOrderItem {
  id: string;
  orderId: string;
  deviceTypeId: string;
  status: 'charging' | 'delivered' | 'cancelled';
  totalPriceMinor: number;
  version: number;
  updatedAt: string;
}

interface ServerLedgerEntry {
  id: string;
  eventType: string;
  amountMinor: number;
  orderId: string;
  orderItemId: string;
  customerId: string;
  createdAt: string;
}

class AuthoritativeConcurrentServerTransport implements ServerSyncTransport {
  public serverItems = new Map<string, ServerOrderItem>();
  public serverLedger: ServerLedgerEntry[] = [];
  public changeLog: ChangeLogEntry[] = [];
  public currentSequence = 0;
  public processedCommands = new Map<string, SyncCommandResponse>();

  constructor() {
    // Initial seeded Order Item state: version = 5, status = 'charging'
    this.serverItems.set('item-555', {
      id: 'item-555',
      orderId: 'ord-100',
      deviceTypeId: 'dev-1',
      status: 'charging',
      totalPriceMinor: 3500,
      version: 5,
      updatedAt: '2026-09-25T10:00:00Z',
    });
  }

  async pushCommand(req: SyncCommandRequest): Promise<SyncCommandResponse> {
    // 1. Exact-Once Idempotency Check
    if (this.processedCommands.has(req.commandId)) {
      return this.processedCommands.get(req.commandId)!;
    }

    const item = this.serverItems.get(req.payload && (req.payload as any).orderItemId ? (req.payload as any).orderItemId : 'item-555');
    if (!item) {
      const resp: SyncCommandResponse = {
        success: false,
        error: 'Item not found on server [404]',
        httpStatus: 404,
        rpcReached: true,
      };
      this.processedCommands.set(req.commandId, resp);
      return resp;
    }

    // 2. Concurrency & Optimistic Version Check (Expected vs Actual Version)
    const expectedVersion = req.expectedVersion;
    if (expectedVersion !== undefined && expectedVersion !== item.version) {
      const conflictResp: SyncCommandResponse = {
        success: false,
        error: `VERSION_CONFLICT [409]: Aggregate version mismatch on order item ${item.id}. Expected version ${expectedVersion}, current server version is ${item.version}`,
        code: 'VERSION_CONFLICT',
        errorClass: 'CONFLICT',
        failureStage: 'RPC',
        httpStatus: 409,
        rpcReached: true,
      };
      this.processedCommands.set(req.commandId, conflictResp);
      return conflictResp;
    }

    // 3. Execute Valid Mutation
    if (req.commandType === 'DELIVER_ORDER_ITEM') {
      item.status = 'delivered';
      item.version += 1;
      item.updatedAt = new Date().toISOString();

      // Record financial recognition on server
      this.serverLedger.push({
        id: `ledg-del-${req.commandId}`,
        eventType: 'ORDER_ITEM_CHARGE',
        amountMinor: -item.totalPriceMinor,
        orderId: item.orderId,
        orderItemId: item.id,
        customerId: 'cust-1',
        createdAt: item.updatedAt,
      });

      // Emit change_log entry
      this.currentSequence += 1;
      this.changeLog.push({
        sequenceId: this.currentSequence,
        entityType: 'order_items',
        entityId: item.id,
        action: 'UPDATE',
        payload: { ...item },
        changedAt: item.updatedAt,
      });

      const successResp: SyncCommandResponse = {
        success: true,
        serverVersion: item.version,
        rpcReached: true,
      };
      this.processedCommands.set(req.commandId, successResp);
      return successResp;
    }

    if (req.commandType === 'CANCEL_ORDER_ITEM') {
      item.status = 'cancelled';
      item.version += 1;
      item.updatedAt = new Date().toISOString();

      // Emit change_log entry
      this.currentSequence += 1;
      this.changeLog.push({
        sequenceId: this.currentSequence,
        entityType: 'order_items',
        entityId: item.id,
        action: 'UPDATE',
        payload: { ...item },
        changedAt: item.updatedAt,
      });

      const successResp: SyncCommandResponse = {
        success: true,
        serverVersion: item.version,
        rpcReached: true,
      };
      this.processedCommands.set(req.commandId, successResp);
      return successResp;
    }

    const fallbackResp: SyncCommandResponse = { success: true, serverVersion: item.version + 1, rpcReached: true };
    this.processedCommands.set(req.commandId, fallbackResp);
    return fallbackResp;
  }

  async pullChanges(cursor: number): Promise<SyncPullResponse> {
    const relevant = this.changeLog.filter((c) => c.sequenceId > cursor);
    return {
       changes: relevant,
       latestSequence: this.currentSequence,
       serverResetGeneration: 1,
    };
  }
}

describe('Multi-Device Same-Order-Item Concurrent Conflict Integration Suite', () => {
  let serverTransport: AuthoritativeConcurrentServerTransport;
  let deviceADb: IndexedDBLocalDatabase;
  let deviceBDb: IndexedDBLocalDatabase;
  let engineA: SyncEngine;
  let engineB: SyncEngine;

  beforeEach(async () => {
    serverTransport = new AuthoritativeConcurrentServerTransport();

    // Isolated client databases representing independent physical devices
    deviceADb = new IndexedDBLocalDatabase();
    deviceBDb = new IndexedDBLocalDatabase();
    await deviceADb.clear();
    await deviceBDb.clear();

    await deviceADb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 0,
      lastPulledAt: '',
      resetGeneration: 1,
      status: 'READY',
    });
    await deviceBDb.setSyncState({
      table: 'global',
      lastAppliedChangeSequence: 0,
      lastPulledAt: '',
      resetGeneration: 1,
      status: 'READY',
    });

    engineA = new SyncEngine(serverTransport);
    engineB = new SyncEngine(serverTransport);
  });

  it('Scenario 1: DELIVER (Device A) wins, CANCEL (Device B) conflicts and is rejected without financial pollution', async () => {
    const targetItemId = 'item-555';
    const initialExpectedVersion = 5;

    // 1. Device A queues DELIVER_ORDER_ITEM with expectedVersion = 5
    const cmdDeliverId = 'cmd-devA-deliver-01';
    await deviceADb.saveOutbox({
      commandId: cmdDeliverId,
      commandType: 'DELIVER_ORDER_ITEM',
      aggregateType: 'order_items',
      aggregateId: targetItemId,
      payload: { orderItemId: targetItemId, bin: '1234', resetGeneration: 1 },
      expectedVersion: initialExpectedVersion,
      createdAt: new Date().toISOString(),
      deviceId: 'device_A_phone',
      actorAdminId: 'admin_1',
      status: 'pending',
      retryCount: 0,
    });

    // 2. Device B queues CANCEL_ORDER_ITEM concurrently with expectedVersion = 5
    const cmdCancelId = 'cmd-devB-cancel-02';
    await deviceBDb.saveOutbox({
      commandId: cmdCancelId,
      commandType: 'CANCEL_ORDER_ITEM',
      aggregateType: 'order_items',
      aggregateId: targetItemId,
      payload: { orderItemId: targetItemId, resetGeneration: 1 },
      expectedVersion: initialExpectedVersion,
      createdAt: new Date().toISOString(),
      deviceId: 'device_B_tablet',
      actorAdminId: 'admin_2',
      status: 'pending',
      retryCount: 0,
    });

    // 3. Device A syncs first -> succeeds (5 -> 6)
    vi.spyOn(localDb, 'listOutbox').mockImplementation(() => deviceADb.listOutbox());
    vi.spyOn(localDb, 'saveOutbox').mockImplementation((r) => deviceADb.saveOutbox(r));
    vi.spyOn(localDb, 'getSyncState').mockImplementation((t) => deviceADb.getSyncState(t));
    vi.spyOn(localDb, 'setSyncState').mockImplementation((r) => deviceADb.setSyncState(r));
    vi.spyOn(localDb, 'saveHistory').mockImplementation((h) => deviceADb.saveHistory(h));
    vi.spyOn(localDb, 'getHistoryByCommandId').mockImplementation((id) => deviceADb.getHistoryByCommandId(id));

    const syncResA = await engineA.synchronize();
    expect(syncResA.pushed).toBe(1);

    const deliverRecordA = await deviceADb.getOutbox(cmdDeliverId);
    expect(deliverRecordA?.status).toBe('accepted');

    // Verify Server state after Device A: version is now 6, status is delivered
    const serverItemAfterA = serverTransport.serverItems.get(targetItemId);
    expect(serverItemAfterA?.version).toBe(6);
    expect(serverItemAfterA?.status).toBe('delivered');

    // Verify Exactly ONE financial ledger entry exists on server
    expect(serverTransport.serverLedger.length).toBe(1);
    expect(serverTransport.serverLedger[0].eventType).toBe('ORDER_ITEM_CHARGE');
    expect(serverTransport.serverLedger[0].amountMinor).toBe(-3500);

    // 4. Device B syncs second -> rejected as CONFLICT (expected 5 !== current 6)
    vi.spyOn(localDb, 'listOutbox').mockImplementation(() => deviceBDb.listOutbox());
    vi.spyOn(localDb, 'saveOutbox').mockImplementation((r) => deviceBDb.saveOutbox(r));
    vi.spyOn(localDb, 'getSyncState').mockImplementation((t) => deviceBDb.getSyncState(t));
    vi.spyOn(localDb, 'setSyncState').mockImplementation((r) => deviceBDb.setSyncState(r));
    vi.spyOn(localDb, 'saveHistory').mockImplementation((h) => deviceBDb.saveHistory(h));
    vi.spyOn(localDb, 'getHistoryByCommandId').mockImplementation((id) => deviceBDb.getHistoryByCommandId(id));

    const syncResB = await engineB.synchronize();
    expect(syncResB.pushed).toBe(0);

    // Verify Device B outbox is marked as CONFLICT
    const cancelRecordB = await deviceBDb.getOutbox(cmdCancelId);
    expect(cancelRecordB?.status).toBe('conflict');
    expect(cancelRecordB?.lastError).toContain('VERSION_CONFLICT');

    // Verify SyncHistory on Device B is CONFLICT and retryEligible is false
    const historyB = await deviceBDb.getHistoryByCommandId(cmdCancelId);
    expect(historyB?.state).toBe('CONFLICT');
    expect(historyB?.errorClass).toBe('CONFLICT');
    expect(historyB?.retryEligible).toBe(false);

    // 5. Verify Change Log Integrity:
    // Exactly ONE change_log event for the winning mutation, ZERO for the losing command
    const itemChangeLogs = serverTransport.changeLog.filter((c) => c.entityId === targetItemId);
    expect(itemChangeLogs.length).toBe(1);
    expect(itemChangeLogs[0].payload).toMatchObject({ status: 'delivered', version: 6 });

    // 6. Verify Financial Safety:
    // Financial ledger still has ONLY the 1 charge from Device A, NO duplicate charge or reversal
    expect(serverTransport.serverLedger.length).toBe(1);

    // 7. Idempotent Retry: Retrying Device B sync must not alter state or produce duplicate events
    const retryResB = await engineB.synchronize();
    expect(retryResB.pushed).toBe(0);
    expect(serverTransport.serverLedger.length).toBe(1);
    expect(serverTransport.changeLog.filter((c) => c.entityId === targetItemId).length).toBe(1);
  });

  it('Scenario 2: CANCEL (Device B) wins, DELIVER (Device A) conflicts and is rejected without duplicate recognition', async () => {
    const targetItemId = 'item-555';
    const initialExpectedVersion = 5;

    // 1. Device B queues CANCEL_ORDER_ITEM with expectedVersion = 5
    const cmdCancelId = 'cmd-devB-cancel-win';
    await deviceBDb.saveOutbox({
      commandId: cmdCancelId,
      commandType: 'CANCEL_ORDER_ITEM',
      aggregateType: 'order_items',
      aggregateId: targetItemId,
      payload: { orderItemId: targetItemId, resetGeneration: 1 },
      expectedVersion: initialExpectedVersion,
      createdAt: new Date().toISOString(),
      deviceId: 'device_B_tablet',
      actorAdminId: 'admin_2',
      status: 'pending',
      retryCount: 0,
    });

    // 2. Device A queues DELIVER_ORDER_ITEM with expectedVersion = 5
    const cmdDeliverId = 'cmd-devA-deliver-lose';
    await deviceADb.saveOutbox({
      commandId: cmdDeliverId,
      commandType: 'DELIVER_ORDER_ITEM',
      aggregateType: 'order_items',
      aggregateId: targetItemId,
      payload: { orderItemId: targetItemId, bin: '9999', resetGeneration: 1 },
      expectedVersion: initialExpectedVersion,
      createdAt: new Date().toISOString(),
      deviceId: 'device_A_phone',
      actorAdminId: 'admin_1',
      status: 'pending',
      retryCount: 0,
    });

    // 3. Device B syncs first -> CANCEL wins
    vi.spyOn(localDb, 'listOutbox').mockImplementation(() => deviceBDb.listOutbox());
    vi.spyOn(localDb, 'saveOutbox').mockImplementation((r) => deviceBDb.saveOutbox(r));
    vi.spyOn(localDb, 'getSyncState').mockImplementation((t) => deviceBDb.getSyncState(t));
    vi.spyOn(localDb, 'setSyncState').mockImplementation((r) => deviceBDb.setSyncState(r));
    vi.spyOn(localDb, 'saveHistory').mockImplementation((h) => deviceBDb.saveHistory(h));
    vi.spyOn(localDb, 'getHistoryByCommandId').mockImplementation((id) => deviceBDb.getHistoryByCommandId(id));

    const syncResB = await engineB.synchronize();
    expect(syncResB.pushed).toBe(1);

    const cancelRecordB = await deviceBDb.getOutbox(cmdCancelId);
    expect(cancelRecordB?.status).toBe('accepted');

    const serverItem = serverTransport.serverItems.get(targetItemId);
    expect(serverItem?.version).toBe(6);
    expect(serverItem?.status).toBe('cancelled');

    // 4. Device A syncs second -> DELIVER is rejected as CONFLICT
    vi.spyOn(localDb, 'listOutbox').mockImplementation(() => deviceADb.listOutbox());
    vi.spyOn(localDb, 'saveOutbox').mockImplementation((r) => deviceADb.saveOutbox(r));
    vi.spyOn(localDb, 'getSyncState').mockImplementation((t) => deviceADb.getSyncState(t));
    vi.spyOn(localDb, 'setSyncState').mockImplementation((r) => deviceADb.setSyncState(r));
    vi.spyOn(localDb, 'saveHistory').mockImplementation((h) => deviceADb.saveHistory(h));
    vi.spyOn(localDb, 'getHistoryByCommandId').mockImplementation((id) => deviceADb.getHistoryByCommandId(id));

    const syncResA = await engineA.synchronize();
    expect(syncResA.pushed).toBe(0);

    const deliverRecordA = await deviceADb.getOutbox(cmdDeliverId);
    expect(deliverRecordA?.status).toBe('conflict');
    expect(deliverRecordA?.lastError).toContain('VERSION_CONFLICT');

    // Zero financial entries created because CANCEL won and DELIVER was blocked
    expect(serverTransport.serverLedger.length).toBe(0);

    // Exactly one change_log event (CANCEL version 6)
    const logs = serverTransport.changeLog.filter((c) => c.entityId === targetItemId);
    expect(logs.length).toBe(1);
    expect(logs[0].payload).toMatchObject({ status: 'cancelled', version: 6 });
  });
});
