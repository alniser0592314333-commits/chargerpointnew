import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('canonical customer payment BIN database boundary', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261116190000_require_bin_for_customer_payments.sql'
  );

  const readMigration = () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    return fs.readFileSync(migrationPath, 'utf8');
  };

  it('requires a BIN for customer payment and credit commands before invoking the mutation processor', () => {
    const sql = readMigration();
    expect(sql).toContain("p_command_type IN ('POST_PAYMENT', 'CREATE_PAYMENT', 'CREATE_CUSTOMER_CREDIT')");
    expect(sql).toContain("USING ERRCODE = 'P4004'");
    expect(sql).toContain('public.verify_admin_bin(v_bin) IS NOT TRUE');
    expect(sql).toContain("USING ERRCODE = 'P0003'");
    expect(sql.indexOf("IF p_command_type IN")).toBeLessThan(
      sql.indexOf('RETURN public.execute_canonical_sync_command_unlocked')
    );
  });

  it('preserves the canonical change-log lock and original unlocked command dispatcher', () => {
    const sql = readMigration();
    expect(sql).toContain("hashtextextended('chargerpointnew:change_log:commit_order', 0)");
    expect(sql).toContain('public.execute_canonical_sync_command_unlocked(');
    expect(sql).toContain("SET search_path TO ''");
  });
});
