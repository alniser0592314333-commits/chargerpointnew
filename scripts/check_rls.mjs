import { query } from './db.mjs';

async function checkRLS() {
    console.log('--- RLS POLICIES ---');
    const policies = await query(`
        SELECT tablename, policyname, roles, cmd, qual
        FROM pg_policies
        WHERE schemaname = 'public'
    `);
    console.log(JSON.stringify(policies, null, 2));
}

checkRLS();
