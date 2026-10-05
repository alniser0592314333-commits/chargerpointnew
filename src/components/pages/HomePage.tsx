import React, { useState, useEffect } from 'react';
import { useI18n } from '../../i18n/i18nContext';
import {
  getTodayHomeData,
  createTodayBusinessDay,
  UIHomeDashboardData,
  UIRecentFinancialActivityItem,
} from './dayOrdersStore';
import { Button } from '../ui/Button';
import {
  Plus,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Calendar,
  Layers,
  Users,
  Wallet,
  Settings,
  ArrowDownLeft,
  ShoppingBag,
  CircleDollarSign,
  TrendingDown,
  ReceiptText,
} from 'lucide-react';

export interface HomePageProps {
  onNavigate?: (path: string) => void;
  onSelectOrder?: (dayId: string, orderId: string) => void;
}

export const HomePage: React.FC<HomePageProps> = ({ onNavigate }) => {
  const { t, locale, isRTL, formatDate, formatWeekday, formatCurrency } = useI18n();

  const [loading, setLoading] = useState(true);
  const [dashboardData, setDashboardData] = useState<UIHomeDashboardData | null>(null);
  const [isCreatingDay, setIsCreatingDay] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await getTodayHomeData(locale as 'ar' | 'en');
      setDashboardData(data);
    } catch (err) {
      console.error('Failed to load home dashboard data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [locale]);

  const handleCreateToday = async () => {
    if (!dashboardData) return;
    setIsCreatingDay(true);
    try {
      const dayId = await createTodayBusinessDay(dashboardData.currentDateStr);
      await loadData();
      if (onNavigate) {
        onNavigate(`/app/days/${dayId}`);
      }
    } catch (err) {
      console.error('Failed to create today business day:', err);
    } finally {
      setIsCreatingDay(false);
    }
  };

  const navigateTo = (path: string) => {
    if (onNavigate) {
      onNavigate(path);
    }
  };

  const formatActivityTime = (isoString: string): string => {
    try {
      const d = new Date(isoString);
      const hours = d.getHours().toString().padStart(2, '0');
      const mins = d.getMinutes().toString().padStart(2, '0');
      return `${hours}:${mins}`;
    } catch {
      return '';
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-7 pb-20 px-4 sm:px-6 text-gray-900 dark:text-[#daf1de]">
      {/* 1. Header: Page Title + Clean Hairline Divider (Direct on surface, no card) */}
      <div className="border-b border-gray-200 dark:border-[#14423b] pb-3">
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-[#daf1de] tracking-tight">
          {t('navHome')}
        </h1>
      </div>

      {loading ? (
        /* Loading Skeleton */
        <div className="space-y-6 animate-pulse">
          <div className="h-24 bg-gray-100 dark:bg-[#082622]/60 rounded-lg" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="h-16 bg-gray-100 dark:bg-[#082622]/60 rounded-lg" />
            <div className="h-16 bg-gray-100 dark:bg-[#082622]/60 rounded-lg" />
            <div className="h-16 bg-gray-100 dark:bg-[#082622]/60 rounded-lg" />
            <div className="h-16 bg-gray-100 dark:bg-[#082622]/60 rounded-lg" />
          </div>
          <div className="h-36 bg-gray-100 dark:bg-[#082622]/60 rounded-lg" />
        </div>
      ) : !dashboardData ? (
        <div className="py-12 text-center text-xs text-gray-500">
          {t('noOrdersToday')}
        </div>
      ) : (
        <>
          {/* 2. Today Section (Direct on page surface, clean layout without card box) */}
          <section className="space-y-3 pb-5 border-b border-gray-200/80 dark:border-[#14423b]">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-600 dark:text-[#8eb698]">
                  {t('todayLabel')}
                </span>
                <h2 className="text-base sm:text-lg font-bold text-gray-900 dark:text-[#daf1de] mt-0.5">
                  {formatWeekday(dashboardData.currentDateStr)}، {formatDate(dashboardData.currentDateStr)}
                </h2>
              </div>

              {/* Action Buttons */}
              {dashboardData.todayDay ? (
                <div className="flex items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => navigateTo(`/app/days/${dashboardData.todayDay!.id}/add-order`)}
                    className="gap-1.5 font-semibold text-xs h-9 px-3.5 cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    <span>{t('addOrder')}</span>
                  </Button>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigateTo(`/app/days/${dashboardData.todayDay!.id}`)}
                    className="gap-1.5 text-xs h-9 px-3 cursor-pointer"
                  >
                    <span>{t('openDay')}</span>
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ) : (
                <div>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleCreateToday}
                    disabled={isCreatingDay}
                    className="gap-1.5 font-semibold text-xs h-9 px-4 cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    <span>{t('createTodayDay')}</span>
                  </Button>
                </div>
              )}
            </div>

            {/* Today's Metrics (Direct on surface) */}
            {dashboardData.todayDay ? (
              <div className="grid grid-cols-2 gap-4 pt-1">
                <div>
                  <span className="text-xs text-gray-500 dark:text-[#8eb698] block">
                    {t('ordersCountLabel')}
                  </span>
                  <span className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-[#daf1de] tracking-tight">
                    {dashboardData.todayDay.orderCount}
                  </span>
                </div>

                <div>
                  <span className="text-xs text-gray-500 dark:text-[#8eb698] block">
                    {t('todayOrdersValue')}
                  </span>
                  <span className="text-xl sm:text-2xl font-bold text-emerald-600 dark:text-[#8eb698] tracking-tight font-mono">
                    {formatCurrency(dashboardData.todayDay.totalOrderValueMinor)}
                  </span>
                </div>
              </div>
            ) : (
              <div className="py-1 flex items-center gap-2 text-xs text-gray-500 dark:text-[#8eb698]">
                <Calendar className="w-4 h-4 text-gray-400 dark:text-[#5e8674]" />
                <span>{t('dayNotCreatedYet')}</span>
              </div>
            )}
          </section>

          {/* 3. General Financial Summary (Directly on main page surface, ZERO card boxes) */}
          <section className="space-y-3 pb-5 border-b border-gray-200/80 dark:border-[#14423b]">
            <div className="pb-1">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-[#daf1de]">
                {t('financialSummaryTitle')}
              </h2>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6 pt-1">
              {/* A. Total Debt */}
              <div className="space-y-1">
                <span className="text-xs text-gray-500 dark:text-[#8eb698] block font-medium">
                  {t('totalDebt')}
                </span>
                <div className="flex items-center gap-1.5">
                  <p className="text-base sm:text-lg font-bold text-rose-600 dark:text-rose-400 font-mono tracking-tight">
                    {formatCurrency(dashboardData.totalDebtMinor)}
                  </p>
                  <TrendingDown className="w-4 h-4 text-rose-500 dark:text-rose-400 shrink-0" />
                </div>
              </div>

              {/* B. Total Collected */}
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-[#8eb698] font-medium">
                  <span>{t('totalCollected')}</span>
                  <CircleDollarSign className="w-3.5 h-3.5 text-emerald-600 dark:text-[#7ae09e] shrink-0" />
                </div>
                <p className="text-base sm:text-lg font-bold text-emerald-600 dark:text-[#7ae09e] font-mono tracking-tight">
                  {formatCurrency(dashboardData.totalCollectedMinor)}
                </p>
              </div>

              {/* C. Total Orders */}
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-[#8eb698] font-medium">
                  <span>{t('totalOrders')}</span>
                  <ShoppingBag className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400 shrink-0" />
                </div>
                <p className="text-base sm:text-lg font-bold text-gray-900 dark:text-[#daf1de] tracking-tight">
                  {dashboardData.totalOrdersCount}
                </p>
              </div>

              {/* D. Total Order Value */}
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-[#8eb698] font-medium">
                  <span>{t('totalOrderValue')}</span>
                  <ReceiptText className="w-3.5 h-3.5 text-gray-500 dark:text-[#8eb698] shrink-0" />
                </div>
                <p className="text-base sm:text-lg font-bold text-gray-900 dark:text-[#daf1de] font-mono tracking-tight">
                  {formatCurrency(dashboardData.totalOrdersValueMinor)}
                </p>
              </div>
            </div>
          </section>

          {/* 4. Recent Financial Activity (Direct on page surface, ZERO card boxes) */}
          <section className="space-y-3 pb-5 border-b border-gray-200/80 dark:border-[#14423b]">
            <div className="pb-1">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-[#daf1de]">
                {t('recentFinancialActivity')}
              </h2>
            </div>

            {dashboardData.recentFinancialActivities.length === 0 ? (
              <div className="py-4 text-center text-xs text-gray-500 dark:text-[#8eb698]">
                {t('noRecentTransactions')}
              </div>
            ) : (
              <div className="divide-y divide-gray-200/60 dark:divide-[#14423b]/60">
                {dashboardData.recentFinancialActivities.map((act: UIRecentFinancialActivityItem) => {
                  const isPayment = act.eventType === 'PAYMENT' || act.amountMinor > 0;
                  return (
                    <div
                      key={act.id}
                      className="py-2.5 flex items-center justify-between gap-3 px-0.5 hover:bg-gray-50/50 dark:hover:bg-[#0c312b]/20 rounded-md transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                            isPayment
                              ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400'
                              : 'bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400'
                          }`}
                        >
                          {isPayment ? (
                            <ArrowDownLeft className="w-3.5 h-3.5" />
                          ) : (
                            <ArrowUpRight className="w-3.5 h-3.5" />
                          )}
                        </div>

                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-gray-900 dark:text-[#daf1de] truncate">
                            {act.displayTitle}
                          </p>
                          <p className="text-[11px] text-gray-400 dark:text-[#5e8674] truncate">
                            {act.description} • {formatActivityTime(act.createdAt)}
                          </p>
                        </div>
                      </div>

                      <div className="shrink-0 text-end">
                        <span
                          className={`text-xs font-bold font-mono ${
                            isPayment
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-rose-600 dark:text-rose-400'
                          }`}
                        >
                          {isPayment ? '+' : ''}
                          {formatCurrency(act.amountMinor)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* 5. Quick Access (Direct on page surface, ZERO card boxes) */}
          <section className="space-y-3">
            <div className="pb-1">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-[#daf1de]">
                {t('quickAccessTitle')}
              </h2>
            </div>

            <div className="divide-y divide-gray-200/60 dark:divide-[#14423b]/60">
              {/* Days */}
              <button
                type="button"
                onClick={() => navigateTo('/app/days')}
                className="w-full py-2.5 px-0.5 flex items-center justify-between text-start cursor-pointer hover:bg-gray-50/50 dark:hover:bg-[#0c312b]/30 rounded-md transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-gray-100 dark:bg-[#0c312b] text-gray-700 dark:text-[#daf1de]">
                    <Layers className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="text-xs font-semibold text-gray-900 dark:text-[#daf1de] block">
                      {t('navDaysOrders')}
                    </span>
                    <span className="text-[11px] text-gray-500 dark:text-[#8eb698]">
                      {locale === 'en'
                        ? 'All business days and full order records'
                        : 'سجل جميع أيام العمل والطلبات الكاملة'}
                    </span>
                  </div>
                </div>
                <div className="text-gray-400 group-hover:text-emerald-600 dark:group-hover:text-[#daf1de] transition-colors">
                  {isRTL ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </div>
              </button>

              {/* Customers */}
              <button
                type="button"
                onClick={() => navigateTo('/app/customers')}
                className="w-full py-2.5 px-0.5 flex items-center justify-between text-start cursor-pointer hover:bg-gray-50/50 dark:hover:bg-[#0c312b]/30 rounded-md transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-gray-100 dark:bg-[#0c312b] text-gray-700 dark:text-[#daf1de]">
                    <Users className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="text-xs font-semibold text-gray-900 dark:text-[#daf1de] block">
                      {t('navCustomers')}
                    </span>
                    <span className="text-[11px] text-gray-500 dark:text-[#8eb698]">
                      {locale === 'en'
                        ? 'Customer accounts, balances and QR cards'
                        : 'سجل العملاء، الأرصدة، وبطاقات QR'}
                    </span>
                  </div>
                </div>
                <div className="text-gray-400 group-hover:text-emerald-600 dark:group-hover:text-[#daf1de] transition-colors">
                  {isRTL ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </div>
              </button>

              {/* Financials */}
              <button
                type="button"
                onClick={() => navigateTo('/app/financials')}
                className="w-full py-2.5 px-0.5 flex items-center justify-between text-start cursor-pointer hover:bg-gray-50/50 dark:hover:bg-[#0c312b]/30 rounded-md transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-gray-100 dark:bg-[#0c312b] text-gray-700 dark:text-[#daf1de]">
                    <Wallet className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="text-xs font-semibold text-gray-900 dark:text-[#daf1de] block">
                      {t('navFinancials')}
                    </span>
                    <span className="text-[11px] text-gray-500 dark:text-[#8eb698]">
                      {locale === 'en'
                        ? 'Revenue reports and overall debt ledgers'
                        : 'التقارير المالية وحركات الديون الشاملة'}
                    </span>
                  </div>
                </div>
                <div className="text-gray-400 group-hover:text-emerald-600 dark:group-hover:text-[#daf1de] transition-colors">
                  {isRTL ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </div>
              </button>

              {/* Settings */}
              <button
                type="button"
                onClick={() => navigateTo('/app/settings')}
                className="w-full py-2.5 px-0.5 flex items-center justify-between text-start cursor-pointer hover:bg-gray-50/50 dark:hover:bg-[#0c312b]/30 rounded-md transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-gray-100 dark:bg-[#0c312b] text-gray-700 dark:text-[#daf1de]">
                    <Settings className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="text-xs font-semibold text-gray-900 dark:text-[#daf1de] block">
                      {t('navSettings')}
                    </span>
                    <span className="text-[11px] text-gray-500 dark:text-[#8eb698]">
                      {locale === 'en'
                        ? 'App theme, language, and QR design settings'
                        : 'إعدادات المظهر، اللغة، وتصميم QR'}
                    </span>
                  </div>
                </div>
                <div className="text-gray-400 group-hover:text-emerald-600 dark:group-hover:text-[#daf1de] transition-colors">
                  {isRTL ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </div>
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
};
