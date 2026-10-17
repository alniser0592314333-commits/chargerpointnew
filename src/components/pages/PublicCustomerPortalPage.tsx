import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, CreditCard, Globe, History, RefreshCw, ShieldCheck, Wallet, Wifi, WifiOff, Zap } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { invokeSupabaseRpc } from '../../services/supabase/client';

type PortalOrderItem = {
  device_name_ar: string;
  device_name_en: string;
  has_charger: boolean;
  status: string;
  payment_status: string;
  total_minor: number;
  paid_minor: number;
  due_minor: number;
};
type PortalOrder = {
  order_number: number;
  created_at: string;
  status: string;
  total_minor: number;
  due_minor: number;
  items: PortalOrderItem[];
};
type PortalSubmission = {
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | string;
  payment_method: string;
  created_at: string;
  reviewed_at: string | null;
  amount_minor: number | null;
};
type PortalGoal = {
  target_quantity: number;
  current_progress: number;
  status: string;
  expires_at: string | null;
  completed_at: string | null;
  bonus_minor: number | null;
  bonus_recorded: boolean;
};
type PortalData = {
  customer_name: string;
  customer_code: string;
  balance_minor: number;
  orders: PortalOrder[];
  payment_submissions: PortalSubmission[];
  goals: PortalGoal[];
};

export interface PublicCustomerPortalPageProps { token: string }

const safeDate = (value: string | null | undefined, locale: string) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-PS' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
};
const money = (minor: number | null | undefined, locale: string) => {
  if (typeof minor !== 'number' || !Number.isFinite(minor)) return '—';
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-PS' : 'en-GB', { style: 'currency', currency: 'ILS', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100);
};

export const PublicCustomerPortalPage: React.FC<PublicCustomerPortalPageProps> = ({ token }) => {
  const { locale, setLocale } = useI18n();
  const isAr = locale === 'ar';
  const [data, setData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'invalid' | 'service' | null>(null);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [refreshing, setRefreshing] = useState(false);
  const requestGeneration = useRef(0);

  const load = useCallback(async (manual = false) => {
    const requestId = ++requestGeneration.current;
    if (manual) setRefreshing(true); else setLoading(true);
    setError(null);
    // Never show a cached/local financial snapshot as if it were current.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setData(null);
      setError('service');
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const { data: response, error: rpcError } = await invokeSupabaseRpc<PortalData>(
        'public_resolve_customer_portal',
        { p_public_token: token },
        undefined,
        true,
        false,
        true
      );
      // Ignore stale requests and never restore financial data after connectivity drops.
      if (requestId !== requestGeneration.current) return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setData(null);
        setError('service');
        return;
      }
      if (rpcError || !response) {
        setData(null);
        setError(rpcError ? 'service' : 'invalid');
      } else if (
        typeof response.customer_name !== 'string' ||
        typeof response.customer_code !== 'string' ||
        typeof response.balance_minor !== 'number' ||
        !Array.isArray(response.orders) ||
        !Array.isArray(response.payment_submissions) ||
        !Array.isArray(response.goals)
      ) {
        setData(null);
        setError('service');
      } else {
        setData(response);
      }
    } catch {
      if (requestId === requestGeneration.current) {
        setData(null);
        setError('service');
      }
    } finally {
      if (requestId === requestGeneration.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [token]);

  useEffect(() => {
    void load();
    const onOnline = () => { setOnline(true); void load(); };
    const onOffline = () => {
      requestGeneration.current += 1;
      setOnline(false);
      setData(null);
      setError('service');
      setLoading(false);
      setRefreshing(false);
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      requestGeneration.current += 1;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [load]);

  const balanceLabel = useMemo(() => {
    if (!data) return '—';
    if (data.balance_minor < 0) return isAr ? 'المبلغ المستحق عليك' : 'Amount you owe';
    if (data.balance_minor > 0) return isAr ? 'رصيد دائن لصالحك' : 'Credit in your favor';
    return isAr ? 'الرصيد متعادل' : 'Account settled';
  }, [data, isAr]);

  const statusLabel = (status: string) => {
    const map: Record<string, [string, string]> = {
      'تم الشحن': ['تم الشحن', 'Charged'], 'قيد الشحن': ['قيد الشحن', 'Charging'],
      CHARGED: ['تم الشحن', 'Charged'], CHARGING: ['قيد الشحن', 'Charging'],
      charging: ['قيد الشحن', 'Charging'], DELIVERED: ['تم التسليم', 'Delivered'],
      delivered: ['تم التسليم', 'Delivered'], CANCELLED: ['ملغي', 'Cancelled'],
      cancelled: ['ملغي', 'Cancelled'], PENDING: ['بانتظار المراجعة', 'Pending review'],
      APPROVED: ['مقبول', 'Approved'], REJECTED: ['مرفوض', 'Rejected'],
      PAID: ['مدفوع', 'Paid'], PARTIAL: ['مدفوع جزئياً', 'Partially paid'],
      PARTIALLY_PAID: ['مدفوع جزئياً', 'Partially paid'],
      UNPAID: ['غير مدفوع', 'Unpaid'], NOT_DUE: ['غير مستحق حالياً', 'Not due'],
      ACTIVE: ['فعّال', 'Active'], COMPLETED: ['مكتمل', 'Completed'], EXPIRED: ['منتهي', 'Expired'],
    };
    return map[status]?.[isAr ? 0 : 1] ?? status;
  };
  const paymentMethodLabel = (method: string) => {
    const methods: Record<string, string> = {
      BANK_OF_PALESTINE: isAr ? 'بنك فلسطين' : 'Bank of Palestine',
      JAWAL_PAY: isAr ? 'جوال باي' : 'Jawwal Pay',
      PALPAY: isAr ? 'بال باي' : 'PalPay',
    };
    return methods[method] ?? method;
  };

  return (
    <div dir={isAr ? 'rtl' : 'ltr'} className="min-h-screen bg-slate-50 text-slate-900 dark:bg-[#071b1b] dark:text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur dark:border-emerald-950 dark:bg-[#082622]/95">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-700 text-white"><Zap className="h-5 w-5" /></span>
            <div><p className="font-bold">{isAr ? 'نقطة الشحن' : 'Charging Point'}</p><p className="text-xs text-slate-500 dark:text-emerald-200/70">{isAr ? 'بوابة العميل' : 'Customer portal'}</p></div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`hidden items-center gap-1 rounded-full px-2 py-1 text-xs sm:flex ${online ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200' : 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200'}`}>
              {online ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}{online ? (isAr ? 'متصل' : 'Online') : (isAr ? 'غير متصل' : 'Offline')}
            </span>
            <button type="button" onClick={() => setLocale(isAr ? 'en' : 'ar')} className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-slate-200 px-3 text-sm font-semibold dark:border-emerald-900" aria-label={isAr ? 'Switch to English' : 'التبديل للعربية'}><Globe className="h-4 w-4" />{isAr ? 'EN' : 'عربي'}</button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-5 sm:py-8">
        {!online && <div role="status" className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-100"><WifiOff className="mt-0.5 h-5 w-5 shrink-0" /><p>{isAr ? 'انقطع الإنترنت. أخفينا البيانات المالية حتى لا تظهر معلومات قديمة على أنها محدثة. أعد الاتصال ثم حدّث الصفحة.' : 'You are offline. Financial data is hidden so an old balance is never shown as current. Reconnect and refresh.'}</p></div>}

        {loading ? <div className="space-y-3" aria-live="polite"><div className="h-28 animate-pulse rounded-2xl bg-slate-200 dark:bg-emerald-950" /><div className="h-36 animate-pulse rounded-2xl bg-slate-200 dark:bg-emerald-950" /><p className="text-center text-sm text-slate-500">{isAr ? 'جارٍ التحقق من رمز العميل وتحميل البيانات...' : 'Verifying customer QR and loading your data…'}</p></div> :
          error || !data ? <section role="alert" className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-emerald-950 dark:bg-[#082622]">
            <AlertTriangle className="mx-auto mb-3 h-9 w-9 text-amber-600" />
            <h1 className="text-lg font-bold">{error === 'invalid' ? (isAr ? 'تعذّر التحقق من رمز العميل' : 'Customer QR could not be verified') : (isAr ? 'بيانات العميل غير متاحة حالياً' : 'Customer data is temporarily unavailable')}</h1>
            <p className="mt-2 text-sm text-slate-600 dark:text-emerald-100/70">{error === 'invalid' ? (isAr ? 'الرمز غير صالح أو منتهي أو ملغى. لم نعرض أي بيانات للحساب.' : 'The QR is invalid, expired, or revoked. No account data was disclosed.') : (isAr ? 'تعذّر الاتصال بالخدمة الآمنة. تأكد من الإنترنت وحاول مجدداً.' : 'The secure service could not be reached. Check your connection and try again.')}</p>
            <button type="button" onClick={() => void load(true)} disabled={refreshing || !online} className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-2 font-semibold text-white disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />{isAr ? 'إعادة المحاولة' : 'Try again'}</button>
          </section> : <>
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-emerald-950 dark:bg-[#082622] sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><p className="text-sm text-slate-500 dark:text-emerald-200/70">{isAr ? 'أهلاً بك' : 'Welcome'}</p><h1 className="mt-1 text-2xl font-extrabold">{data.customer_name}</h1><p className="mt-1 text-sm text-slate-500 dark:text-emerald-200/70">{isAr ? 'رمز العميل' : 'Customer code'}: <bdi className="font-mono font-bold">{data.customer_code}</bdi></p></div>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"><ShieldCheck className="h-4 w-4" />{isAr ? 'بوابة خاصة عبر QR' : 'Private QR portal'}</span>
              </div>
              <div className="mt-5 rounded-xl bg-slate-50 p-4 dark:bg-[#0c312b]">
                <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-emerald-100/75"><Wallet className="h-5 w-5" />{balanceLabel}</div>
                <p className={`mt-2 text-3xl font-extrabold tabular-nums ${data.balance_minor < 0 ? 'text-rose-700 dark:text-rose-300' : 'text-emerald-700 dark:text-emerald-300'}`}>{money(Math.abs(data.balance_minor), locale)}</p>
                <p className="mt-1 text-xs text-slate-500 dark:text-emerald-100/60">{isAr ? 'الرصيد من السجل المالي المعتمد على الخادم' : 'Balance from the server-authoritative financial ledger'}</p>
              </div>
              <a href={`/pay/${encodeURIComponent(token)}`} className="mt-4 flex min-h-12 items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-3 font-bold text-white hover:bg-emerald-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"><CreditCard className="h-5 w-5" />{isAr ? 'إرسال إيصال دفع' : 'Submit payment receipt'}</a>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-emerald-950 dark:bg-[#082622]">
              <div className="mb-4 flex items-center gap-2"><History className="h-5 w-5 text-emerald-700 dark:text-emerald-300" /><h2 className="text-lg font-bold">{isAr ? 'سجل الطلبات' : 'Order history'}</h2></div>
              {data.orders.length === 0 ? <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500 dark:bg-[#0c312b]">{isAr ? 'لا توجد طلبات مسجلة.' : 'No orders found.'}</p> : <div className="space-y-3">{data.orders.map((order) => <article key={`${order.order_number}-${order.created_at}`} className="rounded-xl border border-slate-200 p-4 dark:border-emerald-950">
                <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-bold">{isAr ? 'طلب رقم' : 'Order'} #{order.order_number}</h3><p className="mt-1 text-xs text-slate-500 dark:text-emerald-100/60">{safeDate(order.created_at, locale)}</p></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold dark:bg-emerald-950">{statusLabel(order.status)}</span></div>
                <div className="mt-3 grid grid-cols-2 gap-3"><div><p className="text-xs text-slate-500">{isAr ? 'الإجمالي' : 'Total'}</p><p className="mt-1 font-bold tabular-nums">{money(order.total_minor, locale)}</p></div><div><p className="text-xs text-slate-500">{isAr ? 'المتبقي على الطلب' : 'Order due'}</p><p className="mt-1 font-bold tabular-nums">{money(order.due_minor, locale)}</p></div></div>
                <div className="mt-3 space-y-2">{order.items.map((item, index) => <div key={index} className="flex items-start justify-between gap-3 border-t border-slate-100 pt-2 text-sm dark:border-emerald-950"><div className="min-w-0"><p className="font-medium">{isAr ? item.device_name_ar : item.device_name_en}</p><p className="mt-0.5 text-xs text-slate-500">{item.has_charger ? (isAr ? 'مع شاحن' : 'With charger') : (isAr ? 'بدون شاحن' : 'No charger')} · {statusLabel(item.status)} · {statusLabel(item.payment_status)}</p></div><span className="shrink-0 font-semibold tabular-nums">{money(item.total_minor, locale)}</span></div>)}</div>
              </article>)}</div>}
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-emerald-950 dark:bg-[#082622]">
              <div className="mb-4 flex items-center gap-2"><Clock3 className="h-5 w-5 text-emerald-700 dark:text-emerald-300" /><h2 className="text-lg font-bold">{isAr ? 'المدفوعات والإيصالات' : 'Payments and receipts'}</h2></div>
              {data.payment_submissions.length === 0 ? <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500 dark:bg-[#0c312b]">{isAr ? 'لا توجد إيصالات مرسلة.' : 'No submitted receipts yet.'}</p> : <div className="space-y-3">{data.payment_submissions.map((submission, index) => <div key={`${submission.created_at}-${index}`} className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-emerald-950"><div className="min-w-0"><p className="font-semibold">{paymentMethodLabel(submission.payment_method)}</p><p className="mt-1 text-xs text-slate-500">{safeDate(submission.created_at, locale)}{submission.reviewed_at ? ` · ${isAr ? 'المراجعة' : 'Reviewed'}: ${safeDate(submission.reviewed_at, locale)}` : ''}</p>{submission.status === 'APPROVED' && submission.amount_minor !== null && <p className="mt-1 text-sm font-bold">{money(submission.amount_minor, locale)}</p>}</div><span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold dark:bg-emerald-950">{statusLabel(submission.status)}</span></div>)}</div>}
            </section>

            {data.goals.length > 0 && <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-emerald-950 dark:bg-[#082622]">
              <h2 className="mb-4 text-lg font-bold">{isAr ? 'الأهداف والمكافآت' : 'Goals and rewards'}</h2>
              <div className="space-y-3">{data.goals.map((goal, index) => <div key={index} className="rounded-xl border border-slate-200 p-4 dark:border-emerald-950"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{isAr ? 'هدف الشحن' : 'Charging goal'}</p><p className="mt-1 text-sm text-slate-500">{isAr ? 'التقدم' : 'Progress'}: {goal.current_progress} / {goal.target_quantity}</p></div><span className="text-xs font-semibold">{statusLabel(goal.status)}</span></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-emerald-950"><div className="h-full rounded-full bg-emerald-600" style={{ width: `${Math.max(0, Math.min(100, goal.target_quantity > 0 ? goal.current_progress / goal.target_quantity * 100 : 0))}%` }} /></div>{goal.bonus_recorded && goal.bonus_minor !== null && <p className="mt-3 text-sm font-bold text-emerald-700 dark:text-emerald-300">{isAr ? 'مكافأة مثبتة في السجل المالي:' : 'Reward recorded in financial ledger:'} {money(goal.bonus_minor, locale)}</p>}{goal.expires_at && <p className="mt-2 text-xs text-slate-500">{isAr ? 'ينتهي:' : 'Expires:'} {safeDate(goal.expires_at, locale)}</p>}</div>)}</div>
            </section>}

            <div className="flex flex-wrap items-center justify-between gap-3 pb-2">
              <p className="flex items-center gap-2 text-xs text-slate-500 dark:text-emerald-100/60"><CheckCircle2 className="h-4 w-4" />{isAr ? 'عرض فقط؛ اعتماد الدفع وتعديل الرصيد من صلاحيات الإدارة.' : 'Read-only view; payment approval and balance changes remain admin-only.'}</p>
              <button type="button" onClick={() => void load(true)} disabled={refreshing || !online} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-semibold disabled:opacity-50 dark:border-emerald-900"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />{isAr ? 'تحديث البيانات' : 'Refresh data'}</button>
            </div>
          </>}
      </main>
      <footer className="border-t border-slate-200 px-4 py-5 text-center text-xs text-slate-500 dark:border-emerald-950 dark:text-emerald-100/50">{isAr ? 'نقطة الشحن · بوابة العميل الآمنة' : 'Charging Point · Secure customer portal'}</footer>
    </div>
  );
};
