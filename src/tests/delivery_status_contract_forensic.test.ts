/**
 * Forensic Regression Test Suite for Delivery Status Contract & Invariants
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  repoContext,
  phase5UseCases,
  deliverSingleOrderItem,
  resetStoreMemory,
  setRuntimeBinVerifier,
} from '../components/pages/dayOrdersStore';
import { AuthorizationContext } from '../application/authContext';
import { Permission } from '../domain/enums';
import { DomainInvariants } from '../domain/invariants';
import { FinancialInvariantViolation } from '../domain/errors';
import { initializeCanonicalSyncState } from './utils/testSetup';

describe('Delivery Status Contract Forensic Suite', () => {
  const superAdminAuth = new AuthorizationContext(
    {
      id: 'admin_forensic_1',
      username: 'superadmin',
      fullName: 'Super Admin',
      role: 'SUPER_ADMIN',
      isSuperAdmin: true,
      permissions: ['settings:manage', 'orders:view', 'orders:create', 'orders:edit', 'orders:deliver', 'orders:cancel'] as Permission[],
    },
    async (bin) => bin === '1234'
  );

  beforeEach(async () => {
    await localDb.clear();
    await initializeCanonicalSyncState();
    resetStoreMemory();
    setRuntimeBinVerifier((bin) => bin === '1234');
  });

  it('Test 1 — New Order status is explicitly defined and equals pending', async () => {
    await repoContext.customerRepo.save({
      id: 'cust-f1',
      name: 'Test Customer',
      phone: '0599000000',
      isActive: true,
      debtLimitMinor: -10000,
      chargerFeeExempt: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });
    await repoContext.dayRepo.save({
      id: 'day-2026-10-04',
      businessDate: '2026-10-04',
      isClosed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    const orderRes = await phase5UseCases.createOrder(
      superAdminAuth,
      crypto.randomUUID(),
      'day-2026-10-04',
      'cust-f1',
      'Test notes'
    );
    expect(orderRes.success).toBe(true);
    if (!orderRes.success) return;
    const order = orderRes.data;

    expect(order.status).toBeDefined();
    expect(order.status).toBe('pending');
  });

  it('Test 2 — New Order Item status is explicitly defined and equals charging', async () => {
    await repoContext.customerRepo.save({
      id: 'cust-f2',
      name: 'Test Customer 2',
      phone: '0599000001',
      isActive: true,
      debtLimitMinor: -10000,
      chargerFeeExempt: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });
    await repoContext.dayRepo.save({
      id: 'day-2026-10-04',
      businessDate: '2026-10-04',
      isClosed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });
    await repoContext.deviceRepo.save({
      id: 'dev-f1',
      name: 'iPhone Screen',
      nameAr: 'شاشة آيفون',
      icon: 'smartphone',
      basePriceMinor: 5000,
      chargerFeeEnabled: true,
      isActive: true,
      sortOrder: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    const orderRes = await phase5UseCases.createOrder(
      superAdminAuth,
      crypto.randomUUID(),
      'day-2026-10-04',
      'cust-f2'
    );
    expect(orderRes.success).toBe(true);
    if (!orderRes.success) return;

    const itemRes = await phase5UseCases.addOrderItem(
      superAdminAuth,
      orderRes.data.id,
      'dev-f1',
      false,
      crypto.randomUUID()
    );

    expect(itemRes.success).toBe(true);
    if (!itemRes.success) return;
    const item = itemRes.data;

    expect(item.status).toBeDefined();
    expect(item.status).toBe('charging');
  });

  it('Test 3 — Repository Round Trip preserves order and order item status', async () => {
    const orderId = 'ord-round-1';
    const itemId = 'item-round-1';

    await repoContext.orderRepo.save({
      id: orderId,
      dayId: 'day-2026-10-04',
      customerId: 'cust-f1',
      displayNumber: 1,
      internalSequence: 1,
      status: 'pending',
      customerBalanceSnapshotMinor: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    await repoContext.itemRepo.save({
      id: itemId,
      orderId,
      deviceTypeId: 'dev-f1',
      itemSequence: 1,
      status: 'charging',
      deviceNameSnapshot: 'Device',
      deviceIconSnapshot: 'smartphone',
      basePriceSnapshotMinor: 1000,
      chargerFeeEnabledSnapshot: false,
      customerChargerFeeExemptSnapshot: false,
      chargerFeeSnapshotMinor: 0,
      hasCharger: false,
      unitPriceMinor: 1000,
      totalPriceMinor: 1000,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    const readOrder = await repoContext.orderRepo.findById(orderId);
    const readItem = await repoContext.itemRepo.findById(itemId);

    expect(readOrder?.status).toBe('pending');
    expect(readItem?.status).toBe('charging');
  });

  it('Test 4 & 5 — Invalid undefined status produces controlled domain error, NOT Cannot read properties of undefined', async () => {
    expect(() => {
      DomainInvariants.assertOrderNotCancelledForRecognition(undefined as any);
    }).toThrow(FinancialInvariantViolation);

    expect(() => {
      DomainInvariants.assertItemNotCancelled(undefined as any);
    }).toThrow(FinancialInvariantViolation);
  });

  it('Test 6 — Cancelled Item is rejected by invariant', async () => {
    expect(() => {
      DomainInvariants.assertItemNotCancelled('cancelled');
    }).toThrow(FinancialInvariantViolation);
  });

  it('Test 7 — Cancelled Order is rejected by invariant', async () => {
    expect(() => {
      DomainInvariants.assertOrderNotCancelledForRecognition('cancelled');
    }).toThrow(FinancialInvariantViolation);
  });

  it('Test 8 — Real Delivery Flow (Create Customer -> Order -> Item -> Deliver) succeeds without toLowerCase exception', async () => {
    await repoContext.customerRepo.save({
      id: 'cust-real-1',
      name: 'محمد أحمد',
      phone: '0599887766',
      isActive: true,
      debtLimitMinor: -50000,
      chargerFeeExempt: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });
    await repoContext.dayRepo.save({
      id: 'day-2026-10-04',
      businessDate: '2026-10-04',
      isClosed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });
    await repoContext.deviceRepo.save({
      id: 'dev-real-1',
      name: 'Samsung Screen',
      nameAr: 'شاشة سامسونج',
      icon: 'smartphone',
      basePriceMinor: 4000,
      chargerFeeEnabled: true,
      isActive: true,
      sortOrder: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    const orderRes = await phase5UseCases.createOrder(
      superAdminAuth,
      crypto.randomUUID(),
      'day-2026-10-04',
      'cust-real-1'
    );
    expect(orderRes.success).toBe(true);
    if (!orderRes.success) return;

    const itemRes = await phase5UseCases.addOrderItem(
      superAdminAuth,
      orderRes.data.id,
      'dev-real-1',
      true,
      crypto.randomUUID()
    );
    expect(itemRes.success).toBe(true);
    if (!itemRes.success) return;

    const deliverRes = await deliverSingleOrderItem(itemRes.data.id, '1234');
    expect(deliverRes.success).toBe(true);
    expect(deliverRes.item?.status).toBe('delivered');
  });
});
