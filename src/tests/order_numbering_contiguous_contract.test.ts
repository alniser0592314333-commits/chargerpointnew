import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Server-authoritative contiguous order numbering', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261016130000_server_authoritative_contiguous_order_numbers.sql'
  );

  const readMigration = () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    return fs.readFileSync(migrationPath, 'utf8');
  };

  it('validates the exact client-assigned number under the day lock without reassignment', () => {
    const sql = readMigration();
    const routeStart = sql.indexOf('-- 5. ROUTE BY CANONICAL COMMAND TYPE');
    const createStart = sql.indexOf("WHEN 'CREATE_ORDER' THEN", routeStart);
    const renumberStart = sql.indexOf("WHEN 'RENUMBER_DAY_ORDERS' THEN", createStart);
    expect(routeStart).toBeGreaterThanOrEqual(0);
    expect(createStart).toBeGreaterThan(routeStart);
    expect(renumberStart).toBeGreaterThan(createStart);
    const branch = sql.slice(createStart, renumberStart);

    expect(branch).toContain("pg_advisory_xact_lock(hashtextextended(v_day_uuid::TEXT, 1))");
    expect(branch).toContain('FROM public.business_days WHERE id = v_day_uuid FOR UPDATE');
    expect(branch).toContain("v_requested_display_number := NULLIF(COALESCE(");
    expect(branch).toContain('v_requested_display_number <> v_max_new_number + 1');
    expect(branch).toContain('ORDER_NUMBER_CONFLICT [409]');
    expect(branch).toContain('ORDER_NUMBER_IMMUTABLE [409]');
    expect(branch).toContain('ORDER_NUMBER_REQUIRED');
    expect(branch).toContain('Order numbering is not contiguous');
    expect(branch).toContain('v_max_new_number <> v_change_count');
    expect(branch).toContain("'{displayNumber}'");
    expect(branch).toContain("'{display_number}'");
    expect(branch).toContain("p_payload->>'displayNumber'");
    expect(branch).not.toContain('silently substitutes another number');
  });

  it('enforces per-day uniqueness without breaking atomic number swaps during renumbering', () => {
    const sql = readMigration();
    expect(sql).toContain('orders_day_display_number_key');
    expect(sql).toContain('UNIQUE (day_id, display_number)');
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    const branchStart = sql.indexOf("WHEN 'RENUMBER_DAY_ORDERS' THEN", sql.indexOf('-- 5. ROUTE BY CANONICAL COMMAND TYPE'));
    const branchEnd = sql.indexOf("WHEN 'UPDATE_ORDER' THEN", branchStart);
    const renumberBranch = sql.slice(branchStart, branchEnd);
    expect(renumberBranch).toContain('SET display_number = (c.value->>\'newNumber\')::INTEGER');
    expect(renumberBranch).toContain('INSERT INTO public.order_renumber_audit');
  });
});
