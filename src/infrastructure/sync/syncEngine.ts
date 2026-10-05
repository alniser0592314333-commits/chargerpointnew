/**
 * Offline Sync Engine, Outbox Queue, Retry Policy, and Sync Transport
 */

import { ID } from '../../types/common';
import { localDb, OutboxRecord, SyncHistoryRecord } from '../localDb/localDb';
import {
  OutboxScheduler,
  extractCommandDependencies,
  detectCycles,
  sortReadyCommands,
  SchedulerResult,
} from './outboxScheduler';

export * from './outboxScheduler';

export type SyncErrorClass =
  | 'NETWORK'
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'DATABASE_CONSTRAINT'
  | 'SERVER'
  | 'RPC'
  | 'UNKNOWN';

export type FailureStage =
  | 'LOCAL'
  | 'OUTBOX'
  | 'TRANSPORT'
  | 'RPC'
  | 'REMOTE_EXECUTION'
  | 'APPLY_REMOTE_CHANGE';

export interface StructuredErrorClassification {
  errorClass: SyncErrorClass;
  failureStage: FailureStage;
  retryEligible: boolean;
  httpStatus?: number;
  postgresSqlstate?: string;
  constraintName?: string;
  errorDetails?: string;
  errorHint?: string;
}

export function isRetryEligible(errorClass?: SyncErrorClass): boolean {
  switch (errorClass) {
    case 'NETWORK':
    case 'SERVER':
    case 'RPC':
      return true;
    case 'AUTHENTICATION':
    case 'AUTHORIZATION':
    case 'VALIDATION':
    case 'CONFLICT':
    case 'DATABASE_CONSTRAINT':
    case 'UNKNOWN':
    default:
      return false;
  }
}

export function classifySyncError(response: Partial<SyncCommandResponse>): StructuredErrorClassification {
  if (response.errorClass) {
    const errorClass = response.errorClass;
    const failureStage = response.failureStage || (errorClass === 'DATABASE_CONSTRAINT' ? 'REMOTE_EXECUTION' : 'RPC');
    return {
      errorClass,
      failureStage,
      retryEligible: isRetryEligible(errorClass),
      httpStatus: response.httpStatus,
      postgresSqlstate: response.postgresSqlstate,
      constraintName: response.constraintName,
      errorDetails: response.errorDetails,
      errorHint: response.errorHint,
    };
  }

  const code = response.code;
  const sqlstate = response.postgresSqlstate;
  const status = response.httpStatus;
  const err = (response.error || '').toLowerCase();

  // 1. PostgreSQL SQLSTATE classification
  if (sqlstate) {
    if (sqlstate.startsWith('23')) {
      return {
        errorClass: 'DATABASE_CONSTRAINT',
        failureStage: 'REMOTE_EXECUTION',
        retryEligible: false,
        httpStatus: status,
        postgresSqlstate: sqlstate,
        constraintName: response.constraintName,
        errorDetails: response.errorDetails,
        errorHint: response.errorHint,
      };
    }
    if (sqlstate.startsWith('08') || sqlstate === '57P01') {
      return {
        errorClass: 'NETWORK',
        failureStage: 'TRANSPORT',
        retryEligible: true,
        httpStatus: status,
        postgresSqlstate: sqlstate,
      };
    }
  }

  // 2. Structured Code classification
  if (code === 'DATABASE_CONSTRAINT') {
    return {
      errorClass: 'DATABASE_CONSTRAINT',
      failureStage: 'REMOTE_EXECUTION',
      retryEligible: false,
      httpStatus: status,
      postgresSqlstate: sqlstate,
      constraintName: response.constraintName,
    };
  }

  if (code === 'VALIDATION_ERROR' || code === 'INVALID_PAYLOAD') {
    return {
      errorClass: 'VALIDATION',
      failureStage: 'RPC',
      retryEligible: false,
      httpStatus: status,
    };
  }

  if (code === 'AUTH_REQUIRED' || code === 'AUTH_TOKEN_MISSING' || status === 401) {
    return {
      errorClass: 'AUTHENTICATION',
      failureStage: 'RPC',
      retryEligible: false,
      httpStatus: status || 401,
    };
  }

  if (code === 'FORBIDDEN' || status === 403) {
    return {
      errorClass: 'AUTHORIZATION',
      failureStage: 'RPC',
      retryEligible: false,
      httpStatus: status || 403,
    };
  }

  if (code === 'IDEMPOTENCY_CONFLICT' || code === 'VERSION_CONFLICT' || status === 409) {
    return {
      errorClass: 'CONFLICT',
      failureStage: 'RPC',
      retryEligible: false,
      httpStatus: status || 409,
    };
  }

  if (status && status >= 500 && status < 600) {
    return {
      errorClass: 'SERVER',
      failureStage: 'RPC',
      retryEligible: true,
      httpStatus: status,
    };
  }

  // 3. Fallback text parsing
  if (err.includes('constraint') || err.includes('foreign key') || err.includes('unique constraint') || err.includes('23503') || err.includes('23505')) {
    return {
      errorClass: 'DATABASE_CONSTRAINT',
      failureStage: 'REMOTE_EXECUTION',
      retryEligible: false,
      httpStatus: status,
      postgresSqlstate: sqlstate,
      constraintName: response.constraintName,
    };
  }

  if (err.includes('validation') || err.includes('invalid') || err.includes('malformed')) {
    return {
      errorClass: 'VALIDATION',
      failureStage: 'RPC',
      retryEligible: false,
      httpStatus: status,
    };
  }

  if (err.includes('forbidden') || err.includes('lacks required permission') || err.includes('account is inactive') || err.includes('not a registered admin')) {
    return {
      errorClass: 'AUTHORIZATION',
      failureStage: 'RPC',
      retryEligible: false,
      httpStatus: status || 403,
    };
  }

  if (err.includes('auth_token_missing') || err.includes('unauthorized') || err.includes('authentication required') || err.includes('jwt')) {
    return {
      errorClass: 'AUTHENTICATION',
      failureStage: 'RPC',
      retryEligible: false,
      httpStatus: status || 401,
    };
  }

  if (err.includes('network') || err.includes('failed to fetch') || err.includes('timeout') || err.includes('econnrefused')) {
    return {
      errorClass: 'NETWORK',
      failureStage: 'TRANSPORT',
      retryEligible: true,
      httpStatus: status,
    };
  }

  return {
    errorClass: 'UNKNOWN',
    failureStage: 'RPC',
    retryEligible: false,
    httpStatus: status,
  };
}

export interface SyncCommandRequest {
  commandId: ID;
  commandType: string;
  payload: unknown;
  expectedVersion?: number;
  deviceId: ID;
  actorAdminId: ID;
  resetGeneration?: number;
}

export function containsNonUuidIdentity(payload: any): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const fieldsToCheck = ['orderItemId', 'deviceTypeId', 'itemId'];
  for (const field of fieldsToCheck) {
    if (payload[field] && typeof payload[field] === 'string') {
      const val = payload[field];
      if (val.startsWith('dev-') || val.startsWith('cust-')) {
        return true;
      }
    }
  }
  return false;
}

export function isAuthOrNetworkError(error?: string): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes('auth_token_missing') ||
    lower.includes('unauthorized') ||
    lower.includes('unauthorized_anonymous') ||
    lower.includes('authentication required') ||
    lower.includes('forbidden') ||
    lower.includes('jwt') ||
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('network') ||
    lower.includes('failed to fetch') ||
    lower.includes('timeout')
  );
}

export interface SyncCommandResponse {
  success: boolean;
  error?: string;
  code?: string;
  serverVersion?: number;
  errorClass?: SyncErrorClass;
  failureStage?: FailureStage;
  rpcReached?: boolean;
  httpStatus?: number;
  postgresSqlstate?: string;
  constraintName?: string;
  errorDetails?: string;
  errorHint?: string;
}

export interface ChangeLogEntry {
  sequenceId: number;
  entityType: string;
  entityId: ID;
  action: 'INSERT' | 'UPDATE' | 'DELETE' | 'TOMBSTONE';
  payload: unknown;
  changedAt: string;
}

export interface SyncPullResponse {
  changes: ChangeLogEntry[];
  latestSequence: number;
  serverResetGeneration?: number;
}

export type SyncEvent =
  | { type: 'sync_started'; timestamp: string }
  | { type: 'command_attempt_started'; commandId: ID; attemptCount: number; groupId?: string; timestamp: string }
  | { type: 'command_status_changed'; commandId: ID; groupId?: string; newState: string; error?: string; timestamp: string }
  | { type: 'rpc_started'; commandId: ID; groupId?: string; timestamp: string }
  | { type: 'rpc_finished'; commandId: ID; groupId?: string; success: boolean; rpcReached: 'YES' | 'NO' | 'UNKNOWN'; timestamp: string }
  | { type: 'command_failed'; commandId: ID; groupId?: string; error: string; timestamp: string }
  | { type: 'command_blocked'; commandId: ID; dependencies: ID[]; reason?: string; timestamp: string }
  | { type: 'command_unblocked'; commandId: ID; timestamp: string }
  | { type: 'sync_finished'; pushed: number; pulled: number; timestamp: string }
  | { type: 'sync_history_cleared'; timestamp: string };

export class SyncEventEmitter {
  private listeners: ((event: SyncEvent) => void)[] = [];
  subscribe(listener: (event: SyncEvent) => void) {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }
  emit(event: SyncEvent) {
    this.listeners.forEach(l => l(event));
  }
}

export const syncEventEmitter = new SyncEventEmitter();

export interface ServerSyncTransport {
  pushCommand(req: SyncCommandRequest): Promise<SyncCommandResponse>;
  pullChanges(cursor: number, limit?: number): Promise<SyncPullResponse>;
}

export class MockServerSyncTransport implements ServerSyncTransport {
  private changeLog: ChangeLogEntry[] = [];
  private processedCommands = new Map<ID, { payload: unknown; result: SyncCommandResponse }>();
  private currentSequence = 0;

  async pushCommand(req: SyncCommandRequest): Promise<SyncCommandResponse> {
    const existing = this.processedCommands.get(req.commandId);
    if (existing) {
      if (JSON.stringify(existing.payload) !== JSON.stringify(req.payload)) {
        return { success: false, error: 'Idempotency payload conflict', code: 'IDEMPOTENCY_CONFLICT', rpcReached: true };
      }
      return existing.result;
    }

    const result: SyncCommandResponse = { success: true, serverVersion: (req.expectedVersion || 0) + 1, rpcReached: true };
    this.processedCommands.set(req.commandId, { payload: req.payload, result });

    // Append to changelog
    this.currentSequence += 1;
    this.changeLog.push({
      sequenceId: this.currentSequence,
      entityType: req.commandType,
      entityId: req.commandId,
      action: 'INSERT',
      payload: req.payload,
      changedAt: new Date().toISOString(),
    });

    return result;
  }

  async pullChanges(cursor: number, limit?: number): Promise<SyncPullResponse> {
    const maxLimit = limit !== undefined ? Math.min(Math.max(1, limit), 500) : 500;
    const relevant = this.changeLog.filter(c => c.sequenceId > cursor).slice(0, maxLimit);
    return {
      changes: relevant,
      latestSequence: this.currentSequence,
      serverResetGeneration: 1,
    };
  }
}

export class SyncEngine {
  private isSyncing = false;
  public onDeltaApplied?: (change: ChangeLogEntry, tx?: IDBTransaction) => Promise<void> | void;

  constructor(private transport: ServerSyncTransport) {}

  async queueCommand(
    commandId: ID,
    commandType: string,
    aggregateType: string,
    aggregateId: ID,
    payload: unknown,
    deviceId: ID,
    actorAdminId: ID,
    expectedVersion?: number,
    options?: {
      priority?: number;
      dependencyCommandId?: ID;
      dependencyCommandIds?: ID[];
      dependencies?: ID[];
      groupId?: string;
    }
  ): Promise<void> {
    const p = payload as any;
    const dependencyCommandId = options?.dependencyCommandId || p?.dependencyCommandId;
    const dependencyCommandIds = options?.dependencyCommandIds || p?.dependencyCommandIds;
    const dependencies = options?.dependencies || p?.dependencies;
    const priority = options?.priority !== undefined ? options.priority : p?.priority;
    const groupId = options?.groupId || p?.groupId;

    const syncState = await localDb.getSyncState('global');
    console.log('DEBUG: syncState', syncState);
    let currentGen = syncState?.resetGeneration;
    let status: 'pending' | 'PENDING_RECONCILIATION' = 'pending';

    if (syncState?.status === 'RECONCILIATION_REQUIRED' || syncState?.reconciliationRequired || currentGen === undefined) {
      currentGen = -1;
      status = 'PENDING_RECONCILIATION';
    }

    const record: OutboxRecord = {
      commandId,
      commandType,
      aggregateType,
      aggregateId,
      payload: { ...(p || {}), resetGeneration: currentGen },
      expectedVersion,
      createdAt: new Date().toISOString(),
      deviceId,
      actorAdminId,
      status,
      retryCount: 0,
      groupId,
      dependencyCommandId,
      dependencyCommandIds,
      dependencies,
      priority,
      resetGeneration: currentGen,
    };
    await localDb.saveOutbox(record);

    const history: SyncHistoryRecord = {
      historyId: commandId,
      commandId,
      groupId,
      commandType,
      entityType: aggregateType,
      entityId: aggregateId,
      state: 'PENDING',
      createdAt: record.createdAt,
      updatedAt: record.createdAt,
      attemptCount: 0,
      dependencyCommandId,
      dependencyCommandIds,
      dependencies,
      priority,
    };
    await localDb.saveHistory(history);

    syncEventEmitter.emit({
      type: 'command_status_changed',
      commandId,
      groupId,
      newState: 'PENDING',
      timestamp: new Date().toISOString(),
    });
  }

  async resumePendingOutbox(): Promise<number> {
    const outboxItems = await localDb.listOutbox();
    let count = 0;
    for (const item of outboxItems) {
      if (
        item.status === 'syncing' ||
        item.status === 'conflict' ||
        item.status === 'blocked' ||
        (item.status === 'rejected' && isAuthOrNetworkError(item.lastError))
      ) {
        item.status = 'pending';
        await localDb.saveOutbox(item);
        count++;
      }
    }
    return count;
  }

  async synchronize(): Promise<{ pushed: number; pulled: number }> {
    if (this.isSyncing) {
      throw new Error('Sync cycle already in progress');
    }

    this.isSyncing = true;
    syncEventEmitter.emit({ type: 'sync_started', timestamp: new Date().toISOString() });
    let pushedCount = 0;
    let pulledCount = 0;

    try {
      // 0. Preflight Pull & Reset Generation Reconciliation (Must run before pushing outbox commands)
      const syncState = (await localDb.getSyncState('global')) || {
        table: 'global',
        lastAppliedChangeSequence: 0,
        lastPulledAt: '',
        resetGeneration: -1,
        status: 'RECONCILIATION_REQUIRED',
        reconciliationRequired: true,
      };

      let pullRes;
      try {
        pullRes = await this.transport.pullChanges(syncState.lastAppliedChangeSequence);
      } catch (pullTransportErr) {
        console.warn('Transport pull failed during sync preflight:', pullTransportErr);
        // Halt synchronization if we cannot confirm authoritative generation
        syncEventEmitter.emit({ type: 'sync_finished', pushed: 0, pulled: 0, timestamp: new Date().toISOString() });
        this.isSyncing = false;
        return { pushed: 0, pulled: 0 };
      }

      if (pullRes.serverResetGeneration === undefined) {
          console.warn('Authoritative server generation unavailable, halting sync');
          syncEventEmitter.emit({ type: 'sync_finished', pushed: 0, pulled: 0, timestamp: new Date().toISOString() });
          this.isSyncing = false;
          return { pushed: 0, pulled: 0 };
      }

      const serverGen = pullRes.serverResetGeneration;
      const localGen = syncState.resetGeneration !== undefined ? syncState.resetGeneration : -1;
      const wasReconciling = syncState.status === 'RECONCILIATION_REQUIRED' || syncState.reconciliationRequired;

      if (serverGen > localGen || wasReconciling) {
        syncState.resetGeneration = serverGen;
        if (serverGen > localGen) {
          syncState.lastAppliedChangeSequence = 0;
          // REPAIR D: Full operational reconciliation on generation change
          await localDb.clearOperationalData();
        }
        syncState.reconciliationRequired = false;
        syncState.status = 'READY';
        await localDb.setSyncState(syncState);

        // Atomic Promotion of PENDING_RECONCILIATION commands and Quarantine of stale generation commands
        const allOutbox = await localDb.listOutbox();

        // 1. Quarantine any stale generation commands
        const staleCommands = allOutbox.filter(
          item =>
            item.resetGeneration !== undefined &&
            item.resetGeneration >= 0 &&
            item.resetGeneration < serverGen &&
            (item.status === 'pending' ||
              item.status === 'syncing' ||
              item.status === 'blocked' ||
              item.status === 'conflict')
        );

        if (staleCommands.length > 0) {
          await localDb.runTransaction(['outbox', 'syncHistory'], 'readwrite', (tx) => {
            for (const item of staleCommands) {
              item.status = 'rejected';
              item.lastError = 'RESET_GENERATION_MISMATCH';
              localDb.saveOutboxWithTx(tx, item);

              let hist = localDb.getHistorySync(item.commandId);
              if (!hist) {
                hist = {
                  historyId: item.commandId,
                  commandId: item.commandId,
                  groupId: item.groupId,
                  commandType: item.commandType,
                  entityType: item.aggregateType || 'UNKNOWN',
                  entityId: item.aggregateId || item.commandId,
                  state: 'FAILED_PERMANENT',
                  createdAt: item.createdAt || new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  attemptCount: (item.retryCount || 0) + 1,
                  lastAttemptAt: new Date().toISOString(),
                  errorMessage: 'RESET_GENERATION_MISMATCH',
                  retryEligible: false,
                };
              } else {
                hist.state = 'FAILED_PERMANENT';
                hist.errorMessage = 'RESET_GENERATION_MISMATCH';
                hist.retryEligible = false;
                hist.updatedAt = new Date().toISOString();
              }
              localDb.saveHistoryWithTx(tx, hist);
            }
          });
        }

        const pendingPromotions = allOutbox.filter(item => item.status === 'PENDING_RECONCILIATION');
        
        if (pendingPromotions.length > 0) {
            const promotionsToApply: OutboxRecord[] = [];
            
            for (const item of pendingPromotions) {
                let isValid = true;
                const aggregate = await localDb.get(item.aggregateType, item.aggregateId);
                
                if (item.expectedVersion !== undefined && aggregate && (aggregate as any).version !== item.expectedVersion) {
                    isValid = false;
                    item.status = 'conflict';
                    item.lastError = 'Version conflict';
                    await localDb.saveOutbox(item);
                    
                    let hist = await localDb.getHistoryByCommandId(item.commandId);
                    if (hist) {
                        hist.state = 'CONFLICT';
                        hist.errorMessage = 'Version conflict';
                        await localDb.saveHistory(hist);
                    }
                }

                if (isValid) {
                    promotionsToApply.push(item);
                }
            }
            
            if (promotionsToApply.length > 0) {
                await localDb.runTransaction(['outbox', 'syncHistory'], 'readwrite', (tx) => {
                    for (const item of promotionsToApply) {
                        item.status = 'pending';
                        item.resetGeneration = serverGen;
                        item.payload = { ...(item.payload as any), resetGeneration: serverGen };
                        
                        let hist = localDb.getHistorySync(item.commandId);
                        if (hist) {
                            hist.state = 'READY';
                            hist.updatedAt = new Date().toISOString();
                            localDb.saveHistoryWithTx(tx, hist);
                        }
                        
                        localDb.saveOutboxWithTx(tx, item);
                    }
                });
            }
        }
      }

      if (pullRes.changes.length > 0) {
        const sortedChanges = [...pullRes.changes].sort((a, b) => a.sequenceId - b.sequenceId);
        await localDb.runTransaction(['kvStore', 'syncState'], 'readwrite', async (tx) => {
          for (const change of sortedChanges) {
            try {
              if (this.onDeltaApplied) {
                await this.onDeltaApplied(change, tx);
              } else {
                if (change.action === 'DELETE' || change.action === 'TOMBSTONE') {
                  localDb.removeWithTx(tx, change.entityType, change.entityId);
                } else {
                  localDb.setWithTx(tx, change.entityType, change.entityId, change.payload);
                }
              }
              pulledCount++;
            } catch (deltaErr) {
              console.error(`Failed to apply delta change sequence ${change.sequenceId}:`, deltaErr);
              throw deltaErr;
            }
          }
          const maxSeq = sortedChanges[sortedChanges.length - 1].sequenceId;
          const updatedState = {
            ...syncState,
            lastAppliedChangeSequence: maxSeq,
            lastPulledAt: new Date().toISOString(),
          };
          localDb.setSyncStateWithTx(tx, updatedState);
        });
      }

      // 1. Dependency-aware execution of Outbox commands
      const scheduler = new OutboxScheduler();
      const previouslyBlocked = new Set<ID>();
      const processedInCycle = new Set<ID>();

      while (true) {
        const currentSyncState = await localDb.getSyncState('global');
        const activeServerGen = currentSyncState?.resetGeneration !== undefined ? currentSyncState.resetGeneration : -1;

        const rawOutboxItems = await localDb.listOutbox();
        for (const item of rawOutboxItems) {
          if (
            item.status === 'pending' ||
            item.status === 'syncing' ||
            item.status === 'blocked' ||
            item.status === 'conflict'
          ) {
            // Check A: Stale Reset Generation Quarantine
            if (
              activeServerGen >= 0 &&
              item.resetGeneration !== undefined &&
              item.resetGeneration >= 0 &&
              item.resetGeneration !== activeServerGen
            ) {
              item.status = 'rejected';
              item.lastError = 'RESET_GENERATION_MISMATCH';
              await localDb.saveOutbox(item);

              let hist = await localDb.getHistoryByCommandId(item.commandId);
              if (!hist) {
                hist = {
                  historyId: item.commandId,
                  commandId: item.commandId,
                  groupId: item.groupId,
                  commandType: item.commandType,
                  entityType: item.aggregateType || 'UNKNOWN',
                  entityId: item.aggregateId || item.commandId,
                  state: 'FAILED_PERMANENT',
                  createdAt: item.createdAt || new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  attemptCount: (item.retryCount || 0) + 1,
                  lastAttemptAt: new Date().toISOString(),
                  errorMessage: 'RESET_GENERATION_MISMATCH',
                  retryEligible: false,
                };
              } else {
                hist.state = 'FAILED_PERMANENT';
                hist.errorMessage = 'RESET_GENERATION_MISMATCH';
                hist.retryEligible = false;
                hist.updatedAt = new Date().toISOString();
              }
              await localDb.saveHistory(hist);
              continue;
            }

            // Check B: Non-UUID Identity Payload Quarantine
            if (containsNonUuidIdentity(item.payload)) {
              item.status = 'rejected';
              item.lastError = 'INVALID_UUID_IDENTIFIER';
              await localDb.saveOutbox(item);

              let hist = await localDb.getHistoryByCommandId(item.commandId);
              if (!hist) {
                hist = {
                  historyId: item.commandId,
                  commandId: item.commandId,
                  groupId: item.groupId,
                  commandType: item.commandType,
                  entityType: item.aggregateType || 'UNKNOWN',
                  entityId: item.aggregateId || item.commandId,
                  state: 'FAILED_PERMANENT',
                  createdAt: item.createdAt || new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  attemptCount: (item.retryCount || 0) + 1,
                  lastAttemptAt: new Date().toISOString(),
                  errorMessage: 'INVALID_UUID_IDENTIFIER',
                  retryEligible: false,
                };
              } else {
                hist.state = 'FAILED_PERMANENT';
                hist.errorMessage = 'INVALID_UUID_IDENTIFIER';
                hist.retryEligible = false;
                hist.updatedAt = new Date().toISOString();
              }
              await localDb.saveHistory(hist);
              continue;
            }
          }
        }

        const outboxItems = await localDb.listOutbox();
        const candidates = outboxItems.filter(
          i =>
            !processedInCycle.has(i.commandId) &&
            (i.status === 'pending' ||
              i.status === 'blocked' ||
              i.status === 'conflict' ||
              i.status === 'syncing' ||
              (i.status === 'rejected' && isAuthOrNetworkError(i.lastError)))
        );

        if (candidates.length === 0) {
          break;
        }

        const scheduleResult = await scheduler.schedule(
          candidates,
          outboxItems,
          (id) => localDb.getHistoryByCommandId(id)
        );

        // A. Handle cyclic commands
        if (scheduleResult.cyclic.size > 0) {
          for (const cyclicId of scheduleResult.cyclic) {
            const item = outboxItems.find(o => o.commandId === cyclicId);
            if (item && item.status !== 'blocked') {
              item.status = 'blocked';
              item.lastError = 'Circular dependency detected';
              await localDb.saveOutbox(item);

              let hist = await localDb.getHistoryByCommandId(cyclicId);
              if (hist) {
                hist.state = 'BLOCKED';
                hist.errorMessage = 'Circular dependency detected';
                hist.updatedAt = new Date().toISOString();
                await localDb.saveHistory(hist);
              }
              syncEventEmitter.emit({
                type: 'command_blocked',
                commandId: cyclicId,
                dependencies: Array.from(scheduleResult.cyclic),
                reason: 'Circular dependency detected',
                timestamp: new Date().toISOString(),
              });
              syncEventEmitter.emit({
                type: 'command_status_changed',
                commandId: cyclicId,
                newState: 'BLOCKED',
                error: 'Circular dependency detected',
                timestamp: new Date().toISOString(),
              });
            }
          }
        }

        // B. Handle blocked commands
        for (const [blockedId, info] of scheduleResult.blocked) {
          if (scheduleResult.cyclic.has(blockedId)) continue;
          const item = info.record;
          if (item.status !== 'blocked') {
            item.status = 'blocked';
            item.lastError = info.reason;
            await localDb.saveOutbox(item);
          }
          let hist = await localDb.getHistoryByCommandId(blockedId);
          if (hist && hist.state !== 'BLOCKED' && hist.state !== 'WAITING_DEPENDENCY') {
            hist.state = 'BLOCKED';
            hist.errorMessage = info.reason;
            hist.updatedAt = new Date().toISOString();
            await localDb.saveHistory(hist);
          }
          if (!previouslyBlocked.has(blockedId)) {
            previouslyBlocked.add(blockedId);
            syncEventEmitter.emit({
              type: 'command_blocked',
              commandId: blockedId,
              dependencies: info.unsatisfiedDependencies,
              reason: info.reason,
              timestamp: new Date().toISOString(),
            });
            syncEventEmitter.emit({
              type: 'command_status_changed',
              commandId: blockedId,
              groupId: item.groupId,
              newState: 'BLOCKED',
              error: info.reason,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // C. If no ready commands remain, break
        if (scheduleResult.ready.length === 0) {
          break;
        }

        // D. Pick the highest priority ready command
        const item = scheduleResult.ready[0];

        if (previouslyBlocked.has(item.commandId) || item.status === 'blocked') {
          item.status = 'pending';
          await localDb.saveOutbox(item);
          let hist = await localDb.getHistoryByCommandId(item.commandId);
          if (hist) {
            hist.state = 'READY';
            hist.updatedAt = new Date().toISOString();
            await localDb.saveHistory(hist);
          }
          previouslyBlocked.delete(item.commandId);
          syncEventEmitter.emit({
            type: 'command_unblocked',
            commandId: item.commandId,
            timestamp: new Date().toISOString(),
          });
          syncEventEmitter.emit({
            type: 'command_status_changed',
            commandId: item.commandId,
            groupId: item.groupId,
            newState: 'READY',
            timestamp: new Date().toISOString(),
          });
        }

        // E. Dispatch command execution
        processedInCycle.add(item.commandId);

        let history = await localDb.getHistoryByCommandId(item.commandId);
        const now = new Date().toISOString();
        const currentAttempts = history?.attemptCount !== undefined ? history.attemptCount : (item.retryCount || 0);
        const attemptCount = currentAttempts + 1;

        if (!history) {
          history = {
            historyId: item.commandId,
            commandId: item.commandId,
            groupId: item.groupId,
            commandType: item.commandType,
            entityType: item.aggregateType || 'UNKNOWN',
            entityId: item.aggregateId || item.commandId,
            state: 'ATTEMPTING',
            createdAt: item.createdAt || now,
            updatedAt: now,
            attemptCount,
            lastAttemptAt: now,
            dependencyCommandId: item.dependencyCommandId,
            dependencyCommandIds: item.dependencyCommandIds,
            dependencies: item.dependencies,
            priority: item.priority,
          };
        } else {
          history.state = 'ATTEMPTING';
          history.attemptCount = attemptCount;
          history.lastAttemptAt = now;
          history.updatedAt = now;
        }

        await localDb.saveHistory(history);

        syncEventEmitter.emit({
          type: 'command_attempt_started',
          commandId: item.commandId,
          attemptCount: history.attemptCount,
          groupId: item.groupId,
          timestamp: now,
        });

        item.status = 'syncing';
        await localDb.saveOutbox(item);
        syncEventEmitter.emit({
          type: 'command_status_changed',
          commandId: item.commandId,
          groupId: item.groupId,
          newState: 'SYNCING',
          timestamp: now,
        });

        try {
          syncEventEmitter.emit({
            type: 'rpc_started',
            commandId: item.commandId,
            groupId: item.groupId,
            timestamp: new Date().toISOString(),
          });
          const res = await this.transport.pushCommand({
            commandId: item.commandId,
            commandType: item.commandType,
            payload: item.payload,
            expectedVersion: item.expectedVersion,
            deviceId: item.deviceId,
            actorAdminId: item.actorAdminId,
            resetGeneration: item.resetGeneration !== undefined ? item.resetGeneration : -1,
          });

          const rpcReached = res.rpcReached !== undefined ? res.rpcReached : true;
          history.rpcReached = rpcReached;
          history.updatedAt = new Date().toISOString();

          syncEventEmitter.emit({
            type: 'rpc_finished',
            commandId: item.commandId,
            groupId: item.groupId,
            success: res.success,
            rpcReached: rpcReached ? 'YES' : 'NO',
            timestamp: new Date().toISOString(),
          });

          if (res.success) {
            item.status = 'accepted';
            item.lastError = undefined;
            item.serverProcessedAt = new Date().toISOString();
            pushedCount++;

            history.state = 'SUCCESS';
            history.completedAt = new Date().toISOString();
            history.errorClass = undefined;
            history.errorMessage = undefined;
            history.errorDetails = undefined;
            history.errorHint = undefined;
            history.failureStage = undefined;
            history.retryEligible = undefined;
            await localDb.saveHistory(history);

            syncEventEmitter.emit({
              type: 'command_status_changed',
              commandId: item.commandId,
              groupId: item.groupId,
              newState: 'SUCCEEDED',
              timestamp: new Date().toISOString(),
            });
          } else {
            const classification = classifySyncError(res);
            history.state = classification.errorClass === 'CONFLICT' ? 'CONFLICT' : 'FAILED';
            history.failureStage = classification.failureStage;
            history.errorClass = classification.errorClass;
            history.errorMessage = res.error;
            history.errorDetails = classification.errorDetails || res.errorDetails;
            history.errorHint = classification.errorHint || res.errorHint;
            history.httpStatus = classification.httpStatus || res.httpStatus;
            history.postgresSqlstate = classification.postgresSqlstate || res.postgresSqlstate;
            history.constraintName = classification.constraintName || res.constraintName;
            history.retryEligible = classification.retryEligible;
            await localDb.saveHistory(history);

            if (res.code === 'IDEMPOTENCY_CONFLICT') {
              item.status = 'rejected';
            } else if (classification.errorClass === 'CONFLICT' || isAuthOrNetworkError(res.error) || res.code === 'AUTH_REQUIRED') {
              item.status = 'conflict';
            } else if (!classification.retryEligible) {
              item.status = 'rejected';
            } else {
              item.status = 'conflict';
            }
            item.retryCount = history.attemptCount;
            item.lastError = res.error;

            syncEventEmitter.emit({
              type: 'command_failed',
              commandId: item.commandId,
              groupId: item.groupId,
              error: res.error || 'Unknown error',
              timestamp: new Date().toISOString(),
            });
            syncEventEmitter.emit({
              type: 'command_status_changed',
              commandId: item.commandId,
              groupId: item.groupId,
              newState: 'FAILED_RETRYABLE',
              error: res.error,
              timestamp: new Date().toISOString(),
            });
          }
          await localDb.saveOutbox(item);
        } catch (err: any) {
          const errMsg = err?.message || 'Network error';
          history.state = 'FAILED';
          history.rpcReached = false;
          history.failureStage = 'TRANSPORT';
          history.errorClass = 'NETWORK';
          history.retryEligible = true;
          history.errorMessage = errMsg;
          history.updatedAt = new Date().toISOString();
          await localDb.saveHistory(history);

          item.status = 'pending';
          item.retryCount = history.attemptCount;
          item.lastError = errMsg;

          syncEventEmitter.emit({
            type: 'rpc_finished',
            commandId: item.commandId,
            groupId: item.groupId,
            success: false,
            rpcReached: 'NO',
            timestamp: new Date().toISOString(),
          });
          syncEventEmitter.emit({
            type: 'command_failed',
            commandId: item.commandId,
            groupId: item.groupId,
            error: errMsg,
            timestamp: new Date().toISOString(),
          });
          await localDb.saveOutbox(item);
        }
      }

      syncEventEmitter.emit({ type: 'sync_finished', pushed: pushedCount, pulled: pulledCount, timestamp: new Date().toISOString() });
      return { pushed: pushedCount, pulled: pulledCount };
    } finally {
      this.isSyncing = false;
    }
  }
}
