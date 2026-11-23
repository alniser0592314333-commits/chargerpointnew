import { describe, expect, it } from 'vitest';
import { shouldAttemptBootstrapRecovery } from '../infrastructure/sync/bootstrapRecovery';

describe('bootstrap recovery gate', () => {
  it('runs the first bootstrap when no initial hydration marker exists', () => {
    expect(shouldAttemptBootstrapRecovery({
      isResetCompleted: false,
      isInitialHydrationDone: false,
      syncStatus: 'RECONCILIATION_REQUIRED',
    })).toBe(true);
  });

  it('resumes an interrupted install even if a previous install marker is still present', () => {
    expect(shouldAttemptBootstrapRecovery({
      isResetCompleted: false,
      isInitialHydrationDone: true,
      syncStatus: 'INITIALIZING',
    })).toBe(true);
  });

  it('does not repeat a completed install', () => {
    expect(shouldAttemptBootstrapRecovery({
      isResetCompleted: false,
      isInitialHydrationDone: true,
      syncStatus: 'READY',
    })).toBe(false);
  });

  it('preserves an intentional local reset barrier', () => {
    expect(shouldAttemptBootstrapRecovery({
      isResetCompleted: true,
      isInitialHydrationDone: false,
      syncStatus: 'INITIALIZING',
    })).toBe(false);
  });
});
