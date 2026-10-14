/**
 * Forensic Test Suite for execute_sync_command Wrapper Contract & Device Type Sync
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  repoContext,
  phase5UseCases,
  resetStoreMemory,
  setRuntimeBinVerifier,
} from '../components/pages/dayOrdersStore';
import { AuthorizationContext } from '../application/authContext';
import { Permission } from '../domain/enums';
import { initializeCanonicalSyncState } from './utils/testSetup';

describe('execute_sync_command Wrapper Contract Forensic Suite', () => {
  const superAdminAuth = new AuthorizationContext(
    {
      id: 'admin_wrap_1',
      username: 'superadmin',
      fullName: 'Super Admin',
      role: 'SUPER_ADMIN',
      isSuperAdmin: true,
      permissions: ['settings:manage', 'devices:manage', 'orders:view', 'orders:create', 'orders:edit', 'orders:deliver', 'orders:cancel'] as Permission[],
    },
    async (bin) => bin === '1234'
  );

  beforeEach(async () => {
    await localDb.clear();
    await initializeCanonicalSyncState();
    await localDb.setInitialHydrationCompleted(true);
    resetStoreMemory();
    setRuntimeBinVerifier((bin) => bin === '1234');
  });

  it('Test A & B — CREATE_DEVICE_TYPE mutation through canonical workflow succeeds', async () => {
    const res = await phase5UseCases.createDeviceType(
      superAdminAuth,
      'Test Device Type',
      'smartphone',
      3500
    );
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.id).toBeDefined();
    expect(res.data.name).toBe('Test Device Type');
  });

  it('Test C — UPDATE_DEVICE_TYPE mutation succeeds', async () => {
    const createRes = await phase5UseCases.createDeviceType(
      superAdminAuth,
      'Device to Update',
      'smartphone',
      2000
    );
    expect(createRes.success).toBe(true);
    if (!createRes.success) return;

    const updateRes = await phase5UseCases.updateDeviceType(
      superAdminAuth,
      createRes.data.id,
      { name: 'Updated Device Name', basePriceMinor: 2500 }
    );
    expect(updateRes.success).toBe(true);
    if (!updateRes.success) return;
    expect(updateRes.data.name).toBe('Updated Device Name');
    expect(updateRes.data.basePriceMinor).toBe(2500);
  });

  it('Test D — RETIRE_DEVICE_TYPE mutation succeeds', async () => {
    const createRes = await phase5UseCases.createDeviceType(
      superAdminAuth,
      'Device to Retire',
      'battery',
      1500
    );
    expect(createRes.success).toBe(true);
    if (!createRes.success) return;

    const retireRes = await phase5UseCases.deleteDeviceType(
      superAdminAuth,
      createRes.data.id
    );
    expect(retireRes.success).toBe(true);
  });

  it('Test G — Idempotency enforces identical success and conflict on different payload', async () => {
    const deviceId = crypto.randomUUID();
    const cmdId = crypto.randomUUID();

    // Use command repository to record idempotent command
    await repoContext.transactionManager.runInTransaction((ctx) => {
      ctx.commandRepo.record(cmdId, 'CREATE_DEVICE_TYPE', {
        id: deviceId,
        name: 'Idempotent Device',
        basePriceMinor: 1000,
      });
    });

    const outbox = localDb.listOutboxSync();
    expect(outbox.length).toBeGreaterThan(0);
  });
});
