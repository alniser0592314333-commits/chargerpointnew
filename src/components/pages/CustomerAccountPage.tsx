import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Apple, CheckCircle2, Eye, EyeOff, Facebook, KeyRound, LoaderCircle, LockKeyhole, Mail, ShieldCheck } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';
import { AppLogo } from '../qr/AppLogo';
import { PublicCustomerPortalPage, hasCachedCustomerPortalData, clearCachedCustomerPortalData } from './PublicCustomerPortalPage';
import {
  callCustomerAccount, customerAuth, CUSTOMER_TERMS_VERSION, setCustomerSession, startCustomerOAuth,
} from '../../services/customer/customerAuth';

type EntryStatus = {
  valid: boolean;
  activated: boolean;
  customer_name?: string;
  email_recovery_available?: boolean;
  auth_provider?: "password" | "google" | "apple" | "facebook" | null;
  terms_version?: string | null;
};
const sessionExpiryKey = (token: string) => 'cp_customer_session_binding:' + token;
const sessionIdFromAccessToken = (accessToken: string): string | null => {
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')));
    return typeof claims.session_id === 'string' ? claims.session_id : null;
  } catch { return null; }
};
const saveSessionExpiry = async (token: string, value: unknown) => {
  if (typeof value !== 'string') return;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time) || time <= Date.now()) return;
  const { data } = await customerAuth.auth.getSession();
  const sessionId = data.session ? sessionIdFromAccessToken(data.session.access_token) : null;
  if (!sessionId) return;
  try { localStorage.setItem(sessionExpiryKey(token), JSON.stringify({ expiresAt: time, sessionId })); } catch {}
};

type Mode = 'loading' | 'unavailable' | 'activate' | 'social-activation' | 'login' | 'forgot' | 'portal' | 'force-change' | 'recovery' | 'terms-update';

const commonPassword = (value: string) =>
  value.length >= 8 && value.length <= 128 &&
  !new Set(['password', 'password123', '12345678', 'qwerty123', '11111111', '123456789', '1234567890', 'qwertyuiop', 'abc12345', 'letmein123', 'iloveyou', 'admin123', 'welcome1', 'monkey123', 'dragon123']).has(value.trim().toLowerCase()) &&
  !/^(.)(\\1){7,}$/.test(value);
const passwordStrength = (value: string) => {
  if (!value) return 0;
  let score = 0;
  if (value.length >= 8) score++;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
  if (/\\d/.test(value)) score++;
  if (/[^A-Za-z0-9]/.test(value)) score++;
  return score;
};

export const CustomerAccountPage: React.FC<{ token: string }> = ({ token }) => {
  const { locale, setLocale } = useI18n();
  const { resolvedTheme, toggleTheme } = useTheme();
  const isAr = locale === 'ar';
  const [mode, setMode] = useState<Mode>('loading');
  const [entry, setEntry] = useState<EntryStatus | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const initialized = useRef(false);

  const t = useCallback((ar: string, en: string) => isAr ? ar : en, [isAr]);
  const setErrorMessage = (value: string) => {
    const messages: Record<string, [string, string]> = {
      ACCOUNT_UNAVAILABLE_OR_INVALID: ['الحساب غير متاح حاليًا. تأكد من الرمز أو تواصل مع الإدارة.', 'The account is currently unavailable. Check the QR or contact the administrator.'],
      ACCOUNT_ALREADY_ACTIVATED: ['الحساب مفعّل مسبقًا. سجّل الدخول بكلمة السر.', 'This account is already activated. Sign in with your password.'],
      INVALID_CREDENTIALS: ['كلمة السر غير صحيحة أو الحساب غير متاح.', 'The password is incorrect or the account is unavailable.'],
      NETWORK_UNAVAILABLE: ['تعذّر الاتصال بالخادم. تحقق من الإنترنت وحاول مجددًا.', 'Could not reach the server. Check your connection and try again.'],
      PASSWORD_REQUIREMENTS: ['كلمة السر يجب أن تكون 8 أحرف على الأقل وألا تكون شائعة أو سهلة التخمين.', 'Use at least 8 characters and avoid common or easily guessed passwords.'],
      PASSWORD_MISMATCH: ['كلمتا السر غير متطابقتين.', 'The passwords do not match.'],
      TERMS_REQUIRED: ['يجب الموافقة على الشروط والأحكام للمتابعة.', 'You must accept the terms to continue.'],
      EMAIL_RECOVERY_UNAVAILABLE: ['تعذّر إرسال رابط الاستعادة. استخدم طلب الإدارة.', 'Could not send a recovery link. Use the administrator request instead.'],
      REQUEST_NO_LONGER_PENDING: ['طلب الاستعادة لم يعد متاحًا. حدّث الصفحة.', 'This reset request is no longer available. Refresh the page.'],
    };
    setError(messages[value]?.[isAr ? 0 : 1] ?? t('لم تكتمل العملية. حاول مرة أخرى.', 'The operation could not be completed. Please try again.'));
  };

  const loadEntry = useCallback(async () => {
    if (initialized.current) return;
    initialized.current = true;
    setMode('loading');
    setError('');
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      const { data: localSession } = await customerAuth.auth.getSession();
      let localBinding: { expiresAt?: number; sessionId?: string } | null = null;
      try { localBinding = JSON.parse(localStorage.getItem(sessionExpiryKey(token)) || 'null'); } catch {}
      const currentSessionId = localSession.session ? sessionIdFromAccessToken(localSession.session.access_token) : null;
      if (localSession.session && localBinding?.expiresAt && localBinding.expiresAt > Date.now() &&
          localBinding.sessionId && localBinding.sessionId === currentSessionId && hasCachedCustomerPortalData(token)) {
        setMode('portal');
        setMessage(t('أنت غير متصل. هذه آخر نسخة محفوظة؛ الدفع وتغييرات الحساب متوقفة حتى عودة الإنترنت.', 'You are offline. This is the last saved copy; payments and account changes are disabled until you reconnect.'));
      } else {
        setMode('unavailable');
        setError(t('يلزم الاتصال بالإنترنت لتسجيل الدخول والتحقق من الحساب. لا توجد نسخة محفوظة صالحة لهذا الجهاز.', 'An internet connection is required. No valid saved copy is available on this device.'));
      }
      return;
    }
    const result = await callCustomerAccount<EntryStatus>('entry', { token });
    if (!result.data || result.error || result.data.valid !== true) {
      setMode('unavailable');
      setErrorMessage(result.error || 'ACCOUNT_UNAVAILABLE_OR_INVALID');
      return;
    }
    const status = result.data as EntryStatus;
    setEntry(status);
    const params = new URLSearchParams(window.location.search);
    const recovery = params.get('customer_recovery') === '1';
    const pendingMode = typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem('cp_customer_oauth_mode:' + token)
      : null;
    const oauthMode = pendingMode || params.get('customer_oauth');
    const pendingTerms = typeof sessionStorage !== 'undefined' &&
      sessionStorage.getItem('cp_customer_terms:' + token) === 'accepted';
    setTermsAccepted(pendingTerms);

    const { data: sessionResult } = await customerAuth.auth.getSession();
    const session = sessionResult.session;
    if (session && recovery) {
      setMode('recovery');
      setMessage(t('أدخل كلمة سر جديدة لإكمال الاستعادة.', 'Set a new password to complete recovery.'));
      return;
    }
    if (session && oauthMode === 'activate' && !status.activated) {
      setMode('social-activation');
      return;
    }
    if (session) {
      const sessionAction = oauthMode === 'login' ? 'register-session' : 'verify-session';
      const registered = await callCustomerAccount<{ must_change_password?: boolean; auth_provider?: EntryStatus["auth_provider"]; terms_version?: string | null; session_expires_at?: string }>(
        sessionAction, { token }, session.access_token,
      );
      const registeredData = registered.data;
      if (registeredData && !registered.error) {
        await saveSessionExpiry(token, registeredData.session_expires_at);
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.removeItem('cp_customer_oauth_mode:' + token);
          sessionStorage.removeItem('cp_customer_terms:' + token);
        }
        setEntry((current) => current ? { ...current, auth_provider: registeredData.auth_provider ?? current.auth_provider, terms_version: registeredData.terms_version ?? current.terms_version } : current);
        if (registeredData.must_change_password) setMode('force-change');
        else if (registeredData.terms_version !== CUSTOMER_TERMS_VERSION) { setTermsAccepted(false); setMode('terms-update'); }
        else setMode('portal');
        return;
      }
      await customerAuth.auth.signOut();
      if (oauthMode === 'activate' && !status.activated) {
        setMode('social-activation');
        return;
      }
      setErrorMessage('ACCOUNT_UNAVAILABLE_OR_INVALID');
    }
    setMode(status.activated ? 'login' : 'activate');
  }, [token, t]);

  useEffect(() => {
    void loadEntry();
    const onOnline = () => {
      initialized.current = false;
      void loadEntry();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [loadEntry]);

  useEffect(() => {
    const revalidateWhenVisible = () => {
      if (document.visibilityState !== 'visible' || (mode !== 'portal' && mode !== 'force-change')) return;
      initialized.current = false;
      void loadEntry();
    };
    window.addEventListener('focus', revalidateWhenVisible);
    document.addEventListener('visibilitychange', revalidateWhenVisible);
    return () => {
      window.removeEventListener('focus', revalidateWhenVisible);
      document.removeEventListener('visibilitychange', revalidateWhenVisible);
    };
  }, [loadEntry, mode]);

  const finishPasswordChange = async (recoveryFlow = false) => {
    if (!commonPassword(password)) { setErrorMessage('PASSWORD_REQUIREMENTS'); return; }
    if (password !== confirmPassword) { setErrorMessage('PASSWORD_MISMATCH'); return; }
    setBusy(true); setError('');
    try {
      const { error: updateError } = await customerAuth.auth.updateUser({ password });
      if (updateError) { setError(t('تعذّر تحديث كلمة السر. حاول مرة أخرى.', 'Could not update the password. Please try again.')); return; }
      const completed = await callCustomerAccount<{ session_expires_at?: string; terms_version?: string }>('complete-password-change', { token });
      if (completed.error) { setErrorMessage(completed.error); return; }
      await saveSessionExpiry(token, completed.data?.session_expires_at);
      setPassword(''); setConfirmPassword('');
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem('cp_customer_oauth_mode:' + token);
        sessionStorage.removeItem('cp_customer_terms:' + token);
      }
      setMode('portal');
      setMessage(recoveryFlow
        ? t('تم تغيير كلمة السر بنجاح.', 'Password changed successfully.')
        : t('تم تغيير كلمة السر. يمكنك متابعة حسابك.', 'Password changed. You can continue to your account.'));
    } finally { setBusy(false); }
  };

  const submitActivation = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!termsAccepted) { setErrorMessage('TERMS_REQUIRED'); return; }
    if (!commonPassword(password)) { setErrorMessage('PASSWORD_REQUIREMENTS'); return; }
    if (password !== confirmPassword) { setErrorMessage('PASSWORD_MISMATCH'); return; }
    setBusy(true); setError('');
    try {
      const result = await callCustomerAccount<{ session?: { access_token: string; refresh_token: string }; session_expires_at?: string }>(
        'activate-password', { token, password, confirmPassword, termsAccepted: true, termsVersion: CUSTOMER_TERMS_VERSION },
      );
      if (result.error || !result.data?.session) { setErrorMessage(result.error || 'ACTIVATION_UNAVAILABLE'); return; }
      const sessionError = await setCustomerSession(result.data.session);
      await saveSessionExpiry(token, result.data.session_expires_at);
      if (sessionError) { setError(t('تم إنشاء الحساب لكن تعذّر إكمال الدخول. ارجع وسجّل الدخول بكلمة السر.', 'Account created, but sign-in could not be completed. Return and sign in with your password.')); setMode('login'); return; }
      setPassword(''); setConfirmPassword(''); setMode('portal');
    } finally { setBusy(false); }
  };

  const submitSocialActivation = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!termsAccepted) { setErrorMessage('TERMS_REQUIRED'); return; }
    if (!commonPassword(password)) { setErrorMessage('PASSWORD_REQUIREMENTS'); return; }
    if (password !== confirmPassword) { setErrorMessage('PASSWORD_MISMATCH'); return; }
    setBusy(true); setError('');
    try {
      const { data: sessionData } = await customerAuth.auth.getSession();
      if (!sessionData.session) { setErrorMessage('ACCOUNT_UNAVAILABLE_OR_INVALID'); return; }
      const { error: updateError } = await customerAuth.auth.updateUser({ password });
      if (updateError) { setError(t('تعذّر تعيين كلمة السر. حاول مرة أخرى.', 'Could not set the password. Please try again.')); return; }
      const { data: updatedSession } = await customerAuth.auth.getSession();
      if (!updatedSession.session) { setErrorMessage('ACCOUNT_UNAVAILABLE_OR_INVALID'); return; }
      const result = await callCustomerAccount<{ session_expires_at?: string }>('activate-social', {
        token, termsAccepted: true, termsVersion: CUSTOMER_TERMS_VERSION,
      }, updatedSession.session.access_token);
      if (result.error) { setErrorMessage(result.error); return; }
      await saveSessionExpiry(token, result.data?.session_expires_at);
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem('cp_customer_oauth_mode:' + token);
        sessionStorage.removeItem('cp_customer_terms:' + token);
      }
      setPassword(''); setConfirmPassword(''); setMode('portal');
    } finally { setBusy(false); }
  };

  const submitLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password) { setErrorMessage('INVALID_CREDENTIALS'); return; }
    setBusy(true); setError('');
    try {
      const result = await callCustomerAccount<{ session?: { access_token: string; refresh_token: string }; must_change_password?: boolean; terms_version?: string | null; auth_provider?: EntryStatus["auth_provider"]; session_expires_at?: string }>(
        'login', { token, password },
      );
      const loginData = result.data;
      if (result.error || !loginData?.session) {
        setErrorMessage(result.error === 'NETWORK_UNAVAILABLE' ? result.error : 'INVALID_CREDENTIALS');
        return;
      }
      const sessionError = await setCustomerSession(loginData.session);
      await saveSessionExpiry(token, loginData.session_expires_at);
      if (sessionError) { setErrorMessage(sessionError); return; }
      setPassword('');
      setEntry((current) => current ? { ...current, terms_version: loginData.terms_version ?? current.terms_version, auth_provider: loginData.auth_provider ?? current.auth_provider } : current);
      if (loginData.must_change_password) setMode('force-change');
      else if (loginData.terms_version !== CUSTOMER_TERMS_VERSION) { setTermsAccepted(false); setMode('terms-update'); }
      else setMode('portal');
    } finally { setBusy(false); }
  };

  const submitTermsUpdate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!termsAccepted) { setErrorMessage('TERMS_REQUIRED'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await callCustomerAccount<{ terms_version?: string }>('accept-terms', {
        token, termsAccepted: true, termsVersion: CUSTOMER_TERMS_VERSION,
      });
      if (result.error) { setErrorMessage(result.error); return; }
      setEntry((current) => current ? { ...current, terms_version: result.data?.terms_version ?? CUSTOMER_TERMS_VERSION } : current);
      setMode('portal');
      setMessage(t('تم تحديث موافقتك على الشروط. يمكنك متابعة حسابك.', 'Your updated terms acceptance is saved. You can continue to your account.'));
    } finally { setBusy(false); }
  };

  const submitForgot = async (emailRecovery: boolean) => {
    setBusy(true); setError(''); setMessage('');
    try {
      const action = emailRecovery ? 'email-reset' : 'request-reset';
      const redirectTo = new URL('/c/' + encodeURIComponent(token), window.location.origin);
      redirectTo.searchParams.set('customer_recovery', '1');
      const result = await callCustomerAccount(action, {
        token, redirectTo: redirectTo.toString(),
      });
      if (result.error) { setErrorMessage(result.error); return; }
      setMessage(emailRecovery
        ? t('إذا كان البريد الموثّق متاحًا، سيصلك رابط آمن لإعادة تعيين كلمة السر. افحص الوارد والرسائل غير المرغوب فيها.', 'If a verified email is available, a secure password-reset link will be sent. Check your inbox and spam folder.')
        : t('تم إرسال طلب إعادة التعيين للإدارة. سيظهر في صفحة الإشعارات.', 'Your reset request has been sent to the administrator and will appear in Notifications.'));
      setMode('login');
    } finally { setBusy(false); }
  };

  const beginOAuth = async (provider: 'google' | 'apple' | 'facebook', oauthMode: 'login' | 'activate') => {
    setError(''); setMessage('');
    if (oauthMode === 'activate' && !termsAccepted) { setErrorMessage('TERMS_REQUIRED'); return; }
    if (oauthMode === 'activate' && typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('cp_customer_terms:' + token, 'accepted');
    }
    const error = await startCustomerOAuth(provider, token, oauthMode);
    if (error) setError(t('تعذّر بدء تسجيل الدخول الخارجي. تحقق من إعدادات المزوّد وحاول مجددًا.', 'Could not start social sign-in. Check provider configuration and try again.'));
  };

  const logout = async () => {
    await callCustomerAccount('logout').catch(() => undefined);
    await customerAuth.auth.signOut();
    clearCachedCustomerPortalData(token);
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem('cp_customer_terms:' + token);
      localStorage.removeItem(sessionExpiryKey(token));
    }
    setEntry((current) => current ? { ...current, activated: true } : current);
    setMode('login');
    setMessage(t('تم تسجيل الخروج.', 'You have signed out.'));
  };

  if (mode === 'portal') {
    return (
      <div className="relative">
        <div className="mx-auto flex max-w-3xl justify-end gap-2 px-4 pt-3">
          <button type="button" onClick={() => void logout()} className="rounded-xl border border-slate-200 bg-white/90 px-4 py-2 text-sm font-semibold text-slate-700 dark:border-emerald-900 dark:bg-[#0a2423] dark:text-emerald-100">
            {t('تسجيل الخروج', 'Sign out')}
          </button>
        </div>
        {message && <p role="status" className="mx-auto max-w-3xl px-4 pt-2 text-sm text-emerald-700 dark:text-emerald-200">{message}</p>}
        <PublicCustomerPortalPage token={token} />
      </div>
    );
  }

  const showTerms = mode === 'activate' || mode === 'social-activation';
  const showPasswordForm = mode === 'activate' || mode === 'social-activation' || mode === 'force-change' || mode === 'recovery';
  const title = mode === 'activate' ? t('تفعيل حساب العميل', 'Activate your customer account')
    : mode === 'social-activation' ? t('أنشئ كلمة سر لحسابك', 'Create a password for your account')
    : mode === 'login' ? t('تسجيل دخول العميل', 'Customer sign in')
    : mode === 'forgot' ? t('استعادة كلمة السر', 'Recover your password')
    : mode === 'force-change' ? t('تغيير كلمة السر المؤقتة', 'Change temporary password')
    : mode === 'recovery' ? t('تعيين كلمة سر جديدة', 'Set a new password')
    : mode === 'terms-update' ? t('مراجعة الشروط المحدّثة', 'Review updated terms')
    : mode === 'unavailable' ? t('الحساب غير متاح حاليًا', 'Account unavailable')
    : t('بوابة العميل', 'Customer portal');

  const providers = [
    { id: 'google' as const, label: t('المتابعة بواسطة Google', 'Continue with Google'), icon: <span className="text-lg font-black">G</span> },
    { id: 'apple' as const, label: t('المتابعة بواسطة Apple', 'Continue with Apple'), icon: <Apple className="h-5 w-5" /> },
    { id: 'facebook' as const, label: t('المتابعة بواسطة Facebook', 'Continue with Facebook'), icon: <Facebook className="h-5 w-5" /> },
  ];

  return (
    <main dir={isAr ? 'rtl' : 'ltr'} className="relative isolate flex min-h-screen items-center justify-center overflow-hidden bg-slate-50 px-4 py-8 text-slate-900 dark:bg-[#071b1b] dark:text-slate-100">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-emerald-100/80 via-transparent to-transparent dark:from-emerald-950/50" />
      <section className="relative z-10 w-full max-w-md rounded-3xl border border-slate-200 bg-white/95 p-5 shadow-xl shadow-emerald-950/5 backdrop-blur dark:border-emerald-900/70 dark:bg-[#082622]/95 sm:p-7">
        <header className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3"><AppLogo size={44} variant="auto" /><div><p className="font-bold">{t('نقطة الشحن', 'Charging Point')}</p><p className="text-xs text-slate-500 dark:text-emerald-100/60">{t('حساب العميل', 'Customer account')}</p></div></div>
          <div className="flex gap-1"><button type="button" onClick={toggleTheme} className="rounded-lg p-2" aria-label={t('تغيير المظهر', 'Toggle theme')}>{resolvedTheme === 'dark' ? '☀' : '☾'}</button><button type="button" onClick={() => setLocale(isAr ? 'en' : 'ar')} className="rounded-lg px-2 py-1 text-xs font-bold">{isAr ? 'EN' : 'عربي'}</button></div>
        </header>
        <div className="mb-5 flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"><LockKeyhole className="h-5 w-5" /></span><div><h1 className="text-xl font-extrabold">{title}</h1><p className="mt-1 text-sm leading-6 text-slate-500 dark:text-emerald-100/65">{mode === 'login'
          ? t('أدخل كلمة السر للدخول إلى طلباتك ورصيدك.', 'Enter your password to access your orders and balance.')
          : showTerms ? t('أنشئ كلمة سر خاصة بك ووافق على الشروط قبل تفعيل الحساب.', 'Create your password and accept the terms to activate your account.')
          : mode === 'forgot' ? t('اختر طريقة استعادة كلمة السر.', 'Choose a password recovery method.')
          : mode === 'terms-update' ? t('تم تحديث الشروط والأحكام. يجب الموافقة عليها قبل متابعة الحساب.', 'The terms have changed. Accept the updated terms before continuing.')
          : t('حسابك محمي. لن نعرض بياناتك إلا بعد التحقق من الدخول.', 'Your account is protected. Your data is shown only after authentication.')}</p></div></div>

        {entry?.customer_name && (mode === 'activate' || mode === 'login') && <p className="mb-4 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:bg-[#0b302b] dark:text-emerald-100/80">{t('الحساب المرتبط بهذا الرمز', 'Account associated with this QR')}: <strong>{entry.customer_name}</strong></p>}
        {error && <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
        {message && <div role="status" className="mb-4 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{message}</div>}

        {mode === 'loading' ? <div className="flex justify-center py-8"><LoaderCircle className="h-7 w-7 animate-spin text-emerald-700" /></div>
        : mode === 'unavailable' ? <button type="button" onClick={() => { initialized.current = false; void loadEntry(); }} className="w-full rounded-xl bg-emerald-700 px-4 py-3 font-bold text-white">{t('إعادة المحاولة', 'Try again')}</button>
        : mode === 'terms-update' ? <form className="space-y-4" onSubmit={(event) => void submitTermsUpdate(event)}>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm leading-6 dark:border-emerald-900 dark:bg-[#0b302b]">{t('راجع الشروط والأحكام وسياسة استخدام حساب العميل. لا تتغير بياناتك المالية بمجرد الموافقة.', 'Review the customer account terms and usage policy. Accepting them does not change your financial records.')}</div>
          <label className="flex items-start gap-2 text-sm leading-6 text-slate-600 dark:text-emerald-100/75"><input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} className="mt-1 h-4 w-4 accent-emerald-700" /><span>{t('أوافق على الشروط والأحكام المحدّثة.', 'I accept the updated terms and conditions.')}</span></label>
          <button disabled={busy || !termsAccepted} type="submit" className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-3 font-bold text-white disabled:opacity-60"><ShieldCheck className="h-4 w-4" />{busy ? t('جارٍ الحفظ…', 'Saving…') : t('الموافقة والمتابعة', 'Accept and continue')}</button>
        </form>
        : showPasswordForm ? <form className="space-y-4" onSubmit={(event) => {
          if (mode === 'activate') void submitActivation(event);
          else if (mode === 'social-activation') void submitSocialActivation(event);
          else { event.preventDefault(); void finishPasswordChange(mode === 'recovery'); }
        }}>
          <label className="block text-sm font-semibold">{t('كلمة السر الجديدة', 'New password')}
            <div className="relative mt-1"><input required minLength={8} maxLength={128} type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 pe-11 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/15 dark:border-emerald-900 dark:bg-[#061f1c]" placeholder={t('8 أحرف على الأقل', 'At least 8 characters')} /><button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute inset-y-0 end-2 grid place-items-center px-2 text-slate-500" aria-label={showPassword ? t('إخفاء كلمة السر', 'Hide password') : t('إظهار كلمة السر', 'Show password')}>{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div>
          </label>
          <div aria-live="polite" className="space-y-1.5">
            <div className="flex gap-1" aria-label={t('مؤشر قوة كلمة السر', 'Password strength meter')}>
              {[0, 1, 2, 3].map((level) => <span key={level} className={`h-1.5 flex-1 rounded-full ${passwordStrength(password) > level ? (passwordStrength(password) <= 1 ? 'bg-rose-500' : passwordStrength(password) === 2 ? 'bg-amber-500' : passwordStrength(password) === 3 ? 'bg-lime-600' : 'bg-emerald-600') : 'bg-slate-200 dark:bg-emerald-950'}`} />)}
            </div>
            <p className="text-xs text-slate-500 dark:text-emerald-100/60">{password.length === 0 ? t('قوة كلمة السر', 'Password strength') : passwordStrength(password) <= 1 ? t('ضعيفة', 'Weak') : passwordStrength(password) === 2 ? t('متوسطة', 'Fair') : passwordStrength(password) === 3 ? t('جيدة', 'Good') : t('قوية', 'Strong')}</p>
          </div>
          <label className="block text-sm font-semibold">{t('تأكيد كلمة السر', 'Confirm password')}
            <input required minLength={8} maxLength={128} type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/15 dark:border-emerald-900 dark:bg-[#061f1c]" />
          </label>
          {showTerms && <label className="flex items-start gap-2 text-sm leading-6 text-slate-600 dark:text-emerald-100/75"><input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} className="mt-1 h-4 w-4 accent-emerald-700" /><span>{t('أوافق على الشروط والأحكام وسياسة استخدام حساب العميل.', 'I accept the customer account terms and conditions.')}</span></label>}
          {mode === 'force-change' && <p className="rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">{t('يجب تغيير كلمة السر المؤقتة قبل عرض بيانات الحساب.', 'You must change the temporary password before viewing account data.')}</p>}
          <button disabled={busy} type="submit" className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-3 font-bold text-white shadow-sm transition hover:bg-emerald-800 disabled:opacity-60"><KeyRound className="h-4 w-4" />{busy ? t('جارٍ التحقق…', 'Please wait…') : mode === 'activate' ? t('إنشاء الحساب والدخول', 'Create account and sign in') : mode === 'social-activation' ? t('تأكيد كلمة السر وتفعيل الحساب', 'Set password and activate account') : t('حفظ كلمة السر والدخول', 'Save password and continue')}</button>
          {(mode === 'force-change' || mode === 'recovery') && <button type="button" onClick={() => void logout()} className="w-full py-2 text-sm text-slate-500 underline">{t('تسجيل الخروج', 'Sign out')}</button>}
        </form>
        : mode === 'login' ? <form className="space-y-4" onSubmit={(event) => void submitLogin(event)}>
          <label className="block text-sm font-semibold">{t('كلمة السر', 'Password')}
            <div className="relative mt-1"><input required maxLength={128} type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 pe-11 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/15 dark:border-emerald-900 dark:bg-[#061f1c]" /><button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute inset-y-0 end-2 grid place-items-center px-2 text-slate-500" aria-label={t('إظهار أو إخفاء كلمة السر', 'Show or hide password')}>{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div>
          </label>
          <button disabled={busy} type="submit" className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-3 font-bold text-white disabled:opacity-60">{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}{t('دخول إلى حسابي', 'Sign in to my account')}</button>
          <button type="button" onClick={() => { setError(''); setMessage(''); setMode('forgot'); }} className="w-full py-2 text-sm font-semibold text-emerald-800 underline underline-offset-4 dark:text-emerald-200">{t('نسيت كلمة السر؟', 'Forgot password?')}</button>
          <div className="relative py-2"><div className="absolute inset-0 flex items-center"><span className="w-full border-t border-slate-200 dark:border-emerald-900" /></div><span className="relative mx-auto block w-fit bg-white px-3 text-xs text-slate-500 dark:bg-[#082622]">{t('أو الدخول بواسطة', 'Or continue with')}</span></div>
          <div className="grid gap-2">{providers.filter((provider) => entry?.auth_provider === provider.id).map((provider) => <button key={provider.id} type="button" onClick={() => void beginOAuth(provider.id, 'login')} className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold hover:bg-slate-50 dark:border-emerald-900 dark:hover:bg-emerald-950/40">{provider.icon}{provider.label}</button>)}</div>
        </form>
        : mode === 'forgot' ? <div className="space-y-3">
          {entry?.email_recovery_available && <button type="button" disabled={busy} onClick={() => void submitForgot(true)} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-3 font-bold text-white disabled:opacity-60"><Mail className="h-4 w-4" />{t('إرسال رابط آمن إلى بريدي', 'Send a secure reset link to my email')}</button>}
          <button type="button" disabled={busy} onClick={() => void submitForgot(false)} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 py-3 font-bold dark:border-emerald-900"><ShieldCheck className="h-4 w-4" />{t('طلب إعادة التعيين من الإدارة', 'Request reset from administrator')}</button>
          <button type="button" onClick={() => { setError(''); setMessage(''); setMode('login'); }} className="w-full py-2 text-sm underline">{t('العودة لتسجيل الدخول', 'Back to sign in')}</button>
        </div>
        : null}

        {mode === 'activate' && <div className="mt-5 border-t border-slate-200 pt-4 dark:border-emerald-900"><p className="mb-3 text-center text-xs text-slate-500 dark:text-emerald-100/60">{t('أو أنشئ الحساب باستخدام حساب خارجي', 'Or activate using an identity provider')}</p><div className="grid gap-2">{providers.map((provider) => <button key={provider.id} type="button" onClick={() => void beginOAuth(provider.id, 'activate')} className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold hover:bg-slate-50 dark:border-emerald-900 dark:hover:bg-emerald-950/40">{provider.icon}{provider.label}</button>)}</div></div>}
        <footer className="mt-6 flex items-center justify-center gap-2 text-[11px] text-slate-400 dark:text-emerald-100/40"><ShieldCheck className="h-3.5 w-3.5" />{t('جلسة آمنة لمدة 7 أيام · لا نحفظ كلمة السر', 'Secure 7-day session · Password is never stored')}</footer>
      </section>
    </main>
  );
};
