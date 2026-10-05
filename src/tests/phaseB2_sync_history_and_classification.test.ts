import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { initializeCanonicalSyncState } from './utils/testSetup';
import {
  SyncEngine,
  ServerSyncTransport,
  SyncCommandRequest,
  SyncCommandResponse,
  SyncPullResponse,
} from '../infrastructure/sync/syncEngine';

describe('Phase B.2: Real Sync History Lifecycle + Structured Error Classification', () => {
  beforeEach(async () => {
    await localDb.clear();
    await initializeCanonicalSyncState();
  });

  // TEST 1 — SUCCESS HISTORY
  it('TEST 1 — SUCCESS HISTORY: processes successful command and populates all lifecycle fields', async () => {
    const transport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        return { success: true, serverVersion: 1, rpcReached: true };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({
        changes: [],
        latestSequence: cursor,
        serverResetGeneration: 1,
      }),
    };

    const engine = new SyncEngine(transport);
    const cmdId = 'cmd_success_001';

    await engine.queueCommand(cmdId, 'CREATE_ORDER', 'orders', 'ord_1', { total: 100 }, 'dev_1', 'admin_1');

    // Run synchronization
    const result = await engine.synchronize();
    expect(result.pushed).toBe(1);

    // Verify SyncHistory in localDb
    const history = await localDb.getHistoryByCommandId(cmdId);
    expect(history).not.toBeNull();
    expect(history?.commandId).toBe(cmdId);
    expect(history?.commandType).toBe('CREATE_ORDER');
    expect(history?.state).toBe('SUCCESS');
    expect(history?.attemptCount).toBe(1);
    expect(history?.rpcReached).toBe(true);
    expect(history?.completedAt).toBeDefined();
    expect(history?.lastAttemptAt).toBeDefined();
    expect(history?.createdAt).toBeDefined();
    expect(history?.updatedAt).toBeDefined();
    expect(history?.errorClass).toBeUndefined();
  });

  // TEST 2 — NETWORK FAILURE BEFORE RPC
  it('TEST 2 — NETWORK FAILURE BEFORE RPC: captures transport failure with rpcReached = false', async () => {
    const transport: ServerSyncTransport = {
      pushCommand: async (): Promise<SyncCommandResponse> => {
        throw new Error('Failed to fetch: connection refused');
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({
        changes: [],
        latestSequence: cursor,
        serverResetGeneration: 1,
      }),
    };

    const engine = new SyncEngine(transport);
    const cmdId = 'cmd_net_fail_002';

    await engine.queueCommand(cmdId, 'CREATE_CUSTOMER', 'customers', 'cust_1', { name: 'Ali' }, 'dev_1', 'admin_1');

    await engine.synchronize();

    const history = await localDb.getHistoryByCommandId(cmdId);
    expect(history).not.toBeNull();
    expect(history?.commandId).toBe(cmdId);
    expect(history?.state).toBe('FAILED');
    expect(history?.failureStage).toBe('TRANSPORT');
    expect(history?.errorClass).toBe('NETWORK');
    expect(history?.rpcReached).toBe(false);
    expect(history?.retryEligible).toBe(true);
    expect(history?.attemptCount).toBe(1);
    expect(history?.errorMessage).toContain('Failed to fetch');
  });

  // TEST 3 — RPC FAILURE
  it('TEST 3 — RPC FAILURE: captures remote RPC response failure with rpcReached = true', async () => {
    const transport: ServerSyncTransport = {
      pushCommand: async (): Promise<SyncCommandResponse> => {
        return {
          success: false,
          error: 'Bad Gateway: remote server returned 502',
          httpStatus: 502,
          rpcReached: true,
        };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({
        changes: [],
        latestSequence: cursor,
        serverResetGeneration: 1,
      }),
    };

    const engine = new SyncEngine(transport);
    const cmdId = 'cmd_rpc_fail_003';

    await engine.queueCommand(cmdId, 'OPEN_DAY', 'business_days', 'day_1', {}, 'dev_1', 'admin_1');

    await engine.synchronize();

    const history = await localDb.getHistoryByCommandId(cmdId);
    expect(history).not.toBeNull();
    expect(history?.commandId).toBe(cmdId);
    expect(history?.state).toBe('FAILED');
    expect(history?.rpcReached).toBe(true);
    expect(history?.failureStage).toBe('RPC');
    expect(history?.errorClass).toBe('SERVER');
    expect(history?.httpStatus).toBe(502);
    expect(history?.retryEligible).toBe(true);
  });

  // TEST 4 — DATABASE CONSTRAINT
  it('TEST 4 — DATABASE CONSTRAINT: preserves SQLSTATE, constraintName and marks retryEligible = false', async () => {
    const transport: ServerSyncTransport = {
      pushCommand: async (): Promise<SyncCommandResponse> => {
        return {
          success: false,
          error: 'duplicate key value violates unique constraint "customers_phone_key"',
          postgresSqlstate: '23505',
          constraintName: 'customers_phone_key',
          errorDetails: 'Key (phone)=(0590001122) already exists.',
          httpStatus: 400,
          rpcReached: true,
        };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({
        changes: [],
        latestSequence: cursor,
        serverResetGeneration: 1,
      }),
    };

    const engine = new SyncEngine(transport);
    const cmdId = 'cmd_constraint_004';

    await engine.queueCommand(cmdId, 'CREATE_CUSTOMER', 'customers', 'cust_1', {}, 'dev_1', 'admin_1');

    await engine.synchronize();

    const history = await localDb.getHistoryByCommandId(cmdId);
    expect(history).not.toBeNull();
    expect(history?.errorClass).toBe('DATABASE_CONSTRAINT');
    expect(history?.failureStage).toBe('REMOTE_EXECUTION');
    expect(history?.postgresSqlstate).toBe('23505');
    expect(history?.constraintName).toBe('customers_phone_key');
    expect(history?.errorDetails).toContain('Key (phone)=(0590001122) already exists');
    expect(history?.retryEligible).toBe(false);
    expect(history?.rpcReached).toBe(true);
  });

  // TEST 5 — VALIDATION FAILURE
  it('TEST 5 — VALIDATION FAILURE: verifies validation failure is classified separately from NETWORK', async () => {
    const transport: ServerSyncTransport = {
      pushCommand: async (): Promise<SyncCommandResponse> => {
        return {
          success: false,
          error: 'Validation failed: phone number is malformed',
          code: 'VALIDATION_ERROR',
          rpcReached: true,
          httpStatus: 422,
        };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({
        changes: [],
        latestSequence: cursor,
        serverResetGeneration: 1,
      }),
    };

    const engine = new SyncEngine(transport);
    const cmdId = 'cmd_val_fail_005';

    await engine.queueCommand(cmdId, 'CREATE_CUSTOMER', 'customers', 'cust_1', {}, 'dev_1', 'admin_1');

    await engine.synchronize();

    const history = await localDb.getHistoryByCommandId(cmdId);
    expect(history).not.toBeNull();
    expect(history?.errorClass).toBe('VALIDATION');
    expect(history?.errorClass).not.toBe('NETWORK');
    expect(history?.retryEligible).toBe(false);
    expect(history?.rpcReached).toBe(true);
    expect(history?.failureStage).toBe('RPC');
  });

  // TEST 6 — RETRY ATTEMPT COUNT
  it('TEST 6 — RETRY ATTEMPT COUNT: preserves attemptCount across retries and upon final success', async () => {
    let attempt = 0;
    const transport: ServerSyncTransport = {
      pushCommand: async (): Promise<SyncCommandResponse> => {
        attempt++;
        if (attempt === 1) {
          throw new Error('Temporary gateway timeout');
        }
        return { success: true, serverVersion: 2, rpcReached: true };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({
        changes: [],
        latestSequence: cursor,
        serverResetGeneration: 1,
      }),
    };

    const engine = new SyncEngine(transport);
    const cmdId = 'cmd_retry_006';

    await engine.queueCommand(cmdId, 'ADD_ORDER_ITEM', 'order_items', 'it_1', {}, 'dev_1', 'admin_1');

    // Attempt 1: Fails
    await engine.synchronize();
    const historyAttempt1 = await localDb.getHistoryByCommandId(cmdId);
    expect(historyAttempt1?.attemptCount).toBe(1);
    expect(historyAttempt1?.state).toBe('FAILED');
    expect(historyAttempt1?.completedAt).toBeUndefined();

    // Re-queue pending outbox so attempt 2 runs
    const outbox = await localDb.getOutbox(cmdId);
    expect(outbox?.status).toBe('pending');

    // Attempt 2: Succeeds
    await engine.synchronize();
    const historyAttempt2 = await localDb.getHistoryByCommandId(cmdId);
    expect(historyAttempt2?.attemptCount).toBe(2);
    expect(historyAttempt2?.state).toBe('SUCCESS');
    expect(historyAttempt2?.completedAt).toBeDefined();
    expect(historyAttempt2?.rpcReached).toBe(true);
  });

  // TEST 7 — SEPARATE COMMANDS
  it('TEST 7 — SEPARATE COMMANDS: maintains isolated history records for different commands', async () => {
    const transport: ServerSyncTransport = {
      pushCommand: async (req: SyncCommandRequest): Promise<SyncCommandResponse> => {
        if (req.commandId === 'cmd_A') {
          return { success: true, serverVersion: 1, rpcReached: true };
        }
        return { success: false, error: 'Unauthorized', code: 'AUTH_REQUIRED', rpcReached: true };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({
        changes: [],
        latestSequence: cursor,
        serverResetGeneration: 1,
      }),
    };

    const engine = new SyncEngine(transport);
    await engine.queueCommand('cmd_A', 'CREATE_ORDER', 'orders', 'ord_A', {}, 'dev_1', 'admin_1');
    await engine.queueCommand('cmd_B', 'CREATE_ORDER', 'orders', 'ord_B', {}, 'dev_1', 'admin_1');

    await engine.synchronize();

    const historyA = await localDb.getHistoryByCommandId('cmd_A');
    const historyB = await localDb.getHistoryByCommandId('cmd_B');

    expect(historyA).not.toBeNull();
    expect(historyB).not.toBeNull();
    expect(historyA?.commandId).toBe('cmd_A');
    expect(historyB?.commandId).toBe('cmd_B');
    expect(historyA?.state).toBe('SUCCESS');
    expect(historyB?.state).toBe('FAILED');
    expect(historyB?.errorClass).toBe('AUTHENTICATION');
  });

  // TEST 8 — NO INVENTED DIAGNOSTICS
  it('TEST 8 — NO INVENTED DIAGNOSTICS: keeps missing fields undefined when structured details unavailable', async () => {
    const transport: ServerSyncTransport = {
      pushCommand: async (): Promise<SyncCommandResponse> => {
        // Plain generic failure with no SQLSTATE, constraint, or HTTP status
        return {
          success: false,
          error: 'Some unclassified remote failure',
          rpcReached: true,
        };
      },
      pullChanges: async (cursor: number): Promise<SyncPullResponse> => ({
        changes: [],
        latestSequence: cursor,
        serverResetGeneration: 1,
      }),
    };

    const engine = new SyncEngine(transport);
    const cmdId = 'cmd_plain_008';

    await engine.queueCommand(cmdId, 'CREATE_ORDER', 'orders', 'ord_8', {}, 'dev_1', 'admin_1');

    await engine.synchronize();

    const history = await localDb.getHistoryByCommandId(cmdId);
    expect(history).not.toBeNull();
    expect(history?.httpStatus).toBeUndefined();
    expect(history?.postgresSqlstate).toBeUndefined();
    expect(history?.constraintName).toBeUndefined();
    expect(history?.errorDetails).toBeUndefined();
    expect(history?.errorHint).toBeUndefined();
    expect(history?.rpcReached).toBe(true);
    expect(history?.errorClass).toBe('UNKNOWN');
  });
});
