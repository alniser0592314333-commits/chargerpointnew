import { describe, it, expect, beforeEach } from 'vitest';
import { AuthorizationContext } from '../application/authContext';
import { FinalUseCases, RepositoryContext } from '../application/useCases';
import { BinRequiredError, AuthorizationError, InsufficientPermissionError } from '../domain/errors';
import { localDb } from '../infrastructure/localDb/localDb';
import {
  topUpCustomerBalance,
  setRuntimeBinVerifier,
  getCustomerDetail,
  getCustomerFinancialHistory,
  resetStoreMemory,
  validateBinFormat,
  seedDemoOperationalData,
} from '../components/pages/dayOrdersStore';

describe('Phase 5 Security: Admin BIN Verification & Authorization Boundary Tests', () => {
  // Test fixture credentials for testing boundary logic (NO production secrets)
  const TEST_VALID_ADMIN_A_BIN = '7890';
  const TEST_VALID_ADMIN_B_BIN = '4567';

  beforeEach(async () => {
    await localDb.clear();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    resetStoreMemory();
    await seedDemoOperationalData();
    setRuntimeBinVerifier(null);
  });

  // 1. Correct BIN accepted by AuthorizationContext
  it('1. Correct BIN is accepted by AuthorizationContext when valid verifier passes', () => {
    const auth = new AuthorizationContext(
      {
        id: 'admin_1',
        username: 'admin',
        fullName: 'Admin',
        role: 'ADMIN',
        permissions: ['finance:credit-adjustment'],
        isSuperAdmin: false,
      },
      (bin) => bin === TEST_VALID_ADMIN_A_BIN
    );

    expect(() => auth.verifyBin(TEST_VALID_ADMIN_A_BIN)).not.toThrow();
  });

  // 2. Wrong 4-digit BIN rejected by AuthorizationContext
  it('2. Wrong 4-digit BIN throws AuthorizationError', () => {
    const auth = new AuthorizationContext(
      {
        id: 'admin_1',
        username: 'admin',
        fullName: 'Admin',
        role: 'ADMIN',
        permissions: ['finance:credit-adjustment'],
        isSuperAdmin: false,
      },
      (bin) => bin === TEST_VALID_ADMIN_A_BIN
    );

    expect(() => auth.verifyBin('9999')).toThrow(AuthorizationError);
  });

  // 3. Another wrong 4-digit BIN rejected
  it('3. Another wrong 4-digit BIN is also rejected', () => {
    const auth = new AuthorizationContext(
      {
        id: 'admin_1',
        username: 'admin',
        fullName: 'Admin',
        role: 'ADMIN',
        permissions: ['finance:credit-adjustment'],
        isSuperAdmin: false,
      },
      (bin) => bin === TEST_VALID_ADMIN_A_BIN
    );

    expect(() => auth.verifyBin('0000')).toThrow(AuthorizationError);
  });

  // 4. Empty BIN rejected
  it('4. Empty / whitespace BIN throws BinRequiredError', () => {
    const auth = new AuthorizationContext({
      id: 'admin_1',
      username: 'admin',
      fullName: 'Admin',
      role: 'ADMIN',
      permissions: ['finance:credit-adjustment'],
      isSuperAdmin: false,
    });

    expect(() => auth.verifyBin('')).toThrow(BinRequiredError);
    expect(() => auth.verifyBin('   ')).toThrow(BinRequiredError);
  });

  // 5. Non-numeric / short BIN rejected
  it('5. Non-numeric or short BIN throws BinRequiredError', () => {
    const auth = new AuthorizationContext({
      id: 'admin_1',
      username: 'admin',
      fullName: 'Admin',
      role: 'ADMIN',
      permissions: ['finance:credit-adjustment'],
      isSuperAdmin: false,
    });

    expect(() => auth.verifyBin('12')).toThrow(BinRequiredError);
    expect(() => auth.verifyBin('abcd')).toThrow(BinRequiredError);
  });

  // 6. Missing required permission rejected regardless of BIN
  it('6. Missing required permission is rejected before or during use case', async () => {
    const mockRepo: any = {
      ledgerRepo: { append: async () => {} },
    };
    const useCases = new FinalUseCases(mockRepo);

    const authWithoutPermission = new AuthorizationContext({
      id: 'admin_1',
      username: 'admin',
      fullName: 'Admin',
      role: 'ADMIN',
      permissions: ['orders:view'], // missing finance:credit-adjustment
      isSuperAdmin: false,
    });

    await expect(
      useCases.createCustomerCredit(authWithoutPermission, 'cust_1', 1000, TEST_VALID_ADMIN_A_BIN)
    ).rejects.toThrow(InsufficientPermissionError);
  });

  // 7. Authenticated admin A using admin B's credential rejected
  it("7. Authenticated admin A using admin B's credential is rejected", () => {
    const auth = new AuthorizationContext(
      {
        id: 'admin_A',
        username: 'adminA',
        fullName: 'Admin A',
        role: 'ADMIN',
        permissions: ['finance:credit-adjustment'],
        isSuperAdmin: false,
      },
      (bin, actor) => {
        if (actor.id === 'admin_A') return bin === TEST_VALID_ADMIN_A_BIN;
        if (actor.id === 'admin_B') return bin === TEST_VALID_ADMIN_B_BIN;
        return false;
      }
    );

    // Admin A trying to use Admin B's BIN
    expect(() => auth.verifyBin(TEST_VALID_ADMIN_B_BIN)).toThrow(AuthorizationError);
  });

  // 8. Unauthenticated caller rejected
  it('8. Unauthenticated caller throws AuthorizationError', () => {
    const unauth = new AuthorizationContext(null);
    expect(() => unauth.requireAuth()).toThrow(AuthorizationError);
    expect(() => unauth.verifyBin(TEST_VALID_ADMIN_A_BIN)).toThrow(AuthorizationError);
  });

  // 9. Direct invocation of sensitive operation with wrong BIN rejected
  it('9. Direct use case invocation with wrong BIN throws AuthorizationError', async () => {
    let ledgerAppendCalled = false;
    const mockRepo: any = {
      ledgerRepo: {
        append: async () => {
          ledgerAppendCalled = true;
        },
      },
    };
    const useCases = new FinalUseCases(mockRepo);

    const auth = new AuthorizationContext(
      {
        id: 'admin_1',
        username: 'admin',
        fullName: 'Admin',
        role: 'ADMIN',
        permissions: ['finance:credit-adjustment'],
        isSuperAdmin: false,
      },
      (bin) => bin === TEST_VALID_ADMIN_A_BIN
    );

    await expect(
      useCases.createCustomerCredit(auth, 'cust_1', 2500, '9999')
    ).rejects.toThrow(AuthorizationError);

    expect(ledgerAppendCalled).toBe(false);
  });

  // 10. Failed BIN verification produces zero financial mutation
  it('10. Failed BIN verification in topUpCustomerBalance produces zero financial mutation', async () => {
    setRuntimeBinVerifier((bin) => bin === TEST_VALID_ADMIN_A_BIN);

    const initialCust = await getCustomerDetail('cust-1');
    const initialBalance = initialCust!.currentBalanceMinor;
    const initialHist = await getCustomerFinancialHistory('cust-1', 'ar');
    const initialHistCount = initialHist.length;

    // Attempt top-up with wrong BIN
    const failedRes = await topUpCustomerBalance({
      customerId: 'cust-1',
      amountMinor: 3000,
      bin: '0000',
    });

    expect(failedRes.success).toBe(false);

    // Verify balance unchanged
    const afterCust = await getCustomerDetail('cust-1');
    expect(afterCust!.currentBalanceMinor).toBe(initialBalance);

    // Verify history unchanged
    const afterHist = await getCustomerFinancialHistory('cust-1', 'ar');
    expect(afterHist.length).toBe(initialHistCount);
  });

  // 11. Successful BIN verification produces exactly one intended financial mutation
  it('11. Successful BIN verification in topUpCustomerBalance produces exactly one financial mutation', async () => {
    setRuntimeBinVerifier((bin) => bin === TEST_VALID_ADMIN_A_BIN);

    const initialCust = await getCustomerDetail('cust-1');
    const initialBalance = initialCust!.currentBalanceMinor;
    const initialHist = await getCustomerFinancialHistory('cust-1', 'ar');
    const initialHistCount = initialHist.length;

    const topUpAmount = 4500;
    const successRes = await topUpCustomerBalance({
      customerId: 'cust-1',
      amountMinor: topUpAmount,
      bin: TEST_VALID_ADMIN_A_BIN,
      note: 'Verified Top-up',
    });

    expect(successRes.success).toBe(true);
    expect(successRes.newBalanceMinor).toBe(initialBalance + topUpAmount);

    const afterCust = await getCustomerDetail('cust-1');
    expect(afterCust!.currentBalanceMinor).toBe(initialBalance + topUpAmount);

    const afterHist = await getCustomerFinancialHistory('cust-1', 'ar');
    expect(afterHist.length).toBe(initialHistCount + 1);
  });

  // 12. Format validation unit tests
  it('12. Format validation validates syntax without acting as authentication', () => {
    expect(validateBinFormat('').valid).toBe(false);
    expect(validateBinFormat('123').valid).toBe(false);
    expect(validateBinFormat('1234').valid).toBe(true);
    expect(validateBinFormat('9999').valid).toBe(true);
  });

  // 13. Idempotency: repeated top-up with same key does not duplicate ledger
  it('13. Idempotent top-up with same key does not create duplicate financial records', async () => {
    setRuntimeBinVerifier((bin) => bin === TEST_VALID_ADMIN_A_BIN);

    const initialCust = await getCustomerDetail('cust-2');
    const initialBalance = initialCust!.currentBalanceMinor;
    const initialHist = await getCustomerFinancialHistory('cust-2', 'ar');
    const initialHistCount = initialHist.length;

    const key = crypto.randomUUID();
    const res1 = await topUpCustomerBalance({
      customerId: 'cust-2',
      amountMinor: 2000,
      bin: TEST_VALID_ADMIN_A_BIN,
      idempotencyKey: key,
    });
    expect(res1.success).toBe(true);

    const histAfterFirst = await getCustomerFinancialHistory('cust-2', 'ar');
    expect(histAfterFirst.length).toBe(initialHistCount + 1);

    // Second call with same idempotency key
    const res2 = await topUpCustomerBalance({
      customerId: 'cust-2',
      amountMinor: 2000,
      bin: TEST_VALID_ADMIN_A_BIN,
      idempotencyKey: key,
    });
    expect(res2.success).toBe(true);

    const histAfterSecond = await getCustomerFinancialHistory('cust-2', 'ar');
    // Financial entries must NOT be duplicated
    expect(histAfterSecond.length).toBe(initialHistCount + 1);
  });

  // 14. Verification that bin_hash is never exposed in client customer or detail models
  it('14. Customer and ViewModel queries never expose bin_hash or password credentials', async () => {
    const cust = await getCustomerDetail('cust-1');
    expect((cust as any).binHash).toBeUndefined();
    expect((cust as any).bin_hash).toBeUndefined();
    expect((cust as any).password).toBeUndefined();
  });
});
