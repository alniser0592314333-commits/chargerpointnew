/**
 * Normalize Arabic and Latin customer-search text so common spelling variants,
 * diacritics, tatweel, and Arabic-Indic digits do not prevent a match.
 */
export const normalizeCustomerSearchText = (value: string): string => value
  .toLocaleLowerCase()
  .normalize('NFD')
  .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
  .replace(/[أإآٱ]/g, 'ا')
  .replace(/ؤ/g, 'و')
  .replace(/ئ/g, 'ي')
  .replace(/ى/g, 'ي')
  .replace(/ة/g, 'ه')
  .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
  .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
  .replace(/\s+/g, ' ')
  .trim();
