import React, { createContext, useContext, useState, useEffect } from 'react';
import { Locale, translations, TranslationKey } from './translations';
import {
  formatDate as utilFormatDate,
  formatDateTime as utilFormatDateTime,
  formatTime as utilFormatTime,
  formatWeekday as utilFormatWeekday,
  formatCurrency as utilFormatCurrency,
} from '../utils/dateFormatter';

interface I18nContextType {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey | string, params?: Record<string, string | number>) => string;
  dir: 'rtl' | 'ltr';
  isRTL: boolean;
  formatDate: (date: string | Date | undefined | null) => string;
  formatDateTime: (date: string | Date | undefined | null) => string;
  formatTime: (date: string | Date | undefined | null) => string;
  formatWeekday: (date: string | Date | undefined | null) => string;
  formatCurrency: (minor: number) => string;
}

export const I18nContext = createContext<I18nContextType | undefined>(undefined);

const getInitialLocale = (): Locale => {
  try {
    const saved = localStorage.getItem('sys_locale');
    if (saved === 'ar' || saved === 'en') return saved;
  } catch (e) {
    console.warn('Failed to read locale from localStorage', e);
  }
  return 'ar';
};

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [locale, setLocaleState] = useState<Locale>(getInitialLocale);

  const setLocale = (newLocale: Locale) => {
    setLocaleState(newLocale);
    try {
      localStorage.setItem('sys_locale', newLocale);
    } catch (e) {
      console.warn('Failed to save locale to localStorage', e);
    }
    document.documentElement.lang = newLocale;
    document.documentElement.dir = newLocale === 'ar' ? 'rtl' : 'ltr';
  };

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);

  const t = (key: TranslationKey | string, params?: Record<string, string | number>): string => {
    const dict = translations[locale] as Record<string, string>;
    const fallbackDict = translations['ar'] as Record<string, string>;
    let text = dict[key] ?? fallbackDict[key] ?? String(key);

    if (params) {
      Object.entries(params).forEach(([paramKey, paramVal]) => {
        text = text.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramVal));
      });
    }

    return text;
  };

  const dir: 'rtl' | 'ltr' = locale === 'ar' ? 'rtl' : 'ltr';
  const isRTL = dir === 'rtl';

  const formatDate = (date: string | Date | undefined | null) => utilFormatDate(date, locale);
  const formatDateTime = (date: string | Date | undefined | null) => utilFormatDateTime(date, locale);
  const formatTime = (date: string | Date | undefined | null) => utilFormatTime(date, locale);
  const formatWeekday = (date: string | Date | undefined | null) => utilFormatWeekday(date, locale);
  const formatCurrency = (minor: number) => utilFormatCurrency(minor);

  return (
    <I18nContext.Provider
      value={{
        locale,
        setLocale,
        t,
        dir,
        isRTL,
        formatDate,
        formatDateTime,
        formatTime,
        formatWeekday,
        formatCurrency,
      }}
    >
      <div dir={dir} className="min-h-screen transition-colors duration-200">
        {children}
      </div>
    </I18nContext.Provider>
  );
};

export const useI18n = (): I18nContextType => {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return context;
};
