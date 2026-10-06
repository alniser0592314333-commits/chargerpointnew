import fs from 'node:fs';

const token = process.env.SUPABASE_ACCESS_TOKEN;
const projectId = 'ydhcyamtgioyrxfarkwk';

if (!token) {
  console.error('FATAL: SUPABASE_ACCESS_TOKEN environment variable not set');
  process.exit(1);
}

async function runQuery(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectId}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Query failed [${res.status}]: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function inspect() {
  console.log('Starting read-only schema inspection of online Supabase DB...');
  const report = {};

  // 1. Schema migrations
  try {
    report.migrations = await runQuery(`
      SELECT version, name 
      FROM supabase_migrations.schema_migrations 
      ORDER BY version ASC;
    `);
  } catch (err) {
    report.migrationsError = err.message;
  }

  // 2. Tables
  report.tables = await runQuery(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    ORDER BY table_name;
  `);

  // 3. Columns
  report.columns = await runQuery(`
    SELECT table_name, column_name, ordinal_position, column_default, is_nullable, data_type, udt_name
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    ORDER BY table_name, ordinal_position;
  `);

  // 4. Routines / RPCs
  report.routines = await runQuery(`
    SELECT 
      p.proname AS routine_name,
      pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
      pg_catalog.pg_get_function_arguments(p.oid) AS arguments,
      pg_catalog.pg_get_function_result(p.oid) AS result_type,
      p.prosecdef AS is_security_definer
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
    ORDER BY p.proname, identity_arguments;
  `);

  // 5. Triggers
  report.triggers = await runQuery(`
    SELECT 
      event_object_table, 
      trigger_name, 
      event_manipulation, 
      action_statement, 
      action_timing
    FROM information_schema.triggers
    WHERE trigger_schema = 'public'
    ORDER BY event_object_table, trigger_name;
  `);

  // 6. Constraints
  report.constraints = await runQuery(`
    SELECT 
      tc.table_name, 
      tc.constraint_name, 
      tc.constraint_type,
      pg_get_constraintdef(c.oid) AS definition
    FROM information_schema.table_constraints tc
    JOIN pg_constraint c ON c.conname = tc.constraint_name
    WHERE tc.table_schema = 'public'
    ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name;
  `);

  // 7. Indexes
  report.indexes = await runQuery(`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY tablename, indexname;
  `);

  // 8. RLS Policies
  report.policies = await runQuery(`
    SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname;
  `);

  // 9. Custom Types / Enums
  report.enums = await runQuery(`
    SELECT t.typname, e.enumlabel
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    ORDER BY t.typname, e.enumsortorder;
  `);

  // 10. Table row counts (Read-Only)
  report.rowCounts = await runQuery(`
    SELECT 
      (SELECT COUNT(*) FROM public.customers) AS customers_count,
      (SELECT COUNT(*) FROM public.orders) AS orders_count,
      (SELECT COUNT(*) FROM public.order_items) AS order_items_count,
      (SELECT COUNT(*) FROM public.payments) AS payments_count,
      (SELECT COUNT(*) FROM public.payment_allocations) AS payment_allocations_count,
      (SELECT COUNT(*) FROM public.financial_ledger) AS financial_ledger_count,
      (SELECT COUNT(*) FROM public.admins) AS admins_count,
      (SELECT COUNT(*) FROM public.device_types) AS device_types_count,
      (SELECT COUNT(*) FROM public.business_days) AS business_days_count,
      (SELECT COUNT(*) FROM public.processed_commands) AS processed_commands_count,
      (SELECT COUNT(*) FROM public.change_log) AS change_log_count,
      (SELECT COUNT(*) FROM public.system_settings) AS system_settings_count;
  `);

  // 11. System settings contents
  try {
    report.systemSettingsRows = await runQuery(`
      SELECT key, value_type, value_string, value_number, value_boolean, value_json, description
      FROM public.system_settings
      ORDER BY key;
    `);
  } catch (err) {
    report.systemSettingsError = err.message;
  }

  // 12. View definition of execute_canonical_sync_command & execute_sync_command
  report.functionDefs = await runQuery(`
    SELECT p.proname, pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' 
      AND p.proname IN ('execute_canonical_sync_command', 'execute_sync_command', 'reset_online_business_data', 'verify_admin_bin');
  `);

  fs.writeFileSync('online_db_inspection.json', JSON.stringify(report, null, 2));
  console.log('Inspection complete. Saved to online_db_inspection.json');
}

inspect().catch(err => {
  console.error('Inspection failed:', err);
  process.exit(1);
});
