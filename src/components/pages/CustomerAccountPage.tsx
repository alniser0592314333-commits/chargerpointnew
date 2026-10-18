import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, BatteryCharging, CheckCircle2, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, Mail, ShieldCheck, Sparkles } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';
import { AppLogo } from '../qr/AppLogo';
import { PublicCustomerPortalPage, hasCachedCustomerPortalData, clearCachedCustomerPortalData } from './PublicCustomerPortalPage';
import {
  callCustomerAccount, customerAuth, CUSTOMER_TERMS_VERSION, setCustomerSession,
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

type Mode = 'loading' | 'unavailable' | 'activate' | 'login' | 'forgot' | 'portal' | 'force-change' | 'recovery' | 'terms-update';

const commonPassword = (value: string) =>
  value.length >= 8 && value.length <= 128 &&
  !new Set(['password', 'password123', '12345678', 'qwerty123', '11111111', '123456789', '1234567890', 'qwertyuiop', 'abc12345', 'letmein123', 'iloveyou', 'admin123', 'welcome1', 'monkey123', 'dragon123']).has(value.trim().toLowerCase()) &&
  !/^(.)(\1){7,}$/.test(value);
const passwordStrength = (value: string) => {
  if (!value) return 0;
  let score = 0;
  if (value.length >= 8) score++;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
  if (/\d/.test(value)) score++;
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
    try {
      setMode('loading');
      setError('');
      setMessage('');
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
    const recovery = new URLSearchParams(window.location.search).get('customer_recovery') === '1';
    const { data: sessionResult } = await customerAuth.auth.getSession();
    const session = sessionResult.session;
    if (session && recovery) {
      setMode('recovery');
      setMessage(t('أدخل كلمة سر جديدة لإكمال الاستعادة.', 'Set a new password to complete recovery.'));
      return;
    }
    if (session) {
      const registered = await callCustomerAccount<{ must_change_password?: boolean; auth_provider?: EntryStatus["auth_provider"]; terms_version?: string | null; session_expires_at?: string }>(
        'verify-session', { token }, session.access_token,
      );
      const registeredData = registered.data;
      if (registeredData && !registered.error) {
        await saveSessionExpiry(token, registeredData.session_expires_at);
        setEntry((current) => current ? { ...current, auth_provider: registeredData.auth_provider ?? current.auth_provider, terms_version: registeredData.terms_version ?? current.terms_version } : current);
        if (registeredData.must_change_password) setMode('force-change');
        else if (registeredData.terms_version !== CUSTOMER_TERMS_VERSION) { setTermsAccepted(false); setMode('terms-update'); }
        else setMode('portal');
        return;
      }
      await customerAuth.auth.signOut();
      setErrorMessage('ACCOUNT_UNAVAILABLE_OR_INVALID');
    }
      setMode(status.activated ? 'login' : 'activate');
    } catch (loadError) {
      console.error('Customer account entry failed to initialize.', loadError);
      setMode('unavailable');
      setError(t('تعذّر تحميل صفحة الحساب. تحقق من الاتصال ثم أعد المحاولة.', 'The account page could not load. Check your connection and try again.'));
    }
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

  const logout = async () => {
    await callCustomerAccount('logout').catch(() => undefined);
    await customerAuth.auth.signOut();
    clearCachedCustomerPortalData(token);
    localStorage.removeItem(sessionExpiryKey(token));
    setEntry((current) => current ? { ...current, activated: true } : current);
    setMode('login');
    setMessage(t('تم تسجيل الخروج.', 'You have signed out.'));
  };

  if (mode === 'portal') {
    return (
      <div className="relative">
        <div className="mx-auto flex max-w-3xl justify-end gap-2 px-4 pt-3">
          <button type="button" onClick={() => void logout()} className="rounded-xl border border-slate-200 bg-white/90 px-4 py-2 text-sm font-semibold text-slate-700 dark:border-gray-600 dark:bg-[#0a0f18] dark:text-slate-200">
            {t('تسجيل الخروج', 'Sign out')}
          </button>
        </div>
        {message && <p role="status" className="mx-auto max-w-3xl px-4 pt-2 text-sm text-[#9a6712] dark:text-slate-200">{message}</p>}
        <PublicCustomerPortalPage token={token} />
      </div>
    );
  }

  const showTerms = mode === 'activate';
  const showPasswordForm = mode === 'activate' || mode === 'force-change' || mode === 'recovery';
  const title = mode === 'activate' ? t('ابدأ حسابك الخاص', 'Create your account')
    : mode === 'login' ? t('أهلًا بعودتك', 'Welcome back')
    : mode === 'forgot' ? t('لنستعد الوصول معًا', 'Let’s restore your access')
    : mode === 'force-change' ? t('اختر كلمة سر جديدة', 'Choose a new password')
    : mode === 'recovery' ? t('أمّن حسابك من جديد', 'Secure your account again')
    : mode === 'terms-update' ? t('تحديث بسيط قبل المتابعة', 'One quick update before you continue')
    : mode === 'unavailable' ? t('لا يمكن فتح الحساب الآن', 'Your account is unavailable right now')
    : t('بوابة العميل', 'Customer portal');

  const visualTitle = mode === 'activate' ? t('مساحتك الخاصة تبدأ من هنا.', 'Your own space starts here.')
    : mode === 'login' ? t('كل طلباتك. بكل وضوح.', 'Every order. Clear and connected.')
    : mode === 'forgot' || mode === 'recovery' ? t('العودة لحسابك، بثقة.', 'A confident way back in.')
    : mode === 'force-change' ? t('مفتاح جديد، وحماية أقوى.', 'A new key. Stronger protection.')
    : t('حسابك بين يديك.', 'Your account, in your hands.');

  const visualDescription = mode === 'activate' ? t('أنشئ كلمة سر خاصة بك لتتابع طلبات الشحن ورصيدك من مكان واحد.', 'Create a password to keep your charging orders and balance together in one private place.')
    : mode === 'login' ? t('تابع طلبات الشحن، راجع حركات حسابك، وابقَ على اطلاع من أي جهاز.', 'Check charging orders, review account activity, and stay informed from your device.')
    : mode === 'forgot' || mode === 'recovery' ? t('خطوات واضحة لاستعادة الوصول، مع إبقاء بيانات حسابك محمية.', 'A clear recovery flow designed to keep your account details protected.')
    : mode === 'force-change' ? t('اختر كلمة سر لا يعرفها سواك قبل متابعة حسابك.', 'Set a password only you know before continuing to your account.')
    : t('وصول خاص لحسابك، بتجربة هادئة وواضحة.', 'Private access to your account, with a calm and clear experience.');

  const stageLabel = mode === 'activate' ? t('01  /  إعداد الحساب', '01  /  ACCOUNT SETUP')
    : mode === 'login' ? t('02  /  دخول آمن', '02  /  SECURE SIGN IN')
    : mode === 'forgot' || mode === 'recovery' ? t('03  /  استعادة الوصول', '03  /  ACCOUNT RECOVERY')
    : t('حساب العميل  /  نقطة الشحن', 'CUSTOMER ACCOUNT  /  CHARGING POINT');

  const inputClass = 'mt-2 min-h-[54px] w-full rounded-2xl border border-[#d7e0e9] bg-white px-4 py-3 text-[15px] text-[#172335] outline-none transition placeholder:text-[#8b98a8] focus:border-[#d79b24] focus:ring-4 focus:ring-[#f5b942]/15 dark:border-[#334155] dark:bg-[#111925] dark:text-[#f1f5f9] dark:placeholder:text-[#8998ad] dark:focus:border-[#f5b942]';
  const primaryButtonClass = 'group flex min-h-[54px] w-full items-center justify-center gap-3 rounded-2xl bg-[#f0b638] px-5 py-3 text-[15px] font-bold text-[#111827] shadow-[0_12px_28px_rgba(245,185,66,0.18)] transition duration-200 hover:-translate-y-0.5 hover:bg-[#ffd16a] focus:outline-none focus:ring-4 focus:ring-[#f5b942]/25 disabled:cursor-wait disabled:opacity-60 dark:bg-[#f5b942] dark:text-[#111827] dark:hover:bg-[#ffd16a]';

  return (
    <main dir={isAr ? 'rtl' : 'ltr'} className="min-h-[100svh] overflow-x-hidden bg-[#f5f7fa] text-[#172335] transition-colors dark:bg-[#070b12] dark:text-[#eef4ff]">
      <header className="mx-auto flex max-w-[1480px] items-center justify-between gap-4 px-5 py-5 sm:px-8 lg:px-12 lg:py-7">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-[#dce7df] bg-white shadow-sm dark:border-[#283548] dark:bg-[#0a0f18]">
            <AppLogo size={34} variant="auto" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-extrabold tracking-tight">{t('نقطة الشحن', 'Charging Point')}</p>
            <p className="mt-0.5 text-[11px] font-medium tracking-[0.12em] text-[#8290a3] dark:text-[#b5c4d7]">{t('بوابة حساب العميل', 'CUSTOMER ACCOUNT PORTAL')}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={() => setLocale(isAr ? 'en' : 'ar')} className="rounded-full border border-[#d7e0e9] bg-white px-3.5 py-2 text-xs font-bold text-[#344256] transition hover:border-[#e0b44e] dark:border-[#283548] dark:bg-[#0a0f18] dark:text-[#dbe7f5]">{isAr ? 'English' : 'العربية'}</button>
          <button type="button" onClick={toggleTheme} className="grid h-10 w-10 place-items-center rounded-full border border-[#d9e2dc] bg-white text-[#344256] transition hover:border-[#e0b44e] dark:border-[#283548] dark:bg-[#0a0f18] dark:text-[#dbe7f5]" aria-label={t('تغيير المظهر', 'Toggle appearance')}>{resolvedTheme === 'dark' ? <Sparkles className="h-4 w-4" /> : <span aria-hidden="true" className="text-lg leading-none">◐</span>}</button>
        </div>
      </header>

      <section dir="ltr" className="mx-auto grid w-full max-w-[1480px] grid-cols-1 overflow-hidden border-y border-[#dce4dc] bg-[#ffffff] shadow-[0_24px_90px_rgba(9,17,30,0.16)] dark:border-[#303b4b] dark:bg-[#0b1019] lg:min-h-[700px] lg:grid-cols-[1.03fr_0.97fr] lg:rounded-[32px] lg:border">
        <aside dir={isAr ? 'rtl' : 'ltr'} className="relative isolate flex min-h-[280px] flex-col justify-between overflow-hidden bg-[#111d2b] px-6 py-7 text-[#f8fafc] dark:bg-[#080d15] dark:text-[#f8fafc] sm:min-h-[320px] sm:px-9 sm:py-9 lg:min-h-[700px] lg:px-12 lg:py-12 xl:px-16" style={{ background: resolvedTheme === 'dark' ? (mode === 'activate' ? 'radial-gradient(ellipse at 78% 20%, rgba(245,185,66,.16), transparent 38%), radial-gradient(ellipse at 18% 88%, rgba(118,215,245,.09), transparent 42%), #080d15' : mode === 'login' ? 'radial-gradient(ellipse at 82% 18%, rgba(118,215,245,.16), transparent 40%), radial-gradient(ellipse at 16% 88%, rgba(245,185,66,.08), transparent 44%), #080d15' : mode === 'force-change' ? 'radial-gradient(ellipse at 75% 20%, rgba(245,185,66,.2), transparent 38%), #080d15' : 'radial-gradient(ellipse at 82% 20%, rgba(118,215,245,.12), transparent 38%), #080d15') : (mode === 'activate' ? 'radial-gradient(ellipse at 78% 20%, rgba(245,185,66,.24), transparent 38%), #15283a' : mode === 'login' ? 'radial-gradient(ellipse at 82% 18%, rgba(118,215,245,.2), transparent 40%), #15283a' : 'radial-gradient(ellipse at 82% 18%, rgba(245,185,66,.16), transparent 40%), #15283a') }}">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute -end-28 -top-32 h-[390px] w-[390px] rounded-full border border-white/10" />
            <div className="absolute -end-12 -top-16 h-[310px] w-[310px] rounded-full border border-white/10" />
            <div className="absolute end-7 top-[-20px] h-[230px] w-[230px] rounded-full border border-white/10" />
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_78%_18%,rgba(118,215,245,0.16),transparent_42%),linear-gradient(145deg,transparent_35%,rgba(3,10,20,0.46)_100%)]" />
            <svg viewBox="0 0 500 500" className="absolute -end-10 top-1 h-[265px] w-[265px] opacity-95 sm:h-[320px] sm:w-[320px] lg:end-[-24px] lg:top-12 lg:h-[430px] lg:w-[430px]" fill="none" role="img" aria-label={t('لوح شمسي وهاتف قيد الشحن', 'Solar panel and charging phone')}>
              <defs>
                <linearGradient id="solar-panel-fill" x1="96" y1="290" x2="330" y2="390" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#1D3448" />
                  <stop offset="1" stopColor="#0B1420" />
                </linearGradient>
                <linearGradient id="phone-fill" x1="292" y1="150" x2="400" y2="330" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#26364A" />
                  <stop offset="1" stopColor="#101722" />
                </linearGradient>
                <linearGradient id="sun-fill" x1="115" y1="60" x2="200" y2="145" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#FFE29A" />
                  <stop offset="1" stopColor="#F5B942" />
                </linearGradient>
              </defs>
              <circle cx="158" cy="125" r="70" fill="#F5B942" fillOpacity=".08" />
              <circle cx="158" cy="125" r="48" stroke="#F5B942" strokeOpacity=".42" strokeWidth="1.5" />
              <circle cx="158" cy="125" r="32" fill="url(#sun-fill)" />
              <g stroke="#F5B942" strokeWidth="2" strokeLinecap="round" opacity=".85">
                <path d="M158 70V57M158 193V180M103 125H90M226 125H213M119 86L109 76M207 174L197 164M197 86L207 76M109 174L119 164" />
              </g>
              <path d="M45 303L278 249L365 311L132 369L45 303Z" fill="url(#solar-panel-fill)" stroke="#76D7F5" strokeOpacity=".7" strokeWidth="1.5" />
              <path d="M64 307L281 257M86 323L304 272M109 339L326 288M132 355L348 304" stroke="#76D7F5" strokeOpacity=".48" strokeWidth="1.2" />
              <path d="M96 291L180 354M144 280L228 343M193 269L277 331M241 258L325 319" stroke="#76D7F5" strokeOpacity=".42" strokeWidth="1.2" />
              <path d="M131 369L124 390M278 332L287 354" stroke="#94A3B8" strokeWidth="3" strokeLinecap="round" />
              <path d="M116 393L297 348" stroke="#94A3B8" strokeOpacity=".7" strokeWidth="3" strokeLinecap="round" />
              <path d="M300 143Q300 132 311 132H391Q402 132 402 143V314Q402 326 391 326H311Q300 326 300 314V143Z" fill="url(#phone-fill)" stroke="#CBD5E1" strokeOpacity=".82" strokeWidth="2" />
              <path d="M311 157Q311 151 318 151H384Q391 151 391 158V293H311V157Z" fill="#0A1420" stroke="#76D7F5" strokeOpacity=".5" />
              <rect x="342" y="139" width="18" height="3" rx="1.5" fill="#94A3B8" />
              <rect x="327" y="181" width="48" height="24" rx="5" stroke="#F5B942" strokeWidth="2" />
              <rect x="375" y="189" width="4" height="8" rx="1" fill="#F5B942" />
              <rect x="332" y="186" width="12" height="14" rx="2" fill="#F5B942" />
              <path d="M354 216L339 244H353L345 267L369 234H355L362 216H354Z" fill="#76D7F5" />
              <path d="M280 190C258 210 257 238 273 257" stroke="#76D7F5" strokeWidth="2" strokeDasharray="4 7" strokeLinecap="round" />
              <path d="M263 242L273 258L282 243" stroke="#76D7F5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="420" cy="102" r="4" fill="#76D7F5" />
              <circle cx="74" cy="216" r="3" fill="#F5B942" />
              <circle cx="414" cy="365" r="3" fill="#F5B942" />
              <path d="M72 250C110 228 138 231 161 246" stroke="#F5B942" strokeOpacity=".5" strokeWidth="1.5" strokeDasharray="3 8" strokeLinecap="round" />
              {mode === 'forgot' || mode === 'recovery' ? <g transform="translate(386 346)"><circle r="24" fill="#152638" stroke="#76D7F5" strokeWidth="1.5"/><path d="M-7 -2V-7A7 7 0 0 1 7 -7V-2M-10 -2H10V10H-10Z" stroke="#76D7F5" strokeWidth="2" strokeLinejoin="round"/></g> : mode === 'force-change' ? <g transform="translate(386 346)"><circle r="24" fill="#302719" stroke="#F5B942" strokeWidth="1.5"/><path d="M-8 0L-2 6L9 -7" stroke="#F5B942" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></g> : <g transform="translate(386 346)"><circle r="24" fill="#152638" stroke="#76D7F5" strokeWidth="1.5"/><path d="M-8 0H8M0 -8V8" stroke="#76D7F5" strokeWidth="2.5" strokeLinecap="round"/></g>}
            </svg>
            <div className="absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-[#111827]/65 to-transparent" />
          </div>

          <div className="relative z-10 flex items-center gap-2 text-[10px] font-bold tracking-[0.2em] text-[#cbd5e1] sm:text-[11px]">
            <span className="h-px w-7 bg-[#f5b942]" />
            {t('مساحة عميل خاصة', 'YOUR PRIVATE CUSTOMER SPACE')}
          </div>

          <div className="relative z-10 mt-9 max-w-[520px] lg:mt-auto lg:mb-auto lg:pt-20">
            <p className="mb-4 text-xs font-bold tracking-[0.16em] text-[#cbd5e1]">{stageLabel}</p>
            <h2 className="max-w-[13ch] text-[clamp(2rem,4.2vw,4.2rem)] font-semibold leading-[1.13] tracking-[-0.045em]">{visualTitle}</h2>
            <p className="mt-5 max-w-[39ch] text-sm leading-7 text-[#e2e8f0] sm:text-[15px]">{visualDescription}</p>
          </div>

          <div className="relative z-10 mt-8 flex items-end justify-between gap-4 border-t border-white/15 pt-5 lg:mt-12">
            <div>
              <p className="text-[10px] font-bold tracking-[0.18em] text-[#cbd5e1]">{t('خصوصية أولًا', 'PRIVACY FIRST')}</p>
              <p className="mt-1.5 text-xs text-[#e2e8f0]">{t('لا نطلب منك مشاركة كلمة السر مع أحد.', 'Never share your password with anyone.')}</p>
            </div>
            <div className="hidden items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3 py-2 text-[11px] text-[#e2e8f0] sm:flex">
              <LockKeyhole className="h-3.5 w-3.5" />
              {t('جلسة آمنة · 7 أيام', 'SECURE SESSION · 7 DAYS')}
            </div>
          </div>
        </aside>

        <div dir={isAr ? 'rtl' : 'ltr'} className="flex min-w-0 flex-col justify-center px-5 py-8 sm:px-9 sm:py-10 lg:px-12 lg:py-14 xl:px-16">
          <div className="mb-8 flex items-center gap-2 text-[11px] font-bold tracking-[0.15em] text-[#718096] dark:text-[#b5c4d7]">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-[#fff0c8] text-[#81560b] dark:bg-[#1d2939] dark:text-[#e5e7eb]"><LockKeyhole className="h-3.5 w-3.5" /></span>
            {t('دخول خاص ومحمي', 'PRIVATE & PROTECTED ACCESS')}
          </div>

          <div className="max-w-[500px]">
            <h1 className="text-[clamp(1.9rem,3vw,2.75rem)] font-semibold leading-tight tracking-[-0.04em] text-[#172335] dark:text-[#f8fafc]">{title}</h1>
            <p className="mt-3 max-w-[42ch] text-sm leading-7 text-[#66758a] dark:text-[#b5c4d7]">
              {mode === 'login'
                ? t('أدخل كلمة السر للوصول إلى طلباتك ورصيدك.', 'Enter your password to access your orders and balance.')
                : mode === 'activate'
                  ? t('أنشئ كلمة سر قوية ووافق على الشروط لتفعيل حسابك لأول مرة.', 'Create a strong password and accept the terms to activate your account for the first time.')
                  : mode === 'forgot'
                    ? t('اختر الطريقة المناسبة لاستعادة كلمة السر. لن نكشف عن بيانات الحساب.', 'Choose a recovery method. We never reveal private account details.')
                    : mode === 'terms-update'
                      ? t('راجع الشروط المحدّثة قبل متابعة حسابك.', 'Review the updated terms before continuing.')
                      : mode === 'unavailable'
                        ? t('تحقق من الاتصال أو افتح رمز QR الصحيح ثم حاول مرة أخرى.', 'Check your connection or open the correct QR code, then try again.')
                        : t('أكمل الخطوة التالية لحماية حسابك ومتابعة طلباتك.', 'Complete the next step to protect your account and continue to your orders.')}
            </p>
          </div>

          {entry?.customer_name && (mode === 'activate' || mode === 'login') && (
            <div className="mt-6 flex items-center gap-3 rounded-2xl border border-[#e7dfca] bg-[#fff9ec] px-4 py-3.5 dark:border-[#283548] dark:bg-[#121a27]">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-[#d79b24] dark:bg-[#1d2939] dark:text-[#b5c4d7]"><BatteryCharging className="h-5 w-5" /></div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold tracking-[0.13em] text-[#82958a]">{t('الحساب المرتبط بهذا الرمز', 'ACCOUNT LINKED TO THIS QR')}</p>
                <p className="mt-0.5 truncate text-sm font-bold text-[#172335] dark:text-[#e5f0ff]">{entry.customer_name}</p>
              </div>
              <CheckCircle2 className="ms-auto h-4 w-4 shrink-0 text-[#d79b24]" />
            </div>
          )}

          <div className="mt-7 max-w-[500px]">
            {error && <div role="alert" className="mb-4 flex items-start gap-2.5 rounded-2xl border border-[#efc7c0] bg-[#fff1ee] px-4 py-3.5 text-sm leading-6 text-[#963f35] dark:border-[#71313c] dark:bg-[#301b22] dark:text-[#fecaca]"><AlertTriangle className="mt-1 h-4 w-4 shrink-0" />{error}</div>}
            {message && <div role="status" className="mb-4 flex items-start gap-2.5 rounded-2xl border border-[#c5dfce] bg-[#edf7ef] px-4 py-3.5 text-sm leading-6 text-[#2f6a4c] dark:border-[#2b5267] dark:bg-[#142b38] dark:text-[#a8dff5]"><CheckCircle2 className="mt-1 h-4 w-4 shrink-0" />{message}</div>}

            {mode === 'loading' ? (
              <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-[#718096] dark:text-[#b5c4d7]" role="status">
                <LoaderCircle className="h-7 w-7 animate-spin text-[#d79b24]" />
                {t('نتحقق من رابط الحساب بأمان…', 'Securely checking your account link…')}
              </div>
            ) : mode === 'unavailable' ? (
              <button type="button" onClick={() => { initialized.current = false; void loadEntry(); }} className={primaryButtonClass}>
                {t('إعادة المحاولة', 'Try again')} {isAr ? <ArrowLeft className="h-4 w-4 transition group-hover:-translate-x-1" /> : <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />}
              </button>
            ) : mode === 'terms-update' ? (
              <form className="space-y-5" onSubmit={(event) => void submitTermsUpdate(event)}>
                <div className="rounded-2xl border border-[#e7dfca] bg-[#fff9ec] p-4 text-sm leading-7 text-[#5e7568] dark:border-[#283548] dark:bg-[#121a27] dark:text-[#d1d5db]">{t('راجع الشروط والأحكام وسياسة استخدام حساب العميل. الموافقة لا تغيّر أي بيانات مالية.', 'Review the customer account terms and usage policy. Accepting them does not change any financial records.')}</div>
                <label className="flex items-start gap-3 text-sm leading-6 text-[#59677a] dark:text-[#d1d5db]"><input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} className="mt-1 h-4 w-4 accent-[#d79b24]" /><span>{t('أوافق على الشروط والأحكام المحدّثة.', 'I accept the updated terms and conditions.')}</span></label>
                <button disabled={busy || !termsAccepted} type="submit" className={primaryButtonClass}><ShieldCheck className="h-4 w-4" />{busy ? t('جارٍ الحفظ…', 'Saving…') : t('الموافقة والمتابعة', 'Accept and continue')}</button>
              </form>
            ) : showPasswordForm ? (
              <form className="space-y-5" onSubmit={(event) => {
                if (mode === 'activate') void submitActivation(event);
                else { event.preventDefault(); void finishPasswordChange(mode === 'recovery'); }
              }}>
                <label className="block text-sm font-bold text-[#26364b] dark:text-[#e5e7eb]">{t('كلمة السر الجديدة', 'New password')}
                  <div className="relative">
                    <input required minLength={8} maxLength={128} type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" className={inputClass} placeholder={t('8 أحرف على الأقل', 'At least 8 characters')} />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute inset-y-2 end-2 grid w-10 place-items-center rounded-xl text-[#718096] transition hover:bg-[#fff7e5] dark:text-[#b5c4d7] dark:hover:bg-[#263449]" aria-label={showPassword ? t('إخفاء كلمة السر', 'Hide password') : t('إظهار كلمة السر', 'Show password')}>{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
                  </div>
                </label>

                <div aria-live="polite" className="space-y-2">
                  <div className="flex gap-1.5" aria-label={t('مؤشر قوة كلمة السر', 'Password strength meter')}>
                    {[0, 1, 2, 3].map((level) => <span key={level} className={'h-1.5 flex-1 rounded-full transition-colors ' + (passwordStrength(password) > level ? (passwordStrength(password) <= 1 ? 'bg-[#c45d51]' : passwordStrength(password) === 2 ? 'bg-[#c39a49]' : passwordStrength(password) === 3 ? 'bg-[#d6a43a]' : 'bg-[#62b8d5]') : 'bg-[#e2e9e2] dark:bg-[#4b5563]')} />)}
                  </div>
                  <p className="text-xs text-[#8290a3] dark:text-[#b5c4d7]">{password.length === 0 ? t('استخدم كلمة سر يصعب تخمينها', 'Choose a password that is hard to guess') : passwordStrength(password) <= 1 ? t('ضعيفة — أضف تنوعًا أكثر', 'Weak — add more variety') : passwordStrength(password) === 2 ? t('متوسطة', 'Fair') : passwordStrength(password) === 3 ? t('جيدة', 'Good') : t('قوية', 'Strong')}</p>
                </div>

                <label className="block text-sm font-bold text-[#26364b] dark:text-[#e5e7eb]">{t('تأكيد كلمة السر', 'Confirm password')}
                  <input required minLength={8} maxLength={128} type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" className={inputClass} placeholder={t('أعد كتابة كلمة السر', 'Enter the password again')} />
                </label>

                {showTerms && <label className="flex items-start gap-3 text-sm leading-6 text-[#59677a] dark:text-[#d1d5db]"><input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} className="mt-1 h-4 w-4 accent-[#d79b24]" /><span>{t('أوافق على الشروط والأحكام وسياسة استخدام حساب العميل.', 'I accept the customer account terms and conditions.')}</span></label>}
                {mode === 'force-change' && <p className="rounded-2xl border border-[#e8d8ad] bg-[#fbf5e6] p-3.5 text-sm leading-6 text-[#7d622d] dark:border-[#75602e] dark:bg-[#302819] dark:text-[#ffe3a0]">{t('يجب تغيير كلمة السر المؤقتة قبل عرض بيانات الحساب.', 'You must change the temporary password before viewing account data.')}</p>}
                <button disabled={busy} type="submit" className={primaryButtonClass}>
                  {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                  {busy ? t('جارٍ التحقق…', 'Please wait…') : mode === 'activate' ? t('إنشاء الحساب والدخول', 'Create account and sign in') : t('حفظ كلمة السر والمتابعة', 'Save password and continue')}
                  {!busy && (isAr ? <ArrowLeft className="h-4 w-4 transition group-hover:-translate-x-1" /> : <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />)}
                </button>
                {(mode === 'force-change' || mode === 'recovery') && <button type="button" onClick={() => void logout()} className="w-full py-2 text-sm font-semibold text-[#7b8d83] transition hover:text-[#9a6712] dark:text-[#b5c4d7]">{t('تسجيل الخروج', 'Sign out')}</button>}
              </form>
            ) : mode === 'login' ? (
              <form className="space-y-5" onSubmit={(event) => void submitLogin(event)}>
                <label className="block text-sm font-bold text-[#26364b] dark:text-[#e5e7eb]">{t('كلمة السر', 'Password')}
                  <div className="relative">
                    <input required maxLength={128} type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" className={inputClass} placeholder={t('أدخل كلمة السر الخاصة بك', 'Enter your password')} />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute inset-y-2 end-2 grid w-10 place-items-center rounded-xl text-[#718096] transition hover:bg-[#fff7e5] dark:text-[#b5c4d7] dark:hover:bg-[#263449]" aria-label={showPassword ? t('إخفاء كلمة السر', 'Hide password') : t('إظهار كلمة السر', 'Show password')}>{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
                  </div>
                </label>
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[#718096] dark:text-[#b5c4d7]">
                  <span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-[#d79b24]" />{t('تحقق آمن قبل عرض البيانات', 'Verified before showing data')}</span>
                  <button type="button" onClick={() => { setError(''); setMessage(''); setMode('forgot'); }} className="font-bold text-[#b87913] underline-offset-4 hover:underline dark:text-[#a8dff5]">{t('نسيت كلمة السر؟', 'Forgot password?')}</button>
                </div>
                <button disabled={busy} type="submit" className={primaryButtonClass}>
                  {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                  {busy ? t('جارٍ التحقق…', 'Checking…') : t('دخول إلى حسابي', 'Sign in to my account')}
                  {!busy && (isAr ? <ArrowLeft className="h-4 w-4 transition group-hover:-translate-x-1" /> : <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />)}
                </button>
              </form>
            ) : mode === 'forgot' ? (
              <div className="space-y-3.5">
                <div className="mb-5 rounded-2xl border border-[#e7dfca] bg-[#fff9ec] p-4 dark:border-[#283548] dark:bg-[#121a27]">
                  <div className="flex items-start gap-3">
                    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-[#d79b24] dark:bg-[#1d2939] dark:text-[#b5c4d7]"><Mail className="h-5 w-5" /></div>
                    <p className="text-sm leading-6 text-[#59677a] dark:text-[#d1d5db]">{t('إذا كان بريدك الإلكتروني موثّقًا، يمكنك طلب رابط استعادة آمن. وإلا يمكنك إرسال طلب للإدارة.', 'If you have a verified email, you can request a secure reset link. Otherwise, you can send a request to the administrator.')}</p>
                  </div>
                </div>
                {entry?.email_recovery_available && <button type="button" disabled={busy} onClick={() => void submitForgot(true)} className={primaryButtonClass}><Mail className="h-4 w-4" />{busy ? t('جارٍ الإرسال…', 'Sending…') : t('إرسال رابط استعادة آمن', 'Send a secure recovery link')}</button>}
                <button type="button" disabled={busy} onClick={() => void submitForgot(false)} className="flex min-h-[54px] w-full items-center justify-center gap-2 rounded-2xl border border-[#d7e0e9] bg-transparent px-5 py-3 text-sm font-bold text-[#26364b] transition hover:bg-[#fff7e5] disabled:opacity-60 dark:border-[#4b5563] dark:text-[#e5e7eb] dark:hover:bg-[#263449]"><ShieldCheck className="h-4 w-4" />{t('طلب إعادة التعيين من الإدارة', 'Request a reset from the administrator')}</button>
                <button type="button" onClick={() => { setError(''); setMessage(''); setMode('login'); }} className="mt-2 flex w-full items-center justify-center gap-2 py-3 text-sm font-semibold text-[#6d8478] transition hover:text-[#9a6712] dark:text-[#b5c4d7]">{isAr ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}{t('العودة لتسجيل الدخول', 'Back to sign in')}</button>
              </div>
            ) : null}
          </div>

          <footer className="mt-9 flex flex-wrap items-center gap-2 border-t border-[#e2e9e2] pt-5 text-[11px] leading-5 text-[#91a198] dark:border-[#283548] dark:text-[#94a3b8]">
            <ShieldCheck className="h-4 w-4 shrink-0 text-[#d79b24]" />
            <span>{t('جلسة محمية لمدة 7 أيام · لا نحفظ كلمة السر على جهازنا.', 'Protected session for 7 days · Your password is never stored by us.')}</span>
          </footer>
        </div>
      </section>

      <div className="mx-auto flex max-w-[1480px] flex-wrap items-center justify-between gap-3 px-5 py-6 text-[10px] font-medium tracking-[0.08em] text-[#8a9a91] sm:px-8 lg:px-12">
        <span>{t('نقطة الشحن · بوابة العميل', 'CHARGING POINT · CUSTOMER PORTAL')}</span>
        <span>{t('وصول واضح. خصوصية محفوظة.', 'CLEAR ACCESS. PRIVACY RESPECTED.')}</span>
      </div>
    </main>
  );
};
