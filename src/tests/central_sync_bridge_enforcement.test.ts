import { describe, it, expect, beforeEach, vi } from 'vitest';
import { globalSyncBridge } from '../infrastructure/sync/syncBridge';
import {
  globalSyncEngine,
  resetStoreMemory,
  clearAllOperationalData,
  ensureStoreHydrated,
  refreshStoreFromRemote,
} from '../components/pages/dayOrdersStore';
import { localDb } from '../infrastructure/localDb/localDb';
import * as fs from 'fs';
import * as path from 'path';

describe('CENTRAL SYNC BRIDGE ENFORCEMENT & COALESCING AUDIT', () => {
  beforeEach(async () => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
    await clearAllOperationalData();
    await localDb.clearLocalResetMarker();
    resetStoreMemory();
    vi.restoreAllMocks();
  });

  // A. Startup + Online event concurrently -> Bridge coalesces without concurrent SyncEngine execution
  it('A. startup + online event concurrently does not trigger concurrent SyncEngine executions', async () => {
    let activeExecutions = 0;
    let maxConcurrent = 0;

    vi.spyOn(globalSyncEngine, 'synchronize').mockImplementation(async () => {
      activeExecutions++;
      maxConcurrent = Math.max(maxConcurrent, activeExecutions);
      await new Promise((r) => setTimeout(r, 40));
      activeExecutions--;
      return { pushed: 0, pulled: 0 };
    });

    const p1 = globalSyncBridge.notifyOutboxWorkAvailable();
    const p2 = globalSyncBridge.notifyOutboxWorkAvailable();

    await Promise.all([p1, p2]);

    expect(maxConcurrent).toBe(1);
    expect(activeExecutions).toBe(0);
  });

  // B. Startup + Visibilitychange -> Bridge coalesces properly
  it('B. startup + visibilitychange coalesces and ensures no unhandled concurrency errors', async () => {
    const syncSpy = vi.spyOn(globalSyncEngine, 'synchronize').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { pushed: 0, pulled: 0 };
    });

    const p1 = refreshStoreFromRemote();
    const p2 = globalSyncBridge.notifyOutboxWorkAvailable();

    await Promise.all([p1, p2]);

    expect(syncSpy).toHaveBeenCalled();
  });

  // C. Online + Visibilitychange + Outbox notification -> Bridge coalesces requests
  it('C. online + visibilitychange + outbox notification coalesces multiple rapid triggers', async () => {
    let callCount = 0;
    vi.spyOn(globalSyncEngine, 'synchronize').mockImplementation(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 30));
      return { pushed: 0, pulled: 0 };
    });

    const promises = [
      globalSyncBridge.notifyOutboxWorkAvailable(),
      globalSyncBridge.notifyOutboxWorkAvailable(),
      globalSyncBridge.notifyOutboxWorkAvailable(),
      globalSyncBridge.notifyOutboxWorkAvailable(),
    ];

    await Promise.all(promises);

    // Multiple rapid background notifications should coalesce into at most 2 cycles (current + coalesced pending)
    expect(callCount).toBeLessThanOrEqual(2);
  });

  // D. Manual Sync while a sync is in progress -> Gracefully awaits and succeeds without throwing to user
  it('D. requestManualSync during in-flight background sync awaits gracefully without throwing error', async () => {
    vi.spyOn(globalSyncEngine, 'resumePendingOutbox').mockResolvedValue(0);
    vi.spyOn(globalSyncEngine, 'synchronize').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return { pushed: 1, pulled: 1 };
    });

    // Start background sync
    const backgroundPromise = globalSyncBridge.notifyOutboxWorkAvailable();

    // Trigger manual sync while background sync is active
    const manualResult = await globalSyncBridge.requestManualSync();

    await backgroundPromise;

    expect(manualResult).toEqual({ pushed: 1, pulled: 1 });
  });

  // E. Latest Data Reload during sync -> Respects orchestration and does not cause concurrent SyncEngine execution
  it('E. requestLatestDataReload during active sync awaits and executes pull without collision', async () => {
    vi.spyOn(globalSyncEngine, 'synchronize').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return { pushed: 0, pulled: 0 };
    });

    vi.spyOn((globalSyncEngine as any).transport, 'pullChanges').mockResolvedValue({
      changes: [],
      latestSequence: 10,
    });

    const backgroundPromise = globalSyncBridge.notifyOutboxWorkAvailable();
    const reloadResult = await globalSyncBridge.requestLatestDataReload();

    await backgroundPromise;

    expect(reloadResult).toEqual({ pulled: 0 });
  });

  // F. Guard against direct callers of SyncEngine.synchronize in production codebase
  it('F. verifies no production store/UI file directly invokes globalSyncEngine.synchronize', () => {
    const srcDir = path.resolve(__dirname, '..');
    
    function scanFiles(dir: string): string[] {
      let results: string[] = [];
      const list = fs.readdirSync(dir);
      for (const file of list) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          if (file !== 'tests' && file !== 'node_modules') {
            results = results.concat(scanFiles(fullPath));
          }
        } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
          // Exclude syncBridge.ts and syncEngine.ts as they are the authorized internal engine files
          if (!fullPath.endsWith('syncBridge.ts') && !fullPath.endsWith('syncEngine.ts')) {
            results.push(fullPath);
          }
        }
      }
      return results;
    }

    const filesToAudit = scanFiles(srcDir);
    const directCallers: string[] = [];

    for (const file of filesToAudit) {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('globalSyncEngine.synchronize')) {
        directCallers.push(file);
      }
    }

    expect(directCallers).toEqual([]);
  });
});
