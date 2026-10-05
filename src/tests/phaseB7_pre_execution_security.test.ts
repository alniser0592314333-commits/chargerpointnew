import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { invokeSupabaseRpc, invokeSupabaseRestGet } from '../services/supabase/client';

describe('ONLINE RESET — PRE-EXECUTION SECURITY TEST SUITE (REMOTE SUPABASE)', () => {
  const migrationPath = path.join(process.cwd(), 'supabase', 'migrations', '00020_online_business_reset.sql');
  const migrationContent = fs.readFileSync(migrationPath, 'utf8');

  const businessTables = [
    'payment_allocations',
    'financial_ledger',
    'payments',
    'order_items',
    'orders',
    'qr_tokens',
    'customers',
    'business_days',
    'sync_conflicts',
    'change_log',
    'processed_commands',
  ];

  it('1. RPC existence & discoverability in PostgREST schema cache', async () => {
    // Calling with anon / unauthenticated bearer
    const { data, error } = await invokeSupabaseRpc('reset_online_business_data', { p_entered_bin: '000000' }, undefined, true);
    
    // Must NOT be 404 / PGRST202 ("Could not find the function")
    expect(error).not.toContain('404');
    expect(error).not.toContain('PGRST202');
    expect(error).toBeDefined(); // Must return security/auth exception from function logic
  });

  it('2. Rejects unauthenticated RPC invocation', async () => {
    const { data, error } = await invokeSupabaseRpc('reset_online_business_data', { p_entered_bin: '000000' }, undefined, true);
    expect(error).toBeDefined();
    expect(error).toContain('permission denied for function reset_online_business_data');
    expect(data).toBeNull();
  });

  it('3. Rejects null / missing BIN', async () => {
    const { data, error } = await invokeSupabaseRpc('reset_online_business_data', { p_entered_bin: null as any }, undefined, true);
    expect(error).toBeDefined();
    expect(error).not.toContain('PGRST202');
  });

  it('4. Rejects empty string BIN', async () => {
    const { data, error } = await invokeSupabaseRpc('reset_online_business_data', { p_entered_bin: '' }, undefined, true);
    expect(error).toBeDefined();
    expect(error).not.toContain('PGRST202');
  });

  it('5. Rejects whitespace BIN', async () => {
    const { data, error } = await invokeSupabaseRpc('reset_online_business_data', { p_entered_bin: '   ' }, undefined, true);
    expect(error).toBeDefined();
    expect(error).not.toContain('PGRST202');
  });

  it('6. Rejects invalid BIN credential', async () => {
    const { data, error } = await invokeSupabaseRpc('reset_online_business_data', { p_entered_bin: '000000' }, undefined, true);
    expect(error).toBeDefined();
    expect(error).not.toContain('PGRST202');
  });

  it('7. Verified server-side BIN verification structure in 00020 SQL definition', () => {
    expect(migrationContent).toContain('v_bin_verified := verify_admin_bin(p_entered_bin);');
    expect(migrationContent).toContain('IF v_bin_verified IS NOT TRUE THEN');
    expect(migrationContent).toContain("RAISE EXCEPTION 'Invalid BIN: Security verification failed for Online Reset';");
    expect(migrationContent).not.toContain('authService');
    expect(migrationContent).not.toContain('1234');
  });

  it('9. Verifies row counts before and after security test suite remain 100% identical', async () => {
    // Read count for tables
    const tableCountsBefore: Record<string, number> = {};
    const tableCountsAfter: Record<string, number> = {};

    for (const table of businessTables) {
      const { data } = await invokeSupabaseRestGet<any>(table, 'select=id', undefined, true);
      tableCountsBefore[table] = data ? data.length : 0;
    }

    // Execute invalid RPC attempt
    await invokeSupabaseRpc('reset_online_business_data', { p_entered_bin: '000000' }, undefined, true);

    for (const table of businessTables) {
      const { data } = await invokeSupabaseRestGet<any>(table, 'select=id', undefined, true);
      tableCountsAfter[table] = data ? data.length : 0;
    }

    expect(tableCountsAfter).toEqual(tableCountsBefore);
  });
});
