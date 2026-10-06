import React, { useState, useEffect } from 'react';
import { Button } from '../ui/Button';
import { Search, Plus, X, ChevronLeft, ChevronRight, User, ShoppingBag } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import {
  searchCustomersAndOrders,
  addNewCustomer,
  UICustomerListItem,
  UIOrderSearchResult,
  useStoreSubscription,
} from './dayOrdersStore';
import { authService, UserSession } from '../../services/auth/authService';

export interface CustomersPageProps {
  onSelectCustomer?: (customerId: string) => void;
  onSelectOrder?: (dayId: string, orderId: string) => void;
  onAddCustomer?: () => void;
}

export const CustomersPage: React.FC<CustomersPageProps> = ({
  onSelectCustomer,
  onSelectOrder,
  onAddCustomer,
}) => {
  const { locale, isRTL, t, formatDate, formatCurrency } = useI18n();
  const storeVersion = useStoreSubscription(['customers', 'financialLedger', 'payments']);

  const [session, setSession] = useState<UserSession | null>(null);
  useEffect(() => {
    let isMounted = true;
    authService.getCurrentSession().then((s) => {
      if (isMounted) setSession(s);
    });
    return () => {
      isMounted = false;
    };
  }, []);

  const isSuperAdmin = session?.role === "SUPER_ADMIN";
  const hasPermission = (perm: string) => {
    return isSuperAdmin || (session?.permissions?.includes(perm as any) ?? false);
  };

  // Search and Results State
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [customers, setCustomers] = useState<UICustomerListItem[]>([]);
  const [orders, setOrders] = useState<UIOrderSearchResult[]>([]);
  const [isOrderSearch, setIsOrderSearch] = useState(false);
  const [totalStoreCount, setTotalStoreCount] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(true);

  // Add Customer Modal State
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [addErrorMessage, setAddErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Debounce search input (300ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Load results with stale-request protection (unbounded full list access)
  useEffect(() => {
    let isCurrent = true;
    setIsLoading(true);

    searchCustomersAndOrders(debouncedQuery)
      .then((res) => {
        if (isCurrent) {
          setCustomers(res.customers);
          setOrders(res.orders);
          setIsOrderSearch(res.isOrderSearch);
          setTotalStoreCount(res.totalStoreCustomersCount ?? res.customers.length);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (isCurrent) {
          console.error('Failed to load customers or orders:', err);
          setIsLoading(false);
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [debouncedQuery, storeVersion]);

  const handleClearSearch = () => {
    setSearchQuery('');
    setDebouncedQuery('');
  };

  const handleOpenAddModal = () => {
    if (onAddCustomer) {
      onAddCustomer();
    } else {
      setNewCustomerName('');
      setNewCustomerPhone('');
      setAddErrorMessage('');
      setIsAddModalOpen(true);
    }
  };

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCustomerName.trim()) {
      setAddErrorMessage(t('customerNameRequired'));
      return;
    }

    setIsSubmitting(true);
    setAddErrorMessage('');
    try {
      await addNewCustomer(newCustomerName.trim(), newCustomerPhone.trim());
      setIsAddModalOpen(false);
      setNewCustomerName('');
      setNewCustomerPhone('');
      // Reload current search query
      const updated = await searchCustomersAndOrders(debouncedQuery);
      setCustomers(updated.customers);
      setOrders(updated.orders);
      setIsOrderSearch(updated.isOrderSearch);
      setTotalStoreCount(updated.totalStoreCustomersCount ?? updated.customers.length);
    } catch (err: any) {
      setAddErrorMessage(err?.message || t('errorOccurred'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOrderClick = (ord: UIOrderSearchResult) => {
    if (onSelectOrder) {
      onSelectOrder(ord.dayId, ord.orderId);
    } else {
      window.location.hash = `order-card-${ord.orderId}`;
      window.history.pushState(
        { path: `/app/days/${ord.dayId}#order-card-${ord.orderId}` },
        '',
        `/app/days/${ord.dayId}#order-card-${ord.orderId}`
      );
      window.dispatchEvent(new Event('popstate'));
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 px-4 py-4 sm:px-6">
      {/* 1. Header Section: Title & Add Customer Button */}
      <div className="flex flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-gray-900 dark:text-[#daf1de]">
            {t('customersTitle')}
          </h1>
          {totalStoreCount > 0 && (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 dark:bg-[#0c312b] text-emerald-700 dark:text-[#8eb698] border border-emerald-200 dark:border-[#14423b]">
              {totalStoreCount} {locale === 'ar' ? 'عميل' : 'customers'}
            </span>
          )}
        </div>
        {hasPermission('customers:create') && (
          <Button
            variant="primary"
            size="sm"
            onClick={handleOpenAddModal}
            className="shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>{t('addCustomer')}</span>
          </Button>
        )}
      </div>

      {/* 2. Directly Underneath: Search Input (Direction-Aware & Theme Token Compliant) */}
      <div className="space-y-1.5">
        <div className="relative">
          <div className="absolute inset-y-0 start-0 flex items-center ps-3 pointer-events-none text-gray-400 dark:text-[#5e8674]">
            <Search className="w-4 h-4" />
          </div>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('searchCustomerPlaceholder')}
            className="w-full ps-9 pe-9 py-2.5 text-sm bg-white dark:bg-[#061f1c] border border-gray-200 dark:border-[#14423b] rounded-xl text-gray-900 dark:text-[#daf1de] placeholder-gray-400 dark:placeholder-[#5e8674] focus:outline-none focus:ring-2 focus:ring-[#235347] dark:focus:ring-[#8eb698] transition-colors shadow-2xs"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={handleClearSearch}
              className="absolute inset-y-0 end-0 flex items-center pe-3 text-gray-400 hover:text-gray-600 dark:hover:text-[#daf1de] cursor-pointer"
              aria-label={t('clearSearch')}
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        {searchQuery.trim() && (
          <div className="text-xs text-gray-500 dark:text-[#8eb698] px-1">
            {isOrderSearch
              ? t('orderMatchCount', { count: orders.length })
              : t('customerMatchCount', { count: customers.length })}
          </div>
        )}
      </div>

      {/* 3. Results Container */}
      <div className="bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] rounded-xl overflow-hidden shadow-xs">
        {isLoading ? (
          <div className="py-12 text-center text-sm text-gray-500 dark:text-[#8eb698]">
            {t('loadingCustomers')}
          </div>
        ) : isOrderSearch && orders.length > 0 ? (
          /* =======================================================
             ORDER SEARCH RESULTS (When searching by order number)
             Displays matching orders with each day's date & customer
             ======================================================= */
          <div className="divide-y divide-gray-100 dark:divide-[#0f3b34]">
            {orders.map((ord) => (
              <div
                key={`${ord.dayId}-${ord.orderId}`}
                onClick={() => handleOrderClick(ord)}
                className="group flex items-center justify-between p-3.5 sm:p-4 hover:bg-gray-50 dark:hover:bg-[#0b312b] transition-colors cursor-pointer min-h-[56px]"
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleOrderClick(ord);
                  }
                }}
              >
                {/* Left Side: Order Number, Date & Customer Name */}
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-blue-50 dark:bg-[#0c312b] flex items-center justify-center text-blue-700 dark:text-[#8eb698] shrink-0 border border-blue-100 dark:border-[#14423b]">
                    <ShoppingBag className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-gray-900 dark:text-[#daf1de]">
                        {t('orderResultLabel', { number: ord.orderNumber })}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-[#8eb698]">
                        {formatDate(ord.businessDate)}
                      </span>
                    </div>
                    <p className="text-xs font-medium text-gray-700 dark:text-[#a9d4b4] truncate">
                      {ord.customerName}
                    </p>
                  </div>
                </div>

                {/* Right Side: Total & Chevron */}
                <div className="flex items-center gap-3 shrink-0 ms-2">
                  <span className="text-xs font-semibold text-gray-700 dark:text-[#daf1de]">
                    {formatCurrency(ord.totalMinor)}
                  </span>
                  {isRTL ? (
                    <ChevronLeft className="w-4 h-4 text-gray-400 dark:text-[#5e8674] group-hover:text-gray-600 dark:group-hover:text-[#daf1de] transition-colors" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-gray-400 dark:text-[#5e8674] group-hover:text-gray-600 dark:group-hover:text-[#daf1de] transition-colors" />
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : customers.length > 0 ? (
          /* =======================================================
             CUSTOMER SEARCH RESULTS / DEFAULT CUSTOMER LIST
             Displays up to 6 customer items
             ======================================================= */
          <div className="divide-y divide-gray-100 dark:divide-[#0f3b34]">
            {customers.map((customer) => (
              <div
                key={customer.id}
                onClick={() => onSelectCustomer && onSelectCustomer(customer.id)}
                className="group flex items-center justify-between p-3.5 sm:p-4 hover:bg-gray-50 dark:hover:bg-[#0b312b] transition-colors cursor-pointer min-h-[52px]"
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectCustomer && onSelectCustomer(customer.id);
                  }
                }}
              >
                {/* Left Side: Name, Code & Phone */}
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-gray-100 dark:bg-[#0c312b] flex items-center justify-center text-gray-500 dark:text-[#8eb698] shrink-0 border border-transparent dark:border-[#14423b]">
                    <User className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-gray-900 dark:text-[#daf1de] truncate">
                        {customer.name}
                      </span>
                      <span className="inline-block px-1.5 py-0.5 text-[11px] font-mono text-gray-600 dark:text-[#a9d4b4] bg-gray-100 dark:bg-[#0c312b] border border-transparent dark:border-[#14423b] rounded uppercase shrink-0">
                        {customer.code}
                      </span>
                    </div>
                    {customer.phone && (
                      <p className="text-xs text-gray-500 dark:text-[#8eb698] truncate dir-ltr text-start">
                        {customer.phone}
                      </p>
                    )}
                  </div>
                </div>

                {/* Right Side: Balance & Direction-Aware Chevron */}
                <div className="flex items-center gap-3 shrink-0 ms-2">
                  <div className="text-end">
                    <span className="text-xs text-gray-400 dark:text-[#5e8674] block">
                      {t('currentBalance')}
                    </span>
                    <span
                      className={`text-xs font-semibold ${
                        customer.currentBalanceMinor > 0
                          ? 'text-emerald-600 dark:text-[#4ade80]'
                          : customer.currentBalanceMinor < 0
                          ? 'text-red-600 dark:text-[#f87171]'
                          : 'text-gray-700 dark:text-[#daf1de]'
                      }`}
                    >
                      {formatCurrency(customer.currentBalanceMinor)}
                    </span>
                  </div>

                  {isRTL ? (
                    <ChevronLeft className="w-4 h-4 text-gray-400 dark:text-[#5e8674] group-hover:text-gray-600 dark:group-hover:text-[#daf1de] transition-colors" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-gray-400 dark:text-[#5e8674] group-hover:text-gray-600 dark:group-hover:text-[#daf1de] transition-colors" />
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : searchQuery.trim() ? (
          /* Search Empty State */
          <div className="py-12 px-4 text-center space-y-3">
            <p className="text-sm text-gray-600 dark:text-[#8eb698]">
              {t('noMatchingResults')}
            </p>
            <Button variant="outline" size="sm" onClick={handleClearSearch}>
              {t('clearSearch')}
            </Button>
          </div>
        ) : (
          /* General Empty State */
          <div className="py-12 px-4 text-center space-y-3">
            <p className="text-sm text-gray-600 dark:text-[#8eb698]">
              {t('noCustomersFound')}
            </p>
            <Button variant="primary" size="sm" onClick={handleOpenAddModal}>
              <Plus className="w-4 h-4" />
              <span>{t('addCustomer')}</span>
            </Button>
          </div>
        )}
      </div>

      {/* Add Customer Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white dark:bg-[#0a2f29] border border-gray-200 dark:border-[#174840] rounded-2xl p-6 w-full max-w-md shadow-xl space-y-4">
            <div className="flex items-center justify-between border-b border-gray-100 dark:border-[#14423b] pb-3">
              <h2 className="text-lg font-bold text-gray-900 dark:text-[#daf1de]">
                {t('addNewCustomer')}
              </h2>
              <button
                type="button"
                onClick={() => setIsAddModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-[#daf1de] cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateCustomer} className="space-y-4">
              {addErrorMessage && (
                <div className="p-3 text-xs text-red-600 dark:text-[#e07a7a] bg-red-50 dark:bg-[#360d13] border border-red-200 dark:border-[#421419] rounded-xl">
                  {addErrorMessage}
                </div>
              )}

              <div className="space-y-1">
                <label className="block text-xs font-medium text-gray-700 dark:text-[#8eb698]">
                  {t('customerName')} *
                </label>
                <input
                  type="text"
                  required
                  value={newCustomerName}
                  onChange={(e) => setNewCustomerName(e.target.value)}
                  placeholder={t('enterCustomerName')}
                  className="w-full px-3 py-2 text-sm bg-white dark:bg-[#061f1c] border border-gray-200 dark:border-[#14423b] rounded-xl text-gray-900 dark:text-[#daf1de] placeholder-gray-400 dark:placeholder-[#5e8674] focus:outline-none focus:ring-2 focus:ring-[#235347] dark:focus:ring-[#8eb698]"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-medium text-gray-700 dark:text-[#8eb698]">
                  {t('phoneNumber')}
                </label>
                <input
                  type="tel"
                  value={newCustomerPhone}
                  onChange={(e) => setNewCustomerPhone(e.target.value)}
                  placeholder={t('enterPhoneNumber')}
                  className="w-full px-3 py-2 text-sm bg-white dark:bg-[#061f1c] border border-gray-200 dark:border-[#14423b] rounded-xl text-gray-900 dark:text-[#daf1de] placeholder-gray-400 dark:placeholder-[#5e8674] focus:outline-none focus:ring-2 focus:ring-[#235347] dark:focus:ring-[#8eb698] dir-ltr text-start"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100 dark:border-[#14423b]">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsAddModalOpen(false)}
                >
                  {t('cancel')}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  isLoading={isSubmitting}
                >
                  {t('saveCustomer')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
