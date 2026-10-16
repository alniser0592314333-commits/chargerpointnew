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

  it('validates the exact client-assigned number against a durable high-water mark', () => {
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
    expect(branch).toContain('v_requested_display_number <= v_max_new_number');
    expect(branch).toContain('public.business_day_order_sequences');
    expect(branch).toContain('last_assigned_number');
    expect(branch).toContain('GREATEST(v_max_new_number, COALESCE(MAX(display_number), 0))');
    expect(branch).toContain('ORDER_NUMBER_CONFLICT [409]');
    expect(branch).toContain('ORDER_NUMBER_IMMUTABLE [409]');
    expect(branch).toContain('ORDER_NUMBER_REQUIRED');
    expect(branch).toContain("'{displayNumber}'");
    expect(branch).toContain("'{display_number}'");
    expect(branch).toContain("p_payload->>'displayNumber'");
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
    expect(renumberBranch).toContain('INSERT INTO public.business_day_order_sequences (day_id, last_assigned_number, updated_at)');
    expect(renumberBranch).toContain('VALUES (v_day_uuid, v_max_new_number, NOW())');
    expect(renumberBranch).toContain('last_assigned_number = EXCLUDED.last_assigned_number');
  });
  it('keeps the UI preview independent of legacy reservation cursors', () => {
    const storePath = path.resolve(process.cwd(), 'src/components/pages/dayOrdersStore.ts');
    const store = fs.readFileSync(storePath, 'utf8');
    const start = store.indexOf('export const getNextOrderNumberForDay');
    const end = store.indexOf('export const searchCustomers', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const preview = store.slice(start, end);
    expect(preview).toContain('return Math.max(maxNumber, lastAssigned) + 1');
    expect(preview).toContain('getLastAssignedNumberForDay');
    expect(preview).not.toContain('findActiveByDayAndDevice');
    expect(preview).toContain('getEffectiveOrderItemReadModel()');
  });

});
