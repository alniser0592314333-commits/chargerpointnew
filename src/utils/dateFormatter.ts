import { Locale } from '../i18n/translations';

/**
 * Centralized Locale Date, Time and Currency Formatter
 * Complies with strict RTL/LTR and Arabic/English locale requirements.
 */

export function formatDate(
  dateInput: string | Date | undefined | null,
  locale: Locale = 'ar'
): string {
  if (!dateInput) return '';

  try {
    let date: Date;
    if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
      const [year, month, day] = dateInput.split('-').map(Number);
      date = new Date(year, month - 1, day);
    } else {
      date = new Date(dateInput);
    }

    if (isNaN(date.getTime())) return String(dateInput);

    return date.toLocaleDateString(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return String(dateInput);
  }
}

export function formatWeekday(
  dateInput: string | Date | undefined | null,
  locale: Locale = 'ar'
): string {
  if (!dateInput) return '';

  try {
    let date: Date;
    if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
      const [year, month, day] = dateInput.split('-').map(Number);
      date = new Date(year, month - 1, day);
    } else {
      date = new Date(dateInput);
    }

    if (isNaN(date.getTime())) return '';

    return date.toLocaleDateString(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US', {
      weekday: 'long',
    });
  } catch {
    return '';
  }
}

export function formatTime(
  dateInput: string | Date | undefined | null,
  locale: Locale = 'ar'
): string {
  if (!dateInput) return '';

  try {
    const date = new Date(dateInput);
    if (isNaN(date.getTime())) return '';

    const hours = date.getHours();
    const minutes = date.getMinutes();
    const h12 = hours % 12 === 0 ? 12 : hours % 12;
    const mStr = minutes < 10 ? `0${minutes}` : `${minutes}`;
    return `${h12}:${mStr}`;
  } catch {
    return '';
  }
}

export function formatDateTime(
  dateInput: string | Date | undefined | null,
  locale: Locale = 'ar'
): string {
  if (!dateInput) return '';

  try {
    const date = new Date(dateInput);
    if (isNaN(date.getTime())) return String(dateInput);

    const dStr = formatDate(date, locale);
    const tStr = formatTime(date, locale);
    return `${dStr} · ${tStr}`;
  } catch {
    return String(dateInput);
  }
}

export function formatCurrency(minor: number): string {
  const val = minor / 100;
  const formatted = val % 1 === 0 ? `${val}` : `${val.toFixed(2)}`;
  return `${formatted} ₪`;
}

/**
 * Helper to produce consistent local calendar/business date string in YYYY-MM-DD format.
 * Prevents UTC timezone shifts for business day identification around midnight.
 */
export function getLocalBusinessDateStr(dateInput: string | Date = new Date()): string {
  const d = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (isNaN(d.getTime())) {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

