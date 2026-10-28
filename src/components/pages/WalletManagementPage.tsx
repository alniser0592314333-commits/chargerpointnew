import React, { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, LockKeyhole, ShieldCheck, Wallet, WifiOff, RefreshCw, History, Search, Plus } from 'lucide-react';
import { callCustomerAccount, customerAuth, setCustomerSession } from '../../services/customer/customerAuth';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';

type Gate = 'checking' | 'signed-out' | 'checking-access' | 'denied' | 'ready' | 'offline';

export const WalletManagementPage: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { locale, setLocale } = useI18n();
  const { resolvedTheme, toggleTheme } = useTheme();
  const isAr = locale === 'ar';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<Gate>('checking');
  const [error, setError] = useState('');
  const [customerLabel, setCustomerLabel] = useState('');
  const t = (ar: string, en: string) => isAr ? ar : en;

  const verifyAccess = async (accessToken: string) => {
    setGate('checking-access');
    const result = await callCustomerAccount<{ customer_name?: string; wallet_management_enabled?: boolean }>(
      'wallet-management-access', {}, accessToken,
    );
    if (result.error === 'NETWORK_UNAVAILABLE') { setGate('offline'); return; }
    if (result.error || result.data?.wallet_management_enabled !== true) { setGate('denied'); return; }
    setCustomerLabel(result.data.customer_name || '');
    setGate('ready');
  };

  useEffect(() => {
    let alive = true;
    void customerAuth.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      if (!data.session?.access_token) { setGate('signed-out'); return; }
      await verifyAccess(data.session.access_token);
    }).catch(() => { if (alive) setGate('signed-out'); });
    return () => { alive = false; };
  }, []);

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await callCustomerAccount<{ session?: { access_token: string; refresh_token: string } }>(
        'login', { token: username.trim(), password },
      );
      if (result.error || !result.data?.session) {
        setError(result.error === 'NETWORK_UNAVAILABLE'
          ? t('الاتصال غير متاح. جرّب لما يرجع الإنترنت.', 'Connection unavailable. Try again when online.')
          : t('اسم المستخدم أو كلمة المرور غير صحيحة.', 'Incorrect username or password.'));
        return;
      }
      const sessionError = await setCustomerSession(result.data.session);
      if (sessionError) { setError(t('تعذّر إنشاء جلسة آمنة. حاول مرة ثانية.', 'Could not establish a secure session. Try again.')); return; }
      setPassword('');
      await verifyAccess(result.data.session.access_token);
    } catch {
      setError(t('صار خطأ غير متوقع. حاول مرة ثانية.', 'An unexpected error occurred. Please try again.'));
    } finally { setBusy(false); }
  };

  return <div className="min-h-screen bg-[#f5f7f8] text-slate-900 dark:bg-[#071a1d] dark:text-slate-100" dir={isAr ? 'rtl' : 'ltr'}>
    <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/90 backdrop-blur-xl dark:border-white/10 dark:bg-[#071a1d]/90">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <button onClick={onBack} className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold hover:bg-slate-100 dark:hover:bg-white/5">
          {isAr ? <ArrowRight size={18} /> : <ArrowLeft size={18} />}{t('رجوع', 'Back')}
        </button>
        <div className="flex items-center gap-2">
          <button onClick={() => setLocale(isAr ? 'en' : 'ar')} className="rounded-xl px-3 py-2 text-xs font-bold hover:bg-slate-100 dark:hover:bg-white/5">{isAr ? 'EN' : 'عربي'}</button>
          <button onClick={toggleTheme} className="rounded-xl px-3 py-2 text-xs font-bold hover:bg-slate-100 dark:hover:bg-white/5">{resolvedTheme === 'dark' ? '☀️' : '🌙'}</button>
        </div>
      </div>
    </header>
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <section className="relative overflow-hidden rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-[#0b2427] sm:p-9">
        <div className="flex items-start gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-teal-700 text-white"><Wallet size={27} /></div>
          <div><p className="mb-2 text-xs font-bold tracking-widest text-teal-700 dark:text-teal-300">{t('خدمات مساعدة', 'ASSISTANCE SERVICES')}</p>
            <h1 className="text-2xl font-extrabold sm:text-3xl">{t('إدارة المحفظة', 'Wallet management')}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-600 dark:text-slate-300">{t('إدارة المحافظ والحركات المالية بمكان واحد.', 'Manage wallets and financial activity in one place.')}</p>
          </div>
        </div>
        {(gate === 'checking' || gate === 'checking-access') && <div className="mt-8 flex items-center gap-3 rounded-2xl bg-slate-50 p-4 text-sm dark:bg-white/5"><RefreshCw className="animate-spin" size={18} />{t('بنتحقق من الجلسة وصلاحية الخدمة…', 'Checking your session and service access…')}</div>}
        {gate === 'signed-out' && <form onSubmit={signIn} className="mt-8 grid gap-4 border-t border-slate-200 pt-7 dark:border-white/10 sm:max-w-md">
          <div className="flex items-center gap-2 text-sm font-bold"><LockKeyhole size={17} className="text-teal-700 dark:text-teal-300" />{t('دخول آمن بحسابك الحالي', 'Secure sign-in with your existing account')}</div>
          <label className="grid gap-2 text-sm font-semibold">{t('اسم المستخدم', 'Username')}<input autoComplete="username" required maxLength={64} value={username} onChange={e => setUsername(e.target.value)} className="rounded-xl border border-slate-300 bg-white px-4 py-3 outline-none focus:border-teal-600 dark:border-white/15 dark:bg-[#071a1d]" /></label>
          <label className="grid gap-2 text-sm font-semibold">{t('كلمة المرور', 'Password')}<input type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={e => setPassword(e.target.value)} className="rounded-xl border border-slate-300 bg-white px-4 py-3 outline-none focus:border-teal-600 dark:border-white/15 dark:bg-[#071a1d]" /></label>
          {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-400/10 dark:text-rose-200">{error}</p>}
          <button disabled={busy} className="rounded-xl bg-teal-700 px-5 py-3.5 text-sm font-bold text-white disabled:opacity-60">{busy ? t('جارٍ التحقق…', 'Checking…') : t('تسجيل الدخول', 'Sign in')}</button>
          <p className="text-xs leading-6 text-slate-500 dark:text-slate-400">{t('الخدمة للمشتركين المصرّح لهم فقط. تسجيل الدخول وحده لا يمنح صلاحية الوصول.', 'For authorized subscribers only. Signing in alone does not grant access.')}</p>
        </form>}
        {gate === 'denied' && <div className="mt-8 rounded-2xl border border-amber-300/60 bg-amber-50 p-5 dark:border-amber-200/15 dark:bg-amber-200/5">
          <div className="flex items-center gap-3 font-bold text-amber-900 dark:text-amber-100"><ShieldCheck size={20} />{t('الخدمة غير مفعّلة لهذا الحساب', 'Service not enabled for this account')}</div>
          <p className="mt-2 text-sm leading-7 text-amber-800 dark:text-amber-100/75">{t('تم منع الوصول لأن صلاحية إدارة المحفظة لم يتم تأكيدها من الخادم.', 'Access is blocked because the server did not confirm wallet-management permission.')}</p>
          <button onClick={() => { void customerAuth.auth.signOut(); setGate('signed-out'); }} className="mt-4 rounded-xl border border-amber-400/50 px-4 py-2 text-sm font-bold">{t('تبديل الحساب', 'Switch account')}</button>
        </div>}
        {gate === 'offline' && <div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-5 dark:border-white/10 dark:bg-white/5">
          <div className="flex items-center gap-3 font-bold"><WifiOff size={20} />{t('غير متصل بالإنترنت', 'Offline')}</div>
          <p className="mt-2 text-sm leading-7 text-slate-600 dark:text-slate-300">{t('تعذّر تأكيد صلاحية الخدمة بأمان. لن نعرض بيانات مالية قبل التحقق من صلاحية الوصول.', 'Access could not be verified securely. Financial data remains hidden until access is confirmed.')}</p>
          <button onClick={() => window.location.reload()} className="mt-4 rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white dark:bg-white dark:text-slate-900">{t('إعادة المحاولة', 'Retry')}</button>
        </div>}
        {gate === 'ready' && <div className="mt-8 border-t border-slate-200 pt-7 dark:border-white/10">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-bold">{t('أهلًا', 'Welcome')}{customerLabel ? '، ' + customerLabel : ''}</p><p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('تم تأكيد صلاحية الخدمة من الخادم.', 'Service access verified by the server.')}</p></div><span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-800 dark:bg-emerald-300/10 dark:text-emerald-200"><ShieldCheck size={15} />{t('وصول مصرّح', 'Authorized')}</span></div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">{[
            { icon: Wallet, title: t('محافظي', 'My wallets'), detail: t('عرض المحافظ والأرصدة', 'View wallets and balances') },
            { icon: History, title: t('الحركات المالية', 'Transactions'), detail: t('متابعة الحركات الواردة والصادرة', 'Track incoming and outgoing activity') },
            { icon: Search, title: t('البحث الموحد', 'Unified search'), detail: t('البحث بالاسم أو رقم المحفظة أو المرجع', 'Search by name, wallet number, or reference') },
            { icon: Plus, title: t('تسجيل حركة', 'Record activity'), detail: t('إضافة حركة مرتبطة بالمحفظة', 'Record activity linked to a wallet') },
          ].map(item => <div key={item.title} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-white/10 dark:bg-white/[0.025]"><item.icon size={20} className="text-teal-700 dark:text-teal-300" /><h2 className="mt-3 text-sm font-bold">{item.title}</h2><p className="mt-1 text-xs leading-6 text-slate-600 dark:text-slate-400">{item.detail}</p></div>)}</div>
          <div className="mt-5 rounded-xl border border-dashed border-slate-300 p-4 text-sm leading-7 text-slate-600 dark:border-white/15 dark:text-slate-300">{t('هذه مرحلة تأسيس واجهة الدخول فقط. لن تظهر أرصدة أو حركات حتى يكتمل ربط قاعدة البيانات والمزامنة واختبار عزل حسابات المشتركين.', 'This is the secure entry-page foundation only. Balances remain hidden until the data and sync layer is implemented and tenant isolation is tested.')}</div>
        </div>}
      </section>
    </main>
    <footer className="mx-auto max-w-5xl px-4 pb-8 text-center text-xs text-slate-500">{t('بياناتك لا تُعرض إلا بعد التحقق من الجلسة وصلاحية الخدمة.', 'Your data is shown only after session and service authorization checks.')}</footer>
  </div>;
};
