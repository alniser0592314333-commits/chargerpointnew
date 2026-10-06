import { query } from './db.mjs';
import crypto from 'crypto';

async function verify() {
  console.log('--- STARTING E2E VERIFICATION (FINAL) ---');

  try {
    const adminRes = await query("SELECT auth_user_id FROM public.admins WHERE role = 'SUPER_ADMIN' LIMIT 1");
    if (adminRes.length === 0) throw new Error('No super admin found for testing');
    const authUserId = adminRes[0].auth_user_id;
    console.log('Using Auth User ID:', authUserId);

    const setupAuth = "SET local jwt.claims.sub = '" + authUserId + "'; SET local role authenticated;";

    const getSelectResult = (res) => {
      if (Array.isArray(res)) {
        const selectRes = res.find(r => Array.isArray(r) && r.length > 0 && r[0].result !== undefined);
        return selectRes ? selectRes[0].result : res.find(r => Array.isArray(r) && r.length > 0)?.[0];
      }
      return res;
    };

    // 1. OPEN_DAY
    console.log('Test: OPEN_DAY...');
    const dayId = crypto.randomUUID();
    const cmdId1 = crypto.randomUUID();
    const openDayRes = await query("BEGIN; " + setupAuth + " SELECT public.execute_sync_command('" + cmdId1 + "', 'OPEN_DAY', null, null, jsonb_build_object('id', '" + dayId + "', 'businessDate', CURRENT_DATE::text), null) as result; COMMIT;");
    console.log('OPEN_DAY Result:', JSON.stringify(getSelectResult(openDayRes), null, 2));

    // 2. CREATE_CUSTOMER
    console.log('Test: CREATE_CUSTOMER...');
    const custId = crypto.randomUUID();
    const cmdId2 = crypto.randomUUID();
    const createCustRes = await query("BEGIN; " + setupAuth + " SELECT public.execute_sync_command('" + cmdId2 + "', 'CREATE_CUSTOMER', null, null, jsonb_build_object('id', '" + custId + "', 'name', 'Test Customer', 'debtLimitMinor', 5000), null) as result; COMMIT;");
    console.log('CREATE_CUSTOMER Result:', JSON.stringify(getSelectResult(createCustRes), null, 2));

    // 3. CREATE_ORDER
    console.log('Test: CREATE_ORDER...');
    const orderId = crypto.randomUUID();
    const cmdId3 = crypto.randomUUID();
    const createOrderRes = await query("BEGIN; " + setupAuth + " SELECT public.execute_sync_command('" + cmdId3 + "', 'CREATE_ORDER', null, null, jsonb_build_object('id', '" + orderId + "', 'customerId', '" + custId + "', 'dayId', '" + dayId + "', 'status', 'pending'), null) as result; COMMIT;");
    console.log('CREATE_ORDER Result:', JSON.stringify(getSelectResult(createOrderRes), null, 2));

    // 4. ADD_ORDER_ITEM
    console.log('Test: ADD_ORDER_ITEM...');
    const dtResRaw = await query('SELECT id FROM public.device_types LIMIT 1');
    const dtRes = Array.isArray(dtResRaw) ? dtResRaw.flat() : dtResRaw;
    let dtId;
    if (dtRes.length === 0) {
      console.log('Creating device type for test...');
      dtId = crypto.randomUUID();
      await query("BEGIN; " + setupAuth + " SELECT public.execute_sync_command('" + crypto.randomUUID() + "', 'CREATE_DEVICE_TYPE', null, null, jsonb_build_object('id', '" + dtId + "', 'name', 'Test Device', 'basePriceMinor', 1000), null); COMMIT;");
    } else {
      dtId = dtRes[0].id;
    }

    const itemId = crypto.randomUUID();
    const cmdId4 = crypto.randomUUID();
    const addItemRes = await query("BEGIN; " + setupAuth + " SELECT public.execute_sync_command('" + cmdId4 + "', 'ADD_ORDER_ITEM', null, null, jsonb_build_object('id', '" + itemId + "', 'orderId', '" + orderId + "', 'deviceTypeId', '" + dtId + "', 'hasCharger', false), null) as result; COMMIT;");
    console.log('ADD_ORDER_ITEM Result:', JSON.stringify(getSelectResult(addItemRes), null, 2));

    // 5. DELIVER_ORDER_ITEM
    console.log('Test: DELIVER_ORDER_ITEM...');
    const cmdId5 = crypto.randomUUID();
    const deliverRes = await query("BEGIN; " + setupAuth + " SELECT public.execute_sync_command('" + cmdId5 + "', 'DELIVER_ORDER_ITEM', null, null, jsonb_build_object('itemId', '" + itemId + "'), null) as result; COMMIT;");
    console.log('DELIVER_ORDER_ITEM Result:', JSON.stringify(getSelectResult(deliverRes), null, 2));

    // 6. VERIFY LEDGER
    console.log('Test: VERIFY LEDGER...');
    const ledgerResRaw = await query('SELECT * FROM public.financial_ledger WHERE order_item_id = \'' + itemId + '\'');
    const ledgerRes = Array.isArray(ledgerResRaw) ? ledgerResRaw.flat() : ledgerResRaw;
    console.log('Ledger Entry:', JSON.stringify(ledgerRes, null, 2));
    if (ledgerRes.length === 0) throw new Error('Ledger entry not found');

    // 7. CREATE_PAYMENT
    console.log('Test: CREATE_PAYMENT...');
    const paymentId = crypto.randomUUID();
    const cmdId6 = crypto.randomUUID();
    const paymentRes = await query("BEGIN; " + setupAuth + " SELECT public.execute_sync_command('" + cmdId6 + "', 'CREATE_PAYMENT', null, null, jsonb_build_object('id', '" + paymentId + "', 'customerId', '" + custId + "', 'amountMinor', 500, 'paymentMethod', 'CASH'), null) as result; COMMIT;");
    console.log('CREATE_PAYMENT Result:', JSON.stringify(getSelectResult(paymentRes), null, 2));

    // 8. IDEMPOTENCY
    console.log('Test: IDEMPOTENCY...');
    const openDayRes2 = await query("BEGIN; " + setupAuth + " SELECT public.execute_sync_command('" + cmdId1 + "', 'OPEN_DAY', null, null, jsonb_build_object('id', '" + dayId + "', 'businessDate', CURRENT_DATE::text), null) as result; COMMIT;");
    console.log('IDEMPOTENCY Result:', JSON.stringify(openDayRes2[0]?.result || openDayRes2[0], null, 2));

    // 9. VERSION CONFLICT
    console.log('Test: VERSION CONFLICT...');
    const cmdId7 = crypto.randomUUID();
    try {
      const conflictRes = await query("BEGIN; " + setupAuth + " SELECT public.execute_sync_command('" + cmdId7 + "', 'UPDATE_CUSTOMER', null, null, jsonb_build_object('id', '" + custId + "', 'name', 'Conflict Name'), 999) as result; COMMIT;");
      console.log('Conflict Result (unexpected success):', JSON.stringify(conflictRes[0]?.result || conflictRes[0], null, 2));
    } catch (e) {
      console.log('Successfully caught version conflict:', e.message);
    }

    // 10. CHANGE_LOG
    console.log('Test: CHANGE_LOG...');
    const logRes = await query("SELECT count(*) FROM public.change_log WHERE entity_id = '" + orderId + "' OR entity_id = '" + custId + "'");
    console.log('Change Log Entries Count:', logRes[0].count);

    console.log('--- E2E VERIFICATION COMPLETE ---');
  } catch (err) {
    console.error('Verification failed:', err);
    process.exit(1);
  }
}

verify();
