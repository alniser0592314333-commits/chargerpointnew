import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import {
  AlertCircle, ArrowUpRight, Banknote, CheckCircle2, Clock3, FileImage,
  RefreshCw, ShieldCheck, XCircle,
} from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { invokeSupabaseRpc, getSupabaseAuthToken, supabaseRefreshToken } from '../../services/supabase/client';
import { config } from '../../config/env';
import { CustomerAccountNotificationsPanel } from './CustomerAccountNotificationsPanel';

type PaymentMethod = 'JAWAL_PAY' | 'PALPAY' | 'BANK_OF_PALESTINE' | string;

const parseApprovalAmountMinor = (value: string): number | null => {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const minor = Math.round(amount * 100);
  return Number.isSafeInteger(minor) && minor > 0 && minor <= 99_999_999_999 ? minor : null;
};

interface PendingQrPayment {
  id: string;
  order_id: string;
  order_number: number | null;
  customer_id: string;
  customer_name: string;
  amount_minor: number;
  payment_method: PaymentMethod;
  receipt_path: string;
  note?: string | null;
  status: string;
  created_at: string;
  receiptSignedUrl?: string;
}

const methodDetails: Record<string, { ar: string; en: string; mark: string; cls: string; logoUrl: string }> = {
  JAWAL_PAY: { ar: 'جوال باي', en: 'Jawwal Pay', mark: 'Jawwal Pay', cls: 'bg-[#f5e9ed] text-[#8e2342]', logoUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/15/79/dc/1579dcea-3b6b-459a-3fb8-752262e39b6f/AppIcon-0-1x_U007emarketing-0-8-0-0-sRGB-85-220-0.png/512x512bb.jpg' },
  PALPAY: { ar: 'بال باي', en: 'PalPay', mark: 'PALPAY', cls: 'bg-[#f2e8ff] text-[#6634a5]', logoUrl: 'https://bopwebsitestorage.blob.core.windows.net/assets/uploads/l9IcwMLAVdCnG7anhRZRTisqSbNCcsYK1NV4LwZM.png' },
  BANK_OF_PALESTINE: { ar: 'بنك فلسطين', en: 'Bank of Palestine', mark: 'BOP', cls: 'bg-[#e7f1e9] text-[#1d6a45]', logoUrl: 'https://bopwebsitestorage.blob.core.windows.net/assets/news/9sJP6saDV32QxvHqVHnTxo74fVXnHdPcCBzT2okA.jpg' },
};

const ReviewMethodLogo: React.FC<{ detail: { mark: string; cls: string; logoUrl: string } }> = ({ detail }) => {
  const [failed, setFailed] = useState(false);
  if (failed || !detail.logoUrl) return <span className={`flex h-11 min-w-11 items-center justify-center rounded-lg px-2 text-[10px] font-black ${detail.cls}`}>{detail.mark}</span>;
  return <img src={detail.logoUrl} alt={detail.mark} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="h-11 w-12 rounded-lg object-contain" />;
};

async function createReceiptSignedUrl(path: string): Promise<string | null> {
  const token = getSupabaseAuthToken();
  if (!config.supabaseUrl || !config.supabaseAnonKey || !token || !path) return null;
  const endpoint = config.supabaseUrl.replace(/\/+$/, '') + '/functions/v1/sign-qr-payment-receipt';
  const request = (bearer: string) => fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: 'Bearer ' + bearer,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path }),
  });
  let response = await request(token);
  if (response.status === 401) {
    const refreshed = await supabaseRefreshToken();
    if (refreshed.session?.access_token) response = await request(refreshed.session.access_token);
  }
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    console.warn('Could not create signed QR payment receipt URL:', response.status, details);
    return null;
  }
  const result = await response.json().catch(() => ({}));
  const signedURL = result.signedURL ?? result.signedUrl;
  if (typeof signedURL !== 'string' || !signedURL) {
    console.warn('Receipt signer response did not contain signedURL.');
    return null;
  }
  if (/^https?:\/\//i.test(signedURL)) return signedURL;
  if (signedURL.startsWith('/storage/v1/')) return config.supabaseUrl.replace(/\/+$/, '') + signedURL;
  return config.supabaseUrl.replace(/\/+$/, '') + '/storage/v1/' + signedURL.replace(/^\/+/, '');
}

export const NotificationsRequestsPage: React.FC = () => {
  const { t, locale, formatCurrency } = useI18n();
  const isAr = locale === 'ar';
  const [items, setItems] = useState<PendingQrPayment[]>([]);
  const backgroundLoadInFlight = useRef(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [approvalAmounts, setApprovalAmounts] = useState<Record<string, string>>({});
  const [approvalBins, setApprovalBins] = useState<Record<string, string>>({});
  const [rejectionReason, setRejectionReason] = useState('');
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<{ itemId: string; action: 'APPROVE' | 'REJECT' } | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadPending = useCallback(async (quiet = false, background = false) => {
    if (background && backgroundLoadInFlight.current) return;
    if (background) backgroundLoadInFlight.current = true;
    if (quiet) setRefreshing(true);
    else if (!background) setLoading(true);
    if (!background) setError('');
    try {
      const { data, error: rpcError } = await invokeSupabaseRpc<Array<Record<string, unknown>>>(
        'list_pending_qr_payment_submissions',
        {},
      );
      if (rpcError) throw new Error(rpcError);
      const rows = Array.isArray(data) ? data : [];
      const parsed = rows.map((row) => ({
        id: String(row.id ?? ''),
        order_id: String(row.order_id ?? ''),
        order_number: row.order_number == null ? null : Number(row.order_number),
        customer_id: String(row.customer_id ?? ''),
        customer_name: String(row.customer_name ?? ''),
        amount_minor: Number(row.amount_minor ?? 0),
        payment_method: String(row.payment_method ?? 'UNKNOWN'),
        receipt_path: String(row.receipt_path ?? ''),
        note: row.note == null ? null : String(row.note),
        status: String(row.status ?? 'PENDING'),
        created_at: String(row.created_at ?? ''),
      })).filter((row) => row.id && row.receipt_path);

      // Receipt storage is ancillary to the notification record. A signing/network failure
      // must not reject the whole Promise.all and hide otherwise reviewable notifications.
      const signed = await Promise.all(parsed.map(async (row) => {
        try {
          return { ...row, receiptSignedUrl: await createReceiptSignedUrl(row.receipt_path) ?? undefined };
        } catch (receiptError) {
          console.warn('Receipt preview unavailable for payment notification:', row.id, receiptError);
          return row;
        }
      }));
      setItems(signed);
    } catch (err: any) {
      if (!background) {
        setError(isAr
          ? 'تعذّر تحميل إشعارات الدفع. تأكد من اتصالك وصلاحيتك ثم أعد المحاولة.'
          : 'Could not load payment notifications. Check your connection and permissions, then retry.');
        console.error('Failed to load QR payment submissions:', err);
      }
    } finally {
      if (background) backgroundLoadInFlight.current = false;
      if (!background) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [isAr]);

  useEffect(() => { void loadPending(); }, [loadPending]);

  useEffect(() => {
    let disposed = false;
    let pushListener: { remove: () => Promise<void> } | null = null;
    let pushListenerDisposed = false;
    const refreshVisible = () => {
      if (disposed || document.visibilityState !== 'visible' || navigator.onLine === false) return;
      void loadPending(false, true);
    };
    const timer = window.setInterval(refreshVisible, 2500);
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('online', refreshVisible);
    if (Capacitor.isNativePlatform()) {
      void PushNotifications.addListener('pushNotificationReceived', refreshVisible).then((handle) => {
        if (pushListenerDisposed) void handle.remove();
        else pushListener = handle;
      }).catch((error) => console.warn('Payment notification list refresh listener unavailable.', error));
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
  }, [loadPending]);

  const review = async (item: PendingQrPayment, action: 'APPROVE' | 'REJECT', confirmed = false) => {
    if (processingId) return;
    const approvedAmountMinor = action === 'APPROVE' ? parseApprovalAmountMinor(approvalAmounts[item.id] ?? '') : null;
    if (action === 'APPROVE' && approvedAmountMinor === null) {
      setError(isAr ? 'أدخل المبلغ الفعلي الذي تحققت منه في صورة الإيصال.' : 'Enter the actual amount verified from the receipt image.');
      return;
    }
    const approvalBin = approvalBins[item.id]?.trim() ?? '';
    if (action === 'APPROVE' && !approvalBin) {
      setError(isAr ? 'أدخل رمز التحقق الإداري (PIN/BIN) لهذا الإشعار قبل الاعتماد.' : 'Enter the admin PIN/BIN for this notification before approval.');
      return;
    }
    // Embedded mobile/web previews may suppress native dialogs, making review buttons appear inert.
    // Use an explicit in-app confirmation before sending the financial mutation.
    if (!confirmed) {
      setPendingConfirmation({ itemId: item.id, action });
      return;
    }
    setPendingConfirmation(null);

    setProcessingId(item.id);
    setError('');
    setMessage('');
    try {
      const { data, error: rpcError } = await invokeSupabaseRpc<Record<string, unknown>>(
        'review_qr_payment_submission',
        {
          p_submission_id: item.id,
          p_action: action,
          p_bin: action === 'APPROVE' ? approvalBin : null,
          p_rejection_reason: action === 'REJECT' ? (rejectionReason.trim() || null) : null,
          p_approved_amount_minor: action === 'APPROVE' ? approvedAmountMinor : null,
        },
      );
      if (rpcError) throw new Error(rpcError);
      if (!data || data.success !== true) throw new Error('REVIEW_FAILED');
      setItems((current) => current.filter((row) => row.id !== item.id));
      setMessage(action === 'APPROVE'
        ? (isAr ? 'تم اعتماد الدفعة وتسجيلها عبر المسار المالي الحالي.' : 'Payment approved and recorded through the existing financial flow.')
        : (isAr ? 'تم رفض الإشعار دون تسجيل دفعة أو تغيير الرصيد.' : 'Notification rejected without recording a payment or changing the balance.'));
      setRejectionReason('');
      setApprovalAmounts((current) => { const next = { ...current }; delete next[item.id]; return next; });
      setApprovalBins((current) => { const next = { ...current }; delete next[item.id]; return next; });
    } catch (err: any) {
      console.error('Payment notification review failed:', err);
      setError(isAr
        ? 'لم تكتمل المراجعة. لم يتم اعتبار الإشعار معتمداً؛ حدّث القائمة وتأكد من الرمز والصلاحيات.'
        : 'Review did not complete. The notification was not treated as approved; refresh the list and check the BIN and permissions.');
    } finally {
      setProcessingId(null);
    }
  };

  const formatDate = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(isAr ? 'ar-PS' : 'en-GB', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  };

  return (
    <div className="space-y-6 text-gray-900 dark:text-[#e7f2ef]">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-300">{isAr ? 'مركز المراجعة' : 'REVIEW CENTER'}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t('navNotificationsRequests')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-500 dark:text-[#9bb6b0]">{isAr ? 'راجع إشعارات التحويل المرسلة من صفحات QR. الاعتماد فقط هو الذي يسجّل الدفعة ويشغّل التوزيع المالي الحالي.' : 'Review transfer notifications submitted from QR pages. Approval records the payment and invokes the existing allocation flow.'}</p>
        </div>
        <button type="button" onClick={() => void loadPending(true)} disabled={refreshing || loading} className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-xs font-semibold text-gray-700 shadow-sm transition hover:bg-gray-50 disabled:opacity-50 dark:border-[#244746] dark:bg-[#0a2423] dark:text-[#c8d9d4] dark:hover:bg-[#133533]">
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />{isAr ? 'تحديث القائمة' : 'Refresh list'}
        </button>
      </div>

      <CustomerAccountNotificationsPanel />

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-[#1c4140] dark:bg-[#0a2423]">
          <div className="flex items-center justify-between"><span className="text-xs text-gray-500 dark:text-[#9bb6b0]">{isAr ? 'بانتظار المراجعة' : 'Awaiting review'}</span><Clock3 className="h-4 w-4 text-amber-600 dark:text-amber-300" /></div>
          <p className="mt-3 text-2xl font-semibold tabular-nums">{items.length}</p>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-[#1c4140] dark:bg-[#0a2423]">
          <div className="flex items-center justify-between"><span className="text-xs text-gray-500 dark:text-[#9bb6b0]">{isAr ? 'مبالغ تنتظر التحقق' : 'Amounts awaiting verification'}</span><Banknote className="h-4 w-4 text-emerald-700 dark:text-emerald-300" /></div>
          <p className="mt-3 text-2xl font-semibold tabular-nums">{isAr ? 'تُحدَّد عند القبول' : 'Set on approval'}</p>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-[#1c4140] dark:bg-[#0a2423]">
          <div className="flex items-center justify-between"><span className="text-xs text-gray-500 dark:text-[#9bb6b0]">{isAr ? 'ضوابط المراجعة' : 'Review safeguards'}</span><ShieldCheck className="h-4 w-4 text-emerald-700 dark:text-emerald-300" /></div>
          <p className="mt-3 text-sm font-semibold">{isAr ? 'منع التكرار · معاملة ذرّية' : 'Duplicate-safe · Atomic review'}</p>
        </div>
      </div>

      <section className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-[#1c4140] dark:bg-[#0a2423] sm:p-5">
        <div className="flex flex-wrap items-end gap-4">
          <label className="block min-w-[220px] flex-1 text-xs font-semibold text-gray-700 dark:text-[#c8d9d4]">
            {isAr ? 'سبب الرفض (اختياري)' : 'Rejection reason (optional)'}
            <input value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value.slice(0, 500))} maxLength={500} placeholder={isAr ? 'سبب مختصر يظهر في سجل الإشعار' : 'Brief reason for the record'} className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-3 text-sm outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/10 dark:border-[#315653] dark:bg-[#0b2928] dark:text-white" />
          </label>
        </div>
        <p className="mt-3 flex items-start gap-2 text-[11px] leading-5 text-gray-500 dark:text-[#9bb6b0]"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />{isAr ? 'الاعتماد ينفّذ إنشاء الدفعة وتوزيع FIFO وتحديث الإشعار داخل معاملة واحدة. الرفض لا ينشئ دفعة ولا يغيّر رصيد العميل.' : 'Approval creates the payment, applies FIFO allocation and updates the notification in one transaction. Rejection creates no payment and changes no customer balance.'}</p>
      </section>

      {error && <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
      {message && <div role="status" className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{message}</div>}

      {loading ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-12 text-center text-sm text-gray-500 dark:border-[#1c4140] dark:bg-[#0a2423] dark:text-[#9bb6b0]">{isAr ? 'جاري تحميل الإشعارات…' : 'Loading notifications…'}</div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-gray-200 bg-white px-6 py-14 text-center dark:border-[#1c4140] dark:bg-[#0a2423]">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-100 text-gray-500 dark:bg-[#102f2d] dark:text-[#a4c0b9]"><CheckCircle2 className="h-6 w-6" /></span>
          <h2 className="mt-4 text-base font-semibold">{isAr ? 'ما في إشعارات دفع معلّقة' : 'No pending payment notifications'}</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-[#9bb6b0]">{isAr ? 'الإشعارات الجديدة رح تظهر هون للمراجعة.' : 'New payment notifications will appear here for review.'}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {items.map((item) => {
            const detail = methodDetails[item.payment_method] || { ar: 'طريقة غير معروفة', en: 'Unknown method', mark: 'PAY', cls: 'bg-gray-100 text-gray-700', logoUrl: '' };
            const displayApprovalAmountMinor = parseApprovalAmountMinor(approvalAmounts[item.id] ?? '');
            return (
              <article key={item.id} className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-[0_8px_30px_rgba(16,55,51,0.03)] dark:border-[#1c4140] dark:bg-[#0a2423]">
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-100 p-4 dark:border-[#244746] sm:p-5">
                  <div className="flex min-w-0 items-start gap-3">
                    <ReviewMethodLogo detail={detail} />
                    <div className="min-w-0">
                      <h2 className="text-base font-semibold">{item.customer_name || (isAr ? 'عميل' : 'Customer')}</h2>
                      <p className="mt-1 text-xs text-gray-500 dark:text-[#9bb6b0]">{item.order_number != null ? (isAr ? `طلب رقم ${item.order_number}` : `Order #${item.order_number}`) : (isAr ? 'دفعة مباشرة على حساب الزبون' : 'Direct customer-account payment')} <span className="mx-1.5">·</span>{isAr ? detail.ar : detail.en}</p>
                      <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-[#9bb6b0]"><Clock3 className="h-3.5 w-3.5" />{formatDate(item.created_at)}</p>
                    </div>
                  </div>
                  <div className="text-start sm:text-end">
                    <p className="text-[11px] text-gray-500 dark:text-[#9bb6b0]">{isAr ? 'حالة الإشعار' : 'Notification status'}</p>
                    <span className="mt-2 inline-flex rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{isAr ? 'بانتظار المراجعة وتحديد المبلغ' : 'Pending review and amount'}</span>
                  </div>
                </div>

                <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_220px] sm:p-5">
                  <div className="min-w-0 space-y-3">
                    {item.note && <div className="rounded-xl bg-gray-50 p-3 text-sm leading-6 text-gray-700 dark:bg-[#0b2928] dark:text-[#c8d9d4]"><p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-500 dark:text-[#9bb6b0]">{isAr ? 'ملاحظة العميل' : 'Customer note'}</p>{item.note}</div>}
                    <label className="mb-3 block max-w-sm text-xs font-semibold text-gray-700 dark:text-[#c8d9d4]">
                      {isAr ? 'المبلغ الفعلي حسب الإيصال (تحدده عند القبول)' : 'Verified amount from receipt (set on approval)'}
                      <input type="number" inputMode="decimal" min="0.01" max="999999999.99" step="0.01" value={approvalAmounts[item.id] ?? ''} onChange={(e) => { setApprovalAmounts((current) => ({ ...current, [item.id]: e.target.value })); setError(''); }} placeholder={isAr ? 'أدخل المبلغ الذي ظهر في الإيصال' : 'Enter the amount shown on the receipt'} className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-3 text-sm font-semibold tabular-nums outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/10 dark:border-[#315653] dark:bg-[#0b2928] dark:text-white" />
                    </label>
                    <label className="mb-3 block max-w-sm text-xs font-semibold text-gray-700 dark:text-[#c8d9d4]">
                      {isAr ? 'رمز PIN/BIN لتأكيد الاعتماد' : 'PIN/BIN to confirm approval'}
                      <input type="password" autoComplete="off" inputMode="numeric" maxLength={32} value={approvalBins[item.id] ?? ''} onChange={(e) => { setApprovalBins((current) => ({ ...current, [item.id]: e.target.value })); setError(''); }} placeholder={isAr ? 'أدخل الرمز لهذا الإشعار' : 'Enter the code for this notification'} className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-3 text-sm outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/10 dark:border-[#315653] dark:bg-[#0b2928] dark:text-white" />
                    </label>
                    {pendingConfirmation?.itemId === item.id && (
                      <div role="alertdialog" aria-live="polite" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                        <p className="font-semibold">
                          {pendingConfirmation.action === 'APPROVE'
                            ? (isAr ? 'تأكيد اعتماد الدفعة بمبلغ ' + formatCurrency(displayApprovalAmountMinor ?? 0) + '؟' : 'Confirm approval for ' + formatCurrency(displayApprovalAmountMinor ?? 0) + '?')
                            : (isAr ? 'تأكيد رفض إشعار الدفع للزبون ' + item.customer_name + '؟' : 'Confirm rejecting ' + item.customer_name + "'s payment notification?")}
                        </p>
                        <p className="mt-1 text-xs opacity-80">
                          {pendingConfirmation.action === 'APPROVE'
                            ? (isAr ? 'سيُسجَّل المبلغ بعد التحقق من الرمز والصلاحيات.' : 'The payment will be recorded after the BIN and permissions are validated.')
                            : (isAr ? 'لن تُسجَّل دفعة ولن يتغيّر رصيد الزبون.' : 'No payment will be recorded and the customer balance will not change.')}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button type="button" onClick={() => setPendingConfirmation(null)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700 dark:border-[#315653] dark:bg-[#0b2928] dark:text-white">{isAr ? 'إلغاء' : 'Cancel'}</button>
                          <button type="button" disabled={processingId === item.id} onClick={() => void review(item, pendingConfirmation.action, true)} className="rounded-lg bg-[#0f766e] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{isAr ? 'تأكيد التنفيذ' : 'Confirm action'}</button>
                        </div>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button type="button" disabled={processingId === item.id} onClick={() => void review(item, 'APPROVE')} className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#0f766e] px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-[#115e59] disabled:opacity-50"><CheckCircle2 className="h-4 w-4" />{processingId === item.id ? (isAr ? 'جاري المعالجة…' : 'Processing…') : (isAr ? 'اعتماد الدفعة' : 'Approve payment')}</button>
                      <button type="button" disabled={processingId === item.id} onClick={() => void review(item, 'REJECT')} className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-200 bg-white px-4 py-2.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900 dark:bg-[#0a2423] dark:text-rose-200 dark:hover:bg-rose-950/30"><XCircle className="h-4 w-4" />{isAr ? 'رفض الإشعار' : 'Reject notification'}</button>
                    </div>
                  </div>
                  <div className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50 dark:border-[#244746] dark:bg-[#0b2928]">
                    {item.receiptSignedUrl ? (
                      <a href={item.receiptSignedUrl} target="_blank" rel="noreferrer" className="group block">
                        <img src={item.receiptSignedUrl} alt={isAr ? 'إيصال التحويل' : 'Transfer receipt'} loading="lazy" className="h-44 w-full object-contain transition group-hover:opacity-90" />
                        <span className="flex items-center justify-center gap-1.5 border-t border-gray-200 bg-white px-3 py-2.5 text-[11px] font-semibold text-gray-600 dark:border-[#244746] dark:bg-[#0a2423] dark:text-[#c8d9d4]"><FileImage className="h-3.5 w-3.5" />{isAr ? 'فتح الصورة بالحجم الكامل' : 'Open full-size receipt'}<ArrowUpRight className="h-3 w-3" /></span>
                      </a>
                    ) : (
                      <div className="flex h-44 flex-col items-center justify-center gap-2 px-4 text-center text-xs text-gray-500 dark:text-[#9bb6b0]"><FileImage className="h-6 w-6" />{isAr ? 'تعذّر تحميل صورة الإيصال. حدّث القائمة.' : 'Receipt preview unavailable. Refresh the list.'}</div>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};
