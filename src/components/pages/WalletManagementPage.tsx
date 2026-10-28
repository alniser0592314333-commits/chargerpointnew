import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, LockKeyhole, ShieldCheck, Wallet, WifiOff, RefreshCw, History, Search, Plus } from 'lucide-react';
import { callCustomerAccount, customerAuth, setCustomerSession } from '../../services/customer/customerAuth';
import { callWalletService } from '../../services/customer/walletService';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';
import { WalletSnapshotPanel } from './WalletSnapshotPanel';

type Gate = 'checking' | 'signed-out' | 'checking-access' | 'activation-required' | 'denied' | 'step-up-required' | 'ready' | 'offline';
type ActivationRequest = { id?: string; status?: string; requested_at?: string; decided_at?: string; rejection_reason?: string | null } | null;

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
  const [activationRequest, setActivationRequest] = useState<ActivationRequest>(null);
  const t = (ar: string, en: string) => isAr ? ar : en;
  const handleStepUpRequired = useCallback(() => setGate('step-up-required'), []);

  const verifyAccess = async (accessToken: string) => {
    setGate('checking-access');
    const status = await callWalletService<{ wallet_management_enabled?: boolean; request?: ActivationRequest }>(
      'wallet-activation-status', {}, accessToken,
    );
    if (status.error === 'NETWORK_UNAVAILABLE') { setGate('offline'); return; }
    if (status.error === 'STEP_UP_REQUIRED') { setGate('step-up-required'); return; }
    if (status.error || !status.data) { setGate('denied'); return; }
    setActivationRequest(status.data.request ?? null);
    if (status.data.wallet_management_enabled !== true) { setGate('activation-required'); return; }
    const result = await callWalletService<{ customer_name?: string; wallet_management_enabled?: boolean }>(
      'wallet-management-access', {}, accessToken,
    );
    if (result.error === 'NETWORK_UNAVAILABLE') { setGate('offline'); return; }
    if (result.error === 'STEP_UP_REQUIRED') { setGate('step-up-required'); return; }
    if (result.error || result.data?.wallet_management_enabled !== true) { setGate('denied'); return; }
    setCustomerLabel(result.data.customer_name || '');
    setGate('ready');
  };

  const requestActivation = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await callWalletService<{ status?: string; request?: ActivationRequest; wallet_management_enabled?: boolean }>('wallet-request-activation');
      if (result.error === 'STEP_UP_REQUIRED') {
        setGate('step-up-required');
        return;
      }
      if (result.error && result.error !== 'REQUEST_SAVED_NOTIFICATION_PENDING') {
        setError(t('تعذّر إرسال الطلب. تأكد من الاتصال وحاول مرة ثانية.', 'Could not submit the request. Check your connection and try again.'));
        return;
      }
      if (result.data?.request) setActivationRequest(result.data.request);
      else setActivationRequest((current) => current ? { ...current, status: result.data?.status ?? current.status } : { status: result.data?.status ?? 'PENDING' });
      if (result.data?.wallet_management_enabled === true) {
        const session = await customerAuth.auth.getSession();
        if (session.data.session?.access_token) await verifyAccess(session.data.session.access_token);
      } else {
        setGate('activation-required');
      }
      if (result.error === 'REQUEST_SAVED_NOTIFICATION_PENDING') {
        setError(t('تم حفظ الطلب، لكن تعذّر تسجيل إشعار الإدارة. الإدارة بحاجة لمراجعة قائمة الطلبات.', 'The request was saved, but the admin notification could not be recorded. An administrator must review the request queue.'));
      }
    } catch {
      setError(t('صار خطأ غير متوقع. حاول مرة ثانية.', 'An unexpected error occurred. Please try again.'));
    } finally { setBusy(false); }
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

  return <div className="min-h-screen bg-[#f3f6f5] text-slate-900 dark:bg-[#071817] dark:text-slate-100" dir={isAr ? 'rtl' : 'ltr'}>
    <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/90 backdrop-blur-xl dark:border-white/10 dark:bg-[#071a1d]/90">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <button onClick={onBack} className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition hover:bg-slate-100 dark:hover:bg-white/5">
          {isAr ? <ArrowRight size={18} /> : <ArrowLeft size={18} />}{t('رجوع', 'Back')}
        </button>
        <div className="flex items-center gap-2">
          <button onClick={() => setLocale(isAr ? 'en' : 'ar')} className="rounded-xl px-3 py-2 text-xs font-bold hover:bg-slate-100 dark:hover:bg-white/5">{isAr ? 'EN' : 'عربي'}</button>
          <button onClick={toggleTheme} className="rounded-xl px-3 py-2 text-xs font-bold hover:bg-slate-100 dark:hover:bg-white/5">{resolvedTheme === 'dark' ? '☀️' : '🌙'}</button>
        </div>
      </div>
    </header>
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <section className="relative overflow-hidden rounded-[1.75rem] border border-slate-200/90 bg-white shadow-[0_20px_70px_-42px_rgba(15,70,61,0.35)] dark:border-white/10 dark:bg-[#0b2420]">
        <div className="relative overflow-hidden bg-gradient-to-br from-[#103f36] via-[#14574a] to-[#1a6b59] px-6 py-7 text-white sm:px-9 sm:py-9">
          <div aria-hidden="true" className="pointer-events-none absolute -left-10 -top-16 h-56 w-56 rounded-full border border-white/10" />
          <div aria-hidden="true" className="pointer-events-none absolute -left-2 -top-8 h-40 w-40 rounded-full border border-white/10" />
          <div className="relative flex flex-wrap items-start justify-between gap-5">
            <div className="flex items-start gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-white/15 bg-white/10 shadow-inner"><Wallet size={27} /></div>
              <div><p className="mb-2 text-[11px] font-bold tracking-[0.18em] text-emerald-100/80">{t('الخدمات المالية · بوابة العملاء', 'FINANCIAL SERVICES · CUSTOMER PORTAL')}</p>
                <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{t('إدارة المحفظة', 'Wallet management')}</h1>
                <p className="mt-2 max-w-2xl text-sm leading-7 text-emerald-50/85">{t('مساحة مالية منظّمة لمتابعة محافظك وأرصدتك وحركاتك المالية بأمان.', 'A secure, organized space to manage your wallets, balances, and financial activity.')}</p>
              </div>
            </div>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-black/10 px-3 py-2 text-xs font-semibold text-emerald-50"><ShieldCheck size={15} />{t('بوابة آمنة', 'Secure portal')}</span>
          </div>
          <div className="relative mt-7 grid grid-cols-2 gap-3 border-t border-white/15 pt-5 sm:grid-cols-3">
            <div><p className="text-xs text-emerald-100/75">{t('الوصول', 'Access')}</p><p className="mt-1 text-sm font-bold">{t('مقيّد بالحساب', 'Account protected')}</p></div>
            <div><p className="text-xs text-emerald-100/75">{t('تحديث البيانات', 'Data refresh')}</p><p className="mt-1 text-sm font-bold">{t('مباشر من الخادم', 'Live from server')}</p></div>
            <div className="col-span-2 sm:col-span-1"><p className="text-xs text-emerald-100/75">{t('سجل الحركات', 'Transaction ledger')}</p><p className="mt-1 text-sm font-bold">{t('مرجع موحّد', 'Unified ledger')}</p></div>
          </div>
        </div>
        <div className="px-5 pb-7 sm:px-9 sm:pb-9">
        {(gate === 'checking' || gate === 'checking-access') && <div className="mt-8 flex items-center gap-3 rounded-2xl bg-slate-50 p-4 text-sm dark:bg-white/5"><RefreshCw className="animate-spin" size={18} />{t('بنتحقق من الجلسة وصلاحية الخدمة…', 'Checking your session and service access…')}</div>}
        {gate === 'signed-out' && <form onSubmit={signIn} className="mt-8 grid gap-4 border-t border-slate-200 pt-7 dark:border-white/10 sm:max-w-md">
          <div className="flex items-center gap-2 text-sm font-bold"><LockKeyhole size={17} className="text-teal-700 dark:text-teal-300" />{t('دخول آمن بحسابك الحالي', 'Secure sign-in with your existing account')}</div>
          <label className="grid gap-2 text-sm font-semibold">{t('اسم المستخدم', 'Username')}<input autoComplete="username" required maxLength={64} value={username} onChange={e => setUsername(e.target.value)} className="rounded-xl border border-slate-300 bg-white px-4 py-3 outline-none focus:border-teal-600 dark:border-white/15 dark:bg-[#071a1d]" /></label>
          <label className="grid gap-2 text-sm font-semibold">{t('كلمة المرور', 'Password')}<input type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={e => setPassword(e.target.value)} className="rounded-xl border border-slate-300 bg-white px-4 py-3 outline-none focus:border-teal-600 dark:border-white/15 dark:bg-[#071a1d]" /></label>
          {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-400/10 dark:text-rose-200">{error}</p>}
          <button disabled={busy} className="rounded-xl bg-teal-700 px-5 py-3.5 text-sm font-bold text-white disabled:opacity-60">{busy ? t('جارٍ التحقق…', 'Checking…') : t('تسجيل الدخول', 'Sign in')}</button>
          <p className="text-xs leading-6 text-slate-500 dark:text-slate-400">{t('الخدمة للمشتركين المصرّح لهم فقط. تسجيل الدخول وحده لا يمنح صلاحية الوصول.', 'For authorized subscribers only. Signing in alone does not grant access.')}</p>
        </form>}
        {gate === 'activation-required' && <div className="mt-8 rounded-2xl border border-amber-300/60 bg-amber-50 p-5 dark:border-amber-200/15 dark:bg-amber-200/5">
          <div className="flex items-center gap-3 font-bold text-amber-900 dark:text-amber-100"><ShieldCheck size={20} />{t('تفعيل المحفظة مطلوب', 'Wallet activation required')}</div>
          {activationRequest?.status === 'PENDING' ? <p className="mt-2 text-sm leading-7 text-amber-800 dark:text-amber-100/75">{t('طلبك قيد مراجعة الإدارة. ما في داعي تبعث طلب ثاني؛ ارجع لهون لاحقًا لتحديث الحالة.', 'Your request is waiting for administrator review. Do not submit another request; revisit this page later to check its status.')}</p>
            : activationRequest?.status === 'REJECTED' ? <div className="mt-2 text-sm leading-7 text-amber-800 dark:text-amber-100/75"><p>{t('تم رفض الطلب السابق.', 'Your previous request was rejected.')}</p>{activationRequest.rejection_reason && <p>{t('السبب: ', 'Reason: ')}{activationRequest.rejection_reason}</p>}<button disabled={busy} onClick={() => void requestActivation()} className="mt-4 rounded-xl bg-teal-700 px-4 py-3 font-bold text-white disabled:opacity-60">{busy ? t('جارٍ الإرسال…', 'Submitting…') : t('إعادة طلب التفعيل', 'Request activation again')}</button></div>
            : <><p className="mt-2 text-sm leading-7 text-amber-800 dark:text-amber-100/75">{t('قبل استخدام المحفظة، لازم تطلب تفعيلها. بعد موافقة الإدارة رح تفتح معك بشكل طبيعي.', 'Before using the wallet, request activation. Once approved, it will open normally.')}</p><button disabled={busy} onClick={() => void requestActivation()} className="mt-4 rounded-xl bg-teal-700 px-4 py-3 font-bold text-white disabled:opacity-60">{busy ? t('جارٍ الإرسال…', 'Submitting…') : t('طلب تفعيل المحفظة', 'Request wallet activation')}</button></>}
          {error && <p role="alert" className="mt-3 text-sm text-rose-700 dark:text-rose-200">{error}</p>}
          <button onClick={() => { void customerAuth.auth.signOut(); setGate('signed-out'); }} className="mt-4 block rounded-xl border border-amber-400/50 px-4 py-2 text-sm font-bold">{t('تبديل الحساب', 'Switch account')}</button>
        </div>}
        {gate === 'step-up-required' && <div className="mt-8 rounded-2xl border border-teal-300/60 bg-teal-50 p-5 dark:border-teal-200/15 dark:bg-teal-200/5">
          <div className="flex items-center gap-3 font-bold text-teal-900 dark:text-teal-100"><LockKeyhole size={20} />{t('يلزم تأكيد الهوية من جديد', 'Identity verification required')}</div>
          <p className="mt-2 text-sm leading-7 text-teal-800 dark:text-teal-100/75">{t('انتهت مدة تأكيد الهوية الآمن. ارجع لخدمات المساعدة وأكّد هويتك بكلمة المرور أو البصمة قبل متابعة استخدام المحفظة.', 'Your recent identity verification has expired. Return to Assistance Services and verify again with your password or biometric before using the wallet.')}</p>
          <button onClick={onBack} className="mt-4 rounded-xl bg-teal-700 px-4 py-2 text-sm font-bold text-white">{t('العودة لتأكيد الهوية', 'Return to identity verification')}</button>
        </div>}
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
        {gate === 'ready' && <div className="px-5 pb-7 sm:px-9 sm:pb-9">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-5 dark:border-white/10"><div><p className="text-lg font-extrabold">{t('أهلًا', 'Welcome')}{customerLabel ? '، ' + customerLabel : ''}</p><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('تم التحقق من حسابك. اختار القسم اللي بدك تفتحه.', 'Your account is verified. Choose a section to open.')}</p></div><span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-800 dark:bg-emerald-300/10 dark:text-emerald-200"><ShieldCheck size={15} />{t('وصول مصرّح', 'Authorized')}</span></div>
          <div className="mt-5">
            <h2 className="text-sm font-extrabold">{t('اختصارات المحفظة', 'Wallet shortcuts')}</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { icon: Wallet, title: t('محافظي وأرصدتي', 'My wallets & balances'), detail: t('عرض المحافظ المسجلة', 'View registered wallets'), target: 'wallet-accounts' },
                { icon: History, title: t('سجل الحركات', 'Transaction history'), detail: t('مراجعة الوارد والصادر', 'Review incoming and outgoing'), target: 'wallet-transactions' },
                { icon: Plus, title: t('إضافة محفظة', 'Add a wallet'), detail: t('ربط محفظة بحسابك', 'Link a wallet to your account'), target: 'wallet-add' },
                { icon: Search, title: t('تسجيل حركة', 'Record a transaction'), detail: t('إدخال حركة مالية جديدة', 'Enter a new financial transaction'), target: 'wallet-record' },
              ].map(item => <button type="button" key={item.target} onClick={() => document.getElementById(item.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })} className="group flex min-h-[112px] items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-start transition duration-200 hover:-translate-y-0.5 hover:border-emerald-700/50 hover:bg-emerald-50/60 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 dark:border-white/10 dark:bg-white/[0.025] dark:hover:bg-emerald-300/5">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-800 transition group-hover:bg-emerald-700 group-hover:text-white dark:bg-emerald-300/10 dark:text-emerald-200"><item.icon size={19} /></span>
                <span><strong className="block text-sm">{item.title}</strong><span className="mt-1 block text-xs leading-5 text-slate-500 dark:text-slate-400">{item.detail}</span></span>
                <span className="ms-auto self-center text-slate-400 transition group-hover:text-emerald-700">{isAr ? <ArrowLeft size={16} /> : <ArrowRight size={16} />}</span>
              </button>)}
            </div>
          </div>
          <WalletSnapshotPanel onStepUpRequired={handleStepUpRequired} />
        </div>}
        </div>
      </section>
    </main>
    <footer className="mx-auto max-w-6xl px-4 pb-8 text-center text-xs text-slate-500">{t('بياناتك لا تُعرض إلا بعد التحقق من الجلسة وصلاحية الخدمة.', 'Your data is shown only after session and service authorization checks.')}</footer>
  </div>;
};
