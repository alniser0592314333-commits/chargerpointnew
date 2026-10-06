/**
 * Canonical Domain Models & Database Types (Phase 1 Baseline)
 * Strictly typed interfaces corresponding to the relational database schema.
 * Zero 'any' policy.
 */

import { BaseEntity, ID, Timestamp } from '../types/common';

export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'OPERATOR' | 'FINANCE' | 'VIEWER';

export type CustomerStatus = 'ACTIVE' | 'DELETED';
export type DeviceTypeStatus = 'ACTIVE' | 'RETIRED';
export type BusinessDayStatus = 'OPEN' | 'CLOSED';
export type GoalStatus = 'ACTIVE' | 'COMPLETED' | 'FAILED';
export type GoalRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export type OrderStatus = 'pending' | 'charging' | 'delivered' | 'cancelled';

// 3 Independent Dimensions for Order Items
export type ItemOperationalStatus = 'CHARGING' | 'DELIVERED' | 'CANCELLED';
export type ItemFinancialStatus = 'UNRECOGNIZED' | 'RECOGNIZED' | 'REVERSED';
export type ItemPaymentStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';

// Legacy compatibility alias
export type ItemStatus = 'charging' | 'delivered' | 'cancelled';

export type LedgerEventType =
  | 'CHARGE'
  | 'PAYMENT'
  | 'CREDIT'
  | 'DISCOUNT'
  | 'REVERSAL'
  | 'REFUND'
  | 'ADJUSTMENT'
  | 'ORDER_ITEM_CHARGE'
  | 'CREDIT_ADJUSTMENT'
  | 'CREDIT_USED'
  | 'BONUS'
  | 'CORRECTION';

export interface AdminEntity extends BaseEntity {
  username: string;
  fullName: string;
  roleId: ID;
  role?: string;
  binHash: string;
  isActive: boolean;
  createdBy?: ID;
  permissions?: string[];
}

export interface BusinessDayEntity extends BaseEntity {
  businessDate: string; // YYYY-MM-DD
  displayNumber?: number;
  status?: BusinessDayStatus;
  isClosed: boolean;
  openedAt?: Timestamp;
  closedAt?: Timestamp;
  closedBy?: ID;
}

export interface CustomerEntity extends BaseEntity {
  name: string;
  phone?: string;
  status?: CustomerStatus;
  isActive: boolean;
  notes?: string;
  debtLimitMinor: number;
  chargerFeeExempt: boolean;
  deletedAt?: Timestamp;
}

export interface DeviceTypeEntity extends BaseEntity {
  name: string;
  nameAr?: string;
  nameEn?: string;
  icon: string;
  basePriceMinor: number;
  chargerFeeEnabled: boolean;
  chargerFeeApplicable?: boolean;
  status?: DeviceTypeStatus;
  isActive: boolean;
  sortOrder: number;
  deletedAt?: Timestamp;
}

export interface SystemSettingEntity {
  key: string;
  valueType: 'string' | 'number' | 'boolean' | 'json';
  valueString?: string;
  valueNumber?: number;
  valueBoolean?: boolean;
  valueJson?: Record<string, unknown>;
  description?: string;
  updatedAt?: Timestamp;
  updatedBy?: ID;
}

export interface OrderEntity extends BaseEntity {
  dayId: ID;
  customerId: ID;
  displayNumber: number;
  internalSequence: number;
  status: OrderStatus;
  customerBalanceSnapshotMinor?: number;
  notes?: string;
  qrTokenId?: ID;
  chargingAt?: Timestamp;
  deliveredAt?: Timestamp;
  cancelledAt?: Timestamp;
  deletedAt?: Timestamp;
}

export interface OrderItemEntity extends BaseEntity {
  orderId: ID;
  deviceTypeId: ID;
  itemSequence: number;
  
  // Independent Dimensions
  operationalStatus?: ItemOperationalStatus;
  financialStatus?: ItemFinancialStatus;
  paymentStatus?: ItemPaymentStatus;
  status: ItemStatus;

  // Snapshots for Historical Integrity
  deviceNameSnapshot: string;
  deviceIconSnapshot: string;
  basePriceSnapshotMinor: number;
  chargerFeeEnabledSnapshot: boolean;
  customerChargerFeeExemptSnapshot: boolean;
  chargerFeeSnapshotMinor: number;
  discountSnapshotMinor?: number;
  finalChargeSnapshotMinor?: number;
  hasCharger: boolean;

  unitPriceMinor: number;
  totalPriceMinor: number;
  replacementOfItemId?: ID;
  deliveredAt?: Timestamp;
  financiallyRecognizedAt?: Timestamp;
  cancelledAt?: Timestamp;
  deletedAt?: Timestamp;
}

export interface GoalEntity extends BaseEntity {
  customerId: ID;
  targetQuantity: number;
  currentProgress: number;
  bonusAmountMinor: number;
  durationDays: number;
  status: GoalStatus;
  startedAt: Timestamp;
  expiresAt: Timestamp;
  completedAt?: Timestamp;
  bonusLedgerId?: ID;
}

export interface GoalRequestEntity extends BaseEntity {
  customerId: ID;
  requestedTarget?: number;
  status: GoalRequestStatus;
  reviewedBy?: ID;
  reviewedAt?: Timestamp;
  rejectionReason?: string;
  resultingGoalId?: ID;
}

export interface FinancialLedgerEntity {
  id: ID;
  sequenceNumber?: number;
  eventType: LedgerEventType;
  amountMinor: number;
  orderId?: ID;
  orderItemId?: ID;
  customerId: ID;
  actorAdminId?: ID;
  referenceId?: ID;
  metadata?: Record<string, unknown>;
  createdAt: Timestamp;
}

export interface PaymentEntity {
  id: ID;
  customerId: ID;
  amountMinor: number;
  paymentMethod: string;
  reference?: string;
  actorAdminId: ID;
  commandId: ID;
  createdAt: Timestamp;
}

export interface PaymentAllocationEntity {
  id: ID;
  paymentId: ID;
  orderItemId?: ID;
  orderId?: ID;
  allocatedAmountMinor: number;
  createdAt: Timestamp;
}

export interface QrTokenEntity {
  id: ID;
  tokenHash: string;
  publicToken: string;
  tokenType: 'ORDER' | 'CUSTOMER';
  targetId: ID;
  isActive: boolean;
  expiresAt?: Timestamp;
  createdAt: Timestamp;
}

export interface ProcessedCommandEntity {
  commandId: ID;
  commandType: string;
  payloadHash: string;
  aggregateType: string;
  aggregateId?: ID;
  actorAdminId?: ID;
  actorId?: ID;
  deviceId?: string;
  resultPayload?: Record<string, unknown>;
  processedAt: Timestamp;
}

export interface ChangeLogEntity {
  sequenceId: number;
  entityType: string;
  entityId: ID;
  action: 'INSERT' | 'UPDATE' | 'DELETE' | 'TOMBSTONE';
  payload: Record<string, unknown>;
  version: number;
  changedAt: Timestamp;
}

export interface BackupCheckpointEntity {
  checkpointSequence: number;
  checkpointId: ID;
  checkpointType: string;
  manifest: Record<string, unknown>;
  integrityHash: string;
  createdAt: Timestamp;
}

export interface AuditLogEntity {
  id: ID;
  actorAdminId?: ID;
  action: string;
  entityType: string;
  entityId?: ID;
  details?: Record<string, unknown>;
  createdAt: Timestamp;
}

export interface OrderNumberReservationEntity extends BaseEntity {
  businessDayId: ID;
  deviceId: ID;
  startNumber: number;
  endNumber: number;
  nextNumber: number;
  status: 'ACTIVE' | 'EXHAUSTED';
  commandId?: ID;
}

