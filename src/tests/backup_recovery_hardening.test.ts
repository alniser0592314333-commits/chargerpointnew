import { describe, expect, it, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { backupService, computeSnapshotSha256, validateReplacementData } from '../services/backup/backupService';
import { AuthorizationContext, ActorAdmin } from '../application/authContext';

describe('Backup recovery hardening', () => {
  const actor: ActorAdmin = {
    id: '00000000-0000-0000-0000-000000000001',
    username: 'backup-admin',
    fullName: 'Backup Admin',
    role: 'SUPER_ADMIN',
    permissions: ['settings:manage'],
    isSuperAdmin: true,
  };
  const auth = new AuthorizationContext(actor, (bin) => bin === '1234');

  beforeEach(async () => {
    await localDb.clear();
  });

  it('captures pending outbox and optimistic overlay state, then quarantines it when server generation cannot be verified', async () => {
    const customerId = '00000000-0000-0000-0000-000000000010';
    await localDb.set('customers', customerId, {
      id: customerId,
      name: 'Offline customer',
      version: 1,
    });

    await localDb.saveOutbox({
      commandId: '00000000-0000-0000-0000-000000000020',
      commandType: 'UPDATE_CUSTOMER',
      aggregateType: 'customers',
      aggregateId: customerId,
      payload: { id: customerId, name: 'Changed offline' },
      createdAt: new Date().toISOString(),
      deviceId: '00000000-0000-0000-0000-000000000030',
      actorAdminId: actor.id,
      status: 'pending',
      retryCount: 0,
      resetGeneration: 7,
    });

    await localDb.saveOverlay({
      commandId: '00000000-0000-0000-0000-000000000020',
      mutationKey: 'customers:' + customerId,
      entityType: 'customers',
      entityId: customerId,
      operation: 'PATCH',
      patch: { name: 'Changed offline' },
      sequence: 1,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
    });

    const snapshot = await backupService.createSnapshot('OFFLINE', auth, {
      name: 'Recovery state',
      bin: '1234',
    });

    expect(snapshot.data.outbox).toHaveLength(1);
    expect(snapshot.data.optimisticOverlays).toHaveLength(1);

    await localDb.clearOperationalData({
      clearOutbox: true,
      clearSyncState: true,
    });

    await backupService.restoreSnapshot(snapshot.snapshotId, auth, { bin: '1234' });

    expect(await localDb.listOutbox()).toHaveLength(1);
    expect(await localDb.listOverlays()).toHaveLength(1);
    expect((await localDb.getOutbox('00000000-0000-0000-0000-000000000020'))?.status).toBe('rejected');
    expect((await localDb.getOutbox('00000000-0000-0000-0000-000000000020'))?.lastError).toBe('BACKUP_GENERATION_MISMATCH_REQUIRES_MANUAL_REVIEW');
  });


  it('validates and preserves goals, goal requests, and keyed system settings as recoverable state', async () => {
    const customerId = '00000000-0000-0000-0000-000000000050';
    const goalId = '00000000-0000-0000-0000-000000000051';
    const requestId = '00000000-0000-0000-0000-000000000052';

    await localDb.set('customers', customerId, { id: customerId, name: 'Goal customer' });
    await localDb.set('goals', goalId, {
      id: goalId,
      customerId,
      targetQuantity: 10,
      currentProgress: 2,
      bonusAmountMinor: 100,
      durationDays: 30,
      status: 'ACTIVE',
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      version: 1,
    });
    await localDb.set('goalRequests', requestId, {
      id: requestId,
      customerId,
      requestedTarget: 10,
      status: 'PENDING',
      version: 1,
    });
    await localDb.set('systemSettings', 'server_reset_generation', {
      key: 'server_reset_generation',
      value_type: 'number',
      value_number: 7,
    });

    const snapshot = await backupService.createSnapshot('OFFLINE', auth, {
      name: 'Goals and settings recovery',
      bin: '1234',
    });

    expect(snapshot.data.goals).toHaveLength(1);
    expect(snapshot.data.goalRequests).toHaveLength(1);
    expect(snapshot.data.systemSettings).toHaveLength(1);
    expect(await computeSnapshotSha256(snapshot.data)).toBe(snapshot.metadata.checksum);

    validateReplacementData(snapshot.data);

    await localDb.clearOperationalData({ clearOutbox: true, clearSyncState: true });
    await backupService.restoreSnapshot(snapshot.snapshotId, auth, { bin: '1234' });

    expect(await localDb.list('goals')).toHaveLength(1);
    expect(await localDb.list('goalRequests')).toHaveLength(1);
    expect(await localDb.get('systemSettings', 'server_reset_generation')).toMatchObject({
      key: 'server_reset_generation',
      value_number: 7,
    });
  });

  it('creates a recovery snapshot before destructive local deletion', async () => {
    const customerId = '00000000-0000-0000-0000-000000000040';
    await localDb.set('customers', customerId, { id: customerId, name: 'Protected' });

    const before = await backupService.listSnapshots();
    await backupService.deleteLocalBusinessData(auth, { bin: '1234' });

    expect(await localDb.list('customers')).toHaveLength(0);

    const after = await backupService.listSnapshots();
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.some((snap) => snap.snapshotName.includes('Pre-Local-Delete Recovery Snapshot'))).toBe(true);
  });
});
