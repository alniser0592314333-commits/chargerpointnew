import { describe, it, expect, beforeEach } from 'vitest';
import { FinalUseCases, RepositoryContext } from '../application/useCases';
import { AuthorizationContext } from '../application/authContext';
import { ID } from '../types/common';
import { 
  OrderEntity, 
  OrderItemEntity, 
  CustomerEntity, 
  DeviceTypeEntity,
  FinancialLedgerEntity,
  BusinessDayEntity,
  PaymentEntity,
  PaymentAllocationEntity
} from '../domain/models';

describe('Pricing Sync Regression Fix', () => {
  let useCases: FinalUseCases;
  let mockRepos: RepositoryContext;
  let recordedCommands: any[] = [];

  beforeEach(() => {
    recordedCommands = [];
    mockRepos = {
      orderRepo: {
        findById: (id: ID) => (id === 'order-1' ? { id, dayId: 'day-1', customerId: 'cust-1', status: 'pending' } as OrderEntity : null),
        save: () => {},
        countForDay: () => 0,
      },
      itemRepo: {
        findByOrderId: () => [],
        save: () => {},
        findById: () => null,
      },
      customerRepo: {
        findById: (id: ID) => (id === 'cust-1' ? { id, name: 'Test Cust', isActive: true, debtLimitMinor: 10000, chargerFeeExempt: false } as CustomerEntity : null),
        save: () => {},
        getBalance: () => 0,
      },
      deviceRepo: {
        findById: (id: ID) => (id === 'dev-1' ? { id, name: 'iPhone', icon: 'smartphone', basePriceMinor: 4500, chargerFeeEnabled: true, isActive: true } as DeviceTypeEntity : null),
        save: () => {},
        findAll: () => [],
      },
      ledgerRepo: {
        append: () => {},
        findByCustomer: () => [],
        findAll: () => [],
      },
      dayRepo: {
        findById: (id: ID) => (id === 'day-1' ? { id, businessDate: '2026-09-30', isClosed: false } as BusinessDayEntity : null),
        save: () => {},
        isClosed: () => false,
      },
      paymentRepo: {
        save: () => {},
        saveAllocation: () => {},
        findByCustomer: () => [],
        findAllAllocations: () => [],
      },
      commandRepo: {
        get: () => null,
        record: (id: ID, type: string, payload: any) => {
          recordedCommands.push({ id, type, payload });
        },
      },
      transactionManager: {
        runInTransaction: (work: (ctx: RepositoryContext) => any) => Promise.resolve(work(mockRepos)),
      },
    } as any;

    useCases = new FinalUseCases(mockRepos);
  });

  it('ADD_ORDER_ITEM command payload must contain authoritative pricing snapshot', async () => {
    const auth = new AuthorizationContext({
      id: 'admin-1',
      username: 'admin',
      fullName: 'Admin',
      role: 'SUPER_ADMIN',
      permissions: ['orders:edit'],
      isSuperAdmin: true,
    }, async () => true);

    const result = await useCases.addOrderItem(auth, 'order-1', 'dev-1', false);
    
    if (!result.success) throw new Error(result.error);
    const item = result.data;
    
    // Local calculation check
    expect(item.basePriceSnapshotMinor).toBe(4500);
    expect(item.chargerFeeSnapshotMinor).toBe(50);
    expect(item.unitPriceMinor).toBe(4550);
    expect(item.totalPriceMinor).toBe(4550);

    // Command payload check
    const cmd = recordedCommands.find(c => c.type === 'ADD_ORDER_ITEM');
    expect(cmd).toBeDefined();
    expect(cmd.payload.basePriceSnapshotMinor).toBe(4500);
    expect(cmd.payload.unitPriceMinor).toBe(4550);
    expect(cmd.payload.totalPriceMinor).toBe(4550);
    expect(cmd.payload.deviceNameSnapshot).toBe('iPhone');
    expect(cmd.payload.chargerFeeSnapshotMinor).toBe(50);
  });

  it('CREATE_ORDER command payload must contain customerBalanceSnapshotMinor', async () => {
    const auth = new AuthorizationContext({
      id: 'admin-1',
      username: 'admin',
      fullName: 'Admin',
      role: 'SUPER_ADMIN',
      permissions: ['orders:create'],
      isSuperAdmin: true,
    }, async () => true);

    // Mock customer balance to be -500
    (mockRepos.customerRepo.getBalance as any) = () => -500;

    const result = await useCases.createOrder(auth, 'cmd-1', 'day-1', 'cust-1', 'Notes');
    
    if (!result.success) throw new Error(result.error);
    const order = result.data;
    expect(order.customerBalanceSnapshotMinor).toBe(-500);

    const cmd = recordedCommands.find(c => c.type === 'CREATE_ORDER');
    expect(cmd).toBeDefined();
    expect(cmd.payload.customerBalanceSnapshotMinor).toBe(-500);
  });
});
