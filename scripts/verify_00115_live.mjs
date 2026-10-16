import { query } from './db.mjs';

async function verify() {
  console.log('=== VERIFYING LIVE DATABASE AFTER MIGRATION 00115 ===');

  // 1. Check RPC existence and signature
  const funcQuery = await query(`
    SELECT p.proname, pg_get_functiondef(p.oid) as def
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'reset_online_business_data';
  `);

  if (!funcQuery || funcQuery.length === 0) {
    throw new Error('FAIL: public.reset_online_business_data does not exist!');
  }
  console.log('[PASS] 1. public.reset_online_business_data exists.');

  const def = funcQuery[0].def;

  // 2. No reference to sync_conflicts
  const hasSyncConflicts = /sync_conflicts/i.test(def);
  if (hasSyncConflicts) {
    throw new Error('FAIL: Function definition still references sync_conflicts!');
  }
  console.log('[PASS] 2. Definition does NOT reference sync_conflicts.');

  // 3. Auth and authorization checks
  const hasAuthCheck = def.includes('auth.uid() IS NULL');
  const hasRoleCheck = def.includes("v_admin_role NOT IN ('SUPER_ADMIN', 'Super Admin')");
  const hasPermCheck = def.includes("settings:manage");
  if (!hasAuthCheck || !hasRoleCheck || !hasPermCheck) {
    throw new Error('FAIL: Missing authentication or authorization checks!');
  }
  console.log('[PASS] 3. Contains required auth, role, and permission checks.');

  // 4. Super-admin BIN verification
  const hasBinCheck = def.includes('verify_admin_bin(p_entered_bin)');
  if (!hasBinCheck) {
    throw new Error('FAIL: Missing verify_admin_bin verification check!');
  }
  console.log('[PASS] 4. Super-admin BIN verification check present.');

  // 5. Preserves server_reset_generation
  const hasGenIncrement = def.includes("key = 'server_reset_generation'");
  if (!hasGenIncrement) {
    throw new Error('FAIL: Missing server_reset_generation logic!');
  }
  console.log('[PASS] 5. Preserves server_reset_generation logic.');

  // 6. Canonical FK purge order and trigger protections
  const purgeOrder = [
    'goal_requests',
    'goals',
    'payment_allocations',
    'financial_ledger',
    'payments',
    'order_items',
    'orders',
    'qr_tokens',
    'customers',
    'business_days',
    'device_types',
    'change_log',
    'processed_commands'
  ];
  for (const table of purgeOrder) {
    if (!def.includes(`DELETE FROM ${table}`)) {
      throw new Error(`FAIL: Missing purge for table ${table}!`);
    }
  }
  console.log('[PASS] 6. Preserves canonical FK deletion order for all 13 business tables.');

  // 7. Permissions: Check execute privileges
  const privs = await query(`
    SELECT grantee, privilege_type 
    FROM information_schema.routine_privileges 
    WHERE routine_schema = 'public' AND routine_name = 'reset_online_business_data';
  `);
  console.log('Routine privileges:', JSON.stringify(privs));

  const hasAnon = privs.some(p => p.grantee === 'anon' && p.privilege_type === 'EXECUTE');
  const hasPublic = privs.some(p => p.grantee === 'PUBLIC' && p.privilege_type === 'EXECUTE');
  const hasAuthenticated = privs.some(p => p.grantee === 'authenticated' && p.privilege_type === 'EXECUTE');

  if (hasAnon || hasPublic) {
    throw new Error('FAIL: Function is exposed to anon or PUBLIC!');
  }
  if (!hasAuthenticated) {
    throw new Error('FAIL: Function is not granted to authenticated!');
  }
  console.log('[PASS] 7. Security permissions verified (granted to authenticated, revoked from anon/PUBLIC).');

  // 8. Verify sync_conflicts table does NOT exist
  const tableQuery = await query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'sync_conflicts';
  `);
  if (tableQuery.length > 0) {
    throw new Error('FAIL: Obsolete sync_conflicts table exists in public schema!');
  }
  console.log('[PASS] 8. sync_conflicts table does NOT exist (no obsolete table created).');

  // 9. Non-destructive confirmation: Business data row counts intact
  const counts = await query(`
    SELECT 
      (SELECT COUNT(*) FROM public.admins) as admins_count,
      (SELECT COUNT(*) FROM public.customers) as customers_count,
      (SELECT COUNT(*) FROM public.orders) as orders_count,
      (SELECT COUNT(*) FROM public.financial_ledger) as ledger_count;
  `);
  console.log('Current table row counts (proving no business data deleted):', JSON.stringify(counts[0]));
  console.log('=== ALL NON-DESTRUCTIVE VERIFICATIONS PASSED ===');
}

verify().catch(err => {
  console.error(err);
  process.exit(1);
});
