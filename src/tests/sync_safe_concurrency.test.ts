import { beforeEach, describe, expect, it } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { SyncEngine, SyncCommandRequest, SyncCommandResponse, SyncPullResponse, ServerSyncTransport } from '../infrastructure/sync/syncEngine';
import { initializeCanonicalSyncState } from './utils/testSetup';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function makeTransport(onPush: (request: SyncCommandRequest) => Promise<SyncCommandResponse>): ServerSyncTransport {
  return {
    pushCommand: onPush,
    pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({
      changes: [],
      latestSequence: cursor,
      serverResetGeneration: 1,
    }),
  };
}

describe('safe bounded sync concurrency', () => {
  beforeEach(async () => {
    await localDb.clear();
    await initializeCanonicalSyncState();
  });

  it('overlaps up to three ADD_ORDER_ITEM commands for distinct orders', async () => {
    let active = 0;
    let maxActive = 0;
    const engine = new SyncEngine(makeTransport(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(25);
      active--;
      return { success: true, serverVersion: 1, rpcReached: true };
    }));

    for (let i = 1; i <= 5; i++) {
      await engine.queueCommand(
        `item-command-${i}`, 'ADD_ORDER_ITEM', 'order_items', `item-${i}`,
        { id: `item-${i}`, orderId: `order-${i}`, deviceTypeId: 'type-shared' },
        'device-1', 'admin-1'
      );
    }

    const result = await engine.synchronize();
    expect(result.pushed).toBe(5);
    expect(maxActive).toBe(3);
    expect((await localDb.listOutbox()).every(item => item.status === 'accepted')).toBe(true);
  });

  it('keeps mutations to the same order serial', async () => {
    let active = 0;
    let maxActiveForOrder = 0;
    const engine = new SyncEngine(makeTransport(async request => {
      if (request.commandType === 'ADD_ORDER_ITEM') {
        active++;
        maxActiveForOrder = Math.max(maxActiveForOrder, active);
        await delay(15);
        active--;
      }
      return { success: true, serverVersion: 1, rpcReached: true };
    }));

    for (let i = 1; i <= 4; i++) {
      await engine.queueCommand(
        `same-order-item-${i}`, 'ADD_ORDER_ITEM', 'order_items', `same-item-${i}`,
        { id: `same-item-${i}`, orderId: i % 2 === 0 ? 'ONE-ORDER' : 'one-order', deviceTypeId: 'type-shared' },
        'device-1', 'admin-1'
      );
    }

    const result = await engine.synchronize();
    expect(result.pushed).toBe(4);
    expect(maxActiveForOrder).toBe(1);
  });

  it('keeps payment and other non-allowlisted commands serial', async () => {
    let active = 0;
    let maxActive = 0;
    const engine = new SyncEngine(makeTransport(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      active--;
      return { success: true, serverVersion: 1, rpcReached: true };
    }));

    for (let i = 1; i <= 3; i++) {
      await engine.queueCommand(
        `payment-command-${i}`, 'POST_PAYMENT', 'payments', `payment-${i}`,
        { id: `payment-${i}`, customerId: `customer-${i}`, amountMinor: 100 },
        'device-1', 'admin-1'
      );
    }

    const result = await engine.synchronize();
    expect(result.pushed).toBe(3);
    expect(maxActive).toBe(1);
  });
});
