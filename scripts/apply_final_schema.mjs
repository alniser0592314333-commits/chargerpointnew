import fs from 'fs';
import { query } from './db.mjs';

async function apply() {
  console.log('Applying authoritative supabase/final_schema.sql...');
  try {
    const sql = fs.readFileSync('supabase/final_schema.sql', 'utf8');
    
    // We should split by ';' but be careful with functions.
    // However, the DB driver might support multiple statements if we send them together.
    // Let's try sending it as one big block if it's not too huge.
    
    await query(sql);
    
    console.log('final_schema.sql applied successfully.');
  } catch (err) {
    console.error('Failed to apply final_schema.sql:', err);
    process.exit(1);
  }
}

apply();
