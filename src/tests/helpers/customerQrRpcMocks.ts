/**
 * Deterministic in-memory stand-in for the authoritative customer QR RPCs.
 * Used only by tests that exercise QR presentation/storage behavior without
 * reaching Supabase. The server token map is separate from local IndexedDB so
 * these tests enforce the central-identity contract.
 */
export const configureCustomerQrRpcMocks = (mocks: any, localDb: any): void => {
  const activeTokenByCustomer = new Map<string, string>();
  const customerByToken = new Map<string, string>();
  const customerCodes: Record<string, string> = {
    'cust-1': 'A7K2',
    'cust-2': '9FQX',
    'cust-3': 'M4P8',
    'cust-4': 'K3P9',
    'cust-5': '7X82',
    'cust-6': 'R9W4',
  };

  const newToken = (): string => globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 32);

  const resolveCustomerCode = (customerId: string): string =>
    customerCodes[customerId] || customerId.replace(/-/g, '').slice(0, 4).toUpperCase();

  mocks.getOrCreate.mockImplementation(async (customerId: string) => {
    let token = activeTokenByCustomer.get(customerId);
    if (!token) {
      token = newToken();
      activeTokenByCustomer.set(customerId, token);
      customerByToken.set(token, customerId);
    }
    return token;
  });

  mocks.adopt.mockImplementation(async (customerId: string, publicToken: string) => {
    const existing = activeTokenByCustomer.get(customerId);
    if (existing) return existing;

    const existingOwner = customerByToken.get(publicToken);
    const token = existingOwner && existingOwner !== customerId ? newToken() : publicToken;
    activeTokenByCustomer.set(customerId, token);
    customerByToken.set(token, customerId);
    return token;
  });

  mocks.rotate.mockImplementation(async (customerId: string) => {
    const token = newToken();
    activeTokenByCustomer.set(customerId, token);
    customerByToken.set(token, customerId);
    return token;
  });

  mocks.resolve.mockImplementation(async (publicToken: string) => {
    const customerId = customerByToken.get(publicToken);
    if (!customerId || activeTokenByCustomer.get(customerId) !== publicToken) return null;

    const customer = await localDb.get('customers', customerId);
    if (
      !customer ||
      customer.isActive !== true ||
      customer.deletedAt ||
      customer.status === 'DELETED'
    ) {
      return null;
    }

    return {
      customerName: customer.name,
      customerCode: resolveCustomerCode(customerId),
    };
  });
};
