import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  resetStoreMemory,
  seedDemoOperationalData,
  getOrCreateOrderQrToken,
  getPublicOrderByToken,
  getOrderQrCardData,
} from '../components/pages/dayOrdersStore';

describe('Public Order QR Route & Resolver Verification', () => {
  beforeEach(async () => {
    await localDb.clear();
    resetStoreMemory();
    await seedDemoOperationalData();
  });

  it('1. Generates public order token and resolves read-only public order data without auth', async () => {
    // 1. Get an existing order from demo seed
    const orders = await localDb.list<any>('orders');
    expect(orders.length).toBeGreaterThan(0);
    const sampleOrder = orders[0];

    // 2. Generate/fetch token
    const token = await getOrCreateOrderQrToken(sampleOrder.id);
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');

    // 3. Resolve via public resolver (zero authentication required)
    const publicOrder = await getPublicOrderByToken(token);
    expect(publicOrder).not.toBeNull();
    expect(publicOrder!.orderNumber).toBe(sampleOrder.displayNumber);
    expect(publicOrder!.status).toBe(sampleOrder.status);
    expect(publicOrder!.token).toBe(token);
    expect(publicOrder!.customerName).toBeTruthy();
    expect(publicOrder!.itemsCount).toBeDefined();

    // 4. Strict security boundary: MUST NOT expose internal credentials or financial calculations
    expect((publicOrder as any).password).toBeUndefined();
    expect((publicOrder as any).caller_bin).toBeUndefined();
    expect((publicOrder as any).session).toBeUndefined();
  });

  it('2. Returns null for non-existent or invalid order token', async () => {
    const invalidResult = await getPublicOrderByToken('invalid-fake-token-12345');
    expect(invalidResult).toBeNull();
  });

  it('3. getOrderQrCardData produces /o/ public link matching public order route', async () => {
    const orders = await localDb.list<any>('orders');
    const sampleOrder = orders[0];

    const cardData = await getOrderQrCardData(sampleOrder.dayId, sampleOrder.id);
    expect(cardData).not.toBeNull();
    expect(cardData!.publicUrl).toContain('/o/');
    expect(cardData!.publicUrl).toContain(cardData!.token);
  });
});
