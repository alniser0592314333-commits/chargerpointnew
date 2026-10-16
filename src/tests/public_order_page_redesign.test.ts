import { describe, it, expect } from 'vitest';
import { computeBackgroundStateFromOrder } from '../components/pages/PublicOrderPage';
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
