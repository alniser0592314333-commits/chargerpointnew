import { localDb } from '../../infrastructure/localDb/localDb';
import { CURRENT_MIGRATION_VERSION } from '../../components/pages/dayOrdersStore';

export async function initializeCanonicalSyncState() {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('sys_db_version', CURRENT_MIGRATION_VERSION);
  }
  await localDb.setSyncState({
    table: 'global',
    lastAppliedChangeSequence: 0,
    lastPulledAt: '',
    resetGeneration: 1,
    status: 'READY',
  });
}
