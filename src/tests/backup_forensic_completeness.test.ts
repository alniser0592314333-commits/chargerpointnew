import { describe, it, expect, beforeEach } from 'vitest';
import {
  backupService,
  computeSnapshotChecksum,
} from '../services/backup/backupService';
import { localDb } from '../infrastructure/localDb/localDb';
import { AuthorizationContext, ActorAdmin } from '../application/authContext';

const actor: ActorAdmin = {
  id: 'admin_backup_forensic',
  username: 'backup_forensic',
  fullName: 'Backup Forensic Admin',
  role: 'SUPER_ADMIN',
  permissions: ['settings:manage'],
  isSuperAdmin: true,
};

const auth = new AuthorizationContext(actor, (bin) => bin === '1234');

const baseCustomer = { id: 'cust_backup', name: 'Backup Customer' };
const baseDay = { id: 'day_backup', businessDate: '2026-10-06' };
const baseOrder = { id: 'ord_backup', dayId: baseDay.id, customerId: baseCustomer.id, displayNumber: 1 };
const baseDevice = { id: 'dev_backup', name: 'Phone', basePriceMinor: 100 };
const baseItem = { id: 'item_backup', orderId: baseOrder.id, deviceTypeId: baseDevice.id, status: 'charging', totalPriceMinor: 100 };

beforeEach(async () => {
  await localDb.clear();
  if (typeof localStorage !== 'undefined') {
    localStorage.clear();
    localStorage.setItem('sys_theme', 'dark');
    localStorage.setItem('sys_locale', 'ar');
    localStorage.setItem('app_qr_design_config_CUSTOMER', '{"id":"custom"}');
  }
  await localDb.set('customers', baseCustomer.id, baseCustomer);
  await localDb.set('businessDays', baseDay.id, baseDay);
  await localDb.set('deviceTypes', baseDevice.id, baseDevice);
  await localDb.set('orders', baseOrder.id, baseOrder);
  await localDb.set('orderItems', baseItem.id, baseItem);
  await localDb.set('deletedDeviceTypeMarkers', 'dev_deleted', { id: 'dev_deleted', deletedAt: '2026-10-06T00:00:00Z' });
  await localDb.set('changeLog', '7', { id: '7', sequenceId: 7, entityId: baseOrder.id });
  await localDb.saveMutationSnapshot({
    commandId: 'cmd_backup_pending',
    createdAt: '2026-10-06T00:00:00Z',
    records: [{ table: 'orders', id: baseOrder.id, before: { ...baseOrder, notes: 'before' } }],
  } as any);
  await localDb.saveOutbox({
    commandId: 'cmd_backup_pending',
    commandType: 'UPDATE_ORDER',
    aggregateType: 'orders',
    aggregateId: baseOrder.id,
    payload: { id: baseOrder.id, notes: 'pending' },
    status: 'pending',
    createdAt: '2026-10-06T00:00:00Z',
    retryCount: 0,
  } as any);
});

describe('Backup forensic completeness', () => {
  it('captures recovery-critical local state, pending work and user preferences', async () => {
    const snap = await backupService.createSnapshot('OFFLINE', auth, { bin: '1234' });
    expect(snap.data.deletedDeviceTypeMarkers).toHaveLength(1);
    expect(snap.data.changeLog).toHaveLength(1);
    expect(snap.data.mutationSnapshots).toHaveLength(1);
    expect(snap.data.outbox).toHaveLength(1);
    expect(snap.data.localPreferences?.sys_theme).toBe('dark');
    expect(snap.data.localPreferences?.sys_locale).toBe('ar');
  });

  it('portable export retains the same recovery-critical payload instead of dropping outbox/history', async () => {
    const snap = await backupService.createSnapshot('OFFLINE', auth, { bin: '1234' });
    const exported = await backupService.exportSnapshotToPortableFormat(snap.snapshotId);
    const parsed = JSON.parse(exported.fileContent);
    expect(parsed.data.outbox).toHaveLength(1);
    expect(parsed.data.mutationSnapshots).toHaveLength(1);
    expect(parsed.data.deletedDeviceTypeMarkers).toHaveLength(1);
    expect(parsed.data.localPreferences.sys_theme).toBe('dark');
    expect(computeSnapshotChecksum(parsed.data)).toBe(parsed.metadata.checksum);
  });

  it('rejects a portable backup whose declared record counts were altered', async () => {
    const snap = await backupService.createSnapshot('OFFLINE', auth, { bin: '1234' });
    const exported = await backupService.exportSnapshotToPortableFormat(snap.snapshotId);
    const tampered = JSON.parse(exported.fileContent);
    tampered.metadata.recordCounts.customers += 1;
    const result = backupService.validateAndParsePortableBackup(JSON.stringify(tampered));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('METADATA_MISMATCH');
  });

  it('restores pending work and recovery markers, and does not leave stale mutation snapshots behind', async () => {
    const snap = await backupService.createSnapshot('OFFLINE', auth, { bin: '1234' });
    await localDb.clear({ preserveSnapshots: true });
    await backupService.restoreSnapshot(snap.snapshotId, auth, { bin: '1234' });
    expect((await localDb.listOutbox()).some((x) => x.commandId === 'cmd_backup_pending')).toBe(true);
    expect((await localDb.list('deletedDeviceTypeMarkers')).some((x: any) => x.id === 'dev_deleted')).toBe(true);
    expect((await localDb.listMutationSnapshots()).some((x) => x.commandId === 'cmd_backup_pending')).toBe(true);
    expect(localStorage.getItem('sys_theme')).toBe('dark');
    expect(localStorage.getItem('sys_locale')).toBe('ar');
  });
});
