import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Online reset legacy-schema regression', () => {
  const migrationPath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '00115_remove_legacy_sync_conflicts_from_online_reset.sql'
  );
  const migration = fs.readFileSync(migrationPath, 'utf8');

  it('replaces reset_online_business_data without referencing the removed sync_conflicts table', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION reset_online_business_data');
    expect(migration).not.toMatch(/\b(?:DELETE\s+FROM|v_count_)\s*sync_conflicts\b/i);
  });

  it('preserves reset generation, authorization, BIN validation, and canonical purge tables', () => {
    expect(migration).toContain("server_reset_generation");
    expect(migration).toContain('verify_admin_bin(p_entered_bin)');
    expect(migration).toContain('DELETE FROM payment_allocations WHERE true;');
    expect(migration).toContain('DELETE FROM financial_ledger WHERE true;');
    expect(migration).toContain('DELETE FROM processed_commands WHERE true;');
  });

  it('does not recreate the obsolete compatibility table', () => {
    expect(migration).not.toMatch(/CREATE\s+TABLE[^;]*sync_conflicts/i);
  });
});
