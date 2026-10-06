/**
 * Canonical Domain Business Rules Engine (Phase 1 Baseline)
 * Pure functions encapsulating calculation and state validation logic.
 */

import { OrderStatus, ItemStatus } from './enums';
import { ItemFinancialStatus, ItemPaymentStatus } from './models';
import { BusinessRuleViolation, FinancialInvariantViolation } from './errors';

export const DEFAULT_CHARGER_FEE_MINOR = 50; // 0.50₪ standard fee in minor units (50)
export const CHARGER_FEE_MINOR = 50; // Compatibility alias

export interface CalculateItemPriceParams {
  basePriceMinor: number;
  chargerFeeEnabled?: boolean;
  chargerFeeApplicable?: boolean;
  customerExempt: boolean;
  hasCharger: boolean;
  chargerFeeMinor?: number;
  discountMinor?: number;
}

export interface CalculatedItemPrice {
  basePriceMinor: number;
  unitPriceMinor: number;
  totalPriceMinor: number;
  chargerFeeSnapshotMinor: number;
  discountSnapshotMinor: number;
  finalChargeSnapshotMinor: number;
}

/**
 * Calculates item price adhering to canonical charger fee rules, discount rules, and minor units arithmetic.
 * Invariant: Final Charge = Base Price + Charger Fee - Discount
 * Charger Fee Rule: (chargerFeeApplicable/Enabled && !customerExempt && !hasCharger) ? chargerFeeMinor : 0
 */
export function calculateItemPrice(params: CalculateItemPriceParams): CalculatedItemPrice {
  const {
    basePriceMinor,
    chargerFeeEnabled = true,
    chargerFeeApplicable = true,
    customerExempt,
    hasCharger,
    chargerFeeMinor = DEFAULT_CHARGER_FEE_MINOR,
    discountMinor = 0,
  } = params;

  if (basePriceMinor < 0 || !Number.isInteger(basePriceMinor)) {
    throw new FinancialInvariantViolation('Base price must be a non-negative integer in minor units.');
  }

  const isApplicable = chargerFeeEnabled && chargerFeeApplicable;
  let chargerFeeSnapshotMinor = 0;
  if (isApplicable && !customerExempt && !hasCharger) {
    chargerFeeSnapshotMinor = chargerFeeMinor > 0 ? chargerFeeMinor : 0;
  }

  const discountSnapshotMinor = discountMinor > 0 ? discountMinor : 0;
  let finalChargeSnapshotMinor = basePriceMinor + chargerFeeSnapshotMinor - discountSnapshotMinor;
  if (finalChargeSnapshotMinor < 0) {
    finalChargeSnapshotMinor = 0;
  }

  const unitPriceMinor = finalChargeSnapshotMinor;
  const totalPriceMinor = finalChargeSnapshotMinor;

  return {
    basePriceMinor,
    unitPriceMinor,
    totalPriceMinor,
    chargerFeeSnapshotMinor,
    discountSnapshotMinor,
    finalChargeSnapshotMinor,
  };
}

/**
 * Validates state transitions for Order status
 */
export function validateOrderTransition(current: OrderStatus, target: OrderStatus): void {
  if (current === target) return;

  const validTransitions: Record<string, string[]> = {
    pending: ['charging', 'cancelled'],
    charging: ['delivered', 'cancelled'],
    OPEN: ['COMPLETED', 'cancelled'],
    COMPLETED: [],
    delivered: [],
    cancelled: [],
  };

  if (!validTransitions[current]?.includes(target)) {
    throw new BusinessRuleViolation(`Invalid order status transition from '${current}' to '${target}'`);
  }
}


/**
 * Validates legacy ItemStatus transition
 */
export function validateItemTransition(current: ItemStatus, target: ItemStatus): void {
  if (current === target) return;

  const validTransitions: Record<string, string[]> = {
    pending: ['charging', 'delivered', 'cancelled'],
    charging: ['delivered', 'cancelled'],
    delivered: ['cancelled'],
    cancelled: [],
  };

  if (!validTransitions[current]?.includes(target)) {
    throw new BusinessRuleViolation(`Invalid order item status transition from '${current}' to '${target}'`);
  }
}

/**
 * Authoritative Debt limit check:
 * Customer balance is negative when in debt (e.g. -1500 minor = -15.00₪).
 * Debt limit is positive (e.g. 5000 minor = credit limit up to -50.00₪).
 * Allowed condition: currentBalanceMinor >= -debtLimitMinor.
 */
export function checkDebtLimit(
  projectedBalanceMinor: number,
  debtLimitMinor: number,
  isSuperAdmin: boolean = false
): boolean {
  if (isSuperAdmin) return true;
  // If debtLimitMinor is stored as negative (legacy convention: -100000 = debt down to -1000.00₪)
  if (debtLimitMinor < 0) {
    return projectedBalanceMinor >= debtLimitMinor;
  }
  // If debtLimitMinor is stored as positive limit (e.g. 5000 = max debt of 50.00₪)
  if (debtLimitMinor > 0) {
    return projectedBalanceMinor >= -debtLimitMinor;
  }
  // debtLimitMinor === 0: No debt allowed
  return projectedBalanceMinor >= 0;
}

/**
 * 7-Day Activity Analysis and Goal Parameter Generation
 */
export interface GeneratedGoalProposal {
  targetQuantity: number;
  durationDays: number;
  bonusAmountMinor: number;
  expiresAt: string;
}

export interface GenerateGoalProposalOptions {
  startedAt?: string;
  customRatePerDeviceMinor?: number; // Rate in minor units per device (range 8..13, i.e., 80..130 minor per 10 devices = 0.8..1.3 ILS / 10 devices)
  customDurationDays?: number; // Duration in days (range 6..7)
}

export function generateGoalProposal(
  past7DaysDeliveredCount: number,
  options: GenerateGoalProposalOptions | string = {}
): GeneratedGoalProposal {
  const startedAt = typeof options === 'string' ? options : options.startedAt || new Date().toISOString();
  const customRate = typeof options === 'object' ? options.customRatePerDeviceMinor : undefined;
  const customDuration = typeof options === 'object' ? options.customDurationDays : undefined;

  const safePastCount = Math.max(0, Math.floor(past7DaysDeliveredCount || 0));

  // 1. Target Quantity Algorithm:
  // Aggregates qualifying delivered+recognized items in previous 7 days.
  // Formula: Baseline + max(10, ceil(25% growth)), minimum target 10 devices.
  const targetQuantity = Math.max(10, safePastCount + 10, Math.ceil(safePastCount * 1.25));

  // 2. Goal Duration Algorithm:
  // Randomized / configurable between 6 and 7 days (default 7 days).
  const durationDays = customDuration !== undefined && customDuration >= 6 && customDuration <= 7
    ? customDuration
    : 7;

  // 3. Goal Bonus Formula (Approved Rate Reconciled):
  // Bonus rate: 0.8 - 1.3 ILS per 10 devices = 8 - 13 minor units per target device.
  // Default rate: 10 minor units per target device (1.00 ILS per 10 devices).
  const ratePerDeviceMinor = customRate !== undefined && customRate >= 8 && customRate <= 13
    ? customRate
    : 10;

  const rawBonusMinor = targetQuantity * ratePerDeviceMinor;

  // Exact Rounding Rule: Integer minor units (Math.round). Minimum bonus rule: 80 minor units (0.80 ILS).
  const bonusAmountMinor = Math.max(80, Math.round(rawBonusMinor));

  const startDate = new Date(startedAt);
  const expiresDate = new Date(startDate.getTime() + durationDays * 24 * 60 * 60 * 1000);

  return {
    targetQuantity,
    durationDays,
    bonusAmountMinor,
    expiresAt: expiresDate.toISOString(),
  };
}


/**
 * Server-compatible Order projection from canonical OrderItem.status.
 * This is a read/UI projection only; callers must not persist its result as an
 * authoritative Order.status mutation. Cancelled items are inactive.
 */
export function calculateOrderProjection(
  items: Array<{ status?: string | null }>,
  fallback: OrderStatus = 'pending'
): OrderStatus {
  const active = items.filter((item) => String(item.status || '').toLowerCase() !== 'cancelled');
  if (items.length === 0) return fallback;
  if (active.length === 0) return 'cancelled';
  const hasCharging = active.some((item) => String(item.status || '').toLowerCase() === 'charging');
  const hasDelivered = active.some((item) => String(item.status || '').toLowerCase() === 'delivered');
  if (hasCharging) return 'charging';
  if (hasDelivered) return 'delivered';
  return fallback;
}

/**
 * Calculates authoritative goal progress based on qualifying delivered & recognized order items
 */
export function calculateAuthoritativeGoalProgress(
  goal: { startedAt: string; expiresAt: string },
  customerItems: Array<{
    id: string;
    operationalStatus?: string;
    financialStatus?: string;
    status?: string;
    deliveredAt?: string;
    deletedAt?: string;
  }>
): number {
  const startTime = new Date(goal.startedAt).getTime();
  const expiresTime = new Date(goal.expiresAt).getTime();

  const qualifyingItemIds = new Set<string>();

  for (const item of customerItems) {
    if (item.deletedAt) continue;
<<<<<<< HEAD
    const isDelivered = item.status && item.status.toLowerCase() === 'delivered';
=======
    const isDelivered = (item.status && item.status.toLowerCase() === 'delivered');
>>>>>>> 4e55486a6852245c0d53ee50a72b8dfc88ec66ee
    const isRecognized =
      (item.financialStatus && item.financialStatus.toUpperCase() === 'RECOGNIZED') ||
      item.status === 'delivered';

    if (isDelivered && isRecognized && item.deliveredAt) {
      const deliveredTime = new Date(item.deliveredAt).getTime();
      if (deliveredTime >= startTime && deliveredTime <= expiresTime) {
        qualifyingItemIds.add(item.id);
      }
    }
  }

  return qualifyingItemIds.size;
}

/**
 * Calculates authoritative Order status projection from OrderItems adhering to Phase 1 rules.
 */
export function calculateOrderProjection(items: Array<{ status?: string }>): OrderStatus {
  if (!items || items.length === 0) {
    return 'pending';
  }
  const activeItems = items.filter(i => i.status && i.status.toLowerCase() !== 'cancelled');
  if (activeItems.length === 0) {
    return 'cancelled';
  }
  const hasCharging = activeItems.some(i => i.status && i.status.toLowerCase() === 'charging');
  const allDelivered = activeItems.every(i => i.status && i.status.toLowerCase() === 'delivered');

  if (allDelivered) {
    return 'delivered';
  }
  if (hasCharging) {
    return 'charging';
  }
  return 'charging';
}

