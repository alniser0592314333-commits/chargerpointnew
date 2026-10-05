import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Concurrent Sync vs Online Reset Advisory Lock Regression Test', () => {
  const migration00016Path = path.join(process.cwd(), 'supabase', 'migrations', '00016_authoritative_sync_command_processor.sql');
  const migration00019Path = path.join(process.cwd(), 'supabase', 'migrations', '00019_concurrent_sync_online_reset_lock.sql');

  const migration00016Content = fs.readFileSync(migration00016Path, 'utf8');
  const migration00019Content = fs.readFileSync(migration00019Path, 'utf8');

  it('1. 00019 contains pg_advisory_xact_lock with correct key, while restored 00016 is clean', () => {
    const expectedLockCall = "pg_advisory_xact_lock(hashtext('online_business_reset_lock'))";
    expect(migration00019Content).toContain(expectedLockCall);
    expect(migration00016Content).not.toContain(expectedLockCall);
  });

  it('2. The lock key in 00019 is exactly online_business_reset_lock', () => {
    const keyMatch19 = migration00019Content.match(/hashtext\('([^']+)'\)/);

    expect(keyMatch19).not.toBeNull();
    expect(keyMatch19![1]).toBe('online_business_reset_lock');
  });

  it('3. Lock in 00019 is strictly Transaction-Scoped (pg_advisory_xact_lock)', () => {
    expect(migration00019Content).toContain('pg_advisory_xact_lock');
  });

  it('4. No session-level advisory locks are used in execute_sync_command', () => {
    // Ensure pg_advisory_lock without _xact_ is not used
    const sessionLockPattern = /pg_advisory_lock\(/g;
    expect(sessionLockPattern.test(migration00016Content)).toBe(false);
    expect(sessionLockPattern.test(migration00019Content)).toBe(false);

    // Ensure pg_try_advisory_lock is not used
    expect(migration00016Content).not.toContain('pg_try_advisory');
    expect(migration00019Content).not.toContain('pg_try_advisory');
  });

  it('5. No alternate or invalid lock key is used in 00019', () => {
    const allHashtextMatches19 = Array.from(migration00019Content.matchAll(/hashtext\('([^']+)'\)/g)).map(m => m[1]);

    expect(allHashtextMatches19.length).toBeGreaterThan(0);
    expect(allHashtextMatches19.every(k => k === 'online_business_reset_lock')).toBe(true);
  });

  it('6. RPC contract signature of execute_sync_command remains unchanged', () => {
    const expectedSignature = `CREATE OR REPLACE FUNCTION execute_sync_command(
    p_command_id TEXT,
    p_command_type VARCHAR(100),
    p_aggregate_type VARCHAR(100) DEFAULT NULL,
    p_aggregate_id TEXT DEFAULT NULL,
    p_payload JSONB DEFAULT '{}'::jsonb,
    p_expected_version INTEGER DEFAULT NULL
)`;
    expect(migration00016Content.replace(/\s+/g, ' ')).toContain(expectedSignature.replace(/\s+/g, ' '));
    expect(migration00019Content.replace(/\s+/g, ' ')).toContain(expectedSignature.replace(/\s+/g, ' '));
  });

  it('7. Command idempotency boundary remains intact', () => {
    expect(migration00016Content).toContain('WHERE command_id = v_cmd_uuid;');
    expect(migration00016Content).toContain('RETURN v_existing_result;');
    expect(migration00019Content).toContain('WHERE command_id = v_cmd_uuid;');
    expect(migration00019Content).toContain('RETURN v_existing_result;');
  });

  it('8. Fine-grained RBAC authorization boundary remains intact', () => {
    expect(migration00016Content).toContain('get_effective_permissions(v_admin_id)');
    expect(migration00019Content).toContain('get_effective_permissions(v_admin_id)');
  });
});
