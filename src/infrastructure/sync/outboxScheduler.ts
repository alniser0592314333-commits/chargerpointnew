/**
 * Dependency-Aware Outbox Scheduler (Phase B.3)
 * Enforces topological dependency ordering, priority tie-breaking,
 * cycle detection, and BLOCKED -> READY state transitions.
 *
 * Core rule:
 * DEPENDENCY ORDER OVERRIDES PRIORITY.
 * Priority may only be used among commands that are already dependency-ready.
 */

import { ID } from '../../types/common';
import { localDb, OutboxRecord, SyncHistoryRecord } from '../localDb/localDb';

export interface SchedulerResult {
  ready: OutboxRecord[];
  blocked: Map<ID, { record: OutboxRecord; unsatisfiedDependencies: ID[]; reason?: string }>;
  cyclic: Set<ID>;
}

/**
 * Extracts all dependencies for a command from explicit declarations
 * and implicit domain entity relationships.
 */
export function extractCommandDependencies(item: OutboxRecord, allOutbox: OutboxRecord[]): ID[] {
  const deps = new Set<ID>();

  // 1. Explicit single dependency ID on record
  if (item.dependencyCommandId) {
    deps.add(item.dependencyCommandId);
  }

  // 2. Explicit dependency arrays on record
  if (Array.isArray(item.dependencyCommandIds)) {
    for (const id of item.dependencyCommandIds) {
      if (id) deps.add(id);
    }
  }
  if (Array.isArray(item.dependencies)) {
    for (const id of item.dependencies) {
      if (id) deps.add(id);
    }
  }

  // 3. Payload explicit dependencies
  const payload = item.payload as any;
  if (payload && typeof payload === 'object') {
    if (payload.dependencyCommandId && typeof payload.dependencyCommandId === 'string') {
      deps.add(payload.dependencyCommandId);
    }
    if (Array.isArray(payload.dependencyCommandIds)) {
      for (const id of payload.dependencyCommandIds) {
        if (id && typeof id === 'string') deps.add(id);
      }
    }
    if (Array.isArray(payload.dependencies)) {
      for (const id of payload.dependencies) {
        if (id && typeof id === 'string') deps.add(id);
      }
    }
    if (payload.dependsOn) {
      if (Array.isArray(payload.dependsOn)) {
        for (const id of payload.dependsOn) {
          if (id && typeof id === 'string') deps.add(id);
        }
      } else if (typeof payload.dependsOn === 'string') {
        deps.add(payload.dependsOn);
      }
    }

    // 4. Domain entity relationships:
    // Helper to find matching outbox commands by aggregateId, commandId, or payload id
    const checkCandidate = (candidateId: unknown, validTypes?: string[], isStructural: boolean = false) => {
      if (!candidateId || typeof candidateId !== 'string') return;
      let matchedInActiveOutbox = false;
      for (const other of allOutbox) {
        if (other.commandId === item.commandId) continue;
        if (
          other.commandId === candidateId ||
          other.aggregateId === candidateId ||
          (other.payload && (other.payload as any).id === candidateId)
        ) {
          if (
            !validTypes ||
            validTypes.includes(other.commandType) ||
            validTypes.includes(other.aggregateType)
          ) {
            deps.add(other.commandId);
            matchedInActiveOutbox = true;
          }
        }
      }
      if (!matchedInActiveOutbox) {
        // No local command owns this entity, so it may be an already-existing
        // authoritative server row. Do not invent a dependency on the entity ID:
        // that incorrectly blocks valid commands such as DELIVER/CANCEL against
        // an existing order item when no local ADD_ORDER_ITEM command exists.
        // Explicit dependencyCommandId/dependencies are still enforced above.
      }
    };

    // CREATE_ORDER depends on CREATE_DAY / OPEN_DAY (dayId) and CREATE_CUSTOMER (customerId)
    if (item.commandType === 'CREATE_ORDER' || item.aggregateType === 'orders') {
      if (payload.dayId) checkCandidate(payload.dayId, ['CREATE_DAY', 'OPEN_DAY', 'business_days'], true);
      if (payload.customerId) checkCandidate(payload.customerId, ['CREATE_CUSTOMER', 'customers'], false);

      // A CANCEL_ORDER mutation must wait for all local commands that still
      // reference the same order, otherwise a late ADD_ORDER_ITEM could arrive
      // after the server has already cancelled the order.
      if (item.commandType === 'CANCEL_ORDER') {
        for (const other of allOutbox) {
          if (other.commandId === item.commandId) continue;
          const op = other.payload as any;
          if (op?.orderId === payload.id || op?.orderId === payload.orderId || other.aggregateId === payload.id) {
            deps.add(other.commandId);
          }
        }
      }
    }
    // Item commands (DELIVER_ORDER_ITEM, CANCEL_ORDER_ITEM, etc.) depend on ADD_ORDER_ITEM (itemId / orderItemId)
    else if (item.commandType === 'DELIVER_ORDER_ITEM' || item.commandType === 'CANCEL_ORDER_ITEM' || payload.itemId || payload.orderItemId) {
      const targetItemId = payload.itemId || payload.orderItemId;
      if (targetItemId) {
        checkCandidate(targetItemId, ['ADD_ORDER_ITEM'], true);
      }
      if (payload.orderId) {
        checkCandidate(payload.orderId, ['CREATE_ORDER', 'orders'], true);
      }
    }
    // ADD_ORDER_ITEM depends on CREATE_ORDER (orderId) and CREATE_DEVICE_TYPE (deviceTypeId)
    else if (item.commandType === 'ADD_ORDER_ITEM' || item.aggregateType === 'order_items') {
      if (payload.orderId) checkCandidate(payload.orderId, ['CREATE_ORDER', 'orders'], true);
      if (payload.deviceTypeId) checkCandidate(payload.deviceTypeId, ['CREATE_DEVICE_TYPE', 'device_types'], false);
    }
    // Delivery/cancellation of an item can be queued while offline immediately
    // after the item is created. It must never reach the server before the
    // corresponding ADD_ORDER_ITEM command has been accepted.
    else if (item.commandType === 'CREATE_GOAL' || item.commandType === 'UPDATE_GOAL_CONFIG' || item.commandType === 'UPDATE_GOAL_PROGRESS') {
      if (payload.customerId) checkCandidate(payload.customerId, ['CREATE_CUSTOMER', 'customers'], false);
      if (payload.goalId && item.commandType !== 'CREATE_GOAL') checkCandidate(payload.goalId, ['CREATE_GOAL', 'goals'], true);
    }
    else if (item.commandType === 'RECORD_GOAL_REQUEST' || item.commandType === 'APPROVE_GOAL_REQUEST' || item.commandType === 'REJECT_GOAL_REQUEST') {
      if (payload.customerId) checkCandidate(payload.customerId, ['CREATE_CUSTOMER', 'customers'], false);
      if (payload.requestId) checkCandidate(payload.requestId, ['RECORD_GOAL_REQUEST', 'goal_requests'], true);
    }
    else if (item.commandType === 'DELIVER_ORDER_ITEM' || item.commandType === 'CANCEL_ORDER_ITEM') {
      const itemId = payload.itemId || payload.orderItemId || payload.id;
      if (itemId) checkCandidate(itemId, ['ADD_ORDER_ITEM', 'order_items'], true);
    } else {
      // General referencing across commands
      if (payload.orderId) checkCandidate(payload.orderId, undefined, true);
      if (payload.customerId) checkCandidate(payload.customerId, undefined, false);
      if (payload.dayId) checkCandidate(payload.dayId, undefined, true);
      if (payload.deviceTypeId) checkCandidate(payload.deviceTypeId, undefined, false);
    }
  }

  // Remove self-references
  deps.delete(item.commandId);
  return Array.from(deps);
}

/**
 * Non-recursive, iterative cycle detection on a directed dependency graph.
 * Avoids uncontrolled recursion and prevents infinite loops.
 */
export function detectCycles(
  commandIds: ID[],
  getDependencies: (id: ID) => ID[]
): Set<ID> {
  const cyclic = new Set<ID>();
  const state = new Map<ID, 'visiting' | 'visited'>();

  for (const startId of commandIds) {
    if (state.get(startId) === 'visited') continue;

    const path: ID[] = [];
    const stack: { id: ID; depIndex: number }[] = [{ id: startId, depIndex: 0 }];
    state.set(startId, 'visiting');
    path.push(startId);

    while (stack.length > 0) {
      const current = stack[stack.length - 1];
      const deps = getDependencies(current.id);

      if (current.depIndex < deps.length) {
        const nextId = deps[current.depIndex];
        current.depIndex++;

        // Only traverse nodes that are part of the target candidate set
        if (!commandIds.includes(nextId)) continue;

        const nextState = state.get(nextId);
        if (nextState === 'visiting') {
          // Detected cycle! Mark all nodes along the cycle path
          const cycleStart = path.indexOf(nextId);
          if (cycleStart !== -1) {
            for (let i = cycleStart; i < path.length; i++) {
              cyclic.add(path[i]);
            }
          }
          cyclic.add(nextId);
        } else if (!nextState) {
          state.set(nextId, 'visiting');
          path.push(nextId);
          stack.push({ id: nextId, depIndex: 0 });
        }
      } else {
        state.set(current.id, 'visited');
        path.pop();
        stack.pop();
      }
    }
  }

  return cyclic;
}

/**
 * Sorts dependency-ready commands.
 * Rule: Priority descending (higher number first).
 * Tie-breaker: createdAt ascending (FIFO).
 */
export function sortReadyCommands(ready: OutboxRecord[]): OutboxRecord[] {
  return [...ready].sort((a, b) => {
    const priorityA = a.priority ?? 0;
    const priorityB = b.priority ?? 0;
    if (priorityB !== priorityA) {
      return priorityB - priorityA;
    }
    const timeA = new Date(a.createdAt || 0).getTime();
    const timeB = new Date(b.createdAt || 0).getTime();
    return timeA - timeB;
  });
}

export class OutboxScheduler {
  /**
   * Evaluates candidates against the outbox and history state to determine:
   * - Ready commands (dependencies satisfied, sorted by priority then FIFO)
   * - Blocked commands (waiting on unsatisfied dependencies)
   * - Cyclic commands (involved in a circular dependency)
   */
  async schedule(
    candidates: OutboxRecord[],
    allOutbox: OutboxRecord[],
    historyLookup?: (id: ID) => Promise<SyncHistoryRecord | null>
  ): Promise<SchedulerResult> {
    const candidateIds = candidates.map(c => c.commandId);
    const candidateMap = new Map<ID, OutboxRecord>(candidates.map(c => [c.commandId, c]));
    const allOutboxMap = new Map<ID, OutboxRecord>(allOutbox.map(o => [o.commandId, o]));

    // 1. Build dependency map for each candidate
    const depMap = new Map<ID, ID[]>();
    for (const candidate of candidates) {
      const deps = extractCommandDependencies(candidate, allOutbox);
      depMap.set(candidate.commandId, deps);
    }

    // 2. Detect cycles among candidate commands
    const cyclic = detectCycles(candidateIds, (id) => depMap.get(id) || []);

    const ready: OutboxRecord[] = [];
    const blocked = new Map<ID, { record: OutboxRecord; unsatisfiedDependencies: ID[]; reason?: string }>();

    // Cache history lookups within this schedule pass
    const historyCache = new Map<ID, SyncHistoryRecord | null>();
    const getHistory = async (id: ID): Promise<SyncHistoryRecord | null> => {
      if (historyCache.has(id)) return historyCache.get(id)!;
      if (!historyLookup) return null;
      const h = await historyLookup(id);
      historyCache.set(id, h);
      return h;
    };

    // 3. Evaluate each candidate
    for (const candidate of candidates) {
      const id = candidate.commandId;

      if (cyclic.has(id)) {
        blocked.set(id, {
          record: candidate,
          unsatisfiedDependencies: depMap.get(id) || [],
          reason: 'Circular dependency detected',
        });
        continue;
      }

      const deps = depMap.get(id) || [];
      const unsatisfied: ID[] = [];

      for (const depId of deps) {
        // 1. Check in allOutbox (by commandId, aggregateId, or payload.id)
        let outboxDep = allOutboxMap.get(depId);
        if (!outboxDep) {
          outboxDep = allOutbox.find(
            (o) =>
              o.commandId !== candidate.commandId &&
              (o.commandId === depId ||
                o.aggregateId === depId ||
                (o.payload && (o.payload as any).id === depId))
          );
        }

        if (outboxDep) {
          // In outbox: satisfied ONLY if accepted
          if (outboxDep.status !== 'accepted') {
            unsatisfied.push(outboxDep.commandId || depId);
          }
        } else {
          // 2. Check local history (by commandId or entityId/aggregateId)
          const historyDep = await getHistory(depId);
          if (historyDep) {
            if (historyDep.state === 'SUCCESS' || historyDep.state === 'SUCCEEDED') {
              // Satisfied by previous sync
            } else {
              // Prerequisite failed, blocked, or not completed (e.g. FAILED, CONFLICT, BLOCKED, etc.)
              unsatisfied.push(historyDep.commandId || depId);
            }
          } else {
            // Prerequisite is not in active outbox AND not in history.
            // Check if the entity already exists locally in DB (e.g. existing order, day, customer, device, item)
            const [existsInDays, existsInOrders, existsInCustomers, existsInDevices, existsInItems] = await Promise.all([
              localDb.get('businessDays', depId).catch(() => null),
              localDb.get('orders', depId).catch(() => null),
              localDb.get('customers', depId).catch(() => null),
              localDb.get('deviceTypes', depId).catch(() => null),
              localDb.get('orderItems', depId).catch(() => null),
            ]);

            const entityExistsLocally = Boolean(existsInDays || existsInOrders || existsInItems || existsInCustomers || existsInDevices);

            if (!entityExistsLocally) {
              const isDayDep =
                (candidate.commandType === 'CREATE_ORDER' || candidate.aggregateType === 'orders') &&
                (candidate.payload as any)?.dayId === depId;
              const isOrderDep =
                (candidate.commandType === 'ADD_ORDER_ITEM' || candidate.aggregateType === 'order_items') &&
                (candidate.payload as any)?.orderId === depId;
              const isItemDep =
                (candidate.commandType === 'DELIVER_ORDER_ITEM' || candidate.commandType === 'CANCEL_ORDER_ITEM' || (candidate.payload as any)?.itemId || (candidate.payload as any)?.orderItemId) &&
                ((candidate.payload as any)?.itemId === depId || (candidate.payload as any)?.orderItemId === depId);
              const isExplicitDep =
                candidate.dependencyCommandId === depId ||
                candidate.dependencyCommandIds?.includes(depId) ||
                candidate.dependencies?.includes(depId) ||
                (candidate.payload as any)?.dependencyCommandId === depId;

              if (isDayDep || isOrderDep || isItemDep || isExplicitDep) {
                unsatisfied.push(depId);
              }
            }
          }
        }
      }

      if (unsatisfied.length === 0) {
        ready.push(candidate);
      } else {
        blocked.set(id, {
          record: candidate,
          unsatisfiedDependencies: unsatisfied,
          reason: `Waiting for dependencies: ${unsatisfied.join(', ')}`,
        });
      }
    }

    // 4. Sort ready commands by priority descending, then createdAt FIFO
    const sortedReady = sortReadyCommands(ready);

    return {
      ready: sortedReady,
      blocked,
      cyclic,
    };
  }
}
