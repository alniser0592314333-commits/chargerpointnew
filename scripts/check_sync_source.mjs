import { query } from './db.mjs';

async function checkSource() {
    const rpc = await query(`
        SELECT prosrc
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'execute_sync_command'
    `);
    if (rpc.length > 0) {
        console.log('--- execute_sync_command SOURCE ---');
        console.log(rpc[0].prosrc);
    } else {
        console.log('execute_sync_command NOT FOUND');
    }
}

checkSource();
