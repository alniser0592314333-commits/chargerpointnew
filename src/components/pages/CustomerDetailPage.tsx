import React, { useState, useEffect, useRef } from 'react';
import { useI18n } from '../../i18n/i18nContext';
import {
  getCustomerDetail,
  getCustomerOrders,
  getCustomerFinancialHistory,
  updateCustomer,
  topUpCustomerBalance,
  updateCustomerChargerFeeExemptionWithPhase5,
  validateBinFormat,
  getAuthoritativeBinVerifier,
  UICustomerDetail,
  UICustomerOrderSummary,
  UICustomerFinancialItem,
  useStoreSubscription,
} from './dayOrdersStore';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { sendSmsUsingSystemDefaultSim } from '../../services/nativeSms';
import { authService, UserSession } from '../../services/auth/authService';
import {
  ChevronDown,
  ChevronUp,
  Phone,
  ShoppingBag,
  QrCode,
  X,
  AlertTriangle,
  Calendar,
  Receipt,
  CreditCard,
  ShieldCheck,
  CheckCircle2,
  Lock,
  ArrowRight,
  AlertCircle,
  Power,
} from 'lucide-react';

export interface CustomerDetailPageProps {
  customerId: string;
  onNavigateToQr?: (customerId: string) => void;
}

export const CustomerDetailPage: React.FC<CustomerDetailPageProps> = ({
  customerId,
  onNavigateToQr,
}) => {
  const { locale, t, formatDate, formatDateTime, formatCurrency } = useI18n();
  const { showToast } = useToast();

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

  const isSuperAdmin = session?.role === 'SUPER_ADMIN';
  const hasPermission = (perm: string) => {
    return isSuperAdmin || (session?.permissions?.includes(perm as any) ?? false);
  };
  const [customer, setCustomer] = useState<UICustomerDetail | null>(null);
  const [orders, setOrders] = useState<UICustomerOrderSummary[]>([]);
  const [financialHistory, setFinancialHistory] = useState<UICustomerFinancialItem[]>([]);
    const [isOrdersLoading, setIsOrdersLoading] = useState(false);
  const [isOrdersError, setIsOrdersError] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [isHistoryError, setIsHistoryError] = useState(false);
const [isLoading, setIsLoading] = useState(true);
  const paymentStoreVersion = useStoreSubscription(['orders', 'orderItems', 'paymentAllocations', 'payments', 'financialLedger']);
  const [isError, setIsError] = useState(false);

  // Active record view tab ('orders' or 'financial')
  const [activeTab, setActiveTab] = useState<'orders' | 'financial'>('orders');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  // Inline expanded order ID & financial item ID
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [expandedFinancialId, setExpandedFinancialId] = useState<string | null>(null);

  // Unified customer profile and account management modal state
  const [isAccountControlModalOpen, setIsAccountControlModalOpen] = useState(false);
  const [controlName, setControlName] = useState('');
  const [controlPhone, setControlPhone] = useState('');
  const [controlDebtLimit, setControlDebtLimit] = useState('');
  const [controlBin, setControlBin] = useState('');
  const [controlError, setControlError] = useState('');
  const [isSavingControl, setIsSavingControl] = useState(false);

  // Top-Up Payment Modal State
  const [isTopUpModalOpen, setIsTopUpModalOpen] = useState(false);
  const [topUpStep, setTopUpStep] = useState<1 | 2 | 3>(1); // 1: BIN, 2: Amount, 3: Confirm
  const [topUpAmountNIS, setTopUpAmountNIS] = useState('');
  const [topUpBin, setTopUpBin] = useState('');
  const [topUpNote, setTopUpNote] = useState('');
  const [topUpError, setTopUpError] = useState('');
  const [isSubmittingTopUp, setIsSubmittingTopUp] = useState(false);
  const [isValidatingBin, setIsValidatingBin] = useState(false);
  const idempotencyKeyRef = useRef<string>('');

  // Charger-fee exemption is managed inside the unified account modal.
  const [isSubmittingExempt, setIsSubmittingExempt] = useState(false);

  // Top-up Modal Flow Handlers
  const handleOpenTopUp = () => {
    if (!hasPermission('finance:credit-adjustment')) {
      showToast(
        locale === 'ar'
          ? 'أنت لا تتمتع بالصلاحية اللازمة لتنفيذ هذا الإجراء.'
          : 'You do not have permission to perform this action.',
        'error'
      );
      return;
    }
    setIsTopUpModalOpen(true);
    setTopUpStep(typeof navigator !== 'undefined' && navigator.onLine === false ? 2 : 1);
    setTopUpBin('');
    setTopUpAmountNIS('');
    setTopUpNote('');
    setTopUpError('');
    idempotencyKeyRef.current = crypto.randomUUID();
  };

  const handleCloseTopUp = () => {
    if (isSubmittingTopUp) return;
    setIsTopUpModalOpen(false);
    setTopUpBin('');
    setTopUpAmountNIS('');
    setTopUpNote('');
    setTopUpError('');
  };

  const handleVerifyBinStep = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isValidatingBin) return;
    setTopUpError('');

    const validation = validateBinFormat(topUpBin, locale);
    if (!validation.valid) {
      setTopUpError(validation.error || t('invalidBinError'));
      return;
    }

    setIsValidatingBin(true);
    const verifier = getAuthoritativeBinVerifier();
    if (!verifier) {
      setTopUpError('نظام التحقق غير متوفر حالياً');
      setIsValidatingBin(false);
      return;
    }

    try {
      const isValid = await verifier(topUpBin, {
        id: 'admin_authenticated',
        username: 'admin',
        fullName: 'مدير المنظومة',
        role: 'SUPER_ADMIN',
        permissions: [],
        isSuperAdmin: true,
      });

      if (!isValid) {
        setTopUpError(t('invalidBinError') || 'رمز التحقق (BIN) غير صحيح');
        setIsValidatingBin(false);
        return;
      }

      setTopUpStep(2);
    } catch {
      setTopUpError(t('invalidBinError') || 'رمز التحقق (BIN) غير صحيح');
    } finally {
      setIsValidatingBin(false);
    }
  };

  const handleAmountStep = (e: React.FormEvent) => {
    e.preventDefault();
    setTopUpError('');
    const num = parseFloat(topUpAmountNIS);
    if (isNaN(num) || num <= 0) {
      setTopUpError(t('invalidAmountError'));
      return;
    }
    setTopUpStep(3);
  };

  const handleCommitTopUp = async () => {
    if (isSubmittingTopUp || !customer) return;
    setIsSubmittingTopUp(true);
    setTopUpError('');

    const parsedAmount = parseFloat(topUpAmountNIS);
    const amountMinor = Math.round(parsedAmount * 100);

    try {
      const res = await topUpCustomerBalance({
        customerId: customer.id,
        amountMinor,
        bin: topUpBin,
        note: topUpNote.trim() || undefined,
        idempotencyKey: idempotencyKeyRef.current,
      });

      if (!res.success) {
        setTopUpError(res.error || 'فشلت عملية الشحن');
        setIsSubmittingTopUp(false);
        return;
      }

      // The payment is already committed. SMS is a best-effort follow-up and must
      // never roll back or disguise a successful financial transaction.
      let smsNotice = '';
      const smsPhone = String(customer.phone || '').trim();
      const smsKey = String(res.transactionId || idempotencyKeyRef.current);
      const sentKey = 'chargerpoint.balanceTopUpSmsSent.v1';
      if (smsPhone) {
        try {
          const sentMap = JSON.parse(localStorage.getItem(sentKey) || '{}') as Record<string, string>;
          if (!sentMap[smsKey]) {
            const template = localStorage.getItem('chargerpoint.balanceTopUpSmsTemplate.v1')
              || 'عزيزنا المشترك {customer_name}، تم إضافة رصيد إلى حسابك بقيمة {amount}. رصيدك الحالي بعد الإضافة: {current_balance}. شكراً لثقتك بنا.';
            const money = (minor: number) => (minor / 100).toLocaleString(locale === 'ar' ? 'ar-PS' : 'en-GB', {
              minimumFractionDigits: 2, maximumFractionDigits: 2,
            }) + (locale === 'ar' ? ' شيكل' : ' ILS');
            const smsMessage = template
              .replace(/\{customer_name\}/g, customer.name || '')
              .replace(/\{amount\}/g, money(amountMinor))
              .replace(/\{current_balance\}/g, money(res.newBalanceMinor));
            await sendSmsUsingSystemDefaultSim(smsPhone, smsMessage);
            sentMap[smsKey] = new Date().toISOString();
            const entries = Object.entries(sentMap).slice(-300);
            localStorage.setItem(sentKey, JSON.stringify(Object.fromEntries(entries)));
          }
        } catch (smsError) {
          console.warn('Balance was topped up, but confirmation SMS was not submitted:', smsError);
          smsNotice = locale === 'ar'
            ? '، لكن تعذّر إرسال رسالة SMS'
            : ', but the SMS could not be submitted';
        }
      } else {
        smsNotice = locale === 'ar' ? '، ولا يوجد رقم هاتف مسجل للزبون' : ', and the customer has no phone number';
      }

      // Refresh in place after the financial operation and SMS attempt.
      await loadData();
      setIsSubmittingTopUp(false);
      handleCloseTopUp();
      showToast(
        (locale === 'ar' ? 'تم شحن الرصيد بنجاح' : 'Balance topped up successfully') + smsNotice,
        smsNotice ? 'info' : 'success'
      );
    } catch (err) {
      console.error('Commit topup error:', err);
      setTopUpError('حدث خطأ غير متوقع');
      setIsSubmittingTopUp(false);
    }
  };

  const loadData = async () => {
    setIsLoading(true);
    setIsError(false);
    setIsOrdersLoading(true);
    setIsOrdersError(false);
    setIsHistoryLoading(true);
    setIsHistoryError(false);

    try {
      const custData = await getCustomerDetail(customerId);
      setCustomer(custData);
      if (!custData) setIsError(true);
    } catch (err) {
      console.error('Failed to load customer detail:', err);
      setIsError(true);
    } finally {
      setIsLoading(false);
    }

    // Load Orders independently
    getCustomerOrders(customerId, locale)
      .then((data) => {
        setOrders(data);
        setIsOrdersError(false);
      })
      .catch((err) => {
        console.error('Failed to load orders:', err);
        setIsOrdersError(true);
      })
      .finally(() => setIsOrdersLoading(false));

    // Load Financial History independently
    getCustomerFinancialHistory(customerId, locale)
      .then((data) => {
        setFinancialHistory(data);
        setIsHistoryError(false);
      })
      .catch((err) => {
        console.error('Failed to load financial history:', err);
        setIsHistoryError(true);
      })
      .finally(() => setIsHistoryLoading(false));
  };

  useEffect(() => {
    loadData();
  }, [customerId, locale]);

  // Remote payment/allocations are applied as authoritative deltas into the local store.
  // Refresh this page when those deltas arrive so payment badges cannot remain on the pre-payment snapshot.
  useEffect(() => {
    if (paymentStoreVersion > 0) loadData();
  }, [paymentStoreVersion]);

  const handleOpenAccountControlModal = () => {
    if (!customer) return;
    setControlName(customer.name);
    setControlPhone(customer.phone || '');
    setControlDebtLimit(`${Math.abs(customer.debtLimitMinor / 100)}`);
    setControlBin('');
    setControlError('');
    setIsAccountControlModalOpen(true);
  };

  const handleSaveAccountDetails = async () => {
    if (!customer || isSavingControl) return;
    if (!hasPermission('customers:edit')) {
      setControlError(locale === 'ar' ? 'غير مصرح بتعديل بيانات العميل' : 'Not authorized to edit customer details');
      return;
    }
    if (!controlName.trim()) {
      setControlError(t('customerNameRequired'));
      return;
    }

    const debtNum = controlDebtLimit.trim() === '' ? Number.NaN : Number(controlDebtLimit);
    if (!Number.isFinite(debtNum) || debtNum < 0) {
      setControlError(locale === 'ar' ? 'يرجى إدخال سقف دين صحيح' : 'Please enter a valid debt limit');
      return;
    }
    const debtLimitMinor = -Math.abs(Math.round(debtNum * 100));
    const debtLimitChanged = debtLimitMinor !== customer.debtLimitMinor;

    if (debtLimitChanged) {
      if (!hasPermission('customers:debt-limit')) {
        setControlError(locale === 'ar' ? 'غير مصرح بتعديل سقف الدين' : 'Not authorized to change debt limit');
        return;
      }
      const validation = validateBinFormat(controlBin, locale);
      if (!validation.valid) {
        setControlError(validation.error || t('invalidBinError'));
        return;
      }
    }

    setIsSavingControl(true);
    setControlError('');
    try {
      const updated = await updateCustomer(
        customer.id,
        {
          name: controlName.trim(),
          phone: controlPhone.trim(),
          ...(debtLimitChanged ? { debtLimitMinor } : {}),
        },
        debtLimitChanged ? controlBin.trim() : undefined
      );
      setCustomer(updated);
      setControlName(updated.name);
      setControlPhone(updated.phone || '');
      setControlDebtLimit(`${Math.abs(updated.debtLimitMinor / 100)}`);
      setControlBin('');
      showToast(
        locale === 'ar' ? 'تم حفظ بيانات العميل وإعدادات حسابه بنجاح' : 'Customer details and account settings saved',
        'success'
      );
    } catch (err: any) {
      setControlError(err?.message || (locale === 'ar' ? 'فشل حفظ بيانات العميل' : 'Failed to save customer details'));
    } finally {
      setIsSavingControl(false);
    }
  };

  const handleToggleCustomerActive = async () => {
    if (!customer) return;
    if (!hasPermission('customers:deactivate')) {
      showToast(
        locale === 'ar'
          ? 'أنت لا تتمتع بالصلاحية اللازمة لتنفيذ هذا الإجراء.'
          : 'You do not have permission to perform this action.',
        'error'
      );
      return;
    }

    setIsSavingControl(true);
    try {
      const newActive = !customer.isActive;
      const updated = await updateCustomer(customer.id, {
        isActive: newActive,
      });
      setCustomer(updated);
      showToast(
        newActive
          ? (locale === 'ar' ? 'تم تنشيط حساب العميل بنجاح' : 'Customer activated successfully')
          : (locale === 'ar' ? 'تم إلغاء تنشيط وتجميد الحساب' : 'Customer deactivated successfully'),
        'success'
      );
    } catch (err: any) {
      showToast(err?.message || 'فشل تحديث حالة الحساب', 'error');
    } finally {
      setIsSavingControl(false);
    }
  };

  const handleCommitExempt = async () => {
    if (!customer || isSubmittingExempt) return;
    if (!hasPermission('customers:charger-exemption')) {
      setControlError(locale === 'ar' ? 'غير مصرح بمنح أو إلغاء الإعفاء' : 'Not authorized to change charger-fee exemption');
      return;
    }

    const validation = validateBinFormat(controlBin, locale);
    if (!validation.valid) {
      setControlError(validation.error || t('invalidBinError'));
      return;
    }

    setIsSubmittingExempt(true);
    setControlError('');
    try {
      const nextExemptState = !customer.chargerFeeExempt;
      const res = await updateCustomerChargerFeeExemptionWithPhase5(
        customer.id,
        nextExemptState,
        controlBin.trim()
      );
      if (!res.success) {
        setControlError(res.error || (locale === 'ar' ? 'رمز BIN غير صحيح أو تم رفض العملية' : 'BIN is invalid or the operation was rejected'));
        return;
      }

      await loadData();
      setControlBin('');
      showToast(
        nextExemptState
          ? (locale === 'ar' ? 'تم منح الإعفاء بنجاح' : 'Exemption granted successfully')
          : (locale === 'ar' ? 'تم إلغاء الإعفاء بنجاح' : 'Exemption removed successfully'),
        'success'
      );
    } catch (err: any) {
      setControlError(err?.message || (locale === 'ar' ? 'حدث خطأ أثناء حفظ الإعفاء' : 'Failed to save exemption'));
    } finally {
      setIsSubmittingExempt(false);
    }
  };

  const handleQrClick = () => {
    if (!customer) return;
    if (onNavigateToQr) {
      onNavigateToQr(customer.id);
    } else {
      window.history.pushState(
        { path: `/app/qr/customer/${customer.id}` },
        '',
        `/app/qr/customer/${customer.id}`
      );
      window.dispatchEvent(new Event('popstate'));
    }
  };

  const toggleOrderExpand = (orderId: string) => {
    setExpandedOrderId((prev) => (prev === orderId ? null : orderId));
  };

  const toggleFinancialExpand = (id: string) => {
    setExpandedFinancialId((prev) => (prev === id ? null : id));
  };

  const getStatusBadge = (status: string, key?: string) => {
    switch (status) {
      case 'completed':
      case 'delivered':
        return (
          <span key={key || 'status-delivered'} className="px-2 py-0.5 text-xs font-medium bg-emerald-50 text-emerald-700 dark:bg-[#0d362f] dark:text-[#7ae09e] rounded-md border border-emerald-200 dark:border-[#14423b]">
            {t('statusDelivered')}
          </span>
        );
      case 'cancelled':
        return (
          <span key={key || 'status-cancelled'} className="px-2 py-0.5 text-xs font-medium bg-red-50 text-red-700 dark:bg-[#360d13] dark:text-[#e07a7a] rounded-md border border-red-200 dark:border-[#421419]">
            {t('statusCancelled')}
          </span>
        );
      case 'charging':
      case 'in_progress':
        return (
          <span key={key || 'status-charging'} className="px-2 py-0.5 text-xs font-medium bg-blue-50 text-blue-700 dark:bg-[#0c312b] dark:text-[#8eb698] rounded-md border border-blue-200 dark:border-[#14423b]">
            {t('statusCharging')}
          </span>
        );
      default:
        return (
          <span key={key || 'status-pending'} className="px-2 py-0.5 text-xs font-medium bg-amber-50 text-amber-700 dark:bg-[#36270d] dark:text-[#e0be7a] rounded-md border border-amber-200 dark:border-[#423314]">
            {t('statusPending')}
          </span>
        );
    }
  };

  const getPaymentStatusBadge = (pStatus: 'PAID' | 'PARTIAL' | 'UNPAID', key?: string) => {
    switch (pStatus) {
      case 'PAID':
        return (
          <span key={key || 'payment-paid'} className="px-2 py-0.5 text-xs font-medium bg-emerald-50 text-emerald-700 dark:bg-[#0d362f] dark:text-[#7ae09e] rounded-md border border-emerald-200 dark:border-[#14423b]">
            {t('paymentPaid')}
          </span>
        );
      case 'PARTIAL':
        return (
          <span key={key || 'payment-partial'} className="px-2 py-0.5 text-xs font-medium bg-amber-50 text-amber-700 dark:bg-[#36270d] dark:text-[#e0be7a] rounded-md border border-amber-200 dark:border-[#423314]">
            {t('paymentPartial')}
          </span>
        );
      case 'UNPAID':
      default:
        return (
          <span key={key || 'payment-unpaid'} className="px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-700 dark:bg-[#0d2623] dark:text-[#8eb698] rounded-md border border-gray-200 dark:border-[#14423b]">
            {t('paymentUnpaid')}
          </span>
        );
    }
  };

  // Loading Skeleton State
  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto space-y-6 px-4 py-4 sm:px-6 animate-pulse">
        <div className="bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] rounded-xl p-5 space-y-4">
          <div className="h-7 bg-gray-200 dark:bg-[#0c312b] rounded w-1/3"></div>
          <div className="h-4 bg-gray-100 dark:bg-[#0c312b]/60 rounded w-1/4"></div>
        </div>
      </div>
    );
  }

  // Error State
  if (isError || !customer) {
    return (
      <div className="max-w-4xl mx-auto py-12 px-4 text-center space-y-3">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-red-100 dark:bg-[#360d13] text-red-600 dark:text-[#e07a7a]">
          <AlertTriangle className="w-5 h-5" />
        </div>
        <p className="text-sm font-medium text-gray-900 dark:text-[#daf1de]">
          {t('noCustomersFound')}
        </p>
      </div>
    );
  }

  const parsedAmount = parseFloat(topUpAmountNIS) || 0;
  const topUpMinor = Math.round(parsedAmount * 100);
  const resultingBalanceMinor = customer.currentBalanceMinor + topUpMinor;
  const isRTL = locale === 'ar';

  return (
    <div className="max-w-4xl mx-auto space-y-6 px-4 py-4 sm:px-6">
      {/* 1. Header Profile & Actions Card */}
      <div className="bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] rounded-2xl p-5 shadow-xs space-y-4 transition-colors">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          {/* Right/Start Area: Customer Name + Green/Red Status Dot + Code + Sub Info */}
          <div className="space-y-2 flex-1 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-xl font-bold text-gray-900 dark:text-[#daf1de] tracking-tight truncate">
                {customer.name}
              </h1>

              {/* Status Indicator: Pure Green / Red Clean Dot */}
              <span
                className={`inline-block w-2.5 h-2.5 rounded-full ${
                  customer.isActive
                    ? 'bg-emerald-500 ring-3 ring-emerald-500/20'
                    : 'bg-rose-500 ring-3 ring-rose-500/20'
                }`}
                title={
                  customer.isActive
                    ? locale === 'ar' ? 'الحساب نشط' : 'Active'
                    : locale === 'ar' ? 'الحساب غير نشط ومجمد' : 'Inactive'
                }
              />

              {/* Code */}
              <span className="font-mono text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-[#0c312b] text-gray-600 dark:text-[#a9d4b4] border border-gray-200/60 dark:border-[#14423b] uppercase">
                {customer.code}
              </span>
            </div>

            {/* Sub-info: Phone & Created Date */}
            <div className="flex flex-wrap items-center gap-4 text-xs text-gray-500 dark:text-[#8eb698]">
              {customer.phone && (
                <div className="flex items-center gap-1.5 dir-ltr text-start">
                  <Phone className="w-3.5 h-3.5 text-gray-400 dark:text-[#5e8674]" />
                  <span className="font-mono">{customer.phone}</span>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-gray-400 dark:text-[#5e8674]" />
                <span>{formatDate(customer.createdAt)}</span>
              </div>
            </div>
          </div>

          {/* Left/End Area: Action Buttons (Top-Up Big Button on Top, 50/50 QR & Edit underneath) */}
          <div className="flex flex-col gap-2 w-full sm:w-60 shrink-0">
            {/* Top Large Primary Button: Top-Up Balance */}
            <Button
              variant="primary"
              size="sm"
              onClick={handleOpenTopUp}
              className="w-full justify-center gap-2 py-2 px-4 text-xs font-bold shadow-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl transition-all cursor-pointer"
            >
              <CreditCard className="w-4 h-4 shrink-0" />
              <span>{t('topUpBalance') || 'شحن الرصيد'}</span>
            </Button>

            {/* QR shortcut; customer editing lives in Account Management */}
            <div className="grid grid-cols-1 gap-2 w-full">
              <Button
                variant="outline"
                size="sm"
                onClick={handleQrClick}
                className="w-full justify-center gap-1.5 py-1.5 px-2 text-xs font-semibold rounded-xl border-gray-200 dark:border-[#14423b] hover:bg-gray-50 dark:hover:bg-[#0c312b] cursor-pointer"
              >
                <QrCode className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <span>{t('qrCode') || 'الـ QR'}</span>
              </Button>

            </div>
          </div>
        </div>

        {/* 2. Customer Balance & Bottom Corner Activation / Control Button */}
        <div className="pt-3 border-t border-gray-100 dark:border-[#123832] flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          {/* Balance Display */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-gray-500 dark:text-[#8eb698] font-medium">
              {t('currentBalance')}:
            </span>
            <span
              className={`text-base sm:text-lg font-bold font-mono tracking-tight ${
                customer.currentBalanceMinor > 0
                  ? 'text-emerald-600 dark:text-[#7ae09e]'
                  : customer.currentBalanceMinor < 0
                  ? 'text-rose-600 dark:text-[#f87171]'
                  : 'text-gray-900 dark:text-[#daf1de]'
              }`}
            >
              {formatCurrency(customer.currentBalanceMinor)}
            </span>
            {customer.currentBalanceMinor > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-[#0d362f] dark:text-[#7ae09e] font-semibold border border-emerald-200/50 dark:border-[#14423b]">
                {locale === 'ar' ? 'رصيد دائن' : 'Credit'}
              </span>
            )}
            {customer.currentBalanceMinor < 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 dark:bg-[#360d13] dark:text-[#f87171] font-semibold border border-rose-200/50 dark:border-[#421419]">
                {locale === 'ar' ? 'دين مستحق' : 'Debt'}
              </span>
            )}
          </div>

          {/* Quick Account Controls & Activation Trigger Button */}
          <div className="flex items-center gap-2 self-start sm:self-auto">
            <button
              type="button"
              onClick={handleOpenAccountControlModal}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-gray-700 dark:text-[#daf1de] bg-gray-50 hover:bg-gray-100 dark:bg-[#061f1c] dark:hover:bg-[#0c312b] border border-gray-200 dark:border-[#14423b] transition-colors cursor-pointer"
            >
              <Power className={`w-3.5 h-3.5 ${customer.isActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`} />
              <span>{locale === 'ar' ? 'تفعيل وإدارة الحساب' : 'Account Controls'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* 3. Dynamic Record Selector Dropdown Section */}
      <div className="space-y-3">
        {/* Selector Header */}
        <div className="relative flex items-center justify-between px-1">
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsDropdownOpen((prev) => !prev)}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-base font-bold text-gray-900 dark:text-[#daf1de] bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] rounded-xl hover:bg-gray-50 dark:hover:bg-[#0b312b] transition-colors shadow-xs cursor-pointer"
            >
              {activeTab === 'orders' ? (
                <span key="active-tab-orders" className="inline-flex items-center gap-2">
                  <ShoppingBag className="w-4 h-4 text-gray-500 dark:text-[#8eb698]" />
                  <span>{t('ordersHistoryTab')}</span>
                  <span className="ms-1 px-2 py-0.5 text-xs text-gray-500 dark:text-[#a9d4b4] bg-gray-100 dark:bg-[#0c312b] rounded-full font-medium border border-transparent dark:border-[#14423b]">
                    {orders.length}
                  </span>
                </span>
              ) : (
                <span key="active-tab-financial" className="inline-flex items-center gap-2">
                  <Receipt className="w-4 h-4 text-gray-500 dark:text-[#8eb698]" />
                  <span>{t('financialLedgerTab')}</span>
                  <span className="ms-1 px-2 py-0.5 text-xs text-gray-500 dark:text-[#a9d4b4] bg-gray-100 dark:bg-[#0c312b] rounded-full font-medium border border-transparent dark:border-[#14423b]">
                    {financialHistory.length}
                  </span>
                </span>
              )}
              {isDropdownOpen ? (
                <ChevronUp key="chevron-up" className="w-4 h-4 text-gray-500 dark:text-[#8eb698] shrink-0 ms-1" />
              ) : (
                <ChevronDown key="chevron-down" className="w-4 h-4 text-gray-500 dark:text-[#8eb698] shrink-0 ms-1" />
              )}
            </button>

            {/* Dropdown Menu */}
            {isDropdownOpen && (
              <div key="dropdown-menu-wrapper">
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setIsDropdownOpen(false)}
                />
                <div className="absolute top-full start-0 mt-1.5 w-48 bg-white dark:bg-[#0a2f29] border border-gray-200 dark:border-[#174840] rounded-xl shadow-lg z-20 py-1 overflow-hidden">
                  <button
                    key="btn-tab-orders"
                    type="button"
                    onClick={() => {
                      setActiveTab('orders');
                      setIsDropdownOpen(false);
                    }}
                    className={`w-full flex items-center justify-between px-3.5 py-2 text-xs font-semibold text-start transition-colors cursor-pointer ${
                      activeTab === 'orders'
                        ? 'bg-gray-100 dark:bg-[#0c312b] text-gray-900 dark:text-[#daf1de]'
                        : 'text-gray-700 dark:text-[#8eb698] hover:bg-gray-50 dark:hover:bg-[#082622]'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <ShoppingBag className="w-3.5 h-3.5 text-gray-500 dark:text-[#8eb698]" />
                      <span>{t('ordersHistoryTab')}</span>
                    </div>
                    <span className="px-1.5 py-0.5 text-[10px] text-gray-500 dark:text-[#8eb698] bg-gray-200/60 dark:bg-[#0c312b] rounded-full">
                      {orders.length}
                    </span>
                  </button>

                  <button
                    key="btn-tab-financial"
                    type="button"
                    onClick={() => {
                      setActiveTab('financial');
                      setIsDropdownOpen(false);
                    }}
                    className={`w-full flex items-center justify-between px-3.5 py-2 text-xs font-semibold text-start transition-colors cursor-pointer ${
                      activeTab === 'financial'
                        ? 'bg-gray-100 dark:bg-[#0c312b] text-gray-900 dark:text-[#daf1de]'
                        : 'text-gray-700 dark:text-[#8eb698] hover:bg-gray-50 dark:hover:bg-[#082622]'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Receipt className="w-3.5 h-3.5 text-gray-500 dark:text-[#8eb698]" />
                      <span>{t('financialLedgerTab')}</span>
                    </div>
                    <span className="px-1.5 py-0.5 text-[10px] text-gray-500 dark:text-[#8eb698] bg-gray-200/60 dark:bg-[#0c312b] rounded-full">
                      {financialHistory.length}
                    </span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Tab Content Display */}
        <div className="space-y-2">
          {activeTab === 'orders' ? (isOrdersLoading ? (<div key="loading-orders" className="p-8 text-center animate-pulse"><div className="h-10 bg-gray-100 dark:bg-[#0c312b] rounded-xl w-full"></div></div>) : isOrdersError ? (<div key="error-orders" className="p-8 text-center bg-rose-50/30 rounded-xl border border-rose-100"><p className="text-xs text-rose-600">{t('errorOccurred')}</p></div>) : 
            orders.length === 0 ? (
              <div key="empty-orders" className="bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] rounded-xl p-8 text-center space-y-2">
                <ShoppingBag className="w-8 h-8 text-gray-300 dark:text-[#174840] mx-auto" />
                <p className="text-xs text-gray-500 dark:text-[#8eb698]">
                  {t('noOrdersForCustomer')}
                </p>
              </div>
            ) : (
              <div key="orders-list" className="space-y-2">
                {orders.map((ord, ordIdx) => {
                  const isExpanded = expandedOrderId === ord.id;
                  const orderKey = `order-${ord.id || 'noid'}-${ordIdx}`;
                  return (
                    <div
                      key={orderKey}
                      className="bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] rounded-xl overflow-hidden shadow-2xs transition-colors"
                    >
                      <div
                        onClick={() => toggleOrderExpand(ord.id)}
                        className="p-3.5 sm:p-4 flex items-center justify-between cursor-pointer hover:bg-gray-50/50 dark:hover:bg-[#0b312b]/50 transition-colors"
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggleOrderExpand(ord.id);
                          }
                        }}
                      >
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span key="order-label" className="font-semibold text-sm text-gray-900 dark:text-[#daf1de]">
                              {t('orderResultLabel', { number: ord.orderNumber })}
                            </span>
                            {getStatusBadge(ord.status, `status-${ord.id || ordIdx}`)}
                            {getPaymentStatusBadge(ord.paymentStatus, `payment-${ord.id || ordIdx}`)}
                          </div>
                          <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-[#8eb698]">
                            <span>{formatDate(ord.businessDate || ord.createdAt)}</span>
                            <span>•</span>
                            <span>
                              {t('devicesCountSummary', { count: ord.itemCount })}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 shrink-0 ms-2">
                          <span className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">
                            {formatCurrency(ord.totalMinor)}
                          </span>
                          {isExpanded ? (
                            <ChevronUp className="w-4 h-4 text-gray-400 dark:text-[#8eb698]" />
                          ) : (
                            <ChevronDown className="w-4 h-4 text-gray-400 dark:text-[#8eb698]" />
                          )}
                        </div>
                      </div>

                      {/* Expanded Device Details */}
                      {isExpanded && (
                        <div className="px-4 pb-4 pt-2 border-t border-gray-100 dark:border-[#103831] bg-gray-50/40 dark:bg-[#061f1c]/40 space-y-2">
                          <span className="text-xs font-semibold text-gray-700 dark:text-[#8eb698] block">
                            {t('registeredDevicesList')}:
                          </span>
                          <div className="space-y-1.5">
                            {(ord.items || []).map((item, itemIdx) => {
                              const itemKey = `ord-item-${ord.id || ordIdx}-${item.id || 'item'}-${itemIdx}`;
                              return (
                                <div
                                  key={itemKey}
                                  className="flex items-center justify-between text-xs p-2 rounded bg-white dark:bg-[#082622] border border-gray-100 dark:border-[#14423b]"
                                >
                                  <div className="flex items-center gap-2">
                                    <span className="font-medium text-gray-800 dark:text-[#daf1de]">
                                      {item.deviceName}
                                    </span>
                                    {item.hasCharger && (
                                      <span className="px-1.5 py-0.5 text-[10px] bg-amber-50 text-amber-800 dark:bg-[#36270d] dark:text-[#e0be7a] rounded font-medium">
                                        {t('withCharger')}
                                      </span>
                                    )}
                                  </div>
                                  <span className="font-mono font-medium text-gray-700 dark:text-[#8eb698]">
                                    {formatCurrency(item.priceMinor)}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          ) : (isHistoryLoading ? (<div key="loading-financial" className="p-8 text-center animate-pulse"><div className="h-10 bg-gray-100 dark:bg-[#0c312b] rounded-xl w-full"></div></div>) : isHistoryError ? (<div key="error-financial" className="p-8 text-center bg-rose-50/30 rounded-xl border border-rose-100"><p className="text-xs text-rose-600">{t('errorOccurred')}</p></div>) : 
            financialHistory.length === 0 ? (
              <div key="empty-financial" className="bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] rounded-xl p-8 text-center space-y-2">
                <Receipt className="w-8 h-8 text-gray-300 dark:text-[#174840] mx-auto" />
                <p className="text-xs text-gray-500 dark:text-[#8eb698]">
                  {t('noFinancialTransactionsFound')}
                </p>
              </div>
            ) : (
              <div key="financial-list" className="space-y-2">
                {financialHistory.map((item, histIdx) => {
                  const isExpanded = expandedFinancialId === item.id;
                  const isPayment = item.amountMinor > 0;
                  const isOrderCharge = item.eventType === 'ORDER_ITEM_CHARGE' || item.eventType === 'ORDER_CHARGE';
                  const finKey = `fin-${item.id || 'noid'}-${histIdx}`;

                  return (
                    <div
                      key={finKey}
                      className="bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] rounded-xl overflow-hidden shadow-2xs transition-colors"
                    >
                      <div
                        onClick={() => toggleFinancialExpand(item.id)}
                        className="p-3.5 sm:p-4 flex items-center justify-between cursor-pointer hover:bg-gray-50/50 dark:hover:bg-[#0b312b]/50 transition-colors"
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggleFinancialExpand(item.id);
                          }
                        }}
                      >
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-sm text-gray-900 dark:text-[#daf1de]">
                              {item.shortTitle}
                            </span>
                            {item.orderDisplayNumber && (
                              <span className="text-[10px] px-2 py-0.5 rounded font-mono bg-blue-50 text-blue-700 dark:bg-[#0c312b] dark:text-[#8eb698]">
                                {t('orderResultLabel', { number: item.orderDisplayNumber })}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-[#8eb698]">
                            <span>{formatDate(item.businessDate || item.createdAt)}</span>
                            <span>•</span>
                            <span>
                              {t('resultingBalance')}: {formatCurrency(item.postBalanceMinor)}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 shrink-0 ms-2">
                          <span
                            className={`text-sm font-bold font-mono ${
                              isPayment
                                ? 'text-emerald-600 dark:text-[#7ae09e]'
                                : 'text-rose-600 dark:text-[#f87171]'
                            }`}
                          >
                            {isPayment ? '+' : ''}
                            {formatCurrency(item.amountMinor)}
                          </span>
                          {isExpanded ? (
                            <ChevronUp className="w-4 h-4 text-gray-400 dark:text-[#8eb698]" />
                          ) : (
                            <ChevronDown className="w-4 h-4 text-gray-400 dark:text-[#8eb698]" />
                          )}
                        </div>
                      </div>

                      {/* Expanded Transaction Details */}
                      {isExpanded && (
                        <div className="px-4 pb-4 pt-2 border-t border-gray-100 dark:border-[#103831] bg-gray-50/40 dark:bg-[#061f1c]/40 space-y-2.5 text-xs">
                          {isOrderCharge && item.orderItems && item.orderItems.length > 0 && (
                            <div className="space-y-1.5 bg-white dark:bg-[#082622] p-2.5 rounded-lg border border-gray-100 dark:border-[#14423b]">
                              <span className="font-semibold text-gray-700 dark:text-[#8eb698] block">
                                {t('registeredDevicesList')}:
                              </span>
                              <div className="space-y-1 pl-2 pr-2">
                                {(item.orderItems || []).map((dev, devIdx) => {
                                  const devKey = `fin-dev-${item.id || histIdx}-${dev.id || 'dev'}-${devIdx}`;
                                  return (
                                    <div
                                      key={devKey}
                                      className="flex items-center justify-between text-gray-700 dark:text-[#daf1de]"
                                    >
                                      <div className="flex items-center gap-2">
                                        <span>• {dev.deviceName}</span>
                                        {dev.hasCharger && (
                                          <span className="px-1.5 py-0.5 text-[10px] bg-amber-100 dark:bg-[#36270d] text-amber-800 dark:text-[#e0be7a] rounded font-medium">
                                            {t('withCharger')}
                                          </span>
                                        )}
                                      </div>
                                      <span className="font-medium text-gray-900 dark:text-[#daf1de]">
                                        {formatCurrency(dev.priceMinor)}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                              {item.orderTotalMinor !== undefined && (
                                <div className="flex items-center justify-between pt-1 border-t border-gray-200/50 dark:border-[#14423b] font-bold text-gray-900 dark:text-[#daf1de]">
                                  <span>{t('total')}:</span>
                                  <span>{formatCurrency(item.orderTotalMinor)}</span>
                                </div>
                              )}
                            </div>
                          )}

                          {item.note && (
                            <div className="text-gray-600 dark:text-[#8eb698] bg-white/60 dark:bg-[#082622] p-2 rounded border border-gray-200/50 dark:border-[#14423b]">
                              <span className="font-semibold">{t('noteLabel')} </span>
                              <span>{item.note}</span>
                            </div>
                          )}

                          <div className="flex items-center justify-between text-[11px] text-gray-400 dark:text-[#5e8674] pt-1 border-t border-gray-200/40 dark:border-[#14423b]">
                            <span>{t('transactionDateTime')}</span>
                            <span>{formatDateTime(item.createdAt)}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          )}
        </div>
      </div>

      {/* Unified customer profile and account management */}
      {isAccountControlModalOpen && customer && (
        <Modal
          isOpen={isAccountControlModalOpen}
          onClose={() => setIsAccountControlModalOpen(false)}
          title={locale === 'ar' ? 'تفعيل وإدارة حساب العميل' : 'Customer Account Management'}
          className="max-w-md bg-white dark:bg-[#082622] border-gray-200 dark:border-[#14423b]"
        >
          <div className="space-y-4">
            {controlError && (
              <div className="p-3 text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/40 rounded-xl flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{controlError}</span>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-gray-700 dark:text-[#8eb698]">{t('customerName')} *</label>
              <input
                type="text"
                required
                disabled={!hasPermission('customers:edit') || isSavingControl}
                value={controlName}
                onChange={(e) => setControlName(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-white dark:bg-[#061f1c] border border-gray-200 dark:border-[#14423b] rounded-xl text-gray-900 dark:text-[#daf1de] disabled:opacity-60"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-gray-700 dark:text-[#8eb698]">{t('phoneNumber')}</label>
              <input
                type="tel"
                disabled={!hasPermission('customers:edit') || isSavingControl}
                value={controlPhone}
                onChange={(e) => setControlPhone(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-white dark:bg-[#061f1c] border border-gray-200 dark:border-[#14423b] rounded-xl text-gray-900 dark:text-[#daf1de] dir-ltr text-start font-mono disabled:opacity-60"
              />
            </div>

            <div className="p-3.5 bg-gray-50 dark:bg-[#061f1c] border border-gray-200/80 dark:border-[#123832] rounded-xl space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-gray-900 dark:text-[#daf1de]">{t('debtLimit') || 'سقف الدين'} (₪)</label>
                <span className="text-xs font-mono font-semibold text-gray-600 dark:text-[#8eb698]">{formatCurrency(customer.debtLimitMinor)}</span>
              </div>
              <input
                type="number"
                min="0"
                step="10"
                disabled={!hasPermission('customers:debt-limit') || isSavingControl}
                value={controlDebtLimit}
                onChange={(e) => setControlDebtLimit(e.target.value)}
                placeholder="0.00"
                className="w-full px-3 py-2 text-sm font-mono bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] rounded-lg text-gray-900 dark:text-[#daf1de] disabled:opacity-60"
              />
            </div>

            <div className="p-3.5 bg-gray-50 dark:bg-[#061f1c] border border-gray-200/80 dark:border-[#123832] rounded-xl flex items-center justify-between gap-3">
              <div className="space-y-0.5">
                <span className="text-xs font-bold text-gray-900 dark:text-[#daf1de] block">{locale === 'ar' ? 'حالة الحساب' : 'Account Status'}</span>
                <span className="text-[11px] text-gray-500 dark:text-[#8eb698]">
                  {customer.isActive
                    ? (locale === 'ar' ? 'الحساب نشط ويستقبل الطلبات' : 'Active and accepting orders')
                    : (locale === 'ar' ? 'الحساب مجمد وموقوف عن العمليات' : 'Account is frozen / deactivated')}
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                variant={customer.isActive ? 'outline' : 'primary'}
                disabled={isSavingControl || !hasPermission('customers:deactivate')}
                onClick={handleToggleCustomerActive}
                className={`gap-1.5 text-xs font-semibold cursor-pointer ${customer.isActive ? 'border-rose-300 text-rose-700 dark:border-rose-900/60 dark:text-rose-400' : 'bg-emerald-600 hover:bg-emerald-700 text-white'}`}
              >
                <Power className="w-3.5 h-3.5" />
                <span>{customer.isActive ? (locale === 'ar' ? 'تجميد الحساب' : 'Deactivate') : (locale === 'ar' ? 'تنشيط الحساب' : 'Activate')}</span>
              </Button>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-700 dark:text-[#8eb698] block">{t('adminPinLabel')} (BIN)</label>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={8}
                value={controlBin}
                onChange={(e) => setControlBin(e.target.value)}
                placeholder={locale === 'ar' ? 'مطلوب عند تعديل سقف الدين أو الإعفاء' : 'Required for debt-limit or exemption changes'}
                className="w-full text-center tracking-widest font-mono text-sm bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 text-gray-900 dark:text-[#daf1de]"
              />
              <p className="text-[10px] text-gray-500 dark:text-[#8eb698]">
                {locale === 'ar' ? 'يتم التحقق من الرمز عند تنفيذ العملية الحساسة فقط.' : 'The BIN is verified only when a protected change is submitted.'}
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={isSavingControl || !hasPermission('customers:edit')}
                isLoading={isSavingControl}
                onClick={handleSaveAccountDetails}
                className="w-full text-xs font-semibold cursor-pointer"
              >
                {locale === 'ar' ? 'حفظ بيانات العميل وحد الدين' : 'Save Customer Details & Debt Limit'}
              </Button>

              <div className="p-3.5 bg-gray-50 dark:bg-[#061f1c] border border-gray-200/80 dark:border-[#123832] rounded-xl flex items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <span className="text-xs font-bold text-gray-900 dark:text-[#daf1de] block">{t('chargerFeeExempt') || 'استثناء رسوم الشاحن'}</span>
                  <span className="text-[11px] text-gray-500 dark:text-[#8eb698]">
                    {customer.chargerFeeExempt
                      ? (locale === 'ar' ? 'العميل معفى من رسوم الشاحن' : 'Customer is exempt from charger fees')
                      : (locale === 'ar' ? 'تُطبق رسوم الشاحن الاعتيادية' : 'Standard charger fee applies')}
                  </span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!hasPermission('customers:charger-exemption') || isSubmittingExempt}
                  isLoading={isSubmittingExempt}
                  onClick={handleCommitExempt}
                  className={`text-xs font-semibold px-3 cursor-pointer ${customer.chargerFeeExempt ? 'border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-300 bg-amber-50/50 dark:bg-amber-950/20' : 'border-gray-200 dark:border-[#14423b]'}`}
                >
                  {customer.chargerFeeExempt ? (locale === 'ar' ? 'إلغاء الإعفاء' : 'Remove Exemption') : (locale === 'ar' ? 'منح الإعفاء' : 'Grant Exemption')}
                </Button>
              </div>
            </div>

            <div className="flex justify-end pt-2 border-t border-gray-100 dark:border-[#14423b]">
              <Button type="button" variant="outline" size="sm" onClick={() => setIsAccountControlModalOpen(false)} className="text-xs cursor-pointer">
                {t('closeAction') || 'إغلاق'}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* 7. Top-up Payment Modal Dialog */}
      {isTopUpModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white dark:bg-[#0a2f29] border border-gray-200 dark:border-[#174840] rounded-2xl w-full max-w-md shadow-xl overflow-hidden">
            <div className="flex items-center justify-between border-b border-gray-100 dark:border-[#14423b] p-4 sm:p-5">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 bg-emerald-50 dark:bg-emerald-950/40 rounded-xl flex items-center justify-center text-emerald-600 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-900/30">
                  <CreditCard className="w-4 h-4" />
                </div>
                <div className="text-start">
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
                className="p-1 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-[#daf1de] transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Error Banner if any */}
            {topUpError && (
              <div className="mx-4 sm:mx-5 mt-4 p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/50 rounded-xl text-xs text-rose-700 dark:text-rose-400 flex items-center gap-2 text-start">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{topUpError}</span>
              </div>
            )}

            {/* STEP 1: SENSITIVE OPERATION AUTHORIZATION (BIN) */}
            {topUpStep === 1 && (
              <form onSubmit={handleVerifyBinStep} className="p-4 sm:p-5 space-y-4">
                <div className="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200/70 dark:border-amber-800/40 rounded-xl text-xs space-y-1 text-start">
                  <div className="flex items-center gap-1.5 font-bold text-amber-800 dark:text-amber-300">
                    <ShieldCheck className="w-4 h-4" />
                    <span>{t('sensitiveOperation')}</span>
                  </div>
                  <p className="text-amber-700 dark:text-amber-400/90 text-[11px]">
                    {t('enterBinToProceed')}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-700 dark:text-[#8eb698] block text-start">
                    {t('adminPinLabel')} (BIN)
                  </label>
                  <div className="relative">
                    <Lock className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-[#5e8674] ${isRTL ? 'right-3' : 'left-3'}`} />
                    <input
                      type="password"
                      autoFocus
                      value={topUpBin}
                      onChange={(e) => setTopUpBin(e.target.value)}
                      placeholder="••••"
                      maxLength={8}
                      className="w-full text-center tracking-widest font-mono text-sm bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 text-gray-900 dark:text-[#daf1de] placeholder-gray-400 dark:placeholder-[#5e8674] focus:outline-none focus:ring-1 focus:ring-emerald-500"
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
                <div className="p-3 bg-gray-50 dark:bg-[#06201c] border border-gray-200/70 dark:border-[#14423b]/70 rounded-xl space-y-1.5 text-xs text-start">
                  <div className="flex justify-between items-center text-gray-500 dark:text-[#8eb698]">
                    <span>{customer.name}</span>
                    <span className="font-mono">{customer.code}</span>
                  </div>
                  <div className="flex justify-between items-center font-semibold pt-1 border-t border-gray-200/50 dark:border-[#14423b]/50">
                    <span>{t('currentBalance')}:</span>
                    <span
                      className={`font-mono font-bold ${
                        customer.currentBalanceMinor < 0
                          ? 'text-rose-600 dark:text-rose-400'
                          : customer.currentBalanceMinor > 0
                          ? 'text-emerald-600 dark:text-[#8eb698]'
                          : 'text-gray-600'
                      }`}
                    >
                      {formatCurrency(customer.currentBalanceMinor)}
                    </span>
                  </div>
                </div>

                {/* Amount Input */}
                <div className="space-y-1.5 text-start">
                  <label className="text-xs font-semibold text-gray-700 dark:text-[#8eb698] block">
                    {t('topUpAmount')} (₪)
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    min="1"
                    autoFocus
                    value={topUpAmountNIS}
                    onChange={(e) => setTopUpAmountNIS(e.target.value)}
                    placeholder="0.00"
                    className="w-full text-lg font-mono font-bold text-center bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 text-emerald-600 dark:text-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                {/* Note Input */}
                <div className="space-y-1.5 text-start">
                  <label className="text-xs font-semibold text-gray-700 dark:text-[#8eb698] block">
                    {t('topUpNoteOptional')}
                  </label>
                  <input
                    type="text"
                    value={topUpNote}
                    onChange={(e) => setTopUpNote(e.target.value)}
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
                <div className="p-3.5 bg-gray-50 dark:bg-[#06201c] border border-gray-200/70 dark:border-[#14423b]/70 rounded-xl space-y-2 text-xs text-start">
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

                  {topUpNote && (
                    <div className="flex justify-between items-center text-gray-500 dark:text-[#5e8674] text-[11px] pt-1 border-t border-gray-200/40 dark:border-[#14423b]/40">
                      <span>{t('topUpNoteOptional')}:</span>
                      <span>{topUpNote}</span>
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
                      <span className="inline-flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>{t('confirmAndApply')}</span>
                      </span>
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
