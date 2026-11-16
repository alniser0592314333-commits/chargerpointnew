import { describe, expect, it } from 'vitest';

const normalizeCustomerSearchText = (value: string): string => value
  .toLocaleLowerCase()
  .normalize('NFD')
  .replace(/[\\u064B-\\u065F\\u0670\\u0640]/g, '')
  .replace(/[أإآٱ]/g, 'ا')
  .replace(/ؤ/g, 'و')
  .replace(/ئ/g, 'ي')
  .replace(/ى/g, 'ي')
  .replace(/ة/g, 'ه')
  .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
  .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
  .replace(/\\s+/g, ' ')
  .trim();

describe('add-order Arabic customer search normalization', () => {
  it('matches hamza variants in customer names', () => {
    expect(normalizeCustomerSearchText('وائل جودة')).toContain(normalizeCustomerSearchText('وايل'));
  });

  it('matches a partial common Arabic name', () => {
    expect(normalizeCustomerSearchText('محمد فرج الله')).toContain(normalizeCustomerSearchText('محمد'));
  });

  it('normalizes Arabic digits and diacritics without changing the visible name', () => {
    expect(normalizeCustomerSearchText('مُحَمَّد ١٢')).toBe('محمد 12');
  });

  it('matches each typed word across the searchable customer fields', () => {
    const terms = normalizeCustomerSearchText('محمد 059').split(' ');
    const values = ['محمد جودة', '0599000000'].map(normalizeCustomerSearchText);
    expect(terms.every((term) => values.some((value) => value.includes(term)))).toBe(true);
  });
});
