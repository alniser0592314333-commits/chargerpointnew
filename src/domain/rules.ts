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
 * Smart goal policy.
 * Monetary amounts are integer minor units (agorot); 100 minor units = ₪1.
 * Hard cap: ₪2 per 10 target devices = 20 minor units per target device.
 */
export const MIN_GOAL_DURATION_DAYS = 3;
export const MAX_GOAL_DURATION_DAYS = 15;
export const GOAL_BONUS_CAP_MINOR_PER_DEVICE = 20;
export const MIN_GOAL_BONUS_MINOR = 80;

export function randomGoalDurationDays(random: () => number = Math.random): number {
  const sample = Math.min(0.999999999, Math.max(0, random()));
  return MIN_GOAL_DURATION_DAYS + Math.floor(sample * (MAX_GOAL_DURATION_DAYS - MIN_GOAL_DURATION_DAYS + 1));
}

export function calculateGoalBonusCapMinor(targetQuantity: number): number {
  if (!Number.isInteger(targetQuantity) || targetQuantity <= 0) {
    throw new RangeError('Goal target quantity must be a positive integer.');
  }
  return targetQuantity * GOAL_BONUS_CAP_MINOR_PER_DEVICE;
}

/**
 * Legacy proposal policy note: proposals should be based on delivered activity,
 * with an adaptive stretch and a minimum target of 10 devices. The production
 * implementation is being revised to use a 28-day activity profile.
 */
export interface GeneratedGoalProposal {
  targetQuantity: number;
  durationDays: number;
  bonusAmountMinor: number;
  expiresAt: string;
}

export interface GenerateGoalProposalOptions {
  startedAt?: string;
  /** Optional deterministic override for tests/controlled admin workflows. */
  customRatePerDeviceMinor?: number;
  /** Explicit duration override; otherwise choose a random integer from 3 through 15. */
  customDurationDays?: number;
  /** Injectable random source for deterministic tests. */
  random?: () => number;
}

export function generateGoalProposal(
  recentDeliveredActivity: number | number[],
  options: GenerateGoalProposalOptions | string = {}
): GeneratedGoalProposal {
  const startedAt = typeof options === 'string' ? options : options.startedAt || new Date().toISOString();
  const customRate = typeof options === 'object' ? options.customRatePerDeviceMinor : undefined;
  const customDuration = typeof options === 'object' ? options.customDurationDays : undefined;
  const random = typeof options === 'object' ? options.random || Math.random : Math.random;
  const sample = () => Math.min(0.999999999, Math.max(0, random()));

  const isProfile = Array.isArray(recentDeliveredActivity);
  const profile = isProfile
    ? recentDeliveredActivity.slice(-28).map((n) => Math.max(0, Math.floor(Number.isFinite(n) ? n : 0)))
    : [Math.max(0, Math.floor(Number.isFinite(recentDeliveredActivity) ? recentDeliveredActivity : 0))];
  const recentDays = isProfile ? profile.slice(-7) : profile;
  const recentRate = recentDays.reduce((sum, n) => sum + n, 0) / Math.max(1, recentDays.length);
  const baselineRate = profile.reduce((sum, n) => sum + n, 0) / Math.max(1, profile.length);
  const dailyRate = isProfile ? recentRate * 0.65 + baselineRate * 0.35 : profile[0] / 7;

  const minDuration = isProfile ? (dailyRate >= 4 ? 3 : dailyRate >= 1.5 ? 4 : 6) : MIN_GOAL_DURATION_DAYS;
  const maxDuration = isProfile ? (dailyRate >= 4 ? 9 : dailyRate >= 1.5 ? 11 : MAX_GOAL_DURATION_DAYS) : MAX_GOAL_DURATION_DAYS;
  const durationDays = Number.isInteger(customDuration) && customDuration! >= MIN_GOAL_DURATION_DAYS && customDuration! <= MAX_GOAL_DURATION_DAYS
    ? customDuration!
    : minDuration + Math.floor(sample() * (maxDuration - minDuration + 1));
  const expectedDevicesDuringGoal = dailyRate * durationDays;
  const targetQuantity = isProfile
    ? Math.max(10, Math.ceil(expectedDevicesDuringGoal * (1.25 + sample() * 0.30)))
    : Math.max(10, Math.ceil(expectedDevicesDuringGoal + Math.max(10, expectedDevicesDuringGoal * 0.25)));
  const difficultyRatio = expectedDevicesDuringGoal > 0 ? targetQuantity / expectedDevicesDuringGoal : 1.5;
  const derivedRate = 8 + Math.min(5, Math.max(0, Math.round((difficultyRatio - 1) * 10)));
  const ratePerDeviceMinor = Number.isInteger(customRate) && customRate! >= 8 && customRate! <= 13
    ? customRate!
    : isProfile
      ? Math.min(13, Math.max(8, derivedRate + Math.floor(sample() * 3) - 1))
      : derivedRate;
  const bonusAmountMinor = Math.min(
    calculateGoalBonusCapMinor(targetQuantity),
    Math.max(MIN_GOAL_BONUS_MINOR, Math.round(targetQuantity * ratePerDeviceMinor))
  );
  const startDate = new Date(startedAt);
  const expiresDate = new Date(startDate.getTime() + durationDays * 24 * 60 * 60 * 1000);
  return { targetQuantity, durationDays, bonusAmountMinor, expiresAt: expiresDate.toISOString() };
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
    const isDelivered = item.status?.toLowerCase() === 'delivered';
    const operationallyDelivered =
      !item.operationalStatus || item.operationalStatus.toUpperCase() === 'DELIVERED';
    const isRecognized = item.financialStatus?.toUpperCase() === 'RECOGNIZED';

    if (isDelivered && operationallyDelivered && isRecognized && item.deliveredAt) {
      const deliveredTime = new Date(item.deliveredAt).getTime();
      if (deliveredTime >= startTime && deliveredTime <= expiresTime) {
        qualifyingItemIds.add(item.id);
      }
    }
  }

  return qualifyingItemIds.size;
}

