import React, { useEffect, useState } from 'react';
import {
  BatteryCharging, CalendarClock, CheckCircle2,
  ChevronRight, CircleHelp, Clock3, CreditCard, Globe, Moon, PackageCheck,
  ShieldCheck, Smartphone, Sun, Zap,
} from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';
import { getPublicOrderByToken, PublicOrderQrData } from './dayOrdersStore';

export interface PublicOrderPageProps {
  token: string;
}

export const PublicOrderPage: React.FC<PublicOrderPageProps> = ({ token }) => {
  const { locale, setLocale, formatCurrency, isRTL } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const isAr = locale === 'ar';
  const [data, setData] = useState<PublicOrderQrData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
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

  const formatDate = (dateString?: string) => {
    if (!dateString) return '—';
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString(isAr ? 'ar-PS' : 'en-GB', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  };

  const statusInfo = (status?: string) => {
    const key = (status || '').toUpperCase();
    if (['CHARGING', 'IN_PROGRESS', 'IN_PROGRESS_CHARGING', 'PROCESSING'].includes(key)) {
      return { label: isAr ? 'قيد الشحن' : 'Charging', icon: BatteryCharging, cls: 'bg-sky-50 text-sky-800 border-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:border-sky-900' };
    }
    if (['READY', 'READY_FOR_PICKUP'].includes(key)) {
      return { label: isAr ? 'جاهز للاستلام' : 'Ready for pickup', icon: CheckCircle2, cls: 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-900' };
    }
    if (['DELIVERED', 'COMPLETED'].includes(key)) {
      return { label: isAr ? 'تم التسليم' : 'Delivered', icon: PackageCheck, cls: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700' };
    }
    if (['CANCELLED', 'CANCELED'].includes(key)) {
      return { label: isAr ? 'ملغي' : 'Cancelled', icon: CircleHelp, cls: 'bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:border-rose-900' };
    }
    return { label: isAr ? 'قيد المعالجة' : 'In progress', icon: Clock3, cls: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-900' };
  };

  const total = data?.orderTotalMinor;
  const due = data?.orderDueMinor;
  const status = statusInfo(data?.status);

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} className="min-h-screen bg-[#f4f7f7] text-[#142c2c] dark:bg-[#071b1b] dark:text-[#e7f2ef] transition-colors">
      <header className="border-b border-[#dce6e4] bg-white/90 dark:bg-[#0a2423]/90 dark:border-[#1c4140]">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#0f766e] text-white shadow-sm"><Zap className="h-5 w-5" /></span>
            <span>
              <span className="block text-sm font-bold tracking-tight">{isAr ? 'نقطة الشحن' : 'Charging Point'}</span>
              <span className="block text-[11px] text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'بوابة العميل' : 'Customer portal'}</span>
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => setLocale(isAr ? 'en' : 'ar')} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-[#365653] hover:bg-[#edf4f2] dark:text-[#c8d9d4] dark:hover:bg-[#133533]" aria-label="Toggle language"><Globe className="h-4 w-4" />{isAr ? 'English' : 'عربي'}</button>
            <button type="button" onClick={toggleTheme} className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#dce6e4] hover:bg-[#edf4f2] dark:border-[#244746] dark:hover:bg-[#133533]" aria-label="Toggle theme">{theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4 text-amber-300" />}</button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-7 sm:px-6 lg:py-10">
        {loading ? (
          <div className="mx-auto max-w-3xl rounded-2xl border border-[#dce6e4] bg-white p-10 text-center shadow-sm dark:border-[#1c4140] dark:bg-[#0a2423]">
            <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-[#eaf4f1] text-[#0f766e] dark:bg-[#133533]"><span className="h-4 w-4 animate-spin rounded-full border-2 border-[#0f766e]/30 border-t-[#0f766e]" /></span>
            <p className="mt-4 text-sm text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'جاري تحميل تفاصيل الطلب…' : 'Loading order details…'}</p>
          </div>
        ) : error || !data ? (
          <div className="mx-auto max-w-lg rounded-2xl border border-rose-200 bg-white p-8 text-center shadow-sm dark:border-rose-900 dark:bg-[#0a2423]">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-200"><CircleHelp className="h-6 w-6" /></span>
            <h1 className="mt-4 text-lg font-semibold">{isAr ? 'الطلب غير موجود' : 'Order not found'}</h1>
            <p className="mt-2 text-sm leading-6 text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'رمز QR غير صالح أو منتهي. تأكد من مسح رمز الطلب الصحيح.' : 'This QR code is invalid or expired. Please scan the correct order QR.'}</p>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <section className="min-w-0 space-y-5">
              <div className="space-y-2">
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0f766e]">{isAr ? 'تفاصيل الطلب' : 'ORDER DETAILS'}</p>
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{isAr ? `طلب رقم ${data.orderNumber}` : `Order #${data.orderNumber}`}</h1>
                    <p className="mt-1 text-sm text-[#6b8580] dark:text-[#9bb6b0]">{data.customerName}</p>
                  </div>
                  <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${status.cls}`}><status.icon className="h-4 w-4" />{status.label}</span>
                </div>
              </div>

              <div className="rounded-2xl border border-[#dce6e4] bg-white shadow-[0_8px_30px_rgba(16,55,51,0.04)] dark:border-[#1c4140] dark:bg-[#0a2423]">
                <div className="grid gap-4 border-b border-[#e5ecea] p-5 sm:grid-cols-2 dark:border-[#244746] sm:p-6">
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#edf5f2] text-[#0f766e] dark:bg-[#133533]"><CalendarClock className="h-4 w-4" /></span>
                    <div><p className="text-[11px] text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'تاريخ ووقت الطلب' : 'Order date & time'}</p><p className="mt-1 text-sm font-semibold">{formatDate(data.createdAt)}</p></div>
                  </div>
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#edf5f2] text-[#0f766e] dark:bg-[#133533]"><Smartphone className="h-4 w-4" /></span>
                    <div><p className="text-[11px] text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'عدد الأجهزة' : 'Items'}</p><p className="mt-1 text-sm font-semibold">{data.itemsCount}</p></div>
                  </div>
                </div>

                <div className="p-5 sm:p-6">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <h2 className="text-base font-semibold">{isAr ? 'الأجهزة والخدمات' : 'Devices & services'}</h2>
                    <span className="text-xs text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? `${data.itemsCount} عنصر` : `${data.itemsCount} items`}</span>
                  </div>
                  {data.items?.length ? (
                    <div className="divide-y divide-[#e5ecea] dark:divide-[#244746]">
                      {data.items.map((item, index) => (
                        <div key={`${item.name}-${index}`} className="flex items-start gap-3 py-4 first:pt-0 last:pb-0">
                          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#f0f5f4] text-[#55736d] dark:bg-[#102f2d] dark:text-[#a4c0b9]"><Smartphone className="h-4 w-4" /></span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold">{item.name}</p>
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                              <span className="rounded-md bg-[#f1f5f4] px-2 py-1 text-[10px] font-medium text-[#58736e] dark:bg-[#102f2d] dark:text-[#b0c6c1]">{item.has_charger ? (isAr ? 'مع شاحن' : 'With charger') : (isAr ? 'بدون شاحن' : 'No charger')}</span>
                              {item.charger_fee_exempt && <span className="rounded-md bg-[#eaf4f1] px-2 py-1 text-[10px] font-semibold text-[#0f766e] dark:bg-[#133533] dark:text-[#a9d8cc]">{isAr ? 'تم إعفاؤك من رسوم الشحن' : 'Charger fee waived'}</span>}
                            </div>
                          </div>
                          <div className="shrink-0 text-end">
                            <p className="text-sm font-semibold tabular-nums">{typeof item.total_price_minor === 'number' ? formatCurrency(item.total_price_minor) : '—'}</p>
                            {typeof item.due_minor === 'number' && item.due_minor > 0 && item.due_minor < (item.total_price_minor ?? 0) && <p className="mt-1 text-[10px] text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'المتبقي' : 'Due'}: {formatCurrency(item.due_minor)}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-xl bg-[#f7faf9] p-4 text-sm text-[#6b8580] dark:bg-[#0b2928] dark:text-[#9bb6b0]">{isAr ? 'لا توجد تفاصيل أجهزة متاحة.' : 'No device details are available.'}</p>
                  )}
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-[#dce6e4] bg-white p-4 text-xs leading-5 text-[#607874] dark:border-[#1c4140] dark:bg-[#0a2423] dark:text-[#a7beb9]">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#0f766e]" />
                <p>{isAr ? 'هذه صفحة عامة للعرض فقط. لا تعرض بيانات دخول أو روابط إدارية، ولا يتغير الوضع المالي إلا من خلال إجراءات المراجعة المعتمدة داخل النظام.' : 'This is a public, read-only page. It exposes no login or admin links, and financial status changes only through the approved review flow inside the app.'}</p>
              </div>
            </section>

            <aside className="h-fit space-y-4 lg:sticky lg:top-6">
              <div className="overflow-hidden rounded-2xl border border-[#dce6e4] bg-white shadow-[0_8px_30px_rgba(16,55,51,0.05)] dark:border-[#1c4140] dark:bg-[#0a2423]">
                <div className="bg-[#103c38] px-5 py-5 text-white">
                  <p className="text-[11px] font-semibold text-[#b9d8d0]">{isAr ? 'ملخص المبلغ' : 'AMOUNT SUMMARY'}</p>
                  <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{typeof total === 'number' ? formatCurrency(total) : '—'}</p>
                  <p className="mt-1 text-xs text-[#b9d8d0]">{isAr ? 'إجمالي قيمة الطلب' : 'Total order value'}</p>
                </div>
                <div className="space-y-4 p-5">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'المبلغ المتبقي من الطلب' : 'Remaining order amount'}</span>
                    <span className="font-semibold tabular-nums">{typeof due === 'number' ? formatCurrency(due) : '—'}</span>
                  </div>
                  {typeof due === 'number' && due > 0 ? (
                    <a href={`/pay/${token}`} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#0f766e] px-4 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#115e59] focus:outline-none focus:ring-2 focus:ring-[#0f766e] focus:ring-offset-2 dark:focus:ring-offset-[#0a2423]">
                      <CreditCard className="h-4 w-4" />{isAr ? 'ادفع الآن' : 'Pay now'}<ChevronRight className={`h-4 w-4 ${isRTL ? 'rotate-180' : ''}`} />
                    </a>
                  ) : (
                    <div className="rounded-xl bg-[#f0f8f6] p-3 text-xs leading-5 text-[#41635d] dark:bg-[#10302e] dark:text-[#b4d0c8]">{typeof due === 'number' && due === 0 ? (isAr ? 'لا يوجد مبلغ متبقٍ على هذا الطلب حالياً.' : 'There is no remaining amount on this order.') : (isAr ? 'تعذّر تحميل المبلغ المستحق حالياً. حاول مجدداً عند توفر الاتصال.' : 'The outstanding amount is currently unavailable. Please try again when connected.')}</div>
                  )}
                  <p className="text-center text-[10px] leading-4 text-[#7d9690] dark:text-[#779791]"><ShieldCheck className="me-1 inline h-3.5 w-3.5" />{isAr ? 'إرسال إشعار الدفع لا يؤكد الدفع تلقائياً' : 'Payment notification is not automatic confirmation'}</p>
                </div>
              </div>
              <div className="rounded-2xl border border-[#dce6e4] bg-[#edf5f2] p-4 dark:border-[#1c4140] dark:bg-[#0c2927]">
                <div className="flex items-center gap-2 text-sm font-semibold"><Zap className="h-4 w-4 text-[#0f766e]" />{isAr ? 'نقطة الشحن' : 'Charging Point'}</div>
                <p className="mt-2 text-xs leading-5 text-[#58736e] dark:text-[#a4c0b9]">{isAr ? 'تفاصيل طلبك ومبلغك في مكان واحد، بتصميم واضح وسهل القراءة.' : 'Your order details and amount, presented in one clear and easy-to-read place.'}</p>
              </div>
            </aside>
          </div>
        )}
      </main>

      <footer className="border-t border-[#dce6e4] px-4 py-5 text-center text-[11px] text-[#7d9690] dark:border-[#1c4140] dark:text-[#779791]">{isAr ? 'نقطة الشحن · بوابة العميل' : 'Charging Point · Customer Portal'}</footer>
    </div>
  );
};
