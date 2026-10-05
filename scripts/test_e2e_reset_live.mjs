import { query } from "./db.mjs";

async function runE2EResetTest() {
  console.log("=================================================");
  console.log("STARTING FINAL END-TO-END REMOTE ONLINE RESET TEST");
  console.log("=================================================");

  // 1. Get current server reset generation
  const genBeforeRes = await query(`SELECT value_number FROM system_settings WHERE key = 'server_reset_generation';`);
  const genBefore = Number(genBeforeRes[0]?.value_number || 0);
  console.log("Current Generation:", genBefore);

  // 2. Find Super Admin auth user ID
  const adminRes = await query(`SELECT auth_user_id FROM admins WHERE role ILIKE '%SUPER_ADMIN%' LIMIT 1;`);
  if (!adminRes || adminRes.length === 0) {
    throw new Error("No Super Admin found.");
  }
  const superAdminAuthUserId = adminRes[0].auth_user_id;

  // 3. Seed test data to prove purge
  console.log("Seeding test data (Customer + Ledger entry)...");
  const testCustomerId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const testLedgerId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  
  const seedRes = await query(`
    INSERT INTO customers (id, name, phone) VALUES ('${testCustomerId}', 'Reset Test Customer', '123') ON CONFLICT DO NOTHING;
    INSERT INTO financial_ledger (id, customer_id, event_type, amount_minor) VALUES ('${testLedgerId}', '${testCustomerId}', 'CHARGE', 1000) ON CONFLICT DO NOTHING;
  `);
  console.log("Seed result:", JSON.stringify(seedRes));

  // 4. Perform the Reset
  console.log("Invoking reset_online_business_data...");
  const resetRes = await query(`
    SET LOCAL request.jwt.claim.sub = '${superAdminAuthUserId}';
    SELECT public.reset_online_business_data('123456') AS res;
  `);
  
  const resJson = resetRes[0]?.res;
  if (!resJson || !resJson.success) {
    throw new Error("FAIL: Reset RPC failed: " + JSON.stringify(resetRes));
  }
  console.log(">> PASS: reset_online_business_data returned success.");
  console.log("Deleted Counts:", JSON.stringify(resJson.deletedCounts));

  // 5. Verify Purge
  const customerCheck = await query(`SELECT count(*) FROM customers WHERE id = '${testCustomerId}';`);
  const ledgerCheck = await query(`SELECT count(*) FROM financial_ledger WHERE id = '${testLedgerId}';`);
  
  if (Number(customerCheck[0].count) !== 0 || Number(ledgerCheck[0].count) !== 0) {
    throw new Error("FAIL: Test data was not purged!");
  }
  console.log(">> PASS: Test data purged successfully.");

  // 6. Verify Generation advanced
  const genAfterRes = await query(`SELECT value_number FROM system_settings WHERE key = 'server_reset_generation';`);
  const genAfter = Number(genAfterRes[0]?.value_number);
  if (genAfter !== genBefore + 1) {
    throw new Error(`FAIL: Generation did not increment exactly once. Before: ${genBefore}, After: ${genAfter}`);
  }
  console.log(">> PASS: Reset generation incremented correctly to", genAfter);

  // 7. Verify Protection is Active
  console.log("Verifying append-only protection remains active...");
  const newCustomerId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const newLedgerId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  
  await query(`INSERT INTO customers (id, name, phone) VALUES ('${newCustomerId}', 'Post-Reset Customer', '456');`);
  await query(`INSERT INTO financial_ledger (id, customer_id, event_type, amount_minor) VALUES ('${newLedgerId}', '${newCustomerId}', 'CHARGE', 500);`);

  const updateAttempt = await query(`UPDATE financial_ledger SET amount_minor = 999 WHERE id = '${newLedgerId}';`);
  if (updateAttempt && updateAttempt.message && updateAttempt.message.includes("P0001")) {
    console.log(">> PASS: Normal UPDATE successfully blocked with P0001.");
  } else {
    throw new Error("FAIL: Normal UPDATE was not blocked! Response: " + JSON.stringify(updateAttempt));
  }

  const deleteAttempt = await query(`DELETE FROM financial_ledger WHERE id = '${newLedgerId}';`);
  if (deleteAttempt && deleteAttempt.message && deleteAttempt.message.includes("P0001")) {
    console.log(">> PASS: Normal DELETE successfully blocked with P0001.");
  } else {
    throw new Error("FAIL: Normal DELETE was not blocked! Response: " + JSON.stringify(deleteAttempt));
  }

  console.log("=================================================");
  console.log("END-TO-END RESET VERIFIED");
  console.log("=================================================");
}

runE2EResetTest().catch(err => {
  console.error("E2E Test Failed:", err);
  process.exit(1);
});
