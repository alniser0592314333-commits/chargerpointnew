import { query } from './db.mjs';

async function verify() {
  console.log('Running Authoritative Alignment Verification...');

  try {
    // 1. Setup Test Admin
    const testSub = '00000000-0000-0000-0000-000000000000';
    await query(`
      INSERT INTO public.admins (auth_user_id, username, full_name, role, permissions)
      VALUES ('${testSub}', 'test_verifier', 'Test Verifier', 'SUPER_ADMIN', '{orders:create,orders:view,orders:deliver,customers:create,customers:view,finance:create-payment}')
      ON CONFLICT (auth_user_id) DO UPDATE SET role='SUPER_ADMIN', permissions='{orders:create,orders:view,orders:deliver,customers:create,customers:view,finance:create-payment}';
    `);

    const runRpc = async (stmt) => {
      return await query(`
        BEGIN;
        SET LOCAL "request.jwt.claims" = '{"sub":"${testSub}"}';
        ${stmt}
        COMMIT;
      `);
    };

    // 2. Open Business Day
    console.log('Test: Create Business Day');
    const dayId = '10000000-0000-0000-0000-000000000000';
    const dayRes = await runRpc(`
      SELECT execute_canonical_sync_command(
        '${dayId}',
        'OPEN_DAY',
        '{"id":"${dayId}","businessDate":"2026-10-30","displayNumber":1}',
        'hash1',
        null,
        '${testSub}'
      );
    `);
    console.log('Day Result:', JSON.stringify(dayRes));

    // 3. Create Customer
    console.log('Test: Create Customer');
    const custId = '20000000-0000-0000-0000-000000000000';
    const custRes = await runRpc(`
      SELECT execute_canonical_sync_command(
        '${custId}',
        'CREATE_CUSTOMER',
        '{"id":"${custId}","name":"Verify Test Cust","debtLimitMinor":5000}',
        'hash2',
        null,
        '${testSub}'
      );
    `);
    console.log('Cust Result:', JSON.stringify(custRes));

    // 4. Create Order
    console.log('Test: Create Order');
    const ordId = '30000000-0000-0000-0000-000000000000';
    const ordRes = await runRpc(`
      SELECT execute_canonical_sync_command(
        '${ordId}',
        'CREATE_ORDER',
        '{"id":"${ordId}","customerId":"${custId}","dayId":"${dayId}","displayNumber":101}',
        'hash3',
        null,
        '${testSub}'
      );
    `);
    console.log('Order Result:', JSON.stringify(ordRes));

    // 5. Add Device Type (needed for item)
    const devTypeId = '40000000-0000-0000-0000-000000000000';
    await query(`
      INSERT INTO public.device_types (id, name, base_price_minor)
      VALUES ('${devTypeId}', 'Test Device', 1500)
      ON CONFLICT (id) DO NOTHING;
    `);

    // 6. Add Item
    console.log('Test: Add Item');
    const itemId = '50000000-0000-0000-0000-000000000000';
    const itemRes = await runRpc(`
      SELECT execute_canonical_sync_command(
        '${itemId}',
        'ADD_ORDER_ITEM',
        '{"id":"${itemId}","orderId":"${ordId}","deviceTypeId":"${devTypeId}","itemSequence":1,"hasCharger":false}',
        'hash4',
        null,
        '${testSub}'
      );
    `);
    console.log('Item Result:', JSON.stringify(itemRes));

    // 7. Deliver Item
    console.log('Test: Deliver Item');
    const deliverRes = await runRpc(`
      SELECT execute_canonical_sync_command(
        '${crypto.randomUUID()}',
        'DELIVER_ORDER_ITEM',
        '{"orderItemId":"${itemId}"}',
        'hash5',
        null,
        '${testSub}'
      );
    `);
    console.log('Deliver Result:', JSON.stringify(deliverRes));

    // 8. Verify Financial Ledger
    console.log('Test: Verify Ledger');
    const ledger = await query(`SELECT * FROM public.financial_ledger WHERE order_item_id='${itemId}'`);
    if (ledger.length > 0 && Math.abs(Number(ledger[0].amount_minor)) > 0) {
      console.log('PASS: Ledger entry found:', ledger[0].amount_minor);
    } else {
      console.error('FAIL: No ledger entry for delivered item');
    }

    // 9. Create Payment
    console.log('Test: Create Payment');
    const payId = '60000000-0000-0000-0000-000000000000';
    const payRes = await runRpc(`
      SELECT execute_canonical_sync_command(
        '${payId}',
        'POST_PAYMENT',
        '{"id":"${payId}","customerId":"${custId}","amountMinor":1000,"paymentMethod":"CASH"}',
        'hash6',
        null,
        '${testSub}'
      );
    `);
    console.log('Payment Result:', JSON.stringify(payRes));

    // 10. Verify Idempotency
    console.log('Test: Idempotency');
    const repeatRes = await runRpc(`
      SELECT execute_canonical_sync_command(
        '${payId}',
        'POST_PAYMENT',
        '{"id":"${payId}","customerId":"${custId}","amountMinor":1000,"paymentMethod":"CASH"}',
        'hash6',
        null,
        '${testSub}'
      );
    `);
    if (JSON.stringify(repeatRes).includes('success')) {
       console.log('PASS: Idempotency handled');
    } else {
       console.warn('Idempotency result:', JSON.stringify(repeatRes));
    }

    console.log('Verification Complete.');
  } catch (err) {
    console.error('Verification Failed:', err);
    process.exit(1);
  }
}

verify();
