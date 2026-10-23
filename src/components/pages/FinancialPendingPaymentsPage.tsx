import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Clock3, Plus, RefreshCw, Search, ShieldCheck, XCircle } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { invokeSupabaseRpc } from '../../services/supabase/client';
import { searchFinancialCustomers, UIFinancialCustomerItem } from './dayOrdersStore';

type ManualPayment = {
  id: string;
  customer_id: string;
  customer_name: string;
  customer_code: string;
  amount_minor: number;
  note: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | string;
  rejection_reason: string | null;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
};

const parseAmountMinor = (value: string): number | null => {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  const minor = Math.round(amount * 100);
  return Number.isSafeInteger(minor) && minor > 0 && minor <= 99_999_999_999 ? minor : null;
};

export const FinancialPendingPaymentsPage: React.FC<{ onBack?: () => void }> = ({ onBack }) => {
  const { locale, formatCurrency, formatDateTime } = useI18n();
  const isAr = locale === 'ar';
  const [rows, setRows] = useState<ManualPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<UIFinancialCustomerItem[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<UIFinancialCustomerItem | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [bins, setBins] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [processingId, setProcessingId] = useState<string | null>(null);

  const loadRows = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      const { data, error: rpcError } = await invokeSupabaseRpc<Array<Record<string, unknown>>>(
        'list_admin_manual_customer_payments', {},
      );
      if (rpcError) throw new Error(rpcError);
      setRows((Array.isArray(data) ? data : []).map((row) => ({
        id: String(row.id ?? ''),
        customer_id: String(row.customer_id ?? ''),
        customer_name: String(row.customer_name ?? ''),
        customer_code: String(row.customer_code ?? ''),
        amount_minor: Number(row.amount_minor ?? 0),
        note: row.note == null ? null : String(row.note),
        status: String(row.status ?? 'PENDING'),
        rejection_reason: row.rejection_reason == null ? null : String(row.rejection_reason),
        created_at: String(row.created_at ?? ''),
        reviewed_at: row.reviewed_at == null ? null : String(row.reviewed_at),
        reviewed_by_name: row.reviewed_by_name == null ? null : String(row.reviewed_by_name),
      })).filter((row) => row.id));
    } catch (e) {
      console.error('Could not load manually recorded customer payments', e);
      setError(isAr ? 'تعذّر تحميل الدفعات. تحقق من الاتصال وصلاحيات المالية ثم أعد المحاولة.' : 'Could not load payments. Check your connection and finance permissions, then retry.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isAr]);

  useEffect(() => { void loadRows(); }, [loadRows]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || selectedCustomer) { setMatches([]); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchFinancialCustomers(trimmed).then((found) => {
        if (!cancelled) setMatches(found.slice(0, 8));
      }).catch(() => { if (!cancelled) setMatches([]); });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, selectedCustomer]);

  const createPending = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(''); setMessage('');
    if (!selectedCustomer) {
      setError(isAr ? 'اختر الزبون أولًا.' : 'Select a customer first.');
      return;
    }
    const amountMinor = parseAmountMinor(amount);
    if (!amountMinor) {
      setError(isAr ? 'أدخل مبلغًا صحيحًا أكبر من صفر.' : 'Enter a valid amount greater than zero.');
      return;
    }
    setBusy(true);
    try {
      const { data, error: rpcError } = await invokeSupabaseRpc<Record<string, unknown>>(
        'create_admin_pending_customer_payment',
        { p_customer_id: selectedCustomer.id, p_amount_minor: amountMinor, p_note: note.trim() || null },
      );
      if (rpcError) throw new Error(rpcError);
      if (!data || data.success !== true) throw new Error('PAYMENT_CREATE_FAILED');
      setMessage(isAr ? 'تم تسجيل الدفعة كدفعة معلّقة. لم يتغير رصيد الزبون.' : 'Payment recorded as pending. The customer balance has not changed.');
      setSelectedCustomer(null); setQuery(''); setAmount(''); setNote('');
      await loadRows(true);
    } catch (e) {
      console.error('Could not create pending customer payment', e);
      setError(isAr ? 'لم يتم تسجيل الدفعة. تأكد من صلاحياتك واتصال الإنترنت.' : 'Payment was not recorded. Check your permissions and connection.');
    } finally { setBusy(false); }
  };

  const review = async (row: ManualPayment, action: 'APPROVE' | 'REJECT') => {
    if (processingId) return;
    setError(''); setMessage('');
    const bin = (bins[row.id] || '').trim();
    const rejectionReason = (reasons[row.id] || '').trim();
    if (action === 'APPROVE' && !bin) {
      setError(isAr ? 'أدخل BIN لاعتماد الدفعة.' : 'Enter your BIN to approve this payment.');
      return;
    }
    if (action === 'APPROVE' && !window.confirm(isAr ? 'تأكيد اعتماد الدفعة وإضافتها للحساب؟' : 'Approve this payment and apply it to the account?')) return;
    if (action === 'REJECT' && !window.confirm(isAr ? 'تأكيد رفض الدفعة؟' : 'Reject this payment?')) return;
    setProcessingId(row.id);
    try {
      const { data, error: rpcError } = await invokeSupabaseRpc<Record<string, unknown>>(
        'review_qr_payment_submission',
        {
          p_submission_id: row.id,
          p_action: action,
          p_bin: action === 'APPROVE' ? bin : null,
          p_rejection_reason: action === 'REJECT' ? (rejectionReason || null) : null,
          p_approved_amount_minor: action === 'APPROVE' ? row.amount_minor : null,
        },
      );
      if (rpcError) throw new Error(rpcError);
      if (!data || data.success !== true) throw new Error('PAYMENT_REVIEW_FAILED');
      setBins((prev) => ({ ...prev, [row.id]: '' }));
      setMessage(action === 'APPROVE'
        ? (isAr ? 'تم اعتماد الدفعة وتحديث الحساب.' : 'Payment approved and account updated.')
        : (isAr ? 'تم رفض الدفعة.' : 'Payment rejected.'));
      await loadRows(true);
    } catch (e) {
      console.error('Could not review pending customer payment', e);
      setError(action === 'APPROVE'
        ? (isAr ? 'تعذّر اعتماد الدفعة. تحقق من BIN وصلاحياتك وحالة الدفعة.' : 'Could not approve the payment. Check the BIN, permissions and payment status.')
        : (isAr ? 'تعذّر رفض الدفعة. حدّث القائمة وحاول مجددًا.' : 'Could not reject the payment. Refresh and try again.'));
    } finally { setProcessingId(null); }
  };

  const pendingCount = rows.filter((row) => row.status === 'PENDING').length;

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 pb-24 pt-2 text-gray-900 dark:text-[#daf1de] sm:px-6">
      <header className="flex items-start gap-3 border-b border-gray-200 pb-4 dark:border-[#14423b]">
        {onBack && <button type="button" onClick={onBack} aria-label={isAr ? 'رجوع' : 'Back'} className="mt-1 p-1 text-gray-500 hover:text-emerald-600"><ArrowLeft size={20} /></button>}
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold tracking-tight">{isAr ? 'دفعات الزبائن' : 'Customer payments'}</h1>
          <p className="mt-1 text-xs text-gray-500 dark:text-[#8eb698]">{isAr ? 'تسجيل الدفعات ومراجعتها قبل احتسابها في الرصيد.' : 'Record and review payments before applying them to balances.'}</p>
        </div>
        <button type="button" onClick={() => void loadRows(true)} disabled={refreshing} className="p-2 text-gray-500 hover:text-emerald-600" aria-label={isAr ? 'تحديث' : 'Refresh'}><RefreshCw size={17} className={refreshing ? 'animate-spin' : ''} /></button>
      </header>

      <section className="space-y-4">
        <h2 className="flex items-center gap-2 text-sm font-bold"><Plus size={17} />{isAr ? 'تسجيل دفعة معلّقة' : 'Record pending payment'}</h2>
        <p className="text-xs leading-6 text-gray-500 dark:text-[#8eb698]">{isAr ? 'تُسجّل الدفعة في سجل الزبون فورًا، لكنها لا تؤثر على الرصيد حتى اعتمادها.' : 'The payment appears in the customer history immediately, but does not affect the balance until approved.'}</p>
        <form onSubmit={createPending} className="space-y-3">
          <div className="relative">
            <label htmlFor="manual-payment-customer" className="mb-1.5 block text-xs font-semibold">{isAr ? 'ابحث عن الزبون' : 'Search customer'}</label>
            <div className="relative">
              <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input id="manual-payment-customer" value={selectedCustomer ? selectedCustomer.name : query} onChange={(e) => { setSelectedCustomer(null); setQuery(e.target.value); }} placeholder={isAr ? 'اسم الزبون أو رقم الحساب' : 'Customer name or account number'} className="w-full border-b border-gray-300 bg-transparent py-3 ps-9 pe-3 text-sm outline-none focus:border-emerald-500 dark:border-[#28584c]" />
            </div>
            {!selectedCustomer && matches.length > 0 && <div className="divide-y divide-gray-100 border-b border-gray-200 dark:divide-[#164238] dark:border-[#164238]">{matches.map((customer) => <button key={customer.id} type="button" onClick={() => { setSelectedCustomer(customer); setQuery(customer.name); setMatches([]); }} className="flex w-full items-center justify-between gap-3 py-3 text-start hover:bg-gray-50 dark:hover:bg-[#0c312b]"><span><span className="block text-sm font-semibold">{customer.name}</span><span className="mt-1 block text-xs text-gray-500">{customer.code}</span></span><span className="text-xs font-semibold">{formatCurrency(customer.currentBalanceMinor)}</span></button>)}</div>}
            {selectedCustomer && <div className="flex items-center justify-between gap-3 border-b border-emerald-500/60 py-2 text-xs"><span>{isAr ? 'الزبون المحدد' : 'Selected customer'}: <strong>{selectedCustomer.name}</strong></span><button type="button" onClick={() => { setSelectedCustomer(null); setQuery(''); }} className="text-emerald-700 underline dark:text-emerald-300">{isAr ? 'تغيير' : 'Change'}</button></div>}
          </div>
          <div>
            <label htmlFor="manual-payment-amount" className="mb-1.5 block text-xs font-semibold">{isAr ? 'المبلغ (شيكل)' : 'Amount (ILS)'}</label>
            <input id="manual-payment-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className="w-full border-b border-gray-300 bg-transparent py-3 text-lg font-semibold outline-none focus:border-emerald-500 dark:border-[#28584c]" />
          </div>
          <div>
            <label htmlFor="manual-payment-note" className="mb-1.5 block text-xs font-semibold">{isAr ? 'ملاحظة (اختياري)' : 'Note (optional)'}</label>
            <input id="manual-payment-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={isAr ? 'مرجع التحويل أو أي تفاصيل تساعدك بالمراجعة' : 'Transfer reference or details for review'} className="w-full border-b border-gray-300 bg-transparent py-3 text-sm outline-none focus:border-emerald-500 dark:border-[#28584c]" />
          </div>
          <button type="submit" disabled={busy} className="inline-flex items-center justify-center gap-2 border-b-2 border-emerald-700 px-1 py-3 text-sm font-bold text-emerald-800 disabled:opacity-50 dark:border-emerald-400 dark:text-emerald-300">{busy ? <RefreshCw size={16} className="animate-spin" /> : <Plus size={16} />}{isAr ? 'حفظ كدفعة معلّقة' : 'Save as pending payment'}</button>
        </form>
      </section>

      {(error || message) && <p role="status" className={`border-y py-3 text-sm ${error ? 'border-rose-300 text-rose-700 dark:text-rose-300' : 'border-emerald-300 text-emerald-800 dark:text-emerald-300'}`}>{error || message}</p>}

      <section className="space-y-2">
        <div className="flex items-center justify-between border-b border-gray-200 pb-3 dark:border-[#14423b]">
          <h2 className="text-sm font-bold">{isAr ? 'سجل الدفعات المسجّلة' : 'Recorded payments'}</h2>
          <span className="text-xs text-amber-700 dark:text-amber-300">{pendingCount} {isAr ? 'بانتظار المراجعة' : 'pending review'}</span>
        </div>
        {loading ? <p className="py-8 text-center text-sm text-gray-500">{isAr ? 'جارٍ تحميل الدفعات…' : 'Loading payments…'}</p>
          : rows.length === 0 ? <p className="py-8 text-center text-sm text-gray-500">{isAr ? 'لا توجد دفعات مسجّلة حتى الآن.' : 'No manually recorded payments yet.'}</p>
          : <div className="divide-y divide-gray-200 dark:divide-[#164238]">{rows.map((row) => <article key={row.id} className="space-y-3 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><p className="text-sm font-bold">{row.customer_name}</p><p className="mt-1 text-xs text-gray-500 dark:text-[#8eb698]">{row.customer_code} · {formatDateTime(row.created_at)}</p>{row.note && <p className="mt-2 text-xs text-gray-600 dark:text-[#b1d4bf]">{row.note}</p>}</div>
              <div className="shrink-0 text-end"><p className="text-base font-bold tabular-nums">{formatCurrency(row.amount_minor)}</p><p className={`mt-1 inline-flex items-center gap-1 text-xs font-semibold ${row.status === 'PENDING' ? 'text-amber-700 dark:text-amber-300' : row.status === 'APPROVED' ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}`}>{row.status === 'PENDING' ? <Clock3 size={13} /> : row.status === 'APPROVED' ? <CheckCircle2 size={13} /> : <XCircle size={13} />}{row.status === 'PENDING' ? (isAr ? 'بانتظار الاعتماد' : 'Pending') : row.status === 'APPROVED' ? (isAr ? 'معتمدة' : 'Approved') : (isAr ? 'مرفوضة' : 'Rejected')}</p></div>
            </div>
            {row.status === 'PENDING' && <div className="space-y-3 border-s-2 border-amber-400 ps-3">
              <label className="block text-xs font-semibold">{isAr ? 'رمز BIN لاعتماد الدفعة' : 'BIN to approve payment'}</label>
              <input type="password" inputMode="numeric" autoComplete="off" value={bins[row.id] || ''} onChange={(e) => setBins((prev) => ({ ...prev, [row.id]: e.target.value }))} className="w-full border-b border-gray-300 bg-transparent py-2 text-sm outline-none focus:border-emerald-500 dark:border-[#28584c]" placeholder={isAr ? 'أدخل BIN' : 'Enter BIN'} />
              <label className="block text-xs font-semibold">{isAr ? 'ملاحظة الرفض (اختياري)' : 'Rejection note (optional)'}</label>
              <input value={reasons[row.id] || ''} onChange={(e) => setReasons((prev) => ({ ...prev, [row.id]: e.target.value }))} maxLength={500} className="w-full border-b border-gray-300 bg-transparent py-2 text-sm outline-none focus:border-rose-500 dark:border-[#28584c]" placeholder={isAr ? 'سبب الرفض إن وجد' : 'Reason for rejection, if any'} />
              <div className="flex flex-wrap items-center gap-4 pt-1">
                <button type="button" disabled={processingId === row.id} onClick={() => void review(row, 'APPROVE')} className="inline-flex items-center gap-1.5 py-2 text-xs font-bold text-emerald-700 disabled:opacity-50 dark:text-emerald-300"><ShieldCheck size={15} />{isAr ? 'اعتماد الدفعة' : 'Approve payment'}</button>
                <button type="button" disabled={processingId === row.id} onClick={() => void review(row, 'REJECT')} className="inline-flex items-center gap-1.5 py-2 text-xs font-bold text-rose-700 disabled:opacity-50 dark:text-rose-300"><XCircle size={15} />{isAr ? 'رفض الدفعة' : 'Reject payment'}</button>
                {processingId === row.id && <RefreshCw size={14} className="animate-spin text-gray-400" />}
              </div>
            </div>}
            {row.status === 'REJECTED' && row.rejection_reason && <p className="border-s-2 border-rose-400 ps-3 text-xs text-rose-700 dark:text-rose-300">{isAr ? 'ملاحظة الرفض: ' : 'Rejection note: '}{row.rejection_reason}</p>}
            {row.status === 'APPROVED' && row.reviewed_at && <p className="text-xs text-gray-500 dark:text-[#8eb698]">{isAr ? 'تم الاعتماد في ' : 'Approved on '}{formatDateTime(row.reviewed_at)}{row.reviewed_by_name ? ' · ' + row.reviewed_by_name : ''}</p>}
          </article>)}</div>}
      </section>
    </main>
  );
};
