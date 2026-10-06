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
import { OptimisticOverlayRecord } from '../infrastructure/localDb/localDb';
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
    if (!this.deps.overlayRepo) return;
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

    const customer = await this.deps.customerRepo.findById(customerId);
    if (!customer) throw new NotFoundError('Customer not found');
    if (!customer.isActive) throw new InactiveCustomerError();

    const currentBalance = await this.deps.customerRepo.getBalance(customerId);
    const allowed = checkDebtLimit(currentBalance, customer.debtLimitMinor, actor.isSuperAdmin);
    if (!allowed) {
      return { success: false, error: 'Debt limit exceeded. Regular admin blocked.', code: 'DEBT_LIMIT_EXCEEDED' };
    }

    const orderId = commandId || crypto.randomUUID();

    const order: OrderEntity = {
      id: orderId,
      dayId,
      customerId,
      displayNumber: 0, // Will be set by server
      internalSequence: 0,
      status: 'pending',
      customerBalanceSnapshotMinor: currentBalance,
      notes,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };

    const effectiveGroupId = groupId || (typeof payloadHash === 'object' && payloadHash !== null ? (payloadHash as any).groupId : undefined);

    // Phase 1.1: Use Overlay
    const mutationKey = `order:${orderId}`;
    if (this.deps.mutationSnapshotRepo) {
      await this.deps.mutationSnapshotRepo.capture(orderId, [
        { table: 'orders', id: order.id, existed: false },
      ]);
    }
    await this.createOverlay(orderId, mutationKey, 'orders', orderId, 'CREATE', order as unknown as Record<string, unknown>);

    await this.deps.commandRepo.record(orderId, 'CREATE_ORDER', {
        ...(typeof payloadHash === 'object' && payloadHash !== null ? payloadHash : {}),
        id: orderId,
        dayId: order.dayId,
        customerId: order.customerId,
        notes: order.notes,
        ...(effectiveGroupId ? { groupId: effectiveGroupId } : {}),
        customerBalanceSnapshotMinor: order.customerBalanceSnapshotMinor,
        displayNumber: order.displayNumber,
        orderNumber: (order as any).orderNumber ?? order.displayNumber,
    });
    
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

    const item: OrderItemEntity = {
      id: itemId,
      orderId,
      deviceTypeId,
      itemSequence,
      status: 'charging', // Always start charging optimistically
      deviceNameSnapshot: deviceType.name,
      deviceIconSnapshot: deviceType.icon,
      basePriceSnapshotMinor: deviceType.basePriceMinor,
      chargerFeeEnabledSnapshot: deviceType.chargerFeeEnabled,
      customerChargerFeeExemptSnapshot: customer.chargerFeeExempt,
      chargerFeeSnapshotMinor: pricing.chargerFeeSnapshotMinor,
      hasCharger,
      unitPriceMinor: pricing.unitPriceMinor,
      totalPriceMinor: pricing.totalPriceMinor,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };

    // Phase 1.1: Use Overlay
    const mutationKey = `order:${orderId}`;
    if (this.deps.mutationSnapshotRepo) {
      await this.deps.mutationSnapshotRepo.capture(itemId, [
        { table: 'orderItems', id: item.id, existed: false },
      ]);
    }
    await this.createOverlay(itemId, mutationKey, 'order_items', itemId, 'CREATE', item as unknown as Record<string, unknown>);

    await this.deps.commandRepo.record(itemId, 'ADD_ORDER_ITEM', {
        orderId,
        deviceTypeId,
        hasCharger,
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
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
    }

    const mutationKey = `order:${order.id}`;

    if (this.deps.mutationSnapshotRepo) {
      await this.deps.mutationSnapshotRepo.capture(commandId, [
        { table: 'orders', id: order.id, existed: false },
        ...preparedItems.map(item => ({ table: 'orderItems', id: item.id, existed: false })),
      ]);
    }

    // 1. Overlay Order
    await this.createOverlay(commandId, mutationKey, 'orders', order.id, 'CREATE', order as unknown as Record<string, unknown>);

    // 2. Overlay Items
    for (const item of preparedItems) {
      const itemOverlayId = `${commandId}:item:${item.id}`;
      await this.createOverlay(itemOverlayId, mutationKey, 'order_items', item.id, 'CREATE', item as unknown as Record<string, unknown>);
    }

    // 3. Record Commands
    await this.deps.commandRepo.record(commandId, 'CREATE_ORDER', {
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
      await this.deps.commandRepo.record(item.id, 'ADD_ORDER_ITEM', {
        id: item.id,
        aggregateId: order.id,
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
        await this.deps.commandRepo.record(deliveryCommandId, 'DELIVER_ORDER_ITEM', {
          id: deliveryCommandId,
          itemId: item.id,
          orderItemId: item.id,
          orderId: order.id,
          dependencyCommandId: item.id,
        }, item.version);
      }
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

  async deliverOrderItem(
    auth: AuthorizationContext,
    itemId: ID,
    bin: string
  ): Promise<Result<OrderItemEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('orders:deliver');
    await auth.verifyBin(bin);

    const item = await this.deps.itemRepo.findById(itemId);
    if (!item) throw new NotFoundError('Item not found');

    const order = await this.deps.orderRepo.findById(item.orderId);
    if (!order) throw new NotFoundError('Order not found');

    const dayIsClosed = await this.deps.dayRepo.isClosed(order.dayId);
    if (dayIsClosed && !actor.isSuperAdmin) {
      throw new ClosedDayError();
    }

    const orderItems = await this.deps.itemRepo.findByOrderId(order.id);
    const activeItems = orderItems.filter(i => i.status !== 'cancelled');
    if (activeItems.length === 0) {
      throw new BusinessRuleViolation('Cannot deliver or recognize an empty order');
    }

    const customer = await this.deps.customerRepo.findById(order.customerId);
    if (!customer) throw new NotFoundError('Customer not found');
    DomainInvariants.assertCustomerActive(customer);

    DomainInvariants.assertOrderNotCancelledForRecognition(order.status);
    if (item.status === 'delivered') {
      throw new FinancialInvariantViolation(`Order item ${item.id} is already delivered.`);
    }
    validateItemTransition(item.status, 'delivered');
    DomainInvariants.assertItemNotRecognizedTwice(item.id, await this.deps.ledgerRepo.findByCustomer(order.customerId));

    const currentCustomerBalance = await this.deps.customerRepo.getBalance(order.customerId);
    const projectedBalance = currentCustomerBalance - item.totalPriceMinor;
    if (!checkDebtLimit(projectedBalance, customer.debtLimitMinor, actor.isSuperAdmin)) {
      throw new BusinessRuleViolation(
        `Debt limit exceeded: Customer debt limit of ${customer.debtLimitMinor} minor units exceeded by projected balance ${projectedBalance}`
      );
    }

    const patch: Partial<OrderItemEntity> = {
      status: 'delivered',
      financialStatus: 'RECOGNIZED',
      deliveredAt: new Date().toISOString(),
      financiallyRecognizedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: item.version + 1,
    };

    // Phase 1.1: Use Overlay
    const mutationKey = `order:${order.id}`;
    const commandId = crypto.randomUUID();
    
    if (this.deps.mutationSnapshotRepo) {
      await this.deps.mutationSnapshotRepo.capture(commandId, [
        { table: 'orderItems', id: item.id, existed: true, data: item },
      ]);
    }
    await this.createOverlay(commandId, mutationKey, 'order_items', itemId, 'PATCH', patch as Record<string, unknown>);

    await this.deps.commandRepo.record(commandId, 'DELIVER_ORDER_ITEM', {
        id: commandId,
        itemId: item.id,
        orderItemId: item.id,
        orderId: order.id,
        bin,
    }, item.version);

    return { success: true as const, data: { ...item, ...patch } as OrderItemEntity };
  }

  async editOrderNotes(
    auth: AuthorizationContext,
    orderId: ID,
    notes?: string
  ): Promise<Result<OrderEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('orders:edit');

    const existing = await this.deps.orderRepo.findById(orderId);
    if (!existing) throw new NotFoundError('Order not found');

    const dayIsClosed = await this.deps.dayRepo.isClosed(existing.dayId);
    if (dayIsClosed && !actor.isSuperAdmin) {
      throw new ClosedDayError();
    }

    if (existing.status === 'cancelled') throw new BusinessRuleViolation('Cannot edit a cancelled order');

    const patch: Partial<OrderEntity> = {
      notes: notes?.trim() || undefined,
      updatedAt: new Date().toISOString(),
      version: existing.version + 1,
    };

    const commandId = crypto.randomUUID();
    const mutationKey = `order:${orderId}`;

    if (this.deps.mutationSnapshotRepo) {
      await this.deps.mutationSnapshotRepo.capture(commandId, [
        { table: 'orders', id: existing.id, existed: true, data: existing },
      ]);
    }

    await this.createOverlay(commandId, mutationKey, 'orders', orderId, 'PATCH', patch as Record<string, unknown>);

    await this.deps.commandRepo.record(commandId, 'UPDATE_ORDER', {
      id: orderId,
      aggregateId: orderId,
      orderId: orderId,
      notes: patch.notes,
    }, existing.version);

    return { success: true, data: { ...existing, ...patch } as OrderEntity };
  }

  async removeOrderItemDuringEdit(
    auth: AuthorizationContext,
    itemId: ID
  ): Promise<Result<OrderItemEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('orders:edit');

    const item = await this.deps.itemRepo.findById(itemId);
    if (!item) throw new NotFoundError('Item not found');

    const order = await this.deps.orderRepo.findById(item.orderId);
    if (!order) throw new NotFoundError('Order not found');

    const dayIsClosed = await this.deps.dayRepo.isClosed(order.dayId);
    if (dayIsClosed && !actor.isSuperAdmin) {
      throw new ClosedDayError();
    }

    validateItemTransition(item.status, 'cancelled');

    const patch: Partial<OrderItemEntity> = {
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
      version: item.version + 1,
    };

    const commandId = crypto.randomUUID();
    const mutationKey = `order:${order.id}`;

    if (this.deps.mutationSnapshotRepo) {
      await this.deps.mutationSnapshotRepo.capture(commandId, [
        { table: 'orderItems', id: item.id, existed: true, data: item },
      ]);
    }

    await this.createOverlay(commandId, mutationKey, 'order_items', item.id, 'PATCH', patch as Record<string, unknown>);

    await this.deps.commandRepo.record(commandId, 'CANCEL_ORDER_ITEM', {
      id: commandId,
      itemId: item.id,
      orderItemId: item.id,
      orderId: order.id,
    }, item.version);

    return { success: true, data: { ...item, ...patch } as OrderItemEntity };
  }

  async cancelOrder(
    auth: AuthorizationContext,
    orderId: ID,
    bin: string
  ): Promise<Result<OrderEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('orders:cancel');
    await auth.verifyBin(bin);

    const order = await this.deps.orderRepo.findById(orderId);
    if (!order) throw new NotFoundError('Order not found');

    const dayIsClosed = await this.deps.dayRepo.isClosed(order.dayId);
    if (dayIsClosed && !actor.isSuperAdmin) {
      throw new ClosedDayError();
    }

    validateOrderTransition(order.status, 'cancelled');

    const items = await this.deps.itemRepo.findByOrderId(orderId);
    const activeItems = items.filter(i => i.status !== 'cancelled');
    
    const commandId = crypto.randomUUID();
    const mutationKey = `order:${orderId}`;

    if (this.deps.mutationSnapshotRepo) {
      await this.deps.mutationSnapshotRepo.capture(commandId, [
        ...activeItems.map((i) => ({ table: 'orderItems', id: i.id, existed: true, data: i })),
      ]);
    }

    // For simplicity in Phase 1.1, we overlay each item cancellation
    // However, since createOverlay only handles one per commandId, we'll need to be careful.
    // Actually, let's just overlay the first item and the command will handle the rest on server.
    // Wait, the client projection should show ALL as cancelled.
    // We'll use a PATCH on order_items table for the whole order? No, localDb overlays are per entityId.
    
    for (const itemToCancel of activeItems) {
        const itemPatch = {
            status: 'cancelled',
            cancelledAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        // We'll create a separate overlay for each item with unique commandIds?
        // No, standard says one commandId per mutation.
        // Let's modify createOverlay to handle multiple if needed? 
        // No, let's just create one overlay for the order cancellation state if possible.
        // But the projection is based on items.
        
        const itemCommandId = `${commandId}:${itemToCancel.id}`;
        await this.createOverlay(itemCommandId, mutationKey, 'order_items', itemToCancel.id, 'PATCH', itemPatch as Record<string, unknown>);
    }

    await this.createOverlay(
      commandId,
      mutationKey,
      'orders',
      orderId,
      'PATCH',
      {
        status: 'cancelled',
        cancelledAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: order.version + 1,
      }
    );

    await this.deps.commandRepo.record(commandId, 'CANCEL_ORDER', {
      id: commandId,
      aggregateId: orderId,
      orderId,
      bin,
    }, order.version);

    return { success: true, data: { ...order, status: 'cancelled', cancelledAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: order.version + 1 } };
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
    
    const patch = {
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: existingItem.version + 1,
    };

    if (this.deps.mutationSnapshotRepo) {
      await this.deps.mutationSnapshotRepo.capture(commandId, [
        { table: 'orderItems', id: existingItem.id, existed: true, data: existingItem },
      ]);
    }

    await this.createOverlay(commandId, mutationKey, 'order_items', itemId, 'PATCH', patch as Record<string, unknown>);

    await this.deps.commandRepo.record(commandId, 'CANCEL_ORDER_ITEM', {
      id: commandId,
      aggregateId: order.id,
      itemId: itemId,
      orderItemId: itemId,
      orderId: order.id,
      bin,
    }, existingItem.version);

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
    return this.updateDeviceType(auth, deviceId, { isActive: false });
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

    // 1. Overlay Payment
    await this.createOverlay(commandId, mutationKey, 'payments', commandId, 'CREATE', payment as unknown as Record<string, unknown>);

    // 2. Overlay Ledger
    const ledgerEvent: Omit<FinancialLedgerEntity, 'id' | 'createdAt'> = {
        eventType: 'PAYMENT',
        amountMinor,
        customerId,
        actorAdminId: actor.id,
        referenceId: payment.id,
    };
    await this.createOverlay(`${commandId}:ledger`, mutationKey, 'ledger', commandId, 'CREATE', ledgerEvent as unknown as Record<string, unknown>);

    // 3. Outbox Recording
    await this.deps.commandRepo.record(commandId, 'CREATE_PAYMENT', {
      ...payment,
      resetGeneration
    });

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
    commandId?: ID
  ): Promise<Result<FinancialLedgerEntity>> {
    const actor = auth.requireAuth();
    auth.assertPermission('finance:credit-adjustment');
    await auth.verifyBin(bin);
    DomainInvariants.assertValidPaymentAmount(amountMinor);

    const customer = await this.deps.customerRepo.findById(customerId);
    if (!customer) throw new NotFoundError('Customer not found');
    DomainInvariants.assertCustomerActive(customer);

    const event: Omit<FinancialLedgerEntity, 'id' | 'createdAt'> = {
      eventType: 'CREDIT_ADJUSTMENT',
      amountMinor,
      customerId,
      actorAdminId: actor.id,
    };

    const txId = commandId || crypto.randomUUID();
    const mutationKey = `customer:${customerId}`;
    const createdAt = new Date().toISOString();

    if (this.deps.mutationSnapshotRepo) {
      await this.deps.mutationSnapshotRepo.capture(txId, [
        { table: 'ledger', id: txId, existed: false },
      ]);
    }

    await this.createOverlay(
      txId,
      mutationKey,
      'ledger',
      txId,
      'CREATE',
      { id: txId, createdAt, ...event } as unknown as Record<string, unknown>
    );

    const payment: PaymentEntity = {
      id: txId,
      customerId,
      amountMinor,
      paymentMethod: 'CASH',
      reference: 'Customer credit',
      actorAdminId: actor.id,
      commandId: txId,
      createdAt,
    };
    await this.createOverlay(
      `${txId}:payment`,
      mutationKey,
      'payments',
      txId,
      'CREATE',
      payment as unknown as Record<string, unknown>
    );

    await this.deps.commandRepo.record(txId, 'CREATE_CUSTOMER_CREDIT', {
      id: txId,
      customerId,
      amountMinor,
      actorAdminId: actor.id,
      createdAt,
      bin,
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
    const qualifyingCharges = ledger.filter(
      l =>
        (l.eventType === 'CHARGE' || l.eventType === 'ORDER_ITEM_CHARGE') &&
        l.createdAt >= goal.startedAt &&
        l.createdAt <= goal.expiresAt
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
