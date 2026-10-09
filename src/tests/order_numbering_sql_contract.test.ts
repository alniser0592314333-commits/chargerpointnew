import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Atomic day order renumbering SQL contract', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261009090000_add_atomic_day_order_renumbering.sql'
  );

  const readMigration = () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    return fs.readFileSync(migrationPath, 'utf8');
  };

  const readRenumberBranch = (sql: string) => {
    const start = sql.lastIndexOf("WHEN 'RENUMBER_DAY_ORDERS' THEN");
    const end = sql.indexOf("WHEN 'UPDATE_ORDER' THEN", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return sql.slice(start, end);
  };

  it('routes renumbering through the explicit server permission without legacy BIN aliases', () => {
    const sql = readMigration();
    expect(sql).toContain("WHEN 'RENUMBER_DAY_ORDERS' THEN");
    expect(sql).toContain("v_required_perm := 'orders:renumber-day';");
    expect(sql).toContain("v_bin := NULLIF(TRIM(p_payload->>'bin'), '');");
    expect(sql).not.toContain('adminBin');
  });

  it('locks the day and validates the complete, current, contiguous order set before updates', () => {
    const sql = readMigration();
    const branch = readRenumberBranch(sql);
    expect(branch).toContain("pg_advisory_xact_lock(hashtextextended(v_day_uuid::TEXT, 1))");
    expect(branch).toContain('FROM public.business_days WHERE id = v_day_uuid FOR UPDATE');
    expect(branch).toContain('FOR UPDATE');
    expect(branch).toContain("c->>'expectedVersion'");
    expect(branch).toContain("c->>'oldNumber'");
    expect(branch).toContain('payload must include every order in the selected day');
    expect(branch).toContain('new numbers must be unique and contiguous from 1');
  });

  it('updates each order once, audits final values, and relies on existing change capture', () => {
    const branch = readRenumberBranch(readMigration());
    expect(branch).toContain("UPDATE public.orders o");
    expect(branch).toContain("SET display_number = (c.value->>'newNumber')::INTEGER");
    expect(branch).toContain('version = o.version + 1');
    expect(branch).toContain('INSERT INTO public.order_renumber_audit');
    expect(branch).not.toContain('v_temp_base');
    expect(branch).not.toContain('PERFORM public.record_canonical_change');
    expect(branch).not.toMatch(/internal_sequence/i);
  });

  it('preserves the live payment BIN guard and FIFO allocation order', () => {
    const sql = readMigration();
    expect(sql).toContain("p_command_type IN ('DELIVER_ORDER_ITEM','CANCEL_ORDER','CANCEL_ORDER_ITEM','CREATE_CUSTOMER_CREDIT','CREATE_PAYMENT','POST_PAYMENT','CREATE_REFUND')");
    expect(sql).toContain('ORDER BY o.internal_sequence ASC, oi.item_sequence ASC, oi.id ASC');
    expect(sql).not.toContain('ORDER BY oi.created_at ASC');
  });

  it('serializes order creation with renumbering and refuses to extend a malformed sequence', () => {
    const sql = readMigration();
    const start = sql.lastIndexOf("WHEN 'CREATE_ORDER' THEN");
    const end = sql.indexOf("WHEN 'RENUMBER_DAY_ORDERS' THEN", start);
    const createOrder = sql.slice(start, end);
    expect(createOrder).toContain("pg_advisory_xact_lock(hashtextextended(v_day_uuid::TEXT, 1))");
    expect(createOrder).toContain('FROM public.business_days WHERE id = v_day_uuid FOR UPDATE');
    expect(createOrder).toContain('this day has missing or duplicate numbers');
  });

  it('does not leave the recreated SECURITY DEFINER dispatcher executable by PUBLIC or anon', () => {
    const sql = readMigration();
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.execute_canonical_sync_command(UUID, TEXT, JSONB, TEXT, TEXT, UUID) FROM PUBLIC, anon;'
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.execute_canonical_sync_command(UUID, TEXT, JSONB, TEXT, TEXT, UUID) TO authenticated, service_role;'
    );
    expect(sql).toContain('ALTER TABLE public.order_renumber_audit ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('REVOKE ALL ON TABLE public.order_renumber_audit FROM PUBLIC, anon, authenticated;');
  });
});
