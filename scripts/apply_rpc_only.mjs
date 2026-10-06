import fs from 'fs';
import { query } from './db.mjs';

async function applyRPC() {
  const sql = fs.readFileSync('supabase/final_schema.sql', 'utf8');
  const startMarker = 'create or replace function public.execute_sync_command(';
  const endMarker = '$$;';
  
  const startIdx = sql.indexOf(startMarker);
  // Find the end marker AFTER the start marker
  const endIdx = sql.indexOf(endMarker, startIdx) + endMarker.length;
  
  if (startIdx === -1) {
    console.error('Start marker not found');
    return;
  }
  
  const rpcSql = sql.substring(startIdx, endIdx);
  console.log('Extracting RPC SQL (length:', rpcSql.length, ')');
  
  try {
    await query(rpcSql);
    console.log('execute_sync_command applied successfully.');
  } catch (err) {
    console.error('Failed to apply execute_sync_command:', err.message);
    if (err.details) console.error('Details:', err.details);
    if (err.hint) console.error('Hint:', err.hint);
  }
}

applyRPC();
