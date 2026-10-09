/**
 * Canonical Domain Invariants Enforcement (Phase 1 Baseline)
 * Enforces strict financial, relational, and business invariants across the system.
 */

import { FinancialInvariantViolation, BusinessRuleViolation } from './errors';
import { FinancialLedgerEntity, OrderItemEntity, CustomerEntity, DeviceTypeEntity, GoalEntity } from './models';

export class DomainInvariants {
  /**
   * Final charge invariant:
   * Final Charge = Base Price + Charger Fee - Discount
   */
  static assertFinalChargeFormula(
    basePriceMinor: number,
    chargerFeeMinor: number,
    discountMinor: number,
    finalChargeMinor: number
  ): void {
    const expected = Math.max(0, basePriceMinor + chargerFeeMinor - discountMinor);
    if (finalChargeMinor !== expected) {
      throw new FinancialInvariantViolation(
        `Final charge invariant violated: expected ${expected} (${basePriceMinor} + ${chargerFeeMinor} - ${discountMinor}), got ${finalChargeMinor}`
      );
    }
  }

  /**
   * Customer must not be soft-deleted/frozen for new business operations.
   */
  static assertCustomerActive(customer: CustomerEntity): void {
    if (customer.status === 'DELETED' || !customer.isActive || customer.deletedAt) {
      throw new BusinessRuleViolation(
        `Customer ${customer.id} is deleted/frozen and cannot participate in new business activity.`
      );
    }
  }

  /**
   * Device type must be active and not retired for new items.
   */
  static assertDeviceTypeActive(deviceType: DeviceTypeEntity): void {
    if (deviceType.status === 'RETIRED' || !deviceType.isActive || deviceType.deletedAt) {
      throw new BusinessRuleViolation(
        `Device type ${deviceType.id} is retired/inactive and cannot be assigned to new items.`
      );
    }
  }

  /**
   * Financial Recognition Invariant:
   * Delivery must recognize the charge exactly once. An item cannot be recognized twice.
   */
  static assertItemNotRecognizedTwice(itemId: string, ledger: FinancialLedgerEntity[]): void {
    const existingCharges = ledger.filter(
      (l) => l.orderItemId === itemId && (l.eventType === 'CHARGE' || l.eventType === 'ORDER_ITEM_CHARGE')
    );
    if (existingCharges.length > 0) {
      throw new FinancialInvariantViolation(
        `Order item ${itemId} has already been financially recognized in ledger.`
      );
    }
  }

  /**
   * Cannot deliver or recognize a cancelled item.
   */
  static assertItemNotCancelled(itemStatus?: string): void {
    if (!itemStatus) {
      throw new FinancialInvariantViolation('INVALID_ORDER_ITEM_STATUS: Order item status is undefined or missing.');
    }
    const lower = itemStatus.toLowerCase();
    if (lower === 'cancelled') {
      throw new FinancialInvariantViolation('Cancelled item cannot be financially recognized.');
    }
  }

  /**
   * Cannot recognize items for a cancelled order.
   */
  static assertOrderNotCancelledForRecognition(orderStatus?: string): void {
    if (!orderStatus) {
      throw new FinancialInvariantViolation('INVALID_ORDER_STATUS: Order status is undefined or missing.');
    }
    const lower = orderStatus.toLowerCase();
    if (lower === 'cancelled') {
      throw new FinancialInvariantViolation('Cancelled order cannot perform normal financial recognition.');
    }
  }

  /**
   * Payment allocation cannot exceed payment or outstanding due.
   */
  static assertValidAllocation(allocated: number, paymentTotal: number, outstanding: number): void {
    if (allocated > paymentTotal) {
      throw new FinancialInvariantViolation('Payment allocation cannot exceed payment amount.');
    }
    if (allocated > outstanding) {
      throw new FinancialInvariantViolation('Payment allocation cannot exceed outstanding recognized amount.');
    }
  }

  /**
   * Currency must use non-negative integer minor units.
   */
  static assertIntegerMinor(amount: number): void {
    if (!Number.isInteger(amount)) {
      throw new FinancialInvariantViolation('Monetary amounts must be integer minor units.');
    }
  }

  static assertValidPaymentAmount(amount: number): void {
    if (amount <= 0 || !Number.isInteger(amount)) {
      throw new FinancialInvariantViolation('Payment amount must be a positive integer minor units value.');
    }
  }

  /**
   * Historical snapshots must be immutable once created.
   */
  static assertSnapshotsStable(original: OrderItemEntity, current: OrderItemEntity): void {
    if (
      original.deviceNameSnapshot !== current.deviceNameSnapshot ||
      original.basePriceSnapshotMinor !== current.basePriceSnapshotMinor ||
      original.chargerFeeSnapshotMinor !== current.chargerFeeSnapshotMinor
    ) {
      throw new FinancialInvariantViolation('Historical order item snapshots must remain stable and immutable.');
    }
  }

  /**
   * Super Admin is an immutable system authority:
   * Cannot be deactivated, deleted, or stripped of system authority.
   */
  static assertSuperAdminImmutable(
    targetRole: string,
    operation: 'DELETE' | 'DEACTIVATE' | 'REVOKE_PERMISSION'
  ): void {
    if (targetRole === 'SUPER_ADMIN' || targetRole === 'Super Admin') {
      throw new BusinessRuleViolation(
        `Forbidden: Super Admin is an immutable system authority and cannot undergo ${operation}.`
      );
    }
  }

  /**
   * Goal Invariants:
   * A customer may have at most ONE active goal at a time.
   */
  static assertSingleActiveGoal(existingActiveGoal: GoalEntity | null, customerId: string): void {
    if (existingActiveGoal && existingActiveGoal.status === 'ACTIVE') {
      throw new BusinessRuleViolation(
        `Customer ${customerId} already has an active goal (ID: ${existingActiveGoal.id}). Only one active goal is allowed per customer.`
      );
    }
  }

  /**
   * Only ACTIVE goals can be edited. COMPLETED and FAILED goals are immutable.
   */
  static assertGoalEditable(goal: GoalEntity): void {
    if (goal.status !== 'ACTIVE') {
      throw new BusinessRuleViolation(
        `Goal ${goal.id} is in status ${goal.status} and cannot be modified. Completed/closed goals are immutable.`
      );
    }
  }

  /**
   * Progress cannot be directly overwritten by admin/customer.
   */
  static assertGoalProgressDerived(attemptedDirectEdit: boolean): void {
    if (attemptedDirectEdit) {
      throw new BusinessRuleViolation('Goal progress is authoritatively derived from qualifying business activity and cannot be arbitrarily edited.');
    }
  }

  /**
   * Goal target, duration, and bonus validations.
   */
  static assertGoalParamsValid(targetQuantity: number, durationDays: number, bonusAmountMinor: number): void {
    if (!Number.isInteger(targetQuantity) || targetQuantity <= 0) {
      throw new BusinessRuleViolation('Goal target quantity must be a positive integer.');
    }
    if (!Number.isInteger(durationDays) || durationDays < 3 || durationDays > 15) {
      throw new BusinessRuleViolation('Goal duration must be an integer from 3 through 15 days.');
    }
    if (!Number.isInteger(bonusAmountMinor) || bonusAmountMinor < 0) {
      throw new FinancialInvariantViolation('Goal bonus amount must be a non-negative integer minor units value.');
    }
    const maxBonusMinor = targetQuantity * 20; // ₪2 per 10 target devices.
    if (bonusAmountMinor > maxBonusMinor) {
      throw new FinancialInvariantViolation(
        `Goal bonus exceeds the hard cap of 20 minor units per target device (maximum ${maxBonusMinor}).`
      );
    }
  }
}
