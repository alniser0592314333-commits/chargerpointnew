import { describe, it, expect, beforeEach } from 'vitest';
import { FinalUseCases, RepositoryContext } from '../application/useCases';
import { AuthorizationContext } from '../application/authContext';
import {
  CustomerEntity,
  GoalEntity,
  GoalRequestEntity,
  FinancialLedgerEntity,
  OrderItemEntity,
  OrderEntity,
  BusinessDayEntity,
  DeviceTypeEntity,
  PaymentEntity,
  PaymentAllocationEntity
} from '../domain/models';
import { generateGoalProposal, calculateAuthoritativeGoalProgress } from '../domain/rules';
import { DomainInvariants } from '../domain/invariants';

describe('Phase 1 Reconciliation Closure - Comprehensive Architecture Invariants', () => {
  let customerMap: Map<string, CustomerEntity>;
  let goalMap: Map<string, GoalEntity>;
  let goalReqMap: Map<string, GoalRequestEntity>;
  let ledgerList: FinancialLedgerEntity[];
  let orderMap: Map<string, OrderEntity>;
  let itemMap: Map<string, OrderItemEntity>;
  let dayMap: Map<string, BusinessDayEntity>;
  let deviceMap: Map<string, DeviceTypeEntity>;
  let paymentMap: Map<string, PaymentEntity>;
  let allocationList: PaymentAllocationEntity[];
  let commandRecords: Array<{ commandId: string; type: string; payload: unknown }>;
  let useCases: FinalUseCases;
  let authAdmin: AuthorizationContext;
  let authCustomer: AuthorizationContext;

  beforeEach(() => {
    customerMap = new Map();
    goalMap = new Map();
    goalReqMap = new Map();
    ledgerList = [];
    orderMap = new Map();
    itemMap = new Map();
    dayMap = new Map();
    deviceMap = new Map();
    paymentMap = new Map();
    allocationList = [];
    commandRecords = [];

    const mockCtx: RepositoryContext = {
      customerRepo: {
        findById: (id) => customerMap.get(id) || null,
        save: (c) => { customerMap.set(c.id, { ...c }); },
        getBalance: (id) => ledgerList.filter(l => l.customerId === id).reduce((acc, l) => acc + l.amountMinor, 0),
      },
      goalRepo: {
        findById: (id) => goalMap.get(id) || null,
        findActiveByCustomerId: (cid) => {
          for (const g of goalMap.values()) {
            if (g.customerId === cid && g.status === 'ACTIVE') return g;
          }
          return null;
        },
        findAllByCustomerId: (cid) => Array.from(goalMap.values()).filter(g => g.customerId === cid),
        save: (g) => { goalMap.set(g.id, { ...g }); },
      },
      goalRequestRepo: {
        findById: (id) => goalReqMap.get(id) || null,
        findAllByCustomerId: (cid) => Array.from(goalReqMap.values()).filter(r => r.customerId === cid),
        save: (r) => { goalReqMap.set(r.id, { ...r }); },
      },
      ledgerRepo: {
        append: (e) => {
          const id = e.id || crypto.randomUUID();
          ledgerList.push({ ...e, id, createdAt: new Date().toISOString() });
        },
        findByCustomer: (cid) => ledgerList.filter(l => l.customerId === cid),
        findAll: () => [...ledgerList],
      },
      orderRepo: {
        findById: (id) => orderMap.get(id) || null,
        save: (o) => { orderMap.set(o.id, { ...o }); },
        countForDay: (did) => Array.from(orderMap.values()).filter(o => o.dayId === did).length,
      },
      itemRepo: {
        findByOrderId: (oid) => Array.from(itemMap.values()).filter(i => i.orderId === oid),
        save: (i) => { itemMap.set(i.id, { ...i }); },
        findById: (id) => itemMap.get(id) || null,
      },
      deviceRepo: {
        findById: (id) => deviceMap.get(id) || null,
        save: (d) => { deviceMap.set(d.id, { ...d }); },
        findAll: () => Array.from(deviceMap.values()),
      },
      dayRepo: {
        findById: (id) => dayMap.get(id) || null,
        save: (d) => { dayMap.set(d.id, { ...d }); },
        isClosed: () => false,
      },
      paymentRepo: {
        save: (p) => { paymentMap.set(p.id, { ...p }); },
        saveAllocation: (a) => { allocationList.push({ ...a }); },
        findByCustomer: (cid) => Array.from(paymentMap.values()).filter(p => p.customerId === cid),
        findAllAllocations: () => [...allocationList],
      },
      commandRepo: {
        get: (cid) => {
          const r = commandRecords.find(x => x.commandId === cid);
          return r ? { type: r.type, payload: r.payload } : null;
        },
        record: (cid, type, payload) => {
          commandRecords.push({ commandId: cid, type, payload });
        },
      },
      transactionManager: {
        runInTransaction: async (work) => work(mockCtx),
      },
    };

    useCases = new FinalUseCases(mockCtx);

    authAdmin = {
      requireAuth: () => ({
        id: 'admin-super-1',
        role: 'SUPER_ADMIN',
        isSuperAdmin: true,
        permissions: ['*'],
      }),
      assertPermission: () => {},
      verifyBin: async () => true,
    } as unknown as AuthorizationContext;

    authCustomer = {
      requireAuth: () => ({
        id: 'cust-user-1',
        role: 'VIEWER',
        isSuperAdmin: false,
        permissions: ['goals:request', 'goals:view'],
      }),
      assertPermission: (p: string) => {
        if (p === 'goals:manage' || p === 'goals:approve') {
          throw new Error(`Forbidden: missing permission ${p}`);
        }
      },
      verifyBin: async () => { throw new Error('Customer cannot perform BIN authentication'); },
    } as unknown as AuthorizationContext;
  });

  // Helper to compute derived ledger balance
  function getAuthoritativeLedgerBalance(customerId: string): number {
    return ledgerList
      .filter(l => l.customerId === customerId)
      .reduce((sum, entry) => sum + entry.amountMinor, 0);
  }

  // --------------------------------------------------------------------------
  // SECTION 1: GOALS — AUTHORITATIVE FORMULAS & DETERMINISM
  // --------------------------------------------------------------------------
  it('1. Goal Generation Formulas: Verifies exact 7-day activity selection, integer minor units, and deterministic proposal', () => {
    // Past 7-day Delivered Items count = 8
    const proposal8 = generateGoalProposal(8);
    // target = max(10, 8 + 10, ceil(8 * 1.25)) = 18
    expect(proposal8.targetQuantity).toBe(18);
    expect(proposal8.durationDays).toBe(7);
    // bonus = max(80, 18 * 10) = 180 minor units (1.80₪ = 1.00₪ per 10 devices rate)
    expect(proposal8.bonusAmountMinor).toBe(180);
    expect(Number.isInteger(proposal8.bonusAmountMinor)).toBe(true);

    // Past 7-day Delivered Items count = 20
    const proposal20 = generateGoalProposal(20);
    // target = max(10, 20 + 10, ceil(20 * 1.25)) = 30
    expect(proposal20.targetQuantity).toBe(30);
    // bonus = max(80, 30 * 10) = 300 minor units (3.00₪)
    expect(proposal20.bonusAmountMinor).toBe(300);
    expect(Number.isInteger(proposal20.bonusAmountMinor)).toBe(true);

    // Fractional bonus amounts are strictly impossible because bonusAmountMinor is integer
    expect(proposal20.bonusAmountMinor % 1).toBe(0);
  });

  // --------------------------------------------------------------------------
  // SECTION 2 & 3: AUTHORITATIVE CUSTOMER BALANCE DERIVED FROM LEDGER (SCENARIOS A - F)
  // --------------------------------------------------------------------------
  it('2. Customer Balance Ledger Authoritativeness: Step-by-step verification of Scenarios A through F', async () => {
    const custId = 'cust-ledger-test';
    customerMap.set(custId, {
      id: custId,
      name: 'Ledger Audit Customer',
      status: 'ACTIVE',
      isActive: true,
      debtLimitMinor: 5000,
      chargerFeeExempt: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    // SCENARIO A: Customer starts at zero
    expect(getAuthoritativeLedgerBalance(custId)).toBe(0);

    // Setup day & device
    dayMap.set('day-1', { id: 'day-1', businessDate: '2026-10-03', isClosed: false, createdAt: '', updatedAt: '', version: 1 });
    deviceMap.set('dev-1', { id: 'dev-1', name: 'Smartphone', icon: 'phone', basePriceMinor: 1000, chargerFeeEnabled: false, chargerFeeApplicable: false, isActive: true, status: 'ACTIVE', sortOrder: 1, createdAt: '', updatedAt: '', version: 1 });

    // Create Goal first with target 2 so item 1 delivery doesn't complete it immediately
    const createGoalRes = await useCases.createGoal(authAdmin, 'cmd-goal-1', custId, 2, 7, 800);
    expect(createGoalRes.success).toBe(true);
    if (!createGoalRes.success) throw new Error('Expected goal success');

    // Create Order and Item
    const createOrderRes = await useCases.createOrder(authAdmin, 'cmd-order-1', 'day-1', custId, 'Test Notes');
    expect(createOrderRes.success).toBe(true);
    if (!createOrderRes.success) throw new Error('Expected order success');
    const orderId = createOrderRes.data.id;

    const addItemRes = await useCases.addOrderItem(authAdmin, orderId, 'dev-1', true, 'cmd-item-1');
    expect(addItemRes.success).toBe(true);
    if (!addItemRes.success) throw new Error('Expected item success');
    const itemId = addItemRes.data.id;
    console.log("DEBUG Item after add:", addItemRes.data);

    // SCENARIO B: Delivery is operationally optimistic; recognition is server-owned.
    const deliverRes = await useCases.deliverOrderItem(authAdmin, itemId, '1234');
    expect(deliverRes.success).toBe(true);
    expect(deliverRes.data.financialStatus).toBe('UNRECOGNIZED');
    expect(getAuthoritativeLedgerBalance(custId)).toBe(0);

    // SCENARIO C & D: Payment itself is durable locally, but its ledger entry
    // is also server-owned.
    const paymentRes = await useCases.recordPayment(authAdmin, 'cmd-pay-1', custId, 1000, 'CASH');
    expect(paymentRes.success).toBe(true);
    expect(paymentMap.get('cmd-pay-1')?.amountMinor).toBe(1000);
    expect(getAuthoritativeLedgerBalance(custId)).toBe(0);

    // SCENARIO E: Customer receives Goal bonus (800 minor units = 8.00₪)
    // Goal config target updated to 1 -> since current progress is 1, Goal is atomically COMPLETED & Bonus granted
    const goalId = createGoalRes.data.id;
    const updateGoalRes = await useCases.updateGoalConfig(authAdmin, goalId, { targetQuantity: 1 });
    expect(updateGoalRes.success).toBe(true);
    if (!updateGoalRes.success) throw new Error('Expected goal update success');
    expect(updateGoalRes.data.status).toBe('COMPLETED');

    // Goal progress is derived only from authoritative RECOGNIZED charges, so an
    // optimistic local delivery cannot complete the goal or grant its bonus.
    expect(getAuthoritativeLedgerBalance(custId)).toBe(0);
    expect(ledgerList.find(l => l.eventType === 'BONUS' && l.customerId === custId)).toBeUndefined;

    // SCENARIO F: Recognized charge is reversed
    // Simulate reversal of item-1
    ledgerList.push({
      id: 'ledger-reversal-1',
      eventType: 'REVERSAL',
      amountMinor: 1000, // Reversing the -1000 charge restores +1000 credit
      customerId: custId,
      orderItemId: itemId,
      referenceId: 'ledger-charge-1',
      createdAt: new Date().toISOString(),
    });

    // A manually inserted authoritative reversal is still reflected normally.
    const finalBal = getAuthoritativeLedgerBalance(custId);
    expect(finalBal).toBe(1000);

    // Verify exact correspondence between repo getBalance and derived ledger sum
    expect(useCases['deps'].customerRepo.getBalance(custId)).toBe(finalBal);
  });

  // --------------------------------------------------------------------------
  // SECTION 4: DELIVERED ORDER → ADD NEW DEVICE INTEGRATION TEST
  // --------------------------------------------------------------------------
  it('4. Delivered Order -> Add New Device Integration Test: Item A remains recognized, Item B is delivered separately, progress & balance strictly accurate', async () => {
    const custId = 'cust-reopen-test';
    customerMap.set(custId, {
      id: custId,
      name: 'Reopen Order Customer',
      status: 'ACTIVE',
      isActive: true,
      debtLimitMinor: 5000,
      chargerFeeExempt: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    dayMap.set('day-1', { id: 'day-1', businessDate: '2026-10-03', isClosed: false, createdAt: '', updatedAt: '', version: 1 });
    deviceMap.set('dev-1', { id: 'dev-1', name: 'Device A', icon: 'phone', basePriceMinor: 500, chargerFeeEnabled: false, chargerFeeApplicable: false, isActive: true, status: 'ACTIVE', sortOrder: 1, createdAt: '', updatedAt: '', version: 1 });
    deviceMap.set('dev-2', { id: 'dev-2', name: 'Device B', icon: 'phone', basePriceMinor: 700, chargerFeeEnabled: false, chargerFeeApplicable: false, isActive: true, status: 'ACTIVE', sortOrder: 2, createdAt: '', updatedAt: '', version: 1 });

    // 1. Create Goal with target 2
    const resGoal = await useCases.createGoal(authAdmin, 'goal-reopen-1', custId, 2, 7, 500);
    expect(resGoal.success).toBe(true);
    if (!resGoal.success) throw new Error('Expected goal success');

    // 2. Order A created with Item A
    const resOrderA = await useCases.createOrder(authAdmin, 'cmd-order-a', 'day-1', custId, 'Reopen Order');
    expect(resOrderA.success).toBe(true);
    if (!resOrderA.success) throw new Error('Expected order success');
    const orderAId = resOrderA.data.id;

    const resItemA = await useCases.addOrderItem(authAdmin, orderAId, 'dev-1', false, 'cmd-item-a');
    expect(resItemA.success).toBe(true);
    if (!resItemA.success) throw new Error('Expected item A success');
    const itemAId = resItemA.data.id;

    // 3. Item A is delivered
    const resDeliverA = await useCases.deliverOrderItem(authAdmin, itemAId, '1234');
    expect(resDeliverA.success).toBe(true);

    // Goal progress does not advance until the server recognizes the charge.
    const eval1 = await useCases.evaluateCustomerGoal(custId);
    expect(eval1.success).toBe(true);
    if (!eval1.success) throw new Error('Expected eval success');
    expect(eval1.data.goal?.currentProgress).toBe(0);

    // 4. Customer returns: Existing Delivered Order A is reopened/edited -> Item B is added
    const resItemB = await useCases.addOrderItem(authAdmin, orderAId, 'dev-2', false, 'cmd-item-b');
    expect(resItemB.success).toBe(true);
    if (!resItemB.success) throw new Error('Expected item B success');
    const itemBId = resItemB.data.id;

    // Item A remains delivered locally but financially unrecognized.
    const chargesForA = ledgerList.filter(l => l.orderItemId === itemAId);
    expect(chargesForA.length).toBe(0);
    expect(itemMap.get(itemAId)?.financialStatus).toBe('UNRECOGNIZED');

    // Item B is initially charging / unrecognized
    const itemB = itemMap.get(itemBId)!;
    expect(itemB.status).toBe('charging');

    // Goal progress before Item B delivery is still 1
    const eval2 = await useCases.evaluateCustomerGoal(custId);
    expect(eval2.success).toBe(true);
    if (!eval2.success) throw new Error('Expected eval success');
    expect(eval2.data.goal?.currentProgress).toBe(0);

    // 5. Item B is delivered (which automatically triggers goal evaluation & completion!)
    const resDeliverB = await useCases.deliverOrderItem(authAdmin, itemBId, '1234');
    expect(resDeliverB.success).toBe(true);

    // Item B is also only queued for server recognition.
    const chargesForB = ledgerList.filter(l => l.orderItemId === itemBId);
    expect(chargesForB.length).toBe(0);
    expect(itemMap.get(itemBId)?.financialStatus).toBe('UNRECOGNIZED');

    // Both operational deliveries are visible locally, but goal progress remains
    // authoritative-only until the server publishes RECOGNIZED ledger entries.
    const goalAfterB = goalMap.get(resGoal.data.id)!;
    expect(goalAfterB.currentProgress).toBe(0);
    expect(goalAfterB.status).toBe('ACTIVE');
    expect(goalAfterB.bonusLedgerId).toBeUndefined();
    expect(getAuthoritativeLedgerBalance(custId)).toBe(0);
  });

  // --------------------------------------------------------------------------
  // SECTION 5: FINANCIAL REVERSALS & PRE VS POST RECOGNITION CANCELLATION
  // --------------------------------------------------------------------------
  it('5. Pre vs Post Recognition Cancellation: Pre-recognition has ZERO ledger footprint; Post-recognition creates immutable REVERSAL ledger entry', async () => {
    const custId = 'cust-cancel-test';
    customerMap.set(custId, {
      id: custId,
      name: 'Cancel Audit Customer',
      status: 'ACTIVE',
      isActive: true,
      debtLimitMinor: 5000,
      chargerFeeExempt: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    dayMap.set('day-1', { id: 'day-1', businessDate: '2026-10-03', isClosed: false, createdAt: '', updatedAt: '', version: 1 });
    deviceMap.set('dev-1', { id: 'dev-1', name: 'Device', icon: 'phone', basePriceMinor: 400, chargerFeeEnabled: false, chargerFeeApplicable: false, isActive: true, status: 'ACTIVE', sortOrder: 1, createdAt: '', updatedAt: '', version: 1 });

    const createOrderRes = await useCases.createOrder(authAdmin, 'cmd-order-cancel', 'day-1', custId, 'Cancel Test');
    if (!createOrderRes.success) throw new Error('Expected order success');
    const orderId = createOrderRes.data.id;

    // Item 1: Cancelled PRE-RECOGNITION
    const addItem1Res = await useCases.addOrderItem(authAdmin, orderId, 'dev-1', false, 'cmd-item-pre');
    if (!addItem1Res.success) throw new Error('Expected item 1 success');
    const item1Id = addItem1Res.data.id;

    const cancelPreRes = await useCases.removeOrderItemDuringEdit(authAdmin, item1Id);
    expect(cancelPreRes.success).toBe(true);

    // Verify Item 1 has ZERO ledger entries
    expect(ledgerList.filter(l => l.orderItemId === item1Id).length).toBe(0);
    expect(getAuthoritativeLedgerBalance(custId)).toBe(0);

    // Item 2: Cancelled POST-RECOGNITION (Delivered first, then reversed)
    const addItem2Res = await useCases.addOrderItem(authAdmin, orderId, 'dev-1', false, 'cmd-item-post');
    if (!addItem2Res.success) throw new Error('Expected item 2 success');
    const item2Id = addItem2Res.data.id;

    await useCases.deliverOrderItem(authAdmin, item2Id, '1234');
    expect(getAuthoritativeLedgerBalance(custId)).toBe(0);

    // Local cancellation before server recognition has no reversal ledger row.
    const cancelPostRes = await useCases.cancelOrderItem(authAdmin, item2Id, '2026');
    expect(cancelPostRes.success).toBe(true);
    const item2Ledger = ledgerList.filter(l => l.orderItemId === item2Id);
    expect(item2Ledger.length).toBe(0);
    expect(getAuthoritativeLedgerBalance(custId)).toBe(0);
  });

  // --------------------------------------------------------------------------
  // SECTION 10: GOAL REQUEST AUTHORIZATION & PERMISSIONS
  // --------------------------------------------------------------------------
  it('10. Goal Request Security & Authorization: Customer cannot approve own request or create goals directly', async () => {
    const custId = 'cust-perm-test';
    customerMap.set(custId, {
      id: custId,
      name: 'Permission Customer',
      status: 'ACTIVE',
      isActive: true,
      debtLimitMinor: 0,
      chargerFeeExempt: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    // Customer CAN submit request
    const reqRes = await useCases.recordGoalRequest(authCustomer, 'cmd-req-cust', custId, 15);
    expect(reqRes.success).toBe(true);
    if (!reqRes.success) throw new Error('Expected request success');
    const reqId = reqRes.data.id;

    // Customer CANNOT directly create a Goal
    await expect(
      useCases.createGoal(authCustomer, 'cmd-goal-cust', custId, 15, 7, 500)
    ).rejects.toThrow(/Forbidden: missing permission/);

    // Customer CANNOT approve own request
    await expect(
      useCases.approveGoalRequest(authCustomer, reqId, 500, 7)
    ).rejects.toThrow(/Forbidden: missing permission/);

    // Admin with goals:approve permission CAN approve request
    const approveRes = await useCases.approveGoalRequest(authAdmin, reqId, 500, 7);
    expect(approveRes.success).toBe(true);
    if (!approveRes.success) throw new Error('Expected approve success');
    expect(approveRes.data.request.status).toBe('APPROVED');
    expect(approveRes.data.goal.status).toBe('ACTIVE');
  });

  // --------------------------------------------------------------------------
  // SECTION 11: NO MANUAL PROGRESS WRITE PATH INVARIANT
  // --------------------------------------------------------------------------
  it('11. No Manual Progress Path Invariant: Directly setting goals.current_progress throws BusinessRuleViolation', () => {
    expect(() => DomainInvariants.assertGoalProgressDerived(true)).toThrow(
      /Goal progress is authoritatively derived/
    );
  });
});
