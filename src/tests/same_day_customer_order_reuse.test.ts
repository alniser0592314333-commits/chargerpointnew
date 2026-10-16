import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('same-customer same-business-day order reuse', () => {
  const storePath = path.resolve(process.cwd(), 'src/components/pages/dayOrdersStore.ts');
  const addPagePath = path.resolve(process.cwd(), 'src/components/pages/AddOrderPage.tsx');

  it('matches canonical customer IDs only within the selected business day', () => {
    const store = fs.readFileSync(storePath, 'utf8');
    const start = store.indexOf('export const findExistingCustomerOrderOnDay');
    const end = store.indexOf('export interface UICustomerListItem', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const lookup = store.slice(start, end);

    expect(lookup).toContain('getEffectiveOrderItemReadModel().orders');
    expect(lookup).toContain('isSameDayId(order.dayId, dayId)');
    expect(lookup).toContain('order.customerId === customerId');
    expect(lookup).toContain("order.status !== 'cancelled'");
    expect(lookup).not.toContain('o.customerId === customerId');
  });

  it('navigates directly to an existing same-day order before allowing order creation', () => {
    const addPage = fs.readFileSync(addPagePath, 'utf8');
    const start = addPage.indexOf('const handleSelectCustomer');
    const end = addPage.indexOf('// Handle New Customer Creation', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handler = addPage.slice(start, end);

    expect(handler).toContain('findExistingCustomerOrderOnDay(dayId, customer.id)');
    expect(handler).toContain('if (existingOrd && onEditOrder)');
    expect(handler).toContain('onEditOrder(dayId, existingOrd.id)');
    expect(handler.indexOf('onEditOrder(dayId, existingOrd.id)')).toBeLessThan(handler.indexOf('setSelectedCustomer(customer)'));
    expect(handler).toContain('Do not proceed to the create form when the same-day check failed');
  });
});
