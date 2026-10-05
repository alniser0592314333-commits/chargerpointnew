import { query } from './db.mjs';

async function testPricing() {
  const dayId = '00000000-0000-0000-0000-000000000001';
  const customerId = '00000000-0000-4000-a000-000000000001';
  const deviceTypeId = '00000000-0000-4000-b000-000000000001';
  const realOrderId = '00000000-0000-4000-c000-000000000001';
  const itemId = '00000000-0000-4000-d000-000000000001';
  const cmd1Id = '00000000-0000-4000-e000-000000000001';
  const cmd2Id = '00000000-0000-4000-f000-000000000001';
  const adminAuthUserId = 'f4a7e143-f4a6-47fb-8976-eec7b5f49643'; // SUPER_ADMIN

  console.log("--- Starting Controlled Pricing Test ---");

  try {
    await query(`SET LOCAL "request.jwt.claims" = '{"sub": "${adminAuthUserId}"}'`);

    // Cleanup
    await query(`DELETE FROM public.financial_ledger WHERE order_item_id = '${itemId}' OR customer_id = '${customerId}'`);
    await query(`DELETE FROM public.order_items WHERE id = '${itemId}'`);
    await query(`DELETE FROM public.orders WHERE id = '${realOrderId}'`);
    await query(`DELETE FROM public.customers WHERE id = '${customerId}'`);
    await query(`DELETE FROM public.device_types WHERE id = '${deviceTypeId}'`);
    await query(`DELETE FROM public.business_days WHERE id = '${dayId}'`);
    await query(`DELETE FROM public.processed_commands WHERE command_id IN ('${cmd1Id}', '${cmd2Id}')`);

    // Setup
    await query(`INSERT INTO public.business_days (id, business_date) VALUES ('${dayId}', '2026-10-05') ON CONFLICT DO NOTHING`);
    await query(`INSERT INTO public.device_types (id, name, base_price_minor, charger_fee_applicable) VALUES ('${deviceTypeId}', 'Test Device', 100, true)`);
    await query(`INSERT INTO public.customers (id, name, charger_fee_exempt) VALUES ('${customerId}', 'Test Customer', false)`);
    await query(`INSERT INTO public.orders (id, day_id, customer_id, display_number) VALUES ('${realOrderId}', '${dayId}', '${customerId}', 1)`);

    // Add Item (with resetGeneration: 20)
    const addPayload = {
        id: itemId,
        orderId: realOrderId,
        deviceTypeId: deviceTypeId,
        chargerFeeSnapshotMinor: 50,
        discountSnapshotMinor: 0,
        resetGeneration: 20
    };
    
    console.log("Executing ADD_ORDER_ITEM...");
    const addRes = await query(`SELECT public.execute_canonical_sync_command('${cmd1Id}'::UUID, 'ADD_ORDER_ITEM', '${JSON.stringify(addPayload)}'::JSONB)`);
    console.log("ADD_ORDER_ITEM Result:", JSON.stringify(addRes, null, 2));

    // Verify snapshot
    const item = await query(`SELECT * FROM public.order_items WHERE id = '${itemId}'`);
    console.log("Item Snapshot:", JSON.stringify(item[0], null, 2));
    if (!item[0] || Number(item[0].charger_fee_snapshot_minor) !== 50) throw new Error(`Wrong snapshot fee! Got ${item[0]?.charger_fee_snapshot_minor}`);

    // Deliver Item (with resetGeneration: 20)
    const deliverPayload = {
        itemId: itemId,
        resetGeneration: 20
    };
    console.log("Executing DELIVER_ORDER_ITEM...");
    const delRes = await query(`SELECT public.execute_canonical_sync_command('${cmd2Id}'::UUID, 'DELIVER_ORDER_ITEM', '${JSON.stringify(deliverPayload)}'::JSONB)`);
    console.log("DELIVER_ORDER_ITEM Result:", JSON.stringify(delRes, null, 2));

    // Verify Ledger
    const ledger = await query(`SELECT * FROM public.financial_ledger WHERE order_item_id = '${itemId}'`);
    console.log("Ledger Entry:", JSON.stringify(ledger[0], null, 2));
    
    if (!ledger[0] || Math.abs(Number(ledger[0].amount_minor)) !== 150) throw new Error(`Wrong ledger amount! Expected 150, got ${ledger[0]?.amount_minor}`);
    if (ledger[0].event_type !== 'ORDER_ITEM_CHARGE') throw new Error(`Wrong event type! Expected ORDER_ITEM_CHARGE, got ${ledger[0].event_type}`);

    console.log("--- Controlled Pricing Test PASSED ---");

  } catch (err) {
    console.error("--- Controlled Pricing Test FAILED ---");
    console.error(err);
    process.exit(1);
  }
}

testPricing();
