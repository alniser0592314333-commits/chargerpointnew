export interface BootstrapRecoveryState {
  isResetCompleted: boolean;
  isInitialHydrationDone: boolean;
  syncStatus?: string | null;
}

/**
 * A durable INITIALIZING sync state outranks a stale/previously committed
 * initial-hydration marker. The marker only describes a completed prior
 * install; it cannot prove that a later snapshot replacement finished.
 */
export const shouldAttemptBootstrapRecovery = (state: BootstrapRecoveryState): boolean =>
  !state.isResetCompleted &&
  (!state.isInitialHydrationDone || state.syncStatus === 'INITIALIZING');
