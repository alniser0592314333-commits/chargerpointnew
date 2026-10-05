import { query } from './db.mjs';

async function checkDeliver() {
  const fnDef = await query(`
    SELECT pg_get_functiondef(p.oid) as definition
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE p.proname = 'execute_canonical_sync_command' AND n.nspname = 'public'
  `);
  const def = fnDef[0]?.definition || '';
  const deliverIdx = def.indexOf("WHEN 'DELIVER_ORDER_ITEM'");
  const cancelIdx = def.indexOf("WHEN 'CANCEL_ORDER_ITEM'");
  console.log(def.substring(deliverIdx, cancelIdx));
}

checkDeliver();
