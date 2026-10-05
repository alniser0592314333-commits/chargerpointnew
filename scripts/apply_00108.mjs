import fs from 'fs';
import { query } from './db.mjs';

const sql = fs.readFileSync('supabase/migrations/00108_fix_device_type_commands_in_rpc.sql', 'utf8');

console.log('Applying migration 00108 to Supabase PostgreSQL database...');
const res = await query(sql);
console.log('Migration response:', res);
console.log('Migration 00108 applied successfully!');
