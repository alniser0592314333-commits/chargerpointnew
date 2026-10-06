/**
 * Focused Forensic Tests for DELIVER_ORDER_ITEM Dependency on ADD_ORDER_ITEM
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { OutboxScheduler, extractCommandDependencies } from '../infrastructure/sync/outboxScheduler';
import { initializeCanonicalSyncState } from './utils/testSetup';

describe('DELIVER_ORDER_ITEM Item-Specific Dependency Tests', () => {
  beforeEach(async () => {
    await localDb.clear();
    await initializeCanonicalSyncState();
  });

  it('Test A — dependency exists: DELIVER_ORDER_ITEM extracts dependency on ADD_ORDER_ITEM via itemId', () => {
    const addCmd = {
      commandId: 'cmd_add_x',
      commandType: 'ADD_ORDER_ITEM',
      aggregateType: 'order_items',
      aggregateId: 'item_X',
      payload: { id: 'item_X', orderId: 'ord_1', deviceTypeId: 'dev_1' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending' as const,
      retryCount: 0,
    };

    const deliverCmd = {
      commandId: 'cmd_deliver_x',
      commandType: 'DELIVER_ORDER_ITEM',
      aggregateType: 'order_items',
      aggregateId: 'item_X',
      payload: { itemId: 'item_X' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending' as const,
      retryCount: 0,
    };

    const deps = extractCommandDependencies(deliverCmd, [addCmd, deliverCmd]);
    expect(deps).toContain('cmd_add_x');
  });

  it('Test B — delivery waits: DELIVER_ORDER_ITEM is blocked while ADD_ORDER_ITEM is pending', async () => {
    const addCmd = {
      commandId: 'cmd_add_x',
      commandType: 'ADD_ORDER_ITEM',
      aggregateType: 'order_items',
      aggregateId: 'item_X',
      payload: { id: 'item_X', orderId: 'ord_1', deviceTypeId: 'dev_1' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending' as const,
      retryCount: 0,
    };

    const deliverCmd = {
      commandId: 'cmd_deliver_x',
      commandType: 'DELIVER_ORDER_ITEM',
      aggregateType: 'order_items',
      aggregateId: 'item_X',
      payload: { itemId: 'item_X' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending' as const,
      retryCount: 0,
    };

    const scheduler = new OutboxScheduler();
    const result = await scheduler.schedule([deliverCmd], [addCmd, deliverCmd], () => Promise.resolve(null));

    expect(result.ready).not.toContain(deliverCmd);
    expect(result.blocked.has('cmd_deliver_x')).toBe(true);
  });

  it('Test C — delivery becomes ready: DELIVER_ORDER_ITEM is ready after ADD_ORDER_ITEM succeeds', async () => {
    const addCmd = {
      commandId: 'cmd_add_x',
      commandType: 'ADD_ORDER_ITEM',
      aggregateType: 'order_items',
      aggregateId: 'item_X',
      payload: { id: 'item_X', orderId: 'ord_1', deviceTypeId: 'dev_1' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'accepted' as const,
      retryCount: 0,
    };

    const deliverCmd = {
      commandId: 'cmd_deliver_x',
      commandType: 'DELIVER_ORDER_ITEM',
      aggregateType: 'order_items',
      aggregateId: 'item_X',
      payload: { itemId: 'item_X' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending' as const,
      retryCount: 0,
    };

    const scheduler = new OutboxScheduler();
    const result = await scheduler.schedule([deliverCmd], [addCmd, deliverCmd], () => Promise.resolve(null));

    expect(result.ready).toContainEqual(deliverCmd);
    expect(result.blocked.has('cmd_deliver_x')).toBe(false);
  });

  it('Test D — different items remain independent: DELIVER_ORDER_ITEM(X) does not wait for ADD_ORDER_ITEM(Y)', async () => {
    const addCmdY = {
      commandId: 'cmd_add_y',
      commandType: 'ADD_ORDER_ITEM',
      aggregateType: 'order_items',
      aggregateId: 'item_Y',
      payload: { id: 'item_Y', orderId: 'ord_1', deviceTypeId: 'dev_1' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending' as const,
      retryCount: 0,
    };

    const deliverCmdX = {
      commandId: 'cmd_deliver_x',
      commandType: 'DELIVER_ORDER_ITEM',
      aggregateType: 'order_items',
      aggregateId: 'item_X',
      payload: { itemId: 'item_X' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending' as const,
      retryCount: 0,
    };

    // Save item X locally so it exists (or history success for add X)
    await localDb.saveHistory({
      historyId: 'hist_add_x',
      commandId: 'cmd_add_x',
      commandType: 'ADD_ORDER_ITEM',
      entityType: 'order_items',
      entityId: 'item_X',
      state: 'SUCCESS',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attemptCount: 1,
    });

    const scheduler = new OutboxScheduler();
    const result = await scheduler.schedule([deliverCmdX], [addCmdY, deliverCmdX], (id) => localDb.getHistoryByCommandId(id));

    expect(result.ready).toContainEqual(deliverCmdX);
    expect(result.blocked.has('cmd_deliver_x')).toBe(false);
  });

  it('Test E — no duplicate dependency: if both itemId and orderItemId are present with the same ID, no duplicate edge', () => {
    const addCmd = {
      commandId: 'cmd_add_x',
      commandType: 'ADD_ORDER_ITEM',
      aggregateType: 'order_items',
      aggregateId: 'item_X',
      payload: { id: 'item_X', orderId: 'ord_1', deviceTypeId: 'dev_1' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending' as const,
      retryCount: 0,
    };

    const deliverCmd = {
      commandId: 'cmd_deliver_x',
      commandType: 'DELIVER_ORDER_ITEM',
      aggregateType: 'order_items',
      aggregateId: 'item_X',
      payload: { itemId: 'item_X', orderItemId: 'item_X' },
      createdAt: new Date().toISOString(),
      deviceId: 'dev_1',
      actorAdminId: 'admin_1',
      status: 'pending' as const,
      retryCount: 0,
    };

    const deps = extractCommandDependencies(deliverCmd, [addCmd, deliverCmd]);
    expect(deps.filter(id => id === 'cmd_add_x').length).toBe(1);
  });
});
