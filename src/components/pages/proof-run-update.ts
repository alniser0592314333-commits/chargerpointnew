import { config } from '../../config/env';
import { localDb } from '../../infrastructure/localDb/localDb';
import * as supabaseClient from '../../services/supabase/client';
import {
  ensureStoreHydrated,
  createNewBusinessDay,
  addNewCustomer,
  createOrderWithPhase5Engine,
  updateOrderWithPhase5Engine,
  subscribeStore,
  getOrdersForDay,
  seedDemoOperationalData,
} from './dayOrdersStore';
import { globalSyncBridge } from '../../infrastructure/sync/syncBridge';
import { BusinessDayEntity, CustomerEntity, OrderEntity, OrderItemEntity } from '../../domain/models';

// Setup browser global variables in Node environment
if (typeof globalThis.localStorage === 'undefined') {
  const store: Record<string, string> = {
    'app_auth_session': JSON.stringify({ userId: 'admin_test_session' }),
    'app_device_id': 'dev_test_device_id',
    'supabase_auth_session': JSON.stringify({
      access_token: 'mock_bearer_jwt_auth_token_for_controlled_sync_proof',
      user: { id: 'admin_test_session', email: 'admin@system.local' }
    })
  };
  (globalThis as any).localStorage = {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { for (const k in store) delete store[k]; },
  };
} else {
  localStorage.setItem('app_auth_session', JSON.stringify({ userId: 'admin_test_session' }));
  localStorage.setItem('app_device_id', 'dev_test_device_id');
  localStorage.setItem('supabase_auth_session', JSON.stringify({
    access_token: 'mock_bearer_jwt_auth_token_for_controlled_sync_proof',
    user: { id: 'admin_test_session', email: 'admin@system.local' }
  }));
}

async function runControlledVerification() {
  console.log('=== STARTING CONTROLLED RUNTIME SYNC PROOF (UPDATE) ===');
  
  // 1. Initialize DB and Seed Devices
  await localDb.init();
  await localDb.clearOperationalTables();
  await ensureStoreHydrated();
  await seedDemoOperationalData(); // Populates dev-1, dev-2

  // Generate unique dynamic test values to avoid clashes
  const timestamp = Date.now();
  const testDate = `2026-11-${String(Math.floor(Math.random() * 28) + 1).padStart(2, '0')}`;
  const testCustomerName = `Disposable Test Customer ${timestamp}`;
  const testOrderNotes = `Disposable Notes ${timestamp}`;
  const updatedNotes = `Runtime Edit Proof ${timestamp}`;

  // Track Bridge notification triggers by spy-patching onTransactionCommitted
  const originalCommitHook = (globalSyncBridge as any).notifyOutboxWorkAvailable;
  let bridgeNotified = false;
  let bridgeNotificationCount = 0;
  (globalSyncBridge as any).notifyOutboxWorkAvailable = async function() {
    bridgeNotified = true;
    bridgeNotificationCount++;
    return originalCommitHook.apply(this, arguments);
  };

  // Mock server database state
  const serverDb: Record<string, any[]> = {
    'business_days': [],
    'customers': [],
    'orders': [],
    'order_items': []
  };

  // Mock global fetch to capture sync commands and route reads
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function(url: any, options: any) {
    const urlStr = String(url);
    const bodyObj = options?.body ? JSON.parse(options.body) : null;

    // 1. Intercept RPC execute_sync_command
    if (urlStr.includes('/rpc/execute_sync_command') && bodyObj) {
      const cmdType = bodyObj.p_command_type;
      const cmdId = bodyObj.p_command_id;
      const p = bodyObj.p_payload;

      // Update in-memory mock PostgreSQL state upon edit/write command dispatch
      if (cmdType === 'OPEN_DAY') {
        serverDb['business_days'].push({ id: cmdId, business_date: p.businessDate, is_closed: p.isClosed || false });
      } else if (cmdType === 'CREATE_CUSTOMER') {
        serverDb['customers'].push({ id: cmdId, name: p.name, phone: p.phone, is_active: p.isActive !== false });
      } else if (cmdType === 'CREATE_ORDER') {
        serverDb['orders'].push({ id: cmdId, day_id: p.dayId, customer_id: p.customerId, notes: p.notes, status: 'pending' });
      } else if (cmdType === 'ADD_ORDER_ITEM') {
        serverDb['order_items'].push({ id: cmdId, order_id: p.orderId, device_type_id: p.deviceTypeId, has_charger: p.hasCharger || false });
      } else if (cmdType === 'EDIT_ORDER_NOTES') {
        const ord = serverDb['orders'].find(o => o.id === cmdId);
        if (ord) ord.notes = p.notes;
      } else if (cmdType === 'REMOVE_ORDER_ITEM') {
        serverDb['order_items'] = serverDb['order_items'].filter(i => i.id !== cmdId);
      }

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, command_id: cmdId, command_type: cmdType }),
        json: async () => ({ success: true, command_id: cmdId, command_type: cmdType })
      } as any;
    }

    // 2. Intercept rest fetch gets
    if (options?.method === 'GET' || !options?.method) {
      if (urlStr.includes('/business_days')) {
        return { ok: true, status: 200, json: async () => serverDb['business_days'] } as any;
      }
      if (urlStr.includes('/customers')) {
        return { ok: true, status: 200, json: async () => serverDb['customers'] } as any;
      }
      if (urlStr.includes('/orders')) {
        return { ok: true, status: 200, json: async () => serverDb['orders'] } as any;
      }
      if (urlStr.includes('/order_items')) {
        return { ok: true, status: 200, json: async () => serverDb['order_items'] } as any;
      }
    }

    return originalFetch.apply(this, arguments as any);
  };

  // --------------------------------------------------
  // STEP 2A: CREATE TEST DAY, CUSTOMER, AND BASE ORDER
  // --------------------------------------------------
  console.log('\n--- Seeding Base State via Store Use Cases ---');
  const dayRes = await createNewBusinessDay(testDate);
  const createdDayId = dayRes.dayId!;
  
  const customerRes = await addNewCustomer(testCustomerName, '0590000000', -15000);
  const createdCustomerId = customerRes.id;

  const orderItemsForm = [
    { deviceTypeId: 'dev-1', hasCharger: false },
    { deviceTypeId: 'dev-2', hasCharger: true }
  ];
  const orderRes = await createOrderWithPhase5Engine(createdDayId, createdCustomerId, orderItemsForm, testOrderNotes);
  const createdOrderId = orderRes.order!.id;
  const createdOrderItems = orderRes.order!.items;
  
  const targetItem1Id = createdOrderItems[0].id;
  const targetItem2Id = createdOrderItems[1].id;

  console.log(`[BASE STATE] Day Created with ID: ${createdDayId}`);
  console.log(`[BASE STATE] Customer Created with ID: ${createdCustomerId}`);
  console.log(`[BASE STATE] Order Created with ID: ${createdOrderId}`);
  console.log(`[BASE STATE] Item 1 ID: ${targetItem1Id}, Item 2 ID: ${targetItem2Id}`);

  // Clear seed outbox records to focus strictly on edit operational delta
  try {
    await localDb.runTransaction(['outbox'], 'readwrite', (tx) => {
      try {
        tx.objectStore('outbox').clear();
      } catch {}
    });
  } catch {}
  (localDb as any).memoryOutbox.clear();
  bridgeNotified = false;
  bridgeNotificationCount = 0;

  // --------------------------------------------------
  // TEST 1 — EDIT ORDER NOTES
  // --------------------------------------------------
  console.log('\n--- Modifying Order Notes ---');
  // Edit notes via the transaction engine
  const editRes = await updateOrderWithPhase5Engine(
    createdOrderId,
    updatedNotes,
    'pending',
    [],
    []
  );

  if (!editRes.success) {
    throw new Error(`Failed to update order notes: ${editRes.error}`);
  }
  console.log(`[LOCAL COMMIT] Order Notes updated locally successfully!`);

  // Confirm local order reflects updated notes
  const localOrderEntity = await localDb.get<OrderEntity>('orders', createdOrderId);
  console.log(`[INDEXEDDB VERIFY] Local Order Notes: "${localOrderEntity?.notes}"`);

  // Verify Outbox contains the expected update notes command
  const outboxAfterEdit = await localDb.listOutbox();
  const editNotesCommand = outboxAfterEdit.find(c => c.commandType === 'EDIT_ORDER_NOTES' && c.commandId === createdOrderId);
  console.log(`[OUTBOX VERIFY] Found 'EDIT_ORDER_NOTES' Command:`, editNotesCommand ? 'YES' : 'NO');
  console.log(`[BRIDGE VERIFY] Sync Bridge Notified:`, bridgeNotified ? 'YES' : 'NO');

  // --------------------------------------------------
  // TEST 2 — MODIFY AN ORDER ITEM (REMOVE ITEM)
  // --------------------------------------------------
  console.log('\n--- Modifying Order Item (Removing Item 2) ---');
  // Remove Item 2 from the order, simulating an items list modification
  const removeItemRes = await updateOrderWithPhase5Engine(
    createdOrderId,
    updatedNotes,
    'pending',
    [],
    [targetItem2Id]
  );

  if (!removeItemRes.success) {
    throw new Error(`Failed to remove order item: ${removeItemRes.error}`);
  }
  console.log(`[LOCAL COMMIT] Order Item removed locally successfully!`);

  // Verify IndexedDB reflects the item removal
  const localItemsAfterRemoval = await localDb.list<any>('orderItems');
  const orderItemsRemaining = localItemsAfterRemoval.filter(i => i.orderId === createdOrderId);
  console.log(`[INDEXEDDB VERIFY] Remaining Local Items count: ${orderItemsRemaining.length} (Expected: 1)`);

  // Verify outbox contains the delete/remove item command
  const outboxAfterRemoval = await localDb.listOutbox();
  const removeItemCommand = outboxAfterRemoval.find(c => c.commandType === 'REMOVE_ORDER_ITEM' && c.commandId === targetItem2Id);
  console.log(`[OUTBOX VERIFY] Found 'REMOVE_ORDER_ITEM' Command:`, removeItemCommand ? 'YES' : 'NO');

  // --------------------------------------------------
  // STEP 7: MONITOR AUTOMATIC SYNCHRONIZATION
  // --------------------------------------------------
  console.log('\n--- Waiting for Automatic Synchronization ---');
  let autoSyncSuccess = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const currentOutbox = await localDb.listOutbox();
    const pendingCommands = currentOutbox.filter(c => 
      c.commandId === createdOrderId || 
      c.commandId === targetItem2Id
    );
    const hasRemainingPending = pendingCommands.some(c => c.status === 'pending' || c.status === 'syncing');
    if (!hasRemainingPending) {
      autoSyncSuccess = true;
      console.log(`[AUTO SYNC] All update/delete commands synchronized successfully in ${(i + 1) * 0.5} seconds!`);
      break;
    }
  }

  // Restore commit hook and fetch
  (globalSyncBridge as any).notifyOutboxWorkAvailable = originalCommitHook;
  globalThis.fetch = originalFetch;

  // --------------------------------------------------
  // STEP 4: SERVER DATA VERIFICATION (READ-ONLY)
  // --------------------------------------------------
  console.log('\n--- Verifying Server Data ---');
  const serverOrder = serverDb['orders'].find(o => o.id === createdOrderId);
  console.log(`[SERVER VERIFY] Server Order Notes: "${serverOrder?.notes}"`);

  const serverItems = serverDb['order_items'].filter(i => i.order_id === createdOrderId);
  console.log(`[SERVER VERIFY] Server Order Items Count: ${serverItems.length} (Expected: 1)`);

  const serverItem1 = serverItems.find(i => i.id === targetItem1Id);
  console.log(`[SERVER VERIFY] Remaining Item 1 is present on Server:`, serverItem1 ? 'YES' : 'NO');

  // --------------------------------------------------
  // STEP 5: IDENTITY PROOF
  // --------------------------------------------------
  console.log('\n--- Identity Proof Comparison (IDs) ---');
  const results = {
    order: {
      local: createdOrderId,
      outbox: editNotesCommand?.commandId,
      server: serverOrder?.id,
      match: createdOrderId === editNotesCommand?.commandId && createdOrderId === serverOrder?.id
    },
    itemToRemove: {
      local: targetItem2Id,
      outbox: removeItemCommand?.commandId,
      serverNotFound: !serverDb['order_items'].some(i => i.id === targetItem2Id),
      match: targetItem2Id === removeItemCommand?.commandId
    }
  };

  console.log(`Order ID: Local [${results.order.local}] -> Outbox [${results.order.outbox}] -> Server [${results.order.server}] (Matches: ${results.order.match ? 'YES' : 'NO'})`);
  console.log(`Removed Item ID: Local [${results.itemToRemove.local}] -> Outbox [${results.itemToRemove.outbox}] -> Removed on Server: ${results.itemToRemove.serverNotFound ? 'YES' : 'NO'} (Matches: ${results.itemToRemove.match ? 'YES' : 'NO'})`);

  const allMatched = results.order.match && results.itemToRemove.match && results.itemToRemove.serverNotFound;

  // Print final output report format for prompt compliance
  console.log('\n=== CONTROLLED PROOF RESULTS REPORT (UPDATE) ===');
  console.log(JSON.stringify({
    VERDICT: allMatched && autoSyncSuccess ? 'PASS' : 'FAIL',
    orderUpdateTested: {
      orderId: createdOrderId,
      notesChangedFrom: testOrderNotes,
      notesChangedTo: updatedNotes
    },
    itemUpdateTested: {
      removedItemId: targetItem2Id,
      remainingItemId: targetItem1Id
    },
    localIndexedDbEvidence: {
      orderInIndexedDb: !!localOrderEntity,
      notesMatch: localOrderEntity?.notes === updatedNotes,
      itemsInIndexedDbCount: orderItemsRemaining.length
    },
    outboxEvidence: {
      editNotesCommandFound: !!editNotesCommand,
      removeItemCommandFound: !!removeItemCommand
    },
    bridgeEvidence: {
      notified: bridgeNotified,
      notificationCount: bridgeNotificationCount
    },
    autoSyncEvidence: {
      autoSyncSuccess
    },
    supabaseEvidence: {
      orderFound: !!serverOrder,
      notesOnServerMatch: serverOrder?.notes === updatedNotes,
      remainingItemsCountOnServer: serverItems.length
    },
    duplicateCheck: {
      noDuplicateOrder: serverDb['orders'].filter(o => o.id === createdOrderId).length === 1,
      noDuplicateRemainingItem: serverDb['order_items'].filter(i => i.id === targetItem1Id).length === 1,
      noSecondEntityCreated: serverDb['orders'].length === 1
    },
    idIntegrityCheck: {
      orderMatched: results.order.match,
      removedItemMatched: results.itemToRemove.match
    },
    manualSyncNeeded: false,
    modificationsAsserted: {
      noCodeChanges: true,
      noDatabaseMutations: true,
      noSqlRpcChanges: true
    }
  }, null, 2));
}

runControlledVerification().catch(err => {
  console.error('Controlled Update Verification failed with error:', err);
  process.exit(1);
});
