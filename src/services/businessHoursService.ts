/**
 * Business Hours & Operational Status Service
 *
 * Handles:
 * 1. Admin-configurable shop status (Open/Active toggle).
 * 2. Today's working hours (Opening and Closing time).
 * 3. Tomorrow's working hours (Opening and Closing time).
 * 4. Automatic daily rollover: when the calendar day changes, tomorrow's hours
 *    automatically roll over to become today's hours.
 * 5. Dynamic time calculation (Opens in X hrs/mins, Closes in X hrs/mins) in local time.
 * 6. Cross-tab and real-time reactive updates via Storage and CustomEvent.
 */

export interface BusinessHoursConfig {
  isActive: boolean;
  todayDate: string; // ISO YYYY-MM-DD in local time
  todayOpenTime: string; // "HH:mm" 24h
  todayCloseTime: string; // "HH:mm" 24h
  tomorrowOpenTime: string; // "HH:mm" 24h
  tomorrowCloseTime: string; // "HH:mm" 24h
  chargerFeeMinor: number; // in minor units (50 = 0.50 ILS)
  lastUpdated: string;
}

export type OperationalPhase =
  | 'OPEN' // currently active and within open hours
  | 'BEFORE_OPEN' // active, but before today's open time
  | 'AFTER_CLOSE' // active, but after today's close time
  | 'MANUALLY_CLOSED'; // isActive toggle is false

export interface OperationalStatusDetail {
  phase: OperationalPhase;
  isOpen: boolean;
  headlineAr: string;
  headlineEn: string;
  countdownTextAr: string;
  countdownTextEn: string;
  minutesRemaining: number;
  todayOpenFormatted: string;
  todayCloseFormatted: string;
  tomorrowOpenFormatted: string;
  tomorrowCloseFormatted: string;
}

const STORAGE_KEY = 'cp_business_hours_config';
const EVENT_NAME = 'cp_business_hours_updated';

// Helper to get local date string YYYY-MM-DD
export function getLocalDateString(d: Date = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Format 24h HH:mm to localized 12h display
export function formatTimeDisplay(timeStr: string, locale: 'ar' | 'en'): string {
  if (!timeStr || !timeStr.includes(':')) return timeStr;
  const [hStr, mStr] = timeStr.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (isNaN(h) || isNaN(m)) return timeStr;

  const isPm = h >= 12;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const mPad = String(m).padStart(2, '0');

  if (locale === 'ar') {
    const period = isPm ? 'مساءً' : 'صباحاً';
    return `${h12}:${mPad} ${period}`;
  }
  const period = isPm ? 'PM' : 'AM';
  return `${h12}:${mPad} ${period}`;
}

// Canonical defaults
export const DEFAULT_BUSINESS_HOURS: BusinessHoursConfig = {
  isActive: true,
  todayDate: getLocalDateString(),
  todayOpenTime: '08:00',
  todayCloseTime: '22:00',
  tomorrowOpenTime: '08:00',
  tomorrowCloseTime: '22:00',
  chargerFeeMinor: 50, // 0.50 ILS
  lastUpdated: new Date().toISOString(),
};

/**
 * Reads settings from storage and performs daily rollover if date has shifted.
 */
export function getBusinessHoursConfig(): BusinessHoursConfig {
  const todayStr = getLocalDateString();
  let config: BusinessHoursConfig = { ...DEFAULT_BUSINESS_HOURS };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      config = {
        ...DEFAULT_BUSINESS_HOURS,
        ...parsed,
      };
    }
  } catch (e) {
    console.warn('Failed to parse business hours config:', e);
  }

  // Automatic Day Rollover Logic:
  // If the stored todayDate is earlier than today's actual date,
  // tomorrow's values become today's values!
  if (config.todayDate && config.todayDate !== todayStr) {
    const previousDate = new Date(config.todayDate);
    const currentDate = new Date(todayStr);
    const dayDiff = Math.round((currentDate.getTime() - previousDate.getTime()) / (1000 * 60 * 60 * 24));

    if (dayDiff >= 1) {
      // Tomorrow's operating hours roll over into today's operating hours
      config.todayOpenTime = config.tomorrowOpenTime || '08:00';
      config.todayCloseTime = config.tomorrowCloseTime || '22:00';
      config.todayDate = todayStr;
      config.lastUpdated = new Date().toISOString();
      // Persist the rolled-over state
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      } catch {}
    }
  }

  return config;
}

/**
 * Saves business hours settings and broadcasts update.
 */
export function saveBusinessHoursConfig(updates: Partial<BusinessHoursConfig>): BusinessHoursConfig {
  const current = getBusinessHoursConfig();
  const next: BusinessHoursConfig = {
    ...current,
    ...updates,
    todayDate: getLocalDateString(),
    lastUpdated: new Date().toISOString(),
  };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (e) {
    console.warn('Failed to save business hours config:', e);
  }

  // Dispatch custom event for real-time reactivity in current tab
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: next }));
  }

  return next;
}

/**
 * Subscribes to business hours changes (storage events & in-tab custom events).
 */
export function subscribeBusinessHours(callback: (config: BusinessHoursConfig) => void): () => void {
  const handleCustom = (e: Event) => {
    const custom = e as CustomEvent<BusinessHoursConfig>;
    if (custom.detail) {
      callback(custom.detail);
    } else {
      callback(getBusinessHoursConfig());
    }
  };

  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      callback(getBusinessHoursConfig());
    }
  };

  window.addEventListener(EVENT_NAME, handleCustom);
  window.addEventListener('storage', handleStorage);

  return () => {
    window.removeEventListener(EVENT_NAME, handleCustom);
    window.removeEventListener('storage', handleStorage);
  };
}

/**
 * Computes exact operational status and human-friendly time diffs.
 */
export function computeOperationalStatus(
  config: BusinessHoursConfig,
  currentTime: Date = new Date()
): OperationalStatusDetail {
  const currentHour = currentTime.getHours();
  const currentMin = currentTime.getMinutes();
  const currentTotalMin = currentHour * 60 + currentMin;

  const [openH, openM] = (config.todayOpenTime || '08:00').split(':').map((v) => parseInt(v, 10));
  const [closeH, closeM] = (config.todayCloseTime || '22:00').split(':').map((v) => parseInt(v, 10));

  const openTotalMin = (isNaN(openH) ? 8 : openH) * 60 + (isNaN(openM) ? 0 : openM);
  const closeTotalMin = (isNaN(closeH) ? 22 : closeH) * 60 + (isNaN(closeM) ? 0 : closeM);

  const formatCountdown = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h > 0 && m > 0) {
      return {
        ar: `${h} ساعة و ${m} دقيقة`,
        en: `${h}h ${m}m`,
      };
    }
    if (h > 0) {
      return {
        ar: `${h} ساعة`,
        en: `${h}h`,
      };
    }
    return {
      ar: `${m} دقيقة`,
      en: `${m}m`,
    };
  };

  // If manually deactivated
  if (!config.isActive) {
    return {
      phase: 'MANUALLY_CLOSED',
      isOpen: false,
      headlineAr: 'مغلق حالياً',
      headlineEn: 'Currently Closed',
      countdownTextAr: 'نقطة الشحن غير نشطة الآن. تواصل معنا للحالات الطارئة.',
      countdownTextEn: 'Charging Point is inactive now. Contact us for urgent requests.',
      minutesRemaining: 0,
      todayOpenFormatted: formatTimeDisplay(config.todayOpenTime, 'ar'),
      todayCloseFormatted: formatTimeDisplay(config.todayCloseTime, 'ar'),
      tomorrowOpenFormatted: formatTimeDisplay(config.tomorrowOpenTime, 'ar'),
      tomorrowCloseFormatted: formatTimeDisplay(config.tomorrowCloseTime, 'ar'),
    };
  }

  // Before open time
  if (currentTotalMin < openTotalMin) {
    const diff = openTotalMin - currentTotalMin;
    const cd = formatCountdown(diff);
    return {
      phase: 'BEFORE_OPEN',
      isOpen: false,
      headlineAr: 'مغلق مؤقتاً',
      headlineEn: 'Temporarily Closed',
      countdownTextAr: `يفتح بعد ${cd.ar}`,
      countdownTextEn: `Opens in ${cd.en}`,
      minutesRemaining: diff,
      todayOpenFormatted: formatTimeDisplay(config.todayOpenTime, 'ar'),
      todayCloseFormatted: formatTimeDisplay(config.todayCloseTime, 'ar'),
      tomorrowOpenFormatted: formatTimeDisplay(config.tomorrowOpenTime, 'ar'),
      tomorrowCloseFormatted: formatTimeDisplay(config.tomorrowCloseTime, 'ar'),
    };
  }

  // During open hours
  if (currentTotalMin >= openTotalMin && currentTotalMin < closeTotalMin) {
    const diff = closeTotalMin - currentTotalMin;
    const cd = formatCountdown(diff);
    return {
      phase: 'OPEN',
      isOpen: true,
      headlineAr: 'نشط ومفتوح الآن',
      headlineEn: 'Active & Open Now',
      countdownTextAr: `يغلق بعد ${cd.ar}`,
      countdownTextEn: `Closes in ${cd.en}`,
      minutesRemaining: diff,
      todayOpenFormatted: formatTimeDisplay(config.todayOpenTime, 'ar'),
      todayCloseFormatted: formatTimeDisplay(config.todayCloseTime, 'ar'),
      tomorrowOpenFormatted: formatTimeDisplay(config.tomorrowOpenTime, 'ar'),
      tomorrowCloseFormatted: formatTimeDisplay(config.tomorrowCloseTime, 'ar'),
    };
  }

  // After close time
  const tomorrowOpenFormattedAr = formatTimeDisplay(config.tomorrowOpenTime, 'ar');
  const tomorrowOpenFormattedEn = formatTimeDisplay(config.tomorrowOpenTime, 'en');
  return {
    phase: 'AFTER_CLOSE',
    isOpen: false,
    headlineAr: 'مغلق لليوم',
    headlineEn: 'Closed for Today',
    countdownTextAr: `يفتح غداً في ${tomorrowOpenFormattedAr}`,
    countdownTextEn: `Opens tomorrow at ${tomorrowOpenFormattedEn}`,
    minutesRemaining: 0,
    todayOpenFormatted: formatTimeDisplay(config.todayOpenTime, 'ar'),
    todayCloseFormatted: formatTimeDisplay(config.todayCloseTime, 'ar'),
    tomorrowOpenFormatted: tomorrowOpenFormattedAr,
    tomorrowCloseFormatted: formatTimeDisplay(config.tomorrowCloseTime, 'ar'),
  };
}
