import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Bell, CheckCircle2, CreditCard, Globe, History, KeyRound, Moon, RefreshCw, ShieldCheck, Sun, Target, UserRound, Wallet, Wifi, WifiOff } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { callCustomerAccount, customerAuth } from '../../services/customer/customerAuth';
import { AppLogo } from '../qr/AppLogo';
import { CustomerAuthScene } from './CustomerAuthScene';
import { EnergyCanvasBackground } from '../energy/EnergyCanvasBackground';
import { useTheme } from '../../theme/themeContext';
import { CustomerPortalNavigation, CustomerPortalMoreView, CustomerPortalTab } from './CustomerPortalNavigation';
import './customer-portal-dashboard.css';

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
  cached_at?: string;
};
type PortalLedgerEntry = {
  id: string;
  event_type: string;
  amount_minor: number;
  created_at: string;
  reference_id?: string | null;
  metadata?: Record<string, unknown> | null;
};
type PortalGoalRequest = {
  id: string;
  status: string;
  requested_target: number | null;
  created_at: string;
  reviewed_at: string | null;
  rejection_reason: string | null;
};
type PortalCustomerEvent = {
  id: string;
  event_type: string;
  request_id: string | null;
  is_read: boolean;
  created_at: string;
  payload?: Record<string, unknown> | null;
};
type PortalActivity = {
  ledger: PortalLedgerEntry[];
  goal_requests: PortalGoalRequest[];
  events: PortalCustomerEvent[];
  session: { created_at: string; expires_at: string } | null;
  last_login_at: string | null;
};
type PortalEventRow = { id: string; created_at: string; title: string; detail: string };

export interface PublicCustomerPortalPageProps { token: string; onLogout?: () => void }

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

const portalCacheKey = (token: string) => 'cp_customer_portal_cache:' + token;
export const hasCachedCustomerPortalData = (token: string): boolean => readCachedPortalData(token) !== null;
export const clearCachedCustomerPortalData = (token: string): void => {
  try { localStorage.removeItem(portalCacheKey(token)); } catch {}
};
const readCachedPortalData = (token: string): PortalData | null => {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(portalCacheKey(token));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PortalData;
    return typeof parsed.customer_name === 'string' &&
      typeof parsed.customer_code === 'string' &&
      typeof parsed.balance_minor === 'number' &&
      Array.isArray(parsed.orders) &&
      Array.isArray(parsed.payment_submissions) &&
      Array.isArray(parsed.goals) ? parsed : null;
  } catch { return null; }
};


export const PublicCustomerPortalPage: React.FC<PublicCustomerPortalPageProps> = ({ token, onLogout }) => {
  const { locale, setLocale } = useI18n();
  const { resolvedTheme, toggleTheme } = useTheme();
  const isAr = locale === 'ar';
  const [data, setData] = useState<PortalData | null>(() => readCachedPortalData(token));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'invalid' | 'service' | null>(null);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<CustomerPortalTab>('home');
  const [moreView, setMoreView] = useState<CustomerPortalMoreView>('profile');
  const [activity, setActivity] = useState<PortalActivity | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState(false);
  const [seenNotificationIds, setSeenNotificationIds] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem('cp_customer_notifications_seen:' + token) || '[]');
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch { return []; }
  });
  const [actionMessage, setActionMessage] = useState('');
  const [goalRequestBusy, setGoalRequestBusy] = useState(false);
  const [resetRequestBusy, setResetRequestBusy] = useState(false);
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordChangeBusy, setPasswordChangeBusy] = useState(false);
  const requestGeneration = useRef(0);

  const load = useCallback(async (manual = false) => {
    const requestId = ++requestGeneration.current;
    if (manual) setRefreshing(true); else setLoading(true);
    setError(null);
    // Never show a cached/local financial snapshot as if it were current.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      const cached = readCachedPortalData(token);
      if (cached) { setData(cached); setError(null); }
      else { setData(null); setError('service'); }
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const { data: responseResult, error: rpcError } = await callCustomerAccount<{ data: PortalData }>(
        'portal-data',
        { token }
      );
      const response = responseResult?.data ?? null;
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
        const verifiedSnapshot: PortalData = { ...response, cached_at: new Date().toISOString() };
        setData(verifiedSnapshot);
        try { localStorage.setItem(portalCacheKey(token), JSON.stringify(verifiedSnapshot)); } catch {}
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

  const loadActivity = useCallback(async () => {
    if (!online) return;
    setActivityLoading(true);
    setActivityError(false);
    const { data: response, error: requestError } = await callCustomerAccount<PortalActivity>(
      'customer-activity', { token },
    );
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setActivity(null);
      setActivityError(true);
      setActivityLoading(false);
      return;
    }
    if (requestError || !response || !Array.isArray(response.ledger) ||
        !Array.isArray(response.goal_requests) || !Array.isArray(response.events)) {
      setActivityError(true);
      setActivity(null);
    } else {
      setActivity({
        ledger: response.ledger,
        goal_requests: response.goal_requests,
        events: response.events,
        session: response.session ?? null,
        last_login_at: response.last_login_at ?? null,
      });
      setActivityError(false);
    }
    setActivityLoading(false);
  }, [token, online]);

  useEffect(() => {
    if (data && online) void loadActivity();
  }, [data?.customer_code, online, loadActivity]);

  useEffect(() => {
    if (!online || activeTab !== 'goals') return;
    void load(true);
    void loadActivity();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void load(true);
        void loadActivity();
      }
    }, 12000);
    return () => window.clearInterval(interval);
  }, [activeTab, online, load, loadActivity]);

  const markNotificationsSeen = () => {
    const ids = eventRows.map((event) => event.id);
    setSeenNotificationIds(ids);
    try { window.localStorage.setItem('cp_customer_notifications_seen:' + token, JSON.stringify(ids)); } catch {}
  };

  const requestGoal = async () => {
    if (!online || goalRequestBusy) return;
    setGoalRequestBusy(true);
    setActionMessage('');
    const { data: response, error: requestError } = await callCustomerAccount<{ already_pending?: boolean }>(
      'request-goal', { token },
    );
    if (requestError) {
      setActionMessage(requestError === 'GOAL_ALREADY_ACTIVE'
        ? (isAr ? 'لديك هدف فعّال بالفعل.' : 'You already have an active goal.')
        : (isAr ? 'تعذّر إرسال طلب الهدف. حاول مرة أخرى.' : 'The goal request could not be sent. Please try again.'));
    } else {
      setActionMessage(response?.already_pending
        ? (isAr ? 'لديك طلب هدف بانتظار مراجعة الإدارة بالفعل.' : 'You already have a goal request awaiting administrator review.')
        : (isAr ? 'تم إرسال طلب إنشاء الهدف للإدارة.' : 'Your goal request has been sent to the administrator.'));
      await loadActivity();
    }
    setGoalRequestBusy(false);
  };

  const changePortalPassword = async () => {
    if (!online || passwordChangeBusy) return;
    const common = new Set(['password', 'password123', '12345678', 'qwerty123', '11111111', '123456789', '1234567890', 'qwertyuiop', 'abc12345', 'letmein123', 'iloveyou', 'admin123', 'welcome1', 'monkey123', 'dragon123']);
    if (newPassword.length < 8 || newPassword.length > 128 || common.has(newPassword.trim().toLowerCase()) || /^(.)\1{7,}$/.test(newPassword)) {
      setActionMessage(isAr ? 'استخدم كلمة مرور من 8 أحرف على الأقل، وتجنب كلمات المرور الشائعة.' : 'Use at least 8 characters and avoid common passwords.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setActionMessage(isAr ? 'كلمتا المرور غير متطابقتين.' : 'The passwords do not match.');
      return;
    }
    setPasswordChangeBusy(true);
    setActionMessage('');
    try {
      const { error: updateError } = await customerAuth.auth.updateUser({ password: newPassword });
      if (updateError) {
        setActionMessage(isAr ? 'تعذّر تغيير كلمة المرور. تحقق من الاتصال وحاول مجددًا.' : 'Password could not be changed. Check your connection and try again.');
        return;
      }
      const { error: completionError } = await callCustomerAccount('complete-password-change', { token });
      setNewPassword('');
      setConfirmNewPassword('');
      setShowPasswordChange(false);
      if (completionError) {
        setActionMessage(isAr ? 'تم تحديث كلمة المرور، لكن تعذّر تأكيد الجلسة. سجّل الخروج ثم الدخول مجددًا.' : 'The password was updated, but the session could not be confirmed. Sign out and sign in again.');
      } else {
        setActionMessage(isAr ? 'تم تغيير كلمة المرور بنجاح.' : 'Your password was changed successfully.');
        await loadActivity();
      }
    } catch {
      setActionMessage(isAr ? 'تعذّر إكمال تغيير كلمة المرور. حاول مرة أخرى.' : 'Could not complete the password change. Please try again.');
    } finally {
      setPasswordChangeBusy(false);
    }
  };

  const requestPasswordReset = async () => {
    if (!online || resetRequestBusy) return;
    setResetRequestBusy(true);
    setActionMessage('');
    const { error: requestError } = await callCustomerAccount('request-reset', { token });
    setActionMessage(requestError
      ? (isAr ? 'تعذّر إرسال طلب إعادة تعيين كلمة المرور. حاول مرة أخرى.' : 'Could not send the password-reset request. Please try again.')
      : (isAr ? 'تم إرسال طلب إعادة تعيين كلمة المرور للإدارة، وهو بانتظار الموافقة.' : 'Your password-reset request was sent and is awaiting administrator approval.'));
    if (!requestError) await loadActivity();
    setResetRequestBusy(false);
  };

  useEffect(() => {
    void load();
    const onOnline = () => { setOnline(true); void load(); };
    const onOffline = () => {
      requestGeneration.current += 1;
      setOnline(false);
      setActivity(null);
      setActivityError(true);
      const cached = readCachedPortalData(token);
      if (cached) { setData(cached); setError(null); }
      else { setData(null); setError('service'); }
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

  const pendingReviewMinor = (data?.payment_submissions || [])
    .filter((submission) => submission.status.toUpperCase() === 'PENDING')
    .reduce((total, submission) => total + (submission.amount_minor ?? 0), 0);
  const featuredOrder = data?.orders.find((order) =>
    !['DELIVERED', 'delivered', 'CANCELLED', 'cancelled'].includes(order.status)
  ) || data?.orders[0];
  const activeGoal = data?.goals.find((goal) => goal.status.toUpperCase() === 'ACTIVE');
  const pendingGoalRequest = activity?.goal_requests.find((request) => request.status.toUpperCase() === 'PENDING');
  const translateLedgerType = (type: string) => {
    const labels: Record<string, [string, string]> = {
      CHARGE: ['رسوم شحن', 'Charging charge'],
      ORDER_ITEM_CHARGE: ['رسوم جهاز', 'Device charge'],
      PAYMENT: ['دفعة معتمدة', 'Approved payment'],
      CREDIT: ['رصيد دائن', 'Credit'],
      CREDIT_USED: ['استخدام رصيد', 'Credit used'],
      DISCOUNT: ['خصم', 'Discount'],
      BONUS: ['مكافأة هدف', 'Goal reward'],
      REFUND: ['استرداد', 'Refund'],
      REVERSAL: ['عكس حركة', 'Reversal'],
      ADJUSTMENT: ['تسوية مالية', 'Adjustment'],
      CREDIT_ADJUSTMENT: ['تعديل رصيد', 'Credit adjustment'],
      CORRECTION: ['تصحيح مالي', 'Financial correction'],
    };
    return labels[type]?.[isAr ? 0 : 1] || (isAr ? 'حركة مالية' : 'Financial movement');
  };
  const translateAccountEvent = (type: string) => {
    const labels: Record<string, [string, string]> = {
      RESET_REQUESTED: ['تم إرسال طلب إعادة تعيين كلمة المرور', 'Password reset requested'],
      TEMP_PASSWORD_ISSUED: ['وافقت الإدارة على إعادة تعيين كلمة المرور', 'Password reset approved'],
      PASSWORD_CHANGED: ['تم تغيير كلمة المرور', 'Password changed'],
      TERMS_ACCEPTED: ['تم تحديث الموافقة على الشروط', 'Terms acceptance updated'],
      EMAIL_RESET_SENT: ['تم إرسال رابط استعادة كلمة المرور', 'Password recovery email sent'],
      GOAL_REQUESTED: ['تم إرسال طلب إنشاء هدف', 'Goal creation requested'],
    };
    return labels[type]?.[isAr ? 0 : 1] || (isAr ? 'تحديث في الحساب' : 'Account update');
  };
  const eventRows: PortalEventRow[] = [
    ...(data?.orders || []).map((order) => ({
      id: 'order-' + order.order_number + '-' + order.created_at,
      created_at: order.created_at,
      title: (isAr ? 'طلب شحن رقم ' : 'Charging order #') + order.order_number,
      detail: statusLabel(order.status),
    })),
    ...(data?.payment_submissions || []).map((submission, index) => ({
      id: 'payment-' + submission.created_at + '-' + index,
      created_at: submission.created_at,
      title: isAr ? 'إيصال دفع' : 'Payment receipt',
      detail: statusLabel(submission.status),
    })),
    ...(activity?.goal_requests || []).map((request) => ({
      id: 'goal-request-' + request.id,
      created_at: request.created_at,
      title: isAr ? 'طلب إنشاء هدف' : 'Goal creation request',
      detail: statusLabel(request.status),
    })),
    ...(activity?.ledger || []).map((entry) => ({
      id: 'ledger-' + entry.id,
      created_at: entry.created_at,
      title: translateLedgerType(entry.event_type),
      detail: money(entry.amount_minor, locale),
    })),
    ...(activity?.events || []).map((event) => ({
      id: 'account-event-' + event.id,
      created_at: event.created_at,
      title: translateAccountEvent(event.event_type),
      detail: safeDate(event.created_at, locale),
    })),
  ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 50);

  return (
    <div dir={isAr ? 'rtl' : 'ltr'} className="cp-customer-portal relative isolate min-h-screen bg-slate-50 text-slate-900 dark:bg-[#071b1b] dark:text-slate-100">
      <EnergyCanvasBackground state="charging" theme={resolvedTheme} className="opacity-35" />
      <div aria-hidden="true" className="cp-portal-moon-scene"><CustomerAuthScene uid="cp-customer-portal-scene" /></div>
      <header className="relative z-10 sticky top-0 border-b border-slate-200/80 bg-white/80 backdrop-blur dark:border-emerald-950/80 dark:bg-[#082622]/80">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <AppLogo size={40} variant="auto" className="shrink-0" />
            <div><p className="font-bold">{isAr ? 'نقطة الشحن' : 'Charging Point'}</p><p className="text-xs text-slate-500 dark:text-emerald-200/70">{isAr ? 'بوابة العميل' : 'Customer portal'}</p></div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`flex items-center gap-1 px-2 py-1 text-xs ${online ? 'text-emerald-700 dark:text-emerald-200' : 'text-amber-800 dark:text-amber-200'}`}>
              {online ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}{online ? (isAr ? 'متصل' : 'Online') : (isAr ? 'غير متصل' : 'Offline')}
            </span>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-3xl space-y-4 px-4 py-5 pb-36 sm:py-8 sm:pb-36">
        {!online && <div role="status" className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-100"><WifiOff className="mt-0.5 h-5 w-5 shrink-0" /><p>{isAr ? 'أنت غير متصل. نعرض آخر نسخة محفوظة وليست بيانات لحظية؛ قد لا تشمل آخر دفعة أو تعديل.' : 'You are offline. This is the last saved snapshot, not live data; recent payments or changes may be missing.'}{data?.cached_at ? <span className="mt-1 block text-xs">{isAr ? 'آخر تحقق: ' : 'Last verified: '}{safeDate(data.cached_at, locale)}</span> : null}</p></div>}

        {loading ? <div className="space-y-3" aria-live="polite"><div className="h-28 animate-pulse rounded-2xl bg-slate-200 dark:bg-emerald-950" /><div className="h-36 animate-pulse rounded-2xl bg-slate-200 dark:bg-emerald-950" /><p className="text-center text-sm text-slate-500">{isAr ? 'جارٍ التحقق من رمز العميل وتحميل البيانات...' : 'Verifying customer QR and loading your data…'}</p></div> :
          error || !data ? <section role="alert" className="py-5 text-center">
            <AlertTriangle className="mx-auto mb-3 h-9 w-9 text-amber-600" />
            <h1 className="text-lg font-bold">{error === 'invalid' ? (isAr ? 'تعذّر التحقق من رمز العميل' : 'Customer QR could not be verified') : (isAr ? 'بيانات العميل غير متاحة حالياً' : 'Customer data is temporarily unavailable')}</h1>
            <p className="mt-2 text-sm text-slate-600 dark:text-emerald-100/70">{error === 'invalid' ? (isAr ? 'الرمز غير صالح أو منتهي أو ملغى. لم نعرض أي بيانات للحساب.' : 'The QR is invalid, expired, or revoked. No account data was disclosed.') : (isAr ? 'تعذّر الاتصال بالخدمة الآمنة. تأكد من الإنترنت وحاول مجدداً.' : 'The secure service could not be reached. Check your connection and try again.')}</p>
            <button type="button" onClick={() => void load(true)} disabled={refreshing || !online} className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-2 font-semibold text-white disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />{isAr ? 'إعادة المحاولة' : 'Try again'}</button>
          </section> : <>
            {actionMessage && <div role="status" className="cp-portal-feedback">{actionMessage}</div>}

            {activeTab === 'home' && <>
              <section className="cp-portal-section">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="cp-portal-eyebrow">{isAr ? 'مساحتك الخاصة' : 'YOUR PRIVATE SPACE'}</p>
                    <h1 className="mt-1 text-2xl font-extrabold tracking-tight">{isAr ? 'أهلًا بعودتك، ' : 'Welcome back, '}{data.customer_name}</h1>
                    <p className="mt-1 text-sm cp-portal-muted">{isAr ? 'رقم الحساب' : 'Account'} · <bdi className="font-mono font-bold">{data.customer_code}</bdi></p>
                  </div>
                  <span className="cp-portal-status"><ShieldCheck size={15} />{isAr ? 'حسابك الخاص' : 'Private account'}</span>
                </div>
                <div className="cp-portal-balance">
                  <p className="cp-portal-eyebrow">{isAr ? 'ملخص حسابك' : 'ACCOUNT SUMMARY'}</p>
                  <p className="mt-2 text-sm cp-portal-muted">{balanceLabel}</p>
                  <p className="cp-portal-balance__amount">{money(Math.abs(data.balance_minor), locale)}</p>
                  <p className="mt-1 text-xs cp-portal-muted">{isAr ? 'الرصيد من السجل المالي المعتمد' : 'From the approved financial ledger'}</p>
                  <div className="cp-portal-balance__details">
                    <div><span>{isAr ? 'المستحق عليك' : 'Amount due'}</span><strong>{money(data.balance_minor < 0 ? Math.abs(data.balance_minor) : 0, locale)}</strong></div>
                    <div><span>{isAr ? 'الرصيد الدائن' : 'Available credit'}</span><strong>{money(data.balance_minor > 0 ? data.balance_minor : 0, locale)}</strong></div>
                    <div><span>{isAr ? 'قيد المراجعة' : 'Under review'}</span><strong>{money(pendingReviewMinor, locale)}</strong></div>
                  </div>
                </div>
                <div className="cp-portal-subsection">
                  <div className="flex items-center justify-between gap-3">
                    <div><p className="cp-portal-eyebrow">{isAr ? 'متابعة الشحن' : 'CHARGING UPDATE'}</p><h2 className="mt-1 text-lg font-bold">{isAr ? 'طلبك الحالي' : 'Your current order'}</h2></div>
                    <button type="button" className="cp-portal-text-link" onClick={() => setActiveTab('orders')}>{isAr ? 'كل الطلبات' : 'All orders'} <span aria-hidden="true">←</span></button>
                  </div>
                  {featuredOrder ? <div className="cp-portal-featured-order">
                    <div className="flex items-start justify-between gap-3">
                      <div><p className="font-bold">{isAr ? 'طلب رقم' : 'Order'} #{featuredOrder.order_number}</p><p className="mt-1 text-xs cp-portal-muted">{safeDate(featuredOrder.created_at, locale)}</p></div>
                      <span className="cp-portal-status">{statusLabel(featuredOrder.status)}</span>
                    </div>
                    <div className="mt-4 flex items-end justify-between gap-3">
                      <div><p className="text-xs cp-portal-muted">{isAr ? 'عدد الأجهزة' : 'Devices'}</p><p className="mt-1 font-semibold">{featuredOrder.items.length}</p></div>
                      <div className="text-end"><p className="text-xs cp-portal-muted">{isAr ? 'المتبقي على الطلب' : 'Order due'}</p><p className="mt-1 text-lg font-bold">{money(featuredOrder.due_minor, locale)}</p></div>
                    </div>
                  </div> : <p className="cp-portal-empty">{isAr ? 'لا توجد طلبات مسجلة حتى الآن.' : 'No orders have been recorded yet.'}</p>}
                </div>
                <div className="cp-portal-subsection">
                  <div className="flex items-center justify-between gap-3"><h2 className="text-base font-bold">{isAr ? 'آخر التحديثات' : 'Recent updates'}</h2><button type="button" className="cp-portal-text-link" onClick={() => { setActiveTab('more'); setMoreView('notifications'); }}>{isAr ? 'عرض الكل' : 'View all'}</button></div>
                  {eventRows.length ? <div className="cp-portal-timeline">{eventRows.slice(0, 3).map((event) => <div key={event.id} className="cp-portal-timeline__row"><span className="cp-portal-timeline__dot" /><div className="min-w-0 flex-1"><p className="font-semibold">{event.title}</p><p className="mt-1 text-xs cp-portal-muted">{event.detail} · {safeDate(event.created_at, locale)}</p></div></div>)}</div> : <p className="cp-portal-empty">{isAr ? 'لا توجد تحديثات جديدة.' : 'No recent updates.'}</p>}
                </div>
              </section>
            </>}

            {activeTab === 'orders' && <section className="cp-portal-section">
              <p className="cp-portal-eyebrow">{isAr ? 'سجل الخدمة' : 'SERVICE HISTORY'}</p>
              <h1 className="cp-portal-heading">{isAr ? 'طلبات الشحن' : 'Charging orders'}</h1>
              {data.orders.length === 0 ? <p className="cp-portal-empty">{isAr ? 'لا توجد طلبات مسجلة.' : 'No orders found.'}</p> : <div className="cp-portal-list">
                {[...data.orders].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).map((order) => <article key={String(order.order_number) + order.created_at} className="cp-portal-order">
                  <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-bold">{isAr ? 'طلب رقم' : 'Order'} #{order.order_number}</h2><p className="mt-1 text-xs cp-portal-muted">{safeDate(order.created_at, locale)}</p></div><span className="cp-portal-status">{statusLabel(order.status)}</span></div>
                  <div className="cp-portal-order__totals"><div><span>{isAr ? 'الإجمالي' : 'Total'}</span><strong>{money(order.total_minor, locale)}</strong></div><div><span>{isAr ? 'المتبقي' : 'Due'}</span><strong>{money(order.due_minor, locale)}</strong></div></div>
                  <div className="mt-3">{order.items.map((item, index) => <div key={index} className="cp-portal-device-row"><div className="min-w-0"><p className="font-medium">{isAr ? item.device_name_ar : item.device_name_en}</p><p className="mt-1 text-xs cp-portal-muted">{item.has_charger ? (isAr ? 'مع شاحن' : 'With charger') : (isAr ? 'بدون شاحن' : 'No charger')} · {statusLabel(item.status)} · {statusLabel(item.payment_status)}</p></div><strong>{money(item.total_minor, locale)}</strong></div>)}</div>
                </article>)}
              </div>}
            </section>}

            {activeTab === 'finance' && <>
              <section className="cp-portal-section">
                <p className="cp-portal-eyebrow">{isAr ? 'حسابك المالي' : 'YOUR FINANCES'}</p>
                <h1 className="cp-portal-heading">{isAr ? 'كشف الحساب' : 'Account statement'}</h1>
                <div className="cp-portal-balance cp-portal-balance--compact"><p className="cp-portal-eyebrow">{isAr ? 'الرصيد الحالي' : 'CURRENT BALANCE'}</p><p className="mt-2 text-sm cp-portal-muted">{balanceLabel}</p><p className="cp-portal-balance__amount">{money(Math.abs(data.balance_minor), locale)}</p></div>
                <div className="cp-portal-subsection">
                  <div className="flex items-center justify-between gap-3"><h2 className="font-bold">{isAr ? 'الحركات المالية' : 'Financial movements'}</h2><span className="text-xs cp-portal-muted">{activity?.ledger.length ?? 0}</span></div>
                  {activityLoading && !activity ? <p className="cp-portal-empty">{isAr ? 'جارٍ تحميل الحركات المالية…' : 'Loading financial movements…'}</p>
                    : activityError || !activity ? <p className="cp-portal-empty">{isAr ? 'تعذّر تحميل كشف الحساب. حاول تحديث الصفحة عند توفر الاتصال.' : 'The statement could not be loaded. Refresh when connected.'}</p>
                    : activity.ledger.length === 0 ? <p className="cp-portal-empty">{isAr ? 'لا توجد حركات مالية مسجلة.' : 'No financial movements found.'}</p>
                    : <div className="cp-portal-timeline">{activity.ledger.map((entry) => <div key={entry.id} className="cp-portal-timeline__row cp-portal-finance-row"><span className="cp-portal-timeline__dot" /><div className="min-w-0 flex-1"><p className="font-semibold">{translateLedgerType(entry.event_type)}</p><p className="mt-1 text-xs cp-portal-muted">{safeDate(entry.created_at, locale)}</p></div><strong className="shrink-0">{money(entry.amount_minor, locale)}</strong></div>)}</div>}
                </div>
              </section>
              <section className="cp-portal-section">
                <h2 className="text-base font-bold">{isAr ? 'إيصالات الدفع' : 'Payment receipts'}</h2>
                <p className="mt-1 text-sm cp-portal-muted">{isAr ? 'الإيصال لا يُعد دفعة معتمدة إلا بعد موافقة الإدارة.' : 'A receipt is not an approved payment until the administrator accepts it.'}</p>
                {data.payment_submissions.length === 0 ? <p className="cp-portal-empty">{isAr ? 'لا توجد إيصالات مرسلة.' : 'No submitted receipts.'}</p> : <div className="cp-portal-timeline">{[...data.payment_submissions].sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime()).map((submission,index)=><div key={submission.created_at+'-'+index} className="cp-portal-timeline__row"><span className="cp-portal-timeline__dot" /><div className="min-w-0 flex-1"><p className="font-semibold">{isAr ? 'إيصال دفع' : 'Payment receipt'} · {statusLabel(submission.status)}</p><p className="mt-1 text-xs cp-portal-muted">{safeDate(submission.created_at, locale)}{submission.reviewed_at ? ' · ' + safeDate(submission.reviewed_at, locale) : ''}</p></div><strong>{money(submission.amount_minor, locale)}</strong></div>)}</div>}
                {online && <a href={'/pay/' + encodeURIComponent(token)} className="cp-portal-primary-link"><CreditCard size={18} />{isAr ? 'إرسال إيصال دفع' : 'Submit payment receipt'}</a>}
              </section>
            </>}

            {activeTab === 'goals' && <section className="cp-portal-section">
              <p className="cp-portal-eyebrow">{isAr ? 'التقدم والمكافآت' : 'PROGRESS & REWARDS'}</p>
              <h1 className="cp-portal-heading">{isAr ? 'الأهداف' : 'Goals'}</h1>
              {activeGoal ? <div className="cp-portal-goal">
                <div className="flex items-start justify-between gap-3"><div><p className="font-bold">{isAr ? 'هدف الشحن الحالي' : 'Current charging goal'}</p><p className="mt-1 text-sm cp-portal-muted">{isAr ? 'التقدم' : 'Progress'} · {activeGoal.current_progress} / {activeGoal.target_quantity}</p></div><span className="cp-portal-status">{statusLabel(activeGoal.status)}</span></div>
                <div className="cp-portal-progress"><span style={{ width: (Math.max(0, Math.min(100, activeGoal.target_quantity > 0 ? activeGoal.current_progress / activeGoal.target_quantity * 100 : 0))) + '%' }} /></div>
                {activeGoal.expires_at && <p className="mt-3 text-xs cp-portal-muted">{isAr ? 'ينتهي في' : 'Expires'} · {safeDate(activeGoal.expires_at, locale)}</p>}
                {activeGoal.bonus_recorded && activeGoal.bonus_minor !== null && <p className="mt-3 font-bold">{isAr ? 'المكافأة المثبتة' : 'Recorded reward'} · {money(activeGoal.bonus_minor, locale)}</p>}
              </div> : pendingGoalRequest ? <div className="cp-portal-request-state"><span className="cp-portal-request-state__icon"><History size={20} /></span><div><p className="font-bold">{isAr ? 'طلب إنشاء الهدف قيد المراجعة' : 'Goal request awaiting review'}</p><p className="mt-1 text-sm cp-portal-muted">{isAr ? 'الإدارة ستحدد تفاصيل الهدف عند الموافقة.' : 'The administrator will determine the goal details after approval.'}</p><p className="mt-2 text-xs cp-portal-muted">{safeDate(pendingGoalRequest.created_at, locale)}</p></div></div>
              : activityLoading ? <p className="cp-portal-empty">{isAr ? 'جارٍ التحقق من حالة الأهداف…' : 'Checking goal status…'}</p>
              : activityError || !activity ? <p className="cp-portal-empty">{isAr ? 'تعذّر التحقق من حالة الهدف. أعد المحاولة عند توفر الاتصال.' : 'Goal status is unavailable. Try again when connected.'}</p>
              : <div className="cp-portal-goal-empty"><span className="cp-portal-goal-empty__icon"><Target size={28} /></span><h2 className="mt-3 text-lg font-bold">{isAr ? 'ما عندك هدف حاليًا' : 'No active goal yet'}</h2><p className="mt-2 text-sm cp-portal-muted">{isAr ? 'تقدر ترسل طلبًا للإدارة، وهي تتولى تحديد تفاصيل الهدف واعتماده.' : 'You can request a goal; the administrator decides its details and approval.'}</p><button type="button" className="cp-portal-primary-button" disabled={!online || goalRequestBusy} onClick={() => void requestGoal()}>{goalRequestBusy ? <RefreshCw className="animate-spin" size={17} /> : <Target size={17} />}{isAr ? 'طلب إنشاء هدف' : 'Request a goal'}</button></div>}
              {data.goals.filter((goal) => goal.status.toUpperCase() !== 'ACTIVE').length > 0 && <div className="cp-portal-subsection"><h2 className="font-bold">{isAr ? 'الأهداف السابقة' : 'Previous goals'}</h2>{data.goals.filter((goal) => goal.status.toUpperCase() !== 'ACTIVE').map((goal,index)=><div key={index} className="cp-portal-history-row"><span>{statusLabel(goal.status)} · {goal.current_progress}/{goal.target_quantity}</span><span>{goal.bonus_recorded && goal.bonus_minor !== null ? money(goal.bonus_minor, locale) : '—'}</span></div>)}</div>}
            </section>}

            {activeTab === 'more' && moreView === 'profile' && <section className="cp-portal-section">
              <p className="cp-portal-eyebrow">{isAr ? 'بياناتك الشخصية' : 'YOUR DETAILS'}</p><h1 className="cp-portal-heading">{isAr ? 'حسابي' : 'My account'}</h1>
              <div className="cp-portal-profile"><div><span>{isAr ? 'اسم العميل' : 'Customer name'}</span><strong>{data.customer_name}</strong></div><div><span>{isAr ? 'رقم الحساب' : 'Account number'}</span><strong><bdi>{data.customer_code}</bdi></strong></div><div><span>{isAr ? 'آخر تسجيل دخول على هذا الجهاز' : 'Last sign-in on this device'}</span><strong>{activity?.last_login_at ? safeDate(activity.last_login_at, locale) : '—'}</strong></div><div><span>{isAr ? 'الجلسة الحالية · تنتهي في' : 'Current session · expires'}</span><strong>{activity?.session?.expires_at ? safeDate(activity.session.expires_at, locale) : '—'}</strong></div></div>
              <div className="cp-portal-subsection"><h2 className="font-bold">{isAr ? 'أمان الحساب' : 'Account security'}</h2><p className="mt-2 text-sm cp-portal-muted">{isAr ? 'إعادة تعيين كلمة المرور تحتاج موافقة الإدارة، وبعد الموافقة يجب اختيار كلمة مرور جديدة.' : 'Password reset requires administrator approval. After approval, you must set a new password.'}</p><button type="button" className="cp-portal-secondary-button" disabled={!online || resetRequestBusy} onClick={() => void requestPasswordReset()}>{resetRequestBusy ? <RefreshCw size={17} className="animate-spin" /> : <KeyRound size={17} />}{isAr ? 'طلب إعادة تعيين كلمة المرور' : 'Request password reset'}</button></div>
            </section>}

            {activeTab === 'more' && moreView === 'events' && <section className="cp-portal-section">
              <p className="cp-portal-eyebrow">{isAr ? 'سجل النشاط' : 'ACTIVITY HISTORY'}</p><h1 className="cp-portal-heading">{isAr ? 'الأحداث' : 'Events'}</h1>
              {eventRows.length ? <div className="cp-portal-timeline">{eventRows.map((event)=><div key={event.id} className="cp-portal-timeline__row"><span className="cp-portal-timeline__dot" /><div className="min-w-0 flex-1"><p className="font-semibold">{event.title}</p><p className="mt-1 text-xs cp-portal-muted">{event.detail} · {safeDate(event.created_at, locale)}</p></div></div>)}</div> : <p className="cp-portal-empty">{activityLoading ? (isAr ? 'جارٍ تحميل الأحداث…' : 'Loading events…') : (isAr ? 'لا توجد أحداث مسجلة.' : 'No events recorded.')}</p>}
            </section>}

            {activeTab === 'more' && moreView === 'notifications' && <section className="cp-portal-section">
              <p className="cp-portal-eyebrow">{isAr ? 'آخر المستجدات' : 'LATEST UPDATES'}</p><h1 className="cp-portal-heading">{isAr ? 'الإشعارات' : 'Notifications'}</h1>
              {activity?.events.some((event) => event.event_type === 'TEMP_PASSWORD_ISSUED') && <div className="cp-portal-notice"><Bell size={18} /><p>{isAr ? 'تمت الموافقة على طلب إعادة تعيين كلمة المرور. اتبع تعليمات تغيير كلمة المرور عند تسجيل الدخول.' : 'Your password-reset request was approved. Follow the password-change instructions when signing in.'}</p></div>}
              {eventRows.length ? <div className="cp-portal-timeline">{eventRows.map((event)=><div key={event.id} className="cp-portal-timeline__row"><span className="cp-portal-timeline__dot" /><div className="min-w-0 flex-1"><p className="font-semibold">{event.title}</p><p className="mt-1 text-xs cp-portal-muted">{event.detail} · {safeDate(event.created_at, locale)}</p></div></div>)}</div> : <p className="cp-portal-empty">{isAr ? 'لا توجد إشعارات حتى الآن.' : 'No notifications yet.'}</p>}
            </section>}

            {activeTab === 'more' && moreView === 'settings' && <section className="cp-portal-section">
              <p className="cp-portal-eyebrow">{isAr ? 'تفضيلاتك' : 'PREFERENCES'}</p><h1 className="cp-portal-heading">{isAr ? 'الإعدادات' : 'Settings'}</h1>
              <div className="cp-portal-setting-row"><div><p className="font-semibold">{isAr ? 'المظهر' : 'Appearance'}</p><p className="mt-1 text-xs cp-portal-muted">{isAr ? 'داكن افتراضيًا ويمكنك تغييره' : 'Dark by default; change it anytime'}</p></div><button type="button" className="cp-portal-setting-button" onClick={toggleTheme}>{resolvedTheme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}{resolvedTheme === 'dark' ? (isAr ? 'فاتح' : 'Light') : (isAr ? 'داكن' : 'Dark')}</button></div>
              <div className="cp-portal-setting-row"><div><p className="font-semibold">{isAr ? 'اللغة' : 'Language'}</p><p className="mt-1 text-xs cp-portal-muted">{isAr ? 'اختر لغة الواجهة' : 'Choose your interface language'}</p></div><button type="button" className="cp-portal-setting-button" onClick={() => setLocale(isAr ? 'en' : 'ar')}><Globe size={17} />{isAr ? 'English' : 'العربية'}</button></div>
              <div className="cp-portal-subsection">
                <h2 className="font-bold">{isAr ? 'تغيير كلمة المرور' : 'Change password'}</h2>
                {!showPasswordChange ? <button type="button" className="cp-portal-secondary-button" disabled={!online} onClick={() => { setActionMessage(''); setShowPasswordChange(true); }}><KeyRound size={17} />{isAr ? 'تغيير كلمة المرور' : 'Change password'}</button>
                : <form className="cp-portal-password-form" onSubmit={(event) => { event.preventDefault(); void changePortalPassword(); }}>
                  <label className="cp-portal-password-label">{isAr ? 'كلمة المرور الجديدة' : 'New password'}</label>
                  <input type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className="cp-portal-password-input" />
                  <label className="cp-portal-password-label">{isAr ? 'تأكيد كلمة المرور' : 'Confirm password'}</label>
                  <input type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={confirmNewPassword} onChange={(event) => setConfirmNewPassword(event.target.value)} className="cp-portal-password-input" />
                  <p className="text-xs cp-portal-muted">{isAr ? '8 أحرف على الأقل، وتجنّب كلمات المرور الشائعة.' : 'At least 8 characters; avoid common passwords.'}</p>
                  <div className="flex flex-wrap gap-2"><button type="submit" className="cp-portal-primary-button" disabled={!online || passwordChangeBusy}>{passwordChangeBusy ? <RefreshCw size={17} className="animate-spin" /> : <KeyRound size={17} />}{isAr ? 'حفظ كلمة المرور' : 'Save password'}</button><button type="button" className="cp-portal-secondary-button" disabled={passwordChangeBusy} onClick={() => { setShowPasswordChange(false); setNewPassword(''); setConfirmNewPassword(''); }}>{isAr ? 'إلغاء' : 'Cancel'}</button></div>
                </form>}
              </div>
              <div className="cp-portal-profile cp-portal-profile--footer"><div><span>{isAr ? 'اسم العميل' : 'Customer name'}</span><strong>{data.customer_name}</strong></div><div><span>{isAr ? 'آخر تسجيل دخول على هذا الجهاز' : 'Last sign-in on this device'}</span><strong>{activity?.last_login_at ? safeDate(activity.last_login_at, locale) : '—'}</strong></div><div><span>{isAr ? 'الجلسة الحالية · تنتهي في' : 'Current session · expires'}</span><strong>{activity?.session?.expires_at ? safeDate(activity.session.expires_at, locale) : '—'}</strong></div></div>
              <button type="button" className="cp-portal-signout" onClick={() => onLogout?.()} disabled={!onLogout}><UserRound size={17} />{isAr ? 'تسجيل الخروج' : 'Sign out'}</button>
            </section>}

            <p className="cp-portal-footnote"><CheckCircle2 size={15} />{isAr ? 'عرض معلومات الحساب فقط؛ اعتماد الدفعات وتحديد الأهداف من صلاحيات الإدارة.' : 'Account information only; payment approval and goal assignment remain administrator-controlled.'}</p>
          </>}
      </main>
      <footer className="relative z-10 border-t border-slate-200/70 px-4 py-5 text-center text-xs text-slate-500 dark:border-emerald-950/70 dark:text-emerald-100/50">{isAr ? 'نقطة الشحن · بوابة العميل الآمنة' : 'Charging Point · Secure customer portal'}</footer>
      {data && !loading && !error && <CustomerPortalNavigation activeTab={activeTab} onTabChange={setActiveTab} moreView={moreView} onMoreViewChange={(view) => { setMoreView(view); if (view === 'notifications') markNotificationsSeen(); }} notificationCount={eventRows.filter((event) => !seenNotificationIds.includes(event.id)).length} isAr={isAr} />}
    </div>
  );
};
