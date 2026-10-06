import fs from 'fs';
import { query } from './db.mjs';

async function main() {
  const sql = fs.readFileSync('supabase/final_schema.sql', 'utf8');
  // Extract execute_sync_command block
  const start = sql.indexOf('create or replace function public.execute_sync_command');
  const end = sql.indexOf('$$;', start) + 4;
  const funcSql = sql.substring(start, end);
  
  console.log('Applying execute_sync_command...');
  try {
    await query(funcSql);
    console.log('Success!');
  } catch (err) {
    console.error('Failed:', err.message);
  }
}
main();
