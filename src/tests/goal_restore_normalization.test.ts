import { describe, expect, it } from 'vitest';
import {
  normalizeGoalEntity,
  normalizeGoalRequestEntity,
} from '../services/backup/backupService';

describe('Goal snapshot normalization', () => {
  it('maps PostgreSQL goal columns to the camelCase runtime read model', () => {
    const goal = normalizeGoalEntity({
      id: 'goal-1',
      customer_id: 'customer-1',
      target_quantity: 10,
      current_progress: 10,
      bonus_amount_minor: 130,
      duration_days: 3,
      status: 'COMPLETED',
      started_at: '2026-10-10T16:25:40.172Z',
      expires_at: '2026-10-13T16:25:40.172Z',
      completed_at: '2026-10-10T16:30:15.037Z',
      bonus_ledger_id: 'ledger-1',
      created_at: '2026-10-10T16:25:40.172Z',
      updated_at: '2026-10-10T16:30:15.037Z',
      version: 11,
    });

    expect(goal).toMatchObject({
      id: 'goal-1',
      customerId: 'customer-1',
      targetQuantity: 10,
      currentProgress: 10,
      bonusAmountMinor: 130,
      durationDays: 3,
      status: 'COMPLETED',
      startedAt: '2026-10-10T16:25:40.172Z',
      expiresAt: '2026-10-13T16:25:40.172Z',
      completedAt: '2026-10-10T16:30:15.037Z',
      bonusLedgerId: 'ledger-1',
      createdAt: '2026-10-10T16:25:40.172Z',
      updatedAt: '2026-10-10T16:30:15.037Z',
      version: 11,
    });
    expect(goal.createdAt.localeCompare('2026-10-09T00:00:00.000Z')).toBeGreaterThan(0);
  });

  it('maps PostgreSQL goal-request columns to the runtime read model', () => {
    const request = normalizeGoalRequestEntity({
      id: 'request-1',
      customer_id: 'customer-1',
      requested_target: 12,
      status: 'PENDING',
      reviewed_by: null,
      reviewed_at: null,
      rejection_reason: null,
      resulting_goal_id: null,
      created_at: '2026-10-10T16:25:40.172Z',
      updated_at: '2026-10-10T16:25:40.172Z',
      version: 1,
    });

    expect(request).toMatchObject({
      id: 'request-1',
      customerId: 'customer-1',
      requestedTarget: 12,
      status: 'PENDING',
      createdAt: '2026-10-10T16:25:40.172Z',
      updatedAt: '2026-10-10T16:25:40.172Z',
      version: 1,
    });
    expect(request.createdAt.localeCompare('2026-10-09T00:00:00.000Z')).toBeGreaterThan(0);
  });

  it('accepts already-normalized local entities without losing canonical fields', () => {
    const goal = normalizeGoalEntity({
      id: 'goal-2',
      customerId: 'customer-2',
      targetQuantity: 5,
      currentProgress: 2,
      bonusAmountMinor: 50,
      durationDays: 7,
      status: 'ACTIVE',
      startedAt: '2026-10-10T00:00:00.000Z',
      expiresAt: '2026-10-17T00:00:00.000Z',
      createdAt: '2026-10-10T00:00:00.000Z',
      updatedAt: '2026-10-10T00:00:00.000Z',
      version: 3,
    });
    expect(goal.customerId).toBe('customer-2');
    expect(goal.currentProgress).toBe(2);
    expect(goal.createdAt).toBe('2026-10-10T00:00:00.000Z');
  });
});
