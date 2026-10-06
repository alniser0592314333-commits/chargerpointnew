import fs from 'fs';

function splitSql(sql) {
  const statements = [];
  let current = '';
  let activeTag = null;
  let inSingleQuote = false;
  
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    
    if (char === "'" && !activeTag) {
      if (sql[i-1] !== '\\') {
        inSingleQuote = !inSingleQuote;
      }
    }
    
    if (char === '$' && !inSingleQuote) {
      let j = i + 1;
      while (j < sql.length && /[a-zA-Z0-9_]/.test(sql[j])) j++;
      if (sql[j] === '$') {
        const tag = sql.substring(i, j + 1);
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
  return statements;
}

const sql = fs.readFileSync('supabase/final_schema.sql', 'utf8');
const stmts = splitSql(sql);
stmts.forEach((s, i) => {
  if (s.toLowerCase().includes('do $$') || s.toLowerCase().includes('create function')) {
    console.log('STMT ' + (i+1) + ' length: ' + s.length);
    console.log('STMT ' + (i+1) + ' starts: ' + s.substring(0, 50).replace(/\n/g, ' '));
    console.log('STMT ' + (i+1) + ' ends: ' + s.substring(s.length - 50).replace(/\n/g, ' '));
    console.log('---');
  }
});
