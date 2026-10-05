import fs from 'fs';
import { query } from './db.mjs';

const sql = fs.readFileSync('supabase/migrations/00109_fix_execute_sync_command_wrapper.sql', 'utf8');

console.log('Applying migration 00109 to Supabase PostgreSQL database...');
const res = await query(sql);
console.log('Migration response:', res);
console.log('Migration 00109 applied successfully!');
