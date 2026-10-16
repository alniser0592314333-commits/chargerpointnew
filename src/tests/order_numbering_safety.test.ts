import { describe, it, expect, beforeEach } from 'vitest';
import { localDb, OptimisticOverlayRecord } from '../infrastructure/localDb/localDb';
import { backupService } from '../services/backup/backupService';
import { AuthorizationContext, ActorAdmin } from '../application/authContext';
import { FinalUseCases, RepositoryContext } from '../application/useCases';
import { OrderEntity, BusinessDayEntity, CustomerEntity, DeviceTypeEntity, OrderNumberReservationEntity } from '../domain/models';

describe('Order Numbering Safety, Lazy Reservation & Backup/Restore Integrity', () => {
  const DEVICE_TYPE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
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
  let deviceMap: Map<string, DeviceTypeEntity>;
  let reservationMap: Map<string, OrderNumberReservationEntity>;
  let useCases: FinalUseCases;
  let recordedCommands: Array<{ commandId: string; type: string; payload: unknown }>;
  let overlays: Map<string, OptimisticOverlayRecord>;
  let overlaySequence: number;
  let insideLocalTransaction = false;
  let pendingOrderToInjectDayId: string | null = null;

  beforeEach(async () => {
    await localDb.clear();
    orderMap = new Map();
    dayMap = new Map();
    customerMap = new Map();
    deviceMap = new Map();
    reservationMap = new Map();
    const deviceNow = new Date().toISOString();
    deviceMap.set(DEVICE_TYPE_ID, {
      id: DEVICE_TYPE_ID,
      name: 'Test Device',
      icon: 'device',
      basePriceMinor: 100,
      chargerFeeEnabled: true,
      chargerFeeApplicable: true,
      isActive: true,
      sortOrder: 1,
      createdAt: deviceNow,
      updatedAt: deviceNow,
      version: 1,
    });
    recordedCommands = [];
    overlays = new Map();
    overlaySequence = 0;
    insideLocalTransaction = false;
    pendingOrderToInjectDayId = null;

    const pendingOrderChangesForDay = (dayId: string) => Array.from(overlays.values()).some((overlay) => {
      if (overlay.status !== 'PENDING' || overlay.entityType !== 'orders') return false;
      const patch = (overlay.patch || overlay.entityPayload || {}) as Partial<OrderEntity>;
      const baseOrder = orderMap.get(overlay.entityId);
      const effectiveDayId = patch.dayId ?? baseOrder?.dayId;
      return Boolean(effectiveDayId && effectiveDayId === dayId);
    });

    const effectiveOrdersForDay = (dayId: string): OrderEntity[] => {
      const effective = new Map<string, OrderEntity>(Array.from(orderMap.values()).map((order) => [order.id, { ...order }]));
      for (const overlay of Array.from(overlays.values()).filter((entry) => entry.status === 'PENDING' && entry.entityType === 'orders')) {
        const patch = (overlay.patch || overlay.entityPayload || {}) as Partial<OrderEntity>;
        const existing = effective.get(overlay.entityId);
        if (overlay.operation === 'DELETE') effective.delete(overlay.entityId);
        else effective.set(overlay.entityId, { ...(existing || {} as OrderEntity), ...patch, id: overlay.entityId } as OrderEntity);
      }
      return Array.from(effective.values()).filter((order) => order.dayId === dayId);
    };
    const hasPendingRenumberForDay = (dayId: string) => Array.from(overlays.values()).some((overlay) =>
      overlay.status === 'PENDING' && overlay.mutationKey === `renumber-day:${dayId}`
    );

    const mockCtx: RepositoryContext = {
      orderRepo: {
        findById: (id: string) => orderMap.get(id) || null,
        save: (o: OrderEntity) => { orderMap.set(o.id, { ...o }); },
        countForDay: (dayId: string) => effectiveOrdersForDay(dayId).reduce((max, o) => Math.max(max, o.displayNumber || 0), 0),
        maxInternalSequence: () => Array.from(orderMap.values()).reduce((max, order) => Math.max(max, Number(order.internalSequence) || 0), 0),
        findByDay: (dayId: string) => effectiveOrdersForDay(dayId),
      },
      reservationRepo: {
        findActiveByDayAndDevice: (dayId: string, deviceId: string) => {
          const found = Array.from(reservationMap.values()).find((r) =>
            r.businessDayId === dayId &&
            r.deviceId === deviceId &&
            r.status === 'ACTIVE' &&
            r.nextNumber <= r.endNumber
          );
          return found ? { ...found } : null;
        },
        save: (r: OrderNumberReservationEntity) => {
          const persisted = { ...r };
          reservationMap.set(r.id, persisted);
          void localDb.set('orderNumberReservations', r.id, persisted);
        },
        resetForDay: (dayId: string, nextNumber: number) => {
          let watermarkFound = false;
          for (const reservation of reservationMap.values()) {
            if (reservation.businessDayId !== dayId) continue;
            const isWatermark = reservation.deviceId === '__renumber_watermark__';
            if (isWatermark) watermarkFound = true;
            reservationMap.set(reservation.id, {
              ...reservation,
              startNumber: nextNumber,
              endNumber: nextNumber - 1,
              nextNumber,
              status: 'EXHAUSTED',
              updatedAt: new Date().toISOString(),
              version: reservation.version + 1,
            });
          }
          if (!watermarkFound) {
            const now = new Date().toISOString();
            reservationMap.set(`watermark-${dayId}`, {
              id: `watermark-${dayId}`, businessDayId: dayId, deviceId: '__renumber_watermark__',
              startNumber: nextNumber, endNumber: nextNumber - 1, nextNumber, status: 'EXHAUSTED',
              commandId: `renumber-watermark:${dayId}`, createdAt: now, updatedAt: now, version: 1,
            });
          }
        },
        needsResetForDay: (dayId: string, deviceId: string, expectedNextNumber: number) => {
          const active = Array.from(reservationMap.values()).find((reservation) =>
            reservation.businessDayId === dayId && reservation.deviceId === deviceId &&
            reservation.status === 'ACTIVE' && reservation.nextNumber <= reservation.endNumber
          );
          if (active) {
            const laterRangeExists = Array.from(reservationMap.values()).some((reservation) =>
              reservation.businessDayId === dayId && reservation.id !== active.id &&
              reservation.endNumber > active.endNumber
            );
            return active.nextNumber !== expectedNextNumber || laterRangeExists;
          }
          let maxEnd = 0;
          reservationMap.forEach((reservation) => {
            if (reservation.businessDayId === dayId) maxEnd = Math.max(maxEnd, reservation.endNumber);
          });
          return maxEnd !== expectedNextNumber - 1;
        },
        reserveRange: (dayId: string, deviceId: string, commandId?: string, rangeSize: number = 20) => {
          if (commandId) {
            for (const r of reservationMap.values()) {
              if (r.commandId === commandId) return r;
            }
          }
          let maxEnd = 0;
          reservationMap.forEach(r => {
            if (r.businessDayId === dayId && r.endNumber > maxEnd) maxEnd = r.endNumber;
          });
          effectiveOrdersForDay(dayId).forEach((order) => {
            if ((order.displayNumber || 0) > maxEnd) maxEnd = order.displayNumber;
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
          reservationMap.set(res.id, { ...res });
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
        record: (commandId: string, type: string, payload: unknown) => {
          if (type === 'RENUMBER_DAY_ORDERS' && !insideLocalTransaction) throw new Error('Renumber command must be queued in the same local transaction as overlays');
          recordedCommands.push({ commandId, type, payload });
        },
      },
      overlayRepo: {
        save: async (overlay: OptimisticOverlayRecord) => { overlays.set(overlay.commandId, overlay); },
        remove: async (id: string) => { overlays.delete(id); },
        get: async (id: string) => overlays.get(id) || null,
        hasPendingOrderChangesForDay: pendingOrderChangesForDay,
        hasPendingRenumberForDay,
        getNextSequence: async () => {
          const sequence = ++overlaySequence;
          if (pendingOrderToInjectDayId) {
            const dayId = pendingOrderToInjectDayId;
            pendingOrderToInjectDayId = null;
            const now = new Date().toISOString();
            overlays.set('pending-race-order', {
              commandId: 'pending-race-order',
              mutationKey: `create-order:${dayId}`,
              entityType: 'orders',
              entityId: 'order-pending-race',
              operation: 'CREATE',
              patch: { dayId, displayNumber: 3 },
              sequence,
              createdAt: now,
              status: 'PENDING',
            });
          }
          return sequence;
        },
      },
      deviceRepo: {
        findById: (id: string) => deviceMap.get(id) || null,
        save: (d: DeviceTypeEntity) => { deviceMap.set(d.id, { ...d }); },
        findAll: () => Array.from(deviceMap.values()),
      },
      paymentRepo: {
        save: () => {},
        saveAllocation: () => {},
        findByCustomer: () => [],
        findAllAllocations: () => [],
      },
      transactionManager: {
        runInTransaction: async (fn) => {
          insideLocalTransaction = true;
          const outerOverlayRepo = mockCtx.overlayRepo!;
          const transactionContext: RepositoryContext = {
            ...mockCtx,
            overlayRepo: {
              save: outerOverlayRepo.save,
              remove: outerOverlayRepo.remove,
              get: outerOverlayRepo.get,
              getNextSequence: outerOverlayRepo.getNextSequence,
              hasPendingOrderChangesForDay: outerOverlayRepo.hasPendingOrderChangesForDay,
              hasPendingRenumberForDay: outerOverlayRepo.hasPendingRenumberForDay,
              saveWithTx: (overlay: OptimisticOverlayRecord) => {
                if (!insideLocalTransaction) throw new Error('Overlay must be staged inside the active local transaction');
                overlays.set(overlay.commandId, overlay);
              },
              hasPendingOrderChangesForDaySync: pendingOrderChangesForDay,
              hasPendingRenumberForDaySync: hasPendingRenumberForDay,
            },
          };
          try {
            return fn(transactionContext);
          } finally {
            insideLocalTransaction = false;
          }
        },
      },
    };

    useCases = new FinalUseCases(mockCtx);
  });

  const createReservedOrder = (
    authContext: AuthorizationContext,
    commandId: string,
    dayId: string,
    customerId: string,
    notes: string
  ) => useCases.createOrderWithItems(authContext, commandId, dayId, customerId, [
    { deviceTypeId: DEVICE_TYPE_ID, hasCharger: true },
  ], notes);

  it('renumbers a complete day through awaited overlays and one sync command', async () => {
    const dayId = 'day-1';
    const now = '2026-10-09T10:00:00.000Z';
    dayMap.set(dayId, { id: dayId, businessDate: '2026-10-09', isClosed: false, createdAt: now, updatedAt: now, version: 1 });
    for (const [id, customerId, displayNumber] of [['order-a', 'cust-a', 2], ['order-b', 'cust-b', 1]] as const) {
      orderMap.set(id, {
        id, dayId, customerId, displayNumber, internalSequence: displayNumber,
        status: 'pending', createdAt: now, updatedAt: now, version: 3,
      });
    }

    const result = await useCases.renumberDayOrders(auth, 'renumber-command', dayId, [
      { id: 'order-a', expectedVersion: 3, oldNumber: 2, newNumber: 1 },
      { id: 'order-b', expectedVersion: 3, oldNumber: 1, newNumber: 2 },
    ]);

    expect(result.success).toBe(true);
    expect(overlays.get('renumber-command:order:order-a')?.patch).toMatchObject({ displayNumber: 1, version: 4 });
    expect(overlays.get('renumber-command:order:order-b')?.patch).toMatchObject({ displayNumber: 2, version: 4 });
    expect(recordedCommands).toHaveLength(1);
    expect(recordedCommands[0]).toMatchObject({ commandId: 'renumber-command', type: 'RENUMBER_DAY_ORDERS' });
    expect((recordedCommands[0].payload as any).changes).toHaveLength(2);
  });

  it('rejects renumbering while a pending local order exists, even if the caller omits it', async () => {
    const dayId = 'day-1';
    const now = '2026-10-09T10:00:00.000Z';
    dayMap.set(dayId, { id: dayId, businessDate: '2026-10-09', isClosed: false, createdAt: now, updatedAt: now, version: 1 });
    orderMap.set('order-a', { id: 'order-a', dayId, customerId: 'cust-a', displayNumber: 1, internalSequence: 1, status: 'pending', createdAt: now, updatedAt: now, version: 1 });
    orderMap.set('order-b', { id: 'order-b', dayId, customerId: 'cust-b', displayNumber: 2, internalSequence: 2, status: 'pending', createdAt: now, updatedAt: now, version: 1 });
    overlays.set('pending-local-order', {
      commandId: 'pending-local-order',
      mutationKey: 'create-order:day-1',
      entityType: 'orders',
      entityId: 'order-pending',
      operation: 'CREATE',
      patch: { dayId, displayNumber: 3 },
      sequence: 10,
      createdAt: now,
      status: 'PENDING',
    });

    const result = await useCases.renumberDayOrders(auth, 'renumber-with-pending-order', dayId, [
      { id: 'order-a', expectedVersion: 1, oldNumber: 1, newNumber: 1 },
      { id: 'order-b', expectedVersion: 1, oldNumber: 2, newNumber: 2 },
    ]);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/pending local order changes must sync/i);
    expect(Array.from(overlays.values()).filter((overlay) => overlay.mutationKey === 'renumber-day:day-1')).toHaveLength(0);
    expect(recordedCommands).toHaveLength(0);
  });

  it('rechecks pending order overlays inside the transaction if one appears after preflight', async () => {
    const dayId = 'day-race';
    const now = '2026-10-09T10:00:00.000Z';
    dayMap.set(dayId, { id: dayId, businessDate: '2026-10-09', isClosed: false, createdAt: now, updatedAt: now, version: 1 });
    orderMap.set('race-order-a', { id: 'race-order-a', dayId, customerId: 'cust-a', displayNumber: 1, internalSequence: 1, status: 'pending', createdAt: now, updatedAt: now, version: 1 });
    orderMap.set('race-order-b', { id: 'race-order-b', dayId, customerId: 'cust-b', displayNumber: 2, internalSequence: 2, status: 'pending', createdAt: now, updatedAt: now, version: 1 });
    pendingOrderToInjectDayId = dayId;

    const result = await useCases.renumberDayOrders(auth, 'renumber-race', dayId, [
      { id: 'race-order-a', expectedVersion: 1, oldNumber: 1, newNumber: 2 },
      { id: 'race-order-b', expectedVersion: 1, oldNumber: 2, newNumber: 1 },
    ]);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/pending local order changes must sync/i);
    expect(Array.from(overlays.values()).filter((overlay) => overlay.mutationKey === `renumber-day:${dayId}`)).toHaveLength(0);
    expect(recordedCommands).toHaveLength(0);
  });

  it('rejects stale day versions before writing overlays or a sync command', async () => {
    const dayId = 'day-1';
    const now = '2026-10-09T10:00:00.000Z';
    dayMap.set(dayId, { id: dayId, businessDate: '2026-10-09', isClosed: false, createdAt: now, updatedAt: now, version: 1 });
    orderMap.set('order-a', {
      id: 'order-a', dayId, customerId: 'cust-a', displayNumber: 1, internalSequence: 1,
      status: 'pending', createdAt: now, updatedAt: now, version: 5,
    });

    const result = await useCases.renumberDayOrders(auth, 'stale-command', dayId, [
      { id: 'order-a', expectedVersion: 4, oldNumber: 1, newNumber: 1 },
    ]);

    expect(result.success).toBe(false);
    expect(overlays.size).toBe(0);
    expect(recordedCommands).toHaveLength(0);
  });

  it('rejects duplicate target numbers before staging overlays or a sync command', async () => {
    const dayId = 'day-1';
    const now = '2026-10-09T10:00:00.000Z';
    dayMap.set(dayId, { id: dayId, businessDate: '2026-10-09', isClosed: false, createdAt: now, updatedAt: now, version: 1 });
    orderMap.set('order-a', { id: 'order-a', dayId, customerId: 'cust-a', displayNumber: 1, internalSequence: 1, status: 'pending', createdAt: now, updatedAt: now, version: 1 });
    orderMap.set('order-b', { id: 'order-b', dayId, customerId: 'cust-b', displayNumber: 2, internalSequence: 2, status: 'pending', createdAt: now, updatedAt: now, version: 1 });

    const result = await useCases.renumberDayOrders(auth, 'duplicate-target-command', dayId, [
      { id: 'order-a', expectedVersion: 1, oldNumber: 1, newNumber: 1 },
      { id: 'order-b', expectedVersion: 1, oldNumber: 2, newNumber: 1 },
    ]);

    expect(result.success).toBe(false);
    expect(overlays.size).toBe(0);
    expect(recordedCommands).toHaveLength(0);
  });

  it('rolls back optimistic overlays and outbox records together when the local transaction fails', async () => {
    const now = '2026-10-09T10:00:00.000Z';
    await expect(localDb.runTransaction(['optimisticOverlays', 'outbox'], 'readwrite', (tx) => {
      localDb.saveOverlayWithTx(tx, {
        commandId: 'atomic-renumber:order-a',
        mutationKey: 'renumber-day:day-1',
        entityType: 'orders',
        entityId: 'order-a',
        operation: 'PATCH',
        patch: { displayNumber: 1 },
        sequence: 88,
        createdAt: now,
        status: 'PENDING',
      });
      localDb.saveOutboxWithTx(tx, {
        commandId: 'atomic-renumber',
        commandType: 'RENUMBER_DAY_ORDERS',
        aggregateType: 'orders',
        aggregateId: 'day-1',
        mutationKey: 'renumber-day:day-1',
        payload: { dayId: 'day-1', changes: [] },
        createdAt: now,
        deviceId: 'device_A',
        actorAdminId: 'admin_1',
        status: 'pending',
        retryCount: 0,
      });
      throw new Error('forced local transaction failure');
    })).rejects.toThrow('forced local transaction failure');

    expect(await localDb.getOverlay('atomic-renumber:order-a')).toBeNull();
    expect((await localDb.listOutbox()).some((record) => record.commandId === 'atomic-renumber')).toBe(false);
  });

  it('overlay sequence resumes above the highest persisted overlay after reload', async () => {
    const now = '2026-10-09T10:00:00.000Z';
    await localDb.saveOverlay({
      commandId: 'persisted-high-sequence',
      mutationKey: 'test-sequence',
      entityType: 'orders',
      entityId: 'order-sequence-test',
      operation: 'PATCH',
      patch: { displayNumber: 1 },
      sequence: 75,
      createdAt: now,
      status: 'PENDING',
    });

    expect(await localDb.getNextSequence()).toBeGreaterThan(75);
    await localDb.removeOverlay('persisted-high-sequence');
  });

  it('resets stale reserved numbers after manual renumber and reuses the next contiguous number', async () => {
    const dayId = 'day-1';
    const now = new Date().toISOString();
    dayMap.set(dayId, { id: dayId, businessDate: '2026-10-09', isClosed: false, createdAt: now, updatedAt: now, version: 1 });
    customerMap.set('cust-1', {
      id: 'cust-1', name: 'Customer 1', isActive: true, debtLimitMinor: -1000,
      chargerFeeExempt: false, createdAt: now, updatedAt: now, version: 1,
    });

    const oldNumbers = [...Array.from({ length: 17 }, (_, index) => index + 1), 19];
    const changes = oldNumbers.map((oldNumber, index) => {
      const id = `order-${oldNumber}`;
      orderMap.set(id, {
        id, dayId, customerId: 'cust-1', displayNumber: oldNumber, internalSequence: oldNumber,
        status: 'pending', createdAt: now, updatedAt: now, version: 1,
      });
      return { id, expectedVersion: 1, oldNumber, newNumber: index + 1 };
    });
    reservationMap.set('stale-range', {
      id: 'stale-range', businessDayId: dayId, deviceId: 'device_A',
      startNumber: 1, endNumber: 20, nextNumber: 20, status: 'ACTIVE',
      commandId: 'old-reservation-command', createdAt: now, updatedAt: now, version: 1,
    });

    const renumber = await useCases.renumberDayOrders(auth, 'renumber-stale-range', dayId, changes);
    expect(renumber.success).toBe(true);
    expect(reservationMap.get('stale-range')).toMatchObject({
      startNumber: 19, endNumber: 18, nextNumber: 19, status: 'EXHAUSTED',
    });
    expect(reservationMap.get(`watermark-${dayId}`)).toBeDefined();

    const blockedWhileRenumberPending = await createReservedOrder(auth, 'blocked-during-renumber', dayId, 'cust-1', 'Must wait');
    expect(blockedWhileRenumberPending.success).toBe(false);
    expect((blockedWhileRenumberPending as any).error).toContain('renumbered');

    // Simulate the server's successful canonical pull after the renumber command.
    for (const change of changes) {
      const existing = orderMap.get(change.id)!;
      orderMap.set(change.id, { ...existing, displayNumber: change.newNumber, version: existing.version + 1 });
    }
    overlays.clear();

    const created = await createReservedOrder(auth, 'create-after-renumber', dayId, 'cust-1', 'After renumber');
    expect(created.success).toBe(true);
    expect((created as any).data.order.displayNumber).toBe(19);
  });

  it('repairs an old stale reservation cursor before creating the next order', async () => {
    const dayId = 'day-1';
    const now = new Date().toISOString();
    dayMap.set(dayId, { id: dayId, businessDate: '2026-10-09', isClosed: false, createdAt: now, updatedAt: now, version: 1 });
    customerMap.set('cust-1', {
      id: 'cust-1', name: 'Customer 1', isActive: true, debtLimitMinor: -1000,
      chargerFeeExempt: false, createdAt: now, updatedAt: now, version: 1,
    });
    for (let number = 1; number <= 18; number++) {
      const id = `existing-${number}`;
      orderMap.set(id, {
        id, dayId, customerId: 'cust-1', displayNumber: number, internalSequence: number,
        status: 'pending', createdAt: now, updatedAt: now, version: 1,
      });
    }
    orderMap.set('other-day-order', {
      id: 'other-day-order', dayId: 'other-day', customerId: 'cust-1', displayNumber: 1, internalSequence: 1000,
      status: 'pending', createdAt: now, updatedAt: now, version: 1,
    });
    reservationMap.set('old-stale-cursor', {
      id: 'old-stale-cursor', businessDayId: dayId, deviceId: 'device_A',
      startNumber: 1, endNumber: 20, nextNumber: 20, status: 'ACTIVE',
      commandId: 'old-app-range', createdAt: now, updatedAt: now, version: 1,
    });

    const created = await createReservedOrder(auth, 'create-after-upgrade', dayId, 'cust-1', 'After upgrade');
    expect(created.success).toBe(true);
    expect((created as any).data.order.displayNumber).toBe(19);
    expect((created as any).data.order.internalSequence).toBe(1001);
    expect(reservationMap.get('old-stale-cursor')).toMatchObject({
      startNumber: 19, endNumber: 18, nextNumber: 19, status: 'EXHAUSTED',
    });
  });

  it('blocks new orders when existing day numbers contain a gap until the day is renumbered', async () => {
    const now = new Date().toISOString();
    dayMap.set('day-1', { id: 'day-1', businessDate: '2026-10-09', isClosed: false, createdAt: now, updatedAt: now, version: 1 });
    customerMap.set('cust-1', {
      id: 'cust-1', name: 'Customer 1', isActive: true, debtLimitMinor: -1000,
      chargerFeeExempt: false, createdAt: now, updatedAt: now, version: 1,
    });
    for (const number of [1, 3]) {
      const id = `gap-order-${number}`;
      orderMap.set(id, {
        id, dayId: 'day-1', customerId: 'cust-1', displayNumber: number, internalSequence: number,
        status: 'pending', createdAt: now, updatedAt: now, version: 1,
      });
    }

    const result = await createReservedOrder(auth, 'must-not-create-on-gap', 'day-1', 'cust-1', 'Blocked until renumber');
    expect(result.success).toBe(false);
    expect((result as any).code).toBe('ORDER_NUMBERING_GAP');
    expect(reservationMap.size).toBe(0);
    expect(overlays.size).toBe(0);
    expect(recordedCommands).toHaveLength(0);
  });

  it('does not consume a customer-facing number when device validation fails', async () => {
    const now = new Date().toISOString();
    dayMap.set('day-1', { id: 'day-1', businessDate: '2026-10-09', isClosed: false, createdAt: now, updatedAt: now, version: 1 });
    customerMap.set('cust-1', {
      id: 'cust-1', name: 'Customer 1', isActive: true, debtLimitMinor: -1000,
      chargerFeeExempt: false, createdAt: now, updatedAt: now, version: 1,
    });

    await expect(useCases.createOrderWithItems(auth, 'invalid-device-order', 'day-1', 'cust-1', [
      { deviceTypeId: 'missing-device-type', hasCharger: true },
    ], 'Must not burn a number')).rejects.toThrow('Device type not found or inactive');

    expect(reservationMap.size).toBe(0);
    expect(overlays.size).toBe(0);
    expect(recordedCommands).toHaveLength(0);
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
    const res1 = await createReservedOrder(auth, 'cmd-lazy-1', 'day-1', 'cust-1', 'First Order');
    expect(res1.success).toBe(true);
    expect((res1 as any).data.order.displayNumber).toBe(1);

    // Expected: Exactly one reservation is created
    expect(reservationMap.size).toBe(1);
    const reservationArray = Array.from(reservationMap.values());
    expect(reservationArray[0].startNumber).toBe(1);
    expect(reservationArray[0].endNumber).toBe(20); // Preserve the established twenty-number offline reservation range
    const persistedAfterFirstOrder = Array.from(reservationMap.values())[0];
    expect(persistedAfterFirstOrder.nextNumber).toBe(2);

    // Create additional orders
    const res2 = await createReservedOrder(auth, 'cmd-lazy-2', 'day-1', 'cust-1', 'Second Order');
    const res3 = await createReservedOrder(auth, 'cmd-lazy-3', 'day-1', 'cust-1', 'Third Order');

    expect(res2.success && res3.success).toBe(true);
    expect((res2 as any).data.order.displayNumber).toBe(2);
    expect((res3 as any).data.order.displayNumber).toBe(3);

    // Expected: No additional server reservation is created until current range is exhausted
    expect(reservationMap.size).toBe(1);
    const persistedAfterThreeOrders = Array.from(reservationMap.values())[0];
    expect(persistedAfterThreeOrders.nextNumber).toBe(4);
  });

  it('Test BACKUP/RESTORE RESERVATION INTEGRITY — Preserves partially consumed reservation range across backup and restore', async () => {
    const dayId = '33333333-3333-4333-8333-333333333333';
    const customerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const authBackup = new AuthorizationContext({ ...adminActor, deviceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, (bin) => bin === validBin);
    dayMap.set(dayId, {
      id: dayId,
      businessDate: '2026-10-03',
      isClosed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });
    customerMap.set(customerId, {
      id: customerId,
      name: 'Customer 1',
      isActive: true,
      debtLimitMinor: -1000,
      chargerFeeExempt: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    // Create 3 orders to consume #1, #2, #3 from the reserved range [1, 20], nextNumber = 4
    await createReservedOrder(authBackup, '44444444-4444-4444-8444-444444444441', dayId, customerId, 'Order 1');
    await createReservedOrder(authBackup, '44444444-4444-4444-8444-444444444442', dayId, customerId, 'Order 2');
    await createReservedOrder(authBackup, '44444444-4444-4444-8444-444444444443', dayId, customerId, 'Order 3');

    for (const [id, ord] of orderMap.entries()) {
      await localDb.set('orders', id, ord);
    }
    for (const [id, res] of reservationMap.entries()) {
      await localDb.set('orderNumberReservations', id, res);
    }
    await localDb.set('businessDays', dayId, dayMap.get(dayId));
    await localDb.set('customers', customerId, customerMap.get(customerId));

    const snapshot = await backupService.createSnapshot('OFFLINE', authBackup, {
      name: 'Reservation Restore Test Backup',
      bin: validBin,
    });

    expect(snapshot).toBeDefined();

    orderMap.clear();
    reservationMap.clear();
    await localDb.clearOperationalTables();

    await backupService.restoreSnapshot(snapshot.snapshotId, authBackup, { bin: validBin });

    const restoredReservations = await localDb.list<OrderNumberReservationEntity>('orderNumberReservations');
    expect(restoredReservations).toHaveLength(1);
    expect(restoredReservations[0].startNumber).toBe(1);
    expect(restoredReservations[0].endNumber).toBe(20);
    expect(restoredReservations[0].nextNumber).toBe(4);

    reservationMap.set(restoredReservations[0].id, restoredReservations[0]);

    const resNext = await createReservedOrder(authBackup, '44444444-4444-4444-8444-444444444444', dayId, customerId, 'Order 4');
    expect(resNext.success).toBe(true);
    expect((resNext as any).data.order.displayNumber).toBe(4);
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

    const o1 = await createReservedOrder(authDeviceA, 'cmd-a1', 'day-1', 'cust-1', 'Order A1');
    const o2 = await createReservedOrder(authDeviceA, 'cmd-a2', 'day-1', 'cust-1', 'Order A2');
    const o3 = await createReservedOrder(authDeviceA, 'cmd-a3', 'day-1', 'cust-1', 'Order A3');

    const o4 = await createReservedOrder(authDeviceB, 'cmd-b1', 'day-1', 'cust-1', 'Order B1');
    const o5 = await createReservedOrder(authDeviceB, 'cmd-b2', 'day-1', 'cust-1', 'Order B2');

    expect(o1.success && o2.success && o3.success && o4.success && o5.success).toBe(true);

    const numbers = [
      (o1 as any).data.order.displayNumber,
      (o2 as any).data.order.displayNumber,
      (o3 as any).data.order.displayNumber,
      (o4 as any).data.order.displayNumber,
      (o5 as any).data.order.displayNumber,
    ];

    const uniqueNumbers = new Set(numbers);
    expect(uniqueNumbers.size).toBe(5);
  });
});
