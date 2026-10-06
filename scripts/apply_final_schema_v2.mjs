import fs from 'fs';
import { query } from './db.mjs';

async function apply() {
  console.log('Applying authoritative supabase/final_schema.sql (no transaction wrapping)...');
  try {
    let sql = fs.readFileSync('supabase/final_schema.sql', 'utf8');
    
    // Remove begin/commit to let the driver handle it or manage it ourselves
    sql = sql.replace(/^begin;/im, '');
    sql = sql.replace(/^commit;/im, '');
    
    await query(sql);
    
    console.log('final_schema.sql applied successfully.');
  } catch (err) {
    console.error('Failed to apply final_schema.sql:', err);
    process.exit(1);
  }
}

apply();
