import { query } from './db.mjs';

async function audit() {
    console.log('--- DATABASE AUDIT ---');

    console.log('\n[Tables & Columns]');
    const tables = await query(`
        SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position
    `);
    
    const tableMap = {};
    tables.forEach(row => {
        if (!tableMap[row.table_name]) tableMap[row.table_name] = [];
        tableMap[row.table_name].push(`${row.column_name} (${row.data_type})${row.is_nullable === 'NO' ? ' NOT NULL' : ''}${row.column_default ? ' DEFAULT ' + row.column_default : ''}`);
    });
    
    for (const [table, cols] of Object.entries(tableMap)) {
        console.log(`Table: ${table}`);
        cols.forEach(c => console.log(`  - ${c}`));
    }

    console.log('\n[RPCs / Functions]');
    const functions = await query(`
        SELECT proname, proargnames, proargtypes, n.nspname as schema
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
        ORDER BY proname
    `);
    
    // To resolve type OIDs to names
    const types = await query(`SELECT oid, typname FROM pg_type`);
    const typeMap = {};
    types.forEach(t => typeMap[t.oid] = t.typname);

    functions.forEach(f => {
        const argTypes = f.proargtypes ? f.proargtypes.split(' ').map(oid => typeMap[oid] || oid).join(', ') : '';
        console.log(`Function: ${f.proname}(${f.proargnames ? f.proargnames.join(', ') : argTypes}) [Types: ${argTypes}]`);
    });

    console.log('\n[Enums]');
    const enums = await query(`
        SELECT t.typname as enum_name, e.enumlabel as enum_value
        FROM pg_type t
        JOIN pg_enum e ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
        ORDER BY enum_name, e.enumsortorder
    `);
    const enumMap = {};
    enums.forEach(row => {
        if (!enumMap[row.enum_name]) enumMap[row.enum_name] = [];
        enumMap[row.enum_name].push(row.enum_value);
    });
    for (const [name, vals] of Object.entries(enumMap)) {
        console.log(`Enum: ${name} { ${vals.join(', ')} }`);
    }
}

audit();
