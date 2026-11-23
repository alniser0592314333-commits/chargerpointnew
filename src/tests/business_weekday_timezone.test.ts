import { describe, expect, it } from 'vitest';
import { formatWeekday } from '../utils/dateFormatter';

describe('business weekday formatting', () => {
  it('maps consecutive Postgres calendar dates to their actual weekdays', () => {
    const dates = [
      '2026-11-22',
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
      '2026-11-26',
      '2026-11-27',
      '2026-11-28',
    ];

    expect(dates.map((date) => formatWeekday(date, 'ar'))).toEqual([
      'الأحد',
      'الاثنين',
      'الثلاثاء',
      'الأربعاء',
      'الخميس',
      'الجمعة',
      'السبت',
    ]);
  });

  it('preserves the business calendar date when serialized as an ISO timestamp', () => {
    expect(formatWeekday('2026-11-22T00:00:00.000Z', 'ar')).toBe('الأحد');
    expect(formatWeekday('2026-11-28T23:30:00-08:00', 'en')).toBe('Saturday');
  });

  it('supports English weekday labels and rejects invalid calendar dates', () => {
    expect(formatWeekday('2026-11-23', 'en')).toBe('Monday');
    expect(formatWeekday('2026-02-30', 'ar')).toBe('');
  });
});
