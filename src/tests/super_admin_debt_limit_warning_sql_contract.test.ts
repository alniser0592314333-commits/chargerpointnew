import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Super Admin debt-limit warning policy migration', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261010100000_super_admin_debt_limit_warning_policy.sql'
  );

  const readMigration = () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    return fs.readFileSync(migrationPath, 'utf8');
  };

  it('changes only the existing canonical debt guard and fails closed on dispatcher drift', () => {
    const sql = readMigration();
    expect(sql).toContain("public.execute_canonical_sync_command(uuid,text,jsonb,text,text,uuid)");
    expect(sql).toContain('pg_get_functiondef');
    expect(sql).toContain('Expected canonical debt-limit guard was not found');
    expect(sql).toContain('was not replaced exactly once');
    expect(sql).toContain("EXECUTE v_replaced_definition");
  });

  it('keeps debt-limit enforcement for non-Super-Admin roles and bypasses it only for Super Admin', () => {
    const sql = readMigration();
    expect(sql).toContain("IF v_admin_role NOT IN ('SUPER_ADMIN', 'Super Admin') AND (");
    expect(sql).toContain("(v_rec_item.debt_limit_minor = 0 AND v_projected_balance < 0)");
    expect(sql).toContain("RAISE EXCEPTION 'Debt Limit Exceeded: Customer debt limit % exceeded by projected balance %'");
  });

  it('does not alter RPC signatures, command names, permissions, or sync contracts', () => {
    const sql = readMigration();
    expect(sql).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.execute_sync_command/i);
    expect(sql).not.toMatch(/GRANT\s+EXECUTE|REVOKE\s+ALL|ALTER\s+TABLE|CREATE\s+TRIGGER/i);
    expect(sql).not.toContain('CREATE_ORDER');
    expect(sql).not.toContain('ADD_ORDER_ITEM');
  });
});
