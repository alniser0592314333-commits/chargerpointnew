/**
 * Shared canonical goal proposal generator.
 * Imported by the app and the Sarah Edge Function so goal values are never reimplemented.
 */

export const MIN_GOAL_DURATION_DAYS = 3;
export const MAX_GOAL_DURATION_DAYS = 15;
export const GOAL_BONUS_CAP_MINOR_PER_DEVICE = 20;
export const MIN_GOAL_BONUS_MINOR = 150;

export function randomGoalDurationDays(random: () => number = Math.random): number {
  const sample = Math.min(0.999999999, Math.max(0, random()));
  // Randomized goals should not default to the shortest 3-day challenge.
  const minimumRandomDuration = 5;
  return minimumRandomDuration + Math.floor(sample * (MAX_GOAL_DURATION_DAYS - minimumRandomDuration + 1));
}

export function calculateGoalBonusCapMinor(targetQuantity: number): number {
  if (!Number.isInteger(targetQuantity) || targetQuantity <= 0) {
    throw new RangeError('Goal target quantity must be a positive integer.');
  }
  return targetQuantity * GOAL_BONUS_CAP_MINOR_PER_DEVICE;
}

/**
 * Smart proposals use the customer's delivered activity over 28 days, weighted
 * toward the latest week, with a controlled stretch and a minimum target of 10.
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
  /** Explicit duration override; otherwise choose an activity-based integer from 5 through 15. */
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

  const minDuration = isProfile ? (dailyRate >= 4 ? 5 : dailyRate >= 1.5 ? 5 : 7) : 5;
  const maxDuration = isProfile ? (dailyRate >= 4 ? 9 : dailyRate >= 1.5 ? 11 : MAX_GOAL_DURATION_DAYS) : MAX_GOAL_DURATION_DAYS;
  const durationDays = Number.isInteger(customDuration) && customDuration! >= MIN_GOAL_DURATION_DAYS && customDuration! <= MAX_GOAL_DURATION_DAYS
    ? customDuration!
    : minDuration + Math.floor(sample() * (maxDuration - minDuration + 1));
  const expectedDevicesDuringGoal = dailyRate * durationDays;
  const targetQuantity = isProfile
    ? Math.max(10, Math.ceil(expectedDevicesDuringGoal * (1.25 + sample() * 0.30)))
    : Math.max(10, Math.ceil(expectedDevicesDuringGoal + Math.max(10, expectedDevicesDuringGoal * 0.25)));
  const difficultyRatio = expectedDevicesDuringGoal > 0 ? targetQuantity / expectedDevicesDuringGoal : 1.5;
  const derivedRate = 15 + Math.min(5, Math.max(0, Math.round((difficultyRatio - 1) * 10)));
  const ratePerDeviceMinor = Number.isInteger(customRate) && customRate! >= 15 && customRate! <= 20
    ? customRate!
    : isProfile
      ? Math.min(20, Math.max(15, derivedRate + Math.floor(sample() * 3) - 1))
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
