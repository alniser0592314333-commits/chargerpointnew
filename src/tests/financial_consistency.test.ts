
import { describe, test, expect, beforeEach, vi as jest } from 'vitest';
import { localDb } from '../infrastructure/localDb/localDb';
import { FinalUseCases } from '../application/useCases';
import { AuthorizationContext } from '../application/authContext';
import { ID } from '../types/common';

describe('Financial Consistency Audit & Idempotency', () => {
  let useCases: any;
  const adminAuth = new AuthorizationContext(
    { 
      id: 'admin-1', 
      username: 'admin', 
      fullName: 'Admin User',
      role: 'SUPER_ADMIN', 
      permissions: ['finance:create-payment', 'settings:manage'],
      isSuperAdmin: true
    },
    async () => true
  );

  beforeEach(async () => {
    await localDb.init();
    await localDb.clear();
    
    // Minimal mock for repoContext
    const mockRepo: any = {
      customerRepo: { findById: (id: string) => localDb.get('customers', id) },
      commandRepo: {
        get: async (id: string) => localDb.getOutbox(id),
        save: async (cmd: any) => localDb.saveOutbox(cmd),
        record: async (id: string, type: string, payload: any) => localDb.saveOutbox({ commandId: id, commandType: type, payload, status: 'pending', createdAt: new Date().toISOString(), retryCount: 0 } as any),
      },
      ledgerRepo: { 
        findByCustomer: async (id: string) => localDb.list('financialLedger'),
        append: async (l: any) => {
          const id = l.id || `ledg_${Math.random().toString(36).substring(2, 9)}`;
          return localDb.set('financialLedger', id, { ...l, id });
        }
      },
      paymentRepo: {
        save: (p: any) => localDb.set('payments', p.id, p),
        saveAllocation: (a: any) => localDb.set('paymentAllocations', a.id, a),
        findAllAllocations: () => localDb.list('paymentAllocations')
      },
      overlayRepo: {
        getNextSequence: () => localDb.getNextSequence(),
        save: (overlay: any) => localDb.saveOverlay(overlay),
      },
      transactionManager: { runInTransaction: (work: any) => work(mockRepo) }
    };
    useCases = new FinalUseCases(mockRepo);
  });

  test('Payment Idempotency Test', async () => {
    const custId = 'cust-1';
    await localDb.set('customers', custId, { id: custId, name: 'C', isActive: true });
    
    const paymentId = 'pay-1';
    await useCases.recordPayment(adminAuth, paymentId, custId, 100, 'CASH', undefined, 1);
    await useCases.recordPayment(adminAuth, paymentId, custId, 100, 'CASH', undefined, 1);
    
    // CREATE_PAYMENT is optimistic-overlay backed: it must not write the
    // canonical payment/ledger tables before the outbox command is accepted.
    const outbox = await localDb.listOutbox();
    expect(outbox.filter((command) => command.commandId === paymentId)).toHaveLength(1);
    expect(outbox.find((command) => command.commandId === paymentId)?.commandType).toBe('CREATE_PAYMENT');

    const overlays = await localDb.listOverlays();
    expect(overlays.filter((overlay) => overlay.commandId === paymentId)).toHaveLength(1);
    expect(overlays.filter((overlay) => overlay.commandId === `${paymentId}:ledger`)).toHaveLength(1);
    expect(overlays.filter((overlay) => overlay.entityType === 'ledger' && overlay.entityId === paymentId)).toHaveLength(1);
    expect(await localDb.list('payments')).toHaveLength(0);
    expect(await localDb.list('financialLedger')).toHaveLength(0);
  });
});
