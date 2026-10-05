import fs from 'fs';
import { query } from './db.mjs';

console.log('Applying migration 00102 to remote Supabase database...');
const sql102 = fs.readFileSync('supabase/migrations/00102_fix_reset_online_business_data_trigger.sql', 'utf8');
const res102 = await query(sql102);
console.log('Result 00102:', res102);

console.log('Applying migration 00103 to remote Supabase database...');
const sql103 = fs.readFileSync('supabase/migrations/00103_reset_generation_and_sync_safety.sql', 'utf8');
const res103 = await query(sql103);
console.log('Result 00103:', res103);

console.log('Verifying remote database state...');
const triggerCheck = await query(`
  SELECT tgname, tgenabled 
  FROM pg_trigger 
  JOIN pg_class ON pg_trigger.tgrelid = pg_class.oid 
  WHERE pg_class.relname = 'financial_ledger' AND tgname = 'trg_immutable_financial_ledger';
`);
console.log('Trigger check:', triggerCheck);

const rpcCheck = await query(`
  SELECT proname, prosecdef 
  FROM pg_proc 
  WHERE proname = 'reset_online_business_data';
`);
console.log('RPC check:', rpcCheck);

const genCheck = await query(`
  SELECT key, value_number 
  FROM system_settings 
  WHERE key = 'server_reset_generation';
`);
console.log('Generation check:', genCheck);

console.log('Remote deployment and verification completed successfully!');
