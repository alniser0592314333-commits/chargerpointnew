import { query } from './db.mjs';

async function gatherEvidence() {
  console.log("=== 1. Migration History ===");
  const migs = await query("SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = '00107'");
  console.log("Migration 00107 in history:", migs);

  console.log("=== 2. System Setting ===");
  const setting = await query("SELECT * FROM public.system_settings WHERE key = 'default_charger_fee_minor'");
  console.log("System setting:", setting);

  console.log("=== 3. RPC Overloads ===");
  const overloads = await query(`
    SELECT n.nspname as schema, p.proname as name, pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as result
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE p.proname = 'execute_canonical_sync_command'
  `);
  console.log("Overloads count:", overloads.length);
  console.log("Overloads details:", overloads);

  console.log("=== 4 & 5. Function Definition Snippet (DELIVER_ORDER_ITEM) ===");
  const fnDef = await query(`
    SELECT pg_get_functiondef(p.oid) as definition
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE p.proname = 'execute_canonical_sync_command' AND n.nspname = 'public'
  `);
  const def = fnDef[0]?.definition || '';
  const hasSnapshotRead = def.includes('final_charge_snapshot_minor');
  const hasDeviceTypeRecalc = def.includes('FROM public.device_types') && def.includes('DELIVER_ORDER_ITEM');
  const hasOrderItemCharge = def.includes("'ORDER_ITEM_CHARGE'");
  const hasLegacyCharge = def.includes("'CHARGE'");

  console.log("Has snapshot read:", hasSnapshotRead);
  console.log("Has device type recalc in delivery:", hasDeviceTypeRecalc);
  console.log("Has ORDER_ITEM_CHARGE:", hasOrderItemCharge);
  console.log("Has legacy CHARGE in delivery:", hasLegacyCharge);

  console.log("=== 8. Ledger Protection Triggers ===");
  const triggers = await query(`
    SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.financial_ledger'::regclass
  `);
  console.log("Ledger triggers:", triggers);

  const rules = await query(`
    SELECT rulename FROM pg_rules WHERE tablename = 'financial_ledger'
  `);
  console.log("Ledger rules:", rules);
}

gatherEvidence();
