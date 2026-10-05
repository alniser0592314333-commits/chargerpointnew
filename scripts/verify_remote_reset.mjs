import { query } from './db.mjs';

console.log('Testing normal financial ledger append-only protection (should fail)...');
try {
  const updateRes = await query(`UPDATE financial_ledger SET amount_minor = 999 WHERE true;`);
  console.log('Update result (unexpected if protected):', updateRes);
} catch (e) {
  console.log('Update successfully blocked:', e);
}

try {
  const deleteRes = await query(`DELETE FROM financial_ledger WHERE true;`);
  console.log('Delete result (unexpected if protected):', deleteRes);
} catch (e) {
  console.log('Delete successfully blocked:', e);
}

const triggerStatus = await query(`
  SELECT tgname, tgenabled 
  FROM pg_trigger 
  JOIN pg_class ON pg_trigger.tgrelid = pg_class.oid 
  WHERE pg_class.relname = 'financial_ledger' AND tgname = 'trg_immutable_financial_ledger';
`);
console.log('Trigger status outside reset:', triggerStatus);

const genRecord = await query(`
  SELECT key, value_number 
  FROM system_settings 
  WHERE key = 'server_reset_generation';
`);
console.log('Server reset generation record:', genRecord);

console.log('Remote verification script completed.');
