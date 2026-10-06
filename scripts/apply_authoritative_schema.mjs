import fs from 'fs';
import { query } from './db.mjs';

async function main() {
  console.log('Authoritative Alignment v9');
  
  // Ensure extensions are in public
  console.log('Enabling extensions...');
  try {
    await query('CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public');
    await query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA public');
  } catch (e) {
    console.warn('Extension enable warning:', e.message);
  }

  const sql = fs.readFileSync('supabase/final_schema.sql', 'utf8');
  
  // Strip comments and handle splitting
  const lines = sql.split('\n');
  const cleanLines = lines.map(line => {
    const commentIdx = line.indexOf('--');
    if (commentIdx !== -1) return line.substring(0, commentIdx);
    return line;
  });
  
  const cleanSql = cleanLines.join('\n');
  
  const statements = [];
  let current = '';
  let activeTag = null;
  let inSingleQuote = false;
  
  for (let i = 0; i < cleanSql.length; i++) {
    const char = cleanSql[i];
    
    if (char === "'" && !activeTag) {
      if (cleanSql[i-1] !== '\\') {
        inSingleQuote = !inSingleQuote;
      }
    }
    
    if (char === '$' && !inSingleQuote) {
      let j = i + 1;
      while (j < cleanSql.length && /[a-zA-Z0-9_]/.test(cleanSql[j])) j++;
      if (cleanSql[j] === '$') {
        const tag = cleanSql.substring(i, j + 1);
        if (activeTag === tag) {
          activeTag = null;
        } else if (!activeTag) {
          activeTag = tag;
        }
        current += tag;
        i = j;
        continue;
      }
    }
    
    current += char;
    
    if (char === ';' && !activeTag && !inSingleQuote) {
      statements.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) statements.push(current.trim());

  console.log('Found ' + statements.length + ' clean statements.');

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    if (!stmt || stmt.toLowerCase().startsWith('begin') || stmt.toLowerCase().startsWith('commit')) continue;
    
    try {
      await query(stmt);
    } catch (err) {
      if (err.message.includes('already exists') || err.message.includes('already a member')) continue;
      
      if (err.message.includes('Use DROP FUNCTION')) {
        const match = err.message.match(/Use DROP FUNCTION ([a-zA-Z0-9_]+\([^\)]*\))/);
        if (match) {
           await query('DROP FUNCTION IF EXISTS public.' + match[1] + ' CASCADE');
           await query(stmt);
           continue;
        }
      }
      console.warn('Error in statement ' + (i+1) + ': ' + err.message);
      // console.warn('Content:', stmt.substring(0, 100));
    }
  }
  console.log('Done.');
}
main();
