import { describe, expect, it } from 'vitest';
import { mergeCustomerRemoteDelta } from '../utils/customerRemoteMerge';

const existingCustomer = {
  id: 'customer-wael',
  name: 'وايل جودة',
  phone: '0599000000',
  isActive: true,
  notes: 'ملاحظة محفوظة',
  debtLimitMinor: -25000,
  chargerFeeExempt: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  version: 4,
};

describe('partial customer sync delta merge', () => {
  it('preserves the customer name and profile when only charger exemption changes', () => {
    const updated = mergeCustomerRemoteDelta(
      existingCustomer,
      { id: existingCustomer.id, chargerFeeExempt: true },
      existingCustomer.id,
      5
    );

    expect(updated).toMatchObject({
      id: 'customer-wael',
      name: 'وايل جودة',
      phone: '0599000000',
      isActive: true,
      notes: 'ملاحظة محفوظة',
      debtLimitMinor: -25000,
      chargerFeeExempt: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      version: 5,
    });
  });

  it('applies explicit profile edits while preserving every omitted field', () => {
    const updated = mergeCustomerRemoteDelta(
      existingCustomer,
      { id: existingCustomer.id, name: 'وايل جودة الجديد', phone: '' },
      existingCustomer.id,
      6
    );

    expect(updated.name).toBe('وايل جودة الجديد');
    expect(updated.phone).toBe('');
    expect(updated.debtLimitMinor).toBe(-25000);
    expect(updated.chargerFeeExempt).toBe(false);
    expect(updated.notes).toBe('ملاحظة محفوظة');
  });

  it('accepts snake_case fields from database change-log payloads', () => {
    const updated = mergeCustomerRemoteDelta(
      existingCustomer,
      { id: existingCustomer.id, charger_fee_exempt: true, debt_limit_minor: -30000 },
      existingCustomer.id,
      7
    );

    expect(updated.name).toBe('وايل جودة');
    expect(updated.chargerFeeExempt).toBe(true);
    expect(updated.debtLimitMinor).toBe(-30000);
  });
});
