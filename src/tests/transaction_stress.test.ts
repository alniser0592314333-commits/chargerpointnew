import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { ID } from '../types/common';

describe('IndexedDB Transaction Lifecycle Stress Test', () => {
  beforeEach(async () => {
    await localDb.init();
    await localDb.clear();
  });

  it('handles rapid consecutive mutations without "Transaction has finished" error', async () => {
    const table = 'testTable';
    
    // Perform rapid mutations
    const iterations = 50;
    const promises = [];
    
    for (let i = 0; i < iterations; i++) {
      promises.push(
        localDb.runTransaction([table], 'readwrite', (tx) => {
          localDb.setWithTx(tx, table, `key-${i}`, { val: i });
          // Ensure this completes before moving to next in sequence, but not concurrency
        })
      );
    }
    
    await Promise.all(promises);
    
    // Verification
    for (let i = 0; i < iterations; i++) {
      const val = await localDb.get<{ val: number }>(table, `key-${i}`);
      expect(val?.val).toBe(i);
    }
  });

  it('maintains atomicity for Entity + Outbox write', async () => {
    const orderId = 'order-1';
    
    await localDb.runTransaction(['kvStore', 'outbox'], 'readwrite', (tx) => {
      localDb.setWithTx(tx, 'orders', orderId, { id: orderId, val: 'order-data' });
      localDb.saveOutboxWithTx(tx, { commandId: 'cmd-1', commandType: 'CREATE', aggregateType: 'orders', aggregateId: orderId, payload: {}, createdAt: '', deviceId: '', actorAdminId: '', status: 'pending', retryCount: 0 });
    });
    
    const order = await localDb.get('orders', orderId);
    const outbox = await localDb.getOutbox('cmd-1');
    
    expect(order).toBeDefined();
    expect(outbox).toBeDefined();
  });
});
