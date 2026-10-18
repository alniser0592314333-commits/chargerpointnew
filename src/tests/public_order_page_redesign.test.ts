import { describe, it, expect } from 'vitest';
import { computeBackgroundStateFromOrder, getOrderPaymentViewState } from '../components/pages/PublicOrderPage';
import { PublicOrderQrData } from '../components/pages/dayOrdersStore';

describe('Public Order Page Energy Redesign & State Machine', () => {
  it('1. Computes "charging" state for orders in progress or charging', () => {
    const mockOrder: PublicOrderQrData = {
      orderId: 'test-1',
      orderNumber: 101,
      customerName: 'Ahmad User',
      status: 'CHARGING',
      createdAt: '2026-10-10T12:00:00Z',
      itemsCount: 1,
      orderTotalMinor: 5000,
      orderDueMinor: 5000,
      token: 'tok-123',
    };

    expect(computeBackgroundStateFromOrder(mockOrder)).toBe('charging');

    const inProgressOrder: PublicOrderQrData = {
      ...mockOrder,
      status: 'IN_PROGRESS',
    };
    expect(computeBackgroundStateFromOrder(inProgressOrder)).toBe('charging');
  });

  it('2. Computes "charged" state for orders that are ready for pickup', () => {
    const readyOrder: PublicOrderQrData = {
      orderId: 'test-2',
      orderNumber: 102,
      customerName: 'Sarah Customer',
      status: 'READY_FOR_PICKUP',
      createdAt: '2026-10-10T12:00:00Z',
      itemsCount: 2,
      orderTotalMinor: 8000,
      orderDueMinor: 8000,
      token: 'tok-456',
    };

    expect(computeBackgroundStateFromOrder(readyOrder)).toBe('charged');
  });

  it('3. Computes "delivered-paid" state when order is delivered and fully paid (due === 0)', () => {
    const paidOrder: PublicOrderQrData = {
      orderId: 'test-3',
      orderNumber: 103,
      customerName: 'Omar Client',
      status: 'DELIVERED',
      createdAt: '2026-10-10T12:00:00Z',
      itemsCount: 1,
      orderTotalMinor: 4000,
      orderDueMinor: 0,
      orderPaidMinor: 4000,
      token: 'tok-789',
    };

    expect(computeBackgroundStateFromOrder(paidOrder)).toBe('delivered-paid');
  });

  it('4. Computes "delivered-unpaid" state when order is delivered but has remaining balance due (due > 0)', () => {
    const unpaidDeliveredOrder: PublicOrderQrData = {
      orderId: 'test-4',
      orderNumber: 104,
      customerName: 'Khaled Buyer',
      status: 'DELIVERED',
      createdAt: '2026-10-10T12:00:00Z',
      itemsCount: 2,
      orderTotalMinor: 10000,
      orderDueMinor: 10000,
      token: 'tok-999',
    };

    expect(computeBackgroundStateFromOrder(unpaidDeliveredOrder)).toBe('delivered-unpaid');
  });
});


describe('Public order QR payment status presentation', () => {
  it('shows Pay Now only when there is a confirmed outstanding balance and no QR submission', () => {
    expect(getOrderPaymentViewState(2500, null, false, 'DELIVERED', 0, 2500)).toBe('UNPAID');
  });

  it('replaces Pay Now with a review state while this order QR submission is pending', () => {
    expect(getOrderPaymentViewState(2500, { status: 'PENDING' }, false, 'DELIVERED', 0, 2500)).toBe('PENDING');
  });

  it('shows partially paid when this order has allocated payments and a remainder', () => {
    expect(getOrderPaymentViewState(1200, { status: 'APPROVED' }, false, 'DELIVERED', 300, 1500)).toBe('PARTIALLY_PAID');
  });

  it('allows a new payment attempt after a rejected notification', () => {
    expect(getOrderPaymentViewState(2500, { status: 'REJECTED' }, false, 'DELIVERED', 0, 2500)).toBe('REJECTED');
  });

  it('treats the canonical zero balance as paid even if an older notification is pending', () => {
    expect(getOrderPaymentViewState(0, { status: 'PENDING' }, false, 'DELIVERED', 100, 100)).toBe('PAID');
  });

  it('does not claim that an order is paid when its balance is unavailable', () => {
    expect(getOrderPaymentViewState(undefined, null, false, 'DELIVERED', 0)).toBe('UNAVAILABLE');
  });

  it('shows Pay Now when positive customer credit does not cover the full order remainder', () => {
    expect(getOrderPaymentViewState(150, null, true, 'DELIVERED', 0, 150)).toBe('UNPAID');
  });

  it('keeps an approved receipt separate from this order's allocation when no amount is allocated here', () => {
    expect(getOrderPaymentViewState(150, { status: 'APPROVED' }, true, 'DELIVERED', 0, 150)).toBe('APPROVED');
  });

  it('does not call a charging order paid before its charge is recognized', () => {
    expect(getOrderPaymentViewState(0, null, false, 'CHARGING', 0, 5000)).toBe('NOT_DUE');
  });

  it('does not treat positive customer credit as a payment allocation', () => {
    expect(getOrderPaymentViewState(0, null, true, 'CHARGING', 0, 5000)).toBe('NOT_DUE');
  });

  it('does not claim full coverage from a positive-balance flag alone', () => {
    expect(getOrderPaymentViewState(0, null, true, 'CHARGING', 0)).toBe('NOT_DUE');
  });

  it('does not mark a delivered order fully paid when no payment is allocated to it', () => {
    expect(getOrderPaymentViewState(0, null, true, 'DELIVERED', 0, 5000)).toBe('UNAVAILABLE');
  });

  it('fails closed when customer balance is unavailable', () => {
    expect(getOrderPaymentViewState(150, null, undefined, 'DELIVERED', 0, 150)).toBe('UNAVAILABLE');
  });
  it('does not mark a delivered order paid from an approved notification alone', () => {
    expect(getOrderPaymentViewState(1200, { status: 'APPROVED' }, true, 'DELIVERED', 0, 1200)).toBe('APPROVED');
  });

  it('marks an order paid only when its own allocated amount leaves no due', () => {
    expect(getOrderPaymentViewState(0, { status: 'APPROVED' }, true, 'DELIVERED', 1200, 1200)).toBe('PAID');
  });

  it('shows partial payment when some amount is allocated to this order, regardless of customer balance', () => {
    expect(getOrderPaymentViewState(1200, { status: 'APPROVED' }, true, 'DELIVERED', 300)).toBe('PARTIALLY_PAID');
  });

  it('uses a partial-payment background when a delivered order has both paid and due amounts', () => {
    expect(computeBackgroundStateFromOrder({
      orderId: 'test-partial',
      orderNumber: 105,
      customerName: 'Test Customer',
      status: 'DELIVERED',
      createdAt: '2026-10-18T12:00:00Z',
      itemsCount: 1,
      orderTotalMinor: 5000,
      orderPaidMinor: 2000,
      orderDueMinor: 3000,
      token: 'tok-partial',
    })).toBe('delivered-unpaid');
  });

  it('does not mark a zero-due order paid when its own allocated amount is below the order total', () => {
    expect(getOrderPaymentViewState(0, null, false, 'DELIVERED', 2000, 5000)).toBe('UNAVAILABLE');
  });

});
