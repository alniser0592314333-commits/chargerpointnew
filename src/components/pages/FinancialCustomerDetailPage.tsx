import React, { useState, useEffect, useRef } from 'react';
import { useI18n } from '../../i18n/i18nContext';
import { presentError } from '../../domain/errors';
import {
  getCustomerDetail,
  getCustomerOrders,
  getCustomerFinancialHistory,
  topUpCustomerBalance,
  validateBinFormat,
  getCurrentAdminAuthorizationContext,
  UICustomerDetail,
  UICustomerOrderSummary,
  UICustomerFinancialItem,
} from './dayOrdersStore';
import { Button } from '../ui/Button';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  User,
  Smartphone,
  BatteryCharging,
  FileText,
  CreditCard,
  CheckCircle2,
  Clock,
  AlertCircle,
  X,
  Lock,
  ArrowRight,
  ShieldCheck,
} from 'lucide-react';

export interface FinancialCustomerDetailPageProps {
  customerId: string;
}

export const FinancialCustomerDetailPage: React.FC<FinancialCustomerDetailPageProps> = ({
  customerId,
}) => {
  const { t, locale, isRTL, formatDateTime, formatCurrency } = useI18n();
  const [customer, setCustomer] = useState<UICustomerDetail | null>(null);
  const [financialHistory, setFinancialHistory] = useState<UICustomerFinancialItem[]>([]);
  const [orders, setOrders] = useState<UICustomerOrderSummary[]>([]);
  const [loading, setLoading] = useState(true);

  // Selector between Financial Ledger and Order History
  const [activeView, setActiveView] = useState<'financial' | 'orders'>('financial');
  const [isSelectorOpen, setIsSelectorOpen] = useState(false);

  // Inline expanded item IDs
  const [expandedFinancialId, setExpandedFinancialId] = useState<string | null>(null);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);

  // Top-Up Modal State
  const [isTopUpOpen, setIsTopUpOpen] = useState(false);
  const [topUpStep, setTopUpStep] = useState<1 | 2 | 3>(1); // 1: BIN, 2: Amount, 3: Confirm
  const [binInput, setBinInput] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [topUpError, setTopUpError] = useState('');
  const [isSubmittingTopUp, setIsSubmittingTopUp] = useState(false);
  const idempotencyKeyRef = useRef<string>('');

  const loadData = async () => {
    try {
      // Load Detail
      getCustomerDetail(customerId)
        .then(setCustomer)
        .catch(err => console.error('Failed to load customer detail:', err));

      // Load History
      getCustomerFinancialHistory(customerId, locale as 'ar' | 'en')
        .then(setFinancialHistory)
        .catch(err => console.error('Failed to load financial history:', err));

      // Load Orders
      getCustomerOrders(customerId, locale as 'ar' | 'en')
        .then(setOrders)
        .catch(err => console.error('Failed to load orders:', err));

    } catch (err) {
      console.error('Failed to load financial customer detail:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    loadData();
  }, [customerId, locale]);

  const toggleExpandFinancial = (id: string) => {
    setExpandedFinancialId((prev) => (prev === id ? null : id));
  };

  const toggleExpandOrder = (id: string) => {
    setExpandedOrderId((prev) => (prev === id ? null : id));
  };

  // Open Top-up Modal Flow
  const handleOpenTopUp = () => {
    setIsTopUpOpen(true);
    setTopUpStep(1);
    setBinInput('');
    setAmountInput('');
    setNoteInput('');
    setTopUpError('');
    idempotencyKeyRef.current = crypto.randomUUID();
  };

  // Close Top-up Modal Flow
  const handleCloseTopUp = () => {
    if (isSubmittingTopUp) return;
    setIsTopUpOpen(false);
    setBinInput('');
    setAmountInput('');
    setNoteInput('');
    setTopUpError('');
  };

  // Step 1: Validate BIN (Format UX check + Actual Verification)
  const [isValidatingBin, setIsValidatingBin] = useState(false);

  const handleVerifyBinStep = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isValidatingBin) return;
    setTopUpError('');
    
    const validation = validateBinFormat(binInput, locale as 'ar' | 'en');
    if (!validation.valid) {
      setTopUpError(validation.error || t('invalidBinError'));
      return;
    }

    setIsValidatingBin(true);
    try {
      const auth = getCurrentAdminAuthorizationContext();
      await auth.verifyBin(binInput.trim());
      const isValid = true;

      if (!isValid) {
        setTopUpError(t('invalidBinError') || 'رمز التحقق (BIN) غير صحيح');
        setIsValidatingBin(false);
        return;
      }

      setTopUpStep(2);
    } catch (err) {
      setTopUpError(t('invalidBinError') || 'رمز التحقق (BIN) غير صحيح');
    } finally {
      setIsValidatingBin(false);
    }
  };

  // Step 2: Validate Amount
  const handleAmountStep = (e: React.FormEvent) => {
    e.preventDefault();
    setTopUpError('');
    const num = parseFloat(amountInput);
    if (isNaN(num) || num <= 0) {
      setTopUpError(t('invalidAmountError'));
      return;
    }
    setTopUpStep(3);
  };

  // Step 3: Commit Top-up
  const handleCommitTopUp = async () => {
    if (isSubmittingTopUp || !customer) return;
    setIsSubmittingTopUp(true);
    setTopUpError('');

    const parsedAmount = parseFloat(amountInput);
    const amountMinor = Math.round(parsedAmount * 100);

    try {
      const res = await topUpCustomerBalance({
        customerId: customer.id,
        amountMinor,
        bin: binInput,
        note: noteInput.trim() || undefined,
        idempotencyKey: idempotencyKeyRef.current,
      });

      if (!res.success) {
        setTopUpError(res.error ? presentError(res.error, locale) : 'فشلت عملية الشحن');
        setIsSubmittingTopUp(false);
        return;
      }

      // Refresh in place
      await loadData();
      setIsSubmittingTopUp(false);
      handleCloseTopUp();
    } catch (err) {
      console.error('Commit topup error:', err);
      setTopUpError(presentError(err, locale));
      setIsSubmittingTopUp(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto space-y-5 pb-20 px-4 sm:px-6 animate-pulse">
        <div className="h-32 bg-gray-100 dark:bg-[#082622] rounded-xl border border-gray-200 dark:border-[#14423b]" />
        <div className="h-64 bg-gray-100 dark:bg-[#082622] rounded-xl border border-gray-200 dark:border-[#14423b]" />
      </div>
    );
  }

  if (!customer) {
    return (
      <div className="max-w-3xl mx-auto p-8 text-center text-xs text-gray-500">
        {t('customerNotFound')}
      </div>
    );
  }

  const isDebt = customer.currentBalanceMinor < 0;
  const isCredit = customer.currentBalanceMinor > 0;

  const parsedAmount = parseFloat(amountInput) || 0;
  const topUpMinor = Math.round(parsedAmount * 100);
  const resultingBalanceMinor = customer.currentBalanceMinor + topUpMinor;

  const getPaymentStatusBadge = (status: 'PAID' | 'PARTIAL' | 'UNPAID') => {
    switch (status) {
      case 'PAID':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/40">
            <CheckCircle2 className="w-3 h-3" />
            {t('paymentStatusPaid')}
          </span>
        );
      case 'PARTIAL':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/40">
            <Clock className="w-3 h-3" />
            {t('paymentStatusPartial')}
          </span>
        );
      case 'UNPAID':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 border border-rose-200 dark:border-rose-800/40">
            <AlertCircle className="w-3 h-3" />
            {t('paymentStatusUnpaid')}
          </span>
        );
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-20 px-4 sm:px-6 text-gray-900 dark:text-[#daf1de]">
      {/* 1. Header: Single Profile Surface (Customer Name + ID + Balance + Top-up Button) */}
      <section className="bg-white dark:bg-[#082622] rounded-xl border border-gray-200 dark:border-[#14423b] p-5 sm:p-6 transition-colors">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-gray-100 dark:bg-[#06201c] flex items-center justify-center text-gray-700 dark:text-[#daf1de] shrink-0">
              <User className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg sm:text-xl font-bold text-gray-900 dark:text-[#daf1de] tracking-tight">
                {customer.name}
              </h1>
              <p className="text-xs text-gray-400 dark:text-[#5e8674] font-mono mt-0.5">
                {customer.code}
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between sm:justify-end gap-4 border-t sm:border-t-0 pt-3 sm:pt-0 border-gray-100 dark:border-[#123d37]">
            <div className="text-start sm:text-end">
              <span className="text-xs text-gray-500 dark:text-[#8eb698] block">
                {t('currentBalance')}
              </span>
              <span
                className={`text-xl sm:text-2xl font-bold font-mono tracking-tight ${
                  isDebt
                    ? 'text-rose-600 dark:text-rose-400'
                    : isCredit
                    ? 'text-emerald-600 dark:text-[#8eb698]'
                    : 'text-gray-600 dark:text-[#8eb698]'
                }`}
              >
                {isCredit ? '+' : ''}
                {formatCurrency(customer.currentBalanceMinor)}
              </span>
            </div>

            {/* Button: شحن الرصيد (Opens In-Context Dialog) */}
            <Button
              variant="primary"
              size="sm"
              onClick={handleOpenTopUp}
              className="gap-1.5 text-xs h-9 px-3 shrink-0 font-semibold cursor-pointer"
            >
              <CreditCard className="w-3.5 h-3.5" />
              <span>{t('topUpBalance')}</span>
            </Button>
          </div>
        </div>
      </section>

      {/* 2. Main Section: Selector between Financial Ledger and Order History */}
      <section className="bg-white dark:bg-[#082622] rounded-xl border border-gray-200 dark:border-[#14423b] p-4 sm:p-5 space-y-3 transition-colors">
        {/* Selector Header Bar with Dropdown Arrow */}
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-[#123d37] pb-3">
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsSelectorOpen(!isSelectorOpen)}
              className="flex items-center gap-1.5 text-sm font-bold text-gray-900 dark:text-[#daf1de] hover:text-emerald-600 dark:hover:text-[#8eb698] transition-colors cursor-pointer"
            >
              <span>
                {activeView === 'financial'
                  ? t('financialLedgerView')
                  : t('orderHistoryView')}
              </span>
              <ChevronDown className="w-4 h-4 text-gray-500 dark:text-[#8eb698]" />
            </button>

            {/* Selector Dropdown Menu */}
            {isSelectorOpen && (
              <div className="absolute top-full mt-1.5 start-0 w-44 bg-white dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-lg shadow-lg z-20 py-1 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setActiveView('financial');
                    setIsSelectorOpen(false);
                  }}
                  className={`w-full text-start px-3 py-2 transition-colors ${
                    activeView === 'financial'
                      ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-[#daf1de] font-bold'
                      : 'text-gray-700 dark:text-[#daf1de] hover:bg-gray-50 dark:hover:bg-[#0c312b]'
                  }`}
                >
                  {t('financialLedgerView')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveView('orders');
                    setIsSelectorOpen(false);
                  }}
                  className={`w-full text-start px-3 py-2 transition-colors ${
                    activeView === 'orders'
                      ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-[#daf1de] font-bold'
                      : 'text-gray-700 dark:text-[#daf1de] hover:bg-gray-50 dark:hover:bg-[#0c312b]'
                  }`}
                >
                  {t('orderHistoryView')}
                </button>
              </div>
            )}
          </div>

          <span className="text-xs text-gray-400 dark:text-[#5e8674]">
            {activeView === 'financial'
              ? `${financialHistory.length} ${locale === 'en' ? 'records' : 'حركات'}`
              : `${orders.length} ${locale === 'en' ? 'orders' : 'طلبات'}`}
          </span>
        </div>

        {/* View A: Financial Ledger */}
        {activeView === 'financial' && (
          <div>
            {financialHistory.length === 0 ? (
              <div className="py-8 text-center text-xs text-gray-500 dark:text-[#8eb698]">
                {t('noFinancialHistory')}
              </div>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-[#123d37]">
                {financialHistory.map((item) => {
                  const isExpanded = expandedFinancialId === item.id;
                  const isPositive = item.amountMinor > 0;
                  const isCharge = item.eventType === 'ORDER_ITEM_CHARGE';
                  const isPayment = item.eventType === 'PAYMENT';

                  return (
                    <div key={item.id} className="py-3 px-1 transition-colors">
                      {/* Summary Row */}
                      <div
                        onClick={() => toggleExpandFinancial(item.id)}
                        className="flex items-start justify-between gap-3 cursor-pointer group"
                      >
                        <div className="flex items-start gap-3 min-w-0">
                          <div
                            className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                              isPositive
                                ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-800/40'
                                : 'bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400 border border-rose-200/60 dark:border-rose-800/40'
                            }`}
                          >
                            {isPositive ? (
                              <ArrowDownLeft className="w-3.5 h-3.5" />
                            ) : (
                              <ArrowUpRight className="w-3.5 h-3.5" />
                            )}
                          </div>

                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-gray-900 dark:text-[#daf1de] group-hover:text-emerald-700 dark:group-hover:text-[#daf1de] transition-colors">
                              {item.shortTitle}
                            </p>
                            <p className="text-[11px] text-gray-400 dark:text-[#5e8674] mt-0.5">
                              {formatDateTime(item.createdAt)}
                            </p>
                          </div>
                        </div>

                        <div className="shrink-0 text-end flex items-center gap-2">
                          <div>
                            <p
                              className={`text-xs font-bold font-mono ${
                                item.amountMinor > 0
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : item.amountMinor < 0
                                  ? 'text-rose-600 dark:text-rose-400'
                                  : 'text-gray-600 dark:text-gray-400'
                              }`}
                            >
                              {item.amountMinor > 0 ? '+' : ''}
                              {formatCurrency(item.amountMinor)}
                            </p>
                            <p className="text-[11px] text-gray-400 dark:text-[#5e8674] font-mono mt-0.5">
                              {t('balanceAfterOp')}: {formatCurrency(item.postBalanceMinor)}
                            </p>
                          </div>

                          <div className="text-gray-400 group-hover:text-emerald-600 dark:group-hover:text-[#daf1de] transition-colors pl-1">
                            {isExpanded ? (
                              <ChevronUp className="w-4 h-4" />
                            ) : (
                              <ChevronDown className="w-4 h-4" />
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Inline Expanded Details */}
                      {isExpanded && (
                        <div className="mt-3 pt-3 border-t border-dashed border-gray-100 dark:border-[#14423b] bg-gray-50/50 dark:bg-[#06201c]/60 rounded-lg p-3 space-y-2 text-xs">
                          {isCharge && item.orderItems && item.orderItems.length > 0 && (
                            <div className="space-y-1.5">
                              <span className="text-[11px] font-semibold text-gray-600 dark:text-[#8eb698] block">
                                {locale === 'en' ? 'Historical Order Items:' : 'تفاصيل أجهزة الطلب:'}
                              </span>
                              <div className="space-y-1 pl-2 pr-2">
                                {item.orderItems.map((dev) => (
                                  <div
                                    key={`${item.id}-${dev.id}`}
                                    className="flex items-center justify-between text-[11px] text-gray-700 dark:text-[#daf1de]"
                                  >
                                    <span className="flex items-center gap-1.5">
                                      <Smartphone className="w-3 h-3 text-gray-400" />
                                      <span>{dev.deviceName}</span>
                                      {dev.hasCharger && (
                                        <span className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-0.5">
                                          <BatteryCharging className="w-2.5 h-2.5" />
                                          {t('withCharger')}
                                        </span>
                                      )}
                                    </span>
                                    <span className="font-mono font-medium">
                                      {formatCurrency(dev.priceMinor)}
                                    </span>
                                  </div>
                                ))}
                              </div>

                              {item.orderTotalMinor !== undefined && (
                                <div className="flex items-center justify-between pt-1.5 border-t border-gray-200/60 dark:border-[#14423b]/60 text-xs font-semibold text-gray-900 dark:text-[#daf1de]">
                                  <span>{t('orderTotal')}</span>
                                  <span className="font-mono">
                                    {formatCurrency(item.orderTotalMinor)}
                                  </span>
                                </div>
                              )}
                            </div>
                          )}

                          {isPayment && (
                            <div className="space-y-1">
                              <div className="flex items-center justify-between text-gray-700 dark:text-[#daf1de]">
                                <span className="text-gray-500 dark:text-[#8eb698]">
                                  {locale === 'en' ? 'Payment Received' : 'الدفعة المسددة'}
                                </span>
                                <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                                  +{formatCurrency(item.amountMinor)}
                                </span>
                              </div>
                              {item.note && (
                                <div className="flex items-start gap-1.5 pt-1 text-[11px] text-gray-600 dark:text-[#8eb698]">
                                  <FileText className="w-3 h-3 shrink-0 mt-0.5 text-gray-400" />
                                  <span>{item.note}</span>
                                </div>
                              )}
                            </div>
                          )}

                          {!isCharge && !isPayment && (
                            <div className="text-gray-600 dark:text-[#8eb698] text-[11px]">
                              {item.description}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* View B: Order History */}
        {activeView === 'orders' && (
          <div>
            {orders.length === 0 ? (
              <div className="py-8 text-center text-xs text-gray-500 dark:text-[#8eb698]">
                {t('noCustomerOrders')}
              </div>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-[#123d37]">
                {orders.map((ord) => {
                  const isExpanded = expandedOrderId === ord.id;
                  return (
                    <div key={ord.id} className="py-3 px-1 transition-colors">
                      {/* Order Summary Row */}
                      <div
                        onClick={() => toggleExpandOrder(ord.id)}
                        className="flex items-start justify-between gap-3 cursor-pointer group"
                      >
                        <div className="flex items-start gap-3 min-w-0">
                          <span className="font-mono text-xs font-bold text-gray-500 dark:text-[#8eb698] shrink-0 mt-0.5">
                            #{ord.orderNumber}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-xs font-semibold text-gray-900 dark:text-[#daf1de]">
                                {ord.items.length}{' '}
                                {ord.items.length === 1
                                  ? locale === 'en'
                                    ? 'device'
                                    : 'جهاز'
                                  : locale === 'en'
                                  ? 'devices'
                                  : 'أجهزة'}
                              </p>
                              {getPaymentStatusBadge(ord.paymentStatus)}
                            </div>
                            <p className="text-[11px] text-gray-400 dark:text-[#5e8674] mt-0.5">
                              {formatDateTime(ord.createdAt)}
                            </p>
                          </div>
                        </div>

                        <div className="shrink-0 text-end flex items-center gap-2">
                          <div>
                            <span className="text-xs font-bold font-mono text-gray-900 dark:text-[#daf1de] block">
                              {formatCurrency(ord.totalMinor)}
                            </span>
                          </div>
                          <div className="text-gray-400 group-hover:text-emerald-600 dark:group-hover:text-[#daf1de] transition-colors pl-1">
                            {isExpanded ? (
                              <ChevronUp className="w-4 h-4" />
                            ) : (
                              <ChevronDown className="w-4 h-4" />
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Inline Expanded Order Details */}
                      {isExpanded && (
                        <div className="mt-3 pt-3 border-t border-dashed border-gray-100 dark:border-[#14423b] bg-gray-50/50 dark:bg-[#06201c]/60 rounded-lg p-3 space-y-2 text-xs">
                          <span className="text-[11px] font-semibold text-gray-600 dark:text-[#8eb698] block">
                            {locale === 'en' ? 'Order Devices & Financial Status:' : 'تفاصيل الأجهزة وحالة السداد:'}
                          </span>

                          <div className="space-y-1 pl-2 pr-2">
                            {ord.items.map((dev) => (
                              <div
                                key={dev.id}
                                className="flex items-center justify-between text-[11px] text-gray-700 dark:text-[#daf1de]"
                              >
                                <span className="flex items-center gap-1.5">
                                  <Smartphone className="w-3 h-3 text-gray-400" />
                                  <span>{dev.deviceName}</span>
                                  {dev.hasCharger && (
                                    <span className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-0.5">
                                      <BatteryCharging className="w-2.5 h-2.5" />
                                      {t('withCharger')}
                                    </span>
                                  )}
                                </span>
                                <span className="font-mono font-medium">
                                  {formatCurrency(dev.priceMinor)}
                                </span>
                              </div>
                            ))}
                          </div>

                          <div className="pt-2 border-t border-gray-200/60 dark:border-[#14423b]/60 flex items-center justify-between text-xs font-semibold">
                            <span className="text-gray-700 dark:text-[#daf1de]">{t('orderTotal')}</span>
                            <span className="font-mono text-gray-900 dark:text-[#daf1de]">
                              {formatCurrency(ord.totalMinor)}
                            </span>
                          </div>

                          <div className="flex items-center justify-between text-xs text-gray-600 dark:text-[#8eb698]">
                            <span>{t('paymentStatusLabel')}</span>
                            <div>{getPaymentStatusBadge(ord.paymentStatus)}</div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>

      {/* 3. In-Context Sensitive Top-Up Modal Flow */}
      {isTopUpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-md bg-white dark:bg-[#082622] rounded-2xl border border-gray-200 dark:border-[#14423b] shadow-2xl overflow-hidden text-gray-900 dark:text-[#daf1de]">
            {/* Modal Header */}
            <div className="p-4 sm:p-5 border-b border-gray-100 dark:border-[#123d37] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-[#8eb698] border border-emerald-200/40 dark:border-emerald-800/40">
                  <CreditCard className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">
                    {t('topUpBalance')}
                  </h3>
                  <p className="text-[11px] text-gray-500 dark:text-[#8eb698]">
                    {customer.name} ({customer.code})
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={handleCloseTopUp}
                disabled={isSubmittingTopUp}
                className="p-1 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-[#daf1de] transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Error Banner if any */}
            {topUpError && (
              <div className="mx-4 sm:mx-5 mt-4 p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/50 rounded-xl text-xs text-rose-700 dark:text-rose-400 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{topUpError}</span>
              </div>
            )}

            {/* STEP 1: SENSITIVE OPERATION AUTHORIZATION (BIN) */}
            {topUpStep === 1 && (
              <form onSubmit={handleVerifyBinStep} className="p-4 sm:p-5 space-y-4">
                <div className="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200/70 dark:border-amber-800/40 rounded-xl text-xs space-y-1">
                  <div className="flex items-center gap-1.5 font-bold text-amber-800 dark:text-amber-300">
                    <ShieldCheck className="w-4 h-4" />
                    <span>{t('sensitiveOperation')}</span>
                  </div>
                  <p className="text-amber-700 dark:text-amber-400/90 text-[11px]">
                    {t('enterBinToProceed')}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-700 dark:text-[#8eb698] block">
                    {t('adminPinLabel')} (BIN)
                  </label>
                  <div className="relative">
                    <Lock className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-[#5e8674] ${isRTL ? 'right-3' : 'left-3'}`} />
                    <input
                      type="password"
                      autoFocus
                      value={binInput}
                      onChange={(e) => setBinInput(e.target.value)}
                      placeholder="••••"
                      maxLength={8}
                      className={`w-full text-center tracking-widest font-mono text-sm bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 text-gray-900 dark:text-[#daf1de] placeholder-gray-400 dark:placeholder-[#5e8674] focus:outline-none focus:ring-1 focus:ring-emerald-500`}
                    />
                  </div>
                </div>

                <div className="pt-2 flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleCloseTopUp}
                    className="text-xs"
                  >
                    {t('cancelAction')}
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    disabled={isValidatingBin}
                    isLoading={isValidatingBin}
                    className="gap-1.5 text-xs font-semibold"
                  >
                    <span>{t('nextStep')}</span>
                    {isRTL ? <ArrowRight className="w-3.5 h-3.5 rotate-180" /> : <ArrowRight className="w-3.5 h-3.5" />}
                  </Button>
                </div>
              </form>
            )}

            {/* STEP 2: TOP-UP AMOUNT */}
            {topUpStep === 2 && (
              <form onSubmit={handleAmountStep} className="p-4 sm:p-5 space-y-4">
                {/* Customer Context Summary */}
                <div className="p-3 bg-gray-50 dark:bg-[#06201c] border border-gray-200/70 dark:border-[#14423b]/70 rounded-xl space-y-1.5 text-xs">
                  <div className="flex justify-between items-center text-gray-500 dark:text-[#8eb698]">
                    <span>{customer.name}</span>
                    <span className="font-mono">{customer.code}</span>
                  </div>
                  <div className="flex justify-between items-center font-semibold pt-1 border-t border-gray-200/50 dark:border-[#14423b]/50">
                    <span>{t('currentBalance')}:</span>
                    <span
                      className={`font-mono font-bold ${
                        isDebt
                          ? 'text-rose-600 dark:text-rose-400'
                          : isCredit
                          ? 'text-emerald-600 dark:text-[#8eb698]'
                          : 'text-gray-600'
                      }`}
                    >
                      {formatCurrency(customer.currentBalanceMinor)}
                    </span>
                  </div>
                </div>

                {/* Amount Input */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-700 dark:text-[#8eb698] block">
                    {t('topUpAmount')} (₪)
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    min="1"
                    autoFocus
                    value={amountInput}
                    onChange={(e) => setAmountInput(e.target.value)}
                    placeholder="0.00"
                    className="w-full text-lg font-mono font-bold text-center bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 text-emerald-600 dark:text-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                {/* Note Input */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-700 dark:text-[#8eb698] block">
                    {t('topUpNoteOptional')}
                  </label>
                  <input
                    type="text"
                    value={noteInput}
                    onChange={(e) => setNoteInput(e.target.value)}
                    placeholder={locale === 'en' ? 'Cash payment, transfer...' : 'دفعة نقدية، حوالة...'}
                    className="w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 px-3 text-gray-900 dark:text-[#daf1de] placeholder-gray-400 dark:placeholder-[#5e8674] focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                <div className="pt-2 flex items-center justify-between gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setTopUpStep(1)}
                    className="text-xs"
                  >
                    {t('previousStep')}
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    className="gap-1.5 text-xs font-semibold"
                  >
                    <span>{t('nextStep')}</span>
                    {isRTL ? <ArrowRight className="w-3.5 h-3.5 rotate-180" /> : <ArrowRight className="w-3.5 h-3.5" />}
                  </Button>
                </div>
              </form>
            )}

            {/* STEP 3: CONFIRMATION & RESULTING BALANCE */}
            {topUpStep === 3 && (
              <div className="p-4 sm:p-5 space-y-4">
                <div className="text-center space-y-1">
                  <h4 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">
                    {t('confirmTopUp')}
                  </h4>
                  <p className="text-xs text-gray-500 dark:text-[#8eb698]">
                    {customer.name} • {customer.code}
                  </p>
                </div>

                {/* Mathematical Resulting Balance Breakdown */}
                <div className="p-3.5 bg-gray-50 dark:bg-[#06201c] border border-gray-200/70 dark:border-[#14423b]/70 rounded-xl space-y-2 text-xs">
                  <div className="flex justify-between items-center text-gray-600 dark:text-[#8eb698]">
                    <span>{t('currentBalance')}:</span>
                    <span className="font-mono font-bold">
                      {formatCurrency(customer.currentBalanceMinor)}
                    </span>
                  </div>

                  <div className="flex justify-between items-center text-emerald-600 dark:text-emerald-400 font-bold">
                    <span>{t('topUpAmount')}:</span>
                    <span className="font-mono">
                      +{formatCurrency(topUpMinor)}
                    </span>
                  </div>

                  {noteInput && (
                    <div className="flex justify-between items-center text-gray-500 dark:text-[#5e8674] text-[11px] pt-1 border-t border-gray-200/40 dark:border-[#14423b]/40">
                      <span>{t('topUpNoteOptional')}:</span>
                      <span>{noteInput}</span>
                    </div>
                  )}

                  <div className="flex justify-between items-center text-sm font-bold pt-2 border-t border-gray-200 dark:border-[#14423b]">
                    <span>{t('resultingBalance')}:</span>
                    <span
                      className={`font-mono text-base ${
                        resultingBalanceMinor < 0
                          ? 'text-rose-600 dark:text-rose-400'
                          : resultingBalanceMinor > 0
                          ? 'text-emerald-600 dark:text-[#8eb698]'
                          : 'text-gray-900 dark:text-[#daf1de]'
                      }`}
                    >
                      {resultingBalanceMinor > 0 ? '+' : ''}
                      {formatCurrency(resultingBalanceMinor)}
                    </span>
                  </div>
                </div>

                <div className="pt-2 flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isSubmittingTopUp}
                    onClick={() => setTopUpStep(2)}
                    className="text-xs"
                  >
                    {t('previousStep')}
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    disabled={isSubmittingTopUp}
                    onClick={handleCommitTopUp}
                    className="gap-1.5 text-xs font-semibold px-4 cursor-pointer"
                  >
                    {isSubmittingTopUp ? (
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <>
                        <CheckCircle2 className="w-4 h-4" />
                        <span>{t('confirmAndApply')}</span>
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
