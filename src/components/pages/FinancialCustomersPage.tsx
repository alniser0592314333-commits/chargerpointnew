import React, { useState, useEffect } from 'react';
import { useI18n } from '../../i18n/i18nContext';
import {
  getFinancialCustomersByFilter,
  searchFinancialCustomers,
  UIFinancialCustomerItem,
} from './dayOrdersStore';
import { Search, ChevronLeft, ChevronRight, User, Users, TrendingUp, TrendingDown, Filter } from 'lucide-react';

export interface FinancialCustomersPageProps {
  onSelectCustomer: (customerId: string) => void;
}

export const FinancialCustomersPage: React.FC<FinancialCustomersPageProps> = ({
  onSelectCustomer,
}) => {
  const { t, isRTL, formatCurrency } = useI18n();
  const [activeFilter, setActiveFilter] = useState<'all' | 'credit' | 'debt' | null>(null);
  const [customers, setCustomers] = useState<UIFinancialCustomerItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);

  // Fetch when filter is clicked
  const handleSelectFilter = (filter: 'all' | 'credit' | 'debt') => {
    setActiveFilter(filter);
    setLoading(true);
    getFinancialCustomersByFilter(filter, 25)
      .then((res) => {
        setCustomers(res);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load financial customers by filter:', err);
        setLoading(false);
      });
  };

  // Direct Search Effect
  useEffect(() => {
    if (!searchQuery.trim()) {
      if (activeFilter) {
        handleSelectFilter(activeFilter);
      } else {
        setCustomers([]);
      }
      return;
    }

    setLoading(true);
    const timer = setTimeout(() => {
      searchFinancialCustomers(searchQuery)
        .then((res) => {
          setCustomers(res);
          setLoading(false);
        })
        .catch((err) => {
          console.error('Search failed:', err);
          setLoading(false);
        });
    }, 150);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  return (
    <div className="max-w-3xl mx-auto space-y-5 pb-20 px-4 sm:px-6 text-gray-900 dark:text-[#daf1de]">
      {/* 1. Header Bar: Content-first */}
      <div className="border-b border-gray-200 dark:border-[#14423b] pb-4">
        <h1 className="text-xl font-bold text-gray-900 dark:text-[#daf1de] tracking-tight">
          {t('customerBalancesTitle')}
        </h1>
        <p className="text-xs text-gray-500 dark:text-[#8eb698] mt-0.5">
          {t('customerBalancesSubtitle')}
        </p>
      </div>

      {/* 2. Three Primary Action Buttons (NO initial customer list fetch) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        {/* Button 1: All Customers */}
        <button
          type="button"
          onClick={() => handleSelectFilter('all')}
          className={`py-3 px-3.5 rounded-xl border text-xs font-semibold flex items-center justify-between transition-all cursor-pointer ${
            activeFilter === 'all'
              ? 'bg-emerald-50 dark:bg-[#0c312b] border-emerald-500 text-emerald-800 dark:text-[#daf1de] ring-1 ring-emerald-500 shadow-sm'
              : 'bg-white dark:bg-[#082622] border-gray-200 dark:border-[#14423b] text-gray-700 dark:text-[#daf1de] hover:bg-gray-50 dark:hover:bg-[#0c312b]/60'
          }`}
        >
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />
            <span>{t('financialsFilterAll')}</span>
          </div>
        </button>

        {/* Button 2: Customers with Credit (> 0) */}
        <button
          type="button"
          onClick={() => handleSelectFilter('credit')}
          className={`py-3 px-3.5 rounded-xl border text-xs font-semibold flex items-center justify-between transition-all cursor-pointer ${
            activeFilter === 'credit'
              ? 'bg-emerald-50 dark:bg-[#0c312b] border-emerald-500 text-emerald-800 dark:text-[#daf1de] ring-1 ring-emerald-500 shadow-sm'
              : 'bg-white dark:bg-[#082622] border-gray-200 dark:border-[#14423b] text-gray-700 dark:text-[#daf1de] hover:bg-gray-50 dark:hover:bg-[#0c312b]/60'
          }`}
        >
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />
            <span>{t('financialsFilterCredit')}</span>
          </div>
        </button>

        {/* Button 3: Customers with Debt (< 0) */}
        <button
          type="button"
          onClick={() => handleSelectFilter('debt')}
          className={`py-3 px-3.5 rounded-xl border text-xs font-semibold flex items-center justify-between transition-all cursor-pointer ${
            activeFilter === 'debt'
              ? 'bg-rose-50 dark:bg-[#310c14] border-rose-500 text-rose-800 dark:text-rose-200 ring-1 ring-rose-500 shadow-sm'
              : 'bg-white dark:bg-[#082622] border-gray-200 dark:border-[#14423b] text-gray-700 dark:text-[#daf1de] hover:bg-gray-50 dark:hover:bg-[#0c312b]/60'
          }`}
        >
          <div className="flex items-center gap-2">
            <TrendingDown className="w-4 h-4 text-rose-500 dark:text-rose-400" />
            <span>{t('financialsFilterDebt')}</span>
          </div>
        </button>
      </div>

      {/* 3. Search Input */}
      <div className="relative">
        <Search className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-[#5e8674] ${isRTL ? 'right-3' : 'left-3'}`} />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('searchFinancialCustomerPlaceholder')}
          className={`w-full text-xs bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 text-gray-900 dark:text-[#daf1de] placeholder-gray-400 dark:placeholder-[#5e8674] focus:outline-none focus:ring-1 focus:ring-emerald-500 ${
            isRTL ? 'pr-9 pl-3' : 'pl-9 pr-3'
          }`}
        />
      </div>

      {/* 4. Customer List Area (Lazy Loaded) */}
      <section className="bg-white dark:bg-[#082622] rounded-xl border border-gray-200 dark:border-[#14423b] p-4 sm:p-5 transition-colors">
        {loading ? (
          <div className="space-y-3 animate-pulse py-2">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-10 bg-gray-100 dark:bg-[#06201c] rounded-lg" />
            ))}
          </div>
        ) : !activeFilter && !searchQuery.trim() ? (
          /* Landing Prompt State before selection */
          <div className="py-10 text-center space-y-2">
            <div className="w-10 h-10 mx-auto rounded-full bg-emerald-50 dark:bg-[#06201c] flex items-center justify-center text-emerald-600 dark:text-[#8eb698]">
              <Filter className="w-5 h-5" />
            </div>
            <p className="text-xs text-gray-500 dark:text-[#8eb698] max-w-sm mx-auto">
              {t('financialsSelectPrompt')}
            </p>
          </div>
        ) : customers.length === 0 ? (
          <div className="py-8 text-center text-xs text-gray-500 dark:text-[#8eb698]">
            {t('noCustomersFound')}
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-[#123d37]">
            {customers.map((cust) => {
              const isDebt = cust.currentBalanceMinor < 0;
              const isCredit = cust.currentBalanceMinor > 0;

              return (
                <div
                  key={cust.id}
                  onClick={() => onSelectCustomer(cust.id)}
                  className="py-3 px-1.5 flex items-center justify-between gap-3 hover:bg-gray-50/60 dark:hover:bg-[#0c312b]/40 rounded-lg transition-colors cursor-pointer group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-[#06201c] flex items-center justify-center text-gray-600 dark:text-[#8eb698] shrink-0">
                      <User className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-gray-900 dark:text-[#daf1de] truncate group-hover:text-emerald-700 dark:group-hover:text-[#daf1de] transition-colors">
                        {cust.name}
                      </p>
                      <p className="text-[11px] text-gray-400 dark:text-[#5e8674] font-mono truncate">
                        {cust.code}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
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
                    <div className="text-gray-400 group-hover:text-emerald-600 dark:group-hover:text-[#daf1de] transition-colors">
                      {isRTL ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
