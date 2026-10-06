/**
 * Comprehensive Application Use Cases & Transaction Boundary Coordination
 * Implements 100% of domain requirements for Orders, Customers, Devices, Finance, and Business Days.
 */

import { ID, Result } from '../types/common';
import { 
  OrderEntity, 
  OrderItemEntity, 
  CustomerEntity, 
  DeviceTypeEntity, 
  FinancialLedgerEntity, 
  PaymentEntity, 
  PaymentAllocationEntity,
  BusinessDayEntity,
  QrTokenEntity,
  GoalEntity,
  GoalRequestEntity,
  OrderNumberReservationEntity
} from '../domain/models';
import { localDb, OptimisticOverlayRecord } from '../infrastructure/localDb/localDb';
import { 
  calculateItemPrice, 
  validateOrderTransition, 
  validateItemTransition, 
  checkDebtLimit,
  generateGoalProposal,
  calculateAuthoritativeGoalProgress
} from '../domain/rules';
import { PaymentStatus } from '../domain/enums';
import { DomainInvariants } from '../domain/invariants';
import { AuthorizationContext } from './authContext';
import { 
  InactiveCustomerError, 
  ClosedDayError, 
  NotFoundError, 
  ConflictError, 
  BusinessRuleViolation,
  IdempotencyConflictError,
  BinRequiredError,
  OrderNumberReservationExhaustedError,
  FinancialInvariantViolation
} from '../domain/errors';

export interface RepositoryContext {
  orderRepo: {
    findById(id: ID): Promise<OrderEntity | null> | (OrderEntity | null);
    save(order: OrderEntity): Promise<void> | void;
    countForDay(dayId: ID): Promise<number> | number;
  };
  reservationRepo?: {
    findActiveByDayAndDevice(dayId: ID, deviceId: ID): Promise<OrderNumberReservationEntity | null> | (OrderNumberReservationEntity | null);
    save(reservation: OrderNumberReservationEntity): Promise<void> | void;
    reserveRange(dayId: ID, deviceId: ID, commandId?: ID, rangeSize?: number): Promise<OrderNumberReservationEntity> | OrderNumberReservationEntity;
  };
  itemRepo: {
    findByOrderId(orderId: ID): Promise<OrderItemEntity[]> | OrderItemEntity[];
    save(item: OrderItemEntity): Promise<void> | void;
    findById(id: ID): Promise<OrderItemEntity | null> | (OrderItemEntity | null);
    isDeviceTypeInUse?(deviceTypeId: ID): Promise<boolean> | boolean;
  };
  customerRepo: {
    findById(id: ID): Promise<CustomerEntity | null> | (CustomerEntity | null);
    save(customer: CustomerEntity): Promise<void> | void;
    getBalance(id: ID): Promise<number> | number;
  };
  deviceRepo: {
    findById(id: ID): Promise<DeviceTypeEntity | null> | (DeviceTypeEntity | null);
    save(device: DeviceTypeEntity): Promise<void> | void;
    delete?(id: ID): Promise<void> | void;
    findAll(): Promise<DeviceTypeEntity[]> | DeviceTypeEntity[];
  };
  ledgerRepo: {
    append(event: Omit<FinancialLedgerEntity, 'id' | 'createdAt'> & { id?: ID; createdAt?: string }): Promise<void> | void;
    findByCustomer(customerId: ID): Promise<FinancialLedgerEntity[]> | FinancialLedgerEntity[];
    findAll(): Promise<FinancialLedgerEntity[]> | FinancialLedgerEntity[];
  };
  dayRepo: {
    findById(id: ID): Promise<BusinessDayEntity | null> | (BusinessDayEntity | null);
    save(day: BusinessDayEntity): Promise<void> | void;
    isClosed(dayId: ID): Promise<boolean> | boolean;
  };
  paymentRepo: {
    save(payment: PaymentEntity): Promise<void> | void;
    saveAllocation(allocation: PaymentAllocationEntity): Promise<void> | void;
    findByCustomer(customerId: ID): Promise<PaymentEntity[]> | PaymentEntity[];
    findAllAllocations(): Promise<PaymentAllocationEntity[]> | PaymentAllocationEntity[];
  };
  commandRepo: {
    get(commandId: ID): Promise<{ type: string; payload: unknown } | null> | ({ type: string; payload: unknown } | null);
    record(commandId: ID, type: string, payload: unknown, expectedVersion?: number): Promise<void> | void;
  };
  mutationSnapshotRepo?: {
    capture(commandId: ID, records: Array<{ table: string; id: ID; existed: boolean; data?: unknown }>): Promise<void> | void;
    clear(commandId: ID): Promise<void> | void;
  };
  overlayRepo?: {
    save(overlay: OptimisticOverlayRecord): Promise<void> | void;
    remove(commandId: ID): Promise<void> | void;
    get(commandId: ID): Promise<OptimisticOverlayRecord | null> | (OptimisticOverlayRecord | null);
    getNextSequence(): Promise<number> | number;
  };
  qrTokenRepo?: {
    findByHash(tokenHash: string): Promise<QrTokenEntity | null> | (QrTokenEntity | null);
    save(token: QrTokenEntity): Promise<void> | void;
    findActiveByTarget(targetId: ID, tokenType: 'CUSTOMER' | 'ORDER'): Promise<QrTokenEntity | null> | (QrTokenEntity | null);
  };
  goalRepo?: {
    findById(id: ID): Promise<GoalEntity | null> | (GoalEntity | null);
    findActiveByCustomerId(customerId: ID): Promise<GoalEntity | null> | (GoalEntity | null);
    findAllByCustomerId(customerId: ID): Promise<GoalEntity[]> | GoalEntity[];
    save(goal: GoalEntity): Promise<void> | void;
  };
  goalRequestRepo?: {
    findById(id: ID): Promise<GoalRequestEntity | null> | (GoalRequestEntity | null);
    findAllByCustomerId(customerId: ID): Promise<GoalRequestEntity[]> | GoalRequestEntity[];
    save(request: GoalRequestEntity): Promise<void> | void;
  };
  transactionManager: {
    runInTransaction<T>(work: (ctx: RepositoryContext) => T): Promise<T>;
  };
}

export class FinalUseCases {
  constructor(private deps: RepositoryContext) {}

  private async createOverlay(
    commandId: ID,
    mutationKey: string,
    entityType: string,
    entityId: ID,
    operation: 'CREATE' | 'PATCH' | 'DELETE',
    patchOrPayload: Record<string, unknown> | null
  ) {
    if (!this.deps.overlayRepo) {
      const existing = await localDb.listOverlays();
      const sequence = existing.reduce((max, row) => Math.max(max, row.sequence || 0), 0) + 1;
      const overlay: OptimisticOverlayRecord = {
        commandId,
        mutationKey,
        entityType,
        entityId,
        operation,
        ...(operation === 'CREATE' ? { entityPayload: patchOrPayload } : { patch: patchOrPayload }),
        sequence,
        createdAt: new Date().toISOString(),
        status: 'PENDING',
      };
      await localDb.saveOverlay(overlay);
      return;
    }
    const sequence = await this.deps.overlayRepo.getNextSequence();
    
    const overlay: OptimisticOverlayRecord = {
      commandId,
      mutationKey,
      entityType,
      entityId,
      operation,
      ...(operation === 'CREATE' ? { entityPayload: patchOrPayload } : { patch: patchOrPayload }),
      sequence,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
    };
    await this.deps.overlayRepo.save(overlay);
  }

  // ==========================================
  // ORDERS USE CASES
  // ==========================================

  async createOrder(
    auth: AuthorizationContext,
    commandId: ID,
    dayId: ID,
    customerId: ID,
    notes?: string,
    payloadHash?: unknown,
    groupId?: string
  ): Promise<Result<OrderEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('orders:create');

    // Local idempotency: retrying the same CREATE_ORDER command must return the
    // already-created local aggregate instead of attempting a second optimistic
    // write (which incorrectly trips the repository version check). A reused
    // command ID with a different semantic payload is a real idempotency conflict.
    const existingCommand = await this.deps.commandRepo.get(commandId);
    if (existingCommand) {
      if (existingCommand.type !== 'CREATE_ORDER') {
        throw new IdempotencyConflictError('Command ID is already associated with a different operation');
      }

      const existingPayload = (existingCommand.payload || {}) as Record<string, unknown>;
      const requestedPayload = (typeof payloadHash === 'object' && payloadHash !== null)
        ? (payloadHash as Record<string, unknown>)
        : {};
      const existingSemantic = {
        dayId: existingPayload.dayId,
        customerId: existingPayload.customerId,
        notes: existingPayload.notes ?? undefined,
      };
      const requestedSemantic = {
        dayId: requestedPayload.dayId ?? dayId,
        customerId: requestedPayload.customerId ?? customerId,
        notes: requestedPayload.notes ?? notes,
      };

      if (JSON.stringify(existingSemantic) !== JSON.stringify(requestedSemantic)) {
        throw new IdempotencyConflictError();
      }

      const existingOrder = await this.deps.orderRepo.findById(commandId);
      if (existingOrder) {
        return { success: true, data: existingOrder };
      }
      throw new IdempotencyConflictError('CREATE_ORDER command exists but its local aggregate is missing');
    }

    const customer = await this.deps.customerRepo.findById(customerId);
    if (!customer) throw new NotFoundError('Customer not found');
    if (!customer.isActive) throw new InactiveCustomerError();

    // The aggregate-only create path must enforce the same closed-day rule as
    // createOrderWithItems. Otherwise a regular admin can create a "pending"
    // order on a closed day, bypassing the transaction/rollback invariant.
    const dayIsClosed = await this.deps.dayRepo.isClosed(dayId);
    if (dayIsClosed && !actor.isSuperAdmin) {
      throw new ClosedDayError();
    }

    const currentBalance = await this.deps.customerRepo.getBalance(customerId);
    const allowed = checkDebtLimit(currentBalance, customer.debtLimitMinor, actor.isSuperAdmin);
    if (!allowed) {
      return { success: false, error: 'Debt limit exceeded. Regular admin blocked.', code: 'DEBT_LIMIT_EXCEEDED' };
    }

    const orderId = commandId || crypto.randomUUID();

    // The legacy createOrder path must use the same lazy reservation contract as
    // createOrderWithItems. Otherwise it emits displayNumber=0 and bypasses the
    // reservation state, which breaks numbering, backup/restore, and multi-device
    // sequencing for callers that create the aggregate before adding items.
    const deviceId = actor.deviceId || 'default-device';
    let reservation: OrderNumberReservationEntity | null = null;
    let displayNumber = 1;
    if (this.deps.reservationRepo) {
      reservation = await this.deps.reservationRepo.findActiveByDayAndDevice(dayId, deviceId);
      if (!reservation || reservation.nextNumber > reservation.endNumber) {
        reservation = await this.deps.reservationRepo.reserveRange(dayId, deviceId, orderId, 20);
      }
      if (!reservation || reservation.nextNumber > reservation.endNumber) {
        throw new OrderNumberReservationExhaustedError();
      }
      displayNumber = reservation.nextNumber;
      reservation.nextNumber += 1;
      if (reservation.nextNumber > reservation.endNumber) reservation.status = 'EXHAUSTED';
      reservation.updatedAt = new Date().toISOString();
    } else {
      displayNumber = (await this.deps.orderRepo.countForDay(dayId)) + 1;
    }

    const order: OrderEntity = {
      id: orderId,
      dayId,
      customerId,
      displayNumber,
      internalSequence: displayNumber,
      status: 'pending',
      customerBalanceSnapshotMinor: currentBalance,
      notes,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };

    const effectiveGroupId = groupId || (typeof payloadHash === 'object' && payloadHash !== null ? (payloadHash as any).groupId : undefined);

    const mutationKey = `order:${orderId}`;

    if (this.deps.mutationSnapshotRepo) {
      await this.deps.mutationSnapshotRepo.capture(orderId, [
        { table: 'orders', id: order.id, existed: false },
      ]);
    }

    /*
     * Keep the legacy createOrder contract safe for any existing caller:
     * persist the local entity and its CREATE_ORDER outbox command atomically.
     * The overlay remains only as the pending projection layer.
     */
    await this.deps.transactionManager.runInTransaction((ctx) => {
      ctx.orderRepo.save(order);
      if (reservation) ctx.reservationRepo?.save(reservation);
      ctx.commandRepo.record(orderId, 'CREATE_ORDER', {
        ...(typeof payloadHash === 'object' && payloadHash !== null ? payloadHash : {}),
        id: orderId,
        aggregateId: orderId,
        dayId: order.dayId,
        customerId: order.customerId,
        notes: order.notes,
        ...(effectiveGroupId ? { groupId: effectiveGroupId } : {}),
        customerBalanceSnapshotMinor: order.customerBalanceSnapshotMinor,
        displayNumber: order.displayNumber,
        orderNumber: (order as any).orderNumber ?? order.displayNumber,
      });
    });

    try {
      await this.createOverlay(
        orderId,
        mutationKey,
        'orders',
        orderId,
        'CREATE',
        order as unknown as Record<string, unknown>
      );
    } catch (overlayError) {
      console.warn(
        'Failed to persist order pending overlay; base local state is authoritative.',
        overlayError
      );
    }
    return { success: true, data: order };
  }

  async addOrderItem(
    auth: AuthorizationContext,
    orderId: ID,
    deviceTypeId: ID,
    hasCharger: boolean,
    commandId?: ID,
    groupId?: string
  ): Promise<Result<OrderItemEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('orders:edit');

    const order = await this.deps.orderRepo.findById(orderId);
    if (!order) throw new NotFoundError('Order not found');
    if (order.status === 'cancelled') throw new BusinessRuleViolation('Cannot add item to cancelled order');

    const dayIsClosed = await this.deps.dayRepo.isClosed(order.dayId);
    if (dayIsClosed && !actor.isSuperAdmin) {
      throw new ClosedDayError();
    }

    const customer = await this.deps.customerRepo.findById(order.customerId);
    if (!customer || !customer.isActive) throw new InactiveCustomerError();

    const deviceType = await this.deps.deviceRepo.findById(deviceTypeId);
    if (!deviceType || !deviceType.isActive) throw new NotFoundError('Device type not found or inactive');

    const pricing = calculateItemPrice({
      basePriceMinor: deviceType.basePriceMinor,
      chargerFeeEnabled: deviceType.chargerFeeEnabled,
      customerExempt: customer.chargerFeeExempt,
      hasCharger,
    });

    const existingItems = await this.deps.itemRepo.findByOrderId(orderId);
    const itemSequence = (Array.isArray(existingItems) ? existingItems.length : 0) + 1;

    const itemId = commandId || crypto.randomUUID();

    // A Super Admin is allowed to add a device to an already closed day.
    // The device is immediately recognized as delivered, but the financial
    // recognition still travels through the canonical DELIVER_ORDER_ITEM
    // command after ADD_ORDER_ITEM, preserving one authoritative charge.
    const autoDeliver = dayIsClosed && actor.isSuperAdmin;
    const item: OrderItemEntity = {
      id: itemId,
      orderId,
      deviceTypeId,
      itemSequence,
      status: autoDeliver ? 'delivered' : 'charging',
      financialStatus: autoDeliver ? 'RECOGNIZED' : 'UNRECOGNIZED',
      deviceNameSnapshot: deviceType.name,
      deviceIconSnapshot: deviceType.icon,
      basePriceSnapshotMinor: deviceType.basePriceMinor,
      chargerFeeEnabledSnapshot: deviceType.chargerFeeEnabled,
      customerChargerFeeExemptSnapshot: customer.chargerFeeExempt,
      chargerFeeSnapshotMinor: pricing.chargerFeeSnapshotMinor,
      hasCharger,
      unitPriceMinor: pricing.unitPriceMinor,
      totalPriceMinor: pricing.totalPriceMinor,
      deliveredAt: autoDeliver ? new Date().toISOString() : undefined,
      financiallyRecognizedAt: autoDeliver ? new Date().toISOString() : undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };

    const mutationKey = `order:${orderId}`;
    const orderReopened = order.status === 'delivered' && !autoDeliver;
    const reopenedOrder: OrderEntity = orderReopened
      ? { ...order, status: 'charging', updatedAt: item.updatedAt, version: order.version + 1 }
      : order;
    if (this.deps.mutationSnapshotRepo) {
      await this.deps.mutationSnapshotRepo.capture(itemId, [
        { table: 'orderItems', id: item.id, existed: false },
        ...(orderReopened ? [{ table: 'orders', id: order.id, existed: true, data: order }] : []),
      ]);
    }

    /*
     * Persist the new item and its outbox command atomically. The overlay is
     * only a pending projection; the local entity row is the durable read model.
     */
    const parentCreate = await this.deps.commandRepo.get(orderId);
    await this.deps.transactionManager.runInTransaction((ctx) => {
      if (orderReopened) ctx.orderRepo.save(reopenedOrder);
      ctx.itemRepo.save(item);
      ctx.commandRepo.record(itemId, 'ADD_ORDER_ITEM', {
        id: item.id,
        aggregateId: orderId,
        orderId,
        deviceTypeId,
        hasCharger,
        ...(parentCreate?.type === 'CREATE_ORDER' ? { dependencyCommandId: orderId } : {}),
        ...(groupId ? { groupId } : {}),
        deviceNameSnapshot: item.deviceNameSnapshot,
        deviceIconSnapshot: item.deviceIconSnapshot,
        basePriceSnapshotMinor: item.basePriceSnapshotMinor,
        chargerFeeEnabledSnapshot: item.chargerFeeEnabledSnapshot,
        customerChargerFeeExemptSnapshot: item.customerChargerFeeExemptSnapshot,
        chargerFeeSnapshotMinor: item.chargerFeeSnapshotMinor,
        unitPriceMinor: item.unitPriceMinor,
        totalPriceMinor: item.totalPriceMinor,
      });

      if (autoDeliver) {
        const deliveryCommandId = crypto.randomUUID();
        ctx.ledgerRepo.append({
          id: crypto.randomUUID(),
          eventType: 'ORDER_ITEM_CHARGE',
          amountMinor: -item.totalPriceMinor,
          customerId: order.customerId,
          orderId,
          orderItemId: item.id,
          actorAdminId: actor.id,
          referenceId: deliveryCommandId,
          createdAt: item.updatedAt,
        });
        // The ADD command and the auto-delivery command are separate server
        // transactions. Keep a rollback snapshot for the delivery command so
        // an authoritative delivery rejection restores the item to CHARGING
        // instead of leaving a locally "delivered" item with no charge.
        ctx.mutationSnapshotRepo?.capture(deliveryCommandId, [
          {
            table: 'orderItems',
            id: item.id,
            existed: true,
            data: {
              ...item,
              status: 'charging',
              financialStatus: 'UNRECOGNIZED',
              deliveredAt: undefined,
              financiallyRecognizedAt: undefined,
            },
          },
        ]);
        ctx.commandRepo.record(deliveryCommandId, 'DELIVER_ORDER_ITEM', {
          id: deliveryCommandId,
          aggregateId: item.id,
          itemId: item.id,
          orderItemId: item.id,
          orderId,
          autoDelivery: true,
          dependencyCommandId: item.id,
        }, item.version);
      }
    });

    try {
      if (orderReopened) {
        await this.createOverlay(
          itemId,
          mutationKey,
          'orders',
          order.id,
          'PATCH',
          { status: 'charging', updatedAt: reopenedOrder.updatedAt, version: reopenedOrder.version },
        );
      }
      await this.createOverlay(
        itemId,
        mutationKey,
        'orderItems',
        itemId,
        'CREATE',
        item as unknown as Record<string, unknown>
      );
    } catch (overlayError) {
      console.warn(
        'Failed to persist item pending overlay; base local state is authoritative.',
        overlayError
      );
    }
    return { success: true, data: item };
  }


  /**
   * Atomic order aggregate creation. The order row, every order item, their
   * outbox commands, and any initial financial entries are committed as one
   * local transaction. This prevents a failed item validation from leaving a
   * ghost CREATE_ORDER command behind.
   */
  async createOrderWithItems(
    auth: AuthorizationContext,
    commandId: ID,
    dayId: ID,
    customerId: ID,
    items: Array<{ deviceTypeId: ID; hasCharger: boolean }>,
    notes?: string,
    groupId?: string
  ): Promise<Result<{ order: OrderEntity; items: OrderItemEntity[] }>> {
    const actor = auth.requireAuth();
    auth.assertPermission('orders:create');
    auth.assertPermission('orders:edit');

    if (!items.length) return { success: false, error: 'At least one order item is required' };

    const isClosed = await this.deps.dayRepo.isClosed(dayId);
    if (isClosed && !actor.isSuperAdmin) throw new ClosedDayError();

    const customer = await this.deps.customerRepo.findById(customerId);
    if (!customer) throw new NotFoundError('Customer not found');
    if (!customer.isActive) throw new InactiveCustomerError();

    const currentBalance = await this.deps.customerRepo.getBalance(customerId);
    if (!checkDebtLimit(currentBalance, customer.debtLimitMinor, actor.isSuperAdmin)) {
      return { success: false, error: 'Debt limit exceeded. Regular admin blocked.', code: 'DEBT_LIMIT_EXCEEDED' };
    }

    const deviceId = actor.deviceId || 'default-device';
    let displayNumber = 1;
    let reservation: OrderNumberReservationEntity | null = null;
    if (this.deps.reservationRepo) {
      reservation = await this.deps.reservationRepo.findActiveByDayAndDevice(dayId, deviceId);
      if (!reservation || reservation.nextNumber > reservation.endNumber) {
        try {
          reservation = await this.deps.reservationRepo.reserveRange(dayId, deviceId, commandId, 20);
        } catch {
          throw new OrderNumberReservationExhaustedError();
        }
      }
      if (!reservation || reservation.nextNumber > reservation.endNumber) throw new OrderNumberReservationExhaustedError();
      displayNumber = reservation.nextNumber;
      reservation.nextNumber += 1;
      if (reservation.nextNumber > reservation.endNumber) reservation.status = 'EXHAUSTED';
      reservation.updatedAt = new Date().toISOString();
    } else {
      displayNumber = (await this.deps.orderRepo.countForDay(dayId)) + 1;
    }

    const now = new Date().toISOString();
    const order: OrderEntity = {
      id: commandId || crypto.randomUUID(),
      dayId,
      customerId,
      displayNumber,
      internalSequence: displayNumber,
      status: 'pending',
      customerBalanceSnapshotMinor: currentBalance,
      notes,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    const preparedItems: OrderItemEntity[] = [];
    for (let index = 0; index < items.length; index++) {
      const requested = items[index];
      const deviceType = await this.deps.deviceRepo.findById(requested.deviceTypeId);
      if (!deviceType || !deviceType.isActive) throw new NotFoundError('Device type not found or inactive');

      const pricing = calculateItemPrice({
        basePriceMinor: deviceType.basePriceMinor,
        chargerFeeEnabled: deviceType.chargerFeeEnabled,
        chargerFeeApplicable: deviceType.chargerFeeApplicable ?? deviceType.chargerFeeEnabled,
        customerExempt: customer.chargerFeeExempt,
        hasCharger: requested.hasCharger,
      });

      const initialStatus = isClosed && actor.isSuperAdmin ? 'delivered' : 'charging';
      preparedItems.push({
        id: crypto.randomUUID(),
        orderId: order.id,
        deviceTypeId: requested.deviceTypeId,
        itemSequence: index + 1,
        status: initialStatus,
        financialStatus: initialStatus === 'delivered' ? 'RECOGNIZED' : 'UNRECOGNIZED',
        deviceNameSnapshot: deviceType.name,
        deviceIconSnapshot: deviceType.icon,
        basePriceSnapshotMinor: deviceType.basePriceMinor,
        chargerFeeEnabledSnapshot: deviceType.chargerFeeEnabled,
        customerChargerFeeExemptSnapshot: customer.chargerFeeExempt,
        chargerFeeSnapshotMinor: pricing.chargerFeeSnapshotMinor,
        hasCharger: requested.hasCharger,
        unitPriceMinor: pricing.unitPriceMinor,
        totalPriceMinor: pricing.totalPriceMinor,
        deliveredAt: initialStatus === 'delivered' ? now : undefined,
        financiallyRecognizedAt: initialStatus === 'delivered' ? now : undefined,
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
    }

    // Order-level status is an aggregate completion state: it remains PENDING
    // until every active item is delivered. Item-level status carries CHARGING.
    // This prevents delivering one device from incorrectly completing the whole
    // order while preserving the per-device charging state.
    order.status = preparedItems.every(item => item.status === 'delivered') ? 'delivered' : 'pending';
    order.updatedAt = now;

    const mutationKey = `order:${order.id}`;

    if (this.deps.mutationSnapshotRepo) {
      await this.deps.mutationSnapshotRepo.capture(commandId, [
        { table: 'orders', id: order.id, existed: false },
        ...preparedItems.map(item => ({ table: 'orderItems', id: item.id, existed: false })),
      ]);
    }

    /*
     * LOCAL READ-MODEL INVARIANT:
     * The order aggregate must exist in the authoritative local entity stores
     * in the SAME transaction as its outbox commands. Optimistic overlays remain
     * a presentation/pending layer only; they are never the only copy of a new
     * order or item.
     */
    await this.deps.transactionManager.runInTransaction((ctx) => {
      ctx.orderRepo.save(order);
      // Persist the consumed reservation cursor in the same transaction as the
      // order. Mutating only the returned in-memory reservation would reset the
      // next number after restart/backup restore.
      if (reservation) ctx.reservationRepo?.save(reservation);

      ctx.commandRepo.record(commandId, 'CREATE_ORDER', {
        id: order.id,
        aggregateId: order.id,
        dayId,
        customerId,
        displayNumber,
        notes,
        customerBalanceSnapshotMinor: currentBalance,
        ...(groupId ? { groupId } : {}),
      });

      for (const item of preparedItems) {
        // Closed-day Super Admin auto-delivery is a composite ADD + DELIVERY.
        // Keep the base item at the durable pre-delivery state until the
        // independent delivery command is accepted; the overlay exposes the
        // immediate delivered projection to the UI.
        const persistedItem = item.status === 'delivered'
          ? {
              ...item,
              status: 'charging' as const,
              financialStatus: 'UNRECOGNIZED' as const,
              deliveredAt: undefined,
              financiallyRecognizedAt: undefined,
            }
          : item;
        ctx.itemRepo.save(persistedItem);

        if (item.status === 'delivered') {
          ctx.ledgerRepo.append({
            id: crypto.randomUUID(),
            eventType: 'ORDER_ITEM_CHARGE',
            amountMinor: -item.totalPriceMinor,
            customerId,
            orderId: order.id,
            orderItemId: item.id,
            actorAdminId: actor.id,
            referenceId: item.id,
            createdAt: now,
          });
        }

        ctx.commandRepo.record(item.id, 'ADD_ORDER_ITEM', {
          id: item.id,
          aggregateId: item.id,
          orderId: order.id,
          deviceTypeId: item.deviceTypeId,
          hasCharger: item.hasCharger,
          ...(groupId ? { groupId } : {}),
          deviceNameSnapshot: item.deviceNameSnapshot,
          deviceIconSnapshot: item.deviceIconSnapshot,
          basePriceSnapshotMinor: item.basePriceSnapshotMinor,
          chargerFeeEnabledSnapshot: item.chargerFeeEnabledSnapshot,
          customerChargerFeeExemptSnapshot: item.customerChargerFeeExemptSnapshot,
          chargerFeeSnapshotMinor: item.chargerFeeSnapshotMinor,
          unitPriceMinor: item.unitPriceMinor,
          totalPriceMinor: item.totalPriceMinor,
          dependencyCommandId: commandId,
        });

        if (item.status === 'delivered') {
          const deliveryCommandId = crypto.randomUUID();
          // Same invariant as the single-item closed-day path: the delivery
          // command must be independently rollback-safe after ADD succeeds.
          ctx.mutationSnapshotRepo?.capture(deliveryCommandId, [
            {
              table: 'orderItems',
              id: item.id,
              existed: true,
              data: {
                ...item,
                status: 'charging',
                financialStatus: 'UNRECOGNIZED',
                deliveredAt: undefined,
                financiallyRecognizedAt: undefined,
              },
            },
          ]);
          ctx.commandRepo.record(deliveryCommandId, 'DELIVER_ORDER_ITEM', {
            id: deliveryCommandId,
            aggregateId: item.id,
            itemId: item.id,
            orderItemId: item.id,
            orderId: order.id,
            autoDelivery: true,
            dependencyCommandId: item.id,
          }, item.version);
        }
      }
    });

    /*
     * Keep overlays for pending-state/projection compatibility with existing
     * UI and sync cleanup. They are deliberately written AFTER the atomic
     * entity+outbox commit so an overlay failure can never hide a valid local
     * order or strand its outbox commands.
     */
    try {
      await this.createOverlay(
        commandId,
        mutationKey,
        'orders',
        order.id,
        'CREATE',
        order as unknown as Record<string, unknown>
      );

      for (const item of preparedItems) {
        const itemOverlayId = `${commandId}:item:${item.id}`;
        await this.createOverlay(
          itemOverlayId,
          mutationKey,
          'orderItems',
          item.id,
          'CREATE',
          item as unknown as Record<string, unknown>
        );
      }
    } catch (overlayError) {
      console.warn(
        'Failed to persist order pending overlays; base local state is authoritative.',
        overlayError
      );
    }
    return { success: true, data: { order, items: preparedItems } };
  }

  async addItemToDeliveredOrder(
    auth: AuthorizationContext,
    orderId: ID,
    deviceTypeId: ID,
    hasCharger: boolean
  ): Promise<Result<OrderItemEntity>> {
    return this.addOrderItem(auth, orderId, deviceTypeId, hasCharger);
  }

  async deliverOrderItem(auth: AuthorizationContext, itemId: ID, bin: string): Promise<Result<OrderItemEntity>> {
    const actor = auth.requireAuth(); auth.assertPermission('orders:deliver'); await auth.verifyBin(bin);
    const item = await this.deps.itemRepo.findById(itemId); if (!item) throw new NotFoundError('Item not found');
    const order = await this.deps.orderRepo.findById(item.orderId); if (!order) throw new NotFoundError('Order not found');
    const dayIsClosed = await this.deps.dayRepo.isClosed(order.dayId); if (dayIsClosed && !actor.isSuperAdmin) throw new ClosedDayError();
    const orderItems = await this.deps.itemRepo.findByOrderId(order.id);
    if (orderItems.filter(i => i.status !== 'cancelled').length === 0) throw new BusinessRuleViolation('Cannot deliver or recognize an empty order');
    const customer = await this.deps.customerRepo.findById(order.customerId); if (!customer) throw new NotFoundError('Customer not found');
    DomainInvariants.assertCustomerActive(customer); DomainInvariants.assertOrderNotCancelledForRecognition(order.status);
    if (item.status === 'delivered') throw new FinancialInvariantViolation(`Order item ${item.id} is already delivered.`);
    validateItemTransition(item.status, 'delivered');
    DomainInvariants.assertItemNotRecognizedTwice(item.id, await this.deps.ledgerRepo.findByCustomer(order.customerId));
    const projectedBalance = (await this.deps.customerRepo.getBalance(order.customerId)) - item.totalPriceMinor;
    if (!checkDebtLimit(projectedBalance, customer.debtLimitMinor, actor.isSuperAdmin)) throw new BusinessRuleViolation(`Debt limit exceeded: Customer debt limit of ${customer.debtLimitMinor} minor units exceeded by projected balance ${projectedBalance}`);
    const deliveredAt = new Date().toISOString();
    const patch: Partial<OrderItemEntity> = { status:'delivered', financialStatus:'RECOGNIZED', deliveredAt, financiallyRecognizedAt:deliveredAt, updatedAt:deliveredAt, version:item.version+1 };
    const commandId = crypto.randomUUID();
    const chargeLedger: Omit<FinancialLedgerEntity, 'createdAt'> & { createdAt?: string } = {
      id: commandId,
      eventType: 'ORDER_ITEM_CHARGE',
      amountMinor: -item.totalPriceMinor,
      customerId: order.customerId,
      orderId: order.id,
      orderItemId: item.id,
      actorAdminId: actor.id,
      referenceId: commandId,
      createdAt: deliveredAt,
    };
    const nextItems = orderItems.map((candidate) => candidate.id === item.id ? ({ ...candidate, ...patch } as OrderItemEntity) : candidate);
    const activeAfter = nextItems.filter((candidate) => candidate.status !== 'cancelled');
    const nextOrderStatus: OrderEntity['status'] = activeAfter.length > 0 && activeAfter.every((candidate) => candidate.status === 'delivered')
      ? 'delivered'
      : 'pending';
    const orderStatusChanged = order.status !== nextOrderStatus;
    const nextOrder: OrderEntity = orderStatusChanged
      ? { ...order, status: nextOrderStatus, updatedAt: deliveredAt, version: order.version + 1 }
      : order;
    if (this.deps.mutationSnapshotRepo) await this.deps.mutationSnapshotRepo.capture(commandId,[
      {table:'orderItems',id:item.id,existed:true,data:item},
      ...(orderStatusChanged ? [{table:'orders',id:order.id,existed:true,data:order}] : []),
    ]);
    const parentAdd = await this.deps.commandRepo.get(item.id);
    await this.deps.transactionManager.runInTransaction(async (ctx) => {
      // Delivery is an optimistic composite mutation: keep the durable base
      // entity at its pre-delivery state until the authoritative command is
      // accepted, while the effective local read model is immediately patched
      // by the overlay below. This prevents a rejected/failed delivery from
      // looking financially recognized in the base row and preserves the
      // local-first invariant without waiting for a remote delta.
      ctx.ledgerRepo.append(chargeLedger);
      if (ctx.goalRepo) {
        await this.evaluateCustomerGoal(order.customerId, ctx);
      }
      ctx.commandRepo.record(commandId,'DELIVER_ORDER_ITEM',{
        id:commandId,
        aggregateId:item.id,
        itemId:item.id,
        orderItemId:item.id,
        orderId:order.id,
        bin,
        ...(parentAdd?.type === 'ADD_ORDER_ITEM' ? { dependencyCommandId: item.id } : {}),
      },item.version);
    });
    try {
      if (orderStatusChanged) {
        // One delivery command can produce two projections (order + item).
        // Overlay storage is keyed by overlay command ID, so these projections
        // must have distinct durable overlay IDs or the second write silently
        // replaces the first.
        await this.createOverlay(`${commandId}:order`, `order:${order.id}`, 'orders', order.id, 'PATCH', {
          status: nextOrder.status,
          updatedAt: nextOrder.updatedAt,
          version: nextOrder.version,
        });
      }
      await this.createOverlay(`${commandId}:item`,`order:${order.id}`,'orderItems',itemId,'PATCH',patch as Record<string,unknown>);
    } catch(e) { console.warn('Delivery pending projection failed; local aggregate is authoritative.',e); }
    return {success:true,data:{...item,...patch} as OrderItemEntity};
  }

  /**
   * Queue a delivery intent while offline without pretending that BIN
   * authorization or financial recognition already happened. The server must
   * authorize the same command with BIN before it can recognize the charge.
   */
  async queueDeliveryAwaitingBin(
    auth: AuthorizationContext,
    itemId: ID
  ): Promise<Result<OrderItemEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('orders:deliver');

    const item = await this.deps.itemRepo.findById(itemId);
    if (!item) throw new NotFoundError('Item not found');

    const order = await this.deps.orderRepo.findById(item.orderId);
    if (!order) throw new NotFoundError('Order not found');
    if (order.status === 'cancelled') {
      throw new BusinessRuleViolation('Cannot deliver an item from a cancelled order');
    }

    const customer = await this.deps.customerRepo.findById(order.customerId);
    if (!customer) throw new NotFoundError('Customer not found');
    DomainInvariants.assertCustomerActive(customer);

    if (item.status === 'delivered') {
      throw new FinancialInvariantViolation(`Order item ${item.id} is already delivered.`);
    }

    validateItemTransition(item.status, 'delivered');

    const commandId = crypto.randomUUID();
    await this.deps.transactionManager.runInTransaction((ctx) => {
      ctx.commandRepo.record(commandId, 'DELIVER_ORDER_ITEM', {
        id: commandId,
        aggregateId: item.id,
        itemId: item.id,
        orderItemId: item.id,
        orderId: order.id,
        authorizationState: 'PENDING_BIN',
      }, item.version);
    });

    return {
      success: true,
      data: item,
    };
  }

  /**
   * Queue a protected order cancellation while offline. No financial reversal
   * or authoritative status change is applied locally until the server verifies BIN.
   */
  async queueCancelOrderAwaitingBin(
    auth: AuthorizationContext,
    orderId: ID
  ): Promise<Result<OrderEntity>> {
    auth.requireAuth();
    auth.assertPermission('orders:cancel');

    const order = await this.deps.orderRepo.findById(orderId);
    if (!order) throw new NotFoundError('Order not found');
    validateOrderTransition(order.status, 'cancelled');

    const commandId = crypto.randomUUID();
    await this.deps.transactionManager.runInTransaction((ctx) => {
      ctx.commandRepo.record(commandId, 'CANCEL_ORDER', {
        id: commandId,
        aggregateId: orderId,
        orderId,
        authorizationState: 'PENDING_BIN',
      }, order.version);
    });

    return { success: true, data: order };
  }

  /** Queue a protected item cancellation while offline. No authoritative financial state changes locally. */
  async queueCancelOrderItemAwaitingBin(
    auth: AuthorizationContext,
    itemId: ID
  ): Promise<Result<OrderItemEntity>> {
    auth.requireAuth();
    auth.assertPermission('orders:cancel');

    const item = await this.deps.itemRepo.findById(itemId);
    if (!item) throw new NotFoundError('Item not found');
    const order = await this.deps.orderRepo.findById(item.orderId);
    if (!order) throw new NotFoundError('Order not found');
    validateItemTransition(item.status, 'cancelled');

    const commandId = crypto.randomUUID();
    await this.deps.transactionManager.runInTransaction((ctx) => {
      ctx.commandRepo.record(commandId, 'CANCEL_ORDER_ITEM', {
        id: commandId,
        aggregateId: order.id,
        itemId: item.id,
        orderItemId: item.id,
        orderId: order.id,
        authorizationState: 'PENDING_BIN',
      }, item.version);
    });

    return { success: true, data: item };
  }

  async editOrderNotes(auth: AuthorizationContext, orderId: ID, notes?: string): Promise<Result<OrderEntity>> {
    const actor=auth.requireAuth(); auth.assertPermission('orders:edit');
    const existing=await this.deps.orderRepo.findById(orderId); if(!existing) throw new NotFoundError('Order not found');
    if(await this.deps.dayRepo.isClosed(existing.dayId) && !actor.isSuperAdmin) throw new ClosedDayError();
    if(existing.status==='cancelled') throw new BusinessRuleViolation('Cannot edit a cancelled order');
    const updatedAt=new Date().toISOString(); const patch:Partial<OrderEntity>={notes:notes?.trim()||undefined,updatedAt,version:existing.version+1};
    const updatedOrder={...existing,...patch} as OrderEntity; const commandId=crypto.randomUUID();
    if(this.deps.mutationSnapshotRepo) await this.deps.mutationSnapshotRepo.capture(commandId,[{table:'orders',id:existing.id,existed:true,data:existing}]);
    await this.deps.transactionManager.runInTransaction((ctx)=>{ctx.orderRepo.save(updatedOrder);ctx.commandRepo.record(commandId,'UPDATE_ORDER',{id:orderId,aggregateId:orderId,orderId,notes:patch.notes},existing.version);});
    try{await this.createOverlay(commandId,`order:${orderId}`,'orders',orderId,'PATCH',patch as Record<string,unknown>);}catch(e){console.warn('Order pending projection failed; local order is authoritative.',e);}
    return {success:true,data:updatedOrder};
  }

  async removeOrderItemDuringEdit(auth: AuthorizationContext, itemId: ID): Promise<Result<OrderItemEntity>> {
    const actor=auth.requireAuth(); auth.assertPermission('orders:edit');
    const item=await this.deps.itemRepo.findById(itemId); if(!item) throw new NotFoundError('Item not found');
    const order=await this.deps.orderRepo.findById(item.orderId); if(!order) throw new NotFoundError('Order not found');
    if(await this.deps.dayRepo.isClosed(order.dayId) && !actor.isSuperAdmin) throw new ClosedDayError();
    validateItemTransition(item.status,'cancelled');
    const updatedAt=new Date().toISOString(); const patch:Partial<OrderItemEntity>={status:'cancelled',updatedAt,version:item.version+1};
    const updatedItem={...item,...patch} as OrderItemEntity; const commandId=crypto.randomUUID();
    const priorLedger = (await this.deps.ledgerRepo.findByCustomer(order.customerId)) || [];
    const priorCharge = [...priorLedger]
      .reverse()
      .find((entry) =>
        (entry.eventType === 'ORDER_ITEM_CHARGE' || entry.eventType === 'CHARGE') &&
        entry.orderItemId === item.id
      );
    if(this.deps.mutationSnapshotRepo) await this.deps.mutationSnapshotRepo.capture(commandId,[{table:'orderItems',id:item.id,existed:true,data:item}]);
    await this.deps.transactionManager.runInTransaction((ctx)=>{
      ctx.itemRepo.save(updatedItem);
      if (priorCharge || item.financialStatus === 'RECOGNIZED' || item.status === 'delivered') {
        ctx.ledgerRepo.append({
          id: crypto.randomUUID(),
          eventType: 'REVERSAL',
          amountMinor: priorCharge ? -priorCharge.amountMinor : Math.abs(item.totalPriceMinor),
          customerId: order.customerId,
          orderId: order.id,
          orderItemId: item.id,
          actorAdminId: actor.id,
          referenceId: commandId,
          createdAt: updatedAt,
        });
      }
      ctx.commandRepo.record(commandId,'CANCEL_ORDER_ITEM',{id:commandId,aggregateId:order.id,itemId,orderItemId:itemId,orderId:order.id},item.version);
    });
    try{await this.createOverlay(commandId,`order:${order.id}`,'orderItems',item.id,'PATCH',patch as Record<string,unknown>);}catch(e){console.warn('Cancellation projection failed; local item is authoritative.',e);}
    return {success:true,data:updatedItem};
  }

  async cancelOrder(auth: AuthorizationContext, orderId: ID, bin: string): Promise<Result<OrderEntity>> {
    const actor=auth.requireAuth(); auth.assertPermission('orders:cancel'); await auth.verifyBin(bin);
    const order=await this.deps.orderRepo.findById(orderId); if(!order) throw new NotFoundError('Order not found');
    if(await this.deps.dayRepo.isClosed(order.dayId) && !actor.isSuperAdmin) throw new ClosedDayError();
    validateOrderTransition(order.status,'cancelled');
    const items=await this.deps.itemRepo.findByOrderId(orderId); const activeItems=items.filter(i=>i.status!=='cancelled');
    const commandId=crypto.randomUUID(); const cancelledAt=new Date().toISOString();
    const customerLedger = (await this.deps.ledgerRepo.findByCustomer(order.customerId)) || [];
    const updatedOrder={...order,status:'cancelled' as const,cancelledAt,updatedAt:cancelledAt,version:order.version+1};
    const updatedItems=activeItems.map(item=>({
      ...item,
      status:'cancelled' as const,
      financialStatus: (item.financialStatus === 'RECOGNIZED' || item.status === 'delivered') ? 'REVERSED' as const : item.financialStatus,
      cancelledAt,
      updatedAt:cancelledAt,
      version:item.version+1
    }));
    if(this.deps.mutationSnapshotRepo) await this.deps.mutationSnapshotRepo.capture(commandId,[{table:'orders',id:order.id,existed:true,data:order},...activeItems.map(i=>({table:'orderItems',id:i.id,existed:true,data:i}))]);
    await this.deps.transactionManager.runInTransaction((ctx)=>{
      ctx.orderRepo.save(updatedOrder);
      for(const item of updatedItems) {
        ctx.itemRepo.save(item);
        if (item.financialStatus === 'REVERSED') {
          const originalCharge = [...customerLedger]
            .reverse()
            .find((entry) =>
              (entry.eventType === 'ORDER_ITEM_CHARGE' || entry.eventType === 'CHARGE') &&
              entry.orderItemId === item.id
            );
          const reversalAmount = originalCharge ? -originalCharge.amountMinor : Math.abs(item.totalPriceMinor);
          ctx.ledgerRepo.append({
            id: crypto.randomUUID(),
            eventType: 'REVERSAL',
            amountMinor: reversalAmount,
            customerId: order.customerId,
            orderId: order.id,
            orderItemId: item.id,
            actorAdminId: actor.id,
            referenceId: commandId,
            createdAt: cancelledAt,
          });
        }
      }
      ctx.commandRepo.record(commandId,'CANCEL_ORDER',{id:commandId,aggregateId:orderId,orderId,bin},order.version);
    });
    try{for(const item of updatedItems)await this.createOverlay(`${commandId}:${item.id}`,`order:${orderId}`,'orderItems',item.id,'PATCH',{status:'cancelled',cancelledAt,updatedAt:cancelledAt,version:item.version});await this.createOverlay(commandId,`order:${orderId}`,'orders',orderId,'PATCH',{status:'cancelled',cancelledAt,updatedAt:cancelledAt,version:updatedOrder.version});}catch(e){console.warn('Cancellation projections failed; local aggregate is authoritative.',e);}
    return {success:true,data:updatedOrder};
  }

  async cancelOrderItem(
    auth: AuthorizationContext,
    itemId: ID,
    bin: string
  ): Promise<Result<OrderItemEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('orders:cancel');
    await auth.verifyBin(bin);

    const existingItem = await this.deps.itemRepo.findById(itemId);
    if (!existingItem) throw new NotFoundError('Item not found');
    validateItemTransition(existingItem.status, 'cancelled');

    const order = await this.deps.orderRepo.findById(existingItem.orderId);
    if (!order) throw new NotFoundError('Order not found');

    const dayIsClosed = await this.deps.dayRepo.isClosed(order.dayId);
    if (dayIsClosed && !actor.isSuperAdmin) {
      throw new ClosedDayError();
    }

    const commandId = crypto.randomUUID();
    const mutationKey = `order:${order.id}`;
    
    const cancellationWasFinanciallyRecognized =
      existingItem.financialStatus === 'RECOGNIZED' || existingItem.status === 'delivered';

    const patch = {
      status: 'cancelled' as const,
      financialStatus: cancellationWasFinanciallyRecognized ? 'REVERSED' as const : existingItem.financialStatus,
      cancelledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: existingItem.version + 1,
    };

    if (this.deps.mutationSnapshotRepo) {
      await this.deps.mutationSnapshotRepo.capture(commandId, [
        { table: 'orderItems', id: existingItem.id, existed: true, data: existingItem },
      ]);
    }

    await this.deps.transactionManager.runInTransaction((ctx) => {
      ctx.itemRepo.save({ ...existingItem, ...patch } as OrderItemEntity);
      if (cancellationWasFinanciallyRecognized) {
        ctx.ledgerRepo.append({
          id: crypto.randomUUID(),
          eventType: 'REVERSAL',
          amountMinor: Math.abs(existingItem.totalPriceMinor),
          customerId: order.customerId,
          orderId: order.id,
          orderItemId: existingItem.id,
          actorAdminId: actor.id,
          referenceId: commandId,
          createdAt: patch.updatedAt,
        });
      }
      ctx.commandRepo.record(commandId, 'CANCEL_ORDER_ITEM', {
        id: commandId,
        aggregateId: order.id,
        itemId: itemId,
        orderItemId: itemId,
        orderId: order.id,
        bin,
      }, existingItem.version);
    });

    try {
      await this.createOverlay(commandId, mutationKey, 'orderItems', itemId, 'PATCH', patch as Record<string, unknown>);
    } catch (overlayError) {
      console.warn('Cancellation pending projection failed; local item is authoritative.', overlayError);
    }

    /*
     * The local entity row is now the durable read model; the overlay is only
     * an additional pending projection. This mirrors delivery/add-item and
     * makes cancellation immediately visible and rollback-safe.
     */
    return { success: true, data: { ...existingItem, ...patch } as OrderItemEntity };
  }

  // ==========================================
  // CUSTOMER USE CASES
  // ==========================================

  async createCustomer(
    auth: AuthorizationContext,
    name: string,
    phone?: string,
    debtLimitMinor: number = 0,
    chargerFeeExempt: boolean = false,
    commandId?: ID,
    groupId?: string
  ): Promise<Result<CustomerEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('customers:create');
    if (!Number.isInteger(debtLimitMinor)) {
      throw new BusinessRuleViolation('Debt limit must be an integer in minor units');
    }

    const customerId = commandId || crypto.randomUUID();
    const customer: CustomerEntity = {
      id: customerId,
      name,
      phone,
      isActive: true,
      debtLimitMinor,
      chargerFeeExempt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };

    return this.deps.transactionManager.runInTransaction((ctx) => {
      ctx.customerRepo.save(customer);
      ctx.commandRepo.record(customer.id, 'CREATE_CUSTOMER', {
        ...customer,
        ...(groupId ? { groupId } : {})
      });
      return { success: true, data: customer };
    });
  }

  async updateCustomer(auth: AuthorizationContext, customerId: ID, updates: Partial<CustomerEntity>): Promise<Result<CustomerEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('customers:edit');
    if (updates.debtLimitMinor !== undefined && !Number.isInteger(updates.debtLimitMinor)) {
      throw new BusinessRuleViolation('Debt limit must be an integer in minor units');
    }
    const customer = await this.deps.customerRepo.findById(customerId);
    if (!customer) throw new NotFoundError('Customer not found');

    const updatedCustomer: CustomerEntity = {
      ...customer,
      ...updates,
      updatedAt: new Date().toISOString(),
      version: customer.version + 1,
    };

    return this.deps.transactionManager.runInTransaction((ctx) => {
      const commandId = crypto.randomUUID();
      ctx.customerRepo.save(updatedCustomer);
      ctx.commandRepo.record(commandId, 'UPDATE_CUSTOMER', updatedCustomer, customer.version);
      return { success: true, data: updatedCustomer };
    });
  }

  async deactivateCustomer(auth: AuthorizationContext, customerId: ID): Promise<Result<CustomerEntity>> {
    return this.updateCustomer(auth, customerId, { isActive: false });
  }

  async updateCustomerDebtLimit(auth: AuthorizationContext, customerId: ID, newLimitMinor: number, bin: string): Promise<Result<CustomerEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('customers:debt-limit');
    await auth.verifyBin(bin);
    return this.updateCustomer(auth, customerId, { debtLimitMinor: newLimitMinor });
  }

  async updateCustomerChargerFeeExemption(auth: AuthorizationContext, customerId: ID, exempt: boolean, bin: string): Promise<Result<CustomerEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('customers:charger-exemption');
    await auth.verifyBin(bin);
    return this.updateCustomer(auth, customerId, { chargerFeeExempt: exempt });
  }

  async updateCustomerNotes(auth: AuthorizationContext, customerId: ID, notes: string, bin: string): Promise<Result<CustomerEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('customers:edit');
    await auth.verifyBin(bin);
    return this.updateCustomer(auth, customerId, { notes });
  }

  // ==========================================
  // DEVICE TYPE USE CASES
  // ==========================================

  async createDeviceType(
    auth: AuthorizationContext,
    name: string,
    icon: string,
    basePriceMinor: number,
    chargerFeeEnabled: boolean = true,
    nameAr?: string,
    nameEn?: string,
    sortOrder: number = 0,
    isActive: boolean = true
  ): Promise<Result<DeviceTypeEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('devices:manage');
    if (!Number.isInteger(basePriceMinor) || basePriceMinor < 0) {
      throw new BusinessRuleViolation('Device price must be a non-negative integer in minor units');
    }
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      throw new BusinessRuleViolation('Device sort order must be a non-negative integer');
    }

    const device: DeviceTypeEntity = {
      id: crypto.randomUUID(),
      name,
      nameAr: nameAr || name,
      nameEn,
      icon,
      basePriceMinor,
      chargerFeeEnabled,
      chargerFeeApplicable: chargerFeeEnabled,
      isActive,
      sortOrder,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };

    return this.deps.transactionManager.runInTransaction((ctx) => {
      // Inserting at a numbered position shifts existing entries down instead
      // of creating duplicate sort_order values. The shift and creation share
      // one local transaction, so the UI can never observe a half-reordered list.
      if (device.sortOrder > 0 && ctx.deviceRepo.findAll) {
        const existing = (ctx.deviceRepo.findAll as any)() as DeviceTypeEntity[];
        for (const existingDevice of existing) {
          if (existingDevice.sortOrder >= device.sortOrder) {
            existingDevice.sortOrder += 1;
            existingDevice.version += 1;
            existingDevice.updatedAt = new Date().toISOString();
            ctx.deviceRepo.save(existingDevice);
            const shiftCommandId = crypto.randomUUID();
            ctx.commandRepo.record(shiftCommandId, 'UPDATE_DEVICE_TYPE', {
              id: existingDevice.id,
              aggregateId: existingDevice.id,
              deviceTypeId: existingDevice.id,
              name: existingDevice.name,
              arabicName: existingDevice.nameAr || existingDevice.name,
              englishName: existingDevice.nameEn || existingDevice.name,
              icon: existingDevice.icon,
              basePriceMinor: existingDevice.basePriceMinor,
              chargerFeeEnabled: existingDevice.chargerFeeEnabled,
              chargerFeeApplicable: existingDevice.chargerFeeApplicable ?? existingDevice.chargerFeeEnabled,
              sortOrder: existingDevice.sortOrder,
              isActive: existingDevice.isActive,
              version: existingDevice.version,
            }, existingDevice.version - 1);
          }
        }
      }

      ctx.deviceRepo.save(device);
      ctx.commandRepo.record(device.id, 'CREATE_DEVICE_TYPE', {
        id: device.id,
        name: device.name,
        arabicName: device.nameAr || device.name,
        englishName: device.nameEn || device.name,
        icon: device.icon,
        basePriceMinor: device.basePriceMinor,
        chargerFeeEnabled: device.chargerFeeEnabled,
        chargerFeeApplicable: device.chargerFeeApplicable ?? device.chargerFeeEnabled,
        sortOrder: device.sortOrder,
        isActive: device.isActive,
        version: device.version,
      });
      return { success: true, data: device };
    });
  }

  async updateDeviceType(auth: AuthorizationContext, deviceId: ID, updates: Partial<DeviceTypeEntity>): Promise<Result<DeviceTypeEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('devices:manage');
    if (updates.basePriceMinor !== undefined && (!Number.isInteger(updates.basePriceMinor) || updates.basePriceMinor < 0)) {
      throw new BusinessRuleViolation('Device price must be a non-negative integer in minor units');
    }
    if (updates.sortOrder !== undefined && (!Number.isInteger(updates.sortOrder) || updates.sortOrder < 0)) {
      throw new BusinessRuleViolation('Device sort order must be a non-negative integer');
    }
    const device = await this.deps.deviceRepo.findById(deviceId);
    if (!device) throw new NotFoundError('Device type not found');

    const updatedDevice: DeviceTypeEntity = {
      ...device,
      ...updates,
      updatedAt: new Date().toISOString(),
      version: device.version + 1,
    };

    return this.deps.transactionManager.runInTransaction((ctx) => {
      const commandId = crypto.randomUUID();
      ctx.deviceRepo.save(updatedDevice);
      ctx.commandRepo.record(commandId, 'UPDATE_DEVICE_TYPE', {
        id: updatedDevice.id,
        deviceTypeId: updatedDevice.id,
        name: updatedDevice.name,
        arabicName: updatedDevice.nameAr || updatedDevice.name,
        englishName: updatedDevice.nameEn || updatedDevice.name,
        // Keep canonical names plus compatibility aliases for older transports/tests.
        nameAr: updatedDevice.nameAr || updatedDevice.name,
        nameEn: updatedDevice.nameEn || updatedDevice.name,
        icon: updatedDevice.icon,
        basePriceMinor: updatedDevice.basePriceMinor,
        chargerFeeEnabled: updatedDevice.chargerFeeEnabled,
        chargerFeeApplicable: updatedDevice.chargerFeeApplicable ?? updatedDevice.chargerFeeEnabled,
        sortOrder: updatedDevice.sortOrder,
        isActive: updatedDevice.isActive,
        version: updatedDevice.version,
      }, device.version);
      return { success: true, data: updatedDevice };
    });
  }

  async deactivateDeviceType(auth: AuthorizationContext, deviceId: ID): Promise<Result<DeviceTypeEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('devices:manage');
    const device = await this.deps.deviceRepo.findById(deviceId);
    if (!device) throw new NotFoundError('Device type not found');

    const retired: DeviceTypeEntity = {
      ...device,
      isActive: false,
      updatedAt: new Date().toISOString(),
      version: device.version + 1,
    };

    return this.deps.transactionManager.runInTransaction((ctx) => {
      ctx.deviceRepo.save(retired);
      ctx.commandRepo.record(crypto.randomUUID(), 'RETIRE_DEVICE_TYPE', {
        id: retired.id,
        deviceTypeId: retired.id,
        isActive: false,
        version: retired.version,
        actorAdminId: actor.id,
      }, device.version);
      return { success: true, data: retired };
    });
  }

  async deleteDeviceType(auth: AuthorizationContext, deviceId: ID): Promise<Result<void>> {
    const actor = auth.requireAuth();
    auth.assertPermission('devices:manage');

    const device = await this.deps.deviceRepo.findById(deviceId);
    if (!device) throw new NotFoundError('Device type not found');

    // FK Safety: prevent deleting device types that are referenced by existing order items
    if (this.deps.itemRepo.isDeviceTypeInUse) {
      const inUse = await this.deps.itemRepo.isDeviceTypeInUse(deviceId);
      if (inUse) {
        throw new BusinessRuleViolation('DEVICE_TYPE_IN_USE: Cannot delete device type because it is referenced by existing order items.');
      }
    }

    return this.deps.transactionManager.runInTransaction((ctx) => {
      if (ctx.deviceRepo.delete) {
        ctx.deviceRepo.delete(deviceId);
      }
      ctx.commandRepo.record(crypto.randomUUID(), 'DELETE_DEVICE_TYPE', { id: deviceId });
      return { success: true, data: undefined };
    });
  }

  async reorderDeviceTypes(auth: AuthorizationContext, ordering: { id: ID; sortOrder: number }[]): Promise<Result<void>> {
    const actor = auth.requireAuth();
    auth.assertPermission('devices:manage');
    
    return this.deps.transactionManager.runInTransaction((ctx) => {
      for (const ord of ordering) {
        const dev = ctx.deviceRepo.findById(ord.id) as DeviceTypeEntity | null;
        if (dev) {
          dev.sortOrder = ord.sortOrder;
          dev.version += 1;
          dev.updatedAt = new Date().toISOString();
          const commandId = crypto.randomUUID();
          ctx.deviceRepo.save(dev);
          ctx.commandRepo.record(commandId, 'UPDATE_DEVICE_TYPE', {
            id: dev.id,
            deviceTypeId: dev.id,
            name: dev.name,
            arabicName: dev.nameAr || dev.name,
            englishName: dev.nameEn || dev.name,
            icon: dev.icon,
            basePriceMinor: dev.basePriceMinor,
            chargerFeeEnabled: dev.chargerFeeEnabled,
            chargerFeeApplicable: dev.chargerFeeApplicable ?? dev.chargerFeeEnabled,
            sortOrder: dev.sortOrder,
            isActive: dev.isActive,
            version: dev.version,
          }, dev.version - 1);
        }
      }
      return { success: true, data: undefined };
    });
  }

  // ==========================================
  // FINANCE USE CASES (Transaction Boundary)
  // ==========================================

  async recordPayment(
    auth: AuthorizationContext,
    commandId: ID,
    customerId: ID,
    amountMinor: number,
    paymentMethod: string,
    reference?: string,
    resetGeneration?: number
  ): Promise<Result<PaymentEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('finance:create-payment');
    DomainInvariants.assertValidPaymentAmount(amountMinor);

    // CREATE_PAYMENT is command-idempotent. A retry of the same request must
    // return the existing local payment instead of generating a new timestamp,
    // conflicting with the command payload, or creating duplicate overlays.
    const existingPaymentCommand = await this.deps.commandRepo.get(commandId);
    if (existingPaymentCommand) {
      const existingType = (existingPaymentCommand as any).type || (existingPaymentCommand as any).commandType;
      if (existingType !== 'CREATE_PAYMENT') {
        throw new IdempotencyConflictError('Command ID is already associated with a different operation');
      }
      const p = (existingPaymentCommand.payload || {}) as any;
      if (
        p.customerId !== customerId ||
        Number(p.amountMinor) !== amountMinor ||
        String(p.paymentMethod) !== String(paymentMethod) ||
        String(p.reference || '') !== String(reference || '')
      ) {
        throw new IdempotencyConflictError('CREATE_PAYMENT command was reused with different payment data');
      }
      const existingPayment = this.deps.paymentRepo.findByCustomer
        ? await this.deps.paymentRepo.findByCustomer(customerId)
        : await localDb.list<PaymentEntity>('payments');
      const found = existingPayment.find((payment) => payment.id === commandId);
      if (found) return { success: true, data: found };
      throw new IdempotencyConflictError('CREATE_PAYMENT command exists but its local payment is missing');
    }

    const customer = await this.deps.customerRepo.findById(customerId);
    if (!customer) throw new NotFoundError('Customer not found');

    const ledger = (await this.deps.ledgerRepo.findByCustomer(customerId)) || [];
    const allocations = (await this.deps.paymentRepo.findAllAllocations()) || [];

    const payment: PaymentEntity = {
      id: commandId,
      customerId,
      amountMinor,
      paymentMethod,
      reference,
      actorAdminId: actor.id,
      commandId,
      createdAt: new Date().toISOString(),
    };

    const mutationKey = `customer:${customerId}`;

    if (this.deps.mutationSnapshotRepo) {
      await this.deps.mutationSnapshotRepo.capture(commandId, [
        { table: 'payments', id: commandId, existed: false },
      ]);
    }

    /*
     * Payment is a financial mutation, so the authoritative ledger remains
     * server-owned. We can still persist the payment entity itself locally,
     * atomically with the CREATE_PAYMENT outbox command, while retaining the
     * existing pending ledger overlay for balance projection.
     */
    await this.deps.transactionManager.runInTransaction((ctx) => {
      ctx.paymentRepo.save(payment);
      ctx.ledgerRepo.append({
        id: commandId,
        eventType: 'PAYMENT',
        amountMinor,
        customerId,
        actorAdminId: actor.id,
        referenceId: payment.id,
        createdAt: payment.createdAt,
      });
      // Apply the same FIFO allocation path used by explicit approval so a
      // normal customer payment immediately settles recognized order items
      // locally and creates UUID allocation rows before sync.
      this.allocatePaymentFIFOInternal(ctx, commandId, customerId, amountMinor, ledger, allocations);
      ctx.commandRepo.record(commandId, 'CREATE_PAYMENT', {
        ...payment,
        resetGeneration
      });
    });

    try {
      await this.createOverlay(
        commandId,
        mutationKey,
        'payments',
        commandId,
        'CREATE',
        payment as unknown as Record<string, unknown>
      );
      // The ledger row is already persisted atomically above; keep only the
      // payment overlay so the same financial event is not projected twice.
    } catch (overlayError) {
      /*
       * The payment row + outbox are already durable. If the projection layer
       * cannot be written, syncing remains correct; the pending financial
       * projection will be reconstructed by normal reconciliation.
       */
      console.warn(
        'Failed to persist payment pending projection; payment remains queued.',
        overlayError
      );
    }
    return { success: true, data: payment };
  }

  private allocatePaymentFIFOInternal(
    ctx: RepositoryContext,
    paymentId: ID,
    customerId: ID,
    amountMinor: number,
    initialLedger?: FinancialLedgerEntity[],
    initialAllocations?: PaymentAllocationEntity[]
  ): void {
    const rawLedger = initialLedger || ctx.ledgerRepo.findByCustomer(customerId);
    const ledger = (Array.isArray(rawLedger) ? rawLedger : []) as FinancialLedgerEntity[];

    const rawAllocations = initialAllocations || ctx.paymentRepo.findAllAllocations();
    const allocations = (Array.isArray(rawAllocations) ? rawAllocations : []) as PaymentAllocationEntity[];

    const recognizedItemMap = new Map<ID, { orderId?: ID; amount: number }>();
    for (const l of ledger) {
      const targetId = l.orderItemId || l.orderId;
      if (targetId && (l.eventType === 'ORDER_ITEM_CHARGE' || l.eventType === 'CHARGE')) {
        const amt = l.amountMinor < 0 ? -l.amountMinor : l.amountMinor;
        const cur = recognizedItemMap.get(targetId) || { orderId: l.orderId, amount: 0 };
        cur.amount += amt;
        recognizedItemMap.set(targetId, cur);
      }
      if (targetId && (l.eventType === 'REVERSAL' || l.eventType === 'REFUND')) {
        const amt = l.amountMinor < 0 ? -l.amountMinor : l.amountMinor;
        const cur = recognizedItemMap.get(targetId) || { orderId: l.orderId, amount: 0 };
        cur.amount -= amt;
        recognizedItemMap.set(targetId, cur);
      }
    }

    const allocatedMap = new Map<ID, number>();
    for (const alloc of allocations) {
      const key = alloc.orderItemId || alloc.orderId;
      if (key) {
        allocatedMap.set(key, (allocatedMap.get(key) || 0) + alloc.allocatedAmountMinor);
      }
    }

    let remainingPayment = amountMinor;

    for (const [targetId, info] of recognizedItemMap.entries()) {
      if (remainingPayment <= 0) break;
      const alreadyAllocated = allocatedMap.get(targetId) || 0;
      const outstanding = Math.max(0, info.amount - alreadyAllocated);

      if (outstanding > 0) {
        const toAllocate = Math.min(remainingPayment, outstanding);
        DomainInvariants.assertValidAllocation(toAllocate, amountMinor, outstanding);

        ctx.paymentRepo.saveAllocation({
          id: crypto.randomUUID(),
          paymentId,
          orderItemId: targetId,
          orderId: info.orderId || targetId,
          allocatedAmountMinor: toAllocate,
          createdAt: new Date().toISOString(),
        });

        remainingPayment -= toAllocate;
      }
    }

    if (remainingPayment > 0) {
      ctx.ledgerRepo.append({
        eventType: 'CREDIT_ADJUSTMENT',
        amountMinor: remainingPayment,
        customerId,
        referenceId: paymentId,
      });
    }
  }

  async allocatePaymentFIFO(
    auth: AuthorizationContext,
    paymentId: ID,
    customerId: ID,
    amountMinor: number
  ): Promise<Result<PaymentAllocationEntity[]>> {
    const actor = auth.requireAuth();
    auth.assertPermission('finance:approve-payment');

    const ledger = (await this.deps.ledgerRepo.findByCustomer(customerId)) || [];
    const allocations = (await this.deps.paymentRepo.findAllAllocations()) || [];
    
    return this.deps.transactionManager.runInTransaction((ctx) => {
      this.allocatePaymentFIFOInternal(ctx, paymentId, customerId, amountMinor, ledger, allocations);
      const allAllocations = ctx.paymentRepo.findAllAllocations();
      const paymentAllocations = Array.isArray(allAllocations) ? allAllocations.filter(a => a.paymentId === paymentId) : [];
      return { success: true, data: paymentAllocations };
    });
  }

  async createCustomerCredit(
    auth: AuthorizationContext,
    customerId: ID,
    amountMinor: number,
    bin: string,
    commandId?: ID,
    note?: string
  ): Promise<Result<FinancialLedgerEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('finance:credit-adjustment');
    await auth.verifyBin(bin);
    DomainInvariants.assertValidPaymentAmount(amountMinor);

    const customer = await this.deps.customerRepo.findById(customerId);
    if (!customer) throw new NotFoundError('Customer not found');
    DomainInvariants.assertCustomerActive(customer);

    const event: Omit<FinancialLedgerEntity, 'id' | 'createdAt'> & { note?: string } = {
      eventType: 'CREDIT_ADJUSTMENT',
      amountMinor,
      customerId,
      actorAdminId: actor.id,
      ...(note ? { note, metadata: { note } } : {}),
    };

    const txId = commandId || crypto.randomUUID();

    // Credit mutations are also command-idempotent. A retried top-up with the
    // same command ID must return the existing financial row instead of creating
    // a second balance change.
    if (commandId) {
      const existing = await this.deps.commandRepo.get(commandId);
      if (existing) {
        const existingType = (existing as any).type || (existing as any).commandType;
        if (existingType !== 'CREATE_CUSTOMER_CREDIT') {
          throw new IdempotencyConflictError('Command ID is already associated with a different operation');
        }
        const existingLedger = await this.deps.ledgerRepo.findByCustomer(customerId);
        const found = (existingLedger || []).find((row) => row.id === commandId);
        if (found) return { success: true, data: found };
      }
    }

    const mutationKey = `customer:${customerId}`;
    const createdAt = new Date().toISOString();

    if (this.deps.mutationSnapshotRepo) {
      await this.deps.mutationSnapshotRepo.capture(txId, [
        { table: 'ledger', id: txId, existed: false },
      ]);
    }

    const payment: PaymentEntity = {
      id: txId,
      customerId,
      amountMinor,
      paymentMethod: 'CASH',
      reference: note || 'Customer credit',
      actorAdminId: actor.id,
      commandId: txId,
      createdAt,
    };

    // Authorized credit is a real local-first financial mutation. Persist the
    // ledger and payment together with the outbox command so balance/financial
    // pages do not depend on an overlay that can disappear before sync.
    await this.deps.transactionManager.runInTransaction((ctx) => {
      ctx.ledgerRepo.append({ id: txId, createdAt, ...event });
      ctx.paymentRepo.save(payment);
      ctx.commandRepo.record(txId, 'CREATE_CUSTOMER_CREDIT', {
        id: txId,
        customerId,
        amountMinor,
        actorAdminId: actor.id,
        createdAt,
        bin,
        note: note || 'Customer credit',
        idempotencyKey: txId,
      });
    });

    // Durable local financial rows are the pending projection; no duplicate overlays.


    return { success: true, data: { id: txId, createdAt, ...event } };
  }

  /** Queue a customer credit adjustment offline; BIN is collected later in Sync Center. */
  async queueCustomerCreditAwaitingBin(
    auth: AuthorizationContext,
    customerId: ID,
    amountMinor: number,
    commandId?: ID
  ): Promise<Result<FinancialLedgerEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('finance:credit-adjustment');
    DomainInvariants.assertValidPaymentAmount(amountMinor);
    const customer = await this.deps.customerRepo.findById(customerId);
    if (!customer) throw new NotFoundError('Customer not found');
    DomainInvariants.assertCustomerActive(customer);

    const txId = commandId || crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const event = { eventType: 'CREDIT_ADJUSTMENT' as const, amountMinor, customerId, actorAdminId: actor.id };
    const mutationKey = `customer:${customerId}`;

    if (this.deps.mutationSnapshotRepo) {
      await this.deps.mutationSnapshotRepo.capture(txId, [{ table: 'ledger', id: txId, existed: false }]);
    }
    await this.createOverlay(txId, mutationKey, 'ledger', txId, 'CREATE', { id: txId, createdAt, ...event } as Record<string, unknown>);
    const payment: PaymentEntity = {
      id: txId, customerId, amountMinor, paymentMethod: 'CASH', reference: 'Customer credit',
      actorAdminId: actor.id, commandId: txId, createdAt,
    };
    await this.createOverlay(`${txId}:payment`, mutationKey, 'payments', txId, 'CREATE', payment as unknown as Record<string, unknown>);
    await this.deps.commandRepo.record(txId, 'CREATE_CUSTOMER_CREDIT', {
      id: txId, customerId, amountMinor, actorAdminId: actor.id, createdAt, authorizationState: 'PENDING_BIN',
    });
    return { success: true, data: { id: txId, createdAt, ...event } };
  }

  async consumeCustomerCredit(auth: AuthorizationContext, customerId: ID, amountMinor: number, orderId: ID): Promise<Result<FinancialLedgerEntity>> {
    const actor = auth.requireAuth();
    DomainInvariants.assertValidPaymentAmount(amountMinor);

    const event: Omit<FinancialLedgerEntity, 'id' | 'createdAt'> = {
      eventType: 'CREDIT_USED',
      amountMinor: -amountMinor,
      customerId,
      orderId,
      actorAdminId: actor.id,
    };

    const txId = crypto.randomUUID();
    return this.deps.transactionManager.runInTransaction((ctx) => {
      const createdAt = new Date().toISOString();
      ctx.ledgerRepo.append({ id: txId, createdAt, ...event });
      ctx.commandRepo.record(txId, 'CONSUME_CUSTOMER_CREDIT', {
        id: txId,
        customerId,
        amountMinor,
        orderId,
        actorAdminId: actor.id,
        createdAt,
      });
      return { success: true, data: { id: txId, createdAt, ...event } };
    });
  }

  async createRefundOrReversal(
    auth: AuthorizationContext,
    commandId: ID,
    customerId: ID,
    amountMinor: number,
    referenceEventId: ID,
    bin: string
  ): Promise<Result<FinancialLedgerEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('finance:refund');
    await auth.verifyBin(bin);
    DomainInvariants.assertValidPaymentAmount(amountMinor);

    const referenceLedger = await this.deps.ledgerRepo.findAll();
    const referenced = referenceLedger.find((entry) => entry.id === referenceEventId);
    if (!referenced || referenced.customerId !== customerId) {
      throw new BusinessRuleViolation('Referenced financial event not found for this customer');
    }

    return this.deps.transactionManager.runInTransaction((ctx) => {
      const event: Omit<FinancialLedgerEntity, 'id' | 'createdAt'> = {
        eventType: 'REFUND',
        amountMinor: -amountMinor,
        customerId,
        actorAdminId: actor.id,
        referenceId: referenceEventId,
      };

      const createdAt = new Date().toISOString();
      ctx.ledgerRepo.append({ id: commandId, createdAt, ...event });
      ctx.commandRepo.record(commandId, 'CREATE_REFUND', {
        id: commandId,
        customerId,
        amountMinor,
        referenceEventId,
        actorAdminId: actor.id,
        createdAt,
        bin,
      });
      return { success: true, data: { id: commandId, createdAt, ...event } };
    });
  }

  async createCreditAdjustment(auth: AuthorizationContext, customerId: ID, amountMinor: number, bin: string): Promise<Result<FinancialLedgerEntity>> {
    return this.createCustomerCredit(auth, customerId, amountMinor, bin);
  }

  async calculatePaymentStatus(customerId: ID): Promise<PaymentStatus> {
    const ledger = (await this.deps.ledgerRepo.findByCustomer(customerId)) || [];
    const allocations = (await this.deps.paymentRepo.findAllAllocations()) || [];

    let totalRecognized = 0;
    let totalAllocated = 0;

    for (const l of ledger) {
      if (l.eventType === 'ORDER_ITEM_CHARGE') totalRecognized += (l.amountMinor < 0 ? -l.amountMinor : l.amountMinor);
      if (l.eventType === 'REVERSAL' || l.eventType === 'REFUND') totalRecognized -= (l.amountMinor < 0 ? -l.amountMinor : l.amountMinor);
    }

    const customerOrders = new Set(ledger.map(l => l.orderId).filter(Boolean));
    for (const alloc of allocations) {
      if (customerOrders.has(alloc.orderId)) {
        totalAllocated += alloc.allocatedAmountMinor;
      }
    }

    if (totalRecognized <= 0) return 'paid';
    if (totalAllocated >= totalRecognized) return 'paid';
    if (totalAllocated > 0) return 'partially_paid';
    return 'unpaid';
  }

  // ==========================================
  // BUSINESS DAY USE CASES
  // ==========================================

  async createBusinessDay(
    auth: AuthorizationContext,
    businessDate: string,
    dayId?: ID,
    groupId?: string
  ): Promise<Result<BusinessDayEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('settings:manage');

    const isStandardUuid = dayId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dayId);
    const id = isStandardUuid ? dayId : crypto.randomUUID();
    const existing = await this.deps.dayRepo.findById(id);
    if (existing) {
      return { success: false, error: 'Business day already exists', code: 'DAY_ALREADY_EXISTS' };
    }

    const day: BusinessDayEntity = {
      id,
      businessDate,
      isClosed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };

    return this.deps.transactionManager.runInTransaction((ctx) => {
      ctx.dayRepo.save(day);
      ctx.commandRepo.record(day.id, 'OPEN_DAY', {
        ...day,
        ...(groupId ? { groupId } : {})
      });
      return { success: true, data: day };
    });
  }

  async closeBusinessDay(
    auth: AuthorizationContext,
    dayId: ID
  ): Promise<Result<BusinessDayEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('settings:manage');

    const day = await this.deps.dayRepo.findById(dayId);
    if (!day) throw new NotFoundError('Business day not found');

    const updatedDay: BusinessDayEntity = {
      ...day,
      isClosed: true,
      closedAt: new Date().toISOString(),
      closedBy: actor.id,
      version: day.version + 1,
    };

    return this.deps.transactionManager.runInTransaction((ctx) => {
      ctx.dayRepo.save(updatedDay);
      const commandId = crypto.randomUUID();
      ctx.commandRepo.record(commandId, 'CLOSE_DAY', {
        id: day.id,
        aggregateId: day.id,
        dayId: day.id,
        closedAt: day.closedAt,
        closedBy: updatedDay.closedBy,
      }, day.version);
      return { success: true, data: updatedDay };
    });
  }

  async superAdminEditClosedDay(auth: AuthorizationContext, dayId: ID, bin: string): Promise<Result<BusinessDayEntity>> {
    const actor = auth.requireAuth();
    if (!actor.isSuperAdmin) throw new BusinessRuleViolation('Only Super Admin can edit closed days');
    await auth.verifyBin(bin);

    const day = await this.deps.dayRepo.findById(dayId);
    if (!day) throw new NotFoundError('Business day not found');
    return { success: true, data: day };
  }

  async addItemToClosedDay(auth: AuthorizationContext, orderId: ID, deviceTypeId: ID, hasCharger: boolean, bin: string): Promise<Result<OrderItemEntity>> {
    const actor = auth.requireAuth();
    if (!actor.isSuperAdmin) throw new BusinessRuleViolation('Only Super Admin can add items to closed day');
    await auth.verifyBin(bin);

    return this.addOrderItem(auth, orderId, deviceTypeId, hasCharger);
  }

  // ==========================================
  // GOALS USE CASES (Phase 1 Canonical Baseline)
  // ==========================================

  /**
   * Generates customer-specific goal parameters based on past 7 days of delivered activity
   */
  async generateCustomerGoalProposal(
    auth: AuthorizationContext,
    customerId: ID
  ): Promise<Result<{ targetQuantity: number; durationDays: number; bonusAmountMinor: number; expiresAt: string }>> {
    auth.requireAuth();
    const customer = await this.deps.customerRepo.findById(customerId);
    if (!customer) throw new NotFoundError('Customer not found');

    // Count customer items delivered in last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    let deliveredCount = 0;

    // Fetch orders for customer
    const ledger = await this.deps.ledgerRepo.findByCustomer(customerId);
    const recentCharges = ledger.filter(
      l => (l.eventType === 'CHARGE' || l.eventType === 'ORDER_ITEM_CHARGE') && l.createdAt >= sevenDaysAgo
    );
    deliveredCount = recentCharges.length;

    const proposal = generateGoalProposal(deliveredCount);
    return { success: true, data: proposal };
  }

  /**
   * Creates a new active goal for a customer. Enforces single active goal invariant.
   */
  async createGoal(
    auth: AuthorizationContext,
    commandId: ID,
    customerId: ID,
    targetQuantity: number,
    durationDays: number = 7,
    bonusAmountMinor: number = 500,
    groupId?: string
  ): Promise<Result<GoalEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('goals:manage');

    const customer = await this.deps.customerRepo.findById(customerId);
    if (!customer || !customer.isActive) throw new InactiveCustomerError();

    DomainInvariants.assertGoalParamsValid(targetQuantity, durationDays, bonusAmountMinor);

    if (!this.deps.goalRepo) {
      throw new Error('Goal repository not configured in context');
    }

    const existingActive = await this.deps.goalRepo.findActiveByCustomerId(customerId);
    DomainInvariants.assertSingleActiveGoal(existingActive, customerId);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();
    const goalId = commandId || crypto.randomUUID();

    const goal: GoalEntity = {
      id: goalId,
      customerId,
      targetQuantity,
      currentProgress: 0,
      bonusAmountMinor,
      durationDays,
      status: 'ACTIVE',
      startedAt: now.toISOString(),
      expiresAt,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      version: 1,
    };

    return this.deps.transactionManager.runInTransaction((ctx) => {
      ctx.goalRepo!.save(goal);
      ctx.commandRepo.record(goalId, 'CREATE_GOAL', {
        id: goalId,
        customerId,
        targetQuantity,
        durationDays,
        bonusAmountMinor,
        startedAt: goal.startedAt,
        expiresAt: goal.expiresAt,
        ...(groupId ? { groupId } : {}),
      });
      return { success: true, data: goal };
    });
  }

  /**
   * Authorized editing of active goal config (target, duration, bonus, expiry).
   * Progress CANNOT be manually edited.
   * If new target <= currentProgress, goal immediately becomes COMPLETED and grants bonus once.
   */
  async updateGoalConfig(
    auth: AuthorizationContext,
    goalId: ID,
    params: {
      targetQuantity?: number;
      durationDays?: number;
      bonusAmountMinor?: number;
      expiresAt?: string;
    }
  ): Promise<Result<GoalEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('goals:manage');

    if (!this.deps.goalRepo) throw new Error('Goal repository not configured');
    const goalRecord = await this.deps.goalRepo.findById(goalId);
    if (!goalRecord) throw new NotFoundError('Goal not found');
    const goal = { ...goalRecord };

    DomainInvariants.assertGoalEditable(goal);

    if (params.targetQuantity !== undefined) {
      if (!Number.isInteger(params.targetQuantity) || params.targetQuantity <= 0) {
        throw new BusinessRuleViolation('Target quantity must be a positive integer');
      }
      goal.targetQuantity = params.targetQuantity;
    }

    if (params.durationDays !== undefined) {
      if (!Number.isInteger(params.durationDays) || params.durationDays <= 0) {
        throw new BusinessRuleViolation('Duration days must be a positive integer');
      }
      goal.durationDays = params.durationDays;
    }

    if (params.bonusAmountMinor !== undefined) {
      if (!Number.isInteger(params.bonusAmountMinor) || params.bonusAmountMinor < 0) {
        throw new BusinessRuleViolation('Bonus amount must be non-negative integer minor units');
      }
      goal.bonusAmountMinor = params.bonusAmountMinor;
    }

    if (params.expiresAt !== undefined) {
      goal.expiresAt = params.expiresAt;
    }

    goal.updatedAt = new Date().toISOString();
    goal.version += 1;

    // Check if target was edited to be <= current progress -> Complete immediately & grant bonus
    let bonusGranted = false;
    let bonusLedgerId: string | undefined;

    if (goal.targetQuantity <= goal.currentProgress && goal.status === 'ACTIVE') {
      goal.status = 'COMPLETED';
      goal.completedAt = new Date().toISOString();
      bonusGranted = true;
      bonusLedgerId = crypto.randomUUID();
      goal.bonusLedgerId = bonusLedgerId;
    }

    return this.deps.transactionManager.runInTransaction((ctx) => {
      if (bonusGranted && bonusLedgerId) {
        ctx.ledgerRepo.append({
          id: bonusLedgerId,
          eventType: 'BONUS',
          amountMinor: goal.bonusAmountMinor,
          customerId: goal.customerId,
          referenceId: goal.id,
          metadata: {
            reason: 'GOAL_COMPLETED_VIA_CONFIG_UPDATE',
            goalId: goal.id,
            targetQuantity: goal.targetQuantity,
            bonusAmountMinor: goal.bonusAmountMinor,
          },
        });
      }
      ctx.goalRepo!.save(goal);
      ctx.commandRepo.record(crypto.randomUUID(), 'UPDATE_GOAL_CONFIG', {
        id: goal.id,
        targetQuantity: goal.targetQuantity,
        durationDays: goal.durationDays,
        bonusAmountMinor: goal.bonusAmountMinor,
        expiresAt: goal.expiresAt,
        status: goal.status,
        completedAt: goal.completedAt,
        bonusLedgerId: goal.bonusLedgerId,
      });
      return { success: true, data: goal };
    });
  }

  /**
   * Customer submits a new goal request -> PENDING
   */
  async recordGoalRequest(
    auth: AuthorizationContext,
    commandId: ID,
    customerId: ID,
    requestedTarget?: number
  ): Promise<Result<GoalRequestEntity>> {
    auth.requireAuth();

    const customer = await this.deps.customerRepo.findById(customerId);
    if (!customer || !customer.isActive) throw new InactiveCustomerError();

    if (!this.deps.goalRequestRepo) throw new Error('Goal request repo not configured');

    const requestId = commandId || crypto.randomUUID();
    const req: GoalRequestEntity = {
      id: requestId,
      customerId,
      requestedTarget,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };

    return this.deps.transactionManager.runInTransaction((ctx) => {
      ctx.goalRequestRepo!.save(req);
      ctx.commandRepo.record(requestId, 'RECORD_GOAL_REQUEST', {
        id: requestId,
        customerId,
        requestedTarget,
      });
      return { success: true, data: req };
    });
  }

  /**
   * Admin approves a goal request -> creates active GoalEntity
   */
  async approveGoalRequest(
    auth: AuthorizationContext,
    requestId: ID,
    bonusAmountMinor: number = 500,
    durationDays: number = 7
  ): Promise<Result<{ request: GoalRequestEntity; goal: GoalEntity }>> {
    const actor = auth.requireAuth();
    auth.assertPermission('goals:approve');

    if (!this.deps.goalRequestRepo || !this.deps.goalRepo) {
      throw new Error('Goal repositories not configured');
    }

    const reqRecord = await this.deps.goalRequestRepo.findById(requestId);
    if (!reqRecord) throw new NotFoundError('Goal request not found');
    const req = { ...reqRecord };
    if (req.status !== 'PENDING') throw new BusinessRuleViolation(`Request is already ${req.status}`);

    const existingActive = await this.deps.goalRepo.findActiveByCustomerId(req.customerId);
    DomainInvariants.assertSingleActiveGoal(existingActive, req.customerId);

    const targetQuantity = req.requestedTarget || 10;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();
    const goalId = crypto.randomUUID();

    const goal: GoalEntity = {
      id: goalId,
      customerId: req.customerId,
      targetQuantity,
      currentProgress: 0,
      bonusAmountMinor,
      durationDays,
      status: 'ACTIVE',
      startedAt: now.toISOString(),
      expiresAt,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      version: 1,
    };

    req.status = 'APPROVED';
    req.reviewedBy = actor.id;
    req.reviewedAt = now.toISOString();
    req.resultingGoalId = goal.id;
    req.updatedAt = now.toISOString();
    req.version += 1;

    return this.deps.transactionManager.runInTransaction((ctx) => {
      ctx.goalRepo!.save(goal);
      ctx.goalRequestRepo!.save(req);
      ctx.commandRepo.record(crypto.randomUUID(), 'APPROVE_GOAL_REQUEST', {
        requestId: req.id,
        resultingGoalId: goal.id,
        targetQuantity: goal.targetQuantity,
        bonusAmountMinor: goal.bonusAmountMinor,
        durationDays: goal.durationDays,
      });
      return { success: true, data: { request: req, goal } };
    });
  }

  /**
   * Admin rejects a goal request -> REJECTED (no active goal created)
   */
  async rejectGoalRequest(
    auth: AuthorizationContext,
    requestId: ID,
    rejectionReason: string
  ): Promise<Result<GoalRequestEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('goals:approve');

    if (!this.deps.goalRequestRepo) throw new Error('Goal request repo not configured');

    const reqRecord = await this.deps.goalRequestRepo.findById(requestId);
    if (!reqRecord) throw new NotFoundError('Goal request not found');
    const req = { ...reqRecord };
    if (req.status !== 'PENDING') throw new BusinessRuleViolation(`Request is already ${req.status}`);

    req.status = 'REJECTED';
    req.reviewedBy = actor.id;
    req.reviewedAt = new Date().toISOString();
    req.rejectionReason = rejectionReason;
    req.updatedAt = new Date().toISOString();
    req.version += 1;

    return this.deps.transactionManager.runInTransaction((ctx) => {
      ctx.goalRequestRepo!.save(req);
      ctx.commandRepo.record(crypto.randomUUID(), 'REJECT_GOAL_REQUEST', {
        requestId: req.id,
        rejectionReason,
      });
      return { success: true, data: req };
    });
  }

  /**
   * Authoritatively evaluates customer's active goal progress, handles completion & expiration
   */
  async evaluateCustomerGoal(customerId: ID, ctx?: RepositoryContext): Promise<Result<{ hasActiveGoal: boolean; goal?: GoalEntity }>> {
    const repos = ctx || this.deps;
    if (!repos.goalRepo) return { success: true as const, data: { hasActiveGoal: false } };

    const goalRecord = await repos.goalRepo.findActiveByCustomerId(customerId);
    if (!goalRecord || goalRecord.status !== 'ACTIVE') {
      return { success: true as const, data: { hasActiveGoal: false } };
    }

    const goal = { ...goalRecord };

    // Count qualifying delivered order items in window [goal.startedAt, goal.expiresAt]
    const ledger = await repos.ledgerRepo.findByCustomer(customerId);
    const reversedItemIds = new Set(
      ledger
        .filter((entry) => entry.eventType === 'REVERSAL' && entry.orderItemId)
        .map((entry) => String(entry.orderItemId))
    );
    const qualifyingCharges = ledger.filter(
      l =>
        (l.eventType === 'CHARGE' || l.eventType === 'ORDER_ITEM_CHARGE') &&
        l.createdAt >= goal.startedAt &&
        l.createdAt <= goal.expiresAt &&
        (!l.orderItemId || !reversedItemIds.has(String(l.orderItemId)))
    );

    const newProgress = qualifyingCharges.length;
    goal.currentProgress = newProgress;
    goal.updatedAt = new Date().toISOString();

    const now = new Date();
    const isExpired = now.getTime() > new Date(goal.expiresAt).getTime();

    let bonusToGrant = false;
    let bonusLedgerId: string | undefined;

    if (newProgress >= goal.targetQuantity) {
      goal.status = 'COMPLETED';
      goal.completedAt = now.toISOString();
      if (!goal.bonusLedgerId) {
        bonusToGrant = true;
        bonusLedgerId = crypto.randomUUID();
        goal.bonusLedgerId = bonusLedgerId;
      }
    } else if (isExpired) {
      goal.status = 'FAILED';
    }

    goal.version += 1;

    const performSave = (c: RepositoryContext) => {
      if (bonusToGrant && bonusLedgerId) {
        c.ledgerRepo.append({
          id: bonusLedgerId,
          eventType: 'BONUS',
          amountMinor: goal.bonusAmountMinor,
          customerId: goal.customerId,
          referenceId: goal.id,
          metadata: {
            reason: 'GOAL_COMPLETED',
            goalId: goal.id,
            targetQuantity: goal.targetQuantity,
            bonusAmountMinor: goal.bonusAmountMinor,
          },
        });
      }
      c.goalRepo!.save(goal);
      const commandId = crypto.randomUUID();
      c.commandRepo.record(commandId, 'UPDATE_GOAL_PROGRESS', {
        id: goal.id,
        goalId: goal.id,
        customerId: goal.customerId,
        currentProgress: goal.currentProgress,
        status: goal.status,
        completedAt: goal.completedAt,
        bonusLedgerId: goal.bonusLedgerId,
        bonusGranted: bonusToGrant,
        bonusAmountMinor: goal.bonusAmountMinor,
        startedAt: goal.startedAt,
        expiresAt: goal.expiresAt,
      }, goal.version - 1);
      return { success: true as const, data: { hasActiveGoal: true, goal } };
    };

    if (ctx) {
      return performSave(ctx);
    } else {
      return this.deps.transactionManager.runInTransaction(performSave);
    }
  }
}
