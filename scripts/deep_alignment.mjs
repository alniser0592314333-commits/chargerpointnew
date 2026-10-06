import { query } from './db.mjs';

async function deepAlign() {
  console.log('--- STARTING DEEP ALIGNMENT (RECONSTRUCTING CONTRACT) ---');

  try {
    await query('BEGIN');

    // 1. Drop all existing RLS policies
    console.log('Dropping all RLS policies...');
    const policies = await query("SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'");
    for (const p of policies) {
      await query('DROP POLICY IF EXISTS "' + p.policyname + '" ON public."' + p.tablename + '"');
    }

    // 2. Drop all triggers
    console.log('Dropping all triggers...');
    const triggers = await query("SELECT event_object_table, trigger_name FROM information_schema.triggers WHERE trigger_schema = 'public'");
    for (const t of triggers) {
      await query('DROP TRIGGER IF EXISTS "' + t.trigger_name + '" ON public."' + t.event_object_table + '"');
    }

    // 3. Drop empty core tables to allow clean recreation
    console.log('Dropping empty business tables...');
    const tablesToDrop = [
      'order_items', 'orders', 'payments', 'payment_allocations', 'financial_ledger',
      'customers', 'business_days', 'goals', 'goal_requests', 'qr_tokens',
      'order_number_reservations', 'processed_commands', 'change_log', 'audit_logs',
      'qr_payment_submissions', 'notifications', 'customer_requests',
      'customer_push_subscriptions', 'customer_delivery_push_logs', 'customer_activity',
      'events', 'personal_financial_transactions', 'sync_conflicts', 'app_devices'
    ];
    for (const t of tablesToDrop) {
      await query('DROP TABLE IF EXISTS public."' + t + '" CASCADE');
    }

    // 4. Align non-empty tables
    console.log('Aligning persistent tables (admins, settings)...');
    
    // admins
    const adminCols = await query("SELECT column_name FROM information_schema.columns WHERE table_name = 'admins'");
    const adminColNames = adminCols.map(c => c.column_name);
    if (!adminColNames.includes('permissions')) {
      await query("ALTER TABLE public.admins ADD COLUMN permissions text[] NOT NULL DEFAULT '{}'");
    }
    // Ensurerole is text
    await query("ALTER TABLE public.admins ALTER COLUMN role TYPE text");
    
    // 5. Apply final_schema.sql to recreate tables and functions
    console.log('Deep alignment complete. Now run apply_final_schema.mjs to restore everything.');

    await query('COMMIT');
  } catch (err) {
    await query('ROLLBACK');
    console.error('Deep alignment failed:', err);
    process.exit(1);
  }
}

deepAlign();
