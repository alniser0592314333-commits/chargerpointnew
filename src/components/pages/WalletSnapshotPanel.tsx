import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Wallet, History } from 'lucide-react';
import { callCustomerAccount } from '../../services/customer/customerAuth';
import { useI18n } from '../../i18n/i18nContext';

type WalletAccount = {
  id: string; provider: string; wallet_number: string; display_name: string;
  currency: string; is_active: boolean; balance_minor: number;
};
type WalletTransaction = {
  id: string; transaction_type: 'INCOME' | 'EXPENSE' | 'TRANSFER';
  amount_minor: number; currency: string; created_at: string;
  reference?: string | null; note?: string | null;
  source_wallet_name?: string | null; destination_wallet_name?: string | null;
};
type Snapshot = { accounts: WalletAccount[]; transactions: WalletTransaction[] };

export const WalletSnapshotPanel: React.FC = () => {
  const { locale } = useI18n();
  const isAr = locale === 'ar';
  const t = (ar: string, en: string) => isAr ? ar : en;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await callCustomerAccount<{ snapshot?: Snapshot }>('wallet-snapshot', { limit: 50 });
      if (result.error || !result.data?.snapshot) {
        setError(result.error === 'NETWORK_UNAVAILABLE'
          ? t('الاتصال غير متاح؛ بيانات المحفظة مخفية.', 'Connection unavailable; wallet data is hidden.')
          : t('تعذّر تحميل بيانات المحفظة. تأكد أن الخدمة مفعّلة وأن قاعدة البيانات جاهزة.', 'Could not load wallet data. Confirm the service is enabled and the database is ready.'));
        setSnapshot(null);
        return;
      }
      setSnapshot(result.data.snapshot);
    } catch {
      setSnapshot(null);
      setError(t('تعذّر تحميل بيانات المحفظة.', 'Could not load wallet data.'));
    } finally {
      setLoading(false);
    }
  }, [isAr]);
  useEffect(() => { void refresh(); }, [refresh]);
  const money = (minor: number, currency: string) =>
    (Number(minor || 0) / 100).toLocaleString(isAr ? 'ar-PS' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + currency;

  return <div className="mt-6 border-t border-slate-200 pt-6 dark:border-white/10">
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2"><Wallet size={19} className="text-teal-700 dark:text-teal-300" /><h2 className="text-lg font-extrabold">{t('محافظي وأرصدتي', 'My wallets and balances')}</h2></div>
      <button type="button" disabled={loading} onClick={() => { void refresh(); }} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold disabled:opacity-50 dark:border-white/15">
        <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />{t('تحديث', 'Refresh')}
      </button>
    </div>
    {loading && <p className="mt-4 text-sm text-slate-500">{t('جارٍ تحميل البيانات…', 'Loading data…')}</p>}
    {error && <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-4 text-sm leading-6 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200">{error}</p>}
    {!loading && !error && snapshot && snapshot.accounts.length === 0 && <p className="mt-4 rounded-xl bg-slate-50 p-4 text-sm leading-6 text-slate-600 dark:bg-white/5 dark:text-slate-300">{t('ما في محافظ مسجلة لهذا الحساب لحد الآن.', 'No wallets are registered for this account yet.')}</p>}
    {snapshot && <div className="mt-4 grid gap-3 sm:grid-cols-2">
      {snapshot.accounts.map(account => <article key={account.id} className="rounded-2xl border border-slate-200 p-4 dark:border-white/10">
        <div className="flex items-start justify-between gap-2"><div><p className="text-xs font-bold text-teal-700 dark:text-teal-300">{account.provider}</p><h3 className="mt-1 font-bold">{account.display_name}</h3><p className="mt-1 text-xs text-slate-500">{account.wallet_number}</p></div><span className="text-xs text-slate-500">{account.currency}</span></div>
        <p className="mt-4 text-2xl font-extrabold tabular-nums">{money(account.balance_minor, account.currency)}</p>
        {!account.is_active && <p className="mt-2 text-xs text-amber-700">{t('غير نشطة', 'Inactive')}</p>}
      </article>)}
    </div>}
    <div className="mt-7 flex items-center gap-2"><History size={18} className="text-teal-700 dark:text-teal-300" /><h2 className="text-lg font-extrabold">{t('آخر الحركات', 'Recent transactions')}</h2></div>
    {!loading && !error && snapshot?.transactions.length === 0 && <p className="mt-3 text-sm text-slate-500">{t('لسه ما في حركات مسجلة.', 'No transactions recorded yet.')}</p>}
    {snapshot && <div className="mt-3 grid gap-2">
      {snapshot.transactions.map(tx => <article key={tx.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-white/10">
        <div><p className="text-sm font-bold">{tx.transaction_type === 'INCOME' ? t('وارد', 'Income') : tx.transaction_type === 'EXPENSE' ? t('صادر', 'Expense') : t('تحويل', 'Transfer')}</p><p className="mt-1 text-xs text-slate-500">{tx.source_wallet_name || tx.destination_wallet_name || tx.reference || '—'} · {new Date(tx.created_at).toLocaleString(isAr ? 'ar-PS' : 'en-US')}</p>{tx.note && <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{tx.note}</p>}</div>
        <p className="font-bold tabular-nums">{money(tx.amount_minor, tx.currency)}</p>
      </article>)}
    </div>}
    <p className="mt-4 text-xs leading-6 text-slate-500 dark:text-slate-400">{t('الأرصدة محسوبة من سجل الحركات على الخادم، وليست محفوظة بشكل منفصل في المتصفح.', 'Balances are derived from the server transaction journal, not stored separately in the browser.')}</p>
  </div>;
};
