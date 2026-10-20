import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import {
  computeOperationalStatus,
  getBusinessHoursConfig,
  formatTimeDisplay,
  getLocalDateString,
  saveBusinessHoursConfigAndSync,
  BusinessHoursConfig,
} from '../services/businessHoursService';
import { setSupabaseAuthToken } from '../services/supabase/client';

describe('Business Hours & Operational Status Service', () => {
  const storageMap = new Map<string, string>();

  beforeAll(() => {
    (globalThis as any).localStorage = {
      getItem: (key: string) => storageMap.get(key) ?? null,
      setItem: (key: string, value: string) => storageMap.set(key, String(value)),
      removeItem: (key: string) => storageMap.delete(key),
      clear: () => storageMap.clear(),
    };
  });

  beforeEach(() => {
    storageMap.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports NO_TOKEN and does not send a POST when no admin session exists', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    storageMap.delete('supabase_auth_session');
    setSupabaseAuthToken(null);
    const result = await saveBusinessHoursConfigAndSync({ todayOpenTime: '09:00' });
    expect(result.synced).toBe(false);
    expect(result.syncError).toBe('NO_TOKEN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports OFFLINE and does not send a POST when offline', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { onLine: false });
    const result = await saveBusinessHoursConfigAndSync({ todayOpenTime: '09:00' });
    expect(result.synced).toBe(false);
    expect(result.syncError).toBe('OFFLINE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('formats time cleanly in 12-hour format for Arabic and English', () => {
    expect(formatTimeDisplay('08:00', 'ar')).toBe('8:00 صباحاً');
    expect(formatTimeDisplay('08:00', 'en')).toBe('8:00 AM');
    expect(formatTimeDisplay('14:30', 'ar')).toBe('2:30 مساءً');
    expect(formatTimeDisplay('14:30', 'en')).toBe('2:30 PM');
    expect(formatTimeDisplay('22:00', 'ar')).toBe('10:00 مساءً');
    expect(formatTimeDisplay('22:00', 'en')).toBe('10:00 PM');
  });

  it('correctly calculates OPEN phase when current time is within open and close times', () => {
    const config: BusinessHoursConfig = {
      isActive: true,
      todayDate: '2026-10-20',
      todayOpenTime: '08:00',
      todayCloseTime: '22:00',
      tomorrowOpenTime: '09:00',
      tomorrowCloseTime: '21:00',
      chargerFeeMinor: 50,
      lastUpdated: new Date().toISOString(),
    };

    // Simulate 14:00 (2:00 PM)
    const midDay = new Date(2026, 9, 20, 14, 0, 0);
    const status = computeOperationalStatus(config, midDay);

    expect(status.phase).toBe('OPEN');
    expect(status.isOpen).toBe(true);
    expect(status.minutesRemaining).toBe(8 * 60); // 8 hours until 22:00
    expect(status.headlineAr).toContain('نشط ومفتوح');
    expect(status.countdownTextAr).toContain('8 ساعة');
  });

  it('correctly calculates BEFORE_OPEN phase when current time is earlier than opening time', () => {
    const config: BusinessHoursConfig = {
      isActive: true,
      todayDate: '2026-10-20',
      todayOpenTime: '08:00',
      todayCloseTime: '22:00',
      tomorrowOpenTime: '08:00',
      tomorrowCloseTime: '22:00',
      chargerFeeMinor: 50,
      lastUpdated: new Date().toISOString(),
    };

    // Simulate 06:30 AM
    const earlyMorning = new Date(2026, 9, 20, 6, 30, 0);
    const status = computeOperationalStatus(config, earlyMorning);

    expect(status.phase).toBe('BEFORE_OPEN');
    expect(status.isOpen).toBe(false);
    expect(status.minutesRemaining).toBe(90); // 1h 30m
    expect(status.countdownTextAr).toContain('1 ساعة و 30 دقيقة');
  });

  it('correctly calculates AFTER_CLOSE phase when current time is past close time', () => {
    const config: BusinessHoursConfig = {
      isActive: true,
      todayDate: '2026-10-20',
      todayOpenTime: '08:00',
      todayCloseTime: '22:00',
      tomorrowOpenTime: '09:00',
      tomorrowCloseTime: '21:00',
      chargerFeeMinor: 50,
      lastUpdated: new Date().toISOString(),
    };

    // Simulate 22:45 (10:45 PM)
    const lateNight = new Date(2026, 9, 20, 22, 45, 0);
    const status = computeOperationalStatus(config, lateNight);

    expect(status.phase).toBe('AFTER_CLOSE');
    expect(status.isOpen).toBe(false);
    expect(status.headlineAr).toContain('مغلق');
    expect(status.countdownTextAr).toContain('يفتح غداً');
  });

  it('correctly calculates MANUALLY_CLOSED phase when isActive toggle is false', () => {
    const config: BusinessHoursConfig = {
      isActive: false,
      todayDate: '2026-10-20',
      todayOpenTime: '08:00',
      todayCloseTime: '22:00',
      tomorrowOpenTime: '08:00',
      tomorrowCloseTime: '22:00',
      chargerFeeMinor: 50,
      lastUpdated: new Date().toISOString(),
    };

    const midDay = new Date(2026, 9, 20, 14, 0, 0);
    const status = computeOperationalStatus(config, midDay);

    expect(status.phase).toBe('MANUALLY_CLOSED');
    expect(status.isOpen).toBe(false);
    expect(status.headlineAr).toContain('مغلق حالياً');
  });

  it('automatically rolls over tomorrow operating hours into today when date changes', () => {
    const yesterdayDate = '2026-10-18';
    storageMap.set(
      'cp_business_hours_config',
      JSON.stringify({
        isActive: true,
        todayDate: yesterdayDate,
        todayOpenTime: '07:00',
        todayCloseTime: '19:00',
        tomorrowOpenTime: '10:00',
        tomorrowCloseTime: '23:00',
        chargerFeeMinor: 50,
      })
    );

    const loaded = getBusinessHoursConfig();
    const todayStr = getLocalDateString();

    expect(loaded.todayDate).toBe(todayStr);
    expect(loaded.todayOpenTime).toBe('10:00'); // rolled over from tomorrowOpenTime
    expect(loaded.todayCloseTime).toBe('23:00'); // rolled over from tomorrowCloseTime
  });
});
