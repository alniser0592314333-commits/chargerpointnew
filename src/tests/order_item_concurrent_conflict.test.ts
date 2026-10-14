/**
 * Multi-Device Same-Order-Item Concurrent Conflict Integration & Regression Suite
 * Tests concurrent update conflicts on the same Order Item across independent client device contexts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
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

    if (req.commandType === 'DELIVER_ORDER_ITEM') {
      item.status = 'delivered';
      item.version += 1;
      item.updatedAt = new Date().toISOString();

      this.serverLedger.push({
        id: `ledg-del-${req.commandId}`,
        eventType: 'ORDER_ITEM_CHARGE',
        amountMinor: -item.totalPriceMinor,
        orderId: item.orderId,
        orderItemId: item.id,
        customerId: 'cust-1',
        createdAt: item.updatedAt,
      });

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
  let engineA: SyncEngine;
  let engineB: SyncEngine;

  beforeEach(async () => {
    serverTransport = new AuthoritativeConcurrentServerTransport();
    await localDb.clear();
    await initializeCanonicalSyncState();
    // The scheduler requires the referenced aggregate to exist on this device,
    // just as it would on a real device before delivery/cancellation is queued.
    await localDb.set('orders', 'ord-100', {
      id: 'ord-100',
      customerId: 'cust-1',
      businessDayId: 'day-1',
      status: 'charging',
      version: 5,
      createdAt: '2026-09-25T09:00:00Z',
      updatedAt: '2026-09-25T10:00:00Z',
    });
    await localDb.set('orderItems', 'item-555', {
      id: 'item-555',
      orderId: 'ord-100',
      deviceTypeId: 'dev-1',
      itemSequence: 1,
      status: 'charging',
      totalPriceMinor: 3500,
      version: 5,
      createdAt: '2026-09-25T10:00:00Z',
      updatedAt: '2026-09-25T10:00:00Z',
    });

    engineA = new SyncEngine(serverTransport);
    engineB = new SyncEngine(serverTransport);
  });

  it('Scenario 1: DELIVER wins, CANCEL conflicts and is rejected without financial pollution', async () => {
    const targetItemId = 'item-555';
    const initialExpectedVersion = 5;

    const cmdDeliverId = 'cmd-devA-deliver-01';
    await engineA.queueCommand(
      cmdDeliverId,
      'DELIVER_ORDER_ITEM',
      'order_items',
      targetItemId,
      { orderItemId: targetItemId, orderId: 'ord-100', bin: '1234', resetGeneration: 1 },
      'device_A_phone',
      'admin_1',
      initialExpectedVersion
    );

    const cmdCancelId = 'cmd-devB-cancel-02';
    await engineB.queueCommand(
      cmdCancelId,
      'CANCEL_ORDER_ITEM',
      'order_items',
      targetItemId,
      { orderItemId: targetItemId, orderId: 'ord-100', resetGeneration: 1 },
      'device_B_tablet',
      'admin_2',
      initialExpectedVersion
    );

    // Device A syncs first -> succeeds (5 -> 6)
    const syncResA = await engineA.synchronize();
    expect(syncResA.pushed).toBe(1);

    const deliverRecordA = await localDb.getOutbox(cmdDeliverId);
    expect(deliverRecordA?.status).toBe('accepted');

    const serverItemAfterA = serverTransport.serverItems.get(targetItemId);
    expect(serverItemAfterA?.version).toBe(6);
    expect(serverItemAfterA?.status).toBe('delivered');

    expect(serverTransport.serverLedger.length).toBe(1);
    expect(serverTransport.serverLedger[0].eventType).toBe('ORDER_ITEM_CHARGE');
    expect(serverTransport.serverLedger[0].amountMinor).toBe(-3500);

    const syncResB = await engineB.synchronize();
    expect(syncResB.pushed).toBe(0);

    const cancelRecordB = await localDb.getOutbox(cmdCancelId);
    expect(cancelRecordB?.status).toBe('conflict');
    expect(cancelRecordB?.lastError).toContain('VERSION_CONFLICT');

    const historyB = await localDb.getHistoryByCommandId(cmdCancelId);
    expect(historyB?.state).toBe('CONFLICT');
    expect(historyB?.errorClass).toBe('CONFLICT');
    expect(historyB?.retryEligible).toBe(false);

    const itemChangeLogs = serverTransport.changeLog.filter((c) => c.entityId === targetItemId);
    expect(itemChangeLogs.length).toBe(1);
    expect(itemChangeLogs[0].payload).toMatchObject({ status: 'delivered', version: 6 });

    expect(serverTransport.serverLedger.length).toBe(1);
  });

  it('Scenario 2: CANCEL wins, DELIVER conflicts and is rejected without duplicate recognition', async () => {
    const targetItemId = 'item-555';
    const initialExpectedVersion = 5;

    const cmdCancelId = 'cmd-devB-cancel-win';
    await engineB.queueCommand(
      cmdCancelId,
      'CANCEL_ORDER_ITEM',
      'order_items',
      targetItemId,
      { orderItemId: targetItemId, orderId: 'ord-100', resetGeneration: 1 },
      'device_B_tablet',
      'admin_2',
      initialExpectedVersion
    );

    const cmdDeliverId = 'cmd-devA-deliver-lose';
    await engineA.queueCommand(
      cmdDeliverId,
      'DELIVER_ORDER_ITEM',
      'order_items',
      targetItemId,
      { orderItemId: targetItemId, orderId: 'ord-100', bin: '9999', resetGeneration: 1 },
      'device_A_phone',
      'admin_1',
      initialExpectedVersion
    );

    const syncResB = await engineB.synchronize();
    expect(syncResB.pushed).toBe(1);

    const cancelRecordB = await localDb.getOutbox(cmdCancelId);
    expect(cancelRecordB?.status).toBe('accepted');

    const serverItem = serverTransport.serverItems.get(targetItemId);
    expect(serverItem?.version).toBe(6);
    expect(serverItem?.status).toBe('cancelled');

    const syncResA = await engineA.synchronize();
    expect(syncResA.pushed).toBe(0);

    const deliverRecordA = await localDb.getOutbox(cmdDeliverId);
    expect(deliverRecordA?.status).toBe('conflict');
    expect(deliverRecordA?.lastError).toContain('VERSION_CONFLICT');

    expect(serverTransport.serverLedger.length).toBe(0);

    const logs = serverTransport.changeLog.filter((c) => c.entityId === targetItemId);
    expect(logs.length).toBe(1);
    expect(logs[0].payload).toMatchObject({ status: 'cancelled', version: 6 });
  });
});
