/**
 * Canonical Supabase Sync Transport Adapter (Phase 1 Baseline)
 * Client-side safe, no service_role key, zero unsafe parent pre-upserts, strict egress bounds.
 */

import { ServerSyncTransport, SyncCommandRequest, SyncCommandResponse, SyncPullResponse, ChangeLogEntry } from './syncEngine';
import { invokeSupabaseRestGet, invokeSupabaseRpc, resolveAuthBearerToken } from '../../services/supabase/client';

/**
 * Computes a deterministic string hash of a payload for idempotency verification
 */
export function computePayloadHash(payload: unknown): string {
  try {
    const str = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  } catch {
    return 'fallback_hash';
  }
}

export const SYNC_PULL_BATCH_SIZE = 500;

export class SupabaseSyncTransport implements ServerSyncTransport {
  constructor(private supabaseClientUrl?: string, private supabaseAnonKey?: string) {}

  async pushCommand(req: SyncCommandRequest): Promise<SyncCommandResponse> {
    try {
      const token = resolveAuthBearerToken();
      const p = (req.payload || {}) as Record<string, any>;
      const payloadHash = computePayloadHash(p);

      // 1. Primary Canonical Path: Server-Authoritative Semantic RPC
      // Note: NO pre-upserts. Missing server entities are properly caught by relational constraints.
      const { data: rpcData, error: rpcError } = await invokeSupabaseRpc<any>('execute_sync_command', {
        p_command_id: req.commandId,
        p_command_type: req.commandType,
        p_aggregate_type: null,
        p_aggregate_id: null,
        p_payload: { ...p, payloadHash, resetGeneration: req.resetGeneration !== undefined ? req.resetGeneration : null },
        p_expected_version: req.expectedVersion ?? null,
      });

      if (!rpcError && rpcData) {
        // The RPC response is part of the server contract. HTTP/RPC reachability
        // alone is never success: a structured { success: false } response must
        // remain a failed command so the outbox can surface the real reason.
        const response = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as any;
        if (response?.success !== true) {
          return {
            success: false,
            error: response?.error || response?.message || 'Server rejected sync command',
            code: response?.code,
            errorClass: response?.errorClass,
            failureStage: response?.failureStage || 'REMOTE_EXECUTION',
            rpcReached: true,
            serverVersion: response?.serverVersion,
            errorDetails: response?.details || response?.errorDetails,
            errorHint: response?.hint || response?.errorHint,
          };
        }

        return {
          success: true,
          serverVersion: typeof response.serverVersion === 'number'
            ? response.serverVersion
            : (req.expectedVersion !== undefined ? req.expectedVersion + 1 : undefined),
          result: response.result ?? response,
          rpcReached: true,
        };
      }

      if (rpcError) {
        let httpStatus: number | undefined;
        let postgresSqlstate: string | undefined;
        let constraintName: string | undefined;
        let errorDetails: string | undefined;
        let errorHint: string | undefined;

        const statusMatch = rpcError.match(/\[(\d{3})\]/);
        if (statusMatch) {
          httpStatus = parseInt(statusMatch[1], 10);
        }

        const jsonIdx = rpcError.indexOf('{');
        if (jsonIdx !== -1) {
          try {
            const jsonPart = rpcError.substring(jsonIdx);
            const parsed = JSON.parse(jsonPart);
            if (parsed.code) postgresSqlstate = String(parsed.code);
            if (parsed.details) errorDetails = String(parsed.details);
            if (parsed.hint) errorHint = String(parsed.hint);
            if (parsed.message) {
              const cMatch = String(parsed.message).match(/constraint "([^"]+)"/);
              if (cMatch) constraintName = cMatch[1];
            }
          } catch {}
        }

        const isAuthErr =
          rpcError.includes('AUTH_TOKEN_MISSING') ||
          rpcError.includes('UNAUTHORIZED') ||
          rpcError.includes('Forbidden') ||
          rpcError.includes('Unauthorized') ||
          rpcError.includes('Authentication required');

        const isConflict =
          httpStatus === 409 ||
          rpcError.includes('Idempotency Conflict') ||
          rpcError.includes('VERSION_CONFLICT') ||
          postgresSqlstate === '23505';

        const isConstraint =
          postgresSqlstate?.startsWith('23') ||
          rpcError.includes('violates foreign key') ||
          rpcError.includes('is not present in table');

        return {
          success: false,
          error: rpcError,
          code: isAuthErr ? 'AUTH_REQUIRED' : isConflict ? (rpcError.includes('VERSION_CONFLICT') ? 'VERSION_CONFLICT' : 'IDEMPOTENCY_CONFLICT') : isConstraint ? 'DATABASE_CONSTRAINT' : undefined,
          errorClass: isAuthErr ? 'AUTHENTICATION' : isConflict ? 'CONFLICT' : isConstraint ? 'DATABASE_CONSTRAINT' : undefined,
          rpcReached: true,
          httpStatus,
          postgresSqlstate,
          constraintName,
          errorDetails,
          errorHint,
        };
      }

      return {
        success: false,
        error: 'Unknown error during execute_sync_command',
        rpcReached: true,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message || 'Sync push failed',
        rpcReached: false,
        failureStage: 'TRANSPORT',
        errorClass: 'NETWORK',
      };
    }
  }

  /**
   * Monotonic delta change pull with strict pagination limit
   * Minimizes egress and bandwidth consumption
   */
  async pullChanges(cursor: number, limit: number = SYNC_PULL_BATCH_SIZE): Promise<SyncPullResponse> {
    try {
      const batchLimit = Math.min(Math.max(1, limit), SYNC_PULL_BATCH_SIZE);
      const [changesResult, settingResult] = await Promise.all([
        invokeSupabaseRestGet<any>(
          'change_log',
          `select=sequence_id,entity_type,entity_id,action,payload,version,changed_at&sequence_id=gt.${cursor}&order=sequence_id.asc&limit=${batchLimit}`
        ),
        invokeSupabaseRestGet<any>(
          'system_settings',
          'select=value_number&key=eq.server_reset_generation'
        )
      ]);

      const data = changesResult.data;
      const error = changesResult.error;

      if (error || !data || !Array.isArray(data)) {
        return { changes: [], latestSequence: cursor };
      }

      if (settingResult.error || !settingResult.data || settingResult.data.length === 0) {
        console.warn('Authoritative server reset generation fetch failed or empty:', settingResult.error);
        return { changes: [], latestSequence: cursor };
      }

      const serverResetGeneration = Number(settingResult.data[0].value_number);

      const changes: ChangeLogEntry[] = data.map((row: any) => ({
        sequenceId: Number(row.sequence_id),
        entityType: row.entity_type,
        entityId: row.entity_id,
        action: row.action,
        payload: row.payload,
        version: row.version !== null && row.version !== undefined ? Number(row.version) : undefined,
        changedAt: row.changed_at,
      }));

      const latestSequence = changes.length > 0
        ? Math.max(...changes.map((c) => c.sequenceId))
        : cursor;

      return {
        changes,
        latestSequence,
        serverResetGeneration,
      };
    } catch {
      return { changes: [], latestSequence: cursor };
    }
  }
}
