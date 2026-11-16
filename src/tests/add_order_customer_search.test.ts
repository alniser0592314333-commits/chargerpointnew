import { describe, expect, it } from 'vitest';
import { normalizeCustomerSearchText } from '../utils/customerSearch';

describe('add-order Arabic customer search normalization', () => {
  it('matches hamza variants in customer names', () => {
    expect(normalizeCustomerSearchText('وائل جودة')).toContain(normalizeCustomerSearchText('وايل'));
  });

  it('matches a partial common Arabic name', () => {
    expect(normalizeCustomerSearchText('محمد فرج الله')).toContain(normalizeCustomerSearchText('محمد'));
  });

  it('normalizes Arabic digits and diacritics', () => {
    expect(normalizeCustomerSearchText('مُحَمَّد ١٢')).toBe('محمد 12');
  });

  it('matches each typed word across searchable customer fields', () => {
    const terms = normalizeCustomerSearchText('محمد 059').split(' ');
    const values = ['محمد جودة', '0599000000'].map(normalizeCustomerSearchText);
    expect(terms.every((term) => values.some((value) => value.includes(term))).toBe(true);
  });
});
