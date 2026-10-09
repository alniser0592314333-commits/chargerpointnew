import { describe, it, expect, beforeEach } from 'vitest';
import { FinalUseCases, RepositoryContext } from '../application/useCases';
import { AuthorizationContext } from '../application/authContext';
import { 
  CustomerEntity, 
  GoalEntity, 
  GoalRequestEntity, 
  FinancialLedgerEntity, 
  OrderItemEntity,
  BusinessDayEntity,
  OrderEntity,
  DeviceTypeEntity
} from '../domain/models';
import { generateGoalProposal, calculateAuthoritativeGoalProgress } from '../domain/rules';
import { DomainInvariants } from '../domain/invariants';

describe('Canonical Goals Domain & Foundation Invariants', () => {
  let customerMap: Map<string, CustomerEntity>;
  let goalMap: Map<string, GoalEntity>;
  let goalReqMap: Map<string, GoalRequestEntity>;
  let ledgerList: FinancialLedgerEntity[];
  let orderMap: Map<string, OrderEntity>;
  let itemMap: Map<string, OrderItemEntity>;
  let dayMap: Map<string, BusinessDayEntity>;
  let commandRecords: Array<{ commandId: string; type: string; payload: unknown }>;
  let useCases: FinalUseCases;
  let authAdmin: AuthorizationContext;

  beforeEach(() => {
    customerMap = new Map();
    goalMap = new Map();
    goalReqMap = new Map();
    ledgerList = [];
    orderMap = new Map();
    itemMap = new Map();
    dayMap = new Map();
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
        findById: () => null,
        save: () => {},
        findAll: () => [],
      },
      dayRepo: {
        findById: (id) => dayMap.get(id) || null,
        save: (d) => { dayMap.set(d.id, { ...d }); },
        isClosed: () => false,
      },
      paymentRepo: {
        save: () => {},
        saveAllocation: () => {},
        findByCustomer: () => [],
        findAllAllocations: () => [],
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
        id: 'admin-1',
        role: 'SUPER_ADMIN',
        isSuperAdmin: true,
        permissions: ['*'],
      }),
      assertPermission: () => {},
      verifyBin: async () => true,
    } as unknown as AuthorizationContext;
  });

  it('1. Goal Generation Proposal: Deterministically calculates target, variable duration, and reconciled bonus formula', () => {
    // 0 past items -> baseline minimum 10 target, default 10 minor/device rate = 100 minor bonus (1.00 ILS / 10 devices)
    const proposalZero = generateGoalProposal(0, { customDurationDays: 7, customRatePerDeviceMinor: 10, startedAt: '2026-10-01T00:00:00.000Z' });
    expect(proposalZero.targetQuantity).toBe(10);
    expect(proposalZero.durationDays).toBe(7);
    expect(proposalZero.bonusAmountMinor).toBe(100);
    expect(Number.isInteger(proposalZero.bonusAmountMinor)).toBe(true);

    // Baseline 8 items -> target = max(10, 8+10, ceil(8*1.25)) = 18 target
    const proposal8 = generateGoalProposal(8, { customRatePerDeviceMinor: 8, customDurationDays: 7, startedAt: '2026-10-01T00:00:00.000Z' });
    expect(proposal8.targetQuantity).toBe(18);
    // Rate 8 minor/device (0.80 ILS per 10 devices) -> 18 * 8 = 144 minor units (1.44 ILS)
    expect(proposal8.bonusAmountMinor).toBe(144);

    // Baseline 20 items -> target = max(10, 20+10, ceil(20*1.25)) = 30 target
    const proposal20 = generateGoalProposal(20, { customRatePerDeviceMinor: 13, customDurationDays: 7, startedAt: '2026-10-01T00:00:00.000Z' });
    expect(proposal20.targetQuantity).toBe(30);
    expect(proposal20.durationDays).toBe(7);
    // Rate 13 minor/device (1.30 ILS per 10 devices) -> 30 * 13 = 390 minor units (3.90 ILS)
    expect(proposal20.bonusAmountMinor).toBe(390);

    // Verify whole-number minor units invariant
    expect(proposal20.bonusAmountMinor % 1).toBe(0);
  });

  it('2. Single Active Goal Invariant: Rejects creating a second active goal for the same customer', async () => {
    const custId = 'cust-100';
    customerMap.set(custId, {
      id: custId,
      name: 'Test Customer',
      status: 'ACTIVE',
      isActive: true,
      debtLimitMinor: 0,
      chargerFeeExempt: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    const res1 = await useCases.createGoal(authAdmin, 'goal-1', custId, 15, 7, 120);
    expect(res1.success).toBe(true);
    if (!res1.success) throw new Error('Expected success');
    expect(res1.data.status).toBe('ACTIVE');

    // Attempting to create second active goal must throw
    await expect(
      useCases.createGoal(authAdmin, 'goal-2', custId, 20, 7, 160)
    ).rejects.toThrow(/already has an active goal/);
  });

  it('3. Goal Progress & Automatic Completion: Delivering qualifying items advances progress and grants bonus exactly once in financial ledger', async () => {
    const custId = 'cust-200';
    customerMap.set(custId, {
      id: custId,
      name: 'Progress Customer',
      status: 'ACTIVE',
      isActive: true,
      debtLimitMinor: 0,
      chargerFeeExempt: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    // Create goal with target 2
    const resGoal = await useCases.createGoal(authAdmin, 'goal-prog-1', custId, 2, 7, 16);
    expect(resGoal.success).toBe(true);
    if (!resGoal.success) throw new Error('Expected success');
    const goal = resGoal.data;

    // Initial state: progress 0
    expect(goal.currentProgress).toBe(0);
    expect(goal.status).toBe('ACTIVE');
    expect(ledgerList.length).toBe(0);

    // Simulate 1st delivered & recognized item in ledger
    ledgerList.push({
      id: 'ledger-charge-1',
      eventType: 'ORDER_ITEM_CHARGE',
      amountMinor: -200,
      customerId: custId,
      orderItemId: 'item-1',
      createdAt: new Date().toISOString(),
    });

    const eval1 = await useCases.evaluateCustomerGoal(custId);
    expect(eval1.success).toBe(true);
    if (!eval1.success) throw new Error('Expected success');
    expect(eval1.data.goal?.currentProgress).toBe(1);
    expect(eval1.data.goal?.status).toBe('ACTIVE');
    expect(ledgerList.some(l => l.eventType === 'BONUS')).toBe(false);

    // The client reports progress but does not authoritatively complete the goal or issue a bonus.
    const eval2 = await useCases.evaluateCustomerGoal(custId);
    expect(eval2.success).toBe(true);
    if (!eval2.success) throw new Error('Expected success');
    expect(eval2.data.goal?.currentProgress).toBe(2);
    expect(eval2.data.goal?.status).toBe('ACTIVE');
    expect(eval2.data.goal?.completedAt).toBeUndefined();
    expect(eval2.data.goal?.bonusLedgerId).toBeUndefined();
    expect(ledgerList.some(l => l.eventType === 'BONUS' && l.customerId === custId)).toBe(false);

    // Simulate the server's accepted completion event and immutable ledger bonus.
    const serverCompletedAt = new Date().toISOString();
    goalMap.set(goal.id, {
      ...goalMap.get(goal.id)!,
      status: 'COMPLETED',
      completedAt: serverCompletedAt,
      bonusLedgerId: 'ledger-bonus-server',
    });
    ledgerList.push({
      id: 'ledger-bonus-server',
      eventType: 'BONUS',
      amountMinor: 16,
      customerId: custId,
      referenceId: goal.id,
      createdAt: serverCompletedAt,
    });

    // Re-evaluation after authoritative completion must not grant a duplicate bonus.
    const eval3 = await useCases.evaluateCustomerGoal(custId);
    expect(eval3.success).toBe(true);
    if (!eval3.success) throw new Error('Expected success');
    expect(eval3.data.hasActiveGoal).toBe(false);
    const bonusEntriesAfterRetry = ledgerList.filter(l => l.eventType === 'BONUS' && l.customerId === custId);
    expect(bonusEntriesAfterRetry.length).toBe(1);
    expect(bonusEntriesAfterRetry[0].amountMinor).toBe(16);
  });

  it('4. Goal Editing: Target modification where target <= currentProgress immediately triggers completion & bonus', async () => {
    const custId = 'cust-300';
    customerMap.set(custId, {
      id: custId,
      name: 'Edit Customer',
      status: 'ACTIVE',
      isActive: true,
      debtLimitMinor: 0,
      chargerFeeExempt: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    // Create goal with target 10
    const resGoal = await useCases.createGoal(authAdmin, 'goal-edit-1', custId, 10, 7, 80);
    expect(resGoal.success).toBe(true);
    if (!resGoal.success) throw new Error('Expected success');
    const goal = resGoal.data;

    // Set progress to 5
    goal.currentProgress = 5;
    goalMap.set(goal.id, goal);

    // Admin edits target down to 5 (target <= currentProgress)
    const updateRes = await useCases.updateGoalConfig(authAdmin, goal.id, { targetQuantity: 5 });
    expect(updateRes.success).toBe(true);
    if (!updateRes.success) throw new Error('Expected success');
    expect(updateRes.data.status).toBe('ACTIVE');
    expect(updateRes.data.completedAt).toBeUndefined();
    expect(updateRes.data.bonusLedgerId).toBeUndefined();
    expect(ledgerList.some(l => l.eventType === 'BONUS' && l.customerId === custId)).toBe(false);

    // Completion and bonus are applied only after the authoritative server result.
    const serverCompletedAt = new Date().toISOString();
    goalMap.set(goal.id, {
      ...updateRes.data,
      status: 'COMPLETED',
      completedAt: serverCompletedAt,
      bonusLedgerId: 'ledger-edit-server',
    });
    ledgerList.push({
      id: 'ledger-edit-server',
      eventType: 'BONUS',
      amountMinor: 80,
      customerId: custId,
      referenceId: goal.id,
      createdAt: serverCompletedAt,
    });
    const bonus = ledgerList.find(l => l.eventType === 'BONUS' && l.customerId === custId);
    expect(bonus).toBeDefined();
    expect(bonus?.amountMinor).toBe(80);
  });

  it('5. Goal Expiration: Client defers expiry status to the authoritative server and grants no local bonus', async () => {
    const custId = 'cust-400';
    customerMap.set(custId, {
      id: custId,
      name: 'Expired Customer',
      status: 'ACTIVE',
      isActive: true,
      debtLimitMinor: 0,
      chargerFeeExempt: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    const pastStarted = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const pastExpires = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    const expiredGoal: GoalEntity = {
      id: 'goal-exp-1',
      customerId: custId,
      targetQuantity: 10,
      currentProgress: 3, // only reached 3 out of 10
      bonusAmountMinor: 80,
      durationDays: 7,
      status: 'ACTIVE',
      startedAt: pastStarted,
      expiresAt: pastExpires,
      createdAt: pastStarted,
      updatedAt: pastStarted,
      version: 1,
    };
    goalMap.set(expiredGoal.id, expiredGoal);

    const evalRes = await useCases.evaluateCustomerGoal(custId);
    expect(evalRes.success).toBe(true);
    if (!evalRes.success) throw new Error('Expected success');
    expect(evalRes.data.goal?.status).toBe('ACTIVE');
    const expiryCommand = commandRecords.find((record) => record.type === 'UPDATE_GOAL_PROGRESS');
    expect((expiryCommand?.payload as { expiresAt?: string } | undefined)?.expiresAt).toBe(pastExpires);

    // No bonus entry in ledger
    const bonus = ledgerList.find(l => l.eventType === 'BONUS' && l.customerId === custId);
    expect(bonus).toBeUndefined();
  });

  it('6. Goal Request Lifecycle: Request (PENDING) -> Approve (creates ACTIVE goal) vs Reject (no goal created)', async () => {
    const custId = 'cust-500';
    customerMap.set(custId, {
      id: custId,
      name: 'Req Customer',
      status: 'ACTIVE',
      isActive: true,
      debtLimitMinor: 0,
      chargerFeeExempt: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    // 1. Customer submits request
    const reqRes = await useCases.recordGoalRequest(authAdmin, 'req-1', custId, 12);
    expect(reqRes.success).toBe(true);
    if (!reqRes.success) throw new Error('Expected success');
    expect(reqRes.data.status).toBe('PENDING');

    // 2. Admin rejects first request
    const rejectRes = await useCases.rejectGoalRequest(authAdmin, 'req-1', 'Target too low for customer tier');
    expect(rejectRes.success).toBe(true);
    if (!rejectRes.success) throw new Error('Expected success');
    expect(rejectRes.data.status).toBe('REJECTED');
    expect(rejectRes.data.rejectionReason).toBe('Target too low for customer tier');

    // Verify NO active goal created
    const activeGoalAfterReject = await mockFindActive(custId);
    expect(activeGoalAfterReject).toBeNull();

    // 3. Customer submits new request
    const reqRes2 = await useCases.recordGoalRequest(authAdmin, 'req-2', custId, 15);
    expect(reqRes2.success).toBe(true);

    // 4. Admin approves second request -> creates active Goal
    const approveRes = await useCases.approveGoalRequest(authAdmin, 'req-2', 120, 7);
    expect(approveRes.success).toBe(true);
    if (!approveRes.success) throw new Error('Expected success');
    expect(approveRes.data.request.status).toBe('APPROVED');
    expect(approveRes.data.goal.status).toBe('ACTIVE');
    expect(approveRes.data.goal.targetQuantity).toBe(15);
    expect(approveRes.data.goal.bonusAmountMinor).toBe(120);
  });

  it('7. Comprehensive Goal Editing Boundary Cases: target > progress remains ACTIVE; target <= progress COMPLETED; editing completed goal throws', async () => {
    const custId = 'cust-edit-bounds';
    customerMap.set(custId, {
      id: custId,
      name: 'Edit Bounds Cust',
      status: 'ACTIVE',
      isActive: true,
      debtLimitMinor: 0,
      chargerFeeExempt: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    // Create goal target 10, current progress 4
    const resGoal = await useCases.createGoal(authAdmin, 'goal-bound-1', custId, 10, 7, 80);
    expect(resGoal.success).toBe(true);
    if (!resGoal.success) throw new Error('Expected success');
    const goal = resGoal.data;
    goal.currentProgress = 4;
    goalMap.set(goal.id, goal);

    // Case A: Edit target to 6 (greater than progress 4) -> Goal remains ACTIVE
    const editResA = await useCases.updateGoalConfig(authAdmin, goal.id, { targetQuantity: 6 });
    expect(editResA.success).toBe(true);
    if (!editResA.success) throw new Error('Expected success');
    expect(editResA.data.status).toBe('ACTIVE');

    // Case B: Edit target to 4 (equal to progress 4) -> Goal becomes COMPLETED & bonus issued
    const editResB = await useCases.updateGoalConfig(authAdmin, goal.id, { targetQuantity: 4 });
    expect(editResB.success).toBe(true);
    if (!editResB.success) throw new Error('Expected success');
    expect(editResB.data.status).toBe('ACTIVE');
    expect(editResB.data.bonusLedgerId).toBeUndefined();
    expect(ledgerList.some(l => l.eventType === 'BONUS' && l.customerId === custId)).toBe(false);

    // Simulate the server's accepted completion before testing immutability.
    const serverCompletedAt = new Date().toISOString();
    goalMap.set(goal.id, {
      ...editResB.data,
      status: 'COMPLETED',
      completedAt: serverCompletedAt,
      bonusLedgerId: 'ledger-bound-server',
    });
    ledgerList.push({
      id: 'ledger-bound-server',
      eventType: 'BONUS',
      amountMinor: 80,
      customerId: custId,
      referenceId: goal.id,
      createdAt: serverCompletedAt,
    });
    const bonusList = ledgerList.filter(l => l.eventType === 'BONUS' && l.customerId === custId);
    expect(bonusList.length).toBe(1);

    // Case C: Attempting to edit completed goal MUST throw BusinessRuleViolation
    await expect(
      useCases.updateGoalConfig(authAdmin, goal.id, { targetQuantity: 3 })
    ).rejects.toThrow(/Completed\/closed goals are immutable/);

    // Verify bonus is not duplicated
    expect(ledgerList.filter(l => l.eventType === 'BONUS' && l.customerId === custId).length).toBe(1);
  });

  it('8. Historical Goal Reversal Semantics: Item reversal after goal completion keeps historical COMPLETED goal & bonus intact', async () => {
    const custId = 'cust-reversal-hist';
    customerMap.set(custId, {
      id: custId,
      name: 'Reversal History Cust',
      status: 'ACTIVE',
      isActive: true,
      debtLimitMinor: 0,
      chargerFeeExempt: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    // Create goal target 1
    const resGoal = await useCases.createGoal(authAdmin, 'goal-rev-1', custId, 1, 7, 13);
    expect(resGoal.success).toBe(true);
    if (!resGoal.success) throw new Error('Expected goal success');

    // Add item charge & evaluate -> goal completes
    ledgerList.push({
      id: 'charge-item-1',
      eventType: 'ORDER_ITEM_CHARGE',
      amountMinor: -1000,
      customerId: custId,
      orderItemId: 'item-rev-1',
      createdAt: new Date().toISOString(),
    });

    const evalRes = await useCases.evaluateCustomerGoal(custId);
    expect(evalRes.success).toBe(true);
    if (!evalRes.success) throw new Error('Expected eval success');
    expect(evalRes.data.goal?.currentProgress).toBe(1);
    expect(evalRes.data.goal?.status).toBe('ACTIVE');
    expect(ledgerList.some(l => l.eventType === 'BONUS' && l.customerId === custId)).toBe(false);

    // Simulate the server-confirmed completion before reversing the item.
    const serverCompletedAt = new Date().toISOString();
    goalMap.set(resGoal.data.id, {
      ...goalMap.get(resGoal.data.id)!,
      status: 'COMPLETED',
      completedAt: serverCompletedAt,
      bonusLedgerId: 'ledger-reversal-bonus-server',
    });
    ledgerList.push({
      id: 'ledger-reversal-bonus-server',
      eventType: 'BONUS',
      amountMinor: 13,
      customerId: custId,
      referenceId: resGoal.data.id,
      createdAt: serverCompletedAt,
    });

    // Item-1 is reversed post-completion
    ledgerList.push({
      id: 'reversal-item-1',
      eventType: 'REVERSAL',
      amountMinor: 1000,
      customerId: custId,
      orderItemId: 'item-rev-1',
      referenceId: 'charge-item-1',
      createdAt: new Date().toISOString(),
    });

    // Re-evaluation after reversal: Completed goal remains COMPLETED, bonus remains in ledger
    const evalPostReversal = await useCases.evaluateCustomerGoal(custId);
    expect(evalPostReversal.success).toBe(true);
    if (!evalPostReversal.success) throw new Error('Expected eval success');

    const goalInMap = goalMap.get(resGoal.data.id)!;
    expect(goalInMap.status).toBe('COMPLETED');
    expect(ledgerList.filter(l => l.eventType === 'BONUS' && l.customerId === custId).length).toBe(1);
  });

  function mockFindActive(cid: string): GoalEntity | null {
    for (const g of goalMap.values()) {
      if (g.customerId === cid && g.status === 'ACTIVE') return g;
    }
    return null;
  }
});
