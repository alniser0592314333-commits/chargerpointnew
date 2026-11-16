import { describe, expect, it } from 'vitest';
import { generateGoalProposal, randomGoalDurationDays } from './rules';

describe('smart goal proposal policy', () => {
  it('uses customer activity instead of fixed ten-device defaults', () => {
    const profile = Array.from({ length: 28 }, () => 4);
    const proposal = generateGoalProposal(profile, { random: () => 0 });

    expect(proposal.targetQuantity).toBeGreaterThan(10);
    expect(proposal.durationDays).toBe(5);
    expect(proposal.bonusAmountMinor).toBeGreaterThanOrEqual(150);
    expect(proposal.bonusAmountMinor).toBeLessThanOrEqual(proposal.targetQuantity * 20);
  });

  it('keeps randomized fallback durations away from the three-day minimum', () => {
    expect(randomGoalDurationDays(() => 0)).toBe(5);
    expect(randomGoalDurationDays(() => 0.999999)).toBe(15);
  });

  it('keeps rewards within the agreed 1.5–2 shekel per ten-device range', () => {
    const profile = Array.from({ length: 28 }, () => 4);
    const proposal = generateGoalProposal(profile, { random: () => 0 });
    const rewardPerTenDevices = proposal.bonusAmountMinor / proposal.targetQuantity * 10;

    expect(rewardPerTenDevices).toBeGreaterThanOrEqual(15);
    expect(rewardPerTenDevices).toBeLessThanOrEqual(20);
  });
});
