import React, { useEffect, useState } from 'react';
import {
  ArrowUpRight, BatteryCharging, CalendarClock, CheckCircle2, CircleHelp,
  Clock3, CreditCard, Globe, Moon, PackageCheck, RefreshCw, ShieldCheck,
  Smartphone, Sparkles, Sun, UserRound,
} from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';
import { AppLogo } from '../qr/AppLogo';
import { fetchGlobalAppIdentity } from '../../services/storage/logoStorage';
import { getPublicOrderByToken, PublicOrderQrData } from './dayOrdersStore';

export interface PublicOrderPageProps {
  token: string;
}

export const PublicOrderPage: React.FC<PublicOrderPageProps> = ({ token }) => {
  const { locale, setLocale, formatCurrency, isRTL } = useI18n();
  const { resolvedTheme, toggleTheme } = useTheme();
  const isAr = locale === 'ar';
  const [data, setData] = useState<PublicOrderQrData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    void fetchGlobalAppIdentity().catch((err) => console.warn('Unable to refresh public brand identity:', err));
    getPublicOrderByToken(token)
      .then((result) => {
        if (!active) return;
        if (result) setData(result);
        else setError(true);
      })
      .catch((err) => {
        console.error('Failed to load public order data:', err);
        if (active) setError(true);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);

  const refreshOrder = async () => {
    setRefreshing(true);
    try {
      const result = await getPublicOrderByToken(token);
      if (result) {
        setData(result);
        setError(false);
      } else if (!data) setError(true);
    } catch (err) {
      console.error('Failed to refresh public order data:', err);
      if (!data) setError(true);
    } finally {
      setRefreshing(false);
    }
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return '—';
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString(isAr ? 'ar-PS' : 'en-GB', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
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
    if (key === 'PARTIALLY_PAID') return isAr ? 'مدفوع جزئياً' : 'Part-paid';
    if (key === 'UNPAID') return isAr ? 'غير مدفوع' : 'Unpaid';
    return '';
  };

  const statusInfo = (value?: string) => {
    const key = (value || '').toUpperCase();
    if (['CHARGING', 'IN_PROGRESS', 'IN_PROGRESS_CHARGING', 'PROCESSING'].includes(key)) {
      return { label: isAr ? 'قيد الشحن' : 'Charging', icon: BatteryCharging, className: 'is-charging' };
    }
    if (['READY', 'READY_FOR_PICKUP'].includes(key)) {
      return { label: isAr ? 'جاهز للاستلام' : 'Ready for pickup', icon: CheckCircle2, className: 'is-ready' };
    }
    if (['DELIVERED', 'COMPLETED'].includes(key)) {
      return { label: isAr ? 'تم التسليم' : 'Delivered', icon: PackageCheck, className: 'is-delivered' };
    }
    if (['CANCELLED', 'CANCELED'].includes(key)) {
      return { label: isAr ? 'ملغي' : 'Cancelled', icon: CircleHelp, className: 'is-cancelled' };
    }
    return { label: isAr ? 'قيد المعالجة' : 'In progress', icon: Clock3, className: 'is-pending' };
  };

  const total = data?.orderTotalMinor;
  const due = data?.orderDueMinor;
  const status = statusInfo(data?.status);
  const StatusIcon = status.icon;

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} className="order-public-qr-page">
      <div className="order-energy-field" aria-hidden="true">
        <span className="order-energy-orb order-energy-orb--one" />
        <span className="order-energy-orb order-energy-orb--two" />
        <span className="order-energy-stream order-energy-stream--one" />
        <span className="order-energy-stream order-energy-stream--two" />
        <span className="order-energy-stream order-energy-stream--three" />
        <span className="order-energy-stream order-energy-stream--four" />
        <span className="order-energy-spark order-energy-spark--one" />
        <span className="order-energy-spark order-energy-spark--two" />
        <span className="order-energy-spark order-energy-spark--three" />
        <span className="order-energy-spark order-energy-spark--four" />
      </div>

      <header className="order-qr-header">
        <div className="order-qr-header__inner">
          <a href="/public/about" className="order-brand" aria-label={isAr ? 'الصفحة العامة' : 'Public website'}>
            <AppLogo size={42} variant="auto" />
            <span className="order-brand__text">
              <strong>{isAr ? 'نقطة الشحن' : 'Charging Point'}</strong>
              <span>{isAr ? 'بوابة متابعة طلب الشحن' : 'Order tracking'}</span>
            </span>
          </a>
          <div className="order-qr-controls">
            <button type="button" className="order-icon-button" onClick={() => setLocale(isAr ? 'en' : 'ar')} aria-label={isAr ? 'Switch to English' : 'التبديل إلى العربية'} title={isAr ? 'English' : 'العربية'}>
              <Globe size={17} /><span>{isAr ? 'EN' : 'عربي'}</span>
            </button>
            <button type="button" className="order-icon-button order-theme-button" onClick={toggleTheme} aria-label={resolvedTheme === 'dark' ? (isAr ? 'الوضع الفاتح' : 'Light mode') : (isAr ? 'الوضع الداكن' : 'Dark mode')} title={resolvedTheme === 'dark' ? (isAr ? 'الوضع الفاتح' : 'Light mode') : (isAr ? 'الوضع الداكن' : 'Dark mode')}>
              {resolvedTheme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </div>
      </header>

      <main className="order-qr-main">
        <div className="order-qr-heading">
          <div className="order-secure-pill"><ShieldCheck size={15} /><span>{isAr ? 'جلسة موثقة ومؤمنة' : 'Secure verified session'}</span></div>
          <button type="button" className="order-refresh-button" onClick={() => void refreshOrder()} disabled={loading || refreshing}>
            <RefreshCw size={15} className={refreshing ? 'order-spin' : ''} /><span>{isAr ? 'تحديث' : 'Refresh'}</span>
          </button>
        </div>

        {loading ? (
          <section className="order-state-card" aria-live="polite">
            <span className="order-loader" />
            <h1>{isAr ? 'بوابة متابعة الطلب' : 'Order tracking'}</h1>
            <p>{isAr ? 'جارٍ التحقق من رمز الطلب…' : 'Verifying your order code…'}</p>
          </section>
        ) : error || !data ? (
          <section className="order-state-card order-state-card--error" aria-live="polite">
            <span className="order-state-icon"><CircleHelp size={28} /></span>
            <h1>{isAr ? 'تعذّر عرض الطلب' : 'Unable to load order'}</h1>
            <p>{isAr ? 'تأكد من فتح رمز QR الصحيح ثم حاول مرة أخرى.' : 'Check that you opened the correct order QR and try again.'}</p>
            <button type="button" className="order-primary-button order-retry-button" onClick={() => void refreshOrder()}><RefreshCw size={16} />{isAr ? 'إعادة المحاولة' : 'Try again'}</button>
          </section>
        ) : (
          <div className="order-qr-content">
            <section className="order-glass-card order-details-card">
              <div className="order-card-topline">
                <div className="order-number-block">
                  <span className="order-overline">{isAr ? 'رقم الطلب' : 'ORDER NUMBER'}</span>
                  <strong className="order-number" dir="ltr">#{data.orderNumber}</strong>
                </div>
                <span className={'order-status-pill ' + status.className}><StatusIcon size={16} />{status.label}</span>
              </div>

              <div className="order-customer-strip">
                <span className="order-mini-icon"><UserRound size={18} /></span>
                <div className="order-customer-info">
                  <span className="order-field-label">{isAr ? 'الزبون' : 'CUSTOMER'}</span>
                  <strong>{data.customerName}</strong>
                </div>
                {data.customerCode ? <span className="order-customer-code" dir="ltr">{data.customerCode}</span> : null}
              </div>

              <div className="order-device-heading">
                <div><Smartphone size={18} /><h2>{isAr ? 'الأجهزة' : 'Devices'}</h2></div>
                <span className="order-count">{data.itemsCount}</span>
              </div>

              <div className="order-device-list">
                {data.items?.length ? data.items.map((item, index) => (
                  <article className="order-device-row" key={item.name + '-' + index}>
                    <span className="order-device-icon"><Smartphone size={19} /></span>
                    <div className="order-device-info">
                      <strong>{item.name}</strong>
                      <div className="order-device-tags">
                        <span>{item.has_charger ? (isAr ? 'مع شاحن' : 'With charger') : (isAr ? 'بدون شاحن' : 'No charger')}</span>
                        {(item.quantity ?? 1) > 1 ? <span>{isAr ? 'الكمية' : 'Qty'}: {item.quantity ?? 1}</span> : null}
                        {(item.operational_status || item.status) ? <span className={'order-item-state ' + statusInfo(item.operational_status || item.status).className}>{itemOperationalLabel(item.operational_status || item.status)}</span> : null}
                        {itemPaymentLabel(item.payment_status) ? <span className={item.payment_status?.toUpperCase() === 'PAID' ? 'order-item-paid' : 'order-item-unpaid'}>{itemPaymentLabel(item.payment_status)}</span> : null}
                        {item.charger_fee_exempt ? <span className="order-item-paid">{isAr ? 'إعفاء من الرسوم' : 'Fee waived'}</span> : null}
                      </div>
                    </div>
                    <strong className="order-device-price">{typeof item.total_price_minor === 'number' ? formatCurrency(item.total_price_minor) : '—'}</strong>
                  </article>
                )) : <div className="order-empty-items">{isAr ? 'لا توجد أجهزة مسجلة لهذا الطلب.' : 'No devices are recorded for this order.'}</div>}
              </div>

              <div className="order-detail-meta">
                <div><CalendarClock size={16} /><span>{isAr ? 'تاريخ الطلب' : 'Order date'}</span><strong>{formatDate(data.createdAt)}</strong></div>
                <div><Smartphone size={16} /><span>{isAr ? 'عدد الأجهزة' : 'Devices'}</span><strong>{data.itemsCount}</strong></div>
              </div>
            </section>

            <section className="order-glass-card order-amount-card">
              <div className="order-amount-heading">
                <span className="order-amount-icon"><CreditCard size={22} /></span>
                <div><span className="order-overline">{isAr ? 'قيمة الطلب' : 'ORDER TOTAL'}</span><h2>{isAr ? 'ملخص المبلغ' : 'Amount summary'}</h2></div>
              </div>
              <div className="order-total-value" dir="ltr">{typeof total === 'number' ? formatCurrency(total) : '—'}</div>
              <div className="order-due-row"><span>{isAr ? 'المبلغ المتبقي' : 'Amount due'}</span><strong dir="ltr">{typeof due === 'number' ? formatCurrency(due) : '—'}</strong></div>
              {typeof due === 'number' && due > 0 ? (
                <a href={'/pay/' + encodeURIComponent(token)} className="order-primary-button order-pay-button">
                  <CreditCard size={18} /><span>{isAr ? 'ادفع الآن' : 'Pay now'}</span><ArrowUpRight size={17} className="order-pay-arrow" />
                </a>
              ) : typeof due === 'number' && due === 0 ? (
                <div className="order-paid-confirmation"><CheckCircle2 size={18} /><span>{isAr ? 'تم سداد الطلب بالكامل' : 'Order paid in full'}</span></div>
              ) : <div className="order-due-unavailable">{isAr ? 'المبلغ المستحق غير متاح حالياً' : 'Amount due is unavailable'}</div>}
            </section>

            <a href="/public/about" className="order-public-home-link"><Sparkles size={17} /><span>{isAr ? 'ألقي نظرة' : 'Take a look'}</span><ArrowUpRight size={17} /></a>
          </div>
        )}
      </main>

      <footer className="order-qr-footer"><ShieldCheck size={15} /><span>{isAr ? 'نظام إلكتروني مؤمن' : 'Secure electronic service'}</span></footer>
    </div>
  );
};
