import React, { useState, useEffect } from 'react';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';
import { getPublicCustomerByToken, PublicCustomerQrData } from './dayOrdersStore';
import { Button } from '../ui/Button';
import {
  Globe,
  Sun,
  Moon,
  AlertTriangle,
  User,
  CheckCircle2,
  ShieldCheck,
  Zap,
  Sparkles,
  Layers,
  Clock,
} from 'lucide-react';

export interface PublicCustomerQrPageProps {
  token: string;
}

/**
 * Public Customer Page
 * Strictly PUBLIC and READ-ONLY for customers who scan their Customer QR code or open their direct link.
 *
 * Rules:
 * - ZERO authentication required.
 * - ZERO login or password prompt.
 * - Displays customer profile information (Name, Customer Code, Account Status).
 * - Safe, read-only customer portal interface.
 */
export const PublicCustomerQrPage: React.FC<PublicCustomerQrPageProps> = ({ token }) => {
  const { locale, setLocale, t, isRTL } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const [data, setData] = useState<PublicCustomerQrData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setIsError(false);

    getPublicCustomerByToken(token)
      .then((res) => {
        if (active) {
          if (res) {
            setData(res);
          } else {
            setIsError(true);
          }
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          console.error('Failed to load public customer data:', err);
          setIsError(true);
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [token]);

  // Extract initials for avatar
  const getInitials = (name?: string) => {
    if (!name) return 'C';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  };

  return (
    <div className="min-h-screen bg-[#f4f7f7] dark:bg-[#071b1b] text-[#142c2c] dark:text-[#e7f2ef] transition-colors flex flex-col justify-between p-4 sm:p-6">
      {/* 1. Minimal Public Top Bar: Locale & Theme Switcher (No Admin Links) */}
      <header className="max-w-5xl w-full mx-auto flex items-center justify-between gap-3 py-4 border-b border-[#dce6e4] dark:border-[#1c4140]">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded-xl bg-[#0f766e] flex items-center justify-center text-white shadow-sm">
            <Zap className="w-4 h-4" />
          </div>
          <span className="text-sm font-bold tracking-tight text-[#142c2c] dark:text-[#e7f2ef]">
            {locale === 'en' ? 'Charging Point' : 'نقطة الشحن'}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}
            className="h-8 px-2 text-xs text-gray-700 dark:text-[#daf1de] hover:bg-gray-100 dark:hover:bg-[#0c312b]"
            aria-label="Toggle language"
          >
            <Globe className="w-3.5 h-3.5" />
            <span>{locale === 'ar' ? 'English' : 'عربي'}</span>
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={toggleTheme}
            className="h-8 w-8 p-0 text-gray-700 dark:text-[#daf1de] hover:bg-gray-100 dark:hover:bg-[#0c312b]"
            aria-label="Toggle theme"
          >
            {theme === 'light' ? (
              <Moon className="w-3.5 h-3.5 text-gray-700" />
            ) : (
              <Sun className="w-3.5 h-3.5 text-amber-400" />
            )}
          </Button>
        </div>
      </header>

      {/* 2. Main Body: Customer Profile & Read-Only Information */}
      <main className="flex-1 flex items-center justify-center py-6 sm:py-8">
        {isLoading ? (
          <div className="text-center py-16 space-y-3 animate-pulse">
            <div className="w-16 h-16 rounded-full bg-gray-200 dark:bg-[#0e3b34] mx-auto" />
            <div className="h-4 w-32 bg-gray-200 dark:bg-[#0e3b34] rounded mx-auto" />
            <div className="h-3 w-24 bg-gray-200 dark:bg-[#0e3b34] rounded mx-auto" />
          </div>
        ) : isError || !data ? (
          <div className="max-w-sm w-full mx-auto bg-white dark:bg-[#082622] p-8 rounded-2xl border border-gray-200 dark:border-[#14423b] text-center space-y-4 shadow-sm">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-100 dark:bg-[#360d13] text-red-600 dark:text-[#e07a7a]">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <h2 className="text-base font-bold text-gray-900 dark:text-[#daf1de]">
              {locale === 'en' ? 'Customer Profile Not Found' : 'رمز العميل غير صالح أو غير موجود'}
            </h2>
            <p className="text-xs text-gray-500 dark:text-[#8eb698]">
              {locale === 'en'
                ? 'Please make sure you scanned the correct customer code.'
                : 'تأكد من مسح الرمز الصحيح الخاص بحسابك.'}
            </p>
          </div>
        ) : (
          <div className="max-w-md w-full mx-auto space-y-4">
            {/* Customer Main Card */}
            <div className="bg-white dark:bg-[#082622] rounded-2xl border border-gray-200 dark:border-[#14423b] p-6 shadow-sm space-y-5 text-center sm:text-start">
              {/* Header Profile Info */}
              <div className="flex flex-col sm:flex-row items-center sm:items-start gap-4">
                <div className="w-16 h-16 rounded-2xl bg-linear-to-br from-emerald-600 to-teal-800 text-white flex items-center justify-center font-bold text-xl shadow-md shrink-0">
                  {getInitials(data.customerName)}
                </div>

                <div className="flex-1 min-w-0 space-y-1 text-center sm:text-start">
                  <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
                    <h1 className="text-lg sm:text-xl font-bold text-gray-900 dark:text-[#daf1de] truncate">
                      {data.customerName}
                    </h1>
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-[#7ae09e] border border-emerald-200 dark:border-emerald-800/40">
                      <CheckCircle2 className="w-3 h-3" />
                      <span>{locale === 'en' ? 'Active' : 'نشط وموثق'}</span>
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-[#8eb698] font-mono">
                    ID: {data.customerCode}
                  </p>
                </div>
              </div>

              {/* Quick Info Grid */}
              <div className="grid grid-cols-2 gap-3 pt-2">
                <div className="p-3 rounded-xl bg-gray-50 dark:bg-[#0c312b]/60 border border-gray-100 dark:border-[#14423b]/60">
                  <span className="text-[11px] text-gray-500 dark:text-[#8eb698] block">
                    {locale === 'en' ? 'Customer Code' : 'رمز العميل'}
                  </span>
                  <span className="text-sm font-bold text-gray-900 dark:text-[#daf1de] font-mono">
                    {data.customerCode}
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-gray-50 dark:bg-[#0c312b]/60 border border-gray-100 dark:border-[#14423b]/60">
                  <span className="text-[11px] text-gray-500 dark:text-[#8eb698] block">
                    {locale === 'en' ? 'Service Point' : 'نقطة الخدمة'}
                  </span>
                  <span className="text-sm font-bold text-emerald-600 dark:text-[#7ae09e]">
                    {locale === 'en' ? 'Charging Point' : 'نقطة الشحن'}
                  </span>
                </div>
              </div>

              {/* Verification & Trust Badge */}
              <div className="p-3.5 rounded-xl bg-emerald-50/70 dark:bg-[#0c312b]/40 border border-emerald-100 dark:border-emerald-900/30 flex items-start gap-2.5 text-xs text-emerald-800 dark:text-[#9ed6ab]">
                <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-[#7ae09e] shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <p className="font-semibold">
                    {locale === 'en' ? 'Official Registered Customer' : 'حساب عميل معتمد'}
                  </p>
                  <p className="text-[11px] text-emerald-700/80 dark:text-[#8eb698]">
                    {locale === 'en'
                      ? 'This page is a secure, read-only portal for viewing your customer account status.'
                      : 'هذه الصفحة هي بوابة آمنة وقابلة للقراءة فقط لعرض تفاصيل حسابك.'}
                  </p>
                </div>
              </div>
            </div>

            {/* Placeholder / Future Features Card */}
            <div className="bg-white/70 dark:bg-[#082622]/70 rounded-2xl border border-dashed border-gray-200 dark:border-[#14423b] p-4 text-center space-y-2">
              <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-[#0c312b] text-gray-400 dark:text-[#8eb698] flex items-center justify-center mx-auto">
                <Clock className="w-4 h-4" />
              </div>
              <p className="text-xs font-medium text-gray-600 dark:text-[#daf1de]">
                {locale === 'en' ? 'More Customer Details Coming Soon' : 'بيانات وخدمات إضافية قريباً'}
              </p>
              <p className="text-[11px] text-gray-400 dark:text-[#8eb698]">
                {locale === 'en'
                  ? 'Recent order history and special balance services will appear here.'
                  : 'سجل الطلبات السابقة وتفاصيل الخدمات الإضافية ستظهر هنا فور تفعيلها.'}
              </p>
            </div>
          </div>
        )}
      </main>

      {/* 3. Minimal Footer */}
      <footer className="max-w-5xl w-full mx-auto text-center py-5 border-t border-[#dce6e4] dark:border-[#1c4140] text-[11px] text-[#7d9690] dark:text-[#779791]">
        <span>{locale === 'en' ? 'Charging Point • Customer Portal' : 'نقطة الشحن • بوابة العميل'}</span>
        <span className="mx-2">·</span>
        <a href="/public/about" className="font-semibold hover:text-[#0f766e] dark:hover:text-[#83cbbd]">{locale === 'en' ? 'About' : 'عن التطبيق'}</a>
      </footer>
    </div>
  );
};
