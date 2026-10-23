import React, { useState, useEffect } from 'react';
import { useI18n } from '../../i18n/i18nContext';
import {
  getFinancialsOverviewData,
  searchFinancialCustomers,
  UIFinancialsOverviewData,
  UIFinancialCustomerItem,
  useStoreSubscription,
} from './dayOrdersStore';
import {
  Search,
  Users,
  Banknote,
  ChevronLeft,
  ChevronRight,
  User,
} from 'lucide-react';

export interface FinancialsPageProps {
  onNavigate?: (path: string) => void;
}

export const FinancialsPage: React.FC<FinancialsPageProps> = ({ onNavigate }) => {
  const { t, isRTL, formatCurrency } = useI18n();
  const storeVersion = useStoreSubscription(['financialLedger', 'payments', 'paymentAllocations', 'customers']);
  const [data, setData] = useState<UIFinancialsOverviewData | null>(null);
  const [loading, setLoading] = useState(true);

  // Targeted customer search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UIFinancialCustomerItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    let isMounted = true;
    getFinancialsOverviewData()
      .then((res) => {
        if (isMounted) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        console.error('Failed to load financials overview:', err);
        if (isMounted) setLoading(false);
      });
    return () => {
      isMounted = false;
    };
  }, [storeVersion]);

  // Handle direct customer search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const timer = setTimeout(() => {
      searchFinancialCustomers(searchQuery)
        .then((res) => {
          setSearchResults(res);
          setIsSearching(false);
        })
        .catch((err) => {
          console.error('Search failed:', err);
          setIsSearching(false);
        });
    }, 150);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const navigateTo = (path: string) => {
    if (onNavigate) {
      onNavigate(path);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-20 px-4 sm:px-6 text-gray-900 dark:text-[#daf1de]">
      {/* 1. Header Bar: Content-first, Clean */}
      <div className="border-b border-gray-200 dark:border-[#14423b] pb-4">
        <h1 className="text-xl font-bold text-gray-900 dark:text-[#daf1de] tracking-tight">
          {t('navFinancials')}
        </h1>
        <p className="text-xs text-gray-500 dark:text-[#8eb698] mt-0.5">
          {t('financialsSubtitle')}
        </p>
        <button
          type="button"
          onClick={() => navigateTo('/app/financials/payments')}
          className="mt-4 inline-flex items-center gap-2 border-b border-emerald-600 pb-2 text-xs font-bold text-emerald-800 transition-colors hover:text-emerald-600 dark:border-emerald-400 dark:text-emerald-300"
        >
          <Banknote className="h-4 w-4" />
          <span>{isRTL ? 'دفعات الزبائن المعلّقة ومراجعتها' : 'Pending customer payments and review'}</span>
        </button>
      </div>

      {loading ? (
        /* Loading Skeleton */
        <div className="space-y-4 animate-pulse">
          <div className="h-44 bg-gray-100 dark:bg-[#082622] rounded-xl border border-gray-200 dark:border-[#14423b]" />
          <div className="h-28 bg-gray-100 dark:bg-[#082622] rounded-xl border border-gray-200 dark:border-[#14423b]" />
        </div>
      ) : !data ? (
        <div className="bg-white dark:bg-[#082622] rounded-xl border border-gray-200 dark:border-[#14423b] p-8 text-center text-xs text-gray-500">
          {t('errorOccurred')}
        </div>
      ) : (
        <>
          {/* 2. Flat Financial Summary Section (List-first, subtle dividers, NO nested cards) */}
          <section className="bg-white dark:bg-[#082622] rounded-xl border border-gray-200 dark:border-[#14423b] p-4 sm:p-5 space-y-2 transition-colors">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-[#daf1de] border-b border-gray-100 dark:border-[#123d37] pb-3">
              {t('financialSummaryTitle')}
            </h2>

            <div className="divide-y divide-gray-100 dark:divide-[#123d37] pt-1">
              {/* Row 1: Total Customer Debt */}
              <div className="py-2.5 px-1 flex items-center justify-between text-xs">
                <span className="text-gray-700 dark:text-[#daf1de]">
                  {t('totalCustomerDebt')}
                </span>
                <span className="font-mono font-bold text-rose-600 dark:text-rose-400">
                  {formatCurrency(data.totalDebtMinor)}
                </span>
              </div>

              {/* Row 2: Total Collected */}
              <div className="py-2.5 px-1 flex items-center justify-between text-xs">
                <span className="text-gray-700 dark:text-[#daf1de]">
                  {t('totalCollected')}
                </span>
                <span className="font-mono font-bold text-emerald-600 dark:text-[#8eb698]">
                  {formatCurrency(data.totalCollectedMinor)}
                </span>
              </div>

              {/* Row 3: Total Orders */}
              <div className="py-2.5 px-1 flex items-center justify-between text-xs">
                <span className="text-gray-700 dark:text-[#daf1de]">
                  {t('totalOrders')}
                </span>
                <span className="font-mono font-bold text-gray-900 dark:text-[#daf1de]">
                  {data.totalOrdersValueMinor > 0 ? (
                    // show total orders count accurately from store
                    // we can display total orders value alongside
                    `${t('orderTotal')}`
                  ) : (
                    '0'
                  )}
                </span>
              </div>

              {/* Row 4: Total Order Value */}
              <div className="py-2.5 px-1 flex items-center justify-between text-xs">
                <span className="text-gray-700 dark:text-[#daf1de]">
                  {t('totalOrderValue')}
                </span>
                <span className="font-mono font-bold text-gray-900 dark:text-[#daf1de]">
                  {formatCurrency(data.totalOrdersValueMinor)}
                </span>
              </div>
            </div>
          </section>

          {/* 3. Customer Balances & Search Section */}
          <section className="bg-white dark:bg-[#082622] rounded-xl border border-gray-200 dark:border-[#14423b] p-4 sm:p-5 space-y-4 transition-colors">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-[#daf1de] border-b border-gray-100 dark:border-[#123d37] pb-3">
              {t('customerBalancesTitle')}
            </h2>

            {/* Targeted Search Input */}
            <div className="relative">
              <Search
                className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-[#5e8674] ${
                  isRTL ? 'right-3' : 'left-3'
                }`}
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('searchFinancialCustomerPlaceholder')}
                className={`w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 text-gray-900 dark:text-[#daf1de] placeholder-gray-400 dark:placeholder-[#5e8674] focus:outline-none focus:ring-1 focus:ring-emerald-500 ${
                  isRTL ? 'pr-9 pl-3' : 'pl-9 pr-3'
                }`}
              />
            </div>

            {/* Direct Search Results (Shown only when searching) */}
            {searchQuery.trim() !== '' && (
              <div className="space-y-1">
                <span className="text-[11px] font-bold uppercase tracking-wider text-gray-400 dark:text-[#5e8674] block px-1">
                  {t('directSearchResults')}
                </span>

                {isSearching ? (
                  <div className="py-4 text-center text-xs text-gray-400 animate-pulse">
                    ...
                  </div>
                ) : searchResults.length === 0 ? (
                  <div className="py-4 text-center text-xs text-gray-500 dark:text-[#8eb698]">
                    {t('noCustomersFound')}
                  </div>
                ) : (
                  <div className="divide-y divide-gray-100 dark:divide-[#123d37]">
                    {searchResults.map((cust) => {
                      const isDebt = cust.currentBalanceMinor < 0;
                      const isCredit = cust.currentBalanceMinor > 0;
                      return (
                        <div
                          key={cust.id}
                          onClick={() => navigateTo(`/app/financials/customers/${cust.id}`)}
                          className="py-2.5 px-1.5 flex items-center justify-between gap-3 hover:bg-gray-50/70 dark:hover:bg-[#0c312b]/50 rounded-lg transition-colors cursor-pointer group"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className="w-7 h-7 rounded-full bg-gray-100 dark:bg-[#06201c] flex items-center justify-center text-gray-600 dark:text-[#8eb698] shrink-0">
                              <User className="w-3.5 h-3.5" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-gray-900 dark:text-[#daf1de] truncate group-hover:text-emerald-700 dark:group-hover:text-[#daf1de]">
                                {cust.name}
                              </p>
                              <p className="text-[11px] text-gray-400 dark:text-[#5e8674] font-mono">
                                {cust.code}
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center gap-2.5 shrink-0">
                            <span
                              className={`text-xs font-bold font-mono ${
                                isDebt
                                  ? 'text-rose-600 dark:text-rose-400'
                                  : isCredit
                                  ? 'text-emerald-600 dark:text-[#8eb698]'
                                  : 'text-gray-500 dark:text-[#5e8674]'
                              }`}
                            >
                              {isCredit ? '+' : ''}
                              {formatCurrency(cust.currentBalanceMinor)}
                            </span>
                            <div className="text-gray-400 group-hover:text-emerald-600 dark:group-hover:text-[#daf1de]">
                              {isRTL ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* "عرض جميع العملاء" (MUST BE THE LAST OPTION) */}
            <div className="pt-2 border-t border-gray-100 dark:border-[#123d37]">
              <button
                type="button"
                onClick={() => navigateTo('/app/financials/customers')}
                className="w-full py-2.5 px-2 flex items-center justify-between text-start cursor-pointer hover:bg-gray-50/70 dark:hover:bg-[#0c312b]/50 rounded-lg transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-[#8eb698] border border-emerald-200/50 dark:border-emerald-800/40">
                    <Users className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="text-xs font-semibold text-gray-900 dark:text-[#daf1de] block group-hover:text-emerald-700 dark:group-hover:text-[#daf1de]">
                      {t('viewAllFinancialCustomers')}
                    </span>
                    <span className="text-[11px] text-gray-500 dark:text-[#8eb698]">
                      {t('viewAllFinancialCustomersDesc')}
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
