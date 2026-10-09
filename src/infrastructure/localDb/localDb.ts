/**
 * IndexedDB Local Database Implementation for Offline Persistence with Memory Fallback
 */

import { ID, Timestamp } from '../../types/common';

export interface OutboxRecord {
  commandId: ID;
  commandType: string;
  aggregateType: string;
  aggregateId: ID;
  mutationKey?: string;
  payload: unknown;
  payloadHash?: string;
  expectedVersion?: number;
  createdAt: Timestamp;
  deviceId: ID;
  actorAdminId: ID;
  status: 'pending' | 'PENDING_RECONCILIATION' | 'READY' | 'syncing' | 'accepted' | 'rejected' | 'conflict' | 'blocked';
  retryCount: number;
  lastError?: string;
  nextRetryAt?: Timestamp;
  serverProcessedAt?: Timestamp;
  correlationId?: ID;
  groupId?: string;
  dependencyCommandId?: ID;
  dependencyCommandIds?: ID[];
  dependencies?: ID[];
  priority?: number;
  resetGeneration?: number;
}


export interface MutationSnapshotItem {
  table: string;
  id: ID;
  previousRecord: any | null;
  existed: boolean;
}

export interface MutationSnapshotRecord {
  commandId: ID;
  mutationKey?: string;
  createdAt: Timestamp;
  records?: Array<{
    table: string;
    id: ID;
    existed: boolean;
    data?: unknown;
  }>;
  items?: MutationSnapshotItem[];
}

export type SyncStatus = 'READY' | 'RECONCILIATION_REQUIRED' | 'STALE' | 'INITIALIZING' | 'CLOUD_RESET_PENDING';

export interface SyncHistoryRecord {
  historyId: ID;
  commandId: ID;
  groupId?: string;
  commandType: string;
  entityType: string;
  entityId: ID;
  state:
    | 'PENDING'
    | 'READY'
    | 'WAITING_DEPENDENCY'
    | 'SYNCING'
    | 'ATTEMPTING'
    | 'SUCCEEDED'
    | 'SUCCESS'
    | 'FAILED_RETRYABLE'
    | 'FAILED_PERMANENT'
    | 'FAILED'
    | 'CONFLICT'
    | 'BLOCKED';
  createdAt: Timestamp;
  updatedAt: Timestamp;
  attemptCount: number;
  lastAttemptAt?: Timestamp;
  completedAt?: Timestamp;
  errorClass?: string;
  errorMessage?: string;
  errorDetails?: string;
  errorHint?: string;
  failureStage?: string;
  rpcReached?: boolean;
  retryEligible?: boolean;
  nextRetryAt?: Timestamp;
  httpStatus?: number;
  postgresSqlstate?: string;
  constraintName?: string;
  dependencyCommandId?: ID;
  dependencyCommandIds?: ID[];
  dependencies?: ID[];
  dependencyEntityType?: string;
  dependencyEntityId?: ID;
  priority?: number;
}

export interface SyncStateRecord {
  table: string;
  lastAppliedChangeSequence: number;
  lastPulledAt: Timestamp;
  resetGeneration?: number;
  reconciliationRequired?: boolean;
  /** True only after an intentional cloud business-data reset. Local data is preserved and automatic sync/pull is blocked until explicit Local -> Online replacement. */
  cloudResetPending?: boolean;
  status?: SyncStatus;
}

export type BackupSourceType = 'ONLINE' | 'OFFLINE' | 'CONSOLIDATED' | 'IMPORTED';

export interface BackupSnapshotData {
  customers: any[];
  businessDays: any[];
  orders: any[];
  orderItems: any[];
  financialLedger: any[];
  payments: any[];
  paymentAllocations: any[];
  deviceTypes: any[];
  goals?: any[];
  goalRequests?: any[];
  qrTokens?: any[];
  orderNumberReservations?: any[];
  // Exact local outbox checkpoint. Required to restore an offline snapshot
  // without losing unsynced work that was present when the backup was taken.
  outbox?: OutboxRecord[];
  syncHistory?: SyncHistoryRecord[];
  syncState?: SyncStateRecord | null;
  // Recovery-critical local metadata. These are part of an exact offline restore.
  deletedDeviceTypeMarkers?: any[];
  mutationSnapshots?: MutationSnapshotRecord[];
  // Exact optimistic UI overlays checkpointed with offline backups.
  optimisticOverlays?: OptimisticOverlayRecord[];
  changeLog?: any[];
  systemSettings?: any[];
  authoritativeCheckpoint?: { checkpointId?: string; checkpointSequence?: number; integrityHash?: string; authoritativeMaxSequence?: number };
  consolidationMetadata?: {
    onlineRecordCount: number;
    offlineRecordCount: number;
    reconciledCount: number;
    unresolvedConflicts: Array<{
      entityType: string;
      entityId: ID;
      reason: string;
      onlineVersion?: unknown;
      offlineVersion?: unknown;
    }>;
  };
}

export interface BackupSnapshotRecord {
  snapshotId: ID;
  snapshotName: string;
  createdAt: Timestamp;
  sourceType: BackupSourceType;
  schemaVersion: number;
  snapshotVersion: number;
  createdBy?: {
    id: ID;
    username: string;
    fullName?: string;
  };
  status: 'COMPLETED' | 'FAILED' | 'PARTIAL';
  metadata: {
    recordCounts: Record<string, number>;
    totalEntities: number;
    checksum: string;
    description?: string;
  };
  data: BackupSnapshotData;
}

const cloneForRollback = <T>(value: T): T => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
};

export interface OptimisticOverlayRecord {
  commandId: ID;
  mutationKey: string;
  entityType: string;
  entityId: ID;
  operation: 'CREATE' | 'PATCH' | 'DELETE';
  patch?: Record<string, unknown> | null;
  entityPayload?: Record<string, unknown> | null;
  sequence: number;
  createdAt: Timestamp;
  dependencyCommandId?: ID;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
}

export class IndexedDBLocalDatabase {
  private dbName = 'OrderSystemOfflineDB';
  private dbVersion = 5;
  private db: IDBDatabase | null = null;
  private memoryFallback = new Map<string, Map<ID, any>>();
  private memoryOutbox = new Map<ID, OutboxRecord>();
  private memorySyncState = new Map<string, SyncStateRecord>();
  private memorySyncHistory = new Map<ID, SyncHistoryRecord>();
  private memorySnapshots = new Map<ID, BackupSnapshotRecord>();
  private memoryMutationSnapshots = new Map<ID, MutationSnapshotRecord>();
  private memoryOverlays = new Map<ID, OptimisticOverlayRecord>();
  private overlaySequence = 0;
  private isBrowser = typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
  private hydrationPromise: Promise<void> | null = null;
  private isHydrated = false;

  async init(): Promise<void> {
    if (!this.isBrowser) {
      this.isHydrated = true;
      return;
    }
    if (this.hydrationPromise) return this.hydrationPromise;

    this.hydrationPromise = new Promise((resolve) => {
      try {
        const request = indexedDB.open(this.dbName, this.dbVersion);
        request.onerror = () => {
          console.warn('IndexedDB failed to open, running with in-memory persistence');
          this.isHydrated = true;
          resolve();
        };
        request.onsuccess = () => {
          this.db = request.result;
          // Hydrate in-memory cache from IndexedDB stores
          this.hydrateFromIndexedDB().then(() => {
            this.isHydrated = true;
            resolve();
          }).catch(() => {
            this.isHydrated = true;
            resolve();
          });
        };
        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains('outbox')) {
            db.createObjectStore('outbox', { keyPath: 'commandId' });
          }
          if (!db.objectStoreNames.contains('syncHistory')) {
            db.createObjectStore('syncHistory', { keyPath: 'historyId' });
          }
          if (!db.objectStoreNames.contains('syncState')) {
            db.createObjectStore('syncState', { keyPath: 'table' });
          }
          if (!db.objectStoreNames.contains('kvStore')) {
            db.createObjectStore('kvStore');
          }
          if (!db.objectStoreNames.contains('backupSnapshots')) {
            db.createObjectStore('backupSnapshots', { keyPath: 'snapshotId' });
          }
          if (!db.objectStoreNames.contains('mutationSnapshots')) {
            db.createObjectStore('mutationSnapshots', { keyPath: 'commandId' });
          }
          if (!db.objectStoreNames.contains('optimisticOverlays')) {
            db.createObjectStore('optimisticOverlays', { keyPath: 'commandId' });
          }
        };
      } catch (err) {
        console.warn('IndexedDB init error:', err);
        this.isHydrated = true;
        resolve();
      }
    });

    return this.hydrationPromise;
  }

  async ensureHydrated(): Promise<void> {
    if (this.isHydrated) return;
    if (this.hydrationPromise) return this.hydrationPromise;
    return this.init();
  }

  private async hydrateFromIndexedDB(): Promise<void> {
    if (!this.db) return;

    // 1. Hydrate kvStore
    if (this.db.objectStoreNames.contains('kvStore')) {
      await new Promise<void>((resolve) => {
        try {
          const tx = this.db!.transaction('kvStore', 'readonly');
          const store = tx.objectStore('kvStore');
          const req = store.openCursor();
          req.onsuccess = (e) => {
            const cursor = (e.target as IDBRequest).result as IDBCursorWithValue;
            if (cursor) {
              const val = cursor.value;
              if (val && val.table && val.id) {
                const tableMap = this.getMemoryTable(val.table);
                tableMap.set(val.id, val.item);
              }
              cursor.continue();
            } else {
              resolve();
            }
          };
          req.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }

    // 2. Hydrate outbox
    if (this.db.objectStoreNames.contains('outbox')) {
      await new Promise<void>((resolve) => {
        try {
          const tx = this.db!.transaction('outbox', 'readonly');
          const store = tx.objectStore('outbox');
          const req = store.openCursor();
          req.onsuccess = (e) => {
            const cursor = (e.target as IDBRequest).result as IDBCursorWithValue;
            if (cursor) {
              const val = cursor.value as OutboxRecord;
              if (val && val.commandId) {
                this.memoryOutbox.set(val.commandId, val);
              }
              cursor.continue();
            } else {
              resolve();
            }
          };
          req.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }

    // 3. Hydrate syncState
    if (this.db.objectStoreNames.contains('syncState')) {
      await new Promise<void>((resolve) => {
        try {
          const tx = this.db!.transaction('syncState', 'readonly');
          const store = tx.objectStore('syncState');
          const req = store.openCursor();
          req.onsuccess = (e) => {
            const cursor = (e.target as IDBRequest).result as IDBCursorWithValue;
            if (cursor) {
              const val = cursor.value as SyncStateRecord;
              if (val && val.table) {
                this.memorySyncState.set(val.table, val);
              }
              cursor.continue();
            } else {
              resolve();
            }
          };
          req.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }

    // 4. Hydrate syncHistory
    if (this.db.objectStoreNames.contains('syncHistory')) {
      await new Promise<void>((resolve) => {
        try {
          const tx = this.db!.transaction('syncHistory', 'readonly');
          const store = tx.objectStore('syncHistory');
          const req = store.openCursor();
          req.onsuccess = (e) => {
            const cursor = (e.target as IDBRequest).result as IDBCursorWithValue;
            if (cursor) {
              const val = cursor.value as SyncHistoryRecord;
              if (val && val.historyId) {
                this.memorySyncHistory.set(val.historyId, val);
                if (val.commandId) {
                  this.memorySyncHistory.set(val.commandId, val);
                }
                if (val.entityId) {
                  this.memorySyncHistory.set(val.entityId, val);
                }
              }
              cursor.continue();
            } else {
              resolve();
            }
          };
          req.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }

    // 5. Hydrate mutationSnapshots
    if (this.db.objectStoreNames.contains('mutationSnapshots')) {
      await new Promise<void>((resolve) => {
        try {
          const tx = this.db!.transaction('mutationSnapshots', 'readonly');
          const store = tx.objectStore('mutationSnapshots');
          const req = store.openCursor();
          req.onsuccess = (e) => {
            const cursor = (e.target as IDBRequest).result as IDBCursorWithValue;
            if (cursor) {
              const val = cursor.value as MutationSnapshotRecord;
              if (val?.commandId) this.memoryMutationSnapshots.set(val.commandId, val);
              cursor.continue();
            } else resolve();
          };
          req.onerror = () => resolve();
        } catch { resolve(); }
      });
    }

    // 5. Hydrate backupSnapshots
    if (this.db.objectStoreNames.contains('backupSnapshots')) {
      await new Promise<void>((resolve) => {
        try {
          const tx = this.db!.transaction('backupSnapshots', 'readonly');
          const store = tx.objectStore('backupSnapshots');
          const req = store.openCursor();
          req.onsuccess = (e) => {
            const cursor = (e.target as IDBRequest).result as IDBCursorWithValue;
            if (cursor) {
              const val = cursor.value as BackupSnapshotRecord;
              if (val && val.snapshotId) {
                this.memorySnapshots.set(val.snapshotId, val);
              }
              cursor.continue();
            } else {
              resolve();
            }
          };
          req.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }

    // 6. Hydrate mutationSnapshots
    if (this.db.objectStoreNames.contains('mutationSnapshots')) {
      await new Promise<void>((resolve) => {
        try {
          const tx = this.db!.transaction('mutationSnapshots', 'readonly');
          const store = tx.objectStore('mutationSnapshots');
          const req = store.openCursor();
          req.onsuccess = (e) => {
            const cursor = (e.target as IDBRequest).result as IDBCursorWithValue;
            if (cursor) {
              const val = cursor.value as MutationSnapshotRecord;
              if (val && val.commandId) {
                this.memoryMutationSnapshots.set(val.commandId, val);
              }
              cursor.continue();
            } else {
              resolve();
            }
          };
          req.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }

    // 7. Hydrate optimisticOverlays
    if (this.db.objectStoreNames.contains('optimisticOverlays')) {
      await new Promise<void>((resolve) => {
        try {
          const tx = this.db!.transaction('optimisticOverlays', 'readonly');
          const store = tx.objectStore('optimisticOverlays');
          const req = store.openCursor();
          req.onsuccess = (e) => {
            const cursor = (e.target as IDBRequest).result as IDBCursorWithValue;
            if (cursor) {
              const val = cursor.value as OptimisticOverlayRecord;
              if (val && val.commandId) {
                this.memoryOverlays.set(val.commandId, val);
                this.overlaySequence = Math.max(this.overlaySequence, Number(val.sequence) || 0);
              }
              cursor.continue();
            } else {
              resolve();
            }
          };
          req.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }

    // Reconcile orphaned mutation snapshots against active outbox commands
    const activeOutboxIds = new Set<ID>();
    for (const cmd of this.memoryOutbox.values()) {
      if (cmd.status === 'pending' || cmd.status === 'syncing' || cmd.status === 'PENDING_RECONCILIATION' || cmd.status === 'READY') {
        activeOutboxIds.add(cmd.commandId);
      }
    }
    for (const [cmdId] of this.memoryMutationSnapshots.entries()) {
      if (!activeOutboxIds.has(cmdId)) {
        this.memoryMutationSnapshots.delete(cmdId);
        if (this.db && this.db.objectStoreNames.contains('mutationSnapshots')) {
          try {
            const tx = this.db.transaction('mutationSnapshots', 'readwrite');
            tx.objectStore('mutationSnapshots').delete(cmdId);
          } catch {}
        }
      }
    }
  }

  private getMemoryTable(table: string): Map<ID, any> {
    if (!this.memoryFallback.has(table)) {
      this.memoryFallback.set(table, new Map());
    }
    return this.memoryFallback.get(table)!;
  }

  async get<T>(table: string, id: ID): Promise<T | null> {
    await this.ensureHydrated();
    const tableMap = this.getMemoryTable(table);
    if (tableMap.has(id)) {
      return tableMap.get(id);
    }
    if (this.db && this.db.objectStoreNames.contains('kvStore')) {
      return new Promise((resolve) => {
        try {
          const tx = this.db!.transaction('kvStore', 'readonly');
          const store = tx.objectStore('kvStore');
          const req = store.get(`${table}:${id}`);
          req.onsuccess = () => {
            if (req.result && req.result.item) {
              tableMap.set(id, req.result.item);
              resolve(req.result.item as T);
            } else {
              resolve(null);
            }
          };
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }
    return null;
  }

  async set<T>(table: string, id: ID, item: T): Promise<void> {
    await this.ensureHydrated();
    const tableMap = this.getMemoryTable(table);
    tableMap.set(id, item);
    if (this.db && this.db.objectStoreNames.contains('kvStore')) {
      try {
        const tx = this.db.transaction('kvStore', 'readwrite');
        const store = tx.objectStore('kvStore');
        store.put({ key: `${table}:${id}`, table, id, item }, `${table}:${id}`);
      } catch (err) {
        console.warn('Failed to persist to IndexedDB:', err);
      }
    }
  }

  async remove(table: string, id: ID): Promise<void> {
    await this.ensureHydrated();
    const tableMap = this.getMemoryTable(table);
    tableMap.delete(id);
    if (this.db && this.db.objectStoreNames.contains('kvStore')) {
      try {
        const tx = this.db.transaction('kvStore', 'readwrite');
        const store = tx.objectStore('kvStore');
        store.delete(`${table}:${id}`);
      } catch (err) {
        console.warn('Failed to delete from IndexedDB:', err);
      }
    }
  }

    async captureRecoverySnapshot(): Promise<{
    tables: Record<string, any[]>;
    outbox: OutboxRecord[];
    syncHistory: SyncHistoryRecord[];
    syncState: SyncStateRecord | null;
    mutationSnapshots: MutationSnapshotRecord[];
  }> {
    await this.ensureHydrated();
    const clone = <T>(value: T): T => cloneForRollback(value);
    const tableNames = [
      'customers','businessDays','orders','orderItems','financialLedger','payments',
      'paymentAllocations','deviceTypes','goals','goalRequests','qr_tokens','qrTokens',
      'orderNumberReservations','deletedDeviceTypeMarkers','changeLog'
    ];
    const tables: Record<string, any[]> = {};
    for (const name of tableNames) {
      tables[name] = Array.from(this.getMemoryTable(name).values()).map(clone);
    }
    const uniqueHistory = new Map<string, SyncHistoryRecord>();
    for (const h of this.memorySyncHistory.values()) {
      const key = h.historyId || h.commandId || h.entityId;
      if (key) uniqueHistory.set(String(key), clone(h));
    }
    return {
      tables,
      outbox: Array.from(this.memoryOutbox.values()).map(clone),
      syncHistory: Array.from(uniqueHistory.values()),
      syncState: clone(this.memorySyncState.get('global') || null),
      mutationSnapshots: Array.from(this.memoryMutationSnapshots.values()).map(clone),
      optimisticOverlays: Array.from(this.memoryOverlays.values()).map(clone),
    };
  }

  async list<T>(table: string): Promise<T[]> {
    await this.ensureHydrated();
    const tableMap = this.getMemoryTable(table);
    return Array.from(tableMap.values());
  }

  async clearTable(table: string): Promise<void> {
    await this.ensureHydrated();
    const tableMap = this.getMemoryTable(table);
    tableMap.clear();

    if (this.db && this.db.objectStoreNames.contains('kvStore')) {
      return new Promise<void>((resolve, reject) => {
        try {
          const tx = this.db!.transaction('kvStore', 'readwrite');
          const store = tx.objectStore('kvStore');
          const prefix = `${table}:`;
          const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
          const req = store.delete(range);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        } catch (err) {
          console.warn(`Failed to clear table ${table} from IndexedDB:`, err);
          resolve();
        }
      });
    }
  }

  async clearOperationalData(options?: {
    clearOutbox?: boolean;
    clearSyncState?: boolean;
    preservePendingMutations?: boolean;
  }): Promise<void> {
    const preservedRows: Array<{ table: string; id: ID; item: any }> = [];
    const preservedHistory: SyncHistoryRecord[] = [];
    const preservedSnapshots: MutationSnapshotRecord[] = [];

    if (options?.preservePendingMutations) {
      const protectedStatuses = new Set<OutboxRecord['status']>([
        'pending',
        'PENDING_RECONCILIATION',
        'READY',
        'syncing',
        'accepted',
        'blocked',
        'conflict',
      ]);
      for (const outbox of this.memoryOutbox.values()) {
        if (!protectedStatuses.has(outbox.status)) continue;
        if (!outbox.aggregateType || !outbox.aggregateId || outbox.aggregateType === 'COMMAND') continue;
        const tableAliases: Record<string, string> = {
          business_days: 'businessDays',
          device_types: 'deviceTypes',
          order_items: 'orderItems',
          financial_ledger: 'financialLedger',
          payment_allocations: 'paymentAllocations',
          order_number_reservations: 'orderNumberReservations',
          goal_requests: 'goalRequests',
          qr_tokens: 'qrTokens',
        };
        const localTable = tableAliases[outbox.aggregateType] || outbox.aggregateType;
        const tableMap = this.memoryFallback.get(localTable);
        const row = tableMap?.get(outbox.aggregateId);
        if (row !== undefined) {
          preservedRows.push({
            table: localTable,
            id: outbox.aggregateId,
            item: cloneForRollback(row),
          });
        }
        const history = this.memorySyncHistory.get(outbox.commandId);
        if (history) preservedHistory.push(cloneForRollback(history));
        const snapshot = this.memoryMutationSnapshots.get(outbox.commandId);
        if (snapshot) preservedSnapshots.push(cloneForRollback(snapshot));
      }
    }

    const operationalTables = [
      'customers',
      'deviceTypes',
      'businessDays',
      'orders',
      'orderItems',
      'financialLedger',
      'payments',
      'paymentAllocations',
      'goals',
      'goalRequests',
      'qrTokens',
      'qr_tokens',
      'orderNumberReservations',
      'changeLog',
      'deletedDeviceTypeMarkers',
      'systemSettings'
    ];

    for (const table of operationalTables) {
      await this.clearTable(table);
    }

    // Also clear sync history when performing an operational clear
    this.memorySyncHistory.clear();
    this.memoryMutationSnapshots.clear();
    this.memoryOverlays.clear();

    const storesToClear = ['syncHistory', 'mutationSnapshots', 'optimisticOverlays'];
    if (options?.clearOutbox) {
      this.memoryOutbox.clear();
      storesToClear.push('outbox');
    }
    if (options?.clearSyncState) {
      this.memorySyncState.clear();
      storesToClear.push('syncState');
    }

    if (this.db) {
      try {
        const availableStores = storesToClear.filter(s => this.db!.objectStoreNames.contains(s));
        if (availableStores.length > 0) {
          const tx = this.db.transaction(availableStores, 'readwrite');
          for (const s of availableStores) {
            tx.objectStore(s).clear();
          }
        }
      } catch {}
    }

    // A generation reset is a remote read-model reset, not permission to erase
    // unsynced local work. Restore every protected aggregate after the reset and
    // restore its sync metadata so the outbox can continue normally.
    if (options?.preservePendingMutations) {
      for (const row of preservedRows) {
        await this.set(row.table, row.id, row.item);
      }
      for (const history of preservedHistory) {
        await this.saveHistory(history);
      }
      for (const snapshot of preservedSnapshots) {
        await this.saveMutationSnapshot(snapshot);
      }
    }
  }

  async clearOperationalTables(options?: { clearOutbox?: boolean; clearSyncState?: boolean }): Promise<void> {
    return this.clearOperationalData(options);
  }

  // Support test fault injection hook
  private writeHookForTesting: ((table: string, id: ID, item: unknown) => void) | null = null;

  __setWriteHookForTesting(hook: ((table: string, id: ID, item: unknown) => void) | null): void {
    this.writeHookForTesting = hook;
  }

  async runTransaction<T = void>(
    stores: string[],
    mode: IDBTransactionMode,
    work: (tx: IDBTransaction) => Promise<T> | T
  ): Promise<T> {
    const snapshotFallback = new Map<string, Map<ID, any>>();
    for (const [table, map] of this.memoryFallback.entries()) {
      snapshotFallback.set(table, cloneForRollback(new Map(map)));
    }
    const snapshotOutbox = new Map<ID, OutboxRecord>();
    for (const [id, record] of this.memoryOutbox.entries()) {
      snapshotOutbox.set(id, cloneForRollback(record));
    }
    const snapshotSyncState = new Map<string, SyncStateRecord>();
    for (const [table, record] of this.memorySyncState.entries()) {
      snapshotSyncState.set(table, cloneForRollback(record));
    }
    const snapshotSyncHistory = new Map<ID, SyncHistoryRecord>();
    for (const [id, record] of this.memorySyncHistory.entries()) {
      snapshotSyncHistory.set(id, cloneForRollback(record));
    }
    const snapshotMutationSnapshots = new Map<ID, MutationSnapshotRecord>();
    for (const [id, record] of this.memoryMutationSnapshots.entries()) {
      snapshotMutationSnapshots.set(id, cloneForRollback(record));
    }
    const snapshotOverlays = new Map<ID, OptimisticOverlayRecord>();
    for (const [id, record] of this.memoryOverlays.entries()) {
      snapshotOverlays.set(id, cloneForRollback(record));
    }

    const rollbackMemory = () => {
      this.memoryFallback = new Map();
      for (const [table, map] of snapshotFallback.entries()) {
        this.memoryFallback.set(table, new Map(map));
      }
      this.memoryOutbox = cloneForRollback(new Map(snapshotOutbox));
      this.memorySyncState = cloneForRollback(new Map(snapshotSyncState));
      this.memorySyncHistory = cloneForRollback(new Map(snapshotSyncHistory));
      this.memoryMutationSnapshots = cloneForRollback(new Map(snapshotMutationSnapshots));
      this.memoryOverlays = cloneForRollback(new Map(snapshotOverlays));
    };

    if (!this.db) {
      // Memory fallback atomic transaction
      const mockTx = {
        db: { objectStoreNames: { contains: () => false } },
        objectStore: (name: string) => ({
          put: () => {},
          get: () => {},
          delete: () => {},
          clear: () => {},
        }),
        abort: () => {
          rollbackMemory();
          throw new Error('IndexedDB transaction aborted');
        },
      } as unknown as IDBTransaction;

      try {
        const result = work(mockTx);
        if (result && typeof (result as any).then === 'function') {
          return (result as Promise<T>).catch((err) => {
            rollbackMemory();
            throw err;
          });
        }
        return Promise.resolve(result as T);
      } catch (err) {
        rollbackMemory();
        throw err;
      }
    }

    const availableStores = stores.filter((s) => this.db!.objectStoreNames.contains(s));
    if (availableStores.length === 0) {
      try {
        const result = work({} as any);
        if (result && typeof (result as any).then === 'function') {
          return (result as Promise<T>).catch((err) => {
            rollbackMemory();
            throw err;
          });
        }
        return Promise.resolve(result as T);
      } catch (err) {
        rollbackMemory();
        throw err;
      }
    }

    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction | undefined;
      try {
        tx = this.db!.transaction(availableStores, mode);
        let resultVal: T;

        tx.oncomplete = () => {
          resolve(resultVal);
        };
        tx.onerror = () => {
          rollbackMemory();
          reject(tx?.error || new Error('IndexedDB transaction error'));
        };
        tx.onabort = () => {
          rollbackMemory();
          reject(new Error('IndexedDB transaction aborted'));
        };

        const result = work(tx);
        if (result && typeof (result as any).then === 'function') {
          (result as Promise<T>)
            .then((val) => {
              resultVal = val;
            })
            .catch((err) => {
              rollbackMemory();
              if (tx) {
                try {
                  tx.abort();
                } catch {}
              }
              reject(err);
            });
        } else {
          resultVal = result as T;
        }
      } catch (err) {
        rollbackMemory();
        if (tx) {
          try {
            tx.abort();
          } catch {}
        }
        reject(err);
      }
    });
  }

  async saveMutationSnapshot(record: MutationSnapshotRecord): Promise<void> {
    await this.ensureHydrated();
    this.memoryMutationSnapshots.set(record.commandId, cloneForRollback(record));
    if (this.db && this.db.objectStoreNames.contains('mutationSnapshots')) {
      const tx = this.db.transaction('mutationSnapshots', 'readwrite');
      tx.objectStore('mutationSnapshots').put(record);
    }
  }

  saveMutationSnapshotWithTx(tx: IDBTransaction, record: MutationSnapshotRecord): void {
    this.memoryMutationSnapshots.set(record.commandId, cloneForRollback(record));
    if (tx?.objectStore) tx.objectStore('mutationSnapshots').put(record);
  }

  async listMutationSnapshots(): Promise<MutationSnapshotRecord[]> {
    await this.ensureHydrated();
    return Array.from(this.memoryMutationSnapshots.values()).map(cloneForRollback);
  }

  async getMutationSnapshot(commandId: ID): Promise<MutationSnapshotRecord | null> {
    await this.ensureHydrated();
    if (this.memoryMutationSnapshots.has(commandId)) {
      return this.memoryMutationSnapshots.get(commandId)!;
    }
    if (this.db && this.db.objectStoreNames.contains('mutationSnapshots')) {
      return new Promise((resolve) => {
        try {
          const tx = this.db!.transaction('mutationSnapshots', 'readonly');
          const req = tx.objectStore('mutationSnapshots').get(commandId);
          req.onsuccess = () => resolve((req.result as MutationSnapshotRecord) || null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }
    return null;
  }

  getMutationSnapshotSync(commandId: ID): MutationSnapshotRecord | null {
    return this.memoryMutationSnapshots.get(commandId) || null;
  }

  async deleteMutationSnapshot(commandId: ID): Promise<void> {
    await this.ensureHydrated();
    this.memoryMutationSnapshots.delete(commandId);
    if (this.db && this.db.objectStoreNames.contains('mutationSnapshots')) {
      const tx = this.db.transaction('mutationSnapshots', 'readwrite');
      tx.objectStore('mutationSnapshots').delete(commandId);
    }
  }

  deleteMutationSnapshotWithTx(tx: IDBTransaction, commandId: ID): void {
    this.memoryMutationSnapshots.delete(commandId);
    if (tx?.objectStore) tx.objectStore('mutationSnapshots').delete(commandId);
  }

  rollbackMutationSnapshotWithTx(tx: IDBTransaction, commandId: ID): void {
    const snapshot = this.memoryMutationSnapshots.get(commandId);
    if (!snapshot) return;
    for (const record of (snapshot.records || [])) {
      const table = this.getMemoryTable(record.table);
      const current = table.get(record.id);
      const currentVersion = Number((current as any)?.version ?? -1);
      const snapshotVersion = Number((record.data as any)?.version ?? -1);
      // Never overwrite a newer authoritative delta with an old optimistic snapshot.
      if (current && currentVersion > snapshotVersion) continue;
      if (record.existed) {
        table.set(record.id, cloneForRollback(record.data));
        tx.objectStore('kvStore').put({ key: `${record.table}:${record.id}`, table: record.table, id: record.id, item: cloneForRollback(record.data) }, `${record.table}:${record.id}`);
      } else {
        table.delete(record.id);
        tx.objectStore('kvStore').delete(`${record.table}:${record.id}`);
      }
    }
    this.memoryMutationSnapshots.delete(commandId);
    tx.objectStore('mutationSnapshots').delete(commandId);
  }

  async saveOutbox(record: OutboxRecord): Promise<void> {
    await this.ensureHydrated();
    this.memoryOutbox.set(record.commandId, record);
    if (this.db && this.db.objectStoreNames.contains('outbox')) {
      try {
        const tx = this.db.transaction('outbox', 'readwrite');
        const store = tx.objectStore('outbox');
        store.put(record);
      } catch (err) {
        console.warn('Failed to persist outbox to IndexedDB:', err);
      }
    }
  }

  async deleteOutbox(commandId: ID): Promise<void> {
    await this.ensureHydrated();
    this.memoryOutbox.delete(commandId);
    if (this.db && this.db.objectStoreNames.contains('outbox')) {
      try {
        const tx = this.db.transaction('outbox', 'readwrite');
        const store = tx.objectStore('outbox');
        store.delete(commandId);
      } catch (err) {
        console.warn('Failed to delete outbox record from IndexedDB:', err);
      }
    }
  }

  saveOutboxWithTx(tx: IDBTransaction, record: OutboxRecord): void {
    this.memoryOutbox.set(record.commandId, record);
    if (tx && typeof tx.objectStore === 'function') {
      try {
        const store = tx.objectStore('outbox');
        store.put(record);
      } catch (err) {
        console.warn('Failed to persist outbox to transaction:', err);
        throw err;
      }
    }
  }

  setWithTx<T>(tx: IDBTransaction | undefined | null, table: string, id: ID, item: T): void {
    if (this.writeHookForTesting) {
      this.writeHookForTesting(table, id, item);
    }
    const tableMap = this.getMemoryTable(table);
    tableMap.set(id, item);
    if (tx && typeof tx.objectStore === 'function') {
      try {
        const store = tx.objectStore('kvStore');
        if (store && typeof store.put === 'function') {
          store.put({ key: `${table}:${id}`, table, id, item }, `${table}:${id}`);
        }
      } catch (err) {
        console.error(`Failed to persist kv to transaction for ${table}:${id}. Error: ${err}`);
        throw err;
      }
    }
  }

  setSyncStateWithTx(tx: IDBTransaction, record: SyncStateRecord): void {
    this.memorySyncState.set(record.table, record);
    if (tx && typeof tx.objectStore === 'function') {
      try {
        const store = tx.objectStore('syncState');
        if (store && typeof store.put === 'function') {
          store.put(record);
        }
      } catch (err) {
        console.warn('Failed to persist syncState to transaction:', err);
        throw err;
      }
    }
  }

  clearOutboxWithTx(tx: IDBTransaction): void {
    this.memoryOutbox.clear();
    if (tx && typeof tx.objectStore === 'function') {
      try {
        const store = tx.objectStore('outbox');
        if (store && typeof store.clear === 'function') store.clear();
      } catch (err) {
        console.warn('Failed to clear outbox in transaction:', err);
        throw err;
      }
    }
  }

  clearOperationalTablesWithTx(tx: IDBTransaction): void {
    const operationalTables = [
      'customers',
      'businessDays',
      'orders',
      'orderItems',
      'financialLedger',
      'payments',
      'paymentAllocations',
      'deviceTypes',
      'qr_tokens',
      'qrTokens',
      'deletedDeviceTypeMarkers',
      'orderNumberReservations',
      'changeLog',
      'goals',
      'goalRequests',
      'systemSettings',
    ];

    for (const table of operationalTables) {
      const tableMap = this.memoryFallback.get(table);
      if (tableMap) {
        tableMap.clear();
      }
    }

    // syncHistory and mutation snapshots are cleared to ensure a clean slate for the new generation
    this.memorySyncHistory.clear();
    this.memoryMutationSnapshots.clear();
    this.memoryOverlays.clear();

    if (tx && typeof tx.objectStore === 'function') {
      try {
        const storesToCheck = ['kvStore', 'syncHistory', 'mutationSnapshots', 'optimisticOverlays'];
        for (const storeName of storesToCheck) {
          try {
            const hasStore = tx.db.objectStoreNames.contains(storeName);
            if (hasStore) {
              const store = tx.objectStore(storeName);
              if (store && typeof store.clear === 'function') {
                store.clear();
              }
            }
          } catch {}
        }
      } catch (err) {
        console.warn('Failed to clear operational stores in transaction:', err);
        throw err;
      }
    }
  }

  removeWithTx(tx: IDBTransaction, table: string, id: ID): void {
    const tableMap = this.getMemoryTable(table);
    tableMap.delete(id);
    if (tx && typeof tx.objectStore === 'function') {
      try {
        const store = tx.objectStore('kvStore');
        store.delete(`${table}:${id}`);
      } catch (err) {
        console.warn('Failed to delete kv from transaction:', err);
        throw err;
      }
    }
  }

  async getOutbox(commandId: ID): Promise<OutboxRecord | null> {
    await this.ensureHydrated();
    const mem = this.memoryOutbox.get(commandId);
    if (mem) return mem;
    if (this.db && this.db.objectStoreNames.contains('outbox')) {
      return new Promise((resolve) => {
        try {
          const tx = this.db!.transaction('outbox', 'readonly');
          const store = tx.objectStore('outbox');
          const req = store.get(commandId);
          req.onsuccess = () => {
            if (req.result) {
              this.memoryOutbox.set(commandId, req.result);
              resolve(req.result as OutboxRecord);
            } else {
              resolve(null);
            }
          };
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }
    return null;
  }

  async listOutbox(): Promise<OutboxRecord[]> {
    await this.ensureHydrated();
    return Array.from(this.memoryOutbox.values());
  }

  listOutboxSync(): OutboxRecord[] {
    return Array.from(this.memoryOutbox.values());
  }

  getHistorySync(historyId: ID): SyncHistoryRecord | null {
    return this.memorySyncHistory.get(historyId) || null;
  }

  async getSyncState(table: string): Promise<SyncStateRecord | null> {
    await this.ensureHydrated();
    const mem = this.memorySyncState.get(table);
    if (mem) return mem;
    if (this.db && this.db.objectStoreNames.contains('syncState')) {
      const res = await new Promise<SyncStateRecord | null>((resolve) => {
        try {
          const tx = this.db!.transaction('syncState', 'readonly');
          const store = tx.objectStore('syncState');
          const req = store.get(table);
          req.onsuccess = () => {
            if (req.result) {
              this.memorySyncState.set(table, req.result);
              resolve(req.result as SyncStateRecord);
            } else {
              resolve(null);
            }
          };
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
      if (res) return res;
    }
    if (table === 'global') {
      const defaultReconcileState: SyncStateRecord = {
        table: 'global',
        lastAppliedChangeSequence: 0,
        lastPulledAt: '',
        resetGeneration: -1,
        status: 'RECONCILIATION_REQUIRED',
        reconciliationRequired: true,
      };
      this.memorySyncState.set('global', defaultReconcileState);
      return defaultReconcileState;
    }
    return null;
  }

  getSyncStateSync(table: string): SyncStateRecord | null {
    const mem = this.memorySyncState.get(table);
    if (mem) return mem;
    if (table === 'global') {
      const defaultReconcileState: SyncStateRecord = {
        table: 'global',
        lastAppliedChangeSequence: 0,
        lastPulledAt: '',
        resetGeneration: -1,
        status: 'RECONCILIATION_REQUIRED',
        reconciliationRequired: true,
      };
      this.memorySyncState.set('global', defaultReconcileState);
      return defaultReconcileState;
    }
    return null;
  }

  async setSyncState(record: SyncStateRecord): Promise<void> {
    await this.ensureHydrated();
    this.memorySyncState.set(record.table, record);
    if (this.db && this.db.objectStoreNames.contains('syncState')) {
      try {
        const tx = this.db.transaction('syncState', 'readwrite');
        const store = tx.objectStore('syncState');
        store.put(record);
      } catch (err) {
        console.warn('Failed to persist syncState to IndexedDB:', err);
      }
    }
  }
  saveHistoryWithTx(tx: IDBTransaction, record: SyncHistoryRecord): void {
    this.memorySyncHistory.set(record.historyId, record);
    if (record.commandId) {
      this.memorySyncHistory.set(record.commandId, record);
    }
    if (record.entityId) {
      this.memorySyncHistory.set(record.entityId, record);
    }
    if (tx && typeof tx.objectStore === 'function') {
      try {
        const store = tx.objectStore('syncHistory');
        store.put(record);
      } catch (err) {
        console.warn('Failed to persist syncHistory to transaction:', err);
        throw err;
      }
    }
  }

  async saveHistory(record: SyncHistoryRecord): Promise<void> {
    await this.ensureHydrated();
    this.memorySyncHistory.set(record.historyId, record);
    if (record.commandId) {
      this.memorySyncHistory.set(record.commandId, record);
    }
    if (record.entityId) {
      this.memorySyncHistory.set(record.entityId, record);
    }
    if (this.db && this.db.objectStoreNames.contains('syncHistory')) {
      try {
        const tx = this.db.transaction('syncHistory', 'readwrite');
        const store = tx.objectStore('syncHistory');
        store.put(record);
      } catch (err) {
        console.warn('Failed to persist syncHistory to IndexedDB:', err);
      }
    }
  }

  async getHistory(historyId: ID): Promise<SyncHistoryRecord | null> {
    await this.ensureHydrated();
    const mem = this.memorySyncHistory.get(historyId);
    if (mem) return mem;
    if (this.db && this.db.objectStoreNames.contains('syncHistory')) {
      return new Promise((resolve) => {
        try {
          const tx = this.db!.transaction('syncHistory', 'readonly');
          const store = tx.objectStore('syncHistory');
          const req = store.get(historyId);
          req.onsuccess = () => {
            if (req.result) {
              const res = req.result as SyncHistoryRecord;
              this.memorySyncHistory.set(historyId, res);
              if (res.commandId) this.memorySyncHistory.set(res.commandId, res);
              if (res.entityId) this.memorySyncHistory.set(res.entityId, res);
              resolve(res);
            } else {
              resolve(null);
            }
          };
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }
    return null;
  }

  async getHistoryByCommandId(commandId: ID): Promise<SyncHistoryRecord | null> {
    const mem = this.memorySyncHistory.get(commandId);
    if (mem) return mem;
    for (const h of this.memorySyncHistory.values()) {
      if (h.commandId === commandId || h.entityId === commandId || h.historyId === commandId) return h;
    }
    const byId = await this.getHistory(commandId);
    if (byId) return byId;
    const all = await this.listHistory();
    return all.find((h) => h.commandId === commandId || h.entityId === commandId || h.historyId === commandId) || null;
  }

  async listHistory(): Promise<SyncHistoryRecord[]> {
    await this.ensureHydrated();
    if (this.memorySyncHistory.size > 0 || !this.db) {
      // Deduplicate in memory map (since we might key by historyId and commandId)
      const unique = new Map<ID, SyncHistoryRecord>();
      for (const h of this.memorySyncHistory.values()) {
        unique.set(h.historyId || h.commandId, h);
      }
      return Array.from(unique.values());
    }
    if (this.db && this.db.objectStoreNames.contains('syncHistory')) {
      return new Promise((resolve) => {
        try {
          const tx = this.db!.transaction('syncHistory', 'readonly');
          const store = tx.objectStore('syncHistory');
          const req = store.getAll();
          req.onsuccess = () => {
            const list = (req.result || []) as SyncHistoryRecord[];
            for (const item of list) {
              if (item.historyId) this.memorySyncHistory.set(item.historyId, item);
              if (item.commandId) this.memorySyncHistory.set(item.commandId, item);
            }
            resolve(list);
          };
          req.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      });
    }
    return [];
  }

  async clearSyncHistory(): Promise<void> {
    this.memorySyncHistory.clear();
    if (this.db && this.db.objectStoreNames.contains('syncHistory')) {
      try {
        const tx = this.db.transaction('syncHistory', 'readwrite');
        tx.objectStore('syncHistory').clear();
      } catch {}
    }
  }

  async setLocalResetMarker(completed: boolean): Promise<void> {
    if (completed) {
      await this.set('systemMetadata', 'local_reset_completed', {
        key: 'local_reset_completed',
        completed: true,
        timestamp: new Date().toISOString(),
      });
    } else {
      await this.remove('systemMetadata', 'local_reset_completed');
    }
  }

  async isLocalResetCompleted(): Promise<boolean> {
    const record = await this.get<{ completed?: boolean }>('systemMetadata', 'local_reset_completed');
    return Boolean(record && record.completed === true);
  }

  async clearLocalResetMarker(): Promise<void> {
    await this.remove('systemMetadata', 'local_reset_completed');
  }

  async setInitialHydrationCompleted(completed: boolean): Promise<void> {
    if (completed) {
      await this.set('systemMetadata', 'initial_hydration_completed', {
        key: 'initial_hydration_completed',
        completed: true,
        timestamp: new Date().toISOString(),
      });
    } else {
      await this.remove('systemMetadata', 'initial_hydration_completed');
    }
  }

  async isInitialHydrationCompleted(): Promise<boolean> {
    const record = await this.get<{ completed?: boolean }>('systemMetadata', 'initial_hydration_completed');
    return Boolean(record && record.completed === true);
  }

  async saveSnapshot(record: BackupSnapshotRecord): Promise<void> {
    await this.ensureHydrated();
    this.memorySnapshots.set(record.snapshotId, record);
    if (this.db && this.db.objectStoreNames.contains('backupSnapshots')) {
      try {
        const tx = this.db.transaction('backupSnapshots', 'readwrite');
        const store = tx.objectStore('backupSnapshots');
        store.put(record);
      } catch (err) {
        console.warn('Failed to persist snapshot to IndexedDB:', err);
      }
    }
  }

  async getSnapshot(snapshotId: ID): Promise<BackupSnapshotRecord | null> {
    await this.ensureHydrated();
    const mem = this.memorySnapshots.get(snapshotId);
    if (mem) return mem;
    if (this.db && this.db.objectStoreNames.contains('backupSnapshots')) {
      return new Promise((resolve) => {
        try {
          const tx = this.db!.transaction('backupSnapshots', 'readonly');
          const store = tx.objectStore('backupSnapshots');
          const req = store.get(snapshotId);
          req.onsuccess = () => {
            if (req.result) {
              const res = req.result as BackupSnapshotRecord;
              this.memorySnapshots.set(snapshotId, res);
              resolve(res);
            } else {
              resolve(null);
            }
          };
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }
    return null;
  }

  async listSnapshots(): Promise<BackupSnapshotRecord[]> {
    await this.ensureHydrated();
    let list: BackupSnapshotRecord[] = [];
    if (this.memorySnapshots.size > 0 || !this.db) {
      list = Array.from(this.memorySnapshots.values());
    } else if (this.db && this.db.objectStoreNames.contains('backupSnapshots')) {
      list = await new Promise((resolve) => {
        try {
          const tx = this.db!.transaction('backupSnapshots', 'readonly');
          const store = tx.objectStore('backupSnapshots');
          const req = store.getAll();
          req.onsuccess = () => {
            const result = (req.result || []) as BackupSnapshotRecord[];
            for (const item of result) {
              this.memorySnapshots.set(item.snapshotId, item);
            }
            resolve(result);
          };
          req.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      });
    }

    return list.sort((a, b) => {
      const timeA = new Date(a.createdAt || 0).getTime();
      const timeB = new Date(b.createdAt || 0).getTime();
      if (timeB !== timeA) return timeB - timeA;
      return String(a?.snapshotId || '').localeCompare(String(b?.snapshotId || ''));
    });
  }

  async deleteSnapshot(snapshotId: ID): Promise<boolean> {
    const existed = this.memorySnapshots.delete(snapshotId);
    let idbExisted = false;
    if (this.db && this.db.objectStoreNames.contains('backupSnapshots')) {
      idbExisted = await new Promise((resolve) => {
        try {
          const tx = this.db!.transaction('backupSnapshots', 'readwrite');
          const store = tx.objectStore('backupSnapshots');
          store.delete(snapshotId);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch {
          resolve(false);
        }
      });
    }
    return existed || idbExisted;
  }

  /**
   * Records that a device type was intentionally hard deleted by the user.
   * Preserved in kvStore across Local Reset and hydration cycles so default devices are never resurrected.
   */
  async recordIntentionalDeviceTypeDeletion(id: ID): Promise<void> {
    await this.set('deletedDeviceTypeMarkers', id, { id, deletedAt: new Date().toISOString() });
  }

  async recordIntentionalDeviceTypeDeletionWithTx(tx: IDBTransaction, id: ID): Promise<void> {
    await this.setWithTx(tx, 'deletedDeviceTypeMarkers', id, { id, deletedAt: new Date().toISOString() });
  }

  async listIntentionalDeviceTypeDeletions(): Promise<{ id: string; deletedAt: string }[]> {
    return this.list<{ id: string; deletedAt: string }>('deletedDeviceTypeMarkers');
  }

  async isDeviceTypeIntentionallyDeleted(id: ID): Promise<boolean> {
    const marker = await this.get<{ id: string; deletedAt: string }>('deletedDeviceTypeMarkers', id);
    return Boolean(marker && marker.id);
  }

  async clear(options?: { preserveSnapshots?: boolean }): Promise<void> {
    this.memoryFallback.clear();
    this.memoryOutbox.clear();
    this.memorySyncState.clear();
    this.memorySyncHistory.clear();
    this.memoryMutationSnapshots.clear();
    this.memoryOverlays.clear();
    if (!options?.preserveSnapshots) {
      this.memorySnapshots.clear();
    }
    if (this.db) {
      try {
        const storeNames = ['kvStore', 'outbox', 'syncState', 'syncHistory', 'mutationSnapshots', 'optimisticOverlays'].filter((s) =>
          this.db!.objectStoreNames.contains(s)
        );
        if (!options?.preserveSnapshots && this.db!.objectStoreNames.contains('backupSnapshots')) {
          storeNames.push('backupSnapshots');
        }
        if (storeNames.length > 0) {
          return new Promise<void>((resolve, reject) => {
            const tx = this.db!.transaction(storeNames, 'readwrite');
            for (const storeName of storeNames) {
              tx.objectStore(storeName).clear();
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(new Error('Transaction aborted'));
          });
        }
      } catch (err) {
        console.warn('Failed to clear IndexedDB stores:', err);
      }
    }
  }


  async removeMutationSnapshot(commandId: ID): Promise<void> {
    await this.ensureHydrated();
    this.memoryMutationSnapshots.delete(commandId);
    if (this.db && this.db.objectStoreNames.contains('mutationSnapshots')) {
      try {
        const tx = this.db.transaction('mutationSnapshots', 'readwrite');
        tx.objectStore('mutationSnapshots').delete(commandId);
      } catch (err) {
        console.warn('Failed to remove mutation snapshot:', err);
      }
    }
  }

  async hasActiveMutationForEntity(mutationKey: string): Promise<boolean> {
    await this.ensureHydrated();
    for (const snap of this.memoryMutationSnapshots.values()) {
      if (snap.mutationKey === mutationKey) return true;
    }
    return false;
  }

  async atomicRollback(commandId: ID): Promise<boolean> {
    await this.ensureHydrated();
    const snapshot = await this.getMutationSnapshot(commandId);
    if (!snapshot) return false;

    if (this.db && this.db.objectStoreNames.contains('kvStore') && this.db.objectStoreNames.contains('mutationSnapshots')) {
      return new Promise<boolean>((resolve) => {
        try {
          const tx = this.db!.transaction(['kvStore', 'mutationSnapshots'], 'readwrite');
          const kvStore = tx.objectStore('kvStore');
          const snapStore = tx.objectStore('mutationSnapshots');

          for (const item of (snapshot.items || [])) {
            const kvKey = `${item.table}:${item.id}`;
            if (item.existed && item.previousRecord) {
              kvStore.put({ key: kvKey, table: item.table, id: item.id, item: item.previousRecord }, kvKey);
            } else if (!item.existed) {
              kvStore.delete(kvKey);
            }
          }
          snapStore.delete(commandId);

          tx.oncomplete = () => {
            for (const item of (snapshot.items || [])) {
              const tableMap = this.getMemoryTable(item.table);
              if (item.existed && item.previousRecord) {
                tableMap.set(item.id, item.previousRecord);
              } else if (!item.existed) {
                tableMap.delete(item.id);
              }
            }
            this.memoryMutationSnapshots.delete(commandId);
            resolve(true);
          };
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        } catch {
          resolve(false);
        }
      });
    } else {
      // Memory fallback atomic execution
      try {
        for (const item of (snapshot.items || [])) {
          const tableMap = this.getMemoryTable(item.table);
          if (item.existed && item.previousRecord) {
            tableMap.set(item.id, item.previousRecord);
          } else if (!item.existed) {
            tableMap.delete(item.id);
          }
        }
        this.memoryMutationSnapshots.delete(commandId);
        return true;
      } catch (err) {
        console.warn('Atomic rollback failed:', err);
        return false;
      }
    }
  }

  async saveOverlay(record: OptimisticOverlayRecord): Promise<void> {
    await this.ensureHydrated();
    this.memoryOverlays.set(record.commandId, record);
    this.overlaySequence = Math.max(this.overlaySequence, Number(record.sequence) || 0);
    if (this.db && this.db.objectStoreNames.contains('optimisticOverlays')) {
      try {
        const tx = this.db.transaction('optimisticOverlays', 'readwrite');
        const store = tx.objectStore('optimisticOverlays');
        store.put(record);
      } catch (err) {
        console.warn('Failed to persist optimistic overlay to IndexedDB:', err);
      }
    }
  }

  saveOverlayWithTx(tx: IDBTransaction, record: OptimisticOverlayRecord): void {
    this.memoryOverlays.set(record.commandId, record);
    this.overlaySequence = Math.max(this.overlaySequence, Number(record.sequence) || 0);
    if (tx?.objectStore) {
      try {
        tx.objectStore('optimisticOverlays').put(record);
      } catch (err) {
        console.warn('Failed to persist optimistic overlay in transaction:', err);
        throw err;
      }
    }
  }

  async getOverlay(commandId: ID): Promise<OptimisticOverlayRecord | null> {
    await this.ensureHydrated();
    const mem = this.memoryOverlays.get(commandId);
    if (mem) return mem;
    if (this.db && this.db.objectStoreNames.contains('optimisticOverlays')) {
      return new Promise((resolve) => {
        try {
          const tx = this.db!.transaction('optimisticOverlays', 'readonly');
          const store = tx.objectStore('optimisticOverlays');
          const req = store.get(commandId);
          req.onsuccess = () => {
            if (req.result) {
              this.memoryOverlays.set(commandId, req.result);
              this.overlaySequence = Math.max(this.overlaySequence, Number((req.result as OptimisticOverlayRecord).sequence) || 0);
              resolve(req.result as OptimisticOverlayRecord);
            } else {
              resolve(null);
            }
          };
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }
    return null;
  }

  async listOverlays(): Promise<OptimisticOverlayRecord[]> {
    await this.ensureHydrated();
    return Array.from(this.memoryOverlays.values());
  }

  listOverlaysSync(): OptimisticOverlayRecord[] {
    return Array.from(this.memoryOverlays.values());
  }

  async getNextSequence(): Promise<number> {
    await this.ensureHydrated();
    this.overlaySequence += 1;
    return this.overlaySequence;
  }

  removeOverlaysForCommandWithTx(tx: IDBTransaction | null, commandId: ID): void {
    const idsToRemove: ID[] = [];
    for (const id of this.memoryOverlays.keys()) {
      if (id === commandId || id.startsWith(`${commandId}:`)) {
        idsToRemove.push(id);
      }
    }
    for (const id of idsToRemove) {
      this.memoryOverlays.delete(id);
    }

    if (tx && tx.db.objectStoreNames.contains('optimisticOverlays')) {
      try {
        const store = tx.objectStore('optimisticOverlays');
        for (const id of idsToRemove) {
          store.delete(id);
        }
      } catch (err) {
        console.warn('Failed to remove optimistic overlays in TX:', err);
      }
    }
  }

  async removeOverlaysForCommand(commandId: ID): Promise<void> {
    await this.ensureHydrated();
    const idsToRemove: ID[] = [];
    for (const id of this.memoryOverlays.keys()) {
      if (id === commandId || id.startsWith(`${commandId}:`)) {
        idsToRemove.push(id);
      }
    }
    for (const id of idsToRemove) {
      this.memoryOverlays.delete(id);
    }

    if (this.db && this.db.objectStoreNames.contains('optimisticOverlays')) {
      try {
        const tx = this.db.transaction('optimisticOverlays', 'readwrite');
        const store = tx.objectStore('optimisticOverlays');
        for (const id of idsToRemove) {
          store.delete(id);
        }
      } catch (err) {
        console.warn('Failed to remove optimistic overlays from IndexedDB:', err);
      }
    }
  }

  async removeOverlay(commandId: ID): Promise<void> {
    await this.removeOverlaysForCommand(commandId);
  }

  async getEffectiveState(entityType: string, entityId: ID): Promise<any | null> {
    await this.ensureHydrated();
    const base = await this.get(entityType, entityId);
    const allOverlays = await this.listOverlays();
    const activeOverlays = allOverlays
      .filter(o => o.entityType === entityType && o.entityId === entityId && o.status === 'PENDING')
      .sort((a, b) => {
        if (a.sequence !== b.sequence) return a.sequence - b.sequence;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });

    if (!base && activeOverlays.length === 0) return null;

    let effective: any = base ? JSON.parse(JSON.stringify(base)) : null;

    for (const overlay of activeOverlays) {
      if (overlay.operation === 'DELETE') {
        return null;
      }
      if (overlay.operation === 'CREATE') {
        effective = { id: entityId, ...(overlay.entityPayload || overlay.patch || {}) };
      } else if (overlay.operation === 'PATCH') {
        if (!effective) {
          effective = { id: entityId, ...(overlay.patch || {}) };
        } else {
          effective = { ...effective, ...(overlay.patch || {}) };
        }
      }
    }
    return effective;
  }
}

export const localDb = new IndexedDBLocalDatabase();
