import React, { useCallback, useEffect, useState } from 'react';
import { Bell, Check, CheckCircle2, Clipboard, KeyRound, LoaderCircle, RefreshCw, ShieldAlert } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
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
type InboxData = { requests?: ResetRequest[]; events?: AccountEvent[] };

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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [prepared, setPrepared] = useState<{ requestId: string; customerName: string; password: string } | null>(null);
  const [issued, setIssued] = useState<{ customerName: string; password: string } | null>(null);

  const t = (ar: string, en: string) => isAr ? ar : en;
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError('');
    const token = getSupabaseAuthToken();
    if (!token) {
      setError(t('انتهت جلسة المشرف. سجّل الدخول مجددًا.', 'The administrator session has expired. Sign in again.'));
      setLoading(false);
      return;
    }
    try {
      const result = await callCustomerAccount<InboxData>('admin-list', {}, token);
      if (result.error || !result.data) throw new Error(result.error || 'SERVICE_UNAVAILABLE');
      setRequests(Array.isArray(result.data.requests) ? result.data.requests : []);
      setEvents(Array.isArray(result.data.events) ? result.data.events : []);
    } catch {
      setError(t('تعذّر تحميل إشعارات حسابات العملاء. تحقق من الصلاحيات والاتصال.', 'Could not load customer account notifications. Check permissions and connectivity.'));
    } finally { setLoading(false); }
  }, [isAr]);

  useEffect(() => { void load(); }, [load]);

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
      TEMP_PASSWORD_ISSUED: ['أصدر المشرف كلمة سر مؤقتة', 'Administrator issued a temporary password'],
      PASSWORD_CHANGED: ['غيّر العميل كلمة السر', 'Customer changed password'],
      EMAIL_RESET_SENT: ['أُرسل رابط استعادة إلى البريد', 'Email recovery link sent'],
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
