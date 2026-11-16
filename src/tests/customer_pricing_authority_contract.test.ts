import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { calculateItemPrice } from '../domain/rules';

describe('customer charger-fee authority contract', () => {
  it('applies the fee only when both device flags allow it and the customer is not exempt', () => {
    expect(calculateItemPrice({
      basePriceMinor: 100,
      chargerFeeEnabled: true,
      chargerFeeApplicable: true,
      customerExempt: false,
      hasCharger: false,
      chargerFeeMinor: 50,
    }).finalChargeSnapshotMinor).toBe(150);

    expect(calculateItemPrice({
      basePriceMinor: 100,
      chargerFeeEnabled: true,
      chargerFeeApplicable: false,
      customerExempt: false,
      hasCharger: false,
      chargerFeeMinor: 50,
    }).finalChargeSnapshotMinor).toBe(100);

    expect(calculateItemPrice({
      basePriceMinor: 100,
      chargerFeeEnabled: true,
      chargerFeeApplicable: true,
      customerExempt: true,
      hasCharger: false,
      chargerFeeMinor: 50,
    }).finalChargeSnapshotMinor).toBe(100);
  });

  it('keeps the exemption in customer-detail updates and refreshes a selected customer on sync', () => {
    const store = readFileSync('src/components/pages/dayOrdersStore.ts', 'utf8');
    const addOrder = readFileSync('src/components/pages/AddOrderPage.tsx', 'utf8');

    expect(store).toContain('chargerFeeExempt: !!updated.chargerFeeExempt');
    expect(store).toContain('chargerFeeApplicable: dev.chargerFeeApplicable ?? dev.chargerFeeEnabled');
    expect(store).toContain('chargerFeeApplicable: p.chargerFeeApplicable ?? p.charger_fee_applicable');
    expect(addOrder).toContain("useStoreSubscription('customers')");
    expect(addOrder).toContain('getCustomerDetail(selectedCustomer.id)');
  });
});
