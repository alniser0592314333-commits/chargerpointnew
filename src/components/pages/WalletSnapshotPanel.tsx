import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Wallet, History } from 'lucide-react';
import { callWalletService } from '../../services/customer/walletService';
import { useI18n } from '../../i18n/i18nContext';
import { blockPendingWalletTransaction, enqueueWalletTransaction, listPendingWalletTransactions, readWalletSnapshot, removePendingWalletTransaction, saveWalletSnapshot, type PendingWalletTransaction } from '../../services/customer/walletLocalCache';

type WalletAccount = { id: string; provider: string; wallet_number: string; display_name: string; currency: string; is_active: boolean; balance_minor: number };
type WalletTransaction = { id: string; transaction_type: 'INCOME' | 'EXPENSE' | 'TRANSFER'; amount_minor: number; currency: string; created_at: string; reference?: string | null; note?: string | null; source_wallet_name?: string | null; destination_wallet_name?: string | null };
type Snapshot = { accounts: WalletAccount[]; transactions: WalletTransaction[] };

function applyPending(snapshot: Snapshot, pending: PendingWalletTransaction[]): Snapshot {
  const accounts = snapshot.accounts.map(account => ({ ...account }));
  const transactions = [...snapshot.transactions];
  for (const item of [...pending].sort((a, b) => a.queuedAt - b.queuedAt)) {
    const source = accounts.find(account => account.id === item.sourceWalletId);
    const destination = accounts.find(account => account.id === item.destinationWalletId);
    if (item.status !== 'blocked') {
      if (item.transactionType !== 'INCOME' && source) source.balance_minor -= item.amountMinor;
      if (item.transactionType !== 'EXPENSE' && destination) destination.balance_minor += item.amountMinor;
    }
    transactions.unshift({
      id: 'pending:' + item.idempotencyKey,
      transaction_type: item.transactionType,
      amount_minor: item.amountMinor,
      currency: item.currency,
      created_at: new Date(item.queuedAt).toISOString(),
      reference: item.reference,
      note: (item.status === 'blocked' ? '[SYNC_BLOCKED: ' + (item.lastError || 'REJECTED') + '] ' : '[PENDING_SYNC] ') + (item.note || ''),
      source_wallet_name: source?.display_name ?? null,
      destination_wallet_name: destination?.display_name ?? null,
    });
  }
  return { accounts, transactions };
}

export const WalletSnapshotPanel: React.FC<{ onStepUpRequired: () => void; offlineReadOnly?: boolean }> = ({ onStepUpRequired, offlineReadOnly = false }) => {
  const { locale } = useI18n();
  const isAr = locale === 'ar';
  const t = (ar: string, en: string) => isAr ? ar : en;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [usingCachedSnapshot, setUsingCachedSnapshot] = useState(false);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [provider, setProvider] = useState('PalPay');
  const [walletNumber, setWalletNumber] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [currency, setCurrency] = useState('ILS');
  const [transactionType, setTransactionType] = useState<'INCOME' | 'EXPENSE' | 'TRANSFER'>('INCOME');
  const [sourceWalletId, setSourceWalletId] = useState('');
  const [destinationWalletId, setDestinationWalletId] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [transactionKey, setTransactionKey] = useState('');
  const [transactionConflict, setTransactionConflict] = useState(false);
  const [conflictReviewed, setConflictReviewed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingQueue, setPendingQueue] = useState<PendingWalletTransaction[]>([]);
  const [transactionSearch, setTransactionSearch] = useState('');
  const [transactionFilter, setTransactionFilter] = useState<'ALL' | 'INCOME' | 'EXPENSE' | 'TRANSFER'>('ALL');
  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try {
      let queued = await listPendingWalletTransactions();
      for (const item of queued) {
        if (item.status === 'blocked') continue;
        const synced = await callWalletService('wallet-record-transaction', {
          transactionType: item.transactionType, sourceWalletId: item.sourceWalletId,
          destinationWalletId: item.destinationWalletId, amountMinor: item.amountMinor,
          currency: item.currency, idempotencyKey: item.idempotencyKey,
          reference: item.reference, note: item.note,
        });
        if (!synced.error) await removePendingWalletTransaction(item);
        else if (synced.error === 'NETWORK_UNAVAILABLE') break;
        else if (synced.error === 'STEP_UP_REQUIRED') { onStepUpRequired(); break; }
        else await blockPendingWalletTransaction(item, synced.error);
      }
      queued = await listPendingWalletTransactions();
      setPendingQueue(queued);
      const result = await callWalletService<{ snapshot?: Snapshot }>('wallet-snapshot', { limit: 50 });
      if (result.error || !result.data?.snapshot) {
        if (result.error === 'STEP_UP_REQUIRED') {
          setSnapshot(null); setUsingCachedSnapshot(false); setCachedAt(null); onStepUpRequired();
        } else if (result.error === 'NETWORK_UNAVAILABLE') {
          const cached = await readWalletSnapshot<Snapshot>();
          if (cached?.snapshot) {
            setSnapshot(applyPending(cached.snapshot, await listPendingWalletTransactions())); setUsingCachedSnapshot(true); setCachedAt(cached.savedAt);
            setError('');
          } else {
            setSnapshot(null); setUsingCachedSnapshot(false); setCachedAt(null);
            setError(t('ما في نسخة محلية محفوظة بعد. اتصل بالإنترنت أول مرة لتحميل البيانات.', 'No local snapshot is saved yet. Connect once to load your data.'));
          }
        } else {
          setSnapshot(null); setUsingCachedSnapshot(false); setCachedAt(null);
          setError(t('تعذّر تحميل بيانات المحفظة. تأكد أن الخدمة مفعّلة وأن قاعدة البيانات جاهزة.', 'Could not load wallet data. Confirm the service is enabled and the database is ready.'));
        }
        return;
      }
      setSnapshot(applyPending(result.data.snapshot, queued)); setUsingCachedSnapshot(false); setCachedAt(Date.now());
      setPendingQueue(queued); await saveWalletSnapshot(result.data.snapshot);
    } catch {
      const cached = await readWalletSnapshot<Snapshot>();
      if (cached?.snapshot) { setSnapshot(applyPending(cached.snapshot, await listPendingWalletTransactions())); setPendingQueue(await listPendingWalletTransactions()); setUsingCachedSnapshot(true); setCachedAt(cached.savedAt); setError(''); }
      else { setSnapshot(null); setError(t('تعذّر تحميل بيانات المحفظة.', 'Could not load wallet data.')); }
    } finally { setLoading(false); }
  }, [isAr, onStepUpRequired]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const handleOnline = () => { void refresh(); };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [refresh]);
  const currencyScale = (currency: string) => currency === 'JOD' ? 1000 : 100;
  const filteredTransactions = (snapshot?.transactions ?? []).filter(tx => {
    const matchesType = transactionFilter === 'ALL' || tx.transaction_type === transactionFilter;
    const query = transactionSearch.trim().toLocaleLowerCase();
    const searchable = [tx.reference, tx.note, tx.source_wallet_name, tx.destination_wallet_name, tx.transaction_type, tx.currency].filter(Boolean).join(' ').toLocaleLowerCase();
    return matchesType && (!query || searchable.includes(query));
  });
  const totalsByCurrency = (snapshot?.accounts ?? []).reduce<Record<string, number>>((totals, account) => {
    totals[account.currency] = (totals[account.currency] ?? 0) + (account.balance_minor || 0);
    return totals;
  }, {});
  const money = (minor: number, currency: string) => (Number(minor || 0) / currencyScale(currency)).toLocaleString(isAr ? 'ar-PS' : 'en-US', { minimumFractionDigits: currency === 'JOD' ? 3 : 2, maximumFractionDigits: currency === 'JOD' ? 3 : 2 }) + ' ' + currency;

  return <div className="mt-6 border-t border-slate-200 pt-6 dark:border-white/10">
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2"><Wallet size={19} className="text-teal-700 dark:text-teal-300" /><h2 className="text-lg font-extrabold">{t('محافظي وأرصدتي', 'My wallets and balances')}</h2></div>
      <button type="button" disabled={loading} onClick={() => { void refresh(); }} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold disabled:opacity-50 dark:border-white/15"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />{t('تحديث', 'Refresh')}</button>
    </div>
    {loading && <p className="mt-4 text-sm text-slate-500">{t('جارٍ تحميل البيانات…', 'Loading data…')}</p>}
    {usingCachedSnapshot && snapshot && <div role="status" className="mt-4 rounded-xl border border-amber-300/70 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900 dark:border-amber-200/20 dark:bg-amber-200/5 dark:text-amber-100"><p className="font-bold">{t('وضع دون اتصال — نسخة محفوظة محليًا', 'Offline mode — locally saved snapshot')}</p><p>{t('الأرصدة والحركات المعروضة من آخر تحديث ناجح، وليست مضمونة أنها الأحدث. تسجيل الحركات وتعديل المحافظ يحتاج اتصالًا بالخادم.', 'Balances include locally queued transactions and may be stale. Queued transactions sync when connection returns; rejected items need review.')}</p>{cachedAt && <p className="mt-1 text-xs opacity-80">{t('آخر تحديث: ', 'Last refresh: ')}{new Date(cachedAt).toLocaleString(isAr ? 'ar-PS' : 'en-US')}</p>}</div>}
    {pendingQueue.length > 0 && <div role="status" className="mt-4 rounded-xl border border-amber-300/70 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900 dark:border-amber-200/20 dark:bg-amber-200/5 dark:text-amber-100"><p className="font-bold">{t('حركات محفوظة على الجهاز: ', 'Transactions saved on this device: ')}{pendingQueue.length}</p><p>{t('سيتم إرسال الحركات المعلّقة عند رجوع الاتصال. الحركات المتوقفة بسبب رفض الخادم لن تُرسل تلقائيًا مرة أخرى.', 'Pending transactions will sync when connection returns. Transactions rejected by the server will not be retried automatically.')}</p></div>}
    {error && <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-4 text-sm leading-6 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200">{error}</p>}
    {!loading && !error && snapshot && snapshot.accounts.length === 0 && <p className="mt-4 rounded-xl bg-slate-50 p-4 text-sm leading-6 text-slate-600 dark:bg-white/5 dark:text-slate-300">{t('ما في محافظ مسجلة لهذا الحساب لحد الآن.', 'No wallets are registered for this account yet.')}</p>}
    {snapshot && <div id="wallet-accounts" className="mt-4 scroll-mt-24 grid gap-3 sm:grid-cols-2">{snapshot.accounts.map(account => <article key={account.id} className="rounded-2xl border border-slate-200 p-4 dark:border-white/10">
      <div className="flex items-start justify-between gap-2"><div><p className="text-xs font-bold text-teal-700 dark:text-teal-300">{account.provider}</p><h3 className="mt-1 font-bold">{account.display_name}</h3><p className="mt-1 text-xs text-slate-500">{account.wallet_number}</p></div><span className="text-xs text-slate-500">{account.currency}</span></div>
      <p className="mt-4 text-2xl font-extrabold tabular-nums">{money(account.balance_minor, account.currency)}</p>{!account.is_active && <p className="mt-2 text-xs text-amber-700">{t('غير نشطة', 'Inactive')}</p>}
    </article>)}</div>}
    <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(totalsByCurrency).map(([currencyCode, total]) => <article key={currencyCode} className="rounded-2xl border border-emerald-200/70 bg-emerald-50/70 p-4 dark:border-emerald-200/10 dark:bg-emerald-300/5"><p className="text-xs font-semibold text-slate-500">{t('إجمالي الرصيد · ', 'Total balance · ')}{currencyCode}</p><p className="mt-2 text-xl font-extrabold tabular-nums">{money(total, currencyCode)}</p></article>)}</section>
    <div id="wallet-transactions" className="mt-7 scroll-mt-24 flex items-center gap-2"><History size={18} className="text-teal-700 dark:text-teal-300" /><h2 className="text-lg font-extrabold">{t('سجل الحركات', 'Transaction history')}</h2></div>
    <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]"><input aria-label={t('البحث في الحركات', 'Search transactions')} value={transactionSearch} onChange={e => setTransactionSearch(e.target.value)} placeholder={t('ابحث بالملاحظة أو المرجع أو اسم المحفظة…', 'Search notes, reference, or wallet…')} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm dark:border-white/15 dark:bg-[#071a1d]" /><select aria-label={t('تصفية نوع الحركة', 'Filter transaction type')} value={transactionFilter} onChange={e => setTransactionFilter(e.target.value as typeof transactionFilter)} className="rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm dark:border-white/15 dark:bg-[#071a1d]"><option value="ALL">{t('كل الحركات', 'All transactions')}</option><option value="INCOME">{t('الوارد', 'Income')}</option><option value="EXPENSE">{t('الصادر', 'Expense')}</option><option value="TRANSFER">{t('التحويلات', 'Transfers')}</option></select></div>
    {!loading && !error && filteredTransactions.length === 0 && <p className="mt-3 text-sm text-slate-500">{snapshot?.transactions.length ? t('ما في حركات مطابقة للبحث.', 'No transactions match your search.') : t('لسه ما في حركات مسجلة.', 'No transactions recorded yet.')}</p>}
    {snapshot && <div className="mt-3 grid gap-2">{filteredTransactions.map(tx => <article key={tx.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-white/10">
      <div><p className="text-sm font-bold">{tx.transaction_type === 'INCOME' ? t('وارد', 'Income') : tx.transaction_type === 'EXPENSE' ? t('صادر', 'Expense') : t('تحويل', 'Transfer')}</p><p className="mt-1 text-xs text-slate-500">{tx.source_wallet_name || tx.destination_wallet_name || tx.reference || '—'} · {new Date(tx.created_at).toLocaleString(isAr ? 'ar-PS' : 'en-US')}</p>{tx.note && <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{tx.note}</p>}</div>
      <p className="font-bold tabular-nums">{money(tx.amount_minor, tx.currency)}</p>
    </article>)}</div>}
    {!offlineReadOnly && !usingCachedSnapshot && <section id="wallet-add" className="mt-8 scroll-mt-24 border-t border-slate-200 pt-6 dark:border-white/10">
      <h2 className="text-lg font-extrabold">{t('إضافة محفظة', 'Add a wallet')}</h2>
      <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={async event => {
        event.preventDefault(); if (saving) return; setSaving(true); setError('');
        try {
          const result = await callWalletService('wallet-create-account', { provider, walletNumber, displayName, currency });
          if (result.error) { if (result.error === 'STEP_UP_REQUIRED') onStepUpRequired(); setError(result.error === 'STEP_UP_REQUIRED' ? t('انتهت مدة تأكيد الهوية. ارجع لخدمات المساعدة وأكّد هويتك من جديد.', 'Identity verification expired. Return to Assistance Services and verify again.') : result.error === 'WALLET_ACCOUNT_EXISTS' ? t('المحفظة مسجلة من قبل.', 'Wallet already registered.') : t('تعذّرت إضافة المحفظة.', 'Could not add wallet.')); return; }
          setWalletNumber(''); setDisplayName(''); await refresh();
        } finally { setSaving(false); }
      }}>
        <label className="grid gap-1 text-sm font-semibold">{t('المزوّد', 'Provider')}<select value={provider} onChange={e => setProvider(e.target.value)} className="rounded-xl border border-slate-300 bg-white px-3 py-3 dark:border-white/15 dark:bg-[#071a1d]"><option>PalPay</option><option>Jawwal Pay</option><option>Bank of Palestine</option></select></label>
        <label className="grid gap-1 text-sm font-semibold">{t('اسم المحفظة', 'Wallet name')}<input required maxLength={120} value={displayName} onChange={e => setDisplayName(e.target.value)} className="rounded-xl border border-slate-300 bg-white px-3 py-3 dark:border-white/15 dark:bg-[#071a1d]" /></label>
        <label className="grid gap-1 text-sm font-semibold">{t('رقم المحفظة', 'Wallet number')}<input required maxLength={64} value={walletNumber} onChange={e => setWalletNumber(e.target.value)} className="rounded-xl border border-slate-300 bg-white px-3 py-3 dark:border-white/15 dark:bg-[#071a1d]" /></label>
        <label className="grid gap-1 text-sm font-semibold">{t('العملة', 'Currency')}<select value={currency} onChange={e => setCurrency(e.target.value)} className="rounded-xl border border-slate-300 bg-white px-3 py-3 dark:border-white/15 dark:bg-[#071a1d]"><option value="ILS">ILS — شيكل</option><option value="USD">USD — دولار</option><option value="JOD">JOD — دينار</option></select></label>
        <button disabled={saving} className="rounded-xl bg-teal-700 px-5 py-3 text-sm font-bold text-white disabled:opacity-50 sm:col-span-2">{saving ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ المحفظة', 'Save wallet')}</button>
      </form>
    </section>}
    <section id="wallet-record" className="mt-8 scroll-mt-24 border-t border-slate-200 pt-6 dark:border-white/10">
      <h2 className="text-lg font-extrabold">{t('تسجيل حركة مالية', 'Record a transaction')}</h2>
      <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={async event => {
        event.preventDefault(); if (saving || transactionConflict) return;
        const enteredAmount = Number(amount);
        if (!Number.isFinite(enteredAmount) || enteredAmount <= 0) { setError(t('أدخل مبلغًا صحيحًا أكبر من صفر.', 'Enter a valid amount greater than zero.')); return; }
        const accounts = snapshot?.accounts || [];
        const source = accounts.find(a => a.id === sourceWalletId && a.is_active);
        const destination = accounts.find(a => a.id === destinationWalletId && a.is_active);
        if (transactionType !== 'INCOME' && !source) { setError(t('اختار محفظة المصدر.', 'Choose a source wallet.')); return; }
        if (transactionType !== 'EXPENSE' && !destination) { setError(t('اختار محفظة الوجهة.', 'Choose a destination wallet.')); return; }
        if (transactionType === 'TRANSFER' && (source?.id === destination?.id || source?.currency !== destination?.currency)) { setError(t('التحويل يتطلب محفظتين مختلفتين بنفس العملة.', 'Transfer requires two different wallets in the same currency.')); return; }
        const selectedCurrency = transactionType === 'EXPENSE' ? source!.currency : destination!.currency;
        if (source && source.currency !== selectedCurrency) { setError(t('عملة المحافظ غير متطابقة.', 'Wallet currencies do not match.')); return; }
        const amountMinor = Math.round(enteredAmount * currencyScale(selectedCurrency));
        if (transactionType !== 'INCOME' && source && source.balance_minor < amountMinor) { setError(t('الرصيد المحلي الظاهر لا يكفي لهذه الحركة.', 'The displayed local balance is insufficient for this transaction.')); return; }
        if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || Math.abs(enteredAmount * currencyScale(selectedCurrency) - amountMinor) > 1e-7) { setError(t('المبلغ يتجاوز الدقة المسموحة للعملة.', 'Amount exceeds the supported precision for this currency.')); return; }
        const idempotencyKey = transactionKey || crypto.randomUUID();
        setTransactionKey(idempotencyKey);
        setSaving(true); setError('');
        try {
          const transactionPayload = {
            transactionType, sourceWalletId: transactionType === 'INCOME' ? null : sourceWalletId,
            destinationWalletId: transactionType === 'EXPENSE' ? null : destinationWalletId,
            amountMinor, currency: selectedCurrency, idempotencyKey,
            reference: reference.trim() || null, note: note.trim() || null,
          };
          const result = await callWalletService('wallet-record-transaction', transactionPayload);
          if (result.error === 'NETWORK_UNAVAILABLE') {
            const saved = await enqueueWalletTransaction({
              transactionType, sourceWalletId: transactionPayload.sourceWalletId,
              destinationWalletId: transactionPayload.destinationWalletId, amountMinor,
              currency: selectedCurrency, idempotencyKey,
              reference: transactionPayload.reference, note: transactionPayload.note,
            });
            if (!saved) {
              setError(t('تعذّر الحفظ المحلي. لا تغلق الصفحة قبل التأكد من الاتصال والمحاولة مجددًا.', 'Could not save locally. Keep this page open until you can reconnect and retry.'));
              return;
            }
            const queued = await listPendingWalletTransactions();
            setPendingQueue(queued);
            const cached = await readWalletSnapshot<Snapshot>();
            const base = cached?.snapshot ?? snapshot;
            if (base) setSnapshot(applyPending(base, queued));
            setUsingCachedSnapshot(true);
            setAmount(''); setReference(''); setNote(''); setTransactionKey(''); setError('');
            return;
          }
          if (result.error) {
            if (result.error === 'STEP_UP_REQUIRED') onStepUpRequired();
            if (result.error === 'IDEMPOTENCY_KEY_REUSED') {
              setTransactionConflict(true);
              setConflictReviewed(false);
            }
            setError(result.error === 'STEP_UP_REQUIRED' ? t('انتهت مدة تأكيد الهوية. ارجع لخدمات المساعدة وأكّد هويتك من جديد.', 'Identity verification expired. Return to Assistance Services and verify again.')
              : result.error === 'INSUFFICIENT_WALLET_BALANCE' ? t('الرصيد غير كافٍ.', 'Insufficient balance.')
              : result.error === 'IDEMPOTENCY_KEY_REUSED' ? t('تعارض في مفتاح الحركة؛ لم يتم تأكيد التسجيل.', 'Transaction key conflict; recording was not confirmed.')
              : result.error === 'WALLET_UNAVAILABLE' ? t('المحفظة غير متاحة أو العملة غير متطابقة.', 'Wallet unavailable or currency mismatch.')
              : t('تعذّر تسجيل الحركة؛ لم يتم عرض نجاح غير مؤكد.', 'Could not record transaction; no unconfirmed success was shown.'));
            return;
          }
          setAmount(''); setReference(''); setNote(''); setTransactionKey(''); setTransactionConflict(false); setConflictReviewed(false); await refresh();
        } finally { setSaving(false); }
      }}>
        <label className="grid gap-1 text-sm font-semibold">{t('نوع الحركة', 'Transaction type')}<select value={transactionType} onChange={e => setTransactionType(e.target.value as 'INCOME' | 'EXPENSE' | 'TRANSFER')} className="rounded-xl border border-slate-300 bg-white px-3 py-3 dark:border-white/15 dark:bg-[#071a1d]"><option value="INCOME">{t('وارد', 'Income')}</option><option value="EXPENSE">{t('صادر', 'Expense')}</option><option value="TRANSFER">{t('تحويل بين محافظي', 'Transfer between my wallets')}</option></select></label>
        {transactionType !== 'INCOME' && <label className="grid gap-1 text-sm font-semibold">{t('من محفظة', 'From wallet')}<select required value={sourceWalletId} onChange={e => setSourceWalletId(e.target.value)} className="rounded-xl border border-slate-300 bg-white px-3 py-3 dark:border-white/15 dark:bg-[#071a1d]"><option value="">{t('اختار محفظة', 'Choose wallet')}</option>{(snapshot?.accounts || []).filter(a => a.is_active).map(a => <option key={a.id} value={a.id}>{a.display_name} — {a.currency}</option>)}</select></label>}
        {transactionType !== 'EXPENSE' && <label className="grid gap-1 text-sm font-semibold">{t('إلى محفظة', 'To wallet')}<select required value={destinationWalletId} onChange={e => setDestinationWalletId(e.target.value)} className="rounded-xl border border-slate-300 bg-white px-3 py-3 dark:border-white/15 dark:bg-[#071a1d]"><option value="">{t('اختار محفظة', 'Choose wallet')}</option>{(snapshot?.accounts || []).filter(a => a.is_active).map(a => <option key={a.id} value={a.id}>{a.display_name} — {a.currency}</option>)}</select></label>}
        <label className="grid gap-1 text-sm font-semibold">{t('المبلغ', 'Amount')}<input required type="number" min={transactionType === 'EXPENSE' ? (snapshot?.accounts.find(a => a.id === sourceWalletId)?.currency === 'JOD' ? '0.001' : '0.01') : (snapshot?.accounts.find(a => a.id === destinationWalletId)?.currency === 'JOD' ? '0.001' : '0.01')} step={transactionType === 'EXPENSE' ? (snapshot?.accounts.find(a => a.id === sourceWalletId)?.currency === 'JOD' ? '0.001' : '0.01') : (snapshot?.accounts.find(a => a.id === destinationWalletId)?.currency === 'JOD' ? '0.001' : '0.01')} value={amount} onChange={e => setAmount(e.target.value)} className="rounded-xl border border-slate-300 bg-white px-3 py-3 dark:border-white/15 dark:bg-[#071a1d]" /></label>
        <label className="grid gap-1 text-sm font-semibold">{t('المرجع (اختياري)', 'Reference (optional)')}<input maxLength={160} value={reference} onChange={e => setReference(e.target.value)} className="rounded-xl border border-slate-300 bg-white px-3 py-3 dark:border-white/15 dark:bg-[#071a1d]" /></label>
        <label className="grid gap-1 text-sm font-semibold sm:col-span-2">{t('ملاحظة (اختياري)', 'Note (optional)')}<textarea maxLength={1000} rows={2} value={note} onChange={e => setNote(e.target.value)} className="rounded-xl border border-slate-300 bg-white px-3 py-3 dark:border-white/15 dark:bg-[#071a1d]" /></label>
        {transactionConflict && <div role="alert" className="grid gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-900 dark:border-amber-200/20 dark:bg-amber-200/5 dark:text-amber-100 sm:col-span-2">
          <p>{t('تم إيقاف التسجيل بسبب تعارض مفتاح الحركة. راجع آخر الحركات قبل بدء محاولة جديدة؛ لا تعاود إرسال نفس النموذج تلقائيًا.', 'Recording is paused because the transaction key conflicted. Review recent activity before starting a new attempt; this form will not be resubmitted automatically.')}</p>
          <button type="button" disabled={loading || saving} onClick={async () => { await refresh(); setConflictReviewed(true); }} className="justify-self-start rounded-lg border border-amber-400/60 px-3 py-2 font-bold disabled:opacity-50">{loading ? t('جارٍ تحديث السجل…', 'Refreshing history…') : t('تحديث سجل الحركات ومراجعته', 'Refresh and review transaction history')}</button>
          {conflictReviewed && <button type="button" onClick={() => { setTransactionKey(crypto.randomUUID()); setTransactionConflict(false); setConflictReviewed(false); setError(''); }} className="justify-self-start rounded-lg bg-amber-900 px-3 py-2 font-bold text-white dark:bg-amber-100 dark:text-amber-950">{t('راجعت السجل — ابدأ محاولة جديدة', 'I reviewed the history — start a new attempt')}</button>}
        </div>}
        <button disabled={saving || transactionConflict || !(snapshot?.accounts || []).some(a => a.is_active)} className="rounded-xl bg-teal-700 px-5 py-3 text-sm font-bold text-white disabled:opacity-50 sm:col-span-2">{saving ? t('جارٍ التسجيل…', 'Recording…') : transactionConflict ? t('التسجيل متوقف للمراجعة', 'Recording paused for review') : t('تأكيد الحركة', 'Record transaction')}</button>
      </form>
      <p className="mt-3 text-xs leading-6 text-slate-500 dark:text-slate-400">{t('لا يُقبل الصادر أو التحويل إذا كان الرصيد غير كافٍ؛ الخادم هو المرجع النهائي.', 'Expenses and transfers are rejected if funds are insufficient; the server is authoritative.')}</p>
    </section>
    <p className="mt-4 text-xs leading-6 text-slate-500 dark:text-slate-400">{t('الأرصدة محسوبة من سجل الحركات على الخادم، وليست محفوظة بشكل منفصل في المتصفح.', 'Balances are derived from the server journal plus clearly marked local pending transactions until sync is confirmed.')}</p>
  </div>;
};
