import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { AuthorizationContext } from '../application/authContext';
import {
  createNewBusinessDay,
  addNewCustomer,
  createOrderWithPhase5Engine,
  phase5UseCases,
  defaultAdminAuth,
  resetStoreMemory,
  seedDemoOperationalData,
  getOrdersForDay,
  getDaysList,
  getCustomersList,
} from '../components/pages/dayOrdersStore';

describe('Phase B.1: Real Atomic Entity + Outbox Mutation Boundary', () => {
  beforeEach(async () => {
    await localDb.clear();
    resetStoreMemory();
    await seedDemoOperationalData();
  });

  describe('1. Production Use Cases Atomic Persistence', () => {
    it('CREATE_DAY: atomically writes BusinessDay to kvStore and OPEN_DAY to outbox', async () => {
      const todayStr = '2026-10-01';
      const res = await createNewBusinessDay(todayStr);
      expect(res.success).toBe(true);
      const dayId = res.dayId!;

      // 1. Verify Entity in localDb
      const entityInDb = await localDb.get<any>('businessDays', dayId);
      expect(entityInDb).not.toBeNull();
      expect(entityInDb?.businessDate).toBe(todayStr);

      // 2. Verify Command in Outbox
      const outbox = await localDb.listOutbox();
      const dayCmd = outbox.find((c) => c.commandId === dayId && c.commandType === 'OPEN_DAY');
      expect(dayCmd).toBeDefined();
      expect(dayCmd?.aggregateType).toBe('business_days');
    });

    it('CREATE_CUSTOMER: atomically writes Customer to kvStore and CREATE_CUSTOMER to outbox', async () => {
      const customer = await addNewCustomer('عميل تجريبي بيتا', '0590001122', -5000);
      expect(customer.id).toBeDefined();

      // 1. Verify Entity in localDb
      const entityInDb = await localDb.get<any>('customers', customer.id);
      expect(entityInDb).not.toBeNull();
      expect(entityInDb?.name).toBe('عميل تجريبي بيتا');

      // 2. Verify Command in Outbox
      const outbox = await localDb.listOutbox();
      const custCmd = outbox.find((c) => c.commandId === customer.id && c.commandType === 'CREATE_CUSTOMER');
      expect(custCmd).toBeDefined();
      expect(custCmd?.aggregateType).toBe('customers');
    });

    it('CREATE_ORDER and ADD_ORDER_ITEM: atomically commits entity and command in one transaction', async () => {
      // Setup day and customer
      const dayRes = await createNewBusinessDay('2026-10-02');
      const dayId = dayRes.dayId!;
      const customer = await addNewCustomer('محمد علي', '0599998877', -2000);

      // Create Order with item
      const orderRes = await createOrderWithPhase5Engine(
        dayId,
        customer.id,
        [{ deviceTypeId: 'dev-1', hasCharger: false }],
        'ملاحظات تجريبية'
      );

      expect(orderRes.success).toBe(true);
      const order = orderRes.order!;

      // 1. Verify Order Entity in localDb
      const orderInDb = await localDb.get<any>('orders', order.id);
      expect(orderInDb).not.toBeNull();
      expect(orderInDb?.customerId).toBe(customer.id);

      // 2. Verify Order Item Entity in localDb
      const item = order.items[0];
      const itemInDb = await localDb.get<any>('orderItems', item.id);
      expect(itemInDb).not.toBeNull();
      expect(itemInDb?.orderId).toBe(order.id);

      // 3. Verify Outbox Commands
      const outbox = await localDb.listOutbox();
      const orderCmd = outbox.find((c) => c.commandId === order.id && c.commandType === 'CREATE_ORDER');
      expect(orderCmd).toBeDefined();

      const itemCmd = outbox.find((c) => c.commandId === item.id && c.commandType === 'ADD_ORDER_ITEM');
      expect(itemCmd).toBeDefined();
    });
  });

  describe('2. Atomic Rollback Verification (All-or-Nothing Invariant)', () => {
    it('Transaction Rollback: if work throws error after entity save, NEITHER entity NOR outbox command persists', async () => {
      const testOrderId = `order_rollback_${Date.now()}`;
      const dayId = 'day-rollback-test';
      const customerId = 'cust-rollback-test';

      const initialOutboxCount = (await localDb.listOutbox()).length;

      // Attempt transaction that writes order and then throws
      await expect(
        localDb.runTransaction(['kvStore', 'outbox'], 'readwrite', (tx) => {
          // Write entity using setWithTx
          localDb.setWithTx(tx, 'orders', testOrderId, {
            id: testOrderId,
            dayId,
            customerId,
            status: 'pending',
          });

          // Write outbox using saveOutboxWithTx
          localDb.saveOutboxWithTx(tx, {
            commandId: testOrderId,
            commandType: 'CREATE_ORDER',
            aggregateType: 'orders',
            aggregateId: testOrderId,
            payload: {},
            createdAt: new Date().toISOString(),
            deviceId: 'dev_test',
            actorAdminId: 'admin_test',
            status: 'pending',
            retryCount: 0,
          });

          // Simulate business failure / throw before commit
          throw new Error('SIMULATED_TRANSACTION_FAILURE');
        })
      ).rejects.toThrow('SIMULATED_TRANSACTION_FAILURE');

      // Verify Rollback: Entity must NOT exist in localDb
      let orderInDb = await localDb.get('orders', testOrderId);
      for (let i = 0; i < 20; i++) {
        if (orderInDb === null) break;
        await new Promise(resolve => setTimeout(resolve, 50));
        orderInDb = await localDb.get('orders', testOrderId);
      }
      expect(orderInDb).toBeNull();

      // Verify Rollback: Command must NOT exist in Outbox
      let cmdInOutbox = await localDb.getOutbox(testOrderId);
      for (let i = 0; i < 20; i++) {
        if (cmdInOutbox === null) break;
        await new Promise(resolve => setTimeout(resolve, 50));
        cmdInOutbox = await localDb.getOutbox(testOrderId);
      }
      expect(cmdInOutbox).toBeNull();

      const finalOutbox = await localDb.listOutbox();
      expect(finalOutbox.length).toBe(initialOutboxCount);
    });

    it('In-Memory consistency rollback: when useCase transaction throws, memory maps roll back', async () => {
      const dayRes = await createNewBusinessDay('2026-10-03');
      const dayId = dayRes.dayId!;
      const customer = await addNewCustomer('عميل فحص الذاكرة', '0591112233', -1000);

      const daysBefore = await getDaysList();
      const customersBefore = await getCustomersList();

      // Attempt to execute an invalid order creation with closed day or rule violation
      // Close the day first with manager auth
      const managerAuth = new AuthorizationContext({
        id: 'admin_mgr',
        username: 'manager',
        fullName: 'مدير النظام',
        role: 'SUPER_ADMIN',
        permissions: ['settings:manage', 'orders:create', 'orders:view'],
        isSuperAdmin: true,
      });
      await phase5UseCases.closeBusinessDay(managerAuth, dayId);

      // Attempt order on closed day with regular admin - will fail with ClosedDayError
      const orderCmdId = `cmd_failed_${Date.now()}`;
      await expect(
        phase5UseCases.createOrder(
          defaultAdminAuth,
          orderCmdId,
          dayId,
          customer.id,
          'will fail'
        )
      ).rejects.toThrow();

      // Verify no dirty order exists in memory or db
      const ordersAfter = await getOrdersForDay(dayId);
      expect(ordersAfter.find((o) => o.id === orderCmdId)).toBeUndefined();

      const dbOrder = await localDb.get('orders', orderCmdId);
      expect(dbOrder).toBeNull();

      const dbCmd = await localDb.getOutbox(orderCmdId);
      expect(dbCmd).toBeNull();
    });

    it('Partial Outbox failure rollback: if saveOutbox fails, entity write is rolled back', async () => {
      const testId = `test_partial_${Date.now()}`;

      await expect(
        localDb.runTransaction(['kvStore', 'outbox'], 'readwrite', (tx) => {
          localDb.setWithTx(tx, 'customers', testId, {
            id: testId,
            name: 'Partial Write Test',
          });

          // Simulate an error thrown during outbox step
          throw new Error('OUTBOX_WRITE_ABORT');
        })
      ).rejects.toThrow('OUTBOX_WRITE_ABORT');

      // Assert customer was rolled back and does not exist in localDb
      let custInDb = await localDb.get('customers', testId);
      for (let i = 0; i < 20; i++) {
        if (custInDb === null) break;
        await new Promise(resolve => setTimeout(resolve, 50));
        custInDb = await localDb.get('customers', testId);
      }
      expect(custInDb).toBeNull();
    });

    it('Direct repo save operations execute within an atomic transaction boundary', async () => {
      // Testing direct use of createBusinessDay in FinalUseCases
      const directDayRes = await phase5UseCases.createBusinessDay(
        new AuthorizationContext({
          id: 'admin_test',
          username: 'admin',
          fullName: 'مدير',
          role: 'ADMIN',
          permissions: ['settings:manage'],
          isSuperAdmin: false,
        }),
        '2026-10-15'
      );

      expect(directDayRes.success).toBe(true);
      if (!directDayRes.success) throw new Error('Expected directDayRes to succeed');
      const day = directDayRes.data;

      // Verify entity write
      const dayInDb = await localDb.get('businessDays', day.id);
      expect(dayInDb).not.toBeNull();

      // Verify outbox command write in same commit
      const outbox = await localDb.listOutbox();
      const cmd = outbox.find((c) => c.commandId === day.id && c.commandType === 'OPEN_DAY');
      expect(cmd).toBeDefined();
    });

    it('Explicit tx.abort() cleanly rolls back all modifications in memory and database', async () => {
      const abortCustomerId = `cust_abort_${Date.now()}`;

      await expect(
        localDb.runTransaction(['kvStore', 'outbox'], 'readwrite', (tx) => {
          localDb.setWithTx(tx, 'customers', abortCustomerId, {
            id: abortCustomerId,
            name: 'Abort Rollback Test',
          });
          tx.abort();
        })
      ).rejects.toThrow();

      const custInDb = await localDb.get('customers', abortCustomerId);
      expect(custInDb).toBeNull();
    });
  });
});
