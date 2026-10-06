import { query } from './db.mjs';

async function align() {
  console.log('Starting Code <-> Database Contract Alignment Audit & Repair...');

  try {
    await query('BEGIN');

    // 1. Drop extra/legacy triggers that might conflict
    console.log('Cleaning up legacy triggers...');
    const legacyTriggers = await query(`
      SELECT event_object_table, trigger_name 
      FROM information_schema.triggers 
      WHERE trigger_schema = 'public' AND trigger_name LIKE 'trg_log_%'
    `);
    for (const t of legacyTriggers) {
      await query('DROP TRIGGER IF EXISTS "' + t.trigger_name + '" ON public."' + t.event_object_table + '"');
    }

    // 2. Fix column types (Enum -> Text, Integer -> Bigint)
    console.log('Fixing column types...');
    
    // orders
    await query('ALTER TABLE public.orders ALTER COLUMN status TYPE text USING status::text');
    await query('ALTER TABLE public.orders ALTER COLUMN customer_balance_snapshot_minor TYPE bigint');
    
    // order_items
    await query('ALTER TABLE public.order_items ALTER COLUMN status TYPE text USING status::text');
    await query('ALTER TABLE public.order_items ALTER COLUMN base_price_snapshot_minor TYPE bigint');
    await query('ALTER TABLE public.order_items ALTER COLUMN charger_fee_snapshot_minor TYPE bigint');
    await query('ALTER TABLE public.order_items ALTER COLUMN unit_price_minor TYPE bigint');
    await query('ALTER TABLE public.order_items ALTER COLUMN total_price_minor TYPE bigint');
    await query('ALTER TABLE public.order_items ALTER COLUMN discount_snapshot_minor TYPE bigint');
    await query('ALTER TABLE public.order_items ALTER COLUMN final_charge_snapshot_minor TYPE bigint');

    // customers
    await query('ALTER TABLE public.customers ALTER COLUMN debt_limit_minor TYPE bigint');

    // processed_commands (align with final_schema)
    console.log('Aligning processed_commands schema...');
    // Add missing columns if they don't exist
    const procCols = await query("SELECT column_name FROM information_schema.columns WHERE table_name = 'processed_commands'");
    const colNames = procCols.map(c => c.column_name);
    
    if (!colNames.includes('aggregate_type')) await query('ALTER TABLE public.processed_commands ADD COLUMN aggregate_type text');
    if (!colNames.includes('aggregate_id')) await query('ALTER TABLE public.processed_commands ADD COLUMN aggregate_id uuid');
    if (!colNames.includes('device_id')) await query('ALTER TABLE public.processed_commands ADD COLUMN device_id uuid');
    
    // 3. Drop legacy enums (since we converted columns to text)
    console.log('Dropping legacy enums...');
    await query('DROP TYPE IF EXISTS public.order_status CASCADE');
    await query('DROP TYPE IF EXISTS public.item_status CASCADE');
    await query('DROP TYPE IF EXISTS public.user_role CASCADE');
    await query('DROP TYPE IF EXISTS public.customer_status CASCADE');
    await query('DROP TYPE IF EXISTS public.device_status CASCADE');

    // 4. Rename or create missing core tables
    console.log('Ensuring core tables exist...');
    // app_devices -> devices (if app_devices exists and devices doesn't)
    const tables = await query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    const tableNames = tables.map(t => t.table_name);
    
    if (tableNames.includes('app_devices') && !tableNames.includes('devices')) {
      await query('ALTER TABLE public.app_devices RENAME TO devices');
    }

    await query('COMMIT');
    console.log('Pre-alignment complete. Now running authoritative final_schema.sql...');
  } catch (err) {
    await query('ROLLBACK');
    console.error('Alignment failed:', err);
    process.exit(1);
  }
}

align();
