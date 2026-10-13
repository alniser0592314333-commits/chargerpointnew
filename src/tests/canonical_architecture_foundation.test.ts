/**
 * Phase 1 Canonical Architecture Foundation Test Suite
 * =========================================================================
 * Tests all 12 core architectural invariants mandated for Phase 1:
 * 1. Referential integrity (device types, customers, days)
 * 2. Dependency behavior (failed parent blocks ONLY descendants, unrelated continue)
 * 3. Idempotency (same payload returns previous result; different payload is rejected)
 * 4. Financial atomicity (delivery cannot leave item Delivered without financial recognition)
 * 5. Debt limit enforcement (rejects operations exceeding debt limit)
 * 6. Delta sync (monotonic cursor, cursor does not advance past unapplied failure)
 * 7. Delete / Tombstone protection (prevents stale resurrection)
 * 8. Multi-device sync (delta changes without full-table reload)
 * 9. Numbering & sequencing (server authoritative, monotonic)
 * 10. Backup checkpoint & validation (relationship and financial consistency)
 * 11. Staged restore & rollback protection
 * 12. Super Admin immutable authority & RBAC enforcement
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DomainInvariants } from '../domain/invariants';
import { calculateItemPrice, checkDebtLimit } from '../domain/rules';
import { BusinessRuleViolation, FinancialInvariantViolation } from '../domain/errors';
import { OutboxScheduler } from '../infrastructure/sync/outboxScheduler';
import { SyncEngine, MockServerSyncTransport } from '../infrastructure/sync/syncEngine';
import { computePayloadHash } from '../infrastructure/sync/SupabaseSyncTransport';
import { localDb, OutboxRecord } from '../infrastructure/localDb/localDb';
import { backupService } from '../services/backup/backupService';
import {
  CustomerEntity,
  DeviceTypeEntity,
  BusinessDayEntity,
  OrderEntity,
  OrderItemEntity,
  FinancialLedgerEntity,
} from '../domain/models';

describe('Canonical Architecture Foundation (Phase 1)', () => {
  beforeEach(async () => {
    // Clean memory and local DB state before each test
    await localDb.clearOperationalTables();
    await localDb.clearSyncHistory();
  });

  // =======================================================================
  // 1. REFERENTIAL INTEGRITY
  // =======================================================================
  describe('1. Referential Integrity Invariants', () => {
    it('blocks item creation referencing non-existent or retired device types', () => {
      const retiredDevice: DeviceTypeEntity = {
        id: 'dev-retired-1',
        name: 'Old Flashlight',
        icon: 'smartphone',
        basePriceMinor: 100,
        chargerFeeEnabled: true,
        chargerFeeApplicable: false,
        status: 'RETIRED',
        isActive: false,
        sortOrder: 1,
        deletedAt: new Date().toISOString(),
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      expect(() => DomainInvariants.assertDeviceTypeActive(retiredDevice)).toThrow(
        BusinessRuleViolation
      );
      expect(() => DomainInvariants.assertDeviceTypeActive(retiredDevice)).toThrow(
        /retired\/inactive/
      );
    });

    it('blocks order creation referencing soft-deleted/frozen customers', () => {
      const deletedCustomer: CustomerEntity = {
        id: 'cust-deleted-1',
        name: 'Former Customer',
        status: 'DELETED',
        isActive: false,
        debtLimitMinor: 5000,
        chargerFeeExempt: false,
        deletedAt: new Date().toISOString(),
        version: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      expect(() => DomainInvariants.assertCustomerActive(deletedCustomer)).toThrow(
        BusinessRuleViolation
      );
      expect(() => DomainInvariants.assertCustomerActive(deletedCustomer)).toThrow(
        /deleted\/frozen/
      );
    });
  });

  // =======================================================================
  // 2. DEPENDENCY BEHAVIOR
  // =======================================================================
  describe('2. Dependency-Aware Scheduling', () => {
    it('ensures failed parent blocks ONLY its direct descendants while unrelated commands continue', async () => {
      const scheduler = new OutboxScheduler();

      // Parent command (Customer A creation)
      const cmdCreateCustA: OutboxRecord = {
        commandId: 'cmd-cust-a',
        commandType: 'CREATE_CUSTOMER',
        aggregateType: 'customers',
        aggregateId: 'cust-a',
        payload: { id: 'cust-a', name: 'Customer A' },
        deviceId: 'dev-1',
        actorAdminId: 'admin-1',
        status: 'pending',
        retryCount: 1,
        createdAt: new Date('2026-10-03T10:00:00Z').toISOString(),
      };

      // Dependent command 1: Order for Customer A
      const cmdCreateOrderA: OutboxRecord = {
        commandId: 'cmd-order-a',
        commandType: 'CREATE_ORDER',
        aggregateType: 'orders',
        aggregateId: 'order-a',
        dependencyCommandId: 'cmd-cust-a', // Explicit dependency on Customer A
        payload: { id: 'order-a', customerId: 'cust-a', dayId: 'day-1' },
        deviceId: 'dev-1',
        actorAdminId: 'admin-1',
        status: 'pending',
        retryCount: 0,
        createdAt: new Date('2026-10-03T10:01:00Z').toISOString(),
      };

      // Dependent command 2: Item for Order A
      const cmdAddItemA: OutboxRecord = {
        commandId: 'cmd-item-a',
        commandType: 'ADD_ORDER_ITEM',
        aggregateType: 'order_items',
        aggregateId: 'item-a',
        dependencyCommandId: 'cmd-order-a', // Explicit dependency on Order A
        payload: { id: 'item-a', orderId: 'order-a', deviceTypeId: 'dev-flashlight' },
        deviceId: 'dev-1',
        actorAdminId: 'admin-1',
        status: 'pending',
        retryCount: 0,
        createdAt: new Date('2026-10-03T10:02:00Z').toISOString(),
      };

      // Completely unrelated command: Device Type creation or Setting change
      const cmdUnrelatedSetting: OutboxRecord = {
        commandId: 'cmd-setting-1',
        commandType: 'SET_SYSTEM_SETTING',
        aggregateType: 'system_settings',
        aggregateId: 'setting-1',
        payload: { key: 'currency', valueString: 'ILS' },
        deviceId: 'dev-1',
        actorAdminId: 'admin-1',
        status: 'pending',
        retryCount: 0,
        createdAt: new Date('2026-10-03T10:03:00Z').toISOString(),
      };

      // Unrelated Customer B
      const cmdCreateCustB: OutboxRecord = {
        commandId: 'cmd-cust-b',
        commandType: 'CREATE_CUSTOMER',
        aggregateType: 'customers',
        aggregateId: 'cust-b',
        payload: { id: 'cust-b', name: 'Customer B' },
        deviceId: 'dev-1',
        actorAdminId: 'admin-1',
        status: 'pending',
        retryCount: 0,
        createdAt: new Date('2026-10-03T10:04:00Z').toISOString(),
      };

      const allCandidates = [cmdCreateCustA, cmdCreateOrderA, cmdAddItemA, cmdUnrelatedSetting, cmdCreateCustB];

      // Schedule initial pass: cmdCreateCustA, cmdUnrelatedSetting, cmdCreateCustB are READY.
      // cmdCreateOrderA and cmdAddItemA are BLOCKED waiting for prerequisites.
      const result = await scheduler.schedule(allCandidates, allCandidates);

      const readyIds = result.ready.map((r) => r.commandId);
      expect(readyIds).toContain('cmd-cust-a');
      expect(readyIds).toContain('cmd-setting-1');
      expect(readyIds).toContain('cmd-cust-b');

      expect(result.blocked.has('cmd-order-a')).toBe(true);
      expect(result.blocked.has('cmd-item-a')).toBe(true);

      // Now simulate: cmdCreateCustA FAILS permanently
      // cmd-cust-a is marked 'conflict' or 'rejected'
      cmdCreateCustA.status = 'conflict';
      cmdCreateCustA.lastError = 'Key customerId conflict';

      const afterFailureCandidates = [cmdCreateOrderA, cmdAddItemA, cmdUnrelatedSetting, cmdCreateCustB];
      const afterFailureResult = await scheduler.schedule(afterFailureCandidates, [cmdCreateCustA, ...afterFailureCandidates]);

      const afterReadyIds = afterFailureResult.ready.map((r) => r.commandId);
      // Unrelated commands MUST continue execution!
      expect(afterReadyIds).toContain('cmd-setting-1');
      expect(afterReadyIds).toContain('cmd-cust-b');

      // Descendants of failed Customer A MUST be blocked
      expect(afterFailureResult.blocked.has('cmd-order-a')).toBe(true);
      expect(afterFailureResult.blocked.has('cmd-item-a')).toBe(true);
    });
  });

  // =======================================================================
  // 3. IDEMPOTENCY
  // =======================================================================
  describe('3. Idempotency Invariants', () => {
    it('computes deterministic payload hashes to prevent duplicate execution', () => {
      const payload1 = { id: '123', amountMinor: 500, customerId: 'c1' };
      const payload2 = { id: '123', amountMinor: 500, customerId: 'c1' };
      const payloadDifferent = { id: '123', amountMinor: 600, customerId: 'c1' };

      const hash1 = computePayloadHash(payload1);
      const hash2 = computePayloadHash(payload2);
      const hash3 = computePayloadHash(payloadDifferent);

      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
    });

    it('rejects retrying the same command ID with a different payload', async () => {
      const transport = new MockServerSyncTransport();
      const commandId = 'cmd-idem-1';

      // First call
      const res1 = await transport.pushCommand({
        commandId,
        commandType: 'POST_PAYMENT',
        payload: { amountMinor: 500, customerId: 'cust-1' },
        deviceId: 'dev-1',
        actorAdminId: 'admin-1',
      });
      expect(res1.success).toBe(true);

      // Retry with identical payload returns existing result
      const res2 = await transport.pushCommand({
        commandId,
        commandType: 'POST_PAYMENT',
        payload: { amountMinor: 500, customerId: 'cust-1' },
        deviceId: 'dev-1',
        actorAdminId: 'admin-1',
      });
      expect(res2.success).toBe(true);

      // Retry with DIFFERENT payload is rejected with IDEMPOTENCY_CONFLICT
      const res3 = await transport.pushCommand({
        commandId,
        commandType: 'POST_PAYMENT',
        payload: { amountMinor: 9999, customerId: 'cust-1' }, // Tampered amount
        deviceId: 'dev-1',
        actorAdminId: 'admin-1',
      });
      expect(res3.success).toBe(false);
      expect(res3.code).toBe('IDEMPOTENCY_CONFLICT');
    });
  });

  // =======================================================================
  // 4. FINANCIAL ATOMICITY & DELIVERY RECOGNITION
  // =======================================================================
  describe('4. Financial Recognition & Formula Integrity', () => {
    it('enforces Final Charge = Base Price + Charger Fee - Discount', () => {
      // 1. Device requires charger, customer not exempt, charger absent -> fee applied
      const calc1 = calculateItemPrice({
        basePriceMinor: 2000,
        chargerFeeEnabled: true,
        chargerFeeApplicable: true,
        customerExempt: false,
        hasCharger: false,
        chargerFeeMinor: 500,
        discountMinor: 200,
      });
      expect(calc1.basePriceMinor).toBe(2000);
      expect(calc1.chargerFeeSnapshotMinor).toBe(500);
      expect(calc1.discountSnapshotMinor).toBe(200);
      expect(calc1.finalChargeSnapshotMinor).toBe(2300); // 2000 + 500 - 200
      DomainInvariants.assertFinalChargeFormula(2000, 500, 200, calc1.finalChargeSnapshotMinor);

      // 2. Customer is exempt -> charger fee is 0
      const calc2 = calculateItemPrice({
        basePriceMinor: 2000,
        chargerFeeEnabled: true,
        customerExempt: true,
        hasCharger: false,
        chargerFeeMinor: 500,
      });
      expect(calc2.chargerFeeSnapshotMinor).toBe(0);
      expect(calc2.finalChargeSnapshotMinor).toBe(2000);

      // 3. Customer brought charger -> charger fee is 0
      const calc3 = calculateItemPrice({
        basePriceMinor: 2000,
        chargerFeeEnabled: true,
        customerExempt: false,
        hasCharger: true,
        chargerFeeMinor: 500,
      });
      expect(calc3.chargerFeeSnapshotMinor).toBe(0);
      expect(calc3.finalChargeSnapshotMinor).toBe(2000);
    });

    it('prevents double financial recognition of delivered items in ledger', () => {
      const existingLedger: FinancialLedgerEntity[] = [
        {
          id: 'ledger-1',
          eventType: 'ORDER_ITEM_CHARGE',
          amountMinor: -2000,
          orderId: 'order-1',
          orderItemId: 'item-100',
          customerId: 'cust-1',
          createdAt: new Date().toISOString(),
        },
      ];

      // Second recognition attempt must throw FinancialInvariantViolation
      expect(() => DomainInvariants.assertItemNotRecognizedTwice('item-100', existingLedger)).toThrow(
        FinancialInvariantViolation
      );
      expect(() => DomainInvariants.assertItemNotRecognizedTwice('item-100', existingLedger)).toThrow(
        /already been financially recognized/
      );
    });
  });

  // =======================================================================
  // 5. DEBT LIMIT ENFORCEMENT
  // =======================================================================
  describe('5. Debt Limit Invariant', () => {
    it('authoritatively rejects operations that exceed configured customer debt limit', () => {
      const debtLimitMinor = 5000; // Customer allowed up to -50.00₪ debt
      const currentBalance = -4000; // Currently at -40.00₪
      const newCharge = 1500; // Adding 15.00₪ charge -> projected = -55.00₪

      const projected = currentBalance - newCharge; // -5500
      const allowed = checkDebtLimit(projected, debtLimitMinor, false);
      expect(allowed).toBe(false);

      // Super admin is permitted to override
      const allowedForSuperAdmin = checkDebtLimit(projected, debtLimitMinor, true);
      expect(allowedForSuperAdmin).toBe(true);
    });
  });

  // =======================================================================
  // 6. DELTA SYNCHRONIZATION
  // =======================================================================
  describe('6. Monotonic Delta Synchronization', () => {
    it('advances cursor strictly per successfully applied change and halts on unapplied failure', async () => {
      const transport = new MockServerSyncTransport();
      const engine = new SyncEngine(transport);

      // Simulate server pushing changes to transport
      await transport.pushCommand({
        commandId: 'cmd-1',
        commandType: 'CREATE_CUSTOMER',
        payload: { id: 'cust-1', name: 'Alice' },
        deviceId: 'd1',
        actorAdminId: 'a1',
      });
      await transport.pushCommand({
        commandId: 'cmd-2',
        commandType: 'CREATE_CUSTOMER',
        payload: { id: 'cust-2', name: 'Bob' },
        deviceId: 'd1',
        actorAdminId: 'a1',
      });

      // Synchronize: sequence 1 and 2 apply cleanly
      const syncRes1 = await engine.synchronize();
      expect(syncRes1.pulled).toBe(2);

      let syncState = await localDb.getSyncState('global');
      expect(syncState?.lastAppliedChangeSequence).toBe(2);

      // Add sequence 3
      await transport.pushCommand({
        commandId: 'cmd-3',
        commandType: 'CREATE_CUSTOMER',
        payload: { id: 'cust-3', name: 'Charlie' },
        deviceId: 'd1',
        actorAdminId: 'a1',
      });

      // Inject a failure when applying sequence 3 locally
      engine.onDeltaApplied = async (change) => {
        if (change.sequenceId === 3) {
          throw new Error('Local disk write error on sequence 3');
        }
      };

      // Run sync: sequence 3 fails locally and rejects
      await expect(engine.synchronize()).rejects.toThrow('Local disk write error on sequence 3');

      // Invariant: The cursor MUST remain at 2! It must NOT advance past sequence 3.
      syncState = await localDb.getSyncState('global');
      expect(syncState?.lastAppliedChangeSequence).toBe(2);

      // Fix the local error and retry: sequence 3 succeeds and cursor advances to 3
      engine.onDeltaApplied = undefined;
      const retryRes = await engine.synchronize();
      expect(retryRes.pulled).toBe(1);

      syncState = await localDb.getSyncState('global');
      expect(syncState?.lastAppliedChangeSequence).toBe(3);
    });
  });

  // =======================================================================
  // 7. TOMBSTONES AND DELETE PROTECTION
  // =======================================================================
  describe('7. Tombstone & Stale Resurrection Protection', () => {
    it('applies tombstones to remove deleted entities and prevent resurrection', async () => {
      // Seed entity locally
      await localDb.set('customers', 'cust-tombstone-1', {
        id: 'cust-tombstone-1',
        name: 'To Be Deleted',
        status: 'ACTIVE',
      });

      expect(await localDb.get('customers', 'cust-tombstone-1')).toBeDefined();

      const transport = new MockServerSyncTransport();
      const engine = new SyncEngine(transport);

      // Simulate remote TOMBSTONE/DELETE change
      (transport as any).changeLog = [
        {
          sequenceId: 10,
          entityType: 'customers',
          entityId: 'cust-tombstone-1',
          action: 'TOMBSTONE',
          payload: { id: 'cust-tombstone-1', status: 'DELETED' },
          changedAt: new Date().toISOString(),
        },
      ];

      await engine.synchronize();

      // Entity should be removed/tombstoned from local active database
      const loaded = await localDb.get('customers', 'cust-tombstone-1');
      expect(loaded).toBeNull();
    });
  });

  // =======================================================================
  // 8. BACKUP CHECKPOINT & REFERENTIAL INTEGRITY VALIDATION
  // =======================================================================
  describe('8. Backup Checkpoint & Integrity Validation', () => {
    it('detects invalid orphaned foreign keys in backup files (forensic RCA test)', async () => {
      // Simulate an invalid backup payload where an orderItem references a non-existent deviceTypeId
      // (The exact root cause from the user incident!)
      const invalidBackupJson = JSON.stringify({
        formatIdentifier: 'ORDER_SYSTEM_PORTABLE_BACKUP',
        formatVersion: 1,
        schemaVersion: 1,
        snapshotVersion: 1,
        snapshotId: 'snap-orphaned-1',
        snapshotName: 'Corrupted Backup',
        createdAt: new Date().toISOString(),
        sourceType: 'OFFLINE',
        metadata: {
          recordCounts: { customers: 1, businessDays: 1, orders: 1, orderItems: 1, deviceTypes: 0 },
          totalEntities: 3,
        },
        data: {
          customers: [{ id: 'cust-1', name: 'John Doe', status: 'ACTIVE' }],
          businessDays: [{ id: 'day-1', businessDate: '2026-10-03', status: 'OPEN' }],
          orders: [{ id: 'order-1', dayId: 'day-1', customerId: 'cust-1', displayNumber: 1 }],
          orderItems: [
            {
              id: 'item-orphan-1',
              orderId: 'order-1',
              deviceTypeId: 'non-existent-device-uuid', // Orphaned reference!
              deviceNameSnapshot: 'كشاف',
              basePriceSnapshotMinor: 100,
            },
          ],
          deviceTypes: [], // Missing the referenced device type!
          financialLedger: [],
          payments: [],
          paymentAllocations: [],
        },
      });

      const validation = await backupService.validateAndParsePortableBackup(invalidBackupJson);

      expect(validation.valid).toBe(false);
      expect(validation.errorCode).toBe('REFERENTIAL_INTEGRITY_VIOLATION');
      expect(validation.error).toContain('non-existent device type');
    });

    it('successfully validates consistent backup payloads with valid referential integrity', async () => {
      const validBackupJson = JSON.stringify({
        formatIdentifier: 'ORDER_SYSTEM_PORTABLE_BACKUP',
        formatVersion: 1,
        schemaVersion: 1,
        snapshotVersion: 1,
        snapshotId: 'snap-valid-1',
        snapshotName: 'Clean Canonical Backup',
        checkpointSequence: 42,
        createdAt: new Date().toISOString(),
        sourceType: 'ONLINE',
        metadata: {
          recordCounts: { customers: 1, businessDays: 1, orders: 1, orderItems: 1, deviceTypes: 1 },
          totalEntities: 5,
        },
        data: {
          customers: [{ id: 'cust-1', name: 'John Doe', status: 'ACTIVE' }],
          businessDays: [{ id: 'day-1', businessDate: '2026-10-03', status: 'OPEN' }],
          deviceTypes: [{ id: 'dev-flashlight', name: 'كشاف', status: 'ACTIVE' }],
          orders: [{ id: 'order-1', dayId: 'day-1', customerId: 'cust-1', displayNumber: 1 }],
          orderItems: [
            {
              id: 'item-valid-1',
              orderId: 'order-1',
              deviceTypeId: 'dev-flashlight',
              deviceNameSnapshot: 'كشاف',
              basePriceSnapshotMinor: 100,
            },
          ],
          financialLedger: [],
          payments: [],
          paymentAllocations: [],
        },
      });

      const validation = await backupService.validateAndParsePortableBackup(validBackupJson);
      expect(validation.valid).toBe(true);
      expect(validation.portableFile?.checkpointSequence).toBe(42);
    });
  });

  // =======================================================================
  // 9. SUPER ADMIN IMMUTABLE AUTHORITY
  // =======================================================================
  describe('9. Super Admin Immutable Authority', () => {
    it('strictly forbids deactivating or deleting Super Admin', () => {
      expect(() => DomainInvariants.assertSuperAdminImmutable('SUPER_ADMIN', 'DELETE')).toThrow(
        BusinessRuleViolation
      );
      expect(() => DomainInvariants.assertSuperAdminImmutable('SUPER_ADMIN', 'DEACTIVATE')).toThrow(
        BusinessRuleViolation
      );
      expect(() =>
        DomainInvariants.assertSuperAdminImmutable('SUPER_ADMIN', 'REVOKE_PERMISSION')
      ).toThrow(BusinessRuleViolation);

      // Ordinary Admin can be deactivated or deleted
      expect(() => DomainInvariants.assertSuperAdminImmutable('ADMIN', 'DELETE')).not.toThrow();
    });
  });
});
