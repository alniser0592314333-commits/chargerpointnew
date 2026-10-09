import React, { useState, useEffect } from 'react';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';
import { getPublicOrderByToken, PublicOrderQrData } from './dayOrdersStore';
import { Button } from '../ui/Button';
import {
  Globe,
  Sun,
  Moon,
  AlertTriangle,
  Clock,
  BatteryCharging,
  CheckCircle2,
  PackageCheck,
  XCircle,
  Smartphone,
  Calendar,
  Zap,
} from 'lucide-react';

export interface PublicOrderPageProps {
  token: string;
}

/**
 * Public Order Page
 * Strictly PUBLIC and READ-ONLY for customers scanning their Order QR code.
 *
 * Rules:
 * - ZERO authentication required.
 * - ZERO login or password prompt.
 * - ZERO links, mutations, or administrative capabilities.
 * - Displays read-only order status, customer name, and item details.
 */
export const PublicOrderPage: React.FC<PublicOrderPageProps> = ({ token }) => {
  const { locale, setLocale, t, isRTL } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const [data, setData] = useState<PublicOrderQrData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setIsError(false);

    getPublicOrderByToken(token)
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
          console.error('Failed to load public order data:', err);
          setIsError(true);
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [token]);

  const getStatusBadge = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'charging':
        return {
          icon: <BatteryCharging className="w-4 h-4 text-blue-500 animate-pulse" />,
          label: locale === 'en' ? 'Charging' : 'جاري الشحن',
          bg: 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300',
        };
      case 'ready':
        return {
          icon: <CheckCircle2 className="w-4 h-4 text-emerald-500" />,
          label: locale === 'en' ? 'Ready for Pickup' : 'جاهز للاستلام',
          bg: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300',
        };
      case 'delivered':
        return {
          icon: <PackageCheck className="w-4 h-4 text-gray-500" />,
          label: locale === 'en' ? 'Delivered' : 'تم التسليم',
          bg: 'bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300',
        };
      case 'cancelled':
        return {
          icon: <XCircle className="w-4 h-4 text-red-500" />,
          label: locale === 'en' ? 'Cancelled' : 'ملغي',
          bg: 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300',
        };
      case 'pending':
      default:
        return {
          icon: <Clock className="w-4 h-4 text-amber-500" />,
          label: locale === 'en' ? 'In Queue' : 'قيد الانتظار',
          bg: 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300',
        };
    }
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="min-h-screen bg-[#f8faf9] dark:bg-[#031817] text-gray-900 dark:text-[#daf1de] transition-colors flex flex-col justify-between p-4 sm:p-6">
      {/* 1. Minimal Public Top Bar: Locale & Theme Switcher (No Admin Links) */}
      <header className="max-w-md w-full mx-auto flex items-center justify-between py-2 border-b border-gray-200 dark:border-[#123d37]">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-emerald-600/10 dark:bg-emerald-400/10 flex items-center justify-center text-emerald-600 dark:text-[#7ae09e]">
            <Zap className="w-4 h-4" />
          </div>
          <span className="text-xs font-bold text-gray-700 dark:text-[#daf1de]">
            {locale === 'en' ? 'Order Tracking' : 'متابعة الطلب'}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}
            className="h-8 px-2 text-xs"
            aria-label="Toggle language"
          >
            <Globe className="w-3.5 h-3.5" />
            <span>{locale === 'ar' ? 'English' : 'عربي'}</span>
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={toggleTheme}
            className="h-8 w-8 p-0"
            aria-label="Toggle theme"
          >
            {theme === 'light' ? (
              <Moon className="w-3.5 h-3.5 text-gray-700 dark:text-gray-300" />
            ) : (
              <Sun className="w-3.5 h-3.5 text-amber-400" />
            )}
          </Button>
        </div>
      </header>

      {/* 2. Main Public Order Card Display */}
      <main className="max-w-md w-full mx-auto my-auto py-6">
        {isLoading ? (
          <div className="p-8 text-center bg-white dark:bg-[#082622] rounded-2xl border border-gray-200 dark:border-[#14423b] shadow-xs space-y-4">
            <div className="w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-xs text-gray-500 dark:text-[#8eb698]">
              {locale === 'en' ? 'Loading order details...' : 'جاري جلب تفاصيل الطلب...'}
            </p>
          </div>
        ) : isError || !data ? (
          <div className="p-8 text-center bg-white dark:bg-[#082622] rounded-2xl border border-red-200 dark:border-[#421419] shadow-xs space-y-3">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-50 dark:bg-[#360d13] text-red-600 dark:text-[#e07a7a]">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <h2 className="text-base font-bold text-gray-900 dark:text-[#daf1de]">
              {locale === 'en' ? 'Order Not Found' : 'رمز الطلب غير صالح أو غير موجود'}
            </h2>
            <p className="text-xs text-gray-500 dark:text-[#8eb698]">
              {locale === 'en'
                ? 'Please make sure you scanned the correct QR code.'
                : 'تأكد من مسح الرمز الصحيح الخاص بطلبك.'}
            </p>
          </div>
        ) : (
          <div className="bg-white dark:bg-[#082622] rounded-2xl border border-gray-200 dark:border-[#14423b] shadow-md overflow-hidden text-center divide-y divide-gray-100 dark:divide-[#123d37]">
            {/* Order Header */}
            <div className="p-6 space-y-2">
              <span className="inline-block px-3 py-1 bg-emerald-50 dark:bg-[#0c312b] text-emerald-800 dark:text-[#7ae09e] rounded-full text-xs font-black uppercase tracking-wider border border-emerald-200/50 dark:border-[#14423b]">
                {Number.isInteger(data.orderNumber) && data.orderNumber > 0 ? (locale === 'en' ? `Order #${data.orderNumber}` : `طلب #${data.orderNumber}`) : (locale === 'en' ? 'Order number unavailable' : 'رقم الطلب غير متاح')}
              </span>
              <h1 className="text-xl font-black text-gray-900 dark:text-[#daf1de]">
                {data.customerName}
              </h1>

              {/* Status Badge */}
              <div className="pt-2 flex justify-center">
                {(() => {
                  const badge = getStatusBadge(data.status);
                  return (
                    <div
                      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${badge.bg}`}
                    >
                      {badge.icon}
                      <span>{badge.label}</span>
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Order Meta */}
            <div className="p-4 bg-gray-50/50 dark:bg-[#061f1c]/50 text-xs space-y-2 text-start">
              <div className="flex items-center justify-between text-gray-600 dark:text-[#8eb698]">
                <span className="flex items-center gap-1.5 font-medium">
                  <Calendar className="w-3.5 h-3.5" />
                  <span>{locale === 'en' ? 'Order Date:' : 'تاريخ الطلب:'}</span>
                </span>
                <span className="font-mono">{formatDate(data.createdAt)}</span>
              </div>

              {data.itemsCount !== undefined && data.itemsCount > 0 && (
                <div className="flex items-center justify-between text-gray-600 dark:text-[#8eb698]">
                  <span className="flex items-center gap-1.5 font-medium">
                    <Smartphone className="w-3.5 h-3.5" />
                    <span>{locale === 'en' ? 'Devices:' : 'عدد الأجهزة:'}</span>
                  </span>
                  <span className="font-bold">{data.itemsCount}</span>
                </div>
              )}
            </div>

            {/* Order Items List (if available) */}
            {data.items && data.items.length > 0 && (
              <div className="p-4 space-y-2 text-start">
                <h3 className="text-xs font-bold text-gray-700 dark:text-[#8eb698]">
                  {locale === 'en' ? 'Device Details:' : 'تفاصيل الأجهزة:'}
                </h3>
                <div className="space-y-1.5">
                  {data.items.map((item, idx) => (
                    <div
                      key={idx}
                      className="p-2 rounded-lg bg-gray-50 dark:bg-[#0c312b] border border-gray-100 dark:border-[#14423b] flex items-center justify-between text-xs"
                    >
                      <span className="font-medium text-gray-800 dark:text-[#daf1de]">
                        {item.name}
                      </span>
                      {item.has_charger && (
                        <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-100/60 dark:bg-emerald-900/40 text-emerald-800 dark:text-[#7ae09e] font-semibold">
                          {locale === 'en' ? 'With Charger' : 'مع شاحن'}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Footer Notice */}
            <div className="p-4 bg-gray-50/30 dark:bg-[#061f1c]/30 text-center">
              <p className="text-[11px] text-gray-500 dark:text-[#5e8674] font-medium">
                {locale === 'en'
                  ? 'Thank you for choosing our service · Charging Point'
                  : 'شكرًا لتعاملكم معنا · نقطة الشحن'}
              </p>
            </div>
          </div>
        )}
      </main>

      {/* 3. Minimal Public Footer */}
      <footer className="max-w-md w-full mx-auto py-2 text-center text-[10px] text-gray-400 dark:text-[#5e8674] border-t border-gray-200 dark:border-[#123d37]">
        <span>{locale === 'en' ? 'Charging Point System' : 'نظام نقطة الشحن'}</span>
      </footer>
    </div>
  );
};
