import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { startCustomerNativePushNotifications } from '../../services/customer/nativeCustomerPush';
import { enrollAccountBiometric, getAccountBiometricStatus, isNativeBiometricAvailable, loginWithAccountBiometric } from '../../services/auth/accountBiometric';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Eye, EyeOff, Fingerprint, KeyRound, LoaderCircle, LockKeyhole, Mail, Moon, ShieldCheck, Sun } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';
import { AppLogo } from '../qr/AppLogo';
import { CustomerAuthScene, CustomerAuthClipDefs } from './CustomerAuthScene';
import '../../customer-auth.css';
import './customer-reset-approved-toast.css';
import { PublicCustomerPortalPage, hasCachedCustomerPortalData, clearCachedCustomerPortalData } from './PublicCustomerPortalPage';
import {
  callCustomerAccount, customerAuth, CUSTOMER_TERMS_VERSION, setCustomerSession,
} from '../../services/customer/customerAuth';

type EntryStatus = {
  valid: boolean;
  activated: boolean;
  customer_name?: string;
  customer_code?: string | null;
  customer_qr_token?: string | null;
  email_recovery_available?: boolean;
  auth_provider?: "password" | "google" | "apple" | "facebook" | null;
  terms_version?: string | null;
};
const SAVED_CUSTOMER_ACCOUNTS_KEY = 'cp_saved_customer_accounts_v1';
type SavedCustomerAccount = { token: string; label: string };
const readSavedCustomerAccounts = (): SavedCustomerAccount[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_CUSTOMER_ACCOUNTS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter((item): item is SavedCustomerAccount =>
      item && typeof item.token === 'string' && item.token.trim().length > 0 && item.token.length <= 64 &&
      /^[A-Za-z0-9_-]+$/.test(item.token) && typeof item.label === 'string' && item.label.trim().length > 0 && item.label.length <= 160
    );
    return valid.filter((item, index, all) => all.findIndex((candidate) => candidate.token === item.token) === index).slice(0, 5);
  } catch { return []; }
};
const saveCustomerAccount = (account: SavedCustomerAccount): SavedCustomerAccount[] => {
  const token = account.token.trim();
  const label = account.label.trim().slice(0, 160);
  if (!token || token.length > 64 || !/^[A-Za-z0-9_-]+$/.test(token) || !label) return readSavedCustomerAccounts();
  const accounts = [{ token, label }, ...readSavedCustomerAccounts().filter((item) => item.token !== token)].slice(0, 5);
  try { localStorage.setItem(SAVED_CUSTOMER_ACCOUNTS_KEY, JSON.stringify(accounts)); } catch {}
  return accounts;
};
const sessionExpiryKey = (token: string) => 'cp_customer_session_binding:' + token;
const portalTokenCacheKey = (token: string) => 'cp_customer_portal_token:' + token;
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

const hasLocallyBoundCustomerSession = (token: string): boolean => {
  if (!token) return false;
  try {
    const rawSession = localStorage.getItem('chargerpoint_customer_auth_session');
    if (!rawSession) return false;
    // The access token commonly expires after about an hour; the separately
    // registered customer-account binding is valid for up to seven days. Offline
    // read-only access must follow that server-issued binding, not JWT expiry.
    const session = JSON.parse(rawSession) as { access_token?: string; expires_at?: number };
    if (!session.access_token) return false;
    const sessionId = sessionIdFromAccessToken(session.access_token);
    const binding = JSON.parse(localStorage.getItem(sessionExpiryKey(token)) || 'null') as { expiresAt?: number; sessionId?: string } | null;
    const portalToken = localStorage.getItem(portalTokenCacheKey(token)) || token;
    return Boolean(sessionId && binding?.sessionId === sessionId && Number(binding.expiresAt) > Date.now()
      && hasCachedCustomerPortalData(portalToken));
  } catch { return false; }
};

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
  const customerQuery = new URLSearchParams(window.location.search);
  const customerIdFromQuery = customerQuery.get('customerId')?.trim() ?? '';
  const orderQrToken = customerQuery.get('orderQrToken')?.trim() ?? '';
  const directEntry = token === 'portal' && !customerIdFromQuery && !orderQrToken;
  const [username, setUsername] = useState('');
  const [savedCustomerAccounts, setSavedCustomerAccounts] = useState<SavedCustomerAccount[]>(() => readSavedCustomerAccounts());
  const [showSavedCustomerAccounts, setShowSavedCustomerAccounts] = useState(() => directEntry && readSavedCustomerAccounts().length > 0);
  const [selectedSavedCustomerAccountLabel, setSelectedSavedCustomerAccountLabel] = useState('');
  const [pendingRememberCustomerAccount, setPendingRememberCustomerAccount] = useState<SavedCustomerAccount | null>(null);
  const [accountToken, setAccountToken] = useState(customerIdFromQuery || (orderQrToken || directEntry ? '' : token));
  const { locale, setLocale } = useI18n();
  const { resolvedTheme, toggleTheme } = useTheme();
  const isAr = locale === 'ar';
  const [mode, setMode] = useState<Mode>(() => directEntry && !accountToken ? 'login' : hasLocallyBoundCustomerSession(accountToken) ? 'portal' : 'loading');
  const [entry, setEntry] = useState<EntryStatus | null>(null);
  const [portalToken, setPortalToken] = useState(() => { try { return localStorage.getItem(portalTokenCacheKey(accountToken)) || token; } catch { return token; } });
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showBiometricSetup, setShowBiometricSetup] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);
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
      if (!hasLocallyBoundCustomerSession(accountToken)) setMode('loading');
      setError('');
      setMessage('');
      if (directEntry && !accountToken) {
        setMode('login');
        return;
      }
      if (orderQrToken && !accountToken) {
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          setMode('unavailable');
          setError(t('يلزم الاتصال بالإنترنت لفتح حساب العميل من رمز الطلب.', 'Connect to the internet to open the customer account from this order QR.'));
          return;
        }
        const resolved = await callCustomerAccount<{ customer_id?: string }>(
          'resolve-order-customer-id', { token: orderQrToken },
        );
        if (resolved.error || !resolved.data?.customer_id) {
          setMode('unavailable');
          setError(t('الحساب غير متاح حاليًا. تأكد من رمز الطلب أو تواصل مع الإدارة.', 'The account is currently unavailable. Check the order QR or contact the administrator.'));
          return;
        }
        initialized.current = false;
        setAccountToken(resolved.data.customer_id);
        return;
      }
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
      // Read the persisted session snapshot directly here. Calling auth.getSession()
      // may try to refresh an expired JWT and fail when offline, even though the
      // locally cached, read-only customer session binding is still valid.
      const localSession = (() => {
        try {
          const raw = localStorage.getItem('chargerpoint_customer_auth_session');
          const session = raw ? JSON.parse(raw) as { access_token?: string } : null;
          return { session: session?.access_token ? session : null };
        } catch { return { session: null }; }
      })();
      let localBinding: { expiresAt?: number; sessionId?: string } | null = null;
      let cachedPortalToken = accountToken;
      try {
        localBinding = JSON.parse(localStorage.getItem(sessionExpiryKey(accountToken)) || 'null');
        cachedPortalToken = localStorage.getItem(portalTokenCacheKey(accountToken)) || accountToken;
      } catch {}
      const localAccessToken = localSession.session?.access_token;
      const currentSessionId = localAccessToken ? sessionIdFromAccessToken(localAccessToken) : null;
      if (localAccessToken && localBinding?.expiresAt && localBinding.expiresAt > Date.now() &&
          localBinding.sessionId && localBinding.sessionId === currentSessionId && hasCachedCustomerPortalData(cachedPortalToken)) {
        setPortalToken(cachedPortalToken);
        setMode('portal');
        setMessage(t('أنت غير متصل. هذه آخر نسخة محفوظة؛ الدفع وتغييرات الحساب متوقفة حتى عودة الإنترنت.', 'You are offline. This is the last saved copy; payments and account changes are disabled until you reconnect.'));
      } else {
        setMode('unavailable');
        setError(t('يلزم الاتصال بالإنترنت لتسجيل الدخول والتحقق من الحساب. لا توجد نسخة محفوظة صالحة لهذا الجهاز.', 'An internet connection is required. No valid saved copy is available on this device.'));
      }
      return;
    }
    const result = await callCustomerAccount<EntryStatus>('entry', { token: accountToken });
    if (!result.data || result.error || result.data.valid !== true) {
      // A previously server-bound session may view its cached read-only portal while
      // offline. A confirmed server-side invalid account never uses this fallback.
      if (result.error === 'NETWORK_UNAVAILABLE' && hasLocallyBoundCustomerSession(accountToken)) {
        const cachedToken = (() => { try { return localStorage.getItem(portalTokenCacheKey(accountToken)) || accountToken; } catch { return accountToken; } })();
        setPortalToken(cachedToken);
        setMode('portal');
        setMessage(t('أنت غير متصل. هذه آخر بيانات محفوظة؛ العمليات المالية وتغييرات الحساب متوقفة حتى عودة الإنترنت.', 'You are offline. Showing the last saved data; financial actions and account changes are disabled until you reconnect.'));
        return;
      }
      setMode('unavailable');
      setErrorMessage(result.error || 'ACCOUNT_UNAVAILABLE_OR_INVALID');
      return;
    }
    const status = result.data as EntryStatus;
    setEntry(status);
    const resolvedPortalToken = typeof status.customer_qr_token === 'string' && status.customer_qr_token.length >= 24
      ? status.customer_qr_token
      : accountToken;
    setPortalToken(resolvedPortalToken);
    try { localStorage.setItem(portalTokenCacheKey(accountToken), resolvedPortalToken); } catch {}
    const recovery = new URLSearchParams(window.location.search).get('customer_recovery') === '1';
    const { data: sessionResult } = await customerAuth.auth.getSession();
    const session = sessionResult.session;
    if (session && recovery) {
      setMode('recovery');
      setMessage(t('أدخل كلمة سر جديدة لإكمال الاستعادة.', 'Set a new password to complete recovery.'));
      return;
    }
    if (session) {
      const registered = await callCustomerAccount<{ must_change_password?: boolean; auth_provider?: EntryStatus["auth_provider"]; terms_version?: string | null; session_expires_at?: string; customer_qr_token?: string | null }>(
        'verify-session', { token: accountToken }, session.access_token,
      );
      const registeredData = registered.data;
      if (registeredData && !registered.error) {
        if (typeof registeredData.customer_qr_token === 'string' && registeredData.customer_qr_token.length >= 24) {
          setPortalToken(registeredData.customer_qr_token);
          try { localStorage.setItem(portalTokenCacheKey(accountToken), registeredData.customer_qr_token); } catch {}
        }
        await saveSessionExpiry(accountToken, registeredData.session_expires_at);
        const rememberedToken = typeof registeredData.customer_qr_token === 'string' && registeredData.customer_qr_token.length >= 24
          ? registeredData.customer_qr_token
          : accountToken;
        try { localStorage.setItem('last_customer_token', rememberedToken); } catch {}
        if (rememberedToken !== accountToken) await saveSessionExpiry(rememberedToken, registeredData.session_expires_at);
        setEntry((current) => current ? { ...current, auth_provider: registeredData.auth_provider ?? current.auth_provider, terms_version: registeredData.terms_version ?? current.terms_version } : current);
        if (registeredData.must_change_password) { setMode('force-change'); setMessage(t('تمت الموافقة على طلب إعادة تعيين كلمة المرور. عيّن كلمة مرور جديدة للمتابعة.', 'Your password reset request was approved. Set a new password to continue.')); }
        else if (registeredData.terms_version !== CUSTOMER_TERMS_VERSION) { setTermsAccepted(false); setMode('terms-update'); }
        else setMode('portal');
        return;
      }
      if (registered.error === 'NETWORK_UNAVAILABLE' && hasLocallyBoundCustomerSession(accountToken)) {
        const cachedToken = (() => { try { return localStorage.getItem(portalTokenCacheKey(accountToken)) || accountToken; } catch { return accountToken; } })();
        setPortalToken(cachedToken);
        setMode('portal');
        setMessage(t('تعذّر الوصول للخادم. تعرض الصفحة آخر نسخة محفوظة للقراءة فقط حتى عودة الاتصال.', 'The server is unreachable. Showing the last saved read-only copy until connectivity returns.'));
        return;
      }
      await customerAuth.auth.signOut();
      setErrorMessage('ACCOUNT_UNAVAILABLE_OR_INVALID');
    }
      if (customerIdFromQuery && !status.activated) {
      setMode('unavailable');
      setError(t('لإنشاء الحساب لأول مرة، استخدم رمز QR الخاص بحساب العميل.', 'For first-time account setup, scan your customer account QR.'));
      return;
    }
    setMode(status.activated ? 'login' : 'activate');
    } catch (loadError) {
      console.error('Customer account entry failed to initialize.', loadError);
      setMode('unavailable');
      setError(t('تعذّر تحميل صفحة الحساب. تحقق من الاتصال ثم أعد المحاولة.', 'The account page could not load. Check your connection and try again.'));
    }
  }, [accountToken, directEntry, orderQrToken, t]);

  useEffect(() => {
    if (mode === 'portal' && Capacitor.isNativePlatform()) {
      void startCustomerNativePushNotifications(document.documentElement.lang);
    }
  }, [mode]);

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
      const completed = await callCustomerAccount<{ session_expires_at?: string; terms_version?: string }>('complete-password-change', { token: accountToken });
      if (completed.error) { setErrorMessage(completed.error); return; }
      await saveSessionExpiry(accountToken, completed.data?.session_expires_at);
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
      const result = await callCustomerAccount<{ session?: { access_token: string; refresh_token: string }; session_expires_at?: string; customer_qr_token?: string | null }>(
        'activate-password', { token: accountToken, password, confirmPassword, termsAccepted: true, termsVersion: CUSTOMER_TERMS_VERSION },
      );
      if (result.error || !result.data?.session) { setErrorMessage(result.error || 'ACTIVATION_UNAVAILABLE'); return; }
      const sessionError = await setCustomerSession(result.data.session);
      await saveSessionExpiry(accountToken, result.data.session_expires_at);
      if (sessionError) { setError(t('تم إنشاء الحساب لكن تعذّر إكمال الدخول. ارجع وسجّل الدخول بكلمة السر.', 'Account created, but sign-in could not be completed. Return and sign in with your password.')); setMode('login'); return; }
      const rememberedToken = typeof result.data.customer_qr_token === 'string' && result.data.customer_qr_token.length >= 24
        ? result.data.customer_qr_token
        : accountToken;
      try { localStorage.setItem('last_customer_token', rememberedToken); } catch {}
      if (rememberedToken !== accountToken) await saveSessionExpiry(rememberedToken, result.data.session_expires_at);
      const customerLoginIdentifier = entry?.customer_code || accountToken;
      if (!savedCustomerAccounts.some((account) => account.token === customerLoginIdentifier)) {
        setPendingRememberCustomerAccount({ token: customerLoginIdentifier, label: entry?.customer_name || customerLoginIdentifier });
      }
      setPassword(''); setConfirmPassword('');
      setShowBiometricSetup(await isNativeBiometricAvailable());
      setMode('portal');
    } finally { setBusy(false); }
  };

  const submitLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    const loginToken = directEntry ? username.trim() : accountToken;
    if (!loginToken || !password) { setErrorMessage('INVALID_CREDENTIALS'); return; }
    let loginAccountLabel = entry?.customer_name || loginToken;
    let loginAccountIdentifier = entry?.customer_code || loginToken;
    setBusy(true); setError('');
    try {
      if (directEntry) {
        const entryResult = await callCustomerAccount<EntryStatus>('entry', { token: loginToken });
        if (entryResult.error || !entryResult.data?.valid) {
          setErrorMessage(entryResult.error === 'NETWORK_UNAVAILABLE' ? entryResult.error : 'INVALID_CREDENTIALS');
          return;
        }
        if (!entryResult.data.activated) {
          setError(t('لإنشاء الحساب لأول مرة، استخدم رمز QR الخاص بحساب العميل.', 'For first-time account setup, scan your customer account QR.'));
          return;
        }
        setEntry(entryResult.data);
        loginAccountLabel = entryResult.data.customer_name || loginToken;
        loginAccountIdentifier = entryResult.data.customer_code || loginToken;
      }
      const result = await callCustomerAccount<{ session?: { access_token: string; refresh_token: string }; must_change_password?: boolean; terms_version?: string | null; auth_provider?: EntryStatus["auth_provider"]; session_expires_at?: string; customer_qr_token?: string | null; customer_code?: string | null }>(
        'login', { token: loginToken, password },
      );
      const loginData = result.data;
      if (result.error || !loginData?.session) {
        setErrorMessage(result.error === 'NETWORK_UNAVAILABLE' ? result.error : 'INVALID_CREDENTIALS');
        return;
      }
      loginAccountIdentifier = loginData.customer_code || loginAccountIdentifier;
      const sessionError = await setCustomerSession(loginData.session);
      if (directEntry) setAccountToken(loginToken);
      if (typeof loginData.customer_qr_token === 'string' && loginData.customer_qr_token.length >= 24) {
        setPortalToken(loginData.customer_qr_token);
        try { localStorage.setItem(portalTokenCacheKey(loginToken), loginData.customer_qr_token); } catch {}
      }
      await saveSessionExpiry(loginToken, loginData.session_expires_at);
      if (sessionError) { setErrorMessage(sessionError); return; }
      if (Capacitor.isNativePlatform()) {
        try {
          const biometricStatus = await getAccountBiometricStatus(loginData.session.access_token);
          if (!biometricStatus.enrolled) setShowBiometricSetup(true);
        } catch { /* Password sign-in remains available if biometric status cannot be checked. */ }
      }
      const rememberedToken = typeof loginData.customer_qr_token === 'string' && loginData.customer_qr_token.length >= 24
        ? loginData.customer_qr_token
        : loginToken;
      try { localStorage.setItem('last_customer_token', rememberedToken); } catch {}
      if (rememberedToken !== loginToken) await saveSessionExpiry(rememberedToken, loginData.session_expires_at);
      setPassword('');
      setMessage('');
      setEntry((current) => current ? { ...current, terms_version: loginData.terms_version ?? current.terms_version, auth_provider: loginData.auth_provider ?? current.auth_provider } : current);
      const alreadySavedByEnteredIdentifier = savedCustomerAccounts.some((account) => account.token === loginToken);
      if (alreadySavedByEnteredIdentifier && loginAccountIdentifier !== loginToken) {
        // Upgrade older saved QR-token entries to the short customer code after a successful sign-in.
        setSavedCustomerAccounts(saveCustomerAccount({ token: loginAccountIdentifier, label: loginAccountLabel }));
      } else if (!savedCustomerAccounts.some((account) => account.token === loginAccountIdentifier)) {
        setPendingRememberCustomerAccount({ token: loginAccountIdentifier, label: loginAccountLabel });
      }
      if (loginData.must_change_password) { setMode('force-change'); setMessage(t('تمت الموافقة على طلب إعادة تعيين كلمة المرور. عيّن كلمة مرور جديدة للمتابعة.', 'Your password reset request was approved. Set a new password to continue.')); }
      else if (loginData.terms_version !== CUSTOMER_TERMS_VERSION) { setTermsAccepted(false); setMode('terms-update'); }
      else {
        setMode('portal');
        if (Capacitor.isNativePlatform()) {
          try {
            const { data: authState } = await customerAuth.auth.getSession();
            if (authState.session?.access_token) {
              const status = await getAccountBiometricStatus(authState.session.access_token);
              let localAlias = '';
              try { localAlias = localStorage.getItem('cp_biometric_alias_customer') || ''; } catch {}
              if (!status.enrolled || !status.keyAlias || localAlias !== status.keyAlias) setShowBiometricSetup(true);
            }
          } catch { /* Password sign-in remains successful if optional biometric setup is unavailable. */ }
        }
      }
    } finally { setBusy(false); }
  };

  const submitBiometricLogin = async () => {
    const loginToken = directEntry ? username.trim() : accountToken;
    if (!loginToken) { setErrorMessage('INVALID_CREDENTIALS'); return; }
    setBiometricBusy(true); setError('');
    try {
      const result = await loginWithAccountBiometric('customer', loginToken);
      const session = result.session as { access_token: string; refresh_token: string } | undefined;
      if (!session?.access_token || !session.refresh_token) throw new Error('BIOMETRIC_SESSION_UNAVAILABLE');
      const sessionError = await setCustomerSession(session);
      if (sessionError) throw new Error(sessionError);
      const verified = await callCustomerAccount<{ customer_qr_token?: string; customer_code?: string | null; session_expires_at?: string; must_change_password?: boolean; terms_version?: string | null; auth_provider?: EntryStatus['auth_provider'] }>(
        'verify-session', { token: loginToken }, session.access_token,
      );
      if (verified.error || !verified.data) throw new Error(verified.error || 'BIOMETRIC_SESSION_UNAVAILABLE');
      if (directEntry) setAccountToken(loginToken);
      const resolvedToken = typeof verified.data.customer_qr_token === 'string' && verified.data.customer_qr_token.length >= 24
        ? verified.data.customer_qr_token : loginToken;
      const customerLoginIdentifier = verified.data.customer_code || loginToken;
      if (savedCustomerAccounts.some((account) => account.token === loginToken) && customerLoginIdentifier !== loginToken) {
        setSavedCustomerAccounts(saveCustomerAccount({ token: customerLoginIdentifier, label: entry?.customer_name || customerLoginIdentifier }));
      }
      setPortalToken(resolvedToken);
      try { localStorage.setItem(portalTokenCacheKey(loginToken), resolvedToken); localStorage.setItem('last_customer_token', resolvedToken); } catch {}
      await saveSessionExpiry(loginToken, verified.data.session_expires_at || result.session_expires_at);
      if (resolvedToken !== loginToken) await saveSessionExpiry(resolvedToken, verified.data.session_expires_at || result.session_expires_at);
      setEntry((current) => current ? { ...current, terms_version: verified.data?.terms_version ?? current.terms_version, auth_provider: verified.data?.auth_provider ?? current.auth_provider } : current);
      setPassword(''); setMessage('');
      if (verified.data.must_change_password) { setMode('force-change'); setMessage(t('تمت الموافقة على طلب إعادة تعيين كلمة المرور. عيّن كلمة مرور جديدة للمتابعة.', 'Your password reset request was approved. Set a new password to continue.')); }
      else if (verified.data.terms_version !== CUSTOMER_TERMS_VERSION) { setTermsAccepted(false); setMode('terms-update'); }
      else setMode('portal');
    } catch (e) {
      const code = e instanceof Error ? e.message : 'BIOMETRIC_LOGIN_FAILED';
      setError((code === 'BIOMETRIC_NOT_ENROLLED' || code === 'BIOMETRIC_UNAVAILABLE')
        ? t('لم تُفعّل البصمة لهذا الحساب بعد. سجّل الدخول بكلمة السر أولًا.', 'Fingerprint sign-in is not enabled for this account yet. Sign in with your password first.')
        : code === 'BIOMETRIC_CANCELLED'
          ? t('تم إلغاء التحقق بالبصمة.', 'Biometric verification was cancelled.')
          : code === 'STALE_BIOMETRIC_SESSION'
            ? t('ما زال النظام ينهي جلسة الدخول السابقة. انتظر لحظة ثم حاول مجددًا.', 'The previous sign-in session is still being finalized. Wait a moment and try again.')
            : code === 'BIOMETRIC_PROOF_INVALID'
              ? t('مفتاح البصمة لم يعد صالحًا. سجّل الدخول بكلمة السر ثم فعّل البصمة مجددًا.', 'This fingerprint key is no longer valid. Sign in with your password and enable fingerprint again.')
              : code === 'BIOMETRIC_SESSION_UNAVAILABLE' || code === 'BIOMETRIC_SERVICE_UNAVAILABLE'
                ? t('خدمة الدخول الآمن غير متاحة مؤقتًا. يمكنك الدخول بكلمة السر.', 'Secure sign-in is temporarily unavailable. You can use your password.')
                : t('تعذّر الدخول بالبصمة. استخدم كلمة السر أو أعد تفعيل البصمة.', 'Biometric sign-in failed. Use your password or enable biometrics again.'));
    } finally { setBiometricBusy(false); }
  };

  const enableBiometric = async () => {
    setBiometricBusy(true); setError('');
    try {
      const { data } = await customerAuth.auth.getSession();
      if (!data.session?.access_token) throw new Error('AUTH_REQUIRED');
      await enrollAccountBiometric(data.session.access_token, 'ChargerPoint customer');
      setShowBiometricSetup(false);
      setMessage(t('تم تفعيل الدخول بالبصمة وربطها بهذا الحساب على هذا الجهاز.', 'Fingerprint sign-in is now enabled for this account on this device.'));
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      setError(code === 'BIOMETRIC_NOT_AVAILABLE'
        ? t('هذا الجهاز لا يدعم البصمة القوية أو لم يتم إعدادها في إعدادات الجهاز.', 'Strong biometrics are unavailable or not configured on this device.')
        : t('لم نتمكن من تفعيل البصمة. يمكنك المتابعة بكلمة السر والمحاولة لاحقًا.', 'Fingerprint setup failed. You can continue with your password and try again later.'));
    } finally { setBiometricBusy(false); }
  };

  const submitTermsUpdate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!termsAccepted) { setErrorMessage('TERMS_REQUIRED'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await callCustomerAccount<{ terms_version?: string }>('accept-terms', {
        token: accountToken, termsAccepted: true, termsVersion: CUSTOMER_TERMS_VERSION,
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
      const redirectTo = new URL('/c/' + encodeURIComponent(accountToken), window.location.origin);
      redirectTo.searchParams.set('customer_recovery', '1');
      const result = await callCustomerAccount(action, {
        token: accountToken, redirectTo: redirectTo.toString(),
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
    clearCachedCustomerPortalData(accountToken);
    clearCachedCustomerPortalData(portalToken);
    localStorage.removeItem(sessionExpiryKey(accountToken));
    localStorage.removeItem(sessionExpiryKey(portalToken));
    try {
      const remembered = localStorage.getItem('last_customer_token');
      if (remembered === accountToken || remembered === portalToken) localStorage.removeItem('last_customer_token');
    } catch {}
    setEntry((current) => current ? { ...current, activated: true } : current);
    setError('');
    setMessage('');
    if (Capacitor.isNativePlatform()) {
      window.location.replace('/public/about');
      return;
    }
    setMode('login');
    setUsername('');
    setPassword('');
    setShowSavedCustomerAccounts(directEntry && savedCustomerAccounts.length > 0);
  };

  if (mode === 'portal') {
    return (
      <div className="relative">
        {showBiometricSetup && (
          <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="customer-biometric-title" dir={isAr ? 'rtl' : 'ltr'}>
            <div className="w-full max-w-sm space-y-4 rounded-3xl border border-[#b9d9d8] bg-[#f7fbfa] p-6 text-center text-[#244b55] shadow-2xl dark:border-[#2b5267] dark:bg-[#0b2935] dark:text-[#daf1de]">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#1a8a94]/10 text-[#1a8a94]"><ShieldCheck className="h-7 w-7" /></div>
              <h2 id="customer-biometric-title" className="text-lg font-extrabold">{t('تفعيل الدخول بالبصمة؟', 'Enable fingerprint sign-in?')}</h2>
              <p className="text-sm leading-6 text-[#5d7782] dark:text-[#9bb8bf]">{t('ستبقى كلمة السر متاحة دائمًا. تُحفظ البصمة على جهازك فقط، ويتحقق الخادم من توقيع تشفيري مربوط بهذا الحساب.', 'Your password will always remain available. Your fingerprint stays on the device; the server verifies a cryptographic signature bound to this account.')}</p>
              {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{error}</p>}
              <button type="button" disabled={biometricBusy} onClick={() => void enableBiometric()} className="cp-auth__btn">{biometricBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}{t('تفعيل البصمة', 'Enable fingerprint')}</button>
              <button type="button" disabled={biometricBusy} onClick={() => { setShowBiometricSetup(false); setError(''); }} className="w-full rounded-xl border border-[#b9d9d8] px-4 py-3 text-sm font-semibold text-[#5d7782] dark:border-[#2b5267] dark:text-[#9bb8bf]">{t('ليس الآن، سأستخدم كلمة السر', 'Not now, I’ll use my password')}</button>
            </div>
          </div>
        )}
        {message && <p role="status" className="mx-auto max-w-3xl px-4 pt-2 text-sm text-[#9a6712] dark:text-slate-200">{message}</p>}
        <PublicCustomerPortalPage token={portalToken} onLogout={() => void logout()} />
        {pendingRememberCustomerAccount && (
          <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true" aria-labelledby="remember-customer-title" dir="rtl">
            <div className="w-full max-w-sm space-y-4 rounded-3xl border border-[#b9d9d8] bg-[#f7fbfa] p-5 text-[#244b55] shadow-2xl dark:border-[#2b5267] dark:bg-[#0b2935] dark:text-[#daf1de]">
              <div className="text-center">
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-[#1a8a94]/10 text-[#1a8a94]"><ShieldCheck className="h-6 w-6" /></div>
                <h2 id="remember-customer-title" className="mt-3 text-base font-extrabold">{t('حفظ تسجيل الدخول؟', 'Save this account?')}</h2>
                <p className="mt-2 text-sm leading-6 text-[#5d7782] dark:text-[#9bb8bf]">{t('احفظ هذا الحساب على هذا الجهاز لتسهيل الدخول لاحقًا. لن نحفظ كلمة المرور، وستحتاج لإدخالها كل مرة.', 'Save this account on this device for quicker sign-in. Your password will never be saved; you must enter it each time.')}</p>
                <p className="mt-2 truncate text-sm font-bold">{pendingRememberCustomerAccount.label}</p>
              </div>
              <button type="button" onClick={() => {
                setSavedCustomerAccounts(saveCustomerAccount(pendingRememberCustomerAccount));
                setShowSavedCustomerAccounts(false);
                setPendingRememberCustomerAccount(null);
              }} className="cp-auth__btn">{t('نعم، احفظ الحساب', 'Yes, save account')}</button>
              <button type="button" onClick={() => setPendingRememberCustomerAccount(null)} className="w-full rounded-xl border border-[#b9d9d8] px-4 py-3 text-sm font-semibold text-[#5d7782] dark:border-[#2b5267] dark:text-[#9bb8bf]">{t('ليس الآن', 'Not now')}</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  const showTerms = mode === 'activate';
  const showPasswordForm = mode === 'activate' || mode === 'force-change' || mode === 'recovery';
  const title = mode === 'activate' || mode === 'login'
    ? (entry?.customer_name
      ? t('أهلاً بعودتك، ', 'Welcome back, ') + entry.customer_name
      : t('أهلاً بعودتك', 'Welcome back'))
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

  const eyeToggle = (
    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute inset-y-0 end-2 my-auto grid h-9 w-9 place-items-center rounded-full text-[#5d7782] transition hover:bg-[#1a8a94]/10 dark:text-[#9bb8bf]" aria-label={showPassword ? t('إخفاء كلمة السر', 'Hide password') : t('إظهار كلمة السر', 'Show password')}>
      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  );
  const nextArrow = isAr ? <ArrowLeft className="h-4 w-4 transition group-hover:-translate-x-1" /> : <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />;
  const strength = passwordStrength(password);
  const strengthPercent = Math.round((strength / 4) * 100);
  const strengthColor = password.length === 0 ? 'text-[#8a9a92] dark:text-[#9bb8bf]' : strength <= 1 ? 'text-[#c45d51]' : strength === 2 ? 'text-[#c39a49]' : strength === 3 ? 'text-[#82a85f]' : 'text-[#398567]';
  const subtitle = mode === 'login' || mode === 'activate'
    ? t('أدخل بيانات حسابك للمتابعة بأمان.', 'Enter your account details to continue securely.')
      : mode === 'forgot'
        ? t('اختر الطريقة المناسبة لاستعادة كلمة السر. لن نكشف عن بيانات الحساب.', 'Choose a recovery method. We never reveal private account details.')
        : mode === 'terms-update'
          ? t('راجع الشروط المحدّثة قبل متابعة حسابك.', 'Review the updated terms before continuing.')
          : mode === 'unavailable'
            ? t('تحقق من الاتصال أو افتح رمز QR الصحيح ثم حاول مرة أخرى.', 'Check your connection or open the correct QR code, then try again.')
            : t('أكمل الخطوة التالية لحماية حسابك ومتابعة طلباتك.', 'Complete the next step to protect your account and continue to your orders.');

  return (
    <main dir={isAr ? 'rtl' : 'ltr'} className="cp-auth flex flex-col">
      <CustomerAuthClipDefs />
      <div aria-hidden="true" className="cp-auth__backdrop"><CustomerAuthScene uid="cp-bg" /></div>
      <span aria-hidden="true" className="cp-auth__blob cp-auth__blob--tl" />
      <span aria-hidden="true" className="cp-auth__blob cp-auth__blob--br" />

      <header className="mx-auto flex w-full max-w-[1080px] items-center justify-between gap-4 px-4 py-4 sm:py-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-white/95 shadow-md dark:bg-[#0c2e3a]">
            <AppLogo size={30} variant="auto" />
          </div>
          <div className="min-w-0 text-white">
            <p className="truncate text-[15px] font-extrabold">{t('نقطة الشحن', 'Charging Point')}</p>
            <p className="mt-0.5 text-[11px] font-medium tracking-[0.12em] text-white/75">{t('حسابك وخدمات الشحن', 'YOUR ACCOUNT & CHARGING SERVICES')}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={() => setLocale(isAr ? 'en' : 'ar')} className="cp-auth__pill">{isAr ? 'English' : 'العربية'}</button>
          <button type="button" onClick={toggleTheme} className="cp-auth__pill !px-0" aria-label={t('تغيير المظهر', 'Toggle appearance')}>{resolvedTheme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</button>
        </div>
      </header>

      {mode === 'force-change' && <div role="status" aria-live="polite" className="cp-reset-approved-toast" dir={isAr ? 'rtl' : 'ltr'}>
        <CheckCircle2 className="h-5 w-5 shrink-0" />
        <div><p className="font-bold">{t('تمت الموافقة على طلب إعادة تعيين كلمة المرور', 'Your password-reset request was approved')}</p><p className="mt-1 text-sm">{t('غيّر كلمة المرور الآن للمتابعة إلى حسابك.', 'Change your password now to continue to your account.')}</p></div>
      </div>}
      <div className="flex flex-1 items-center px-4 pb-8 pt-2 sm:pb-12">
        <section className="cp-auth__card">
          <div className="relative">
            <div className="cp-auth-art"><CustomerAuthScene uid="cp-card" /></div>
            <div className="pointer-events-none absolute inset-x-0 top-[9%] z-[2] hidden px-10 text-white lg:block" style={{ textShadow: '0 2px 18px rgba(4,34,44,.6)' }}>
              <h2 className="max-w-[14ch] text-[clamp(1.6rem,2.6vw,2.3rem)] font-extrabold leading-[1.2]">{visualTitle}</h2>
              <p className="mt-2 max-w-[32ch] text-sm leading-7 text-white/90">{visualDescription}</p>
            </div>
          </div>

          <div className="cp-auth__form">
            <div className="mx-auto w-full max-w-[400px]">
              <h1 className="cp-auth__title">{title}</h1>
              <p className="cp-auth__sub">{subtitle}</p>

              <div className="mt-6">
                {error && <div role="alert" className="mb-4 flex items-start gap-2.5 rounded-2xl border border-[#efc7c0] bg-[#fff1ee] px-4 py-3 text-sm leading-6 text-[#963f35] dark:border-[#71313c] dark:bg-[#301b22] dark:text-[#fecaca]"><AlertTriangle className="mt-1 h-4 w-4 shrink-0" />{error}</div>}
                {message && mode !== 'force-change' && <div role="status" className="mb-4 flex items-start gap-2.5 rounded-2xl border border-[#b9e0dd] bg-[#e9f7f6] px-4 py-3 text-sm leading-6 text-[#146069] dark:border-[#2b5267] dark:bg-[#142b38] dark:text-[#a8dff5]"><CheckCircle2 className="mt-1 h-4 w-4 shrink-0" />{message}</div>}

                {mode === 'loading' ? (
                  <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-[#5d7782] dark:text-[#9bb8bf]" role="status">
                    <LoaderCircle className="h-7 w-7 animate-spin text-[#e8743b]" aria-hidden="true" />
                    <span className="sr-only">{t('جارٍ التحقق من الحساب', 'Verifying account')}</span>
                  </div>
                ) : mode === 'unavailable' ? (
                  <div className="space-y-3">
                    <button type="button" onClick={() => { initialized.current = false; void loadEntry(); }} className="cp-auth__btn group">
                      {t('إعادة المحاولة', 'Try again')} {nextArrow}
                    </button>
                    {!customerIdFromQuery && !orderQrToken && token !== 'portal' && (
                      <button type="button" onClick={() => window.location.assign('/c/portal')} className="w-full rounded-xl border border-[#b9d9d8] px-4 py-3 text-sm font-bold text-[#146069] transition hover:bg-[#e9f7f6] dark:border-[#2b5267] dark:text-[#a8dff5] dark:hover:bg-[#142b38]">
                        {t('الدخول باسم المستخدم وكلمة المرور', 'Sign in with username and password')}
                      </button>
                    )}
                  </div>
                ) : mode === 'terms-update' ? (
                  <form className="space-y-5" onSubmit={(event) => void submitTermsUpdate(event)}>
                    <div className="cp-auth__chip text-sm leading-7">{t('راجع الشروط والأحكام وسياسة استخدام حساب العميل. الموافقة لا تغيّر أي بيانات مالية.', 'Review the customer account terms and usage policy. Accepting them does not change any financial records.')}</div>
                    <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} className="mt-1 h-4 w-4 accent-[#1a8a94]" /><span>{t('أوافق على الشروط والأحكام المحدّثة.', 'I accept the updated terms and conditions.')}</span></label>
                    <button disabled={busy || !termsAccepted} type="submit" className="cp-auth__btn"><ShieldCheck className="h-4 w-4" />{busy ? t('جارٍ الحفظ…', 'Saving…') : t('الموافقة والمتابعة', 'Accept and continue')}</button>
                  </form>
                ) : showPasswordForm ? (
                  <form className="space-y-4" onSubmit={(event) => {
                    if (mode === 'activate') void submitActivation(event);
                    else { event.preventDefault(); void finishPasswordChange(mode === 'recovery'); }
                  }}>
                    <label className="cp-auth__label">{t('كلمة المرور الجديدة', 'New password')}
                      <div className="relative">
                        <input required minLength={8} maxLength={128} type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" className="cp-auth__input !pe-12" placeholder={t('8 أحرف على الأقل', 'At least 8 characters')} />
                        {eyeToggle}
                      </div>
                    </label>

                    <div aria-live="polite" className="text-end text-sm font-semibold tabular-nums">
                      <span className={strengthColor}>{strengthPercent}%</span>
                    </div>

                    <label className="cp-auth__label">{t('تأكيد كلمة المرور', 'Confirm password')}
                      <input required minLength={8} maxLength={128} type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" className="cp-auth__input" placeholder={t('أعد كتابة كلمة السر', 'Enter the password again')} />
                    </label>

                    {showTerms && <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} className="mt-1 h-4 w-4 accent-[#1a8a94]" /><span>{t('أوافق على الشروط والأحكام وسياسة الخصوصية.', 'I agree to the terms, conditions, and privacy policy.')}</span></label>}
                    {mode === 'force-change' && <p className="rounded-2xl border border-[#f1d3b8] bg-[#fff4e8] p-3.5 text-sm leading-6 text-[#8a4a17] dark:border-[#75502e] dark:bg-[#302219] dark:text-[#ffd9b0]">{t('يجب تغيير كلمة السر المؤقتة قبل عرض بيانات الحساب.', 'You must change the temporary password before viewing account data.')}</p>}
                    <button disabled={busy} type="submit" className="cp-auth__btn group">
                      {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                      {busy ? t('جارٍ التحقق…', 'Please wait…') : mode === 'activate' ? t('إنشاء الحساب والدخول', 'Create account and sign in') : t('حفظ كلمة السر والمتابعة', 'Save password and continue')}
                      {!busy && nextArrow}
                    </button>
                    {(mode === 'force-change' || mode === 'recovery') && <button type="button" onClick={() => void logout()} className="w-full py-2 text-sm font-semibold text-[#5d7782] transition hover:text-[#e8743b] dark:text-[#9bb8bf]">{t('تسجيل الخروج', 'Sign out')}</button>}
                  </form>
                ) : mode === 'login' ? (
                  directEntry && showSavedCustomerAccounts && savedCustomerAccounts.length > 0 ? (
                    <div className="space-y-3" data-testid="saved-customer-accounts">
                      <p className="text-sm font-bold text-[#244b55] dark:text-[#daf1de]">{t('اختر حسابًا محفوظًا', 'Choose a saved account')}</p>
                      {savedCustomerAccounts.map((account) => (
                        <button key={account.token} type="button" onClick={() => { setUsername(account.token); setSelectedSavedCustomerAccountLabel(account.label); setShowSavedCustomerAccounts(false); setError(''); setPassword(''); }}
                          className="flex w-full items-center gap-3 rounded-2xl border border-[#b9d9d8] bg-white/80 px-4 py-3 text-start transition hover:border-[#1a8a94] hover:bg-[#e9f7f6] dark:border-[#2b5267] dark:bg-[#0b2935] dark:hover:bg-[#142b38]">
                          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#1a8a94]/10 text-[#1a8a94]"><ShieldCheck className="h-5 w-5" /></span>
                          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold">{account.label}</span><span className="mt-0.5 block text-xs text-[#5d7782] dark:text-[#9bb8bf]">{t('كلمة المرور مطلوبة في كل دخول', 'Password required each time')}</span></span>
                          <ArrowLeft className="h-4 w-4 shrink-0 rtl:rotate-180" />
                        </button>
                      ))}
                      <button type="button" onClick={() => { setUsername(''); setPassword(''); setShowSavedCustomerAccounts(false); setError(''); }}
                        className="w-full rounded-xl border border-dashed border-[#b9d9d8] px-4 py-3 text-sm font-semibold text-[#5d7782] transition hover:border-[#1a8a94] dark:border-[#2b5267] dark:text-[#9bb8bf]">
                        {t('الدخول بحساب آخر', 'Sign in with another account')}
                      </button>
                    </div>
                  ) : (
                  <form className="space-y-4" onSubmit={(event) => void submitLogin(event)}>
                    {(customerIdFromQuery || directEntry) && !selectedSavedCustomerAccountLabel && (
                      <label className="cp-auth__label">{t('اسم المستخدم / رقم العميل', 'Username / Customer ID')}
                        <input value={directEntry ? username : customerIdFromQuery} onChange={directEntry ? (event) => setUsername(event.target.value) : undefined} readOnly={!directEntry} required={directEntry} maxLength={128} autoComplete="username" className="cp-auth__input" aria-label={t('اسم المستخدم / رقم العميل', 'Username / Customer ID')} placeholder={t('أدخل اسم المستخدم أو رقم العميل', 'Enter username or customer ID')} />
                      </label>
                    )}
                    {selectedSavedCustomerAccountLabel && <div className="cp-auth__chip !py-2.5"><span className="block truncate text-sm font-bold">{selectedSavedCustomerAccountLabel}</span><button type="button" className="ms-auto text-xs font-semibold text-[#146069] dark:text-[#a8dff5]" onClick={() => { setSelectedSavedCustomerAccountLabel(''); setUsername(''); }}>{t('تغيير الحساب', 'Change account')}</button></div>}
                    <label className="cp-auth__label">{t('كلمة السر', 'Password')}
                      <div className="relative">
                        <input required maxLength={128} type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" className="cp-auth__input !pe-12" placeholder={t('أدخل كلمة السر الخاصة بك', 'Enter your password')} />
                        {eyeToggle}
                      </div>
                    </label>
                    {Capacitor.isNativePlatform() && mode === 'login' && (
                      <button type="button" disabled={busy || biometricBusy} onClick={() => void submitBiometricLogin()} className="cp-auth__btn cp-auth__btn--ghost group">
                        {biometricBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
                        {biometricBusy ? t('جارٍ التحقق بالبصمة…', 'Verifying fingerprint…') : t('الدخول بالبصمة', 'Sign in with fingerprint')}
                      </button>
                    )}
                    <div className="flex justify-end text-xs">
                      <button type="button" onClick={() => { setError(''); setMessage(''); setMode('forgot'); }} className="cp-auth__link">{t('نسيت كلمة السر؟', 'Forgot password?')}</button>
                    </div>
                    <button disabled={busy} type="submit" className="cp-auth__btn group">
                      {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                      {busy ? t('جارٍ التحقق…', 'Checking…') : t('دخول إلى حسابي', 'Sign in to my account')}
                      {!busy && nextArrow}
                    </button>
                    {directEntry && savedCustomerAccounts.length > 0 && (
                      <button type="button" onClick={() => { setShowSavedCustomerAccounts(true); setUsername(''); setPassword(''); setError(''); }}
                        className="w-full py-2 text-sm font-semibold text-[#5d7782] transition hover:text-[#e8743b] dark:text-[#9bb8bf]">
                        {t('اختيار حساب محفوظ', 'Choose a saved account')}
                      </button>
                    )}
                  </form>
                  )
                ) : mode === 'forgot' ? (
                  <div className="space-y-3.5">
                    <div className="cp-auth__chip mb-4 items-start">
                      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-[#e8743b] dark:bg-[#0c2e3a]"><Mail className="h-5 w-5" /></div>
                      <p className="text-sm leading-6">{t('إذا كان بريدك الإلكتروني موثّقًا، يمكنك طلب رابط استعادة آمن. وإلا يمكنك إرسال طلب للإدارة.', 'If you have a verified email, you can request a secure reset link. Otherwise, you can send a request to the administrator.')}</p>
                    </div>
                    {entry?.email_recovery_available && <button type="button" disabled={busy} onClick={() => void submitForgot(true)} className="cp-auth__btn"><Mail className="h-4 w-4" />{busy ? t('جارٍ الإرسال…', 'Sending…') : t('إرسال رابط استعادة آمن', 'Send a secure recovery link')}</button>}
                    <button type="button" disabled={busy} onClick={() => void submitForgot(false)} className="cp-auth__btn cp-auth__btn--ghost"><ShieldCheck className="h-4 w-4" />{t('طلب إعادة التعيين من الإدارة', 'Request a reset from the administrator')}</button>
                    <button type="button" onClick={() => { setError(''); setMessage(''); setMode('login'); }} className="mt-1 flex w-full items-center justify-center gap-2 py-2 text-sm font-semibold text-[#5d7782] transition hover:text-[#e8743b] dark:text-[#9bb8bf]">{isAr ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}{t('العودة لتسجيل الدخول', 'Back to sign in')}</button>
                  </div>
                ) : null}
              </div>

              <div className="cp-auth__divider mt-7">
                <span className="flex items-center gap-1.5"><LockKeyhole className="h-3.5 w-3.5" />{t('جلسة محمية لمدة 7 أيام', 'Protected session · 7 days')}</span>
              </div>
              <p className="mt-3 text-center text-[11px] leading-5 text-[#5d7782] dark:text-[#9bb8bf]">{t('تبقى مسجلاً للدخول على هذا الجهاز لمدة تصل إلى 7 أيام. احرص على حماية كلمة المرور، وتجنب حفظها على الأجهزة المشتركة.', 'Stay signed in on this device for up to 7 days. Protect your password and avoid saving it on shared devices.')}</p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
};
