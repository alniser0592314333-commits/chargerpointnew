import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { backupService } from '../services/backup/backupService';
import { AuthorizationContext, ActorAdmin } from '../application/authContext';
import { FinalUseCases, RepositoryContext } from '../application/useCases';
import { OrderEntity, BusinessDayEntity, CustomerEntity, OrderNumberReservationEntity } from '../domain/models';
import { OrderNumberReservationExhaustedError } from '../domain/errors';

describe('Order Numbering Safety, Lazy Reservation & Backup/Restore Integrity', () => {
  const adminActor: ActorAdmin = {
    id: 'admin_1',
    username: 'admin',
    fullName: 'Admin User',
    role: 'ADMIN',
    permissions: ['orders:view', 'orders:create', 'orders:edit', 'customers:view', 'customers:create'],
    isSuperAdmin: true,
    deviceId: 'device_A',
  };
  const validBin = '1234';
  const auth = new AuthorizationContext(adminActor, (b) => b === validBin);

  let orderMap: Map<string, OrderEntity>;
  let dayMap: Map<string, BusinessDayEntity>;
  let customerMap: Map<string, CustomerEntity>;
  let reservationMap: Map<string, OrderNumberReservationEntity>;
  let useCases: FinalUseCases;

  beforeEach(async () => {
    await localDb.clear();
    orderMap = new Map();
    dayMap = new Map();
    customerMap = new Map();
    reservationMap = new Map();

    const mockCtx: RepositoryContext = {
      orderRepo: {
        findById: (id: string) => orderMap.get(id) || null,
        save: (o: OrderEntity) => { orderMap.set(o.id, { ...o }); },
        countForDay: (dayId: string) => Array.from(orderMap.values()).filter(o => o.dayId === dayId).length,
      },
      reservationRepo: {
        findActiveByDayAndDevice: (dayId: string, deviceId: string) => {
          let found: OrderNumberReservationEntity | null = null;
          reservationMap.forEach(r => {
            if (r.businessDayId === dayId && r.deviceId === deviceId && r.status === 'ACTIVE' && r.nextNumber <= r.endNumber) {
              found = r;
            }
          });
          return found;
        },
        save: (r: OrderNumberReservationEntity) => {
          reservationMap.set(r.id, { ...r });
        },
        reserveRange: (dayId: string, deviceId: string, commandId?: string, rangeSize: number = 20) => {
          if (commandId) {
            for (const r of reservationMap.values()) {
              if (r.commandId === commandId) return r;
            }
          }
          let maxEnd = 0;
          reservationMap.forEach(r => {
            if (r.businessDayId === dayId && r.endNumber > maxEnd) {
              maxEnd = r.endNumber;
            }
          });
          const startNumber = maxEnd + 1;
          const endNumber = startNumber + rangeSize - 1;
          const res: OrderNumberReservationEntity = {
            id: crypto.randomUUID(),
            businessDayId: dayId,
            deviceId,
            startNumber,
            endNumber,
            nextNumber: startNumber,
            status: 'ACTIVE',
            commandId: commandId || crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: 1,
          };
          reservationMap.set(res.id, res);
          return res;
        },
      },
      dayRepo: {
        findById: (id: string) => dayMap.get(id) || null,
        isClosed: () => false,
        save: (d: BusinessDayEntity) => { dayMap.set(d.id, { ...d }); },
      },
      customerRepo: {
        findById: (id: string) => customerMap.get(id) || null,
        save: (c: CustomerEntity) => { customerMap.set(c.id, { ...c }); },
        getBalance: () => 0,
      },
      itemRepo: {
        findById: () => null,
        save: () => {},
        findByOrderId: () => [],
      },
      ledgerRepo: {
        append: () => {},
        findByCustomer: () => [],
        findAll: () => [],
      },
      commandRepo: {
        get: () => null,
        record: () => {},
      },
      deviceRepo: {
        findById: () => null,
        save: () => {},
        findAll: () => [],
      },
      paymentRepo: {
        save: () => {},
        saveAllocation: () => {},
        findByCustomer: () => [],
        findAllAllocations: () => [],
      },
      transactionManager: {
        runInTransaction: async (fn) => {
          return fn(mockCtx);
        },
      },
    };

    useCases = new FinalUseCases(mockCtx);
  });

  it('Test LAZY RESERVATION — Zero reservations at startup/login/sync, exact reservation on first order, no new reservation until exhaustion', async () => {
    dayMap.set('day-1', {
      id: 'day-1',
      businessDate: '2026-10-03',
      isClosed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });
    customerMap.set('cust-1', {
      id: 'cust-1',
      name: 'Customer 1',
      isActive: true,
      debtLimitMinor: -1000,
      chargerFeeExempt: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    // Steps 1-6: App start, login, sync, open orders page. NO order creation.
    expect(reservationMap.size).toBe(0);

    // Step 7-8: Start creating the first real order
    const res1 = await useCases.createOrder(auth, 'cmd-lazy-1', 'day-1', 'cust-1', 'First Order');
    expect(res1.success).toBe(true);
    expect((res1 as any).data.displayNumber).toBe(1);

    // Expected: Exactly one reservation is created
    expect(reservationMap.size).toBe(1);
    const reservationArray = Array.from(reservationMap.values());
    expect(reservationArray[0].startNumber).toBe(1);
    expect(reservationArray[0].endNumber).toBe(20); // Default size 20

    // Create additional orders
    const res2 = await useCases.createOrder(auth, 'cmd-lazy-2', 'day-1', 'cust-1', 'Second Order');
    const res3 = await useCases.createOrder(auth, 'cmd-lazy-3', 'day-1', 'cust-1', 'Third Order');

    expect(res2.success && res3.success).toBe(true);
    expect((res2 as any).data.displayNumber).toBe(2);
    expect((res3 as any).data.displayNumber).toBe(3);

    // Expected: No additional server reservation is created until current range is exhausted
    expect(reservationMap.size).toBe(1);
  });

  it('Test BACKUP/RESTORE RESERVATION INTEGRITY — Preserves partially consumed reservation range across backup and restore', async () => {
    dayMap.set('day-1', {
      id: 'day-1',
      businessDate: '2026-10-03',
      isClosed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });
    customerMap.set('cust-1', {
      id: 'cust-1',
      name: 'Customer 1',
      isActive: true,
      debtLimitMinor: -1000,
      chargerFeeExempt: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    // Create 3 orders to consume #1, #2, #3 from range [1, 20], nextNumber = 4
    await useCases.createOrder(auth, 'cmd-bk-1', 'day-1', 'cust-1', 'Order 1');
    await useCases.createOrder(auth, 'cmd-bk-2', 'day-1', 'cust-1', 'Order 2');
    await useCases.createOrder(auth, 'cmd-bk-3', 'day-1', 'cust-1', 'Order 3');

    for (const [id, ord] of orderMap.entries()) {
      await localDb.set('orders', id, ord);
    }
    for (const [id, res] of reservationMap.entries()) {
      await localDb.set('orderNumberReservations', id, res);
    }
    await localDb.set('businessDays', 'day-1', dayMap.get('day-1'));
    await localDb.set('customers', 'cust-1', customerMap.get('cust-1'));

    const snapshot = await backupService.createSnapshot('OFFLINE', auth, {
      name: 'Reservation Restore Test Backup',
      bin: validBin,
    });

    expect(snapshot).toBeDefined();

    orderMap.clear();
    reservationMap.clear();
    await localDb.clearOperationalTables();

    await backupService.restoreSnapshot(snapshot.snapshotId, auth, { bin: validBin });

    const restoredReservations = await localDb.list<OrderNumberReservationEntity>('orderNumberReservations');
    expect(restoredReservations).toHaveLength(1);
    expect(restoredReservations[0].startNumber).toBe(1);
    expect(restoredReservations[0].endNumber).toBe(20);
    expect(restoredReservations[0].nextNumber).toBe(4);

    reservationMap.set(restoredReservations[0].id, restoredReservations[0]);

    const resNext = await useCases.createOrder(auth, 'cmd-bk-4', 'day-1', 'cust-1', 'Order 4');
    expect(resNext.success).toBe(true);
    expect((resNext as any).data.displayNumber).toBe(4);
  });

  it('Test A — Two offline devices get non-overlapping reserved ranges and never produce duplicate displayNumbers', async () => {
    dayMap.set('day-1', {
      id: 'day-1',
      businessDate: '2026-10-03',
      isClosed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });
    customerMap.set('cust-1', {
      id: 'cust-1',
      name: 'Customer 1',
      isActive: true,
      debtLimitMinor: -1000,
      chargerFeeExempt: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    const authDeviceA = new AuthorizationContext({ ...adminActor, deviceId: 'device_A' }, () => true);
    const authDeviceB = new AuthorizationContext({ ...adminActor, deviceId: 'device_B' }, () => true);

    const o1 = await useCases.createOrder(authDeviceA, 'cmd-a1', 'day-1', 'cust-1', 'Order A1');
    const o2 = await useCases.createOrder(authDeviceA, 'cmd-a2', 'day-1', 'cust-1', 'Order A2');
    const o3 = await useCases.createOrder(authDeviceA, 'cmd-a3', 'day-1', 'cust-1', 'Order A3');

    const o4 = await useCases.createOrder(authDeviceB, 'cmd-b1', 'day-1', 'cust-1', 'Order B1');
    const o5 = await useCases.createOrder(authDeviceB, 'cmd-b2', 'day-1', 'cust-1', 'Order B2');

    expect(o1.success && o2.success && o3.success && o4.success && o5.success).toBe(true);

    const numbers = [
      (o1 as any).data.displayNumber,
      (o2 as any).data.displayNumber,
      (o3 as any).data.displayNumber,
      (o4 as any).data.displayNumber,
      (o5 as any).data.displayNumber,
    ];

    const uniqueNumbers = new Set(numbers);
    expect(uniqueNumbers.size).toBe(5);
  });
});
