import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  ArrowUpRight, BatteryCharging, CalendarClock, Check, CheckCircle2,
  CircleAlert, CircleHelp, Clock3, CreditCard, Globe,
  Monitor, Moon, PackageCheck, RefreshCw, Settings2,
  Smartphone, Sparkles, Sun, UserRound, Zap, ShieldCheck, Wallet,
} from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';
import { AppLogo } from '../qr/AppLogo';
import { getPublicOrderByToken, getItemLocalizedDeviceName, PublicOrderQrData } from './dayOrdersStore';
import type { BackgroundState } from '../energy/EnergyCanvasBackground';
import { CustomerAuthScene } from './CustomerAuthScene';
import { rpcResolveOrderQr, rpcResolveOrderQrCreditCoverage, rpcResolveOrderQrCustomerId, rpcResolveQrPaymentSubmission, type PublicQrPaymentSubmissionRpcResult } from '../../services/supabase/client';

export interface PublicOrderPageProps {
  token: string;
}

/**
 * Derives the public payment action from the canonical balance and QR-specific submission state.
 */
export type OrderPaymentViewState = 'PAID' | 'PENDING' | 'APPROVED' | 'PARTIALLY_PAID' | 'REJECTED' | 'UNPAID' | 'CREDIT_COVERED' | 'NOT_DUE' | 'UNAVAILABLE';

export const getOrderPaymentViewState = (
  dueMinor: number | null | undefined,
  submission: Pick<PublicQrPaymentSubmissionRpcResult, 'status'> | null,
  customerHasPositiveCredit: boolean | null | undefined,
  orderStatus: string | null | undefined,
  customerCreditCoversOrder: boolean | null | undefined = false,
  orderTotalMinor?: number | null
): OrderPaymentViewState => {
  if (typeof dueMinor !== 'number' || !Number.isFinite(dueMinor)) return 'UNAVAILABLE';
  if (typeof customerHasPositiveCredit !== 'boolean') return 'UNAVAILABLE';
  const status = String(orderStatus ?? '').toUpperCase();
  if (dueMinor <= 0 && ['DELIVERED', 'COMPLETED'].includes(status)) return 'PAID';
  if (submission?.status === 'PENDING') return 'PENDING';
  if (dueMinor <= 0) return customerHasPositiveCredit && customerCreditCoversOrder === true ? 'CREDIT_COVERED' : 'NOT_DUE';
  // An approved receipt is not proof that the order is fully paid. The server's
  // outstanding amount is authoritative; classify a remaining balance separately.
  if (typeof orderTotalMinor === 'number' && Number.isFinite(orderTotalMinor) && orderTotalMinor > dueMinor) {
    return 'PARTIALLY_PAID';
  }
  if (submission?.status === 'APPROVED') return 'APPROVED';
  if (submission?.status === 'REJECTED') return 'REJECTED';
  // The server-calculated due is already net of available positive customer credit.
  // Any positive remainder is payable even when some customer credit remains.
  return 'UNPAID';
};

/**
 * Derives the background state from the live order operational & financial data.
 */
export const computeBackgroundStateFromOrder = (order: PublicOrderQrData | null): BackgroundState => {
  if (!order) return 'charging';
  const status = (order.status || '').toUpperCase();
  const due = typeof order.orderDueMinor === 'number' ? order.orderDueMinor : 0;

  if (status === 'DELIVERED' || status === 'COMPLETED') {
    return due > 0 ? 'delivered-unpaid' : 'delivered-paid';
  }
  if (status === 'READY' || status === 'READY_FOR_PICKUP') {
    return 'charged';
  }
  // CHARGING, IN_PROGRESS, PROCESSING, PENDING, or default
  return 'charging';
};

export const PublicOrderPage: React.FC<PublicOrderPageProps> = ({ token }) => {
  const { locale, setLocale, formatCurrency, isRTL } = useI18n();
  const { theme, setTheme } = useTheme();
  const isAr = locale === 'ar';

  const [data, setData] = useState<PublicOrderQrData | null>(null);
  const [submission, setSubmission] = useState<PublicQrPaymentSubmissionRpcResult | null>(null);
  const [customerCreditCoversOrder, setCustomerCreditCoversOrder] = useState<boolean | null>(null);
  const [customerAccountId, setCustomerAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const requestGeneration = useRef(0);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // Background state controller with unified setter:
  // setBackgroundState('charging' | 'charged' | 'delivered-paid' | 'delivered-unpaid')
  const [backgroundState, setBackgroundState] = useState<BackgroundState>('charging');

  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let active = true;
    setCustomerAccountId(null);
    if (!online || !token) return () => { active = false; };
    rpcResolveOrderQrCustomerId(token).then((customerId) => {
      if (active) setCustomerAccountId(customerId);
    }).catch((err) => {
      console.warn('Could not resolve the customer account entry for this order QR:', err);
    });
    return () => { active = false; };
  }, [token, online]);

  // Only show a credit-covered message when the server confirms the current credit
  // covers the full order total; a positive balance alone is not sufficient evidence.
  useEffect(() => {
    let active = true;
    const status = String(data?.status ?? '').toUpperCase();
    const needsCoverageCheck = Boolean(
      online && data && data.customerHasPositiveCredit &&
      typeof data.orderDueMinor === 'number' && data.orderDueMinor <= 0 &&
      !['DELIVERED', 'COMPLETED'].includes(status)
    );
    if (!needsCoverageCheck) {
      setCustomerCreditCoversOrder(false);
      return () => { active = false; };
    }
    setCustomerCreditCoversOrder(null);
    rpcResolveOrderQrCreditCoverage(token).then((covered) => {
      if (active) setCustomerCreditCoversOrder(covered);
    }).catch((err) => {
      console.warn('Could not verify whether customer credit covers the full order:', err);
      if (active) setCustomerCreditCoversOrder(false);
    });
    return () => { active = false; };
  }, [token, online, data?.customerHasPositiveCredit, data?.orderDueMinor, data?.status, data?.orderTotalMinor]);

  // Update background state whenever live order data updates
  useEffect(() => {
    if (data) {
      const derived = computeBackgroundStateFromOrder(data);
      setBackgroundState(derived);
    }
  }, [data]);

  // Initial order fetch. Public financial data is never retained across an offline transition.
  useEffect(() => {
    let active = true;
    const requestId = ++requestGeneration.current;
    setLoading(true);
    setError(false);
    setSubmission(null);
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setData(null);
      setError(true);
      setLoading(false);
      return () => { active = false; requestGeneration.current += 1; };
    }

    getPublicOrderByToken(token)
      .then((result) => {
        if (!active || requestId !== requestGeneration.current || !navigator.onLine) return;
        if (result) {
          setData(result);
          void rpcResolveQrPaymentSubmission(token).then((latest) => {
            if (active && requestId === requestGeneration.current && navigator.onLine && latest) setSubmission(latest);
          }).catch((err) => {
            console.warn('Could not resolve public order payment status:', err);
          });
        } else {
          setData(null);
          setError(true);
        }
      })
      .catch((err) => {
        console.error('Failed to load public order data:', err);
        if (active && requestId === requestGeneration.current) {
          setData(null);
          setSubmission(null);
          setError(true);
        }
      })
      .finally(() => {
        if (active && requestId === requestGeneration.current) setLoading(false);
      });
    return () => {
      active = false;
      requestGeneration.current += 1;
    };
  }, [token, online]);

  useEffect(() => {
    const onOffline = () => {
      requestGeneration.current += 1;
      setOnline(false);
      setData(null);
      setSubmission(null);
      setError(true);
      setLoading(false);
    };
    const onOnline = () => setOnline(true);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  // Read-only refresh keeps the QR page aligned with server-side review and payment allocation.
  useEffect(() => {
    let active = true;
    let refreshing = false;

    const refreshPublicPaymentState = async () => {
      if (!active || refreshing || (typeof navigator !== 'undefined' && !navigator.onLine)) return;
      refreshing = true;
      const requestId = requestGeneration.current;
      try {
        const [latestOrder, latestSubmission] = await Promise.all([
          rpcResolveOrderQr(token),
          rpcResolveQrPaymentSubmission(token),
        ]);
        if (!active || requestId !== requestGeneration.current || !navigator.onLine) return;
        // Poll the server RPC directly; stale responses are ignored after route changes/offline transitions.
        if (latestOrder) {
          setData((current) => current ? {
            ...current,
            status: latestOrder.status,
            orderTotalMinor: latestOrder.order_total_minor,
            orderDueMinor: latestOrder.order_due_minor,
            customerHasPositiveCredit: typeof latestOrder.customer_has_positive_credit === 'boolean'
              ? latestOrder.customer_has_positive_credit
              : current.customerHasPositiveCredit,
            orderQrSubmissionLimitReached: typeof latestOrder.order_qr_submission_limit_reached === 'boolean'
              ? latestOrder.order_qr_submission_limit_reached
              : current.orderQrSubmissionLimitReached,
          } : current);
        }
        // Null can mean a temporary RPC failure; do not erase a previously confirmed state.
        if (latestSubmission) setSubmission(latestSubmission);
      } catch (err) {
        console.warn('Could not refresh public order payment status:', err);
      } finally {
        refreshing = false;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshPublicPaymentState();
    };
    const intervalId = window.setInterval(() => void refreshPublicPaymentState(), 15000);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      active = false;
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [token]);

  // Retry order fetch handler (used on error fallback)
  const refreshOrder = async () => {
    const requestId = ++requestGeneration.current;
    setLoading(true);
    try {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setData(null);
        setSubmission(null);
        setError(true);
        return;
      }
      const result = await getPublicOrderByToken(token);
      if (requestId !== requestGeneration.current || !navigator.onLine) return;
      if (result) {
        setData(result);
        setError(false);
        const latest = await rpcResolveQrPaymentSubmission(token);
        if (requestId === requestGeneration.current && navigator.onLine && latest) setSubmission(latest);
      } else {
        setData(null);
        setSubmission(null);
        setError(true);
      }
    } catch (err) {
      console.error('Failed to reload public order data:', err);
      if (requestId === requestGeneration.current) {
        setData(null);
        setSubmission(null);
        setError(true);
      }
    } finally {
      if (requestId === requestGeneration.current) setLoading(false);
    }
  };

  // Close dropdown on click outside or Escape key
  const handleOutsideClick = useCallback((event: MouseEvent | TouchEvent) => {
    if (
      menuRef.current &&
      !menuRef.current.contains(event.target as Node) &&
      menuButtonRef.current &&
      !menuButtonRef.current.contains(event.target as Node)
    ) {
      setIsMenuOpen(false);
    }
  }, []);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      setIsMenuOpen(false);
      menuButtonRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (isMenuOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
      document.addEventListener('touchstart', handleOutsideClick);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('touchstart', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMenuOpen, handleOutsideClick, handleKeyDown]);

  const formatDate = (dateString?: string) => {
    if (!dateString) return '—';
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString(isAr ? 'ar-PS' : 'en-GB', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const itemOperationalLabel = (value?: string) => {
    const key = (value || '').toUpperCase();
    if (key === 'DELIVERED') return isAr ? 'تم التسليم' : 'Delivered';
    if (key === 'CANCELLED' || key === 'CANCELED') return isAr ? 'ملغي' : 'Cancelled';
    if (key === 'READY' || key === 'READY_FOR_PICKUP') return isAr ? 'جاهز للاستلام' : 'Ready';
    if (key === 'CHARGING' || key === 'IN_PROGRESS' || key === 'PROCESSING') return isAr ? 'قيد الشحن' : 'Charging';
    return value || (isAr ? 'قيد المعالجة' : 'In progress');
  };

  const itemPaymentLabel = (value?: string) => {
    const key = (value || '').toUpperCase();
    if (key === 'PAID') return isAr ? 'مدفوع' : 'Paid';
    if (key === 'PARTIALLY_PAID' || key === 'PARTIAL') return isAr ? 'مدفوع جزئياً' : 'Part-paid';
    if (key === 'UNPAID') return isAr ? 'غير مدفوع' : 'Unpaid';
    return '';
  };

  const getOrderStatusConfig = (value?: string, dueMinor?: number) => {
    const key = (value || '').toUpperCase();
    const due = typeof dueMinor === 'number' ? dueMinor : 0;

    if (['CHARGING', 'IN_PROGRESS', 'IN_PROGRESS_CHARGING', 'PROCESSING'].includes(key)) {
      return {
        label: isAr ? 'قيد الشحن' : 'Charging',
        icon: BatteryCharging,
        className: 'is-charging',
      };
    }
    if (['READY', 'READY_FOR_PICKUP'].includes(key)) {
      return {
        label: isAr ? 'جاهز للاستلام' : 'Ready for pickup',
        icon: CheckCircle2,
        className: 'is-ready',
      };
    }
    if (['DELIVERED', 'COMPLETED'].includes(key)) {
      if (due > 0) {
        return {
          label: isAr ? 'تم التسليم (غير مدفوع)' : 'Delivered (Unpaid)',
          icon: PackageCheck,
          className: 'is-delivered-unpaid',
        };
      }
      return {
        label: isAr ? 'تم التسليم (مدفوع)' : 'Delivered & Paid',
        icon: PackageCheck,
        className: 'is-delivered-paid',
      };
    }
    if (['CANCELLED', 'CANCELED'].includes(key)) {
      return {
        label: isAr ? 'ملغي' : 'Cancelled',
        icon: CircleAlert,
        className: 'is-cancelled',
      };
    }
    return {
      label: isAr ? 'قيد المعالجة' : 'In progress',
      icon: Clock3,
      className: 'is-pending',
    };
  };

  const total = data?.orderTotalMinor;
  const due = data?.orderDueMinor;
  const paid =
    typeof total === 'number' && typeof due === 'number' && total >= due
      ? total - due
      : undefined;

  const statusConfig = getOrderStatusConfig(data?.status, due);
  const paymentViewState = getOrderPaymentViewState(due, submission, data?.customerHasPositiveCredit, data?.status, customerCreditCoversOrder, total);
  const orderQrSubmissionLimitReached = data?.orderQrSubmissionLimitReached === true;
  const StatusIcon = statusConfig.icon;

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} className="order-public-qr-page order-mountain-auth">
      <div className="order-mountain-auth__backdrop" aria-hidden="true">
        <CustomerAuthScene uid="order-qr-page-background" />
      </div>

      {/* Header & Settings Bar (Without extra reload button) */}
      <header className="order-qr-header">
        <div className="order-qr-header__inner">
          <a
            href="/public/about"
            className="order-brand"
            aria-label={isAr ? 'الصفحة التعريفية' : 'About page'}
          >
            <AppLogo size={36} variant="dark" />
            <span className="order-brand__text">
              <strong>{isAr ? 'نقطة الشحن' : 'Charging Point'}</strong>
              <span>{isAr ? 'متابعة الطلب' : 'Order Tracking'}</span>
            </span>
          </a>

          <div className="order-qr-controls">
            {/* Menu / Settings Button */}
            <button
              ref={menuButtonRef}
              type="button"
              className={`order-icon-button ${isMenuOpen ? 'order-icon-button--active' : ''}`}
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              aria-expanded={isMenuOpen}
              aria-haspopup="true"
              aria-label={isAr ? 'الإعدادات والمظهر' : 'Settings and theme'}
              title={isAr ? 'الإعدادات' : 'Settings'}
            >
              <Settings2 size={17} />
              <span className="hidden sm:inline">{isAr ? 'الإعدادات' : 'Settings'}</span>
            </button>

            {/* Accessible Dropdown Menu */}
            {isMenuOpen && (
              <div
                ref={menuRef}
                className="order-settings-dropdown"
                role="menu"
                aria-orientation="vertical"
              >
                {/* Theme Selector */}
                <div className="order-dropdown-group">
                  <span className="order-dropdown-label">
                    <Sun size={13} />
                    <span>{isAr ? 'المظهر' : 'Appearance'}</span>
                  </span>
                  <div className="order-dropdown-options">
                    <button
                      type="button"
                      role="menuitem"
                      className={`order-dropdown-item ${theme === 'light' ? 'order-dropdown-item--selected' : ''}`}
                      onClick={() => {
                        setTheme('light');
                        setIsMenuOpen(false);
                      }}
                    >
                      <div>
                        <Sun size={15} />
                        <span>{isAr ? 'فاتح' : 'Light'}</span>
                      </div>
                      {theme === 'light' && <Check size={14} />}
                    </button>

                    <button
                      type="button"
                      role="menuitem"
                      className={`order-dropdown-item ${theme === 'dark' ? 'order-dropdown-item--selected' : ''}`}
                      onClick={() => {
                        setTheme('dark');
                        setIsMenuOpen(false);
                      }}
                    >
                      <div>
                        <Moon size={15} />
                        <span>{isAr ? 'داكن' : 'Dark'}</span>
                      </div>
                      {theme === 'dark' && <Check size={14} />}
                    </button>

                    <button
                      type="button"
                      role="menuitem"
                      className={`order-dropdown-item ${theme === 'system' ? 'order-dropdown-item--selected' : ''}`}
                      onClick={() => {
                        setTheme('system');
                        setIsMenuOpen(false);
                      }}
                    >
                      <div>
                        <Monitor size={15} />
                        <span>{isAr ? 'تلقائي (حسب النظام)' : 'Auto (System)'}</span>
                      </div>
                      {theme === 'system' && <Check size={14} />}
                    </button>
                  </div>
                </div>

                <div className="order-dropdown-divider" />

                {/* Language Selector */}
                <div className="order-dropdown-group">
                  <span className="order-dropdown-label">
                    <Globe size={13} />
                    <span>{isAr ? 'اللغة' : 'Language'}</span>
                  </span>
                  <div className="order-dropdown-options">
                    <button
                      type="button"
                      role="menuitem"
                      className={`order-dropdown-item ${locale === 'ar' ? 'order-dropdown-item--selected' : ''}`}
                      onClick={() => {
                        setLocale('ar');
                        setIsMenuOpen(false);
                      }}
                    >
                      <div>
                        <span>العربية</span>
                      </div>
                      {locale === 'ar' && <Check size={14} />}
                    </button>

                    <button
                      type="button"
                      role="menuitem"
                      className={`order-dropdown-item ${locale === 'en' ? 'order-dropdown-item--selected' : ''}`}
                      onClick={() => {
                        setLocale('en');
                        setIsMenuOpen(false);
                      }}
                    >
                      <div>
                        <span>English</span>
                      </div>
                      {locale === 'en' && <Check size={14} />}
                    </button>
                  </div>
                </div>

                <div className="order-dropdown-divider" />

                <a
                  href={customerAccountId
                    ? `/c/login?customerId=${encodeURIComponent(customerAccountId)}`
                    : `/c/login?orderQrToken=${encodeURIComponent(token)}`}
                  className="order-dropdown-item order-account-entry"
                  role="menuitem"
                  onClick={() => setIsMenuOpen(false)}
                >
                  <div>
                    <UserRound size={15} />
                    <span>{isAr ? 'تسجيل دخول حساب العميل' : 'Customer Account Sign In'}</span>
                  </div>
                  <ArrowUpRight size={14} aria-hidden="true" />
                </a>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Order View Container */}
      <main className="order-qr-main">
        {loading ? (
          <div className="order-state-direct" aria-live="polite">
            <div className="order-loader-ring" />
            <p>{isAr ? 'جارٍ تحميل تفاصيل الطلب…' : 'Loading order details…'}</p>
          </div>
        ) : error || !data ? (
          <div className="order-state-direct" aria-live="polite">
            <div className="order-state-icon-error">
              <CircleHelp size={28} />
            </div>
            <h2>{isAr ? 'تعذّر عرض بيانات الطلب' : 'Unable to Load Order'}</h2>
            <p>
              {isAr
                ? 'تأكد من فتح رابط رمز QR الصحيح أو تواصل مع نقطة الشحن.'
                : 'Make sure you scanned the correct QR code or contact the service counter.'}
            </p>
            <button
              type="button"
              className="order-retry-btn"
              onClick={() => void refreshOrder()}
            >
              <RefreshCw size={14} />
              <span>{isAr ? 'إعادة المحاولة' : 'Try Again'}</span>
            </button>
          </div>
        ) : (
          <>
            <div className="order-qr-content-layout">
              <div className="order-qr-primary-content">
            {/* 1. Main Order Details Crystal Card (Refined, Well-Spaced, Airy) */}
            <article className={`order-crystal-card state-${backgroundState}`}>
              {/* Order Header: ID & Live Status */}
              <div className="order-card-header">
                <div className="order-hero-top">
                  <div className="order-number-display">
                    <span className="order-hero-label">{isAr ? 'طلب رقم' : 'ORDER'}</span>
                    <h1 className="order-hero-number" dir="ltr">#{data.orderNumber}</h1>
                  </div>
                  <div className={`order-status-badge ${statusConfig.className}`}>
                    <StatusIcon size={15} />
                    <span>{statusConfig.label}</span>
                  </div>
                </div>

                {/* Customer & Timestamp row */}
                <div className="order-meta-row">
                  <div className="order-meta-customer">
                    <div className="order-customer-avatar" aria-hidden="true">
                      <UserRound size={13} />
                    </div>
                    <span className="order-customer-name">{data.customerName}</span>
                    {data.customerCode && (
                      <span className="order-customer-code-tag" dir="ltr">
                        {data.customerCode}
                      </span>
                    )}
                  </div>

                  <div className="order-meta-date">
                    <CalendarClock size={14} />
                    <time dateTime={data.createdAt}>{formatDate(data.createdAt)}</time>
                  </div>
                </div>
              </div>

              <div className="order-crystal-divider" />

              {/* Devices Section: Clean line rows with elegant breathing room */}
              <div className="order-devices-section">
                <div className="order-devices-title-row">
                  <div className="order-devices-heading">
                    <Smartphone size={16} />
                    <h2>{isAr ? 'الأجهزة المسجلة' : 'Registered Devices'}</h2>
                  </div>
                  <span className="order-devices-count">
                    {data.itemsCount} {isAr ? (data.itemsCount === 1 ? 'جهاز' : 'أجهزة') : (data.itemsCount === 1 ? 'device' : 'devices')}
                  </span>
                </div>

                <div className="order-devices-list">
                  {data.items?.length ? (
                    data.items.map((item, index) => (
                      <div className="order-device-row" key={`${item.name}-${index}`}>
                        <div className="order-device-body">
                          <div className="order-device-title">
                            {locale === 'en'
                              ? (item.name_en || getItemLocalizedDeviceName(item.device_type_id || item.name, 'en', item.name))
                              : (item.name_ar || item.name)}
                          </div>
                          <div className="order-device-tags">
                            <span className="order-tag-inline">
                              {item.has_charger ? (
                                <>
                                  <Zap size={11} className="text-emerald-500" />
                                  <span>{isAr ? 'مع شاحن' : 'With charger'}</span>
                                </>
                              ) : (
                                <span>{isAr ? 'بدون شاحن' : 'No charger'}</span>
                              )}
                            </span>

                            {(item.quantity ?? 1) > 1 && (
                              <span className="order-tag-inline">
                                {isAr ? 'الكمية' : 'Qty'}: {item.quantity}
                              </span>
                            )}

                            {item.charger_fee_exempt && (
                              <span className="order-tag-inline is-exempt">
                                {isAr ? 'إعفاء من الرسوم' : 'Fee waived'}
                              </span>
                            )}

                            {(item.operational_status || item.status) && (
                              <span className="order-tag-inline">
                                {itemOperationalLabel(item.operational_status || item.status)}
                              </span>
                            )}

                            {itemPaymentLabel(item.payment_status) && (
                              <span
                                className={`order-tag-inline ${
                                  item.payment_status?.toUpperCase() === 'PAID'
                                    ? 'is-paid'
                                    : 'is-unpaid'
                                }`}
                              >
                                {itemPaymentLabel(item.payment_status)}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="order-device-price">
                          {typeof item.total_price_minor === 'number'
                            ? formatCurrency(item.total_price_minor)
                            : '—'}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="order-empty-items">
                      {isAr ? 'لا توجد أجهزة مسجلة لهذا الطلب.' : 'No devices recorded for this order.'}
                    </div>
                  )}
                </div>
              </div>

              {/* Financial & Payment Section (Inside the single crystal card) */}
              <div className="order-financial-integrated-section">
                {paymentViewState === 'UNPAID' ||
                paymentViewState === 'PENDING' ||
                paymentViewState === 'APPROVED' ||
                paymentViewState === 'PARTIALLY_PAID' ||
                paymentViewState === 'REJECTED' ||
                paymentViewState === 'CREDIT_COVERED' ||
                paymentViewState === 'NOT_DUE' ? (
                  <>
                    <div className="order-price-showcase">
                      <div className="order-price-line" />
                      <div className="order-price-value" dir="ltr">
                        {typeof total === 'number' ? formatCurrency(total) : '—'}
                      </div>
                      <div className="order-price-line" />
                    </div>

                    {paymentViewState === 'PENDING' && (
                      <div className="order-fully-paid-banner order-payment-notice is-pending" role="status" aria-live="polite">
                        <div className="order-fully-paid-icon" aria-hidden="true"><Clock3 size={22} /></div>
                        <div className="order-fully-paid-text">
                          <h3>{isAr ? 'إشعار الدفع قيد المراجعة' : 'Payment notification under review'}</h3>
                          <p>{isAr
                            ? 'استلمنا إشعار الدفع لهذا الطلب. لا تحتاج لإرسال إشعار آخر؛ ستتحدث الحالة بعد انتهاء المراجعة.'
                            : 'We received a payment notification for this order. No need to submit another one; this status will update after review.'}</p>
                        </div>
                      </div>
                    )}

                    {paymentViewState === 'APPROVED' && (
                      <div className="order-fully-paid-banner order-payment-notice is-approved" role="status" aria-live="polite">
                        <div className="order-fully-paid-icon" aria-hidden="true"><CheckCircle2 size={22} /></div>
                        <div className="order-fully-paid-text">
                          <h3>{isAr ? 'تم قبول الدفع' : 'Payment accepted'}</h3>
                          <p>{data.customerHasPositiveCredit
                            ? (isAr
                                ? `تم اعتماد الدفعة واحتساب رصيدك الموجب. المبلغ المتبقي عليك: ${formatCurrency(due ?? 0)}.`
                                : `Your payment was approved and your positive credit was applied. Remaining amount due: ${formatCurrency(due ?? 0)}.`)
                            : (isAr
                                ? `تم اعتماد الدفعة لهذا الطلب. المبلغ المتبقي: ${formatCurrency(due ?? 0)}.`
                                : `Your payment was approved for this order. Remaining balance: ${formatCurrency(due ?? 0)}.`)}</p>
                        </div>
                      </div>
                    )}

                    {paymentViewState === 'PARTIALLY_PAID' && (
                      <div className="order-fully-paid-banner order-payment-notice is-approved" role="status" aria-live="polite">
                        <div className="order-fully-paid-icon" aria-hidden="true"><CheckCircle2 size={22} /></div>
                        <div className="order-fully-paid-text">
                          <h3>{isAr ? 'الطلب مدفوع جزئياً' : 'Order Partially Paid'}</h3>
                          <p>{submission?.status === 'APPROVED'
                            ? (isAr ? `تم قبول الدفعة، لكن بقي ${formatCurrency(due ?? 0)} مستحقاً على هذا الطلب.` : `Payment accepted, but ${formatCurrency(due ?? 0)} remains due on this order.`)
                            : (isAr ? `تم سداد جزء من قيمة الطلب. المبلغ المتبقي: ${formatCurrency(due ?? 0)}.` : `Part of this order has been paid. Remaining balance: ${formatCurrency(due ?? 0)}.`)}</p>
                        </div>
                      </div>
                    )}

                    {paymentViewState === 'CREDIT_COVERED' && (
                      <>
                        <div className="order-fully-paid-banner order-payment-notice is-approved" role="status" aria-live="polite">
                          <div className="order-fully-paid-icon" aria-hidden="true"><Wallet size={22} /></div>
                          <div className="order-fully-paid-text">
                            <h3>{isAr ? 'سيتم تغطية هذا الطلب من رصيدك' : 'This order will be covered by your balance'}</h3>
                          </div>
                        </div>
                        <div className="order-integrated-pay-action order-credit-options-action">
                          <p>{isAr ? 'هل ترغب بالاطلاع على خيارات الدفع؟' : 'Would you like to view the payment options?'}</p>
                          <a href={`/pay/${encodeURIComponent(token)}`} className="order-pay-crystal-button">
                            <CreditCard size={18} className="order-pay-btn-icon" aria-hidden="true" />
                            <span className="order-pay-btn-label">{isAr ? 'عرض خيارات الدفع' : 'View Payment Options'}</span>
                          </a>
                        </div>
                      </>
                    )}

                    {paymentViewState === 'NOT_DUE' && (
                      <div className="order-fully-paid-banner order-payment-notice is-pending" role="status" aria-live="polite">
                        <div className="order-fully-paid-icon" aria-hidden="true"><Clock3 size={22} /></div>
                        <div className="order-fully-paid-text">
                          <h3>{isAr ? 'لا يوجد مبلغ مستحق قبل التسليم' : 'No payment is due before delivery'}</h3>
                          <p>{isAr
                            ? 'الأجهزة التي ما زالت قيد الشحن لا تُحتسب كمبلغ مستحق للدفع. حدّث رمز QR بعد التسليم لمعرفة المبلغ الفعلي.'
                            : 'Devices still charging are not treated as payable charges. Refresh this QR after delivery to see the actual amount due.'}</p>
                        </div>
                      </div>
                    )}

                    {paymentViewState === 'REJECTED' && (
                      <div className="order-fully-paid-banner order-payment-notice is-rejected" role="status" aria-live="polite">
                        <div className="order-fully-paid-icon" aria-hidden="true"><CircleAlert size={22} /></div>
                        <div className="order-fully-paid-text">
                          <h3>{isAr ? 'لم يتم قبول إشعار الدفع' : 'Payment notification was not accepted'}</h3>
                          <p>{data.customerHasPositiveCredit
                            ? (isAr
                                ? `لم يُعتمد إشعار الدفع. تم احتساب رصيدك الموجب، لكن ما زال عليك مبلغ متبقٍ: ${formatCurrency(due ?? 0)}. يمكنك إرسال إشعار جديد لهذا المبلغ.`
                                : `The payment notification was not approved. Your positive credit was applied, but ${formatCurrency(due ?? 0)} remains due. You can submit a new notification for that remainder.`)
                            : (isAr
                                ? 'لم يُسجَّل هذا الإشعار كدفعة. يمكنك مراجعة الإيصال وإرسال إشعار جديد.'
                                : 'This notification was not credited as a payment. Review your receipt and submit a new notification.')}</p>
                        </div>
                      </div>
                    )}

                    {orderQrSubmissionLimitReached && typeof due === 'number' && due > 0 && submission?.status !== 'PENDING' && (
                      <div className="order-fully-paid-banner order-payment-notice is-rejected" role="status" aria-live="polite">
                        <div className="order-fully-paid-icon" aria-hidden="true"><CircleAlert size={22} /></div>
                        <div className="order-fully-paid-text">
                          <h3>{isAr ? 'تم بلوغ الحد الأقصى لإشعارات هذا الطلب' : 'This order has reached its notification limit'}</h3>
                          <p>{isAr
                            ? 'تم استخدام الإشعارات الثلاثة المسموح بها لهذا الرمز. تواصل مع نقطة الشحن لمتابعة أي مبلغ متبقٍ.'
                            : 'All three notifications allowed for this QR have been used. Contact Charging Point to resolve any remaining amount.'}</p>
                        </div>
                      </div>
                    )}

                    {(paymentViewState === 'UNPAID' || paymentViewState === 'REJECTED') && !orderQrSubmissionLimitReached && (
                      <div className="order-integrated-pay-action">
                        <a href={`/pay/${encodeURIComponent(token)}`} className="order-pay-crystal-button">
                          <CreditCard size={18} className="order-pay-btn-icon" aria-hidden="true" />
                          <span className="order-pay-btn-label">{isAr ? 'ادفع الآن' : 'Pay Now'}</span>
                        </a>
                      </div>
                    )}

                    {(paymentViewState === 'APPROVED' || paymentViewState === 'PARTIALLY_PAID') && !orderQrSubmissionLimitReached && (
                      <div className="order-integrated-pay-action">
                        <a href={`/pay/${encodeURIComponent(token)}`} className="order-pay-crystal-button">
                          <CreditCard size={18} className="order-pay-btn-icon" aria-hidden="true" />
                          <span className="order-pay-btn-label">{paymentViewState === 'PARTIALLY_PAID' ? (isAr ? 'استكمال الدفع' : 'Complete Payment') : (isAr ? 'سداد المتبقي' : 'Pay Remaining Balance')}</span>
                        </a>
                      </div>
                    )}
                  </>
                ) : paymentViewState === 'PAID' ? (
                  <>
                    <div className="order-fully-paid-banner">
                      <div className="order-fully-paid-icon" aria-hidden="true"><CheckCircle2 size={22} /></div>
                      <div className="order-fully-paid-text">
                        <h3>{submission?.status === 'APPROVED'
                          ? (isAr ? 'تم قبول الدفع وسداد الطلب بالكامل' : 'Payment accepted — order paid in full')
                          : (isAr ? 'تم سداد الطلب بالكامل' : 'Order Paid in Full')}</h3>
                        <p>{isAr ? 'شكراً لتعاملك مع نقطة الشحن' : 'Thank you for choosing Charging Point'}</p>
                      </div>
                    </div>

                    <div className="order-price-showcase is-paid-complete">
                      <div className="order-price-line" />
                      <div className="order-price-value" dir="ltr">
                        {typeof total === 'number' ? formatCurrency(total) : '—'}
                      </div>
                      <div className="order-price-line" />
                    </div>
                  </>
                ) : (
                  <div className="order-fully-paid-banner order-payment-notice is-unavailable" role="status" aria-live="polite">
                    <div className="order-fully-paid-icon" aria-hidden="true"><CircleAlert size={22} /></div>
                    <div className="order-fully-paid-text">
                      <h3>{isAr ? 'تعذّر التحقق من حالة الدفع' : 'Unable to verify payment status'}</h3>
                      <p>{isAr
                        ? 'لم نتمكن من التحقق من المبلغ المستحق حالياً. حدّث الصفحة بعد التأكد من اتصال الإنترنت.'
                        : 'We could not verify the outstanding balance right now. Refresh this page after checking your internet connection.'}</p>
                    </div>
                  </div>
                )}
              </div>
            </article>

            {/* 4. Sole Permitted Exception: Explore charging services link card */}
            <section className="order-about-exception-section">
              <a href="/public/about" className="order-about-link-card">
                <div className="order-about-icon">
                  <Sparkles size={19} />
                </div>
                <div className="order-about-text">
                  <strong>{isAr ? 'تابع الجديد من نقطة الشحن' : 'See What’s New at Charging Point'}</strong>
                  <span>{isAr ? 'تعرّف على الأحداث والعروض وأيام الشحن المجانية عند توفرها.' : 'Check for events, offers and free-charging days when available.'}</span>
                </div>
                <ArrowUpRight size={17} className="order-about-arrow" />
              </a>
            </section>
              </div>

              {/* Desktop-only supporting visual; order details and payment actions remain unchanged. */}
              <aside className="order-qr-visual" aria-label={isAr ? 'معلومات عن خدمة الشحن' : 'Charging service information'}>
                <div className="order-qr-visual-art" aria-hidden="true">
                  <CustomerAuthScene uid="order-qr-page-hero" />
                </div>
                <div className="order-qr-visual-copy">
                    <p className="order-qr-visual-eyebrow">{isAr ? 'كل التفاصيل بمكان واحد' : 'YOUR ORDER, AT A GLANCE'}</p>
                    <h2>{isAr ? 'تابع طلبك بكل سهولة' : 'Your charging order, made simple'}</h2>
                    <p>{isAr
                      ? 'تفاصيل الأجهزة وحالة الشحن والمبلغ المستحق ظاهرة بوضوح، حتى تتابع طلبك من أي جهاز.'
                      : 'See your registered devices, charging status and balance clearly, all in one place from any device.'}</p>
                    <div className="order-qr-visual-points">
                      <span><Smartphone size={15} />{isAr ? 'تفاصيل الأجهزة' : 'Device details'}</span>
                      <span><CheckCircle2 size={15} />{isAr ? 'تحديث حالة الطلب' : 'Order status at a glance'}</span>
                      <span><ShieldCheck size={15} />{isAr ? 'عرض آمن للتفاصيل' : 'Secure details'}</span>
                    </div>
                </div>
              </aside>
            </div>
          </>
        )}
      </main>

      {/* Minimal Footer */}
      <footer className="order-qr-footer">
        <span>{isAr ? 'نقطة الشحن' : 'Charging Point'} &copy; 2026</span>
      </footer>
    </div>
  );
};
