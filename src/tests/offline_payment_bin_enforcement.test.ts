import { describe, expect, it } from 'vitest';
import { AuthorizationContext } from '../application/authContext';
import { FinalUseCases } from '../application/useCases';

const actor = {
  id: 'admin-payment-test',
  username: 'admin',
  fullName: 'Admin',
  role: 'SUPER_ADMIN' as const,
  permissions: ['finance:create-payment'] as any[],
  isSuperAdmin: true,
};

function makeUseCases() {
  const recorded: any[] = [];
  const overlays: any[] = [];
  let overlaySequence = 0;
  const useCases = new FinalUseCases({
    customerRepo: { findById: async () => ({ id: 'customer-1', isActive: true }) },
    ledgerRepo: { findByCustomer: async () => [] },
    paymentRepo: { findAllAllocations: async () => [] },
    commandRepo: { record: async (...args: any[]) => { recorded.push(args); } },
    overlayRepo: {
      getNextSequence: async () => ++overlaySequence,
      save: async (overlay: any) => { overlays.push(overlay); },
    },
    mutationSnapshotRepo: { capture: async () => {} },
  } as any);
  return { useCases, recorded, overlays };
}

describe('offline customer payment BIN enforcement', () => {
  it('requires and verifies a BIN before an online payment can be queued', async () => {
    const { useCases, recorded, overlays } = makeUseCases();
    const auth = new AuthorizationContext(actor, async (bin) => bin === '1234');

    await expect(
      useCases.recordPayment(auth, crypto.randomUUID(), 'customer-1', 500, 'CASH')
    ).rejects.toThrow(/BIN/i);
    expect(recorded).toHaveLength(0);
    expect(overlays).toHaveLength(0);

    const result = await useCases.recordPayment(
      auth, crypto.randomUUID(), 'customer-1', 500, 'CASH', undefined, undefined, '1234'
    );
    expect(result.success).toBe(true);
    expect(recorded[0]?.[1]).toBe('CREATE_PAYMENT');
    expect(recorded[0]?.[2]).toMatchObject({ bin: '1234' });
    expect(recorded[0]?.[2]).not.toHaveProperty('deferBinVerification');
    expect(overlays).toHaveLength(2);
  });

  it('allows an offline local projection only when explicitly marked for deferred BIN verification', async () => {
    const { useCases, recorded, overlays } = makeUseCases();
    const auth = new AuthorizationContext(actor);

    const result = await useCases.recordPayment(
      auth,
      crypto.randomUUID(),
      'customer-1',
      500,
      'CASH',
      undefined,
      undefined,
      '',
      { deferBinVerification: true }
    );

    expect(result.success).toBe(true);
    expect(recorded[0]?.[1]).toBe('CREATE_PAYMENT');
    expect(recorded[0]?.[2]).toMatchObject({ deferBinVerification: true });
    expect(recorded[0]?.[2]).not.toHaveProperty('bin');
    expect(overlays).toHaveLength(0);
  });

  it('does not allow the deferred flag to bypass BIN verification on a normal online call', async () => {
    const { useCases, recorded } = makeUseCases();
    const auth = new AuthorizationContext(actor);

    await expect(
      useCases.recordPayment(
        auth, crypto.randomUUID(), 'customer-1', 500, 'CASH', undefined, undefined, '',
        { deferBinVerification: false }
      )
    ).rejects.toThrow(/BIN/i);
    expect(recorded).toHaveLength(0);
  });
});
