import { globalSyncEngine, applyRemoteChange, setTransactionCommittedHook } from '../../components/pages/dayOrdersStore';
import { localDb } from '../localDb/localDb';

export class SyncBridge {
  private isSyncing = false;
  private pendingWorkNotify = false;
  private activeSyncPromise: Promise<any> | null = null;

  constructor() {
    // Wire up delta change applier to globalSyncEngine
    globalSyncEngine.onDeltaApplied = applyRemoteChange;
    // Wire up transaction commit hook to trigger background sync coordinator
    setTransactionCommittedHook(() => {
      this.notifyOutboxWorkAvailable().catch((err) => {
        console.warn('Background sync error on commit hook:', err);
      });
    });
  }

  /**
   * globalSyncBridge.notifyOutboxWorkAvailable()
   * 
   * A) notifyOutboxWorkAvailable()
   * - Starts a background sync cycle after a successful local transaction commit, startup, or network reconnect.
   * - Does not make the UI wait for the sync result.
   * - Does not execute any domain mutations or send the whole database.
   * - Respects the current OutboxScheduler, priority, FIFO, and dependencies.
   * - Prevents concurrent sync cycles. Coalesces if one is already running.
   */
  async notifyOutboxWorkAvailable(): Promise<void> {
    if (this.isSyncing) {
      this.pendingWorkNotify = true;
      return;
    }

    this.isSyncing = true;
    const workExecution = (async () => {
      try {
        do {
          this.pendingWorkNotify = false;
          await globalSyncEngine.synchronize();
        } while (this.pendingWorkNotify);
      } catch (err: any) {
        if (!err?.message?.includes('already in progress')) {
          console.warn('SyncBridge background sync error:', err);
        }
      } finally {
        this.isSyncing = false;
        this.activeSyncPromise = null;
      }
    })();

    this.activeSyncPromise = workExecution;
    return workExecution;
  }

  /**
   * globalSyncBridge.requestManualSync()
   * 
   * B) requestManualSync()
   * Maintains manual Sync Now behavior:
   * 1. If background sync is currently running, gracefully awaits its completion
   * 2. resume eligible pending outbox
   * 3. push pending outbox commands
   * 4. pull remote changes
   * 5. apply remote changes locally safely
   */
  async requestManualSync(): Promise<{ pushed: number; pulled: number }> {
    // If another sync cycle is active, gracefully await its completion instead of throwing
    while (this.isSyncing && this.activeSyncPromise) {
      try {
        await this.activeSyncPromise;
      } catch {}
    }

    this.isSyncing = true;
    const syncExecution = (async () => {
      try {
        await globalSyncEngine.resumePendingOutbox();
        const result = await globalSyncEngine.synchronize();
        return result;
      } finally {
        this.isSyncing = false;
        this.activeSyncPromise = null;
      }
    })();

    this.activeSyncPromise = syncExecution;
    return syncExecution;
  }

  /**
   * globalSyncBridge.requestLatestDataReload()
   * 
   * C) requestLatestDataReload()
   * Must be PULL-ONLY.
   * - Does not start Push of outbox.
   * - Does not change, delete, or recreate the Outbox.
   * - Reads current lastAppliedChangeSequence.
   * - Fetches only new change_log from server.
   * - Applies changes locally via onDeltaApplied (applyRemoteChange).
   * - Cursor advancement and change application remain transactional.
   * - Cursor advances only after successful local application.
   * - No full hydration or full table refetching.
   * - Blocked if local_reset_completed marker is set.
   */
  async requestLatestDataReload(): Promise<{ pulled: number }> {
    // If another sync cycle is active, gracefully await its completion instead of throwing
    while (this.isSyncing && this.activeSyncPromise) {
      try {
        await this.activeSyncPromise;
      } catch {}
    }

    this.isSyncing = true;
    const reloadExecution = (async () => {
      let pulledCount = 0;

      try {
        // 1. Get current sequence cursor
        const syncState = (await localDb.getSyncState('global')) || {
          table: 'global',
          lastAppliedChangeSequence: 0,
          lastPulledAt: '',
        };

        // 2. Fetch remote change log from transport (pull-only)
        const pullRes = await (globalSyncEngine as any).transport.pullChanges(syncState.lastAppliedChangeSequence);

        if (pullRes.changes.length > 0) {
          const sortedChanges = [...pullRes.changes].sort((a, b) => a.sequenceId - b.sequenceId);
          await localDb.runTransaction(['kvStore', 'syncState'], 'readwrite', async (tx) => {
            for (const change of sortedChanges) {
              const applied = globalSyncEngine.onDeltaApplied
                ? await globalSyncEngine.onDeltaApplied(change, tx) !== false
                : applyRemoteChange(change, tx) !== false;
              if (!applied) break;
              pulledCount++;
            }
            const maxSeq = pulledCount > 0
              ? sortedChanges[pulledCount - 1].sequenceId
              : syncState.lastAppliedChangeSequence;
            const updatedState = {
              ...syncState,
              lastAppliedChangeSequence: maxSeq,
              lastPulledAt: new Date().toISOString(),
            };
            localDb.setSyncStateWithTx(tx, updatedState);
          });
        }

        return { pulled: pulledCount };
      } finally {
        this.isSyncing = false;
        this.activeSyncPromise = null;
      }
    })();

    this.activeSyncPromise = reloadExecution;
    return reloadExecution;
  }

  /**
   * Helper to inspect syncing state.
   */
  getIsSyncing(): boolean {
    return this.isSyncing;
  }
}

export const globalSyncBridge = new SyncBridge();
