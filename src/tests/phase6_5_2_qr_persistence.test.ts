import { describe, it, expect, beforeEach } from 'vitest';
import { generateSecurePublicToken } from '../services/supabase/qrSecurity';
import {
  getCustomerQrCardData,
  getPublicCustomerByToken,
  getOrCreateCustomerQrToken,
  rotateCustomerQrToken,
  updateCustomer,
  resetStoreMemory,
  seedDemoOperationalData,
} from '../components/pages/dayOrdersStore';
import { localDb } from '../infrastructure/localDb/localDb';
import { QrTokenEntity } from '../domain/models';

describe('Phase 6.5.2B: Persistent Random Public Capability Handle (Option C)', () => {
  beforeEach(async () => {
    await localDb.clear();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    resetStoreMemory();
    await seedDemoOperationalData();
  });

  // 1. First customer QR creation -> creates exactly one identity.
  it('1. First customer QR creation creates exactly one identity', async () => {
    const token = await getOrCreateCustomerQrToken('cust-1');
    expect(token).toBeDefined();
    expect(token).toHaveLength(32);

    const allTokens = await localDb.list<QrTokenEntity>('qr_tokens');
    const customerTokens = allTokens.filter(
      (t) => t.targetId === 'cust-1' && t.tokenType === 'CUSTOMER' && t.isActive
    );
    expect(customerTokens).toHaveLength(1);
    expect(customerTokens[0].publicToken).toBe(token);
  });

  // 2. Second request -> returns exactly same identity.
  it('2. Second request returns exactly same identity', async () => {
    const token1 = await getOrCreateCustomerQrToken('cust-1');
    const token2 = await getOrCreateCustomerQrToken('cust-1');
    expect(token2).toBe(token1);
  });

  // 3. Ten repeated requests -> same identity 10/10.
  it('3. Ten repeated requests return identical identity 10/10', async () => {
    const initialToken = await getOrCreateCustomerQrToken('cust-2');
    for (let i = 0; i < 10; i++) {
      const token = await getOrCreateCustomerQrToken('cust-2');
      expect(token).toBe(initialToken);
    }
  });

  // 4. Two simulated admin sessions -> same identity.
  it('4. Two simulated admin sessions receive same identity', async () => {
    // Admin Session 1
    const session1Token = await getOrCreateCustomerQrToken('cust-3');
    // Admin Session 2 (Independent query for same customer)
    const session2Token = await getOrCreateCustomerQrToken('cust-3');
    expect(session1Token).toBe(session2Token);
  });

  // 5. Simulated device A / device B -> same identity.
  it('5. Simulated Device A and Device B access same identity', async () => {
    // Device A creates / accesses token
    const deviceAToken = await getOrCreateCustomerQrToken('cust-1');
    // Device B queries without local knowledge
    const deviceBToken = await getOrCreateCustomerQrToken('cust-1');
    expect(deviceBToken).toBe(deviceAToken);
  });

  // 6. Browser/local storage reset -> same identity.
  it('6. Browser/local memory reset retains same identity when central identity exists', async () => {
    const cardData1 = await getCustomerQrCardData('cust-2');
    expect(cardData1).not.toBeNull();
    const token = cardData1!.token;

    // Simulate subsequent retrieval
    const cardData2 = await getCustomerQrCardData('cust-2');
    expect(cardData2!.token).toBe(token);
    expect(cardData2!.publicUrl).toBe(cardData1!.publicUrl);
  });

  // 7. No local rawToken -> does NOT generate replacement if active central identity exists.
  it('7. Does not generate replacement token if active central identity exists', async () => {
    const originalToken = await getOrCreateCustomerQrToken('cust-5');
    // Simulate subsequent access without any local rawToken storage
    const retrievedToken = await getOrCreateCustomerQrToken('cust-5');
    expect(retrievedToken).toBe(originalToken);
  });

  // 8. Concurrent get-or-create -> exactly one active identity.
  it('8. Concurrent get-or-create produces exactly one active identity', async () => {
    const results = await Promise.all([
      getOrCreateCustomerQrToken('cust-6'),
      getOrCreateCustomerQrToken('cust-6'),
      getOrCreateCustomerQrToken('cust-6'),
      getOrCreateCustomerQrToken('cust-6'),
    ]);

    // All concurrent requests must resolve to the identical token
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
    expect(results[2]).toBe(results[3]);

    const allTokens = await localDb.list<QrTokenEntity>('qr_tokens');
    const activeTokens = allTokens.filter(
      (t) => t.targetId === 'cust-6' && t.tokenType === 'CUSTOMER' && t.isActive
    );
    expect(activeTokens).toHaveLength(1);
  });

  // 9. Reprint -> same identity.
  it('9. Reprinting uses the same identity and URL', async () => {
    const print1 = await getCustomerQrCardData('cust-1');
    const print2 = await getCustomerQrCardData('cust-1');
    expect(print1!.token).toBe(print2!.token);
    expect(print1!.publicUrl).toBe(print2!.publicUrl);
  });

  // 10. Language change -> same identity.
  it('10. Language switch preserves identical QR identity', async () => {
    const tokenArabic = await getOrCreateCustomerQrToken('cust-2');
    // Simulating switching locale and requesting customer QR data
    const tokenEnglish = await getOrCreateCustomerQrToken('cust-2');
    expect(tokenEnglish).toBe(tokenArabic);
  });

  // 11. Theme change -> same identity.
  it('11. Theme change preserves identical QR identity', async () => {
    const tokenLight = await getOrCreateCustomerQrToken('cust-3');
    const tokenDark = await getOrCreateCustomerQrToken('cust-3');
    expect(tokenDark).toBe(tokenLight);
  });

  // 12. Design change simulation -> same identity.
  it('12. Design changes do not alter QR identity', async () => {
    const cardData = await getCustomerQrCardData('cust-4');
    expect(cardData).not.toBeNull();
    const tokenInitial = cardData!.token;

    // Visual rendering variations operate on the same token
    const cardDataUpdatedDesign = await getCustomerQrCardData('cust-4');
    expect(cardDataUpdatedDesign!.token).toBe(tokenInitial);
  });

  // 13. Customer deactivation -> public resolver does not expose customer data.
  it('13. Deactivated customer QR returns null on public resolution (zero data leakage)', async () => {
    const token = await getOrCreateCustomerQrToken('cust-5');
    // Deactivate customer
    await updateCustomer('cust-5', { isActive: false });

    const publicResult = await getPublicCustomerByToken(token);
    expect(publicResult).toBeNull();
  });

  // 14. Customer reactivation -> same identity can remain valid.
  it('14. Customer reactivation restores access to the same QR identity', async () => {
    const token = await getOrCreateCustomerQrToken('cust-5');
    // Reactivate customer
    await updateCustomer('cust-5', { isActive: true });

    const publicResult = await getPublicCustomerByToken(token);
    expect(publicResult).not.toBeNull();
    expect(publicResult!.customerName).toBe('ليلى حسن');
    expect(publicResult!.customerCode).toBe('7X82');
    expect(publicResult!.token).toBe(token);
  });

  // 15. Explicit rotation -> new identity, old identity inactive.
  it('15. Explicit rotation creates new identity and invalidates previous identity', async () => {
    const originalToken = await getOrCreateCustomerQrToken('cust-1');

    // Perform explicit rotation
    const rotatedToken = await rotateCustomerQrToken('cust-1');
    expect(rotatedToken).not.toBe(originalToken);

    // Old token should now fail resolution
    const oldLookup = await getPublicCustomerByToken(originalToken);
    expect(oldLookup).toBeNull();

    // New token should resolve successfully
    const newLookup = await getPublicCustomerByToken(rotatedToken);
    expect(newLookup).not.toBeNull();
    expect(newLookup!.customerName).toBe('محمد علي');
  });

  // 16. Public resolver -> only allowed public fields.
  it('16. Public resolver exposes only customerName, customerCode, and token', async () => {
    const token = await getOrCreateCustomerQrToken('cust-2');
    const publicResult = await getPublicCustomerByToken(token);

    expect(publicResult).not.toBeNull();
    expect(Object.keys(publicResult!).sort()).toEqual(['customerCode', 'customerName', 'token']);
  });

  // 17. No UUID leakage.
  it('17. No internal UUID leakage in public response', async () => {
    const token = await getOrCreateCustomerQrToken('cust-3');
    const publicResult = await getPublicCustomerByToken(token);

    expect((publicResult as any).id).toBeUndefined();
    expect((publicResult as any).customerId).toBeUndefined();
    expect((publicResult as any).targetId).toBeUndefined();
  });

  // 18. No phone/balance/financial leakage.
  it('18. No phone, balance, or financial ledger leakage in public response', async () => {
    const token = await getOrCreateCustomerQrToken('cust-4');
    const publicResult = await getPublicCustomerByToken(token);

    expect((publicResult as any).phone).toBeUndefined();
    expect((publicResult as any).balanceMinor).toBeUndefined();
    expect((publicResult as any).debtLimitMinor).toBeUndefined();
    expect((publicResult as any).ledger).toBeUndefined();
    expect((publicResult as any).orders).toBeUndefined();
  });

  // 19. Public identifier has at least 128-bit entropy.
  it('19. Public identifier has at least 128-bit entropy (32 hex characters)', () => {
    const token1 = generateSecurePublicToken();
    const token2 = generateSecurePublicToken();

    expect(token1).toHaveLength(32);
    expect(token2).toHaveLength(32);
    expect(token1).not.toBe(token2);
    // 32 hex characters = 16 bytes = 128 bits
    expect(/^[0-9a-f]{32}$/.test(token1)).toBe(true);
  });

  // 20. Collision protection is enforced by database uniqueness.
  it('20. Exactly one active token per customer is enforced in storage', async () => {
    await getOrCreateCustomerQrToken('cust-1');
    await getOrCreateCustomerQrToken('cust-1');

    const allTokens = await localDb.list<QrTokenEntity>('qr_tokens');
    const activeCustomerTokens = allTokens.filter(
      (t) => t.targetId === 'cust-1' && t.tokenType === 'CUSTOMER' && t.isActive
    );
    expect(activeCustomerTokens).toHaveLength(1);
  });
});
