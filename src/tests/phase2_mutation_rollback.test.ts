/**
 * Phase 2 Rollback Infrastructure & Per-Entity Mutation Serialization Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { localDb, MutationSnapshotRecord } from '../infrastructure/localDb/localDb';

describe('Phase 2 Mutation Rollback & Serialization Tests', () => {
  beforeEach(async () => {
    await localDb.clear();
  });

  it('A. Single mutation rejection: restores exact pre-mutation state', async () => {
    const entityKey = 'order_100';
    const commandId = 'cmd_mut_1';

    // 1. Establish initial authoritative state
    const initialOrder = { id: 'order_100', status: 'charging', version: 1 };
    await localDb.set('orders', 'order_100', initialOrder);

    // 2. Capture pre-mutation snapshot before optimistic update
    const snapshot: MutationSnapshotRecord = {
      commandId,
      mutationKey: entityKey,
      items: [
        { table: 'orders', id: 'order_100', previousRecord: { ...initialOrder }, existed: true }
      ],
      createdAt: new Date().toISOString()
    };
    await localDb.saveMutationSnapshot(snapshot);

    // 3. Apply optimistic mutation locally
    await localDb.set('orders', 'order_100', { id: 'order_100', status: 'delivered', version: 2 });
    let mutated = await localDb.get('orders', 'order_100');
    expect((mutated as any).status).toBe('delivered');

    // 4. Simulate server rejection -> execute atomic rollback
    const rolledBack = await localDb.atomicRollback(commandId);
    expect(rolledBack).toBe(true);

    // 5. Verify pre-mutation state is fully restored
    const restored = await localDb.get('orders', 'order_100');
    expect(restored).toEqual(initialOrder);
  });

  it('B. Newly created record rejection: removes record because it did not previously exist', async () => {
    const entityKey = 'item_new';
    const commandId = 'cmd_mut_2';

    // 1. Capture snapshot for newly created record (did not exist)
    const snapshot: MutationSnapshotRecord = {
      commandId,
      mutationKey: entityKey,
      items: [
        { table: 'orderItems', id: 'item_new', previousRecord: null, existed: false }
      ],
      createdAt: new Date().toISOString()
    };
    await localDb.saveMutationSnapshot(snapshot);

    // 2. Optimistically create record
    await localDb.set('orderItems', 'item_new', { id: 'item_new', status: 'charging' });
    expect(await localDb.get('orderItems', 'item_new')).not.toBeNull();

    // 3. Rollback
    await localDb.atomicRollback(commandId);

    // 4. Verify record is removed
    expect(await localDb.get('orderItems', 'item_new')).toBeNull();
  });

  it('C. Multiple records in one command: restores all atomically', async () => {
    const entityKey = 'order_multi';
    const commandId = 'cmd_mut_3';

    const initialOrder = { id: 'order_multi', status: 'charging' };
    const initialItem = { id: 'item_multi', orderId: 'order_multi', status: 'charging' };

    await localDb.set('orders', 'order_multi', initialOrder);
    await localDb.set('orderItems', 'item_multi', initialItem);

    const snapshot: MutationSnapshotRecord = {
      commandId,
      mutationKey: entityKey,
      items: [
        { table: 'orders', id: 'order_multi', previousRecord: { ...initialOrder }, existed: true },
        { table: 'orderItems', id: 'item_multi', previousRecord: { ...initialItem }, existed: true }
      ],
      createdAt: new Date().toISOString()
    };
    await localDb.saveMutationSnapshot(snapshot);

    // Mutate both
    await localDb.set('orders', 'order_multi', { id: 'order_multi', status: 'delivered' });
    await localDb.set('orderItems', 'item_multi', { id: 'item_multi', orderId: 'order_multi', status: 'delivered' });

    // Rollback
    await localDb.atomicRollback(commandId);

    expect(await localDb.get('orders', 'order_multi')).toEqual(initialOrder);
    expect(await localDb.get('orderItems', 'item_multi')).toEqual(initialItem);
  });

  it('D & E. Per-entity serialization and different entities independence', async () => {
    const entityKeyA = 'entity_A';
    const commandIdA = 'cmd_A';

    const snapshotA: MutationSnapshotRecord = {
      commandId: commandIdA,
      mutationKey: entityKeyA,
      items: [{ table: 'orders', id: 'entity_A', previousRecord: null, existed: false }],
      createdAt: new Date().toISOString()
    };
    await localDb.saveMutationSnapshot(snapshotA);

    // Command A has active mutation on entity A
    expect(await localDb.hasActiveMutationForEntity(entityKeyA)).toBe(true);

    // Conflicting mutation on entity A should be blocked (serialized)
    expect(await localDb.hasActiveMutationForEntity(entityKeyA)).toBe(true);

    // Different entity B has no active mutation
    const entityKeyB = 'entity_B';
    expect(await localDb.hasActiveMutationForEntity(entityKeyB)).toBe(false);

    // Resolve Command A
    await localDb.removeMutationSnapshot(commandIdA);
    expect(await localDb.hasActiveMutationForEntity(entityKeyA)).toBe(false);
  });

  it('F. Restart safety: snapshot survives initialization/restart check', async () => {
    const commandId = 'cmd_restart';
    const snapshot: MutationSnapshotRecord = {
      commandId,
      mutationKey: 'ent_restart',
      items: [{ table: 'orders', id: 'ent_restart', previousRecord: { id: 'ent_restart', status: 'charging' }, existed: true }],
      createdAt: new Date().toISOString()
    };
    await localDb.saveMutationSnapshot(snapshot);

    const fetched = await localDb.getMutationSnapshot(commandId);
    expect(fetched).not.toBeNull();
    expect(fetched?.commandId).toBe(commandId);

    await localDb.atomicRollback(commandId);
    expect(await localDb.getMutationSnapshot(commandId)).toBeNull();
  });

  it('G. Failure handling test: non-existent snapshot or aborted rollback returns false', async () => {
    const commandId = 'cmd_non_existent';
    const result = await localDb.atomicRollback(commandId);
    expect(result).toBe(false);
  });

  it('H. Multi-entity mutation test: orderItems + financialLedger + customers atomic rollback scope', async () => {
    const commandId = 'cmd_multi_store';
    const initialItem = { id: 'item_del', status: 'charging' };
    const initialLedger = { id: 'ledger_1', amountMinor: -500 };
    const initialCust = { id: 'cust_1', name: 'Test' };

    await localDb.set('orderItems', 'item_del', initialItem);
    await localDb.set('financialLedger', 'ledger_1', initialLedger);
    await localDb.set('customers', 'cust_1', initialCust);

    const snapshot: MutationSnapshotRecord = {
      commandId,
      mutationKey: 'item_del',
      items: [
        { table: 'orderItems', id: 'item_del', previousRecord: { ...initialItem }, existed: true },
        { table: 'financialLedger', id: 'ledger_1', previousRecord: { ...initialLedger }, existed: true },
        { table: 'customers', id: 'cust_1', previousRecord: { ...initialCust }, existed: true }
      ],
      createdAt: new Date().toISOString()
    };
    await localDb.saveMutationSnapshot(snapshot);

    // Rollback all three stores atomically
    const rolledBack = await localDb.atomicRollback(commandId);
    expect(rolledBack).toBe(true);

    expect(await localDb.get('orderItems', 'item_del')).toEqual(initialItem);
    expect(await localDb.get('financialLedger', 'ledger_1')).toEqual(initialLedger);
    expect(await localDb.get('customers', 'cust_1')).toEqual(initialCust);
  });
});
