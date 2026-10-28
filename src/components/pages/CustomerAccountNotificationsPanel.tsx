import React, { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { Bell, Check, CheckCircle2, Clipboard, KeyRound, LoaderCircle, RefreshCw, ShieldAlert } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { config } from '../../config/env';
import { getSupabaseAuthToken } from '../../services/supabase/client';
import { callCustomerAccount } from '../../services/customer/customerAuth';

type ResetRequest = {
  id: string;
  customer_id: string;
  status: string;
  requested_at: string;
  expires_at: string;
  customers?: { name?: string } | Array<{ name?: string }> | null;
};
type AccountEvent = {
  id: string;
  customer_id: string;
  event_type: string;
  request_id?: string | null;
  is_read: boolean;
  created_at: string;
  customers?: { name?: string } | Array<{ name?: string }> | null;
};
type CustomerAccount = {
  customer_id: string;
  account_status: 'ACTIVE' | 'FROZEN' | 'CANCELLED' | string;
  auth_provider: string;
  must_change_password: boolean;
  created_at: string;
  customers?: { name?: string } | Array<{ name?: string }> | null;
};
type HistoryRequest = { id: string; customer_id: string; status: string; requested_at: string; customers?: { name?: string } | Array<{ name?: string }> | null };
type WalletActivationRequest = { id: string; customer_id: string; status: string; requested_at: string; customers?: { name?: string } | Array<{ name?: string }> | null };
type InboxData = { requests?: ResetRequest[]; events?: AccountEvent[]; accounts?: CustomerAccount[]; walletActivationRequests?: WalletActivationRequest[] };

const customerName = (value: ResetRequest['customers'] | AccountEvent['customers']) =>
  Array.isArray(value) ? value[0]?.name ?? '' : value?.name ?? '';

const makeTemporaryPassword = () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (byte) => alphabet[byte & 63]).join('');
};

export const CustomerAccountNotificationsPanel: React.FC = () => {
  const { locale } = useI18n();
  const isAr = locale === 'ar';
  const [requests, setRequests] = useState<ResetRequest[]>([]);
  const [events, setEvents] = useState<AccountEvent[]>([]);
  const [accounts, setAccounts] = useState<CustomerAccount[]>([]);
  const [historyRequests, setHistoryRequests] = useState<HistoryRequest[]>([]);
  const [walletActivationRequests, setWalletActivationRequests] = useState<WalletActivationRequest[]>([]);
  const [walletRejectionReasons, setWalletRejectionReasons] = useState<Record<string, string>>({});
  const [pendingStatus, setPendingStatus] = useState<{ customerId: string; status: 'ACTIVE' | 'FROZEN'; name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [prepared, setPrepared] = useState<{ requestId: string; customerName: string; password: string } | null>(null);
  const [issued, setIssued] = useState<{ customerName: string; password: string } | null>(null);

  const t = (ar: string, en: string) => isAr ? ar : en;
  const load = useCallback(async (quiet = false, background = false) => {
    if (!quiet && !background) setLoading(true);
    if (!background) setError('');
    const token = getSupabaseAuthToken();
    if (!token) {
      if (!background) {
        setError(t('انتهت جلسة المشرف. سجّل الدخول مجددًا.', 'The administrator session has expired. Sign in again.'));
        setLoading(false);
      }
      return;
    }
    try {
      const result = await callCustomerAccount<InboxData>('admin-list', {}, token);
      if (result.error || !result.data) throw new Error(result.error || 'SERVICE_UNAVAILABLE');
      setRequests(Array.isArray(result.data.requests) ? result.data.requests : []);
      setEvents(Array.isArray(result.data.events) ? result.data.events : []);
      setAccounts(Array.isArray(result.data.accounts) ? result.data.accounts : []);
      setWalletActivationRequests(Array.isArray(result.data.walletActivationRequests) ? result.data.walletActivationRequests : []);
      const historyUrl = config.supabaseUrl.endsWith('/') ? config.supabaseUrl.slice(0, -1) : config.supabaseUrl;
      const historyResponse = await fetch(historyUrl + '/functions/v1/customer-history', {
        method: 'POST',
        headers: { apikey: config.supabaseAnonKey, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'admin-list' }),
      });
      const historyResult = await historyResponse.json().catch(() => null);
      if (!historyResponse.ok || historyResult?.ok !== true) throw new Error('HISTORY_REQUESTS_UNAVAILABLE');
      setHistoryRequests(Array.isArray(historyResult.requests) ? historyResult.requests : []);
    } catch {
      if (!background) setError(t('تعذّر تحميل إشعارات حسابات العملاء. تحقق من الصلاحيات والاتصال.', 'Could not load customer account notifications. Check permissions and connectivity.'));
    } finally {
      if (!background) setLoading(false);
    }
  }, [isAr]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let disposed = false;
    let pushListener: { remove: () => Promise<void> } | null = null;
    let pushListenerDisposed = false;
    const refreshVisible = () => {
      if (disposed || document.visibilityState !== 'visible' || navigator.onLine === false) return;
      void load(false, true);
    };
    const timer = window.setInterval(refreshVisible, 10000);
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('online', refreshVisible);
    if (Capacitor.isNativePlatform()) {
      void PushNotifications.addListener('pushNotificationReceived', refreshVisible).then((handle) => {
        if (pushListenerDisposed) void handle.remove();
        else pushListener = handle;
      }).catch((error) => console.warn('Customer account inbox refresh listener unavailable.', error));
    }
    return () => {
      disposed = true;
      pushListenerDisposed = true;
      if (pushListener) void pushListener.remove();
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.removeEventListener('online', refreshVisible);
    };
  }, [load]);

  const prepareReset = (request: ResetRequest) => {
    setPrepared({
      requestId: request.id,
      customerName: customerName(request.customers) || request.customer_id,
      password: makeTemporaryPassword(),
    });
    setIssued(null);
    setMessage('');
    setError('');
  };

  const copyPassword = async (password: string) => {
    try {
      await navigator.clipboard.writeText(password);
      setMessage(t('تم نسخ كلمة السر المؤقتة.', 'Temporary password copied.'));
    } catch {
      setError(t('تعذّر النسخ التلقائي. حدّد كلمة السر وانسخها يدويًا.', 'Automatic copy failed. Select and copy the password manually.'));
    }
  };

  const saveReset = async () => {
    if (!prepared || busy) return;
    const token = getSupabaseAuthToken();
    if (!token) {
      setError(t('انتهت جلسة المشرف. سجّل الدخول مجددًا.', 'The administrator session has expired. Sign in again.'));
      return;
    }
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await callCustomerAccount('admin-reset', {
        requestId: prepared.requestId,
        temporaryPassword: prepared.password,
      }, token);
      if (result.error) {
        setError(result.error === 'REQUEST_NO_LONGER_PENDING'
          ? t('انتهت صلاحية الطلب أو تمت معالجته. حدّث القائمة.', 'This request expired or was already processed. Refresh the list.')
          : t('تعذّر اعتماد إعادة التعيين. لم نعرض العملية على أنها ناجحة؛ حدّث القائمة وتحقق من حالة الحساب.', 'Reset could not be confirmed. Refresh the list and verify the account state.'));
        return;
      }
      setIssued({ customerName: prepared.customerName, password: prepared.password });
      setPrepared(null);
      setMessage(t('تم اعتماد كلمة السر المؤقتة. انسخها وسلّمها للعميل بطريقة آمنة.', 'The temporary password is active. Copy it and deliver it to the customer securely.'));
      await load(true);
    } finally { setBusy(false); }
  };

  const reviewHistoryRequest = async (requestId: string, decision: 'APPROVE' | 'REJECT') => {
    const token = getSupabaseAuthToken();
    if (!token || busy) return;
    setBusy(true);
    try {
      const baseUrl = config.supabaseUrl.endsWith('/') ? config.supabaseUrl.slice(0, -1) : config.supabaseUrl;
      const response = await fetch(baseUrl + '/functions/v1/customer-history', {
        method: 'POST',
        headers: { apikey: config.supabaseAnonKey, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'admin-review', requestId, decision }),
      });
      const result = await response.json();
      if (!response.ok || result?.ok !== true) throw new Error('REVIEW_FAILED');
      setHistoryRequests((items) => items.filter((item) => item.id !== requestId));
      setMessage(decision === 'APPROVE' ? t('تمت الموافقة لمدة 24 ساعة.', 'Approved for 24 hours.') : t('تم رفض الطلب.', 'Request rejected.'));
    } catch {
      setError(t('تعذّرت معالجة الطلب.', 'Could not process request.'));
    } finally { setBusy(false); }
  };

  const reviewWalletActivation = async (requestId: string, decision: 'APPROVE' | 'REJECT') => {
    const token = getSupabaseAuthToken();
    if (!token || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await callCustomerAccount('admin-review-wallet-activation', {
        requestId, decision,
        rejectionReason: decision === 'REJECT' ? (walletRejectionReasons[requestId] ?? '').trim() : '',
      }, token);
      if (result.error) throw new Error(result.error);
      setWalletActivationRequests((items) => items.filter((item) => item.id !== requestId));
      setMessage(decision === 'APPROVE'
        ? t('تم تفعيل المحفظة للعميل.', 'Wallet access has been enabled for this customer.')
        : t('تم رفض طلب تفعيل المحفظة.', 'The wallet activation request was rejected.'));
      await load(true);
    } catch {
      setError(t('تعذّرت معالجة طلب المحفظة. حدّث القائمة وتأكد من حالته.', 'Could not process the wallet request. Refresh the list and verify its status.'));
    } finally { setBusy(false); }
  };

  const changeAccountStatus = async () => {
    if (!pendingStatus || busy) return;
    const token = getSupabaseAuthToken();
    if (!token) { setError(t('انتهت جلسة المشرف. سجّل الدخول مجددًا.', 'The administrator session has expired. Sign in again.')); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await callCustomerAccount('admin-set-status', {
        customerId: pendingStatus.customerId, status: pendingStatus.status,
      }, token);
      if (result.error) throw new Error(result.error);
      setMessage(pendingStatus.status === 'FROZEN'
        ? t('تم تجميد الحساب وإلغاء جلساته.', 'The account is frozen and its sessions have been revoked.')
        : t('تم تفعيل الحساب. يجب على العميل تسجيل الدخول مجددًا.', 'The account is active again. The customer must sign in again.'));
      setPendingStatus(null);
      await load(true);
    } catch {
      setError(t('تعذّر تأكيد تغيير حالة الحساب. حدّث القائمة وتحقق من الحالة.', 'Could not confirm the account status change. Refresh and verify the current state.'));
    } finally { setBusy(false); }
  };

  const markRead = async (event: AccountEvent) => {
    if (event.is_read || busy) return;
    const token = getSupabaseAuthToken();
    if (!token) return;
    setBusy(true); setError('');
    try {
      const result = await callCustomerAccount('admin-mark-event-read', { eventId: event.id }, token);
      if (result.error) throw new Error(result.error);
      setEvents((current) => current.map((item) => item.id === event.id ? { ...item, is_read: true } : item));
    } catch {
      setError(t('تعذّر تحديث حالة الإشعار.', 'Could not update notification status.'));
    } finally { setBusy(false); }
  };

  const eventLabel = (event: AccountEvent) => {
    const labels: Record<string, [string, string]> = {
      RESET_REQUESTED: ['طلب إعادة تعيين كلمة السر', 'Password reset requested'],
      HISTORY_ACCESS_APPROVED: ['تمت الموافقة على كشف الطلبات لمدة 24 ساعة', 'Historical order access approved for 24 hours'],
      HISTORY_ACCESS_REJECTED: ['تم رفض طلب كشف الطلبات التاريخية', 'Historical order access request rejected'],
      DEBT_PAYMENT_REMINDER: ['تذكير بالدفع', 'Payment reminder'],
      TEMP_PASSWORD_ISSUED: ['أصدر المشرف كلمة سر مؤقتة', 'Administrator issued a temporary password'],
      PASSWORD_CHANGED: ['غيّر العميل كلمة السر', 'Customer changed password'],
      EMAIL_RESET_SENT: ['أُرسل رابط استعادة إلى البريد', 'Email recovery link sent'],
      ACCOUNT_FROZEN: ['جمّد المشرف الحساب وألغى الجلسات', 'Administrator froze the account and revoked sessions'],
      ACCOUNT_REACTIVATED: ['أعاد المشرف تفعيل الحساب', 'Administrator reactivated the account'],
      ACCOUNT_CANCELLED: ['ألغى المشرف الحساب', 'Administrator cancelled the account'],
      TERMS_ACCEPTED: ['وافق العميل على الشروط المحدّثة', 'Customer accepted updated terms'],
      GOAL_REQUESTED: ['طلب العميل إنشاء هدف جديد', 'Customer requested a new goal'],
      WALLET_ACTIVATION_REQUESTED: ['طلب العميل تفعيل المحفظة', 'Customer requested wallet activation'],
      WALLET_ACTIVATION_APPROVED: ['تمت الموافقة على تفعيل المحفظة', 'Wallet activation approved'],
      WALLET_ACTIVATION_REJECTED: ['تم رفض طلب تفعيل المحفظة', 'Wallet activation request rejected'],
    };
    return labels[event.event_type]?.[isAr ? 0 : 1] ?? event.event_type;
  };
  const dateLabel = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(isAr ? 'ar-PS' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  };

  return (
    <section className="space-y-4 rounded-2xl border border-emerald-200 bg-white p-4 shadow-sm dark:border-emerald-900/70 dark:bg-[#0a2423] sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"><Bell className="h-5 w-5" /></span>
          <div>
            <h2 className="text-lg font-bold">{t('حسابات العملاء وكلمات السر', 'Customer accounts and passwords')}</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-[#9bb6b0]">{t('طلبات إعادة التعيين وتنبيهات تغيّر كلمة السر.', 'Reset requests and password-change notifications.')}</p>
          </div>
        </div>
        <button type="button" onClick={() => void load(true)} disabled={loading || busy} className="inline-flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-2 text-xs font-semibold dark:border-[#315653]"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />{t('تحديث', 'Refresh')}</button>
      </div>

      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200">{error}</p>}
      {message && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">{message}</p>}

      {prepared && (
        <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/25">
          <div className="flex items-start gap-2"><ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" /><div><h3 className="font-bold">{t('كلمة سر مؤقتة جاهزة', 'Temporary password prepared')}</h3><p className="mt-1 text-sm">{t('للعميل: ', 'For customer: ')}<strong>{prepared.customerName}</strong>. {t('لن تصبح فعالة قبل الضغط على حفظ واعتماد.', 'It will not become active until you select Save and activate.')}</p></div></div>
          <div className="flex flex-wrap items-center gap-2">
            <code dir="ltr" className="min-w-0 flex-1 select-all break-all rounded-lg border border-amber-300 bg-white px-3 py-3 text-sm font-bold tracking-wide text-gray-900">{prepared.password}</code>
            <button type="button" onClick={() => void copyPassword(prepared.password)} className="inline-flex items-center gap-2 rounded-lg border border-amber-400 px-3 py-3 text-xs font-bold"><Clipboard className="h-4 w-4" />{t('نسخ', 'Copy')}</button>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => void saveReset()} className="inline-flex items-center gap-2 rounded-xl bg-emerald-700 px-4 py-3 text-sm font-bold text-white disabled:opacity-50">{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}{t('حفظ واعتماد الكلمة المؤقتة', 'Save and activate temporary password')}</button>
            <button type="button" disabled={busy} onClick={() => setPrepared(null)} className="rounded-xl border border-gray-300 px-4 py-3 text-sm font-semibold dark:border-[#315653]">{t('إلغاء', 'Cancel')}</button>
          </div>
        </div>
      )}

      {issued && (
        <div className="space-y-3 rounded-xl border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/25">
          <p className="font-bold text-emerald-900 dark:text-emerald-100"><CheckCircle2 className="me-2 inline h-5 w-5" />{t('الكلمة المؤقتة فعّالة للعميل: ', 'Temporary password is active for: ')}{issued.customerName}</p>
          <div className="flex flex-wrap items-center gap-2"><code dir="ltr" className="min-w-0 flex-1 select-all break-all rounded-lg border border-emerald-300 bg-white px-3 py-3 text-sm font-bold text-gray-900">{issued.password}</code><button type="button" onClick={() => void copyPassword(issued.password)} className="inline-flex items-center gap-2 rounded-lg border border-emerald-400 px-3 py-3 text-xs font-bold"><Clipboard className="h-4 w-4" />{t('نسخ', 'Copy')}</button></div>
          <p className="text-xs leading-5 text-emerald-900 dark:text-emerald-100">{t('سيُطلب من العميل تغييرها قبل فتح بياناته. لا تغلق هذه الرسالة قبل نسخها.', 'The customer must change it before accessing account data. Copy it before closing this message.')}</p>
          <button type="button" onClick={() => setIssued(null)} className="text-xs font-semibold underline">{t('إخفاء كلمة السر بعد حفظها', 'Hide password after saving it')}</button>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="font-bold">{t('حالة حسابات العملاء', 'Customer account status')} <span className="text-sm font-normal text-gray-500">({accounts.length})</span></h3>
        {loading ? <p className="py-4 text-sm text-gray-500">{t('جارٍ التحميل…', 'Loading…')}</p>
          : accounts.length === 0 ? <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-500 dark:bg-[#0b302b]">{t('لا توجد حسابات مفعّلة بعد.', 'No activated customer accounts yet.')}</p>
          : accounts.map((account) => {
            const name = customerName(account.customers) || account.customer_id;
            return <article key={account.customer_id} className="space-y-3 rounded-xl border border-gray-200 p-3 dark:border-[#244746]">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><p className="font-semibold">{name}</p><p className="mt-1 text-xs text-gray-500">{t('طريقة الدخول: ', 'Sign-in method: ')}{account.auth_provider} · {t('الحالة: ', 'Status: ')}{account.account_status === 'ACTIVE' ? t('فعّال', 'Active') : account.account_status === 'FROZEN' ? t('مجمّد', 'Frozen') : t('ملغى', 'Cancelled')}{account.must_change_password ? ' · ' + t('بانتظار تغيير كلمة السر', 'Password change required') : ''}</p></div>
                {account.account_status === 'ACTIVE' && <button type="button" disabled={busy} onClick={() => setPendingStatus({ customerId: account.customer_id, status: 'FROZEN', name })} className="rounded-xl border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700 dark:border-rose-900 dark:text-rose-200">{t('تجميد الحساب', 'Freeze account')}</button>}
                {account.account_status === 'FROZEN' && <button type="button" disabled={busy} onClick={() => setPendingStatus({ customerId: account.customer_id, status: 'ACTIVE', name })} className="rounded-xl border border-emerald-300 px-3 py-2 text-xs font-bold text-emerald-800 dark:border-emerald-900 dark:text-emerald-200">{t('إعادة التفعيل', 'Reactivate account')}</button>}
              </div>
              {pendingStatus?.customerId === account.customer_id && <div role="alertdialog" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/25 dark:text-amber-100">
                <p className="font-semibold">{pendingStatus.status === 'FROZEN' ? t('تجميد حساب ', 'Freeze account for ') : t('إعادة تفعيل حساب ', 'Reactivate account for ')}{pendingStatus.name}؟</p>
                <p className="mt-1 text-xs">{pendingStatus.status === 'FROZEN' ? t('سيُمنع الدخول وتُلغى الجلسة المسجلة على الجهاز.', 'Sign-in will be blocked and the registered device session will be revoked.') : t('سيُسمح بتسجيل الدخول مجددًا، لكن لن تُستعاد الجلسات السابقة.', 'Sign-in will be allowed again, but previous sessions will not be restored.')}</p>
                <div className="mt-3 flex gap-2"><button type="button" disabled={busy} onClick={() => setPendingStatus(null)} className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold dark:border-[#315653]">{t('إلغاء', 'Cancel')}</button><button type="button" disabled={busy} onClick={() => void changeAccountStatus()} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{busy ? t('جارٍ التنفيذ…', 'Working…') : t('تأكيد', 'Confirm')}</button></div>
              </div>}
            </article>;
          })}
      </div>

      <div className="space-y-2">
        <h3 className="font-bold">{t('طلبات كشف الطلبات التاريخية', 'Historical order access requests')} <span className="text-sm font-normal text-gray-500">({historyRequests.length})</span></h3>
        {historyRequests.length === 0
          ? <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-500 dark:bg-[#0b302b]">{t('لا توجد طلبات كشف تاريخي معلّقة.', 'No pending history access requests.')}</p>
          : historyRequests.map((request) => <article key={request.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 p-3 dark:border-amber-900">
              <div><p className="font-semibold">{customerName(request.customers) || request.customer_id}</p><p className="mt-1 text-xs text-gray-500">{t('طلب الكشف في: ', 'Requested: ')}{dateLabel(request.requested_at)}</p></div>
              <div className="flex gap-2">
                <button type="button" disabled={busy} onClick={() => void reviewHistoryRequest(request.id, 'APPROVE')} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{t('موافقة 24 ساعة', 'Approve 24 hours')}</button>
                <button type="button" disabled={busy} onClick={() => void reviewHistoryRequest(request.id, 'REJECT')} className="rounded-lg border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700 disabled:opacity-50 dark:border-rose-900 dark:text-rose-200">{t('رفض', 'Reject')}</button>
              </div>
            </article>)}
      </div>

      <div className="space-y-3">
        <h3 className="font-bold">{t('طلبات تفعيل المحفظة', 'Wallet activation requests')} <span className="text-sm font-normal text-gray-500">({walletActivationRequests.length})</span></h3>
        {walletActivationRequests.length === 0
          ? <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-500 dark:bg-[#0b302b]">{t('ما في طلبات تفعيل محفظة معلّقة.', 'No pending wallet activation requests.')}</p>
          : walletActivationRequests.map((request) => <article key={request.id} className="space-y-3 rounded-xl border border-emerald-200 p-3 dark:border-emerald-900">
              <div><p className="font-semibold">{customerName(request.customers) || request.customer_id}</p><p className="mt-1 text-xs text-gray-500">{t('تاريخ الطلب: ', 'Requested: ')}{dateLabel(request.requested_at)}</p></div>
              <label className="block text-xs font-semibold">{t('سبب الرفض (اختياري)', 'Rejection reason (optional)')}<textarea maxLength={1000} value={walletRejectionReasons[request.id] ?? ''} onChange={(event) => setWalletRejectionReasons((items) => ({ ...items, [request.id]: event.target.value }))} className="mt-2 w-full rounded-xl border border-gray-200 bg-white p-3 text-sm dark:border-[#315653] dark:bg-[#0b2928]" rows={2} /></label>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => void reviewWalletActivation(request.id, 'APPROVE')} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{t('موافقة وتفعيل', 'Approve and enable')}</button>
                <button type="button" disabled={busy} onClick={() => void reviewWalletActivation(request.id, 'REJECT')} className="rounded-lg border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700 disabled:opacity-50 dark:border-rose-900 dark:text-rose-200">{t('رفض الطلب', 'Reject request')}</button>
              </div>
            </article>)}
      </div>

      <div className="space-y-2">
        <h3 className="font-bold">{t('طلبات إعادة التعيين المعلّقة', 'Pending reset requests')} <span className="text-sm font-normal text-gray-500">({requests.length})</span></h3>
        {loading ? <p className="py-4 text-sm text-gray-500">{t('جارٍ التحميل…', 'Loading…')}</p>
          : requests.length === 0 ? <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-500 dark:bg-[#0b302b]">{t('لا توجد طلبات معلّقة.', 'No pending reset requests.')}</p>
          : requests.map((request) => <article key={request.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 p-3 dark:border-[#244746]">
              <div><p className="font-semibold">{customerName(request.customers) || request.customer_id}</p><p className="mt-1 text-xs text-gray-500">{t('تاريخ الطلب: ', 'Requested: ')}{dateLabel(request.requested_at)} · {t('ينتهي: ', 'Expires: ')}{dateLabel(request.expires_at)}</p></div>
              <button type="button" disabled={busy} onClick={() => prepareReset(request)} className="inline-flex items-center gap-2 rounded-xl bg-emerald-700 px-3.5 py-2.5 text-xs font-bold text-white disabled:opacity-50"><KeyRound className="h-4 w-4" />{t('إعادة تعيين', 'Reset password')}</button>
            </article>)}
      </div>

      <div className="space-y-2">
        <h3 className="font-bold">{t('سجل إشعارات الحسابات', 'Account notification history')} <span className="text-sm font-normal text-gray-500">({events.length})</span></h3>
        {events.length === 0 ? <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-500 dark:bg-[#0b302b]">{t('لا توجد إشعارات بعد.', 'No account notifications yet.')}</p>
          : events.map((event) => <article key={event.id} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 ${event.is_read ? 'border-gray-200 opacity-75 dark:border-[#244746]' : 'border-emerald-300 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/20'}`}>
              <div className="flex items-start gap-2"><span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-600" /><div><p className="font-semibold">{customerName(event.customers) || event.customer_id}</p><p className="text-sm">{eventLabel(event)}</p><p className="mt-1 text-xs text-gray-500">{dateLabel(event.created_at)}</p></div></div>
              {!event.is_read && <button type="button" disabled={busy} onClick={() => void markRead(event)} className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold dark:border-[#315653]"><Check className="h-3.5 w-3.5" />{t('تمت المراجعة', 'Mark read')}</button>}
            </article>)}
      </div>
    </section>
  );
};
