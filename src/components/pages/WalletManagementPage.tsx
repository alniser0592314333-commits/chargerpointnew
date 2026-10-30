import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, LockKeyhole, ShieldCheck, Wallet, WifiOff, RefreshCw, History, Search, Plus } from 'lucide-react';
import { callCustomerAccount, customerAuth, CUSTOMER_TERMS_VERSION, setCustomerSession } from '../../services/customer/customerAuth';
import { callWalletService } from '../../services/customer/walletService';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';
import { WalletSnapshotPanel } from './WalletSnapshotPanel';

type Gate = 'checking' | 'signed-out' | 'checking-access' | 'activation-required' | 'denied' | 'step-up-required' | 'force-change' | 'terms-update' | 'ready' | 'offline';
type ActivationRequest = { id?: string; status?: string; requested_at?: string; decided_at?: string; rejection_reason?: string | null } | null;

export const WalletManagementPage: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { locale, setLocale } = useI18n();
  const { resolvedTheme, toggleTheme } = useTheme();
  const isAr = locale === 'ar';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
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
      const identifier = username.trim();
      const entry = await callCustomerAccount<{ valid?: boolean; activated?: boolean }>('entry', { token: identifier });
      if (entry.error || !entry.data?.valid) {
        setError(entry.error === 'NETWORK_UNAVAILABLE'
          ? t('الاتصال غير متاح. جرّب لما يرجع الإنترنت.', 'Connection unavailable. Try again when online.')
          : t('اسم المستخدم أو كلمة المرور غير صحيحة.', 'Incorrect username or password.'));
        return;
      }
      if (entry.data.activated !== true) {
        setError(t('هذا الحساب لم يُفعّل بعد. استخدم رمز QR الخاص بالعميل لإكمال إنشاء كلمة المرور بالطريقة المعتمدة.', 'This account is not activated yet. Use the customer QR code to complete the existing password setup.'));
        return;
      }
      const result = await callCustomerAccount<{ session?: { access_token: string; refresh_token: string }; must_change_password?: boolean; terms_version?: string | null }>(
        'login', { token: identifier, password },
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
      if (result.data.must_change_password) { setGate('force-change'); return; }
      if (result.data.terms_version !== CUSTOMER_TERMS_VERSION) { setTermsAccepted(false); setGate('terms-update'); return; }
      await verifyAccess(result.data.session.access_token);
    } catch {
      setError(t('صار خطأ غير متوقع. حاول مرة ثانية.', 'An unexpected error occurred. Please try again.'));
    } finally { setBusy(false); }
  };

  const finishRequiredPasswordChange = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password.length < 8 || password.length > 128 || password !== confirmPassword || new Set(['password','password123','12345678','qwerty123','11111111','123456789','1234567890','qwertyuiop','abc12345','letmein123','iloveyou','admin123','welcome1','monkey123','dragon123']).has(password.trim().toLowerCase()) || /^(.)\1{7,}$/.test(password)) {
      setError(t('كلمة المرور يجب أن تكون 8 أحرف على الأقل، غير شائعة، ومتطابقة في الحقلين.', 'Use a non-common password of 8–128 characters and make sure both fields match.'));
      return;
    }
    setBusy(true); setError('');
    try {
      const { error: updateError } = await customerAuth.auth.updateUser({ password });
      if (updateError) { setError(t('تعذّر تحديث كلمة المرور. حاول مرة ثانية.', 'Could not update your password. Please try again.')); return; }
      const completed = await callCustomerAccount('complete-password-change', { token: username.trim() });
      if (completed.error) { setError(t('تم تحديث كلمة المرور لكن تعذّر إكمال خطوة تأكيد الحساب. أعد المحاولة.', 'Password updated, but account confirmation could not be completed. Please retry.')); return; }
      setPassword(''); setConfirmPassword('');
      const session = await customerAuth.auth.getSession();
      if (session.data.session?.access_token) await verifyAccess(session.data.session.access_token);
    } catch { setError(t('صار خطأ غير متوقع. حاول مرة ثانية.', 'An unexpected error occurred. Please try again.')); }
    finally { setBusy(false); }
  };

  const acceptUpdatedTerms = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!termsAccepted) { setError(t('لازم توافق على الشروط للمتابعة.', 'You must accept the terms to continue.')); return; }
    setBusy(true); setError('');
    try {
      const accepted = await callCustomerAccount('accept-terms', { token: username.trim(), termsAccepted: true, termsVersion: CUSTOMER_TERMS_VERSION });
      if (accepted.error) { setError(t('تعذّر حفظ موافقتك. حاول مرة ثانية.', 'Could not save your acceptance. Please try again.')); return; }
      const session = await customerAuth.auth.getSession();
      if (session.data.session?.access_token) await verifyAccess(session.data.session.access_token);
    } catch { setError(t('صار خطأ غير متوقع. حاول مرة ثانية.', 'An unexpected error occurred. Please try again.')); }
    finally { setBusy(false); }
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
    <main className="mx-auto max-w-6xl px-4 py-4 sm:px-6 sm:py-6">
      <section className="rounded-2xl border border-slate-200/90 bg-white px-4 py-4 shadow-sm dark:border-white/10 dark:bg-[#0b2420] sm:px-5">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-800 dark:bg-emerald-300/10 dark:text-emerald-200"><Wallet size={22} /></span>
          <div>
            <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">{t('إدارة المحفظة', 'Wallet management')}</h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('محافظك وأرصدتك وحركاتك المالية.', 'Your wallets, balances, and transactions.')}</p>
          </div>
        </div>
        <div className="px-0 pb-1 pt-5 sm:px-1">
        {(gate === 'checking' || gate === 'checking-access') && <div className="mt-8 flex items-center gap-3 rounded-2xl bg-slate-50 p-4 text-sm dark:bg-white/5"><RefreshCw className="animate-spin" size={18} />{t('بنتحقق من الجلسة وصلاحية الخدمة…', 'Checking your session and service access…')}</div>}
        {gate === 'force-change' && <form onSubmit={finishRequiredPasswordChange} className="mt-8 grid gap-4 border-t border-slate-200 pt-7 dark:border-white/10 sm:max-w-md">
          <p className="text-sm leading-6">{t('يجب تغيير كلمة المرور قبل متابعة حسابك. اختر كلمة مرور جديدة.', 'You must change your password before continuing. Choose a new password.')}</p>
          <label className="grid gap-2 text-sm font-semibold">{t('كلمة المرور الجديدة', 'New password')}<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} className="rounded-xl border border-slate-300 bg-white px-4 py-3 dark:border-white/15 dark:bg-[#071a1d]" /></label>
          <label className="grid gap-2 text-sm font-semibold">{t('تأكيد كلمة المرور', 'Confirm password')}<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} className="rounded-xl border border-slate-300 bg-white px-4 py-3 dark:border-white/15 dark:bg-[#071a1d]" /></label>
          {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
          <button disabled={busy} className="rounded-xl bg-teal-700 px-5 py-3.5 text-sm font-bold text-white disabled:opacity-60">{busy ? t('جارٍ الحفظ…', 'Saving…') : t('تغيير كلمة المرور والمتابعة', 'Change password and continue')}</button>
        </form>}
        {gate === 'terms-update' && <form onSubmit={acceptUpdatedTerms} className="mt-8 grid gap-4 border-t border-slate-200 pt-7 dark:border-white/10 sm:max-w-md">
          <p className="text-sm leading-6">{t('تم تحديث شروط استخدام حساب العميل. راجعها ووافق عليها للمتابعة إلى المحفظة.', 'Customer account terms have been updated. Review and accept them to continue to your wallet.')}</p>
          <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" checked={termsAccepted} onChange={e => setTermsAccepted(e.target.checked)} className="mt-1 h-4 w-4" /><span>{t('أوافق على الشروط والأحكام المحدّثة.', 'I accept the updated terms and conditions.')}</span></label>
          {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
          <button disabled={busy || !termsAccepted} className="rounded-xl bg-teal-700 px-5 py-3.5 text-sm font-bold text-white disabled:opacity-60">{busy ? t('جارٍ الحفظ…', 'Saving…') : t('الموافقة والمتابعة', 'Accept and continue')}</button>
        </form>}
        {(gate === 'signed-out' || gate === 'step-up-required') && <form onSubmit={signIn} className="mt-8 grid gap-4 border-t border-slate-200 pt-7 dark:border-white/10 sm:max-w-md">
          {gate === 'step-up-required' && <div role="status" className="rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-sm leading-6 text-teal-900 dark:border-teal-200/15 dark:bg-teal-200/5 dark:text-teal-100">{t('انتهت صلاحية تأكيد الهوية. أدخل اسم المستخدم وكلمة المرور هنا للمتابعة إلى المحفظة مباشرة.', 'Your identity verification expired. Enter your username and password here to continue directly to the wallet.')}</div>}
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
        {gate === 'denied' && <div className="mt-8 rounded-2xl border border-amber-300/60 bg-amber-50 p-5 dark:border-amber-200/15 dark:bg-amber-200/5">
          <div className="flex items-center gap-3 font-bold text-amber-900 dark:text-amber-100"><ShieldCheck size={20} />{t('الخدمة غير مفعّلة لهذا الحساب', 'Service not enabled for this account')}</div>
          <p className="mt-2 text-sm leading-7 text-amber-800 dark:text-amber-100/75">{t('تم منع الوصول لأن صلاحية إدارة المحفظة لم يتم تأكيدها من الخادم.', 'Access is blocked because the server did not confirm wallet-management permission.')}</p>
          <button onClick={() => { void customerAuth.auth.signOut(); setGate('signed-out'); }} className="mt-4 rounded-xl border border-amber-400/50 px-4 py-2 text-sm font-bold">{t('تبديل الحساب', 'Switch account')}</button>
        </div>}
        {gate === 'offline' && <div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-5 dark:border-white/10 dark:bg-white/5">
          <div className="flex items-center gap-3 font-bold"><WifiOff size={20} />{t('غير متصل بالإنترنت', 'Offline')}</div>
          <p className="mt-2 text-sm leading-7 text-slate-600 dark:text-slate-300">{t('تعذّر تأكيد صلاحية الخدمة بأمان. لن نعرض بيانات مالية قبل التحقق من صلاحية الوصول.', 'Access could not be verified securely. Financial data remains hidden until access is confirmed.')}</p>
          <button onClick={() => window.location.reload()} className="mt-4 rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white dark:bg-white dark:text-slate-900">{t('إعادة المحاولة', 'Retry')}</button>
          <p className="mt-3 text-xs leading-6 text-slate-500 dark:text-slate-400">{t('إذا سبق فتح المحفظة على هذا الجهاز، ستظهر أدناه النسخة المحلية للقراءة فقط عند توفرها.', 'If the wallet was previously opened on this device, its locally saved snapshot will appear below in read-only mode when available.')}</p>
          <WalletSnapshotPanel onStepUpRequired={handleStepUpRequired} offlineReadOnly />
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
