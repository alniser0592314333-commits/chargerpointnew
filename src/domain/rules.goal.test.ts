import { describe, expect, it } from 'vitest';
import {
  calculateGoalBonusCapMinor,
  generateGoalProposal,
  randomGoalDurationDays,
} from './rules';

describe('smart goal policy', () => {
  it('chooses a random integer duration from 3 through 15 inclusive', () => {
    expect(randomGoalDurationDays(() => 0)).toBe(3);
    expect(randomGoalDurationDays(() => 0.5)).toBe(9);
    expect(randomGoalDurationDays(() => 0.999999)).toBe(15);
    for (let sample = 0; sample < 1; sample += 0.01) {
      const days = randomGoalDurationDays(() => sample);
      expect(Number.isInteger(days)).toBe(true);
      expect(days).toBeGreaterThanOrEqual(3);
      expect(days).toBeLessThanOrEqual(15);
    }
  });

  it('scales the target with both recent activity and challenge duration', () => {
    const short = generateGoalProposal(70, { customDurationDays: 3, startedAt: '2026-01-01T00:00:00.000Z' });
    const long = generateGoalProposal(70, { customDurationDays: 15, startedAt: '2026-01-01T00:00:00.000Z' });
    const higherActivity = generateGoalProposal(140, { customDurationDays: 15, startedAt: '2026-01-01T00:00:00.000Z' });

    expect(short.targetQuantity).toBeGreaterThanOrEqual(10);
    expect(long.targetQuantity).toBeGreaterThan(short.targetQuantity);
    expect(higherActivity.targetQuantity).toBeGreaterThan(long.targetQuantity);
  });

  it('calculates the hard cap as 20 minor units per target device', () => {
    expect(calculateGoalBonusCapMinor(10)).toBe(200);
    expect(calculateGoalBonusCapMinor(50)).toBe(1000);
    expect(calculateGoalBonusCapMinor(100)).toBe(2000);
    expect(() => calculateGoalBonusCapMinor(0)).toThrow();
  });

  it('keeps the proposal bonus integer-valued and under the ₪2-per-10-device cap', () => {
    for (let duration = 3; duration <= 15; duration += 1) {
      const proposal = generateGoalProposal(83, {
        customDurationDays: duration,
        startedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(Number.isInteger(proposal.bonusAmountMinor)).toBe(true);
      expect(proposal.bonusAmountMinor).toBeGreaterThanOrEqual(80);
      expect(proposal.bonusAmountMinor).toBeLessThanOrEqual(proposal.targetQuantity * 20);
      expect(new Date(proposal.expiresAt).getTime() - new Date('2026-01-01T00:00:00.000Z').getTime())
        .toBe(duration * 24 * 60 * 60 * 1000);
    }
  });

  it('uses the established 8–13 agorot/device reward band while reflecting challenge difficulty', () => {
    const easyBand = generateGoalProposal(70, {
      customDurationDays: 7,
      customRatePerDeviceMinor: 8,
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    const hardBand = generateGoalProposal(70, {
      customDurationDays: 7,
      customRatePerDeviceMinor: 13,
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(hardBand.bonusAmountMinor).toBeGreaterThan(easyBand.bonusAmountMinor);
    expect(hardBand.bonusAmountMinor).toBeLessThanOrEqual(hardBand.targetQuantity * 20);
  });
});
