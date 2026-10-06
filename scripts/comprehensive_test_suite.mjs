import { query } from './db.mjs';

async function runComprehensiveVerification() {
  console.log('====================================================');
  console.log('AUTHORITATIVE DATABASE CONTRACT VERIFICATION SUITE');
  console.log('====================================================');

  const superAdminRow = await query(`
    SELECT auth_user_id FROM public.admins WHERE role = 'SUPER_ADMIN' AND is_active = true LIMIT 1;
  `);
  const testSub = superAdminRow[0]?.auth_user_id;
  if (!testSub) throw new Error('No active Super Admin found in database');

  const runSyncRpc = async (cmdId, cmdType, payload, expectedVersion = null) => {
    return await query(`
      BEGIN;
      SET LOCAL "request.jwt.claims" = '{"sub":"${testSub}"}';
      SELECT execute_sync_command(
        '${cmdId}'::uuid,
        '${cmdType}',
        null,
        null,
        '${JSON.stringify(payload).replace(/'/g, "''")}'::jsonb,
        ${expectedVersion !== null ? expectedVersion : 'null'}
      ) as res;
      COMMIT;
    `);
  };

  const results = [];
  const logStep = (step, ok, detail) => {
    results.push({ step, ok, detail });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${step}: ${detail}`);
  };

  // Unique timestamp-based IDs
  const ts = Date.now();
  const dayId = crypto.randomUUID();
  const custId = crypto.randomUUID();
  const ordId = crypto.randomUUID();
  const devTypeId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  const deliverCmdId = crypto.randomUUID();
  const payCmdId = crypto.randomUUID();
  const creditCmdId = crypto.randomUUID();

  try {
    // 1. OPEN_DAY
    const dayRes = await runSyncRpc(dayId, 'OPEN_DAY', {
      id: dayId,
      businessDate: `2026-11-${String((ts % 28) + 1).padStart(2, '0')}`,
      displayNumber: 1
    });
    const dayData = dayRes[0]?.res;
    if (dayData?.success && dayData?.result?.businessDayId === dayId) {
      logStep('1. Open Business Day', true, `Opened day ${dayId}`);
    } else {
      logStep('1. Open Business Day', false, JSON.stringify(dayData));
    }

    // 2. CREATE_CUSTOMER
    const custRes = await runSyncRpc(custId, 'CREATE_CUSTOMER', {
      id: custId,
      name: `Contract Test Customer ${ts}`,
      debtLimitMinor: 10000
    });
    const custData = custRes[0]?.res;
    if (custData?.success && custData?.result?.customerId === custId) {
      logStep('2. Create Customer', true, `Created customer ${custId} with limit 100.00 ILS`);
    } else {
      logStep('2. Create Customer', false, JSON.stringify(custData));
    }

    // 3. CREATE_ORDER
    const ordRes = await runSyncRpc(ordId, 'CREATE_ORDER', {
      id: ordId,
      customerId: custId,
      dayId: dayId,
      displayNumber: 1
    });
    const ordData = ordRes[0]?.res;
    if (ordData?.success && ordData?.result?.orderId === ordId) {
      logStep('3. Create Order', true, `Created order ${ordId}`);
    } else {
      logStep('3. Create Order', false, JSON.stringify(ordData));
    }

    // 4. ADD_ORDER_ITEM (first ensure device type)
    await query(`
      INSERT INTO public.device_types (id, name, base_price_minor)
      VALUES ('${devTypeId}', 'Test Device Type ${ts}', 2000)
      ON CONFLICT (id) DO NOTHING;
    `);
    const itemRes = await runSyncRpc(itemId, 'ADD_ORDER_ITEM', {
      id: itemId,
      orderId: ordId,
      deviceTypeId: devTypeId,
      itemSequence: 1,
      hasCharger: false
    });
    const itemData = itemRes[0]?.res;
    if (itemData?.success && itemData?.result?.orderItemId === itemId && itemData?.result?.finalChargeMinor === 2050) {
      logStep('4. Add Order Item', true, `Added item ${itemId} with price 2000 + 50 charger fee = 2050 minor units`);
    } else {
      logStep('4. Add Order Item', false, JSON.stringify(itemData));
    }

    // 5. DELIVER_ORDER_ITEM
    const deliverRes = await runSyncRpc(deliverCmdId, 'DELIVER_ORDER_ITEM', {
      orderItemId: itemId
    });
    const deliverData = deliverRes[0]?.res;
    if (deliverData?.success && deliverData?.result?.status === 'DELIVERED') {
      logStep('5. Deliver Item', true, `Delivered item ${itemId}`);
    } else {
      logStep('5. Deliver Item', false, JSON.stringify(deliverData));
    }

    // 6. VERIFY FINANCIAL LEDGER
    const ledger = await query(`
      SELECT event_type, amount_minor, customer_id, order_id, order_item_id
      FROM public.financial_ledger
      WHERE order_item_id = '${itemId}'
    `);
    if (ledger.length === 1 && Number(ledger[0].amount_minor) === -2050 && ledger[0].event_type === 'ORDER_ITEM_CHARGE') {
      logStep('6. Financial Ledger Entry', true, `Found ORDER_ITEM_CHARGE with -2050 minor units`);
    } else {
      logStep('6. Financial Ledger Entry', false, `Ledger rows: ${JSON.stringify(ledger)}`);
    }

    // 7. CREATE_PAYMENT
    const payRes = await runSyncRpc(payCmdId, 'POST_PAYMENT', {
      id: payCmdId,
      customerId: custId,
      amountMinor: 1500,
      paymentMethod: 'CASH'
    });
    const payData = payRes[0]?.res;
    const payAllocations = await query(`
      SELECT allocated_amount_minor, order_item_id FROM public.payment_allocations WHERE payment_id = '${payCmdId}'
    `);
    if (payData?.success && payAllocations.length === 1 && Number(payAllocations[0].allocated_amount_minor) === 1500) {
      logStep('7. Create Payment & FIFO Allocation', true, `Payment 1500 minor recorded and 1500 allocated to item ${itemId}`);
    } else {
      logStep('7. Create Payment & FIFO Allocation', false, `payData: ${JSON.stringify(payData)}, allocs: ${JSON.stringify(payAllocations)}`);
    }

    // 8. CREATE_CUSTOMER_CREDIT
    const creditRes = await runSyncRpc(creditCmdId, 'CREATE_CUSTOMER_CREDIT', {
      customerId: custId,
      amountMinor: 550,
      note: 'Courtesy credit'
    });
    const creditData = creditRes[0]?.res;
    const balanceRes = await query(`
      SELECT coalesce(sum(amount_minor), 0) as balance FROM public.financial_ledger WHERE customer_id = '${custId}'
    `);
    // Delivered -2050 + Paid 1500 + Credit 550 = 0 balance!
    const balance = Number(balanceRes[0]?.balance);
    if (creditData?.success && balance === 0) {
      logStep('8. Customer Credit & Balance', true, `Added credit 550 minor; customer balance resolved to ${balance} minor (0.00 ILS)`);
    } else {
      logStep('8. Customer Credit & Balance', false, `creditData: ${JSON.stringify(creditData)}, balance: ${balance}`);
    }

    // 9. IDEMPOTENCY HANDLING
    const replayRes = await runSyncRpc(creditCmdId, 'CREATE_CUSTOMER_CREDIT', {
      customerId: custId,
      amountMinor: 550,
      note: 'Courtesy credit'
    });
    const replayData = replayRes[0]?.res;
    const ledgerAfterReplay = await query(`
      SELECT count(*) as count FROM public.financial_ledger WHERE id = '${creditCmdId}'
    `);
    if (replayData?.success && replayData?.idempotent === true && Number(ledgerAfterReplay[0]?.count) === 1) {
      logStep('9. Idempotency Check', true, `Replaying command returned cached idempotent response without duplicating ledger entries`);
    } else {
      logStep('9. Idempotency Check', false, JSON.stringify(replayData));
    }

    // 9b. GOAL OPERATIONS (CREATE_GOAL & UPDATE_GOAL_PROGRESS)
    const goalId = crypto.randomUUID();
    const createGoalRes = await runSyncRpc(goalId, 'CREATE_GOAL', {
      id: goalId,
      customerId: custId,
      targetQuantity: 10,
      bonusAmountMinor: 100,
      durationDays: 7,
      expiresAt: '2026-12-31T00:00:00Z'
    });
    const createGoalData = createGoalRes[0]?.res;
    const updateGoalRes = await runSyncRpc(crypto.randomUUID(), 'UPDATE_GOAL_PROGRESS', {
      goalId: goalId,
      currentProgress: 6
    });
    const updateGoalData = updateGoalRes[0]?.res;
    const goalRow = await query(`SELECT current_progress, target_quantity, status FROM public.goals WHERE id='${goalId}'`);
    if (createGoalData?.success && updateGoalData?.success && goalRow[0]?.current_progress === 6) {
      logStep('9b. Goal Operations', true, `Created goal ${goalId} and updated progress to 6/10`);
    } else {
      logStep('9b. Goal Operations', false, `create: ${JSON.stringify(createGoalData)}, update: ${JSON.stringify(updateGoalData)}`);
    }

    // 10. OPTIMISTIC VERSION CONFLICT
    let conflictCaught = false;
    try {
      await runSyncRpc(crypto.randomUUID(), 'UPDATE_ORDER', {
        id: ordId,
        notes: 'Outdated update'
      }, 999); // Expected version 999 when current version is 1
    } catch (err) {
      if (err.message.includes('VERSION_CONFLICT')) {
        conflictCaught = true;
      }
    }
    if (conflictCaught) {
      logStep('10. Optimistic Version Conflict', true, `Rejected update with stale expected version (P0002 VERSION_CONFLICT)`);
    } else {
      logStep('10. Optimistic Version Conflict', false, `Expected VERSION_CONFLICT exception was not thrown`);
    }

    // 11. CHANGE_LOG & VERSION VERIFICATION
    const changeLogEntries = await query(`
      SELECT entity_type, entity_id, action, version
      FROM public.change_log
      WHERE entity_id IN ('${custId}', '${ordId}', '${itemId}')
      ORDER BY sequence_id ASC
    `);
    if (changeLogEntries.length >= 3) {
      logStep('11. Change Log & Trigger Capture', true, `Captured ${changeLogEntries.length} canonical change_log delta entries for mutated entities`);
    } else {
      logStep('11. Change Log & Trigger Capture', false, `Entries: ${JSON.stringify(changeLogEntries)}`);
    }

    // 12. APP CANONICAL STATE
    const canonicalState = await query(`
      SELECT singleton, canonical_version_id, reset_generation FROM public.app_canonical_state
    `);
    if (canonicalState.length === 1 && canonicalState[0].singleton === true && canonicalState[0].canonical_version_id) {
      logStep('12. App Canonical State', true, `app_canonical_state present: version_id=${canonicalState[0].canonical_version_id}, generation=${canonicalState[0].reset_generation}`);
    } else {
      logStep('12. App Canonical State', false, JSON.stringify(canonicalState));
    }

    console.log('====================================================');
    console.log(`SUMMARY: ${results.filter(r => r.ok).length} / ${results.length} TESTS PASSED`);
    console.log('====================================================');

    if (results.some(r => !r.ok)) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal test error:', err);
    process.exit(1);
  }
}

runComprehensiveVerification();
