import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  ArrowUpRight, BatteryCharging, CalendarClock, Check, CheckCircle2,
  CircleAlert, CircleHelp, Clock3, CreditCard, Globe,
  Monitor, Moon, PackageCheck, RefreshCw, Settings2,
  Smartphone, Sparkles, Sun, UserRound, Zap,
} from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';
import { AppLogo } from '../qr/AppLogo';
import { getPublicOrderByToken, PublicOrderQrData } from './dayOrdersStore';
import { EnergyCanvasBackground, BackgroundState } from '../energy/EnergyCanvasBackground';

export interface PublicOrderPageProps {
  token: string;
}

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
    getPublicOrderByToken(token)
      .then((result) => {
        if (!active) return;
        if (result) {
          setData(result);
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
                          <div className="order-device-title">{item.name}</div>
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
                {typeof due === 'number' && due > 0 ? (
                  <>
                    {/* Centered Order Price Showcase between two thin elegant horizontal lines */}
                    <div className="order-price-showcase">
                      <div className="order-price-line" />
                      <div className="order-price-value" dir="ltr">
                        {typeof total === 'number' ? formatCurrency(total) : '—'}
                      </div>
                      <div className="order-price-line" />
                    </div>

                    {/* Pay Now Button: Strictly centered label with absolute icon */}
                    <div className="order-integrated-pay-action">
                      <a
                        href={`/pay/${encodeURIComponent(token)}`}
                        className="order-pay-crystal-button"
                      >
                        <CreditCard size={18} className="order-pay-btn-icon" aria-hidden="true" />
                        <span className="order-pay-btn-label">{isAr ? 'ادفع الآن' : 'Pay Now'}</span>
                      </a>
                    </div>
                  </>
                ) : (
                  <>
                    {/* Fully Paid State */}
                    <div className="order-fully-paid-banner">
                      <div className="order-fully-paid-icon" aria-hidden="true">
                        <CheckCircle2 size={22} />
                      </div>
                      <div className="order-fully-paid-text">
                        <h3>{isAr ? 'تم سداد الطلب بالكامل' : 'Order Paid in Full'}</h3>
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
