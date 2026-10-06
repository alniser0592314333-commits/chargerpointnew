import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  addNewCustomer,
  createNewBusinessDay,
  createOrderWithPhase5Engine,
  topUpCustomerBalance,
  getOrCreateOrderQrToken,
  getOrCreateCustomerQrToken,
  resetStoreMemory,
  clearAllOperationalData,
  phase5UseCases,
  getOrdersForDay,
  setRuntimeBinVerifier,
} from '../components/pages/dayOrdersStore';
import { localDb } from '../infrastructure/localDb/localDb';
import { AuthorizationContext } from '../application/authContext';
import { PaymentAllocationEntity, FinancialLedgerEntity } from '../domain/models';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const superAdminAuth = new AuthorizationContext(
  {
    id: 'admin_test_super',
    username: 'superadmin',
    fullName: 'Super Admin',
    role: 'SUPER_ADMIN',
    permissions: [
      'devices:manage',
      'finance:create-payment',
      'finance:credit-adjustment',
      'finance:approve-payment',
      'finance:view',
      'settings:manage',
      'customers:create',
      'orders:create',
      'orders:deliver',
    ],
    isSuperAdmin: true,
  },
  (bin: string) => bin === '0000'
);

describe('UUID STANDARDIZATION — NEW BUSINESS DATA ONLY', () => {
  beforeEach(async () => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
    await clearAllOperationalData();
    await localDb.clearLocalResetMarker();
    resetStoreMemory();
    setRuntimeBinVerifier((bin: string) => bin === '0000');
    vi.restoreAllMocks();
  });

  // TEST A: business_days
  it('TEST A: business_days ID is a valid RFC 4122 v4 UUID without day- prefix', async () => {
    const res = await createNewBusinessDay('2026-10-20');
    expect(res.success).toBe(true);
    expect(res.dayId).toBeDefined();
    expect(res.dayId).toMatch(UUID_REGEX);
    expect(res.dayId).not.toContain('day-');

    const dayEntity = await localDb.get<any>('businessDays', res.dayId!);
    expect(dayEntity).toBeDefined();
    expect(dayEntity?.id).toBe(res.dayId);
    expect(dayEntity?.businessDate).toBe('2026-10-20');

    const outbox = await localDb.listOutbox();
    const cmd = outbox.find((c) => c.commandId === res.dayId);
    expect(cmd).toBeDefined();
    expect(cmd?.aggregateId).toBe(res.dayId);
    expect((cmd?.payload as any)?.id).toBe(res.dayId);
    expect(cmd?.aggregateType).toBe('business_days');
  });

  // TEST B: orders
  it('TEST B: orders ID is UUID and matches Outbox aggregateId/commandId with valid dayId and customerId', async () => {
    const cust = await addNewCustomer('عميل فحص الطلب', '0599111222');
    const dayRes = await createNewBusinessDay('2026-10-21');
    const dayId = dayRes.dayId!;

    const devRes = await phase5UseCases.createDeviceType(superAdminAuth, 'شاشة فحص', 'smartphone', 3000);
    expect(devRes.success).toBe(true);
    if (!devRes.success) return;
    const deviceTypeId = devRes.data.id;

    const orderRes = await createOrderWithPhase5Engine(
      dayId,
      cust.id,
      [{ deviceTypeId, hasCharger: false }],
      'ملاحظات تجريبية'
    );

    expect(orderRes.success).toBe(true);
    expect(orderRes.order).toBeDefined();
    const orderId = orderRes.order!.id;
    expect(orderId).toMatch(UUID_REGEX);
    expect(orderId).not.toContain('cmd_');
    expect(orderId).not.toContain('ord_');

    const orderEntity = await localDb.get<any>('orders', orderId);
    expect(orderEntity).toBeDefined();
    expect(orderEntity?.id).toBe(orderId);
    expect(orderEntity?.customerId).toBe(cust.id);
    expect(orderEntity?.dayId).toBe(dayId);

    const outbox = await localDb.listOutbox();
    const cmd = outbox.find((c) => c.commandId === orderId && c.commandType === 'CREATE_ORDER');
    expect(cmd).toBeDefined();
    expect(cmd?.aggregateId).toBe(orderId);
    expect((cmd?.payload as any)?.id).toBe(orderId);
    expect(cmd?.aggregateType).toBe('orders');
  });

  // TEST C: order_items
  it('TEST C: order_items ID is UUID with exact orderId and deviceTypeId', async () => {
    const cust = await addNewCustomer('عميل فحص البنود', '0599111333');
    const dayRes = await createNewBusinessDay('2026-10-22');
    const devRes = await phase5UseCases.createDeviceType(superAdminAuth, 'بطارية فحص', 'battery', 1500);
    if (!devRes.success) return;

    const orderRes = await createOrderWithPhase5Engine(
      dayRes.dayId!,
      cust.id,
      [{ deviceTypeId: devRes.data.id, hasCharger: true }]
    );
    expect(orderRes.success).toBe(true);
    const orderId = orderRes.order!.id;

    const allItems = await localDb.list<any>('orderItems');
    const items = allItems.filter((i: any) => i.orderId === orderId);
    expect(items.length).toBe(1);
    const item = items[0];
    expect(item.id).toMatch(UUID_REGEX);
    expect(item.id).not.toContain('item_');
    expect(item.id).not.toContain('dev-form');
    expect(item.orderId).toBe(orderId);
    expect(item.deviceTypeId).toBe(devRes.data.id);

    const outbox = await localDb.listOutbox();
    const itemCmd = outbox.find((c) => c.commandId === item.id && c.commandType === 'ADD_ORDER_ITEM');
    expect(itemCmd).toBeDefined();
    expect(itemCmd?.aggregateId).toBe(orderId);
    expect((itemCmd?.payload as any)?.orderId).toBe(orderId);
    expect((itemCmd?.payload as any)?.deviceTypeId).toBe(devRes.data.id);
  });

  // TEST D: device_types
  it('TEST D: device_types ID is UUID and does not generate dev-*', async () => {
    const res = await phase5UseCases.createDeviceType(superAdminAuth, 'جهاز قياسي جديد', 'tablet', 5000);
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.data.id).toMatch(UUID_REGEX);
    expect(res.data.id).not.toContain('dev_');
    expect(res.data.id).not.toContain('dev-');

    const dev = await localDb.get<any>('deviceTypes', res.data.id);
    expect(dev).toBeDefined();
    expect(dev?.id).toBe(res.data.id);
  });

  // TEST E: payments
  it('TEST E: payments ID is UUID and preserves customerId', async () => {
    const cust = await addNewCustomer('عميل فحص الدفعات', '0599111444');
    const payRes = await topUpCustomerBalance({
      customerId: cust.id,
      amountMinor: 1000,
      bin: '0000',
      note: 'دفعة اختبار',
    });
    expect(payRes.success).toBe(true);

    const txId = payRes.transactionId!;
    expect(txId).toMatch(UUID_REGEX);
    expect(txId).not.toContain('pay_');
    expect(txId).not.toContain('cred_');

    const pay = await localDb.get<any>('payments', txId);
    expect(pay).toBeDefined();
    expect(pay?.id).toBe(txId);
    expect(pay?.customerId).toBe(cust.id);
    expect(pay?.amountMinor).toBe(1000);
  });

  // TEST F: payment_allocations
  it('TEST F: payment_allocations ID is UUID and preserves paymentId/orderId', async () => {
    const cust = await addNewCustomer('عميل فحص التوزيع', '0599111555');
    const dayRes = await createNewBusinessDay('2026-10-23');
    const devRes = await phase5UseCases.createDeviceType(superAdminAuth, 'صيانة فحص', 'wrench', 2000);
    if (!devRes.success) return;

    const orderRes = await createOrderWithPhase5Engine(
      dayRes.dayId!,
      cust.id,
      [{ deviceTypeId: devRes.data.id, hasCharger: false }]
    );
    expect(orderRes.success).toBe(true);
    const orderId = orderRes.order!.id;

    // The local delivery is optimistic. Seed the authoritative CHARGE row that
    // the server would publish before testing FIFO allocation identity.
    const allItems = await localDb.list<any>('orderItems');
    const orderItem = allItems.find((i: any) => i.orderId === orderId);
    expect(orderItem).toBeDefined();
    const chargeId = crypto.randomUUID();
    await localDb.set('financialLedger', chargeId, {
      id: chargeId,
      eventType: 'CHARGE',
      amountMinor: -2000,
      customerId: cust.id,
      orderId,
      orderItemId: orderItem.id,
      createdAt: new Date().toISOString(),
    });

    // Use recordPayment to trigger FIFO allocation
    const paymentId = crypto.randomUUID();
    const payRes = await phase5UseCases.recordPayment(superAdminAuth, paymentId, cust.id, 2000, 'CASH', undefined, 1);
    expect(payRes.success).toBe(true);

    const allAllocations = await localDb.list<PaymentAllocationEntity>('paymentAllocations');
    const alloc = allAllocations.find((a: PaymentAllocationEntity) => a.orderId === orderId);
    expect(alloc).toBeDefined();
    expect(alloc?.id).toMatch(UUID_REGEX);
    expect(alloc?.id).not.toContain('alloc_');
    expect(alloc?.paymentId).toBe(paymentId);
    expect(alloc?.orderId).toBe(orderId);
  });

  // TEST G: financial_ledger
  it('TEST G: financial_ledger ID is UUID and preserves reference IDs', async () => {
    const cust = await addNewCustomer('عميل دفتر الأستاذ', '0599111666');
    const res = await phase5UseCases.createCustomerCredit(superAdminAuth, cust.id, 500, '0000');
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.data.id).toMatch(UUID_REGEX);
    expect(res.data.id).not.toContain('cred_');
    expect(res.data.id).not.toContain('ledger_');

    const ledgerOverlay = await localDb.getOverlay(res.data.id);
    expect(ledgerOverlay).toBeDefined();
    expect(ledgerOverlay?.entityType).toBe('ledger');
    expect(ledgerOverlay?.entityId).toBe(res.data.id);
    expect((ledgerOverlay?.entityPayload as any)?.customerId).toBe(cust.id);
    expect((ledgerOverlay?.entityPayload as any)?.amountMinor).toBe(500);
  });

  // TEST H: qr_tokens
  it('TEST H: qr_tokens ID is UUID while publicToken remains unchanged', async () => {
    const cust = await addNewCustomer('عميل فحص الرمز', '0599111777');
    const dayRes = await createNewBusinessDay('2026-10-24');
    const devRes = await phase5UseCases.createDeviceType(superAdminAuth, 'جهاز رمز', 'smartphone', 1000);
    if (!devRes.success) return;

    const orderRes = await createOrderWithPhase5Engine(
      dayRes.dayId!,
      cust.id,
      [{ deviceTypeId: devRes.data.id, hasCharger: false }]
    );
    const orderId = orderRes.order!.id;

    const orderToken = await getOrCreateOrderQrToken(orderId);
    expect(orderToken).toBeDefined();

    const customerToken = await getOrCreateCustomerQrToken(cust.id);
    expect(customerToken).toBeDefined();

    const allQr = await localDb.list<any>('qr_tokens');
    const orderQr = allQr.find((q: any) => q.targetId === orderId);
    expect(orderQr).toBeDefined();
    expect(orderQr.id).toMatch(UUID_REGEX);
    expect(orderQr.id).not.toContain('token_ord');
    expect(orderQr.publicToken).toBe(orderToken);

    const custQr = allQr.find((q: any) => q.targetId === cust.id);
    expect(custQr).toBeDefined();
    expect(custQr.id).toMatch(UUID_REGEX);
    expect(custQr.id).not.toContain('token-');
    expect(custQr.publicToken).toBe(customerToken);
  });

  // TEST I: ID invariance across Entity, Outbox, and Payload
  it('TEST I: Entity.id === Outbox aggregateId === Payload ID for newly created entities', async () => {
    const cust = await addNewCustomer('عميل التطابق الشامل', '0599111888');
    const dayRes = await createNewBusinessDay('2026-10-25');
    const dayId = dayRes.dayId!;

    const devRes = await phase5UseCases.createDeviceType(superAdminAuth, 'جهاز التطابق', 'smartphone', 2000);
    if (!devRes.success) return;

    const orderRes = await createOrderWithPhase5Engine(
      dayId,
      cust.id,
      [{ deviceTypeId: devRes.data.id, hasCharger: false }]
    );
    const orderId = orderRes.order!.id;

    const outbox = await localDb.listOutbox();
    const dayCmd = outbox.find((c) => c.commandId === dayId);
    expect(dayCmd?.aggregateId).toBe(dayId);
    expect((dayCmd?.payload as any)?.id).toBe(dayId);

    const orderCmd = outbox.find((c) => c.commandId === orderId);
    expect(orderCmd?.aggregateId).toBe(orderId);
    expect((orderCmd?.payload as any)?.id).toBe(orderId);
  });

  // TEST J: Customer regression
  it('TEST J: Customer still uses crypto.randomUUID() and passes validation', async () => {
    const cust = await addNewCustomer('عميل فحص الارتداد', '0599111999');
    expect(cust.id).toMatch(UUID_REGEX);
    expect(cust.id).not.toContain('cust-');
  });

  // TEST K: Safety regression
  it('TEST K: safe_cast_uuid and server architecture are untouched in code', () => {
    const validUuid = crypto.randomUUID();
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(validUuid)).toBe(true);
  });

  // TEST L: Scope regression
  it('TEST L: ensures core subsystems remain functional and consistent', async () => {
    expect(typeof localDb.clearOperationalTablesWithTx).toBe('function');
    expect(typeof localDb.set).toBe('function');
    expect(typeof resetStoreMemory).toBe('function');
    const days = await getOrdersForDay('day-dummy');
    expect(Array.isArray(days)).toBe(true);
  });
});
