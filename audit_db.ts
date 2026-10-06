import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.error('Supabase URL or Key missing');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function runAudit() {
  console.log('--- 1. DATABASE METADATA ---');
  const { count: procCount, error: countError } = await supabase
    .from('processed_commands')
    .select('*', { count: 'exact', head: true });
  
  if (countError) {
    console.error('Failed to count processed_commands:', countError.message);
  } else {
    console.log(`Total rows in processed_commands: ${procCount}`);
  }

  const { data: allTypes } = await supabase
    .from('processed_commands')
    .select('command_type')
    .limit(100);
  
  if (allTypes) {
    const types = new Set(allTypes.map(t => t.command_type));
    console.log('Command types found in DB:', Array.from(types));
  }

  console.log('\n--- 2. SUSPICIOUS COMMANDS AUDIT ---');
  const suspiciousTypes = [
    'CREATE_PAYMENT', 'POST_PAYMENT', 'RECORD_PAYMENT',
    'CREATE_CUSTOMER_CREDIT', 'CONSUME_CUSTOMER_CREDIT', 'CREATE_REFUND',
    'CANCEL_ORDER', 'CANCEL_ORDER_ITEM',
    'CREATE_GOAL', 'UPDATE_GOAL_CONFIG', 'APPROVE_GOAL_REQUEST'
  ];

  const { data: processed, error: procError } = await supabase
    .from('processed_commands')
    .select('*')
    .in('command_type', suspiciousTypes)
    .order('created_at', { ascending: false });

  if (procError) {
    console.error('Failed to query suspicious commands:', procError.message);
  } else if (processed && processed.length > 0) {
    console.log(`Found ${processed.length} suspicious commands. Cross-checking...`);
    
    const results = [];

    for (const cmd of processed) {
      let mutationFound = 'UNKNOWN';
      let evidence = '';
      let classification = 'UNKNOWN';

      const cid = cmd.command_id;
      const type = cmd.command_type;

      if (type === 'CREATE_PAYMENT' || type === 'POST_PAYMENT' || type === 'RECORD_PAYMENT') {
        const { data: pay } = await supabase.from('payments').select('id').eq('command_id', cid).maybeSingle();
        const { data: ledg } = await supabase.from('financial_ledger').select('id').eq('reference_id', cid).maybeSingle();
        mutationFound = (pay || ledg) ? 'YES' : 'NO';
        evidence = pay ? 'Payment record exists.' : (ledg ? 'Ledger entry exists.' : 'No record in payments or ledger.');
      } 
      else if (type === 'CANCEL_ORDER') {
        const orderId = (cmd.result_payload as any)?.orderId || cid;
        const { data: order } = await supabase.from('orders').select('status, updated_at').eq('id', orderId).maybeSingle();
        mutationFound = (order?.status === 'cancelled') ? 'YES' : 'NO';
        evidence = `Order status: ${order?.status || 'NOT_FOUND'}. Updated at: ${order?.updated_at || 'N/A'}`;
      }
      else if (type === 'CANCEL_ORDER_ITEM') {
        const itemId = (cmd.result_payload as any)?.orderItemId || cid;
        const { data: item } = await supabase.from('order_items').select('status').eq('id', itemId).maybeSingle();
        mutationFound = (item?.status === 'cancelled') ? 'YES' : 'NO';
        evidence = `Item status: ${item?.status || 'NOT_FOUND'}`;
      }
      else if (type.includes('GOAL')) {
         const { data: goal } = await supabase.from('goals').select('id').eq('id', cid).maybeSingle();
         mutationFound = goal ? 'YES' : 'NO';
         evidence = goal ? 'Goal record exists.' : 'No goal record.';
      }

      const isSuccess = (cmd.result_payload as any)?.success !== false;
      if (isSuccess && mutationFound === 'NO') {
        classification = 'FALSE SUCCESS';
      } else if (isSuccess && mutationFound === 'YES') {
        classification = 'VALID SUCCESS';
      }

      results.push({
        command_id: cid,
        command_type: type,
        timestamp: cmd.created_at,
        aggregate_id: (cmd.result_payload as any)?.orderId || (cmd.result_payload as any)?.customerId || (cmd.result_payload as any)?.aggregateId || 'N/A',
        processed_result: JSON.stringify(cmd.result_payload),
        business_mutation_found: mutationFound,
        classification,
        evidence
      });
    }

    console.log('\n--- 5. AFFECTED COMMAND TABLE ---');
    console.table(results);
  } else {
    console.log('No suspicious commands found in processed_commands.');
  }

  console.log('\n--- 7. BACKUP COVERAGE AUDIT ---');
  const tablesToCheck = [
    'processed_commands', 'change_log', 'audit_logs', 'sync_queue',
    'payments', 'payment_allocations', 'financial_ledger',
    'personal_financial_transactions', 'qr_payment_submissions',
    'notifications', 'customer_activity', 'customer_requests',
    'devices', 'events', 'system_settings', 'business_days',
    'customers', 'orders', 'order_items', 'qr_tokens',
    'goals', 'goal_requests', 'backup_checkpoints'
  ];

  const backupTablesIn00116 = [
    'system_settings', 'customers', 'device_types', 'business_days',
    'qr_tokens', 'orders', 'order_items', 'payments',
    'payment_allocations', 'financial_ledger', 'goals', 'goal_requests'
  ];

  for (const table of tablesToCheck) {
    const { error } = await supabase.from(table).select('*', { count: 'exact', head: true });
    const exists = !error || (error.code !== '42P01' && error.code !== 'PGRST116');
    const captured = backupTablesIn00116.includes(table);
    console.log(`${table.padEnd(35)} | Exists: ${exists ? 'YES' : 'NO'} | Captured: ${captured ? 'YES' : 'NO'}`);
  }
}

runAudit();
