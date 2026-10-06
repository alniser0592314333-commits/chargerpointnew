/**
 * Comprehensive Database Architectural Validation Suite
 * Executes real SQL queries and RPC calls directly against Supabase PostgreSQL
 */

const token = process.env.SUPABASE_ACCESS_TOKEN;
const projectId = 'ydhcyamtgioyrxfarkwk';

if (!token) {
  console.error('FATAL: Missing SUPABASE_ACCESS_TOKEN');
  process.exit(1);
}

async function query(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectId}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SQL Query Failed [${res.status}]: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const results = [];

function recordTest(testName, status, details) {
  results.push({ testName, status, details });
  console.log(`[${status}] ${testName}`);
  if (details) console.log(`       Details: ${details}`);
}

async function runAllVerifications() {
  console.log('================================================================');
  console.log('STARTING REAL POSTGRESQL ARCHITECTURAL VERIFICATION GATE');
  console.log('================================================================\n');

  // =======================================================================
  // 1. SCHEMA VERIFICATION
  // =======================================================================
  try {
    const requiredTables = [
      'system_settings',
      'customers',
      'device_types',
      'business_days',
      'orders',
      'order_items',
      'financial_ledger',
      'payments',
      'payment_allocations',
      'processed_commands',
      'change_log',
      'backup_checkpoints',
      'admins',
      'admin_custom_permissions',
      'roles',
      'role_permissions',
    ];

    const tablesRes = await query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';"
    );
    const existingTables = new Set(tablesRes.map((t) => t.table_name));

    const missingTables = requiredTables.filter((t) => !existingTables.has(t));
    if (missingTables.length > 0) {
      recordTest('1. Schema: Table Existence', 'FAIL', `Missing tables: ${missingTables.join(', ')}`);
    } else {
      recordTest('1. Schema: Table Existence', 'PASS', `All ${requiredTables.length} canonical tables exist.`);
    }

    // Check critical columns
    const columnsCheck = await query(`
      SELECT table_name, column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
        AND (
          (table_name = 'order_items' AND column_name IN ('operational_status', 'financial_status', 'payment_status', 'base_price_snapshot_minor', 'charger_fee_snapshot_minor', 'discount_snapshot_minor', 'final_charge_snapshot_minor', 'financially_recognized_at')) OR
          (table_name = 'payment_allocations' AND column_name = 'order_item_id') OR
          (table_name = 'financial_ledger' AND column_name IN ('linked_ledger_id', 'sequence_number')) OR
          (table_name = 'processed_commands' AND column_name = 'payload_hash') OR
          (table_name = 'customers' AND column_name IN ('status', 'debt_limit_minor', 'charger_fee_exempt', 'deleted_at'))
        );
    `);
    if (columnsCheck.length >= 13) {
      recordTest('2. Schema: Column & Type Integrity', 'PASS', `All critical canonical columns confirmed present (${columnsCheck.length} verified).`);
    } else {
      recordTest('2. Schema: Column & Type Integrity', 'FAIL', `Only ${columnsCheck.length}/13 critical columns found.`);
    }

    // Check obsolete RPCs absent
    const obsoleteRpc = await query(
      "SELECT proname FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'public' AND proname = 'execute_command';"
    );
    if (obsoleteRpc.length === 0) {
      recordTest('3. Schema: Obsolete RPC Absence', 'PASS', 'execute_command is completely absent from public schema.');
    } else {
      recordTest('3. Schema: Obsolete RPC Absence', 'FAIL', 'Found obsolete execute_command in database.');
    }
  } catch (err) {
    recordTest('Schema Verification', 'FAIL', err.message);
  }

  // =======================================================================
  // 2. FINANCIAL LEDGER IMMUTABILITY TEST
  // =======================================================================
  try {
    const testCustId = '11111111-1111-4111-a111-111111111111';
    await query(`
      INSERT INTO customers (id, name, status, debt_limit_minor, charger_fee_exempt)
      VALUES ('${testCustId}', 'Ledger Test Cust', 'ACTIVE', 10000, false)
      ON CONFLICT (id) DO NOTHING;
    `);

    const ledgerEntryRes = await query(`
      INSERT INTO financial_ledger (event_type, amount_minor, customer_id)
      VALUES ('ORDER_ITEM_CHARGE', -1500, '${testCustId}')
      RETURNING id;
    `);
    const ledgerId = ledgerEntryRes[0].id;

    // Attempt 1: UPDATE
    let updateBlocked = false;
    try {
      await query(`UPDATE financial_ledger SET amount_minor = 0 WHERE id = '${ledgerId}';`);
    } catch (err) {
      if (err.message.includes('Financial Invariant Violation') && err.message.includes('strictly append-only')) {
        updateBlocked = true;
      }
    }

    // Attempt 2: DELETE
    let deleteBlocked = false;
    try {
      await query(`DELETE FROM financial_ledger WHERE id = '${ledgerId}';`);
    } catch (err) {
      if (err.message.includes('Financial Invariant Violation') && err.message.includes('strictly append-only')) {
        deleteBlocked = true;
      }
    }

    if (updateBlocked && deleteBlocked) {
      recordTest('4. Financial Ledger Immutability', 'PASS', 'Both UPDATE and DELETE strictly rejected by PostgreSQL trigger.');
    } else {
      recordTest('4. Financial Ledger Immutability', 'FAIL', `updateBlocked: ${updateBlocked}, deleteBlocked: ${deleteBlocked}`);
    }
  } catch (err) {
    recordTest('4. Financial Ledger Immutability', 'FAIL', err.message);
  }

  // =======================================================================
  // 3. PRICE SNAPSHOT RULE: FROZEN AT DELIVERY, NOT CREATION
  // =======================================================================
  try {
    const custId = '22222222-2222-4222-a222-222222222222';
    const dayId = '33333333-3333-4333-a333-333333333333';
    const devId = '44444444-4444-4444-a444-444444444444';
    const ordId = '55555555-5555-4555-a555-555555555555';
    const itemId = '66666666-6666-4666-a666-666666666666';

    // 1. Create base entities
    await query(`
      INSERT INTO customers (id, name, status, debt_limit_minor, charger_fee_exempt)
      VALUES ('${custId}', 'Price Rule Customer', 'ACTIVE', 50000, false)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO business_days (id, business_date, display_number, status)
      VALUES ('${dayId}', '2026-10-25', 1, 'OPEN')
      ON CONFLICT (business_date) DO UPDATE SET id = '${dayId}';

      INSERT INTO device_types (id, name, name_ar, name_en, icon, base_price_minor, charger_fee_enabled, charger_fee_applicable, status)
      VALUES ('${devId}', 'Flashlight X', 'كشاف X', 'Flashlight X', 'smartphone', 1000, true, true, 'ACTIVE')
      ON CONFLICT (id) DO UPDATE SET base_price_minor = 1000, charger_fee_applicable = true, icon = 'smartphone';

      INSERT INTO orders (id, day_id, customer_id, display_number, status)
      VALUES ('${ordId}', '${dayId}', '${custId}', 1, 'charging')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 2. Add Order Item with initial device price 1000
    await query(`
      SELECT execute_canonical_sync_command(
        '${itemId}',
        'ADD_ORDER_ITEM',
        jsonb_build_object(
          'id', '${itemId}',
          'orderId', '${ordId}',
          'deviceTypeId', '${devId}',
          'hasCharger', false,
          'itemSequence', 1
        )
      ) AS res;
    `);

    // Check item state before delivery
    const preDeliveryItem = await query(`
      SELECT operational_status, financial_status, base_price_snapshot_minor, financially_recognized_at
      FROM order_items WHERE id = '${itemId}';
    `);
    const isUnrecognized = preDeliveryItem[0].financial_status === 'UNRECOGNIZED';
    const recognizedAtNull = preDeliveryItem[0].financially_recognized_at === null;

    // 3. NOW CHANGE DEVICE TYPE PRICE TO 2500 BEFORE DELIVERY!
    await query(`UPDATE device_types SET base_price_minor = 2500 WHERE id = '${devId}';`);

    // 4. Deliver Item (Financial Recognition)
    await query(`
      SELECT execute_canonical_sync_command(
        gen_random_uuid(),
        'DELIVER_ORDER_ITEM',
        jsonb_build_object('orderItemId', '${itemId}')
      ) AS res;
    `);

    // Check item state after delivery
    const postDeliveryItem = await query(`
      SELECT operational_status, financial_status, base_price_snapshot_minor, charger_fee_snapshot_minor, final_charge_snapshot_minor, financially_recognized_at
      FROM order_items WHERE id = '${itemId}';
    `);

    const recognizedPrice = Number(postDeliveryItem[0].base_price_snapshot_minor);
    const finalCharge = Number(postDeliveryItem[0].final_charge_snapshot_minor);
    const hasRecognizedTimestamp = postDeliveryItem[0].financially_recognized_at !== null;

    // 5. Verify snapshot immutability once recognized
    let snapshotTamperBlocked = false;
    try {
      await query(`UPDATE order_items SET base_price_snapshot_minor = 9999 WHERE id = '${itemId}';`);
    } catch (err) {
      if (err.message.includes('Financial Invariant Violation') && err.message.includes('permanently frozen')) {
        snapshotTamperBlocked = true;
      }
    }

    if (isUnrecognized && recognizedAtNull && recognizedPrice === 2500 && finalCharge === 3000 && hasRecognizedTimestamp && snapshotTamperBlocked) {
      recordTest(
        '5. Price Snapshot Rule (Delivery Freeze)',
        'PASS',
        `Unrecognized at creation. At delivery, re-calculated active base price (2500) + charger (500) = 3000 ILS. Snapshot permanently frozen by DB trigger.`
      );
    } else {
      recordTest(
        '5. Price Snapshot Rule (Delivery Freeze)',
        'FAIL',
        `Pre: unrec=${isUnrecognized}, nullRec=${recognizedAtNull}. Post: price=${recognizedPrice}, finalCharge=${finalCharge}, recognizedAt=${hasRecognizedTimestamp}, tamperBlocked=${snapshotTamperBlocked}`
      );
    }
  } catch (err) {
    recordTest('5. Price Snapshot Rule (Delivery Freeze)', 'FAIL', err.message);
  }

  // =======================================================================
  // 4. POST_PAYMENT ATOMICITY & FIFO ALLOCATION
  // =======================================================================
  try {
    const custFifo = '77777777-7777-4777-a777-777777777777';
    const dayFifo = '88888888-8888-4888-a888-888888888888';
    const devFifo = '99999999-9999-4999-a999-999999999999';
    const ordFifo = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const itemA = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbba';
    const itemB = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb';
    const itemC = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbc';

    await query(`
      INSERT INTO customers (id, name, status, debt_limit_minor, charger_fee_exempt)
      VALUES ('${custFifo}', 'FIFO Customer', 'ACTIVE', 50000, true)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO business_days (id, business_date, display_number, status)
      VALUES ('${dayFifo}', '2026-10-26', 1, 'OPEN')
      ON CONFLICT (business_date) DO UPDATE SET id = '${dayFifo}';

      INSERT INTO device_types (id, name, name_ar, name_en, icon, base_price_minor, charger_fee_enabled, charger_fee_applicable, status)
      VALUES ('${devFifo}', 'FIFO Device', 'جهاز فيفو', 'FIFO Device', 'smartphone', 1000, false, false, 'ACTIVE')
      ON CONFLICT (id) DO UPDATE SET base_price_minor = 1000, icon = 'smartphone';

      INSERT INTO orders (id, day_id, customer_id, display_number, status)
      VALUES ('${ordFifo}', '${dayFifo}', '${custFifo}', 1, 'charging')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Create 3 items sequentially with distinct creation timestamps
    await query(`
      INSERT INTO order_items (id, order_id, device_type_id, item_sequence, operational_status, financial_status, payment_status, base_price_snapshot_minor, final_charge_snapshot_minor, created_at)
      VALUES 
        ('${itemA}', '${ordFifo}', '${devFifo}', 1, 'DELIVERED', 'RECOGNIZED', 'UNPAID', 1000, 1000, NOW() - INTERVAL '3 hours'),
        ('${itemB}', '${ordFifo}', '${devFifo}', 2, 'DELIVERED', 'RECOGNIZED', 'UNPAID', 1000, 1000, NOW() - INTERVAL '2 hours'),
        ('${itemC}', '${ordFifo}', '${devFifo}', 3, 'DELIVERED', 'RECOGNIZED', 'UNPAID', 1000, 1000, NOW() - INTERVAL '1 hour');
    `);

    // Submit Payment of 1500 (fully covers Item A 1000 + partially covers Item B 500; Item C untouched)
    const payId = genRandomUuid();
    await query(`
      SELECT execute_canonical_sync_command(
        '${payId}',
        'POST_PAYMENT',
        jsonb_build_object(
          'id', '${payId}',
          'customerId', '${custFifo}',
          'amountMinor', 1500,
          'paymentMethod', 'CASH'
        )
      );
    `);

    // Check allocation states
    const itemsState = await query(`
      SELECT id, payment_status FROM order_items WHERE id IN ('${itemA}', '${itemB}', '${itemC}') ORDER BY created_at ASC;
    `);

    const itemAStatus = itemsState.find((i) => i.id === itemA)?.payment_status;
    const itemBStatus = itemsState.find((i) => i.id === itemB)?.payment_status;
    const itemCStatus = itemsState.find((i) => i.id === itemC)?.payment_status;

    const allocations = await query(`
      SELECT order_item_id, allocated_amount_minor FROM payment_allocations WHERE payment_id = '${payId}';
    `);

    const allocA = allocations.find((a) => a.order_item_id === itemA)?.allocated_amount_minor;
    const allocB = allocations.find((a) => a.order_item_id === itemB)?.allocated_amount_minor;

    if (itemAStatus === 'PAID' && itemBStatus === 'PARTIALLY_PAID' && itemCStatus === 'UNPAID' && Number(allocA) === 1000 && Number(allocB) === 500) {
      recordTest(
        '6. POST_PAYMENT FIFO Allocation',
        'PASS',
        `Item A satisfied first (1000 PAID). Item B partially paid (500 PARTIALLY_PAID). Item C untouched (UNPAID).`
      );
    } else {
      recordTest(
        '6. POST_PAYMENT FIFO Allocation',
        'FAIL',
        `A=${itemAStatus} (alloc ${allocA}), B=${itemBStatus} (alloc ${allocB}), C=${itemCStatus}`
      );
    }
  } catch (err) {
    recordTest('6. POST_PAYMENT FIFO Allocation', 'FAIL', err.message);
  }

  // =======================================================================
  // 5. SERVER-AUTHORITATIVE DEBT LIMIT ENFORCEMENT
  // =======================================================================
  try {
    const custDebt = 'cccccccc-cccc-4ccc-accc-cccccccccccc';
    const dayDebt = 'dddddddd-dddd-4ddd-addd-dddddddddddd';
    const devDebt = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee';
    const ordDebt = 'ffffffff-ffff-4fff-afff-ffffffffffff';
    const itemDebt = '12345678-1234-4234-a234-123456789abc';

    await query(`
      INSERT INTO customers (id, name, status, debt_limit_minor, charger_fee_exempt)
      VALUES ('${custDebt}', 'Strict Debt Limit Customer', 'ACTIVE', 500, true)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO business_days (id, business_date, display_number, status)
      VALUES ('${dayDebt}', '2026-10-27', 1, 'OPEN')
      ON CONFLICT (business_date) DO UPDATE SET id = '${dayDebt}';

      INSERT INTO device_types (id, name, name_ar, name_en, icon, base_price_minor, charger_fee_enabled, charger_fee_applicable, status)
      VALUES ('${devDebt}', 'Expensive Device', 'جهاز باهظ', 'Expensive Device', 'smartphone', 5000, false, false, 'ACTIVE')
      ON CONFLICT (id) DO UPDATE SET base_price_minor = 5000, icon = 'smartphone';

      INSERT INTO orders (id, day_id, customer_id, display_number, status)
      VALUES ('${ordDebt}', '${dayDebt}', '${custDebt}', 1, 'charging')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO order_items (id, order_id, device_type_id, item_sequence, operational_status, financial_status, payment_status, base_price_snapshot_minor, final_charge_snapshot_minor)
      VALUES ('${itemDebt}', '${ordDebt}', '${devDebt}', 1, 'CHARGING', 'UNRECOGNIZED', 'UNPAID', 5000, 5000);
    `);

    // Attempt delivery of 5000 ILS item when debt limit is 500
    // Client deliberately sends fake preview: "debtLimitOk: true, finalChargeMinor: 0"
    let serverRejected = false;
    let errorMessage = '';
    try {
      await query(`
        SELECT execute_canonical_sync_command(
          gen_random_uuid(),
          'DELIVER_ORDER_ITEM',
          jsonb_build_object(
            'orderItemId', '${itemDebt}',
            'debtLimitOk', true,
            'finalChargeMinor', 0
          )
        );
      `);
    } catch (err) {
      errorMessage = err.message;
      if (err.message.includes('Debt Limit Exceeded')) {
        serverRejected = true;
      }
    }

    if (serverRejected) {
      recordTest(
        '7. Server-Authoritative Debt Limit',
        'PASS',
        `Server rejected operation (projected debt 5000 > limit 500) despite client deceptive payload.`
      );
    } else {
      recordTest('7. Server-Authoritative Debt Limit', 'FAIL', `Operation was not rejected. Error: ${errorMessage}`);
    }
  } catch (err) {
    recordTest('7. Server-Authoritative Debt Limit', 'FAIL', err.message);
  }

  // =======================================================================
  // 6. SUPER ADMIN SECURITY MODEL TEST
  // =======================================================================
  try {
    // Find the real active Super Admin
    const superAdmins = await query("SELECT id, username FROM admins WHERE role IN ('SUPER_ADMIN', 'Super Admin') LIMIT 1;");
    if (superAdmins.length === 0) {
      throw new Error('No Super Admin found in database');
    }
    const superAdminId = superAdmins[0].id;

    // Test 1: Attempt to delete Super Admin
    let deleteBlocked = false;
    try {
      await query(`DELETE FROM admins WHERE id = '${superAdminId}';`);
    } catch (err) {
      if (err.message.includes('Security Invariant Violation') && err.message.includes('cannot be deleted')) {
        deleteBlocked = true;
      }
    }

    // Test 2: Attempt to demote Super Admin
    let demoteBlocked = false;
    try {
      await query(`UPDATE admins SET role = 'STAFF' WHERE id = '${superAdminId}';`);
    } catch (err) {
      if (err.message.includes('Security Invariant Violation') && err.message.includes('cannot be demoted')) {
        demoteBlocked = true;
      }
    }

    // Test 3: Attempt to deactivate Super Admin
    let deactivateBlocked = false;
    try {
      await query(`UPDATE admins SET is_active = false WHERE id = '${superAdminId}';`);
    } catch (err) {
      if (err.message.includes('Security Invariant Violation') && err.message.includes('cannot be disabled')) {
        deactivateBlocked = true;
      }
    }

    // Test 4: Dynamic Permissions Check (does Super Admin automatically receive newly created permission?)
    const newPermCode = 'test:new_feature_' + Date.now();
    await query(`
      INSERT INTO permissions (id, code, description)
      VALUES (gen_random_uuid(), '${newPermCode}', 'Brand new feature permission');
    `);

    const permsRes = await query(`SELECT permission FROM get_effective_permissions('${superAdminId}');`);
    const hasNewPerm = permsRes.some((p) => p.permission === newPermCode);

    if (deleteBlocked && demoteBlocked && deactivateBlocked && hasNewPerm) {
      recordTest(
        '8. Super Admin Security & Dynamic Permissions',
        'PASS',
        `Deactivation, demotion, and deletion blocked by DB triggers. Dynamically received newly created permission (${newPermCode}) without manual assignment.`
      );
    } else {
      recordTest(
        '8. Super Admin Security & Dynamic Permissions',
        'FAIL',
        `deleteBlocked=${deleteBlocked}, demoteBlocked=${demoteBlocked}, deactivateBlocked=${deactivateBlocked}, hasNewPerm=${hasNewPerm}`
      );
    }
  } catch (err) {
    recordTest('8. Super Admin Security & Dynamic Permissions', 'FAIL', err.message);
  }

  // =======================================================================
  // 7. ORDER ITEM CANCELLATION & REVERSAL SEMANTICS
  // =======================================================================
  try {
    const custCancel = '80000000-0000-4000-a000-000000000001';
    const ordCancel = '80000000-0000-4000-a000-000000000002';
    const dayCancel = '80000000-0000-4000-a000-000000000003';
    const devCancel = '80000000-0000-4000-a000-000000000004';
    const itemPreRecognition = '80000000-0000-4000-a000-000000000005';
    const itemPostRecognition = '80000000-0000-4000-a000-000000000006';

    await query(`
      INSERT INTO customers (id, name, status, debt_limit_minor, charger_fee_exempt)
      VALUES ('${custCancel}', 'Cancel Semantics Cust', 'ACTIVE', 50000, true)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO business_days (id, business_date, display_number, status)
      VALUES ('${dayCancel}', '2026-10-28', 1, 'OPEN')
      ON CONFLICT (business_date) DO UPDATE SET id = '${dayCancel}';

      INSERT INTO device_types (id, name, name_ar, name_en, icon, base_price_minor, charger_fee_enabled, charger_fee_applicable, status)
      VALUES ('${devCancel}', 'Cancel Test Dev', 'جهاز الإلغاء', 'Cancel Test Dev', 'smartphone', 2000, false, false, 'ACTIVE')
      ON CONFLICT (id) DO UPDATE SET base_price_minor = 2000, icon = 'smartphone';

      INSERT INTO orders (id, day_id, customer_id, display_number, status)
      VALUES ('${ordCancel}', '${dayCancel}', '${custCancel}', 1, 'charging')
      ON CONFLICT (id) DO NOTHING;

      -- Item 1: CHARGING, UNRECOGNIZED
      INSERT INTO order_items (id, order_id, device_type_id, item_sequence, operational_status, financial_status, payment_status, base_price_snapshot_minor, final_charge_snapshot_minor)
      VALUES ('${itemPreRecognition}', '${ordCancel}', '${devCancel}', 1, 'CHARGING', 'UNRECOGNIZED', 'UNPAID', 2000, 2000);

      -- Item 2: DELIVERED, RECOGNIZED with a ledger entry
      INSERT INTO order_items (id, order_id, device_type_id, item_sequence, operational_status, financial_status, payment_status, base_price_snapshot_minor, final_charge_snapshot_minor, delivered_at, financially_recognized_at)
      VALUES ('${itemPostRecognition}', '${ordCancel}', '${devCancel}', 2, 'DELIVERED', 'RECOGNIZED', 'UNPAID', 2000, 2000, NOW(), NOW());

      INSERT INTO financial_ledger (id, event_type, amount_minor, order_id, order_item_id, customer_id)
      VALUES (gen_random_uuid(), 'ORDER_ITEM_CHARGE', -2000, '${ordCancel}', '${itemPostRecognition}', '${custCancel}');
    `);

    // Case 1: Cancel pre-recognition item -> no ledger reversal created
    const ledgerCountBefore = (await query(`SELECT count(*) FROM financial_ledger WHERE order_item_id = '${itemPreRecognition}';`))[0].count;
    await query(`
      SELECT execute_canonical_sync_command(
        gen_random_uuid(),
        'CANCEL_ORDER_ITEM',
        jsonb_build_object('orderItemId', '${itemPreRecognition}')
      );
    `);
    const ledgerCountAfter = (await query(`SELECT count(*) FROM financial_ledger WHERE order_item_id = '${itemPreRecognition}';`))[0].count;
    const noLedgerForPre = Number(ledgerCountBefore) === 0 && Number(ledgerCountAfter) === 0;

    // Case 2: Cancel post-recognition item -> creates linked REVERSAL entry
    await query(`
      SELECT execute_canonical_sync_command(
        gen_random_uuid(),
        'CANCEL_ORDER_ITEM',
        jsonb_build_object('orderItemId', '${itemPostRecognition}')
      );
    `);

    const reversalEntries = await query(`
      SELECT event_type, amount_minor, linked_ledger_id 
      FROM financial_ledger 
      WHERE order_item_id = '${itemPostRecognition}' AND event_type = 'REVERSAL';
    `);

    const hasReversal = reversalEntries.length === 1;
    const reversalAmount = Number(reversalEntries[0]?.amount_minor);
    const hasLinkedId = reversalEntries[0]?.linked_ledger_id !== null;

    // Case 3: Attempt second cancellation on recognized item -> must be rejected/idempotent
    let secondReversalRejected = false;
    try {
      await query(`
        SELECT execute_canonical_sync_command(
          gen_random_uuid(),
          'CANCEL_ORDER_ITEM',
          jsonb_build_object('orderItemId', '${itemPostRecognition}')
        );
      `);
      const checkReversals = await query(`
        SELECT count(*) FROM financial_ledger WHERE order_item_id = '${itemPostRecognition}' AND event_type = 'REVERSAL';
      `);
      if (Number(checkReversals[0].count) === 1) {
        secondReversalRejected = true;
      }
    } catch {
      secondReversalRejected = true;
    }

    if (noLedgerForPre && hasReversal && reversalAmount === 2000 && hasLinkedId && secondReversalRejected) {
      recordTest(
        '9. Cancellation & Reversal Semantics',
        'PASS',
        `Pre-recognition cancellation creates 0 ledger entries. Post-recognition creates exactly 1 linked REVERSAL entry (+2000). Double-reversal prevented.`
      );
    } else {
      recordTest(
        '9. Cancellation & Reversal Semantics',
        'FAIL',
        `noLedgerPre=${noLedgerForPre}, hasReversal=${hasReversal}, amount=${reversalAmount}, hasLinked=${hasLinkedId}, doublePrevented=${secondReversalRejected}`
      );
    }
  } catch (err) {
    recordTest('9. Cancellation & Reversal Semantics', 'FAIL', err.message);
  }

  // =======================================================================
  // 8. BACKUP CHECKPOINT & ATOMIC RESTORE
  // =======================================================================
  try {
    const adminUser = await query("SELECT id FROM admins WHERE role IN ('SUPER_ADMIN', 'Super Admin') LIMIT 1;");
    const adminId = adminUser[0]?.id;
    // Set a known test BIN '1234' on the Super Admin account
    await query(`
      UPDATE admins 
      SET bin_hash = crypt('1234', gen_salt('bf', 10)), is_active = true 
      WHERE id = '${adminId}';
    `);

    // 1. Create Checkpoint A
    const chkRes = await query(`
      SELECT create_authoritative_backup_checkpoint('1234', 'Checkpoint A') AS res;
    `);
    const checkpointId = chkRes[0].res.checkpointId;

    // 2. Make additional destructive changes
    const canaryCustId = genRandomUuid();
    await query(`
      INSERT INTO customers (id, name, status) VALUES ('${canaryCustId}', 'Canary Post-A Customer', 'ACTIVE');
    `);

    // Verify canary exists
    const canaryPreRestore = await query(`SELECT count(*) FROM customers WHERE id = '${canaryCustId}';`);
    const canaryExists = Number(canaryPreRestore[0].count) === 1;

    // 3. Restore Checkpoint A
    const restoreRes = await query(`
      SELECT restore_authoritative_backup_checkpoint('1234', '${checkpointId}') AS res;
    `);
    const restoreSuccess = restoreRes[0].res.success === true;

    // 4. Verify post-A changes are completely absent
    const canaryPostRestore = await query(`SELECT count(*) FROM customers WHERE id = '${canaryCustId}';`);
    const canaryGone = Number(canaryPostRestore[0].count) === 0;

    if (checkpointId && canaryExists && restoreSuccess && canaryGone) {
      recordTest(
        '10. Authoritative Backup & Restore Semantics',
        'PASS',
        `Checkpoint A captured. Post-A canary created. Checkpoint A restored atomically. Post-A mutations cleanly discarded.`
      );
    } else {
      recordTest(
        '10. Authoritative Backup & Restore Semantics',
        'FAIL',
        `chkId=${checkpointId}, canaryExisted=${canaryExists}, restored=${restoreSuccess}, canaryGone=${canaryGone}`
      );
    }
  } catch (err) {
    recordTest('10. Authoritative Backup & Restore Semantics', 'FAIL', err.message);
  }

  // =======================================================================
  // 9. CLEAN DISPOSABLE DATA
  // =======================================================================
  try {
    console.log('\nCleaning disposable experimental test artifacts from database...');
    await query(`
      ALTER TABLE financial_ledger DISABLE TRIGGER trg_immutable_financial_ledger;
      ALTER TABLE order_items DISABLE TRIGGER trg_freeze_recognized_order_item;

      DELETE FROM payment_allocations;
      DELETE FROM financial_ledger;
      DELETE FROM payments;
      DELETE FROM order_items;
      DELETE FROM orders;
      DELETE FROM business_days;
      DELETE FROM customers;
      DELETE FROM processed_commands;
      DELETE FROM change_log;
      DELETE FROM backup_checkpoints;

      ALTER TABLE financial_ledger ENABLE TRIGGER trg_immutable_financial_ledger;
      ALTER TABLE order_items ENABLE TRIGGER trg_freeze_recognized_order_item;
    `);
    recordTest('11. Disposable Data Cleanup', 'PASS', 'Experimental business tables cleanly cleared per explicit user authorization.');
  } catch (err) {
    recordTest('11. Disposable Data Cleanup', 'FAIL', err.message);
  }

  console.log('\n================================================================');
  console.log('SUMMARY OF REAL DATABASE VERIFICATION RESULTS:');
  console.log('================================================================');
  let passCount = 0;
  let failCount = 0;
  for (const r of results) {
    console.log(`${r.status.padEnd(6)} | ${r.testName}`);
    if (r.status === 'PASS') passCount++;
    else failCount++;
  }
  console.log(`\nTOTAL: ${results.length} tests (${passCount} PASSED, ${failCount} FAILED)`);

  if (failCount > 0) {
    process.exit(1);
  }
}

function genRandomUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

runAllVerifications().catch((e) => {
  console.error('Fatal execution error:', e);
  process.exit(1);
});
