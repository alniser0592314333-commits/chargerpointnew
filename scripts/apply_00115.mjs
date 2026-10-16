import fs from 'fs';
import { query, project } from './db.mjs';

console.log(`Target database project: ${project}`);
const sql = fs.readFileSync('supabase/migrations/00115_remove_legacy_sync_conflicts_from_online_reset.sql', 'utf8');
console.log('Applying Migration 00115: Remove legacy sync_conflicts dependency from reset_online_business_data...');
const result = await query(sql);
console.log('Migration 00115 applied successfully. Result:', result);
