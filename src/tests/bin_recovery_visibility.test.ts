import { describe, it, expect } from 'vitest';

describe('BIN Attempt Tracking & Recovery Visibility State Machine', () => {
  interface BinState {
    failedAttempts: number;
    isLocked: boolean;
  }

  // Pure logic replicating LoginPage.tsx visibility & input disabling
  const computeBinUiState = (state: BinState) => {
    const isLocked = state.isLocked || state.failedAttempts >= 3;
    const isRecoveryVisible = isLocked;
    const isBinInputDisabled = isLocked;
    const isVerifyButtonDisabled = isLocked;
    const remainingAttempts = Math.max(0, 3 - state.failedAttempts);

    return {
      isLocked,
      isRecoveryVisible,
      isBinInputDisabled,
      isVerifyButtonDisabled,
      remainingAttempts,
    };
  };

  it('0 failed attempts -> Recovery HIDDEN, input enabled', () => {
    const state: BinState = { failedAttempts: 0, isLocked: false };
    const ui = computeBinUiState(state);

    expect(ui.isRecoveryVisible).toBe(false);
    expect(ui.isBinInputDisabled).toBe(false);
    expect(ui.isVerifyButtonDisabled).toBe(false);
    expect(ui.remainingAttempts).toBe(3);
  });

  it('1 failed attempt -> Recovery HIDDEN, input enabled, 2 remaining', () => {
    const state: BinState = { failedAttempts: 1, isLocked: false };
    const ui = computeBinUiState(state);

    expect(ui.isRecoveryVisible).toBe(false);
    expect(ui.isBinInputDisabled).toBe(false);
    expect(ui.isVerifyButtonDisabled).toBe(false);
    expect(ui.remainingAttempts).toBe(2);
  });

  it('2 failed attempts -> Recovery HIDDEN, input enabled, 1 remaining', () => {
    const state: BinState = { failedAttempts: 2, isLocked: false };
    const ui = computeBinUiState(state);

    expect(ui.isRecoveryVisible).toBe(false);
    expect(ui.isBinInputDisabled).toBe(false);
    expect(ui.isVerifyButtonDisabled).toBe(false);
    expect(ui.remainingAttempts).toBe(1);
  });

  it('3 failed attempts -> Recovery VISIBLE, input DISABLED, LOCKED', () => {
    const state: BinState = { failedAttempts: 3, isLocked: true };
    const ui = computeBinUiState(state);

    expect(ui.isRecoveryVisible).toBe(true);
    expect(ui.isBinInputDisabled).toBe(true);
    expect(ui.isVerifyButtonDisabled).toBe(true);
    expect(ui.isLocked).toBe(true);
    expect(ui.remainingAttempts).toBe(0);
  });

  it('Post-Recovery Reset -> Counter resets to 0, Recovery becomes HIDDEN again', () => {
    let state: BinState = { failedAttempts: 3, isLocked: true };
    expect(computeBinUiState(state).isRecoveryVisible).toBe(true);

    // After successful recovery
    state = { failedAttempts: 0, isLocked: false };
    const ui = computeBinUiState(state);

    expect(ui.isRecoveryVisible).toBe(false);
    expect(ui.isBinInputDisabled).toBe(false);
    expect(ui.isLocked).toBe(false);
  });
});
