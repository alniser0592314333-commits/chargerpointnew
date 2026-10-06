import fs from 'fs';

const token = process.env.SUPABASE_ACCESS_TOKEN;
const projectId = process.env.SUPABASE_PROJECT_REF;
if (!projectId) { console.error('Missing SUPABASE_PROJECT_REF'); process.exit(1); }

if (!token) {
  console.error('Missing SUPABASE_ACCESS_TOKEN');
  process.exit(1);
}

const sql = fs.readFileSync('supabase/migrations/00100_canonical_architecture_baseline.sql', 'utf8');

console.log('Sending canonical migration to Supabase PostgreSQL database...');

const res = await fetch(`https://api.supabase.com/v1/projects/${projectId}/database/query`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ query: sql }),
});

const resText = await res.text();
console.log('Status:', res.status, res.statusText);
console.log('Response:', resText);

if (!res.ok) {
  process.exit(1);
}
console.log('Migration applied successfully!');
