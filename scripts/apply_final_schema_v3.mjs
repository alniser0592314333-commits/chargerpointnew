import fs from 'fs';
import { query } from './db.mjs';

async function apply() {
  console.log('Applying authoritative supabase/final_schema.sql statement by statement...');
  try {
    const sql = fs.readFileSync('supabase/final_schema.sql', 'utf8');
    
    // Simple split by ; but try to handle $$ blocks
    const statements = [];
    let current = '';
    let inDollar = false;
    
    const lines = sql.split('\n');
    for (const line of lines) {
      if (line.includes('$$')) inDollar = !inDollar;
      current += line + '\n';
      if (!inDollar && line.trim().endsWith(';')) {
        statements.push(current.trim());
        current = '';
      }
    }
    if (current.trim()) statements.push(current.trim());

    console.log(`Found ${statements.length} statements.`);

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      if (!stmt || stmt.toLowerCase() === 'begin;' || stmt.toLowerCase() === 'commit;') continue;
      try {
        await query(stmt);
      } catch (err) {
        console.warn(`Error in statement ${i + 1}:`, err.message);
        // Continue if it's "already exists" error
        if (!err.message.includes('already exists')) {
           // throw err; // Actually, let's just log and continue to see how far we get
        }
      }
    }
    
    console.log('Finished applying statements.');
  } catch (err) {
    console.error('Failed to apply final_schema.sql:', err);
    process.exit(1);
  }
}

apply();
