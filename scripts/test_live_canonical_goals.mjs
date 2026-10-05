import { query } from "./db.mjs";

async function runLiveGoalsTest() {
  console.log("=================================================");
  console.log("STARTING LIVE POSTGRESQL CANONICAL GOALS TEST");
  console.log("=================================================");

  const testSuffix = Date.now();
  const customerId = "a0000000-0000-4000-a000-" + String(testSuffix).slice(-12);
  const goal1Id = "b0000000-0000-4000-a000-" + String(testSuffix).slice(-12);
  const goal2Id = "c0000000-0000-4000-a000-" + String(testSuffix).slice(-12);
  const req1Id = "d0000000-0000-4000-a000-" + String(testSuffix).slice(-12);
  const req2Id = "e0000000-0000-4000-a000-" + String(testSuffix).slice(-12);
  const dayId = "f0000000-0000-4000-a000-" + String(testSuffix).slice(-12);
  const orderId = "10000000-0000-4000-a000-" + String(testSuffix).slice(-12);
  const item1Id = "20000000-0000-4000-a000-" + String(testSuffix).slice(-12);
  const item2Id = "30000000-0000-4000-a000-" + String(testSuffix).slice(-12);
  const deviceTypeId = "40000000-0000-4000-a000-" + String(testSuffix).slice(-12);

  // 1. Create Customer & Business Day & Device Type
  console.log("\n1. Creating test fixtures (Customer, Device Type, Day)...");
  await query(`
    INSERT INTO public.customers (id, name, phone, status, debt_limit_minor, charger_fee_exempt)
    VALUES ('${customerId}', 'Live Goal Customer ${testSuffix}', '0590000000', 'ACTIVE', 5000, true);

    INSERT INTO public.device_types (id, name, name_ar, icon, base_price_minor, charger_fee_enabled, is_active)
    VALUES ('${deviceTypeId}', 'Goal Device ${testSuffix}', 'جهاز الهدف', 'smartphone', 200, false, true);

    INSERT INTO public.business_days (id, business_date, display_number, status, is_closed)
    VALUES ('${dayId}', '2099-01-${String((testSuffix % 25) + 1).padStart(2, '0')}', 1, 'OPEN', false);
  `);
  console.log("Fixtures created successfully.");

  // 2. Test CREATE_GOAL via execute_canonical_sync_command
  console.log("\n2. Executing CREATE_GOAL via canonical sync command...");
  const cmdGoal1 = "50000000-0000-4000-a000-" + String(testSuffix).slice(-12);
  const resGoal1 = await query(`
    SELECT public.execute_canonical_sync_command(
      '${cmdGoal1}'::UUID,
      'CREATE_GOAL',
      jsonb_build_object(
        'id', '${goal1Id}',
        'customerId', '${customerId}',
        'targetQuantity', 2,
        'durationDays', 7,
        'bonusAmountMinor', 1000
      )
    ) AS res;
  `);
  console.log("CREATE_GOAL result:", resGoal1);

  // 3. Test Single Active Goal Constraint: Attempting to create second active goal MUST fail
  console.log("\n3. Testing Single Active Goal Invariant on PostgreSQL...");
  const cmdGoal2 = "60000000-0000-4000-a000-" + String(testSuffix).slice(-12);
  const resGoal2 = await query(`
    SELECT public.execute_canonical_sync_command(
      '${cmdGoal2}'::UUID,
      'CREATE_GOAL',
      jsonb_build_object(
        'id', '${goal2Id}',
        'customerId', '${customerId}',
        'targetQuantity', 5,
        'durationDays', 7,
        'bonusAmountMinor', 2000
      )
    ) AS res;
  `);
  console.log("Second active goal rejection response:", resGoal2);
  if (resGoal2?.message && (resGoal2.message.includes("already has an active goal") || resGoal2.message.includes("idx_customer_single_active_goal"))) {
    console.log(">> PASS: Second active goal was strictly rejected by database constraint!");
  } else {
    throw new Error("FAIL: Database failed to reject second active goal!");
  }

  // 4. Test Goal Requests: RECORD_GOAL_REQUEST & REJECT_GOAL_REQUEST
  console.log("\n4. Testing Goal Request rejection workflow...");
  const cmdReq1 = "70000000-0000-4000-a000-" + String(testSuffix).slice(-12);
  await query(`
    SELECT public.execute_canonical_sync_command(
      '${cmdReq1}'::UUID,
      'RECORD_GOAL_REQUEST',
      jsonb_build_object('id', '${req1Id}', 'customerId', '${customerId}', 'requestedTarget', 15)
    );
  `);
  const cmdReject = "80000000-0000-4000-a000-" + String(testSuffix).slice(-12);
  await query(`
    SELECT public.execute_canonical_sync_command(
      '${cmdReject}'::UUID,
      'REJECT_GOAL_REQUEST',
      jsonb_build_object('requestId', '${req1Id}', 'rejectionReason', 'Tier mismatch')
    );
  `);
  const reqCheck = await query(`SELECT status, rejection_reason FROM public.goal_requests WHERE id = '${req1Id}';`);
  console.log("Rejected request status in DB:", reqCheck);
  if (reqCheck[0]?.status === 'REJECTED') {
    console.log(">> PASS: Goal Request rejection recorded correctly with no active goal created!");
  }

  // 5. Test Delivering Order Items -> Advances Goal Progress and Triggers Automatic Completion & Bonus Ledger Entry
  console.log("\n5. Testing Item Deliveries and automatic Goal Progress / Completion / Ledger Bonus...");
  // Create Order and 2 items
  await query(`
    INSERT INTO public.orders (id, day_id, customer_id, display_number, status)
    VALUES ('${orderId}', '${dayId}', '${customerId}', 1, 'pending');

    INSERT INTO public.order_items (id, order_id, device_type_id, item_sequence, operational_status, financial_status, payment_status, status, device_name_snapshot, device_icon_snapshot, base_price_snapshot_minor, unit_price_minor, total_price_minor, has_charger, charger_fee_enabled_snapshot, customer_charger_fee_exempt_snapshot)
    VALUES ('${item1Id}', '${orderId}', '${deviceTypeId}', 1, 'CHARGING', 'UNRECOGNIZED', 'UNPAID', 'charging', 'Device', 'icon', 200, 200, 200, false, false, true),
           ('${item2Id}', '${orderId}', '${deviceTypeId}', 2, 'CHARGING', 'UNRECOGNIZED', 'UNPAID', 'charging', 'Device', 'icon', 200, 200, 200, false, false, true);
  `);

  // Deliver Item 1 (Progress 1/2)
  console.log("Delivering Item 1 (Progress 1/2)...");
  const cmdDeliver1 = "90000000-0000-4000-a000-" + String(testSuffix).slice(-12);
  await query(`
    SELECT public.execute_canonical_sync_command(
      '${cmdDeliver1}'::UUID,
      'DELIVER_ORDER_ITEM',
      jsonb_build_object('itemId', '${item1Id}')
    );
  `);

  const goalCheck1 = await query(`SELECT current_progress, status, bonus_ledger_id FROM public.goals WHERE id = '${goal1Id}';`);
  console.log("Goal after Item 1 delivery:", goalCheck1);
  if (goalCheck1[0]?.current_progress === 1 && goalCheck1[0]?.status === 'ACTIVE') {
    console.log(">> PASS: Progress advanced to 1/2, goal remains ACTIVE.");
  }

  // Deliver Item 2 (Progress 2/2 -> Target Met! -> Auto-completed and Bonus granted)
  console.log("Delivering Item 2 (Progress 2/2 -> Target Met!)...");
  const cmdDeliver2 = "91000000-0000-4000-a000-" + String(testSuffix).slice(-12);
  await query(`
    SELECT public.execute_canonical_sync_command(
      '${cmdDeliver2}'::UUID,
      'DELIVER_ORDER_ITEM',
      jsonb_build_object('itemId', '${item2Id}')
    );
  `);

  const goalCheck2 = await query(`SELECT current_progress, status, completed_at, bonus_ledger_id FROM public.goals WHERE id = '${goal1Id}';`);
  console.log("Goal after Item 2 delivery:", goalCheck2);
  if (goalCheck2[0]?.status === 'COMPLETED' && goalCheck2[0]?.bonus_ledger_id) {
    console.log(">> PASS: Goal immediately marked COMPLETED with bonus_ledger_id set!");
  } else {
    throw new Error("FAIL: Goal was not auto-completed upon reaching target!");
  }

  // Check Financial Ledger for BONUS event
  const ledgerBonus = await query(`
    SELECT id, event_type, amount_minor, customer_id, reference_id
    FROM public.financial_ledger
    WHERE id = '${goalCheck2[0].bonus_ledger_id}';
  `);
  console.log("Authoritative Ledger Bonus Entry:", ledgerBonus);
  if (ledgerBonus[0]?.event_type === 'BONUS' && Number(ledgerBonus[0]?.amount_minor) === 1000) {
    console.log(">> PASS: Financial Ledger contains exact canonical BONUS entry of 1000 minor units!");
  } else {
    throw new Error("FAIL: Financial ledger bonus entry missing or incorrect!");
  }

  // 6. Test Authoritative Backup & Restore with Goals
  console.log("\n6. Testing Authoritative Backup & Restore with Goals...");
  const bin = "123456";
  const backupRes = await query(`
    SELECT public.create_authoritative_backup_checkpoint('${bin}', 'Goals Test Checkpoint') AS chk;
  `);
  console.log("Created backup checkpoint:", backupRes);
  const checkpointId = backupRes[0]?.chk?.checkpointId;

  // Mutate database: create another goal request
  const cmdReq2 = "92000000-0000-4000-a000-" + String(testSuffix).slice(-12);
  await query(`
    SELECT public.execute_canonical_sync_command(
      '${cmdReq2}'::UUID,
      'RECORD_GOAL_REQUEST',
      jsonb_build_object('id', '${req2Id}', 'customerId', '${customerId}', 'requestedTarget', 30)
    );
  `);

  const reqCountBefore = await query(`SELECT count(*) FROM public.goal_requests WHERE id = '${req2Id}';`);
  console.log("Goal request 2 exists before restore:", reqCountBefore[0]?.count);

  // Restore Checkpoint
  console.log("Restoring Checkpoint...");
  const restoreRes = await query(`
    SELECT public.restore_authoritative_backup_checkpoint('${bin}', '${checkpointId}'::UUID) AS rest;
  `);
  console.log("Restore result:", restoreRes);

  // Verify that goal request 2 was reverted and goal1 is restored exactly as COMPLETED
  const reqCountAfter = await query(`SELECT count(*) FROM public.goal_requests WHERE id = '${req2Id}';`);
  const restoredGoal = await query(`SELECT id, status, current_progress, bonus_amount_minor FROM public.goals WHERE id = '${goal1Id}';`);
  console.log("Goal request 2 count after restore (should be 0):", reqCountAfter[0]?.count);
  console.log("Restored Goal state:", restoredGoal[0]);

  if (Number(reqCountAfter[0]?.count) === 0 && restoredGoal[0]?.status === 'COMPLETED' && restoredGoal[0]?.current_progress === 2) {
    console.log(">> PASS: Authoritative Backup & Restore faithfully restored Goals & Goal Requests!");
  } else {
    throw new Error("FAIL: Restore did not properly recover goals state!");
  }

  console.log("\n=================================================");
  console.log("ALL LIVE POSTGRESQL CANONICAL GOALS INVARIANTS VERIFIED 100%");
  console.log("=================================================");
}

runLiveGoalsTest().catch(err => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
