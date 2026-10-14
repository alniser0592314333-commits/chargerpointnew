import { describe, expect, it } from 'vitest';
import { AuthorizationContext } from '../application/authContext';
import { FinalUseCases } from '../application/useCases';

const validBin = '7890';
const customer = {
  id: 'customer-1',
  name: 'Before',
  phone: '',
  isActive: true,
  debtLimitMinor: -1000,
  chargerFeeExempt: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1,
};

function makeUseCases() {
  let recorded: any[] | null = null;
  let saved: any = null;
  const deps: any = {
    customerRepo: {
      findById: async () => ({ ...customer }),
      save: (value: any) => { saved = value; },
    },
    transactionManager: {
      runInTransaction: async (work: (ctx: any) => unknown) => work({
        customerRepo: { save: (value: any) => { saved = value; } },
        commandRepo: { record: (...args: any[]) => { recorded = args; } },
      }),
    },
  };
  return {
    useCases: new FinalUseCases(deps),
    getRecorded: () => recorded,
    getSaved: () => saved,
  };
}

const admin = (verifier?: (bin: string) => boolean | Promise<boolean>) =>
  new AuthorizationContext(
    {
      id: 'admin-1',
      username: 'admin',
      fullName: 'Admin',
      role: 'ADMIN',
      permissions: ['customers:edit', 'customers:debt-limit'],
      isSuperAdmin: false,
    },
    verifier ? (bin) => verifier(bin) : undefined
  );

describe('Customer update BIN sync contract', () => {
  it('includes the verified BIN in the same outbox command as a debt-limit change', async () => {
    const fixture = makeUseCases();
    await fixture.useCases.updateCustomer(
      admin((bin) => bin === validBin),
      customer.id,
      { name: 'After', debtLimitMinor: -2000 },
      validBin
    );

    const command = fixture.getRecorded();
    expect(command?.[1]).toBe('UPDATE_CUSTOMER');
    expect(command?.[2]).toMatchObject({
      id: customer.id,
      name: 'After',
      debtLimitMinor: -2000,
      bin: validBin,
    });
    expect(command?.[2]).not.toHaveProperty('debt_limit_minor');
    expect(fixture.getSaved()).toMatchObject({ name: 'After', debtLimitMinor: -2000, version: 2 });
  });

  it('does not include the debt-limit field or require BIN for an ordinary name edit', async () => {
    const fixture = makeUseCases();
    await fixture.useCases.updateCustomer(admin(), customer.id, { name: 'After' });

    const command = fixture.getRecorded();
    expect(command?.[2]).toMatchObject({ id: customer.id, name: 'After', version: 2 });
    expect(command?.[2]).not.toHaveProperty('debtLimitMinor');
    expect(command?.[2]).not.toHaveProperty('bin');
  });

  it('rejects a debt-limit change without a valid BIN before writing or queueing a command', async () => {
    const fixture = makeUseCases();
    await expect(
      fixture.useCases.updateCustomer(admin(), customer.id, { debtLimitMinor: -2000 })
    ).rejects.toThrow(/BIN/i);
    expect(fixture.getRecorded()).toBeNull();
    expect(fixture.getSaved()).toBeNull();
  });
});
