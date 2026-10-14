import { describe, expect, it } from 'vitest';
import { resolveLogicalBackPath } from '../navigation/backNavigation';

describe('logical edge-swipe back navigation', () => {
  it('returns from editing an order to its day, regardless of prior edit history', () => {
    expect(resolveLogicalBackPath('/app/days/day-1/orders/order-25/edit')).toBe('/app/days/day-1');
    expect(resolveLogicalBackPath('/app/days/day-1/orders/order-4/edit#details')).toBe('/app/days/day-1');
  });

  it('follows the days hierarchy back to the home page', () => {
    expect(resolveLogicalBackPath('/app/days/day-1')).toBe('/app/days');
    expect(resolveLogicalBackPath('/app/days')).toBe('/app');
    expect(resolveLogicalBackPath('/app')).toBeNull();
  });

  it('handles add-order and QR pages without traversing old record visits', () => {
    expect(resolveLogicalBackPath('/app/days/day-1/add-order')).toBe('/app/days/day-1');
    expect(resolveLogicalBackPath('/app/days/day-1/orders/order-25/qr')).toBe('/app/days/day-1');
    expect(resolveLogicalBackPath('/app/qr/customer/customer-9')).toBe('/app/customers/customer-9');
  });

  it('returns detail pages to their collection and settings subpages to settings', () => {
    expect(resolveLogicalBackPath('/app/customers/customer-9')).toBe('/app/customers');
    expect(resolveLogicalBackPath('/app/customers')).toBe('/app');
    expect(resolveLogicalBackPath('/app/financials/customers/customer-9')).toBe('/app/financials/customers');
    expect(resolveLogicalBackPath('/app/financials/customers')).toBe('/app/financials');
    expect(resolveLogicalBackPath('/app/settings/device-types')).toBe('/app/settings');
    expect(resolveLogicalBackPath('/app/settings')).toBe('/app');
  });
});
