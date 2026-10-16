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
import { EnergyCanvasBackground, BackgroundState } from '../energy/EnergyCanvasBackground';
import { rpcResolveOrderQr, rpcResolveQrPaymentSubmission, type PublicQrPaymentSubmissionRpcResult } from '../../services/supabase/client';

export interface PublicOrderPageProps {
  token: string;
}

/**
 * Derives the public payment action from the canonical balance and QR-specific submission state.
 */
export type OrderPaymentViewState = 'PAID' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'UNPAID' | 'CREDIT_COVERED' | 'NOT_DUE' | 'UNAVAILABLE';

export const getOrderPaymentViewState = (
  dueMinor: number | null | undefined,
  submission: Pick<PublicQrPaymentSubmissionRpcResult, 'status'> | null,
  customerHasPositiveCredit: boolean | null | undefined,
  orderStatus: string | null | undefined
): OrderPaymentViewState => {
  if (typeof dueMinor !== 'number' || !Number.isFinite(dueMinor)) return 'UNAVAILABLE';
  if (typeof customerHasPositiveCredit !== 'boolean') return 'UNAVAILABLE';
  const status = String(orderStatus ?? '').toUpperCase();
  if (dueMinor <= 0 && ['DELIVERED', 'COMPLETED'].includes(status)) return 'PAID';
  if (submission?.status === 'PENDING') return 'PENDING';
  // Positive account balance is customer credit, not a debt to collect through this QR.
  if (customerHasPositiveCredit) return 'CREDIT_COVERED';
  if (dueMinor <= 0) return 'NOT_DUE';
  if (submission?.status === 'APPROVED') return 'APPROVED';
  if (submission?.status === 'REJECTED') return 'REJECTED';
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
  const { theme, resolvedTheme, setTheme } = useTheme();
  const isAr = locale === 'ar';

  const [data, setData] = useState<PublicOrderQrData | null>(null);
  const [submission, setSubmission] = useState<PublicQrPaymentSubmissionRpcResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // Background state controller with unified setter:
  // setBackgroundState('charging' | 'charged' | 'delivered-paid' | 'delivered-unpaid')
  const [backgroundState, setBackgroundState] = useState<BackgroundState>('charging');

  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  // Update background state whenever live order data updates
  useEffect(() => {
    if (data) {
      const derived = computeBackgroundStateFromOrder(data);
      setBackgroundState(derived);
    }
  }, [data]);

  // Initial order fetch
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    setSubmission(null);
    getPublicOrderByToken(token)
      .then((result) => {
        if (!active) return;
        if (result) {
          setData(result);
          void rpcResolveQrPaymentSubmission(token).then((latest) => {
            if (active && latest) setSubmission(latest);
          }).catch((err) => {
            console.warn('Could not resolve public order payment status:', err);
          });
        } else {
          setError(true);
        }
      })
      .catch((err) => {
        console.error('Failed to load public order data:', err);
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token]);

  // Read-only refresh keeps the QR page aligned with server-side review and payment allocation.
  useEffect(() => {
    let active = true;
    let refreshing = false;

    const refreshPublicPaymentState = async () => {
      if (!active || refreshing) return;
      refreshing = true;
      try {
        const [latestOrder, latestSubmission] = await Promise.all([
          rpcResolveOrderQr(token),
          rpcResolveQrPaymentSubmission(token),
        ]);
        if (!active) return;
        // Poll the server RPC directly. The store's offline fallback is useful for initial
        // display, but must not overwrite a confirmed server balance with stale local data.
        if (latestOrder) {
          setData((current) => current ? {
            ...current,
            status: latestOrder.status,
            orderTotalMinor: latestOrder.order_total_minor,
            orderDueMinor: latestOrder.order_due_minor,
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
    setLoading(true);
    try {
      const result = await getPublicOrderByToken(token);
      if (result) {
        setData(result);
        setError(false);
      } else if (!data) {
        setError(true);
      }
    } catch (err) {
      console.error('Failed to reload public order data:', err);
      if (!data) setError(true);
    } finally {
      setLoading(false);
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
  const paymentViewState = getOrderPaymentViewState(due, submission, data?.customerHasPositiveCredit, data?.status);
  const StatusIcon = statusConfig.icon;

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} className="order-public-qr-page">
      {/* Living Energy Canvas Engine */}
      <EnergyCanvasBackground
        state={backgroundState}
        theme={resolvedTheme}
      />

      {/* Header & Settings Bar (Without extra reload button) */}
      <header className="order-qr-header">
        <div className="order-qr-header__inner">
          <a
            href="/public/about"
            className="order-brand"
            aria-label={isAr ? 'الصفحة التعريفية' : 'About page'}
          >
            <AppLogo size={36} variant="auto" />
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
                          <p>{isAr
                            ? `تم اعتماد الدفعة لهذا الطلب. المبلغ المتبقي: ${formatCurrency(due ?? 0)}.`
                            : `Your payment was approved for this order. Remaining balance: ${formatCurrency(due ?? 0)}.`}</p>
                        </div>
                      </div>
                    )}

                    {paymentViewState === 'CREDIT_COVERED' && (
                      <div className="order-fully-paid-banner order-payment-notice is-approved" role="status" aria-live="polite">
                        <div className="order-fully-paid-icon" aria-hidden="true"><Wallet size={22} /></div>
                        <div className="order-fully-paid-text">
                          <h3>{isAr ? 'رصيدك الموجب سيُستخدم للطلب' : 'Your positive balance will be applied to this order'}</h3>
                          <p>{isAr
                            ? 'لا ترسل دفعة الآن. سيُستخدم رصيدك أولاً لتغطية تكلفة الأجهزة المستحقة، وسيظهر خيار الدفع فقط إذا أصبح عليك مبلغ مستحق بعد تحديث الرصيد.'
                            : 'Do not send a payment now. Your available credit is applied first when delivered devices are financially recognized. A payment option appears only if an amount remains due after the balance updates.'}</p>
                        </div>
                      </div>
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
                          <p>{isAr
                            ? 'لم يُسجَّل هذا الإشعار كدفعة. يمكنك مراجعة الإيصال وإرسال إشعار جديد.'
                            : 'This notification was not credited as a payment. Review your receipt and submit a new notification.'}</p>
                        </div>
                      </div>
                    )}

                    {(paymentViewState === 'UNPAID' || paymentViewState === 'REJECTED') && (
                      <div className="order-integrated-pay-action">
                        <a href={`/pay/${encodeURIComponent(token)}`} className="order-pay-crystal-button">
                          <CreditCard size={18} className="order-pay-btn-icon" aria-hidden="true" />
                          <span className="order-pay-btn-label">{isAr ? 'ادفع الآن' : 'Pay Now'}</span>
                        </a>
                      </div>
                    )}

                    {paymentViewState === 'APPROVED' && (
                      <div className="order-integrated-pay-action">
                        <a href={`/pay/${encodeURIComponent(token)}`} className="order-pay-crystal-button">
                          <CreditCard size={18} className="order-pay-btn-icon" aria-hidden="true" />
                          <span className="order-pay-btn-label">{isAr ? 'سداد المتبقي' : 'Pay Remaining Balance'}</span>
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
                  <strong>{isAr ? 'تعرّف على النقاط وخدمات الدفع' : 'Explore Charging Points & Services'}</strong>
                  <span>{isAr ? 'اكتشف سرعة الشحن ومواقع الصناديق الذكية' : 'Discover smart locker locations & features'}</span>
                </div>
                <ArrowUpRight size={17} className="order-about-arrow" />
              </a>
            </section>
              </div>

              {/* Desktop-only supporting visual; order details and payment actions remain unchanged. */}
              <aside className="order-qr-visual" aria-label={isAr ? 'معلومات عن خدمة الشحن' : 'Charging service information'}>
                <div className="order-qr-visual-art" aria-hidden="true">
                  <svg viewBox="0 0 520 440" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <defs>
                      <linearGradient id="orderVisualPhone" x1="154" y1="68" x2="334" y2="352" gradientUnits="userSpaceOnUse">
                        <stop stopColor="#38BDF8" />
                        <stop offset="1" stopColor="#10B981" />
                      </linearGradient>
                      <linearGradient id="orderVisualScreen" x1="187" y1="110" x2="311" y2="315" gradientUnits="userSpaceOnUse">
                        <stop stopColor="#0F2E3A" />
                        <stop offset="1" stopColor="#0A4B43" />
                      </linearGradient>
                      <radialGradient id="orderVisualGlow" cx="0" cy="0" r="1" gradientTransform="matrix(0 170 -190 0 260 215)" gradientUnits="userSpaceOnUse">
                        <stop stopColor="#10B981" stopOpacity=".26" />
                        <stop offset="1" stopColor="#10B981" stopOpacity="0" />
                      </radialGradient>
                    </defs>
                    <ellipse cx="260" cy="220" rx="205" ry="190" fill="url(#orderVisualGlow)" />
                    <circle cx="260" cy="220" r="145" stroke="currentColor" strokeOpacity=".09" strokeWidth="1.5" strokeDasharray="5 10" />
                    <circle cx="260" cy="220" r="112" stroke="#10B981" strokeOpacity=".25" strokeWidth="1.5" />
                    <g transform="rotate(-8 260 220)">
                      <rect x="157" y="57" width="206" height="326" rx="36" fill="url(#orderVisualPhone)" fillOpacity=".13" stroke="url(#orderVisualPhone)" strokeWidth="3" />
                      <rect x="171" y="76" width="178" height="288" rx="25" fill="url(#orderVisualScreen)" stroke="currentColor" strokeOpacity=".18" />
                      <rect x="222" y="88" width="76" height="7" rx="3.5" fill="currentColor" fillOpacity=".35" />
                      <rect x="198" y="122" width="124" height="124" rx="20" fill="#F0FDFA" fillOpacity=".97" />
                      <path d="M219 145h17v17h-17zM240 145h8v8h-8zM256 145h17v17h-17zM282 145h19v19h-19zM219 166h8v8h-8zM235 166h18v18h-18zM260 169h10v10h-10zM279 174h9v9h-9zM219 187h18v18h-18zM244 190h8v8h-8zM260 187h17v17h-17zM285 195h16v16h-16zM224 215h8v8h-8zM242 211h14v14h-14zM264 215h8v8h-8zM281 215h20v8h-20z" fill="#0F766E" />
                      <path d="m266 257-25 42h22l-8 26 34-46h-22l9-22Z" fill="#34D399" />
                      <rect x="204" y="339" width="110" height="5" rx="2.5" fill="currentColor" fillOpacity=".25" />
                    </g>
                    <g>
                      <rect x="38" y="111" width="112" height="70" rx="18" fill="currentColor" fillOpacity=".045" stroke="currentColor" strokeOpacity=".12" />
                      <circle cx="61" cy="136" r="7" fill="#10B981" />
                      <path d="m57.5 136 2.4 2.4 4.6-5" stroke="#052E2B" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      <rect x="76" y="130" width="55" height="5" rx="2.5" fill="currentColor" fillOpacity=".45" />
                      <rect x="57" y="151" width="73" height="5" rx="2.5" fill="currentColor" fillOpacity=".16" />
                      <rect x="357" y="267" width="126" height="76" rx="19" fill="currentColor" fillOpacity=".045" stroke="currentColor" strokeOpacity=".12" />
                      <rect x="375" y="286" width="27" height="27" rx="9" fill="#10B981" fillOpacity=".18" />
                      <path d="M389 291v17m-5-5h10" stroke="#10B981" strokeWidth="2" strokeLinecap="round" />
                      <rect x="411" y="289" width="51" height="5" rx="2.5" fill="currentColor" fillOpacity=".4" />
                      <rect x="411" y="302" width="39" height="5" rx="2.5" fill="currentColor" fillOpacity=".16" />
                      <rect x="389" y="314" width="73" height="5" rx="2.5" fill="#10B981" fillOpacity=".55" />
                    </g>
                    <circle cx="395" cy="103" r="5" fill="#38BDF8" />
                    <circle cx="115" cy="285" r="4" fill="#10B981" />
                    <path d="M85 225c18 12 27 22 32 39M378 159c19 9 29 20 37 36" stroke="#10B981" strokeOpacity=".5" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 8" />
                  </svg>
                </div>
                <p className="order-qr-visual-eyebrow">{isAr ? 'كل التفاصيل بمكان واحد' : 'YOUR ORDER, AT A GLANCE'}</p>
                <h2>{isAr ? 'تابع طلبك بكل سهولة' : 'Your charging order, made simple'}</h2>
                <p>{isAr
                  ? 'تفاصيل الأجهزة وحالة الشحن والمبلغ المستحق ظاهرة بوضوح، حتى تتابع طلبك من أي جهاز.'
                  : 'See your registered devices, charging status and balance clearly, all in one place from any device.'}</p>
                <div className="order-qr-visual-points">
                  <span><CheckCircle2 size={15} />{isAr ? 'تحديث حالة الطلب' : 'Order status at a glance'}</span>
                  <span><ShieldCheck size={15} />{isAr ? 'عرض آمن للتفاصيل' : 'Secure order details'}</span>
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
