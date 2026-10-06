import fs from 'fs';
import pkg from 'pg';
const { Client } = pkg;

async function applyRPC() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres'
  });
  await client.connect();

  const sql = fs.readFileSync('supabase/final_schema.sql', 'utf8');
  const startMarker = 'create or replace function public.execute_sync_command(';
  const endMarker = '$$;';
  
  const startIdx = sql.indexOf(startMarker);
  const endIdx = sql.indexOf(endMarker, startIdx) + endMarker.length;
  
  const rpcSql = sql.substring(startIdx, endIdx);
  
  try {
    console.log('Attempting to apply execute_sync_command...');
    await client.query(rpcSql);
    console.log('Success!');
  } catch (err) {
    console.error('ERROR:', err.message);
    console.error('CODE:', err.code);
    console.error('POSITION:', err.position);
    if (err.position) {
      const pos = parseInt(err.position, 10);
      console.error('CONTEXT:', rpcSql.substring(Math.max(0, pos - 50), Math.min(rpcSql.length, pos + 50)));
    }
  } finally {
    await client.end();
  }
}

applyRPC();
