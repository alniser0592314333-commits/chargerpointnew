import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { AlertTriangle, ArrowLeft, Bell, CheckCircle2, CreditCard, Globe, History, Info, KeyRound, Moon, RefreshCw, ShieldCheck, Sun, Target, UserRound, Wallet, WifiOff } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { callCustomerAccount, customerAuth } from '../../services/customer/customerAuth';
import { startNativePushNotifications, stopNativePushNotifications } from '../../services/nativePushNotifications';
import { enrollAccountBiometric, getAccountBiometricStatus, isNativeBiometricAvailable } from '../../services/auth/accountBiometric';
import { AppLogo } from '../qr/AppLogo';
import { CustomerAuthScene } from './CustomerAuthScene';
import { useTheme } from '../../theme/themeContext';
import { config } from '../../config/env';
import { CustomerPortalNavigation, CustomerPortalMoreView, CustomerPortalTab } from './CustomerPortalNavigation';
import './customer-portal-dashboard.css';

const ReceiptTextFallback = () => <CreditCard size={17} aria-hidden="true" />;
const CalendarDaysFallback = () => <History size={18} aria-hidden="true" />;

type PortalOrderItem = {
  device_name_ar: string;
  device_name_en: string;
  has_charger: boolean;
  status: string;
  payment_status: string;
  total_minor: number;
  paid_minor: number;
  due_minor: number;
};
type PortalOrder = {
  order_number: number;
  created_at: string;
  status: string;
  total_minor: number;
  due_minor: number;
  items: PortalOrderItem[];
};
type PortalSubmission = {
  id?: string;
  submission_source?: 'ADMIN_MANUAL' | 'CUSTOMER_QR' | string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | string;
  payment_method: string;
  created_at: string;
  reviewed_at: string | null;
  amount_minor: number | null;
  note?: string | null;
  rejection_reason?: string | null;
};
type PortalGoal = {
  target_quantity: number;
  current_progress: number;
  status: string;
  expires_at: string | null;
  completed_at: string | null;
  bonus_minor: number | null;
  bonus_recorded: boolean;
};
type PortalData = {
  customer_name: string;
  customer_code: string;
  balance_minor: number;
  orders: PortalOrder[];
  payment_submissions: PortalSubmission[];
  goals: PortalGoal[];
  cached_at?: string;
};
type PortalLedgerEntry = {
  id: string;
  event_type: string;
  amount_minor: number;
  created_at: string;
  reference_id?: string | null;
  metadata?: Record<string, unknown> | null;
};
type PortalGoalRequest = {
  id: string;
  status: string;
  requested_target: number | null;
  created_at: string;
  reviewed_at: string | null;
  rejection_reason: string | null;
};
type PortalCustomerEvent = {
  id: string;
  event_type: string;
  request_id: string | null;
  is_read: boolean;
  created_at: string;
  payload?: Record<string, unknown> | null;
};
type PortalActivity = {
  ledger: PortalLedgerEntry[];
  goal_requests: PortalGoalRequest[];
  events: PortalCustomerEvent[];
  session: { created_at: string; expires_at: string } | null;
  last_login_at: string | null;
};
type PortalEventRow = { id: string; created_at: string; title: string; detail: string };

export interface PublicCustomerPortalPageProps { token: string; onLogout?: () => void }

const safeDate = (value: string | null | undefined, locale: string) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-PS' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
};
const money = (minor: number | null | undefined, locale: string) => {
  if (typeof minor !== 'number' || !Number.isFinite(minor)) return '—';
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-PS' : 'en-GB', { style: 'currency', currency: 'ILS', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100);
};

const portalCacheKey = (token: string) => 'cp_customer_portal_cache:' + token;
export const hasCachedCustomerPortalData = (token: string): boolean => readCachedPortalData(token) !== null;
export const clearCachedCustomerPortalData = (token: string): void => {
  try { localStorage.removeItem(portalCacheKey(token)); } catch {}
};
const readCachedPortalData = (token: string): PortalData | null => {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(portalCacheKey(token));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PortalData;
    return typeof parsed.customer_name === 'string' &&
      typeof parsed.customer_code === 'string' &&
      typeof parsed.balance_minor === 'number' &&
      Array.isArray(parsed.orders) &&
      Array.isArray(parsed.payment_submissions) &&
      Array.isArray(parsed.goals) ? parsed : null;
  } catch { return null; }
};


export const PublicCustomerPortalPage: React.FC<PublicCustomerPortalPageProps> = ({ token, onLogout }) => {
  const { locale, setLocale } = useI18n();
  const { resolvedTheme, toggleTheme } = useTheme();
  const isAr = locale === 'ar';

  useEffect(() => {
    void startNativePushNotifications(
      'customer',
      async () => (await customerAuth.auth.getSession()).data.session?.access_token ?? null,
      locale,
    );
  }, [locale, token]);

  const handleSignOut = async () => {
    await stopNativePushNotifications();
    onLogout?.();
  };
  const [data, setData] = useState<PortalData | null>(() => readCachedPortalData(token));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'invalid' | 'service' | null>(null);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [serverAvailable, setServerAvailable] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [refreshing, setRefreshing] = useState(false);
  const [offlineToastVisible, setOfflineToastVisible] = useState(false);
  const [offlineToastFading, setOfflineToastFading] = useState(false);
  const [showOfflineDot, setShowOfflineDot] = useState(false);
  const [notificationsMessage, setNotificationsMessage] = useState('');
  const [appVersion, setAppVersion] = useState(import.meta.env.VITE_APP_VERSION || '—');
  const initialPortalQuery = new URLSearchParams(window.location.search);
  const requestedTab = initialPortalQuery.get('tab');
  const initialTab: CustomerPortalTab = requestedTab === 'orders' || requestedTab === 'goals' || requestedTab === 'finance' || requestedTab === 'more'
    ? requestedTab : 'home';
  const [activeTab, setActiveTab] = useState<CustomerPortalTab>(initialTab);
  const notificationOrderNumber = initialPortalQuery.get('orderNumber') || '';
  const notificationOrderCreatedAt = initialPortalQuery.get('orderCreatedAt') || '';
  const [moreView, setMoreView] = useState<CustomerPortalMoreView>('profile');
  const [settingsSubpage, setSettingsSubpage] = useState<'main' | 'security' | 'about'>('main');
  const [activity, setActivity] = useState<PortalActivity | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState(false);
  const [seenNotificationIds, setSeenNotificationIds] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem('cp_customer_notifications_seen:' + token) || '[]');
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch { return []; }
  });
  const [actionMessage, setActionMessage] = useState('');
  const [goalRequestBusy, setGoalRequestBusy] = useState(false);
  const [resetRequestBusy, setResetRequestBusy] = useState(false);
  const [historyRequestStatus, setHistoryRequestStatus] = useState<string | null>(null);
  const [historyAccessExpiresAt, setHistoryAccessExpiresAt] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordChangeBusy, setPasswordChangeBusy] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnrolled, setBiometricEnrolled] = useState(false);
  const [showBiometricManager, setShowBiometricManager] = useState(false);
  const [biometricPassword, setBiometricPassword] = useState('');
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [biometricMessage, setBiometricMessage] = useState('');
  const outageActive = !online || (!serverAvailable && !loading);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let active = true;
    void CapacitorApp.getInfo().then((info) => {
      if (active && typeof info.version === 'string' && info.version.trim()) setAppVersion(info.version.trim());
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!outageActive) {
      setOfflineToastVisible(false);
      setOfflineToastFading(false);
      setShowOfflineDot(false);
      return;
    }
    setOfflineToastVisible(true);
    setOfflineToastFading(false);
    const fadeTimer = window.setTimeout(() => setOfflineToastFading(true), 2000);
    const hideTimer = window.setTimeout(() => {
      setOfflineToastVisible(false);
      setOfflineToastFading(false);
      setShowOfflineDot(true);
    }, 2300);
    return () => { window.clearTimeout(fadeTimer); window.clearTimeout(hideTimer); };
  }, [outageActive]);

  useEffect(() => {
    let active = true;
    if (!Capacitor.isNativePlatform()) return;
    void (async () => {
      const available = await isNativeBiometricAvailable();
      if (!active) return;
      setBiometricAvailable(available);
      const { data: authState } = await customerAuth.auth.getSession();
      if (authState.session?.access_token) {
        try {
          const status = await getAccountBiometricStatus(authState.session.access_token);
          if (active) setBiometricEnrolled(status.enrolled);
        } catch { /* Password sign-in remains available if biometric status is temporarily unavailable. */ }
      }
    })();
    return () => { active = false; };
  }, [token]);

  const saveCustomerBiometric = async (event: React.FormEvent) => {
    event.preventDefault();
    setBiometricBusy(true); setBiometricMessage('');
    try {
      if (!biometricAvailable) throw new Error('BIOMETRIC_NOT_AVAILABLE');
      const { data: current } = await customerAuth.auth.getSession();
      const currentUserId = current.session?.user?.id;
      const passwordForReauth = biometricPassword;
      if (!currentUserId) throw new Error('AUTH_REQUIRED');
      // Use the canonical customer-account login path so re-authentication also refreshes
      // the server-side single-device session binding; never create an unregistered Auth session.
      const reauth = await callCustomerAccount<{ session?: { access_token: string; refresh_token: string; user?: { id: string } } }>(
        'login', { token, password: passwordForReauth },
      );
      setBiometricPassword('');
      const verifiedSession = reauth.data?.session;
      if (reauth.error || !verifiedSession?.access_token || !verifiedSession.refresh_token ||
          (verifiedSession.user?.id && verifiedSession.user.id !== currentUserId)) throw new Error('INVALID_PASSWORD');
      const savedSession = await customerAuth.auth.setSession({
        access_token: verifiedSession.access_token,
        refresh_token: verifiedSession.refresh_token,
      });
      if (savedSession.error || !savedSession.data.session) throw new Error('AUTH_REQUIRED');
      await enrollAccountBiometric(savedSession.data.session.access_token, 'ChargerPoint customer', { password: passwordForReauth });
      setBiometricEnrolled(true);
      setShowBiometricManager(false);
      setBiometricMessage(isAr ? 'تم التحقق من كلمة المرور وتفعيل البصمة لهذا الحساب على هذا الجهاز.' : 'Password verified; fingerprint sign-in is enabled for this account on this device.');
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      setBiometricMessage(code === 'BIOMETRIC_NOT_AVAILABLE'
        ? (isAr ? 'هذا الجهاز لا يدعم البصمة القوية أو لم يتم إعدادها.' : 'Strong biometrics are unavailable or not configured on this device.')
        : code === 'INVALID_PASSWORD'
          ? (isAr ? 'كلمة المرور غير صحيحة.' : 'The password is incorrect.')
          : (isAr ? 'تعذر تغيير البصمة. تحقق من كلمة المرور والاتصال ثم حاول مجددًا.' : 'Could not change fingerprint. Check your password and connection, then try again.'));
    } finally { setBiometricBusy(false); }
  };
  const requestGeneration = useRef(0);
  const backgroundLoadInFlight = useRef(false);
  const portalVersionRef = useRef<{ token: string; version: string } | null>(null);
  const activityVersionRef = useRef<{ token: string; version: string } | null>(null);
  const activityRequestGeneration = useRef(0);

  const load = useCallback(async (manual = false, background = false) => {
    // Background refreshes are deliberately conservative; native push and foreground/focus events refresh sooner.
    // A single background read at a time keeps the newest verified snapshot eligible to render.
    if (background && backgroundLoadInFlight.current) return;
    if (background) backgroundLoadInFlight.current = true;
    const requestId = ++requestGeneration.current;
    if (manual) setRefreshing(true); else if (!background) setLoading(true);
    if (!background) setError(null);
    // Never show a cached/local financial snapshot as if it were current.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setServerAvailable(false);
      const cached = readCachedPortalData(token);
      if (cached) { setData(cached); setError(null); }
      else if (!background) { setData(null); setError('service'); }
      if (!background) {
        setLoading(false);
        setRefreshing(false);
      }
      if (background) backgroundLoadInFlight.current = false;
      return;
    }
    try {
      const { data: responseResult, error: rpcError } = await callCustomerAccount<{
        data?: PortalData; unchanged?: boolean; version?: string;
      }>(
        'portal-data',
        {
          token,
          ...(portalVersionRef.current?.token === token
            ? { knownVersion: portalVersionRef.current.version }
            : {}),
        }
      );
      if (requestId !== requestGeneration.current) return;
      portalVersionRef.current = typeof responseResult?.version === 'string'
        ? { token, version: responseResult.version }
        : null;
      // The server has verified that the cached in-memory snapshot is unchanged.
      if (!rpcError && responseResult?.unchanged === true && responseResult.version) {
        if (requestId === requestGeneration.current) {
          setServerAvailable(true);
          setError(null);
        }
        return;
      }
      const response = responseResult?.data ?? null;
      // Ignore stale requests and never restore financial data after connectivity drops.
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setServerAvailable(false);
        const cached = readCachedPortalData(token);
        if (cached) { setData(cached); setError(null); }
        else setError('service');
        return;
      }
      if (rpcError === 'NETWORK_UNAVAILABLE') {
        setServerAvailable(false);
        const cached = readCachedPortalData(token);
        if (cached) { setData(cached); setError(null); }
        else { setData(null); setError('service'); }
      } else if (rpcError || !response) {
        setServerAvailable(false);
        setData(null);
        setError(rpcError ? 'service' : 'invalid');
      } else if (
        typeof response.customer_name !== 'string' ||
        typeof response.customer_code !== 'string' ||
        typeof response.balance_minor !== 'number' ||
        !Array.isArray(response.orders) ||
        !Array.isArray(response.payment_submissions) ||
        !Array.isArray(response.goals)
      ) {
        setServerAvailable(false);
        setData(null);
        setError('service');
      } else {
        const verifiedSnapshot: PortalData = { ...response, cached_at: new Date().toISOString() };
        setServerAvailable(true);
        setData(verifiedSnapshot);
        setError(null);
        try { localStorage.setItem(portalCacheKey(token), JSON.stringify(verifiedSnapshot)); } catch {}
      }
    } catch {
      if (requestId === requestGeneration.current) {
        setServerAvailable(false);
        if (!background) {
          const cached = readCachedPortalData(token);
          if (cached) { setData(cached); setError(null); }
          else { setData(null); setError('service'); }
        }
      }
    } finally {
      if (background) backgroundLoadInFlight.current = false;
      if (requestId === requestGeneration.current && !background) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [token]);

  const loadActivity = useCallback(async (quiet = false) => {
    if (!online || typeof navigator !== 'undefined' && !navigator.onLine) return;
    const activityRequestId = ++activityRequestGeneration.current;
    if (!quiet) setActivityLoading(true);
    setActivityError(false);
    try {
      const { data: response, error: requestError } = await callCustomerAccount<PortalActivity & {
        unchanged?: boolean; version?: string;
      }>(
        'customer-activity',
        {
          token,
          ...(activityVersionRef.current?.token === token
            ? { knownVersion: activityVersionRef.current.version }
            : {}),
        },
      );
      if (activityRequestId !== activityRequestGeneration.current) return;
      activityVersionRef.current = typeof response?.version === 'string'
        ? { token, version: response.version }
        : null;
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setActivityError(true);
        return;
      }
      if (!requestError && response?.unchanged === true && response.version) {
        setActivityError(false);
        return;
      }
      if (requestError || !response || !Array.isArray(response.ledger) ||
          !Array.isArray(response.goal_requests) || !Array.isArray(response.events)) {
        setActivityError(true);
        return;
      }
      setActivity({
        ledger: response.ledger,
        goal_requests: response.goal_requests,
        events: response.events,
        session: response.session ?? null,
        last_login_at: response.last_login_at ?? null,
      });
      setActivityError(false);
    } catch {
      setActivityError(true);
    } finally {
      if (!quiet) setActivityLoading(false);
    }
  }, [token, online]);

  useEffect(() => {
    if (data && online) void loadActivity();
  }, [data?.customer_code, online, loadActivity]);

  // A foreground native push is also a data-invalidation signal. This updates
  // the open customer page immediately after server-side approval/delivery while
  // the existing notification listener continues to display the OS notification.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let listener: { remove: () => Promise<void> } | null = null;
    let disposed = false;
    void PushNotifications.addListener('pushNotificationReceived', () => {
      if (disposed || document.visibilityState !== 'visible' || navigator.onLine === false) return;
      void load(false, true);
      void loadActivity(true);
    }).then((handle) => {
      if (disposed) void handle.remove();
      else listener = handle;
    }).catch((error) => {
      console.warn('Customer portal push refresh listener unavailable; periodic refresh remains active.', error);
    });
    return () => {
      disposed = true;
      if (listener) void listener.remove();
    };
  }, [load, loadActivity]);

  // Keep the customer read model current on every tab, not only Goals.
  // The secure customer-account endpoint remains the sole data path; this avoids
  // granting browser access to financial tables merely to subscribe to Realtime.
  useEffect(() => {
    if (!online) return;
    const refreshVisiblePortal = () => {
      if (document.visibilityState !== 'visible' || navigator.onLine === false) return;
      void load(false, true);
    };
    const interval = window.setInterval(refreshVisiblePortal, 15000);
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') refreshVisiblePortal(); };
    window.addEventListener('focus', refreshVisiblePortal);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshVisiblePortal);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [online, data?.customer_code, load, loadActivity]);

  // Financial activity is larger and changes less often than the portal status.
  // Refresh it separately to avoid downloading the activity ledger on every portal poll.
  useEffect(() => {
    if (!online || !data) return;
    const refreshActivity = () => {
      if (document.visibilityState === 'visible' && navigator.onLine !== false) void loadActivity(true);
    };
    const interval = window.setInterval(refreshActivity, 30000);
    return () => window.clearInterval(interval);
  }, [online, data?.customer_code, loadActivity]);

  const markNotificationsSeen = () => {
    const ids = eventRows.map((event) => event.id);
    setSeenNotificationIds(ids);
    try { window.localStorage.setItem('cp_customer_notifications_seen:' + token, JSON.stringify(ids)); } catch {}
  };

  const markAllNotificationsRead = async () => {
    if (!online || !serverAvailable || activityLoading) return;
    setNotificationsMessage('');
    const result = await callCustomerAccount<{ updated_count?: number }>('mark-notifications-read', { token });
    if (result.error) {
      setNotificationsMessage(isAr ? 'تعذّر تحديث حالة الإشعارات على الخادم. حاول مرة أخرى.' : 'Could not update notification read status on the server. Please try again.');
      return;
    }
    markNotificationsSeen();
    setNotificationsMessage(isAr ? 'تم تعليم الإشعارات كمقروءة.' : 'Notifications marked as read.');
    await loadActivity(true);
  };

  const requestGoal = async () => {
    if (!online || !serverAvailable || goalRequestBusy) return;
    setGoalRequestBusy(true);
    setActionMessage('');
    const { data: response, error: requestError } = await callCustomerAccount<{ already_pending?: boolean }>(
      'request-goal', { token },
    );
    if (requestError) {
      setActionMessage(requestError === 'GOAL_ALREADY_ACTIVE'
        ? (isAr ? 'لديك هدف فعّال بالفعل.' : 'You already have an active goal.')
        : (isAr ? 'تعذّر إرسال طلب الهدف. حاول مرة أخرى.' : 'The goal request could not be sent. Please try again.'));
    } else {
      setActionMessage(response?.already_pending
        ? (isAr ? 'لديك طلب هدف بانتظار مراجعة الإدارة بالفعل.' : 'You already have a goal request awaiting administrator review.')
        : (isAr ? 'تم إرسال طلب إنشاء الهدف للإدارة.' : 'Your goal request has been sent to the administrator.'));
      await loadActivity();
    }
    setGoalRequestBusy(false);
  };

  const changePortalPassword = async () => {
    if (!online || !serverAvailable || passwordChangeBusy) return;
    const common = new Set(['password', 'password123', '12345678', 'qwerty123', '11111111', '123456789', '1234567890', 'qwertyuiop', 'abc12345', 'letmein123', 'iloveyou', 'admin123', 'welcome1', 'monkey123', 'dragon123']);
    if (newPassword.length < 8 || newPassword.length > 128 || common.has(newPassword.trim().toLowerCase()) || /^(.)\1{7,}$/.test(newPassword)) {
      setActionMessage(isAr ? 'استخدم كلمة مرور من 8 أحرف على الأقل، وتجنب كلمات المرور الشائعة.' : 'Use at least 8 characters and avoid common passwords.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setActionMessage(isAr ? 'كلمتا المرور غير متطابقتين.' : 'The passwords do not match.');
      return;
    }
    setPasswordChangeBusy(true);
    setActionMessage('');
    try {
      const { error: updateError } = await customerAuth.auth.updateUser({ password: newPassword });
      if (updateError) {
        setActionMessage(isAr ? 'تعذّر تغيير كلمة المرور. تحقق من الاتصال وحاول مجددًا.' : 'Password could not be changed. Check your connection and try again.');
        return;
      }
      const { error: completionError } = await callCustomerAccount('complete-password-change', { token });
      setNewPassword('');
      setConfirmNewPassword('');
      setShowPasswordChange(false);
      if (completionError) {
        setActionMessage(isAr ? 'تم تحديث كلمة المرور، لكن تعذّر تأكيد الجلسة. سجّل الخروج ثم الدخول مجددًا.' : 'The password was updated, but the session could not be confirmed. Sign out and sign in again.');
      } else {
        setActionMessage(isAr ? 'تم تغيير كلمة المرور بنجاح.' : 'Your password was changed successfully.');
        await loadActivity();
      }
    } catch {
      setActionMessage(isAr ? 'تعذّر إكمال تغيير كلمة المرور. حاول مرة أخرى.' : 'Could not complete the password change. Please try again.');
    } finally {
      setPasswordChangeBusy(false);
    }
  };

  const requestPasswordReset = async () => {
    if (!online || !serverAvailable || resetRequestBusy) return;
    setResetRequestBusy(true);
    setActionMessage('');
    const { error: requestError } = await callCustomerAccount('request-reset', { token });
    setActionMessage(requestError
      ? (isAr ? 'تعذّر إرسال طلب إعادة تعيين كلمة المرور. حاول مرة أخرى.' : 'Could not send the password-reset request. Please try again.')
      : (isAr ? 'تم إرسال طلب إعادة تعيين كلمة المرور للإدارة، وهو بانتظار الموافقة.' : 'Your password-reset request was sent and is awaiting administrator approval.'));
    if (!requestError) await loadActivity();
    setResetRequestBusy(false);
  };

  useEffect(() => {
    void load();
    const onOnline = () => { setOnline(true); void load(); };
    const onOffline = () => {
      requestGeneration.current += 1;
      setOnline(false);
      setServerAvailable(false);
      setActivity(null);
      setActivityError(true);
      const cached = readCachedPortalData(token);
      if (cached) { setData(cached); setError(null); }
      else { setData(null); setError('service'); }
      setLoading(false);
      setRefreshing(false);
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      requestGeneration.current += 1;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [load]);

  const balanceLabel = useMemo(() => {
    if (!data) return '—';
    if (data.balance_minor < 0) return isAr ? 'المبلغ المستحق عليك' : 'Amount you owe';
    if (data.balance_minor > 0) return isAr ? 'رصيد دائن لصالحك' : 'Credit in your favor';
    return isAr ? 'الرصيد متعادل' : 'Account settled';
  }, [data, isAr]);

  const statusLabel = (status: string) => {
    const map: Record<string, [string, string]> = {
      'تم الشحن': ['تم الشحن', 'Charged'], 'قيد الشحن': ['قيد الشحن', 'Charging'],
      CHARGED: ['تم الشحن', 'Charged'], CHARGING: ['قيد الشحن', 'Charging'],
      charging: ['قيد الشحن', 'Charging'], DELIVERED: ['تم التسليم', 'Delivered'],
      delivered: ['تم التسليم', 'Delivered'], CANCELLED: ['ملغي', 'Cancelled'],
      cancelled: ['ملغي', 'Cancelled'], PENDING: ['بانتظار المراجعة', 'Pending review'],
      APPROVED: ['مقبول', 'Approved'], REJECTED: ['مرفوض', 'Rejected'],
      PAID: ['مدفوع', 'Paid'], PARTIAL: ['مدفوع جزئياً', 'Partially paid'],
      PARTIALLY_PAID: ['مدفوع جزئياً', 'Partially paid'],
      UNPAID: ['غير مدفوع', 'Unpaid'], NOT_DUE: ['غير مستحق حالياً', 'Not due'],
      ACTIVE: ['فعّال', 'Active'], COMPLETED: ['مكتمل', 'Completed'], EXPIRED: ['منتهي', 'Expired'],
    };
    return map[status]?.[isAr ? 0 : 1] ?? status;
  };

  const pendingReviewMinor = (data?.payment_submissions || [])
    .filter((submission) => submission.status.toUpperCase() === 'PENDING')
    .reduce((total, submission) => total + (submission.amount_minor ?? 0), 0);
  useEffect(() => {
    if (activeTab !== 'orders' || !data || !notificationOrderNumber) return;
    const target = [...data.orders].find((order) =>
      String(order.order_number) === notificationOrderNumber &&
      (!notificationOrderCreatedAt || order.created_at === notificationOrderCreatedAt)
    );
    if (!target) return;
    const timer = window.setTimeout(() => {
      document.getElementById('customer-order-' + target.order_number + '-' + target.created_at.replace(/[^a-zA-Z0-9]/g, ''))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [activeTab, data, notificationOrderNumber, notificationOrderCreatedAt]);

  const sortedPortalOrders = [...(data?.orders || [])].sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  const featuredOrder = sortedPortalOrders.find((order) =>
    !['DELIVERED', 'delivered', 'CANCELLED', 'cancelled'].includes(order.status)
  ) || sortedPortalOrders[0];
  const activeGoal = data?.goals.find((goal) => goal.status.toUpperCase() === 'ACTIVE');
  const pendingGoalRequest = activity?.goal_requests.find((request) => request.status.toUpperCase() === 'PENDING');
  const translateLedgerType = (type: string) => {
    const labels: Record<string, [string, string]> = {
      CHARGE: ['رسوم شحن', 'Charging charge'],
      ORDER_ITEM_CHARGE: ['رسوم جهاز', 'Device charge'],
      PAYMENT: ['دفعة معتمدة', 'Approved payment'],
      CREDIT: ['رصيد دائن', 'Credit'],
      CREDIT_USED: ['استخدام رصيد', 'Credit used'],
      DISCOUNT: ['خصم', 'Discount'],
      BONUS: ['مكافأة هدف', 'Goal reward'],
      REFUND: ['استرداد', 'Refund'],
      REVERSAL: ['عكس حركة', 'Reversal'],
      ADJUSTMENT: ['تسوية مالية', 'Adjustment'],
      CREDIT_ADJUSTMENT: ['تعديل رصيد', 'Credit adjustment'],
      CORRECTION: ['تصحيح مالي', 'Financial correction'],
    };
    return labels[type]?.[isAr ? 0 : 1] || (isAr ? 'حركة مالية' : 'Financial movement');
  };
  const translateAccountEvent = (type: string) => {
    const labels: Record<string, [string, string]> = {
      RESET_REQUESTED: ['تم إرسال طلب إعادة تعيين كلمة المرور', 'Password reset requested'],
      TEMP_PASSWORD_ISSUED: ['وافقت الإدارة على إعادة تعيين كلمة المرور', 'Password reset approved'],
      PASSWORD_CHANGED: ['تم تغيير كلمة المرور', 'Password changed'],
      TERMS_ACCEPTED: ['تم تحديث الموافقة على الشروط', 'Terms acceptance updated'],
      EMAIL_RESET_SENT: ['تم إرسال رابط استعادة كلمة المرور', 'Password recovery email sent'],
      GOAL_REQUESTED: ['تم إرسال طلب إنشاء هدف', 'Goal creation requested'],
    };
    return labels[type]?.[isAr ? 0 : 1] || (isAr ? 'تحديث في الحساب' : 'Account update');
  };
  const manualFinancialStatuses = (data?.payment_submissions || []).filter((s) => s.submission_source === 'ADMIN_MANUAL' && s.status.toUpperCase() !== 'APPROVED');
  const eventRows: PortalEventRow[] = [
    ...(data?.orders || []).map((order) => ({
      id: 'order-' + order.order_number + '-' + order.created_at,
      created_at: order.created_at,
      title: (isAr ? 'طلب شحن رقم ' : 'Charging order #') + order.order_number,
      detail: statusLabel(order.status),
    })),
    ...(data?.payment_submissions || []).map((submission, index) => ({
      id: 'payment-' + submission.created_at + '-' + index,
      created_at: submission.created_at,
      title: isAr ? 'إيصال دفع' : 'Payment receipt',
      detail: statusLabel(submission.status),
    })),
    ...(activity?.goal_requests || []).map((request) => ({
      id: 'goal-request-' + request.id,
      created_at: request.created_at,
      title: isAr ? 'طلب إنشاء هدف' : 'Goal creation request',
      detail: statusLabel(request.status),
    })),
    ...(activity?.ledger || []).map((entry) => ({
      id: 'ledger-' + entry.id,
      created_at: entry.created_at,
      title: translateLedgerType(entry.event_type),
      detail: money(entry.amount_minor, locale),
    })),
    ...(activity?.events || []).map((event) => ({
      id: 'account-event-' + event.id,
      created_at: event.created_at,
      title: translateAccountEvent(event.event_type),
      detail: safeDate(event.created_at, locale),
    })),
  ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 50);

  useEffect(() => {
    const serverReadIds = (activity?.events || []).filter((event) => event.is_read).map((event) => 'account-event-' + event.id);
    if (!serverReadIds.length) return;
    setSeenNotificationIds((current) => {
      const merged = new Set([...current, ...serverReadIds]);
      return merged.size === current.length ? current : [...merged];
    });
  }, [activity?.events]);

  return (
    <div dir={isAr ? 'rtl' : 'ltr'} className="cp-customer-portal cp-portal-enter relative isolate min-h-screen text-slate-900 dark:text-slate-100">
      <div aria-hidden="true" className="cp-portal-moon-scene"><CustomerAuthScene uid="cp-customer-portal-scene" /></div>
      <header className="cp-portal-sticky-header relative z-20 sticky top-0 border-b border-slate-200 dark:border-emerald-950">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <AppLogo size={40} variant="auto" className="shrink-0" />
            <div><p className="font-bold">{isAr ? 'نقطة الشحن' : 'Charging Point'}</p></div>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-3xl space-y-4 px-4 py-5 pb-28 sm:py-8 sm:pb-28">
        {outageActive && offlineToastVisible && <div role="status" aria-live="polite" className={`cp-portal-offline-toast ${offlineToastFading ? 'cp-portal-offline-toast--leaving' : ''}`}><WifiOff size={16} className="shrink-0"/><span>{!online ? (isAr ? 'انقطع الاتصال — تعرض آخر بيانات محفوظة.' : 'Connection lost — showing saved data.') : (isAr ? 'الخادم غير متاح مؤقتًا — بعض العمليات متوقفة.' : 'Server temporarily unavailable — some actions are paused.')}</span></div>}

        {loading ? <div className="space-y-3" aria-live="polite"><div className="h-28 rounded-2xl bg-slate-200 dark:bg-emerald-950" /><div className="h-36 rounded-2xl bg-slate-200 dark:bg-emerald-950" /><p className="text-center text-sm text-slate-500">{isAr ? 'جارٍ التحقق من رمز العميل وتحميل البيانات...' : 'Verifying customer QR and loading your data…'}</p></div> :
          error || !data ? <section role="alert" className="py-5 text-center">
            <AlertTriangle className="mx-auto mb-3 h-9 w-9 text-amber-600" />
            <h1 className="text-lg font-bold">{error === 'invalid' ? (isAr ? 'تعذّر التحقق من رمز العميل' : 'Customer QR could not be verified') : (isAr ? 'بيانات العميل غير متاحة حالياً' : 'Customer data is temporarily unavailable')}</h1>
            <p className="mt-2 text-sm text-slate-600 dark:text-emerald-100/70">{error === 'invalid' ? (isAr ? 'الرمز غير صالح أو منتهي أو ملغى. لم نعرض أي بيانات للحساب.' : 'The QR is invalid, expired, or revoked. No account data was disclosed.') : (isAr ? 'تعذّر الاتصال بالخدمة الآمنة. تأكد من الإنترنت وحاول مجدداً.' : 'The secure service could not be reached. Check your connection and try again.')}</p>
            <button type="button" onClick={() => void load(true)} disabled={refreshing || !online} className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-2 font-semibold text-white disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />{isAr ? 'إعادة المحاولة' : 'Try again'}</button>
          </section> : <>
            {actionMessage && <div role="status" className="cp-portal-feedback">{actionMessage}</div>}

            {activeTab === 'home' && <>
              <section className="cp-portal-section">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h1 className="mt-1 text-2xl font-extrabold tracking-tight">{isAr ? 'أهلًا بعودتك، ' : 'Welcome back, '}{data.customer_name}</h1>
                    <p className="mt-1 text-sm cp-portal-muted">{isAr ? 'رقم الحساب' : 'Account'} · <bdi className="font-mono font-bold">{data.customer_code}</bdi></p>
                  </div>
                  <span className="cp-portal-status"><ShieldCheck size={15} />{isAr ? 'حسابك الخاص' : 'Private account'}</span>
                </div>
                <div className="cp-portal-balance">
                  <p className="mt-2 text-sm cp-portal-muted">{balanceLabel}</p>
                  <p className="cp-portal-balance__amount">{money(Math.abs(data.balance_minor), locale)}</p>
                  <div className="cp-portal-balance__actions">
                    {data.balance_minor < 0 && online
                      ? <a href={'/pay/' + encodeURIComponent(token)} className="cp-portal-primary-link"><CreditCard size={17} />{isAr ? 'إرسال دفعة' : 'Make a payment'}</a>
                      : <button type="button" className="cp-portal-secondary-button" onClick={() => setActiveTab('finance')}><ReceiptTextFallback />{isAr ? 'تفقد إيصالاتك' : 'View payment receipts'}</button>}
                    {(pendingReviewMinor > 0 || data.payment_submissions.some((submission) => submission.status.toUpperCase() === 'PENDING')) &&
                      <button type="button" className="cp-portal-text-link" onClick={() => setActiveTab('finance')}>{isAr ? 'دفعة قيد المراجعة' : 'Payment under review'}</button>}
                  </div>
                </div>
                <div className="cp-portal-subsection">
                  <div className="flex items-center justify-between gap-3">
                    <div><p className="cp-portal-eyebrow">{isAr ? 'متابعة الشحن' : 'CHARGING UPDATE'}</p><h2 className="mt-1 text-lg font-bold">{isAr ? 'طلبك الحالي' : 'Your current order'}</h2></div>
                    <button type="button" className="cp-portal-text-link" onClick={() => setActiveTab('orders')}>{isAr ? 'كل الطلبات' : 'All orders'} <span aria-hidden="true">←</span></button>
                  </div>
                  {featuredOrder ? <div className="cp-portal-featured-order">
                    <div className="flex items-start justify-between gap-3">
                      <div><p className="font-bold">{isAr ? 'طلب رقم' : 'Order'} #{featuredOrder.order_number}</p><p className="mt-1 text-xs cp-portal-muted">{safeDate(featuredOrder.created_at, locale)}</p></div>
                      <span className="cp-portal-status">{statusLabel(featuredOrder.status)}</span>
                    </div>
                    <div className="mt-4 flex items-end justify-between gap-3">
                      <div><p className="text-xs cp-portal-muted">{isAr ? 'عدد الأجهزة' : 'Devices'}</p><p className="mt-1 font-semibold">{featuredOrder.items.length}</p></div>
                      <div className="text-end"><p className="text-xs cp-portal-muted">{isAr ? 'المتبقي على الطلب' : 'Order due'}</p><p className="mt-1 text-lg font-bold">{money(featuredOrder.due_minor, locale)}</p></div>
                    </div>
                  </div> : <p className="cp-portal-empty">{isAr ? 'لا توجد طلبات مسجلة حتى الآن.' : 'No orders have been recorded yet.'}</p>}
                </div>
                <div className="cp-portal-subsection">
                  <div className="flex items-center justify-between gap-3"><h2 className="text-base font-bold">{isAr ? 'آخر التحديثات' : 'Recent updates'}</h2><button type="button" className="cp-portal-text-link" onClick={() => { setActiveTab('more'); setMoreView('notifications'); }}>{isAr ? 'عرض الكل' : 'View all'}</button></div>
                  {eventRows.length ? <div className="cp-portal-timeline">{eventRows.slice(0, 3).map((event) => <div key={event.id} className="cp-portal-timeline__row"><span className="cp-portal-timeline__dot" /><div className="min-w-0 flex-1"><p className="font-semibold">{event.title}</p><p className="mt-1 text-xs cp-portal-muted">{event.detail} · {safeDate(event.created_at, locale)}</p></div></div>)}</div> : <p className="cp-portal-empty">{isAr ? 'لا توجد تحديثات جديدة.' : 'No recent updates.'}</p>}
                </div>
              </section>
            </>}

            {activeTab === 'orders' && <section className="cp-portal-section">
              <p className="cp-portal-eyebrow">{isAr ? 'سجل الخدمة' : 'SERVICE HISTORY'}</p>
              <h1 className="cp-portal-heading">{isAr ? 'طلبات الشحن' : 'Charging orders'}</h1>
              {data.orders.length === 0 ? <p className="cp-portal-empty">{isAr ? 'لا توجد طلبات مسجلة.' : 'No orders found.'}</p> : <div className="cp-portal-list">
                {[...data.orders].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).map((order) => <article key={String(order.order_number) + order.created_at} className="cp-portal-order" id={'customer-order-' + order.order_number + '-' + order.created_at.replace(/[^a-zA-Z0-9]/g, '')}>
                  <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-bold">{isAr ? 'طلب رقم' : 'Order'} #{order.order_number}</h2><p className="mt-1 text-xs cp-portal-muted">{safeDate(order.created_at, locale)}</p></div><span className="cp-portal-status">{statusLabel(order.status)}</span></div>
                  <div className="cp-portal-order__totals"><div><span>{isAr ? 'الإجمالي' : 'Total'}</span><strong>{money(order.total_minor, locale)}</strong></div><div><span>{isAr ? 'المتبقي' : 'Due'}</span><strong>{money(order.due_minor, locale)}</strong></div></div>
                  <div className="mt-3">{order.items.map((item, index) => <div key={index} className="cp-portal-device-row"><div className="min-w-0"><p className="font-medium">{isAr ? item.device_name_ar : item.device_name_en}</p><p className="mt-1 text-xs cp-portal-muted">{item.has_charger ? (isAr ? 'مع شاحن' : 'With charger') : (isAr ? 'بدون شاحن' : 'No charger')} · {statusLabel(item.status)} · {statusLabel(item.payment_status)}</p></div><strong>{money(item.total_minor, locale)}</strong></div>)}</div>
                </article>)}
              </div>}
            </section>}

            {activeTab === 'finance' && <>
              <section className="cp-portal-section">
                <p className="cp-portal-eyebrow">{isAr ? 'حسابك المالي' : 'YOUR FINANCES'}</p>
                <h1 className="cp-portal-heading">{isAr ? 'كشف الحساب' : 'Account statement'}</h1>
                <div className="cp-portal-balance cp-portal-balance--compact"><p className="cp-portal-eyebrow">{isAr ? 'الرصيد الحالي' : 'CURRENT BALANCE'}</p><p className="mt-2 text-sm cp-portal-muted">{balanceLabel}</p><p className="cp-portal-balance__amount">{money(Math.abs(data.balance_minor), locale)}</p></div>
                <div className="cp-portal-subsection">
                  <div className="flex items-center justify-between gap-3"><h2 className="font-bold">{isAr ? 'الحركات المالية' : 'Financial movements'}</h2><span className="text-xs cp-portal-muted">{(activity?.ledger.length ?? 0) + manualFinancialStatuses.length}</span></div>
                  {activityLoading && !activity ? <p className="cp-portal-empty">{isAr ? 'جارٍ تحميل الحركات المالية…' : 'Loading financial movements…'}</p>
                    : activityError || !activity ? <div className="cp-portal-retry"><p className="cp-portal-empty">{isAr ? 'تعذّر تحميل الحركات المالية حاليًا.' : 'Financial movements are temporarily unavailable.'}</p><button type="button" className="cp-portal-secondary-button" disabled={!online || activityLoading} onClick={() => void loadActivity()}><RefreshCw size={15} className={activityLoading ? 'animate-spin' : ''}/>{isAr ? 'إعادة المحاولة' : 'Retry'}</button></div>
                    : activity.ledger.length === 0 && manualFinancialStatuses.length === 0 ? <p className="cp-portal-empty">{isAr ? 'لا توجد حركات مالية مسجلة.' : 'No financial movements found.'}</p>
                    : <div className="cp-portal-timeline">
                      {[...activity.ledger.map((entry) => ({ kind: 'ledger' as const, id: entry.id, created_at: entry.created_at, event_type: entry.event_type, amount_minor: entry.amount_minor, metadata: entry.metadata, submission: null as PortalSubmission | null })), ...manualFinancialStatuses.map((submission) => ({ kind: 'manual' as const, id: submission.id || submission.created_at, created_at: submission.created_at, event_type: submission.status.toUpperCase(), amount_minor: Number(submission.amount_minor || 0), metadata: null, submission }))].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).map((entry) => <div key={entry.kind + '-' + entry.id} className="cp-portal-timeline__row cp-portal-finance-row"><span className="cp-portal-timeline__dot" /><div className="min-w-0 flex-1"><p className="font-semibold">{entry.kind === 'manual' ? (isAr ? 'دفعة مسجّلة من الإدارة' : 'Admin-recorded payment') + ' · ' + statusLabel(entry.event_type) : translateLedgerType(entry.event_type)}</p><p className="mt-1 text-xs cp-portal-muted">{safeDate(entry.created_at, locale)}{entry.kind === 'ledger' && typeof entry.metadata?.order_number === 'number' ? ' · ' + (isAr ? 'طلب رقم ' : 'Order #') + entry.metadata.order_number : ''}</p>{entry.kind === 'manual' && entry.event_type === 'PENDING' && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{isAr ? 'بانتظار الاعتماد — لا يؤثر المبلغ على رصيدك حاليًا.' : 'Pending approval — this amount is not included in your balance.'}</p>}{entry.kind === 'manual' && entry.event_type === 'REJECTED' && entry.submission?.rejection_reason && <p className="mt-1 text-xs text-rose-600 dark:text-rose-300">{(isAr ? 'ملاحظة الإدارة: ' : 'Administrator note: ') + entry.submission.rejection_reason}</p>}{entry.kind === 'manual' && entry.submission?.note && <p className="mt-1 text-xs cp-portal-muted">{(isAr ? 'ملاحظة: ' : 'Note: ') + entry.submission.note}</p>}</div><strong className="shrink-0">{entry.kind === 'ledger' && entry.event_type === 'DISCOUNT' ? '−' + money(Math.abs(entry.amount_minor), locale) : money(entry.amount_minor, locale)}</strong></div>)}
                    </div>}
                </div>
              </section>
              <section className="cp-portal-section">
                <h2 className="text-base font-bold">{isAr ? 'الدفعات والإيصالات' : 'Payments and receipts'}</h2>
                <p className="mt-1 text-sm cp-portal-muted">{isAr ? 'الدفعات المعلّقة لا تدخل في الرصيد حتى اعتماد الإدارة.' : 'Pending payments do not affect your balance until approved by the administrator.'}</p>
                {data.payment_submissions.length === 0 ? <p className="cp-portal-empty">{isAr ? 'لا توجد دفعات أو إيصالات مسجلة.' : 'No payments or receipts found.'}</p> : <div className="cp-portal-timeline">{[...data.payment_submissions].sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime()).map((submission,index)=><div key={(submission.id || submission.created_at)+'-'+index} className="cp-portal-timeline__row"><span className="cp-portal-timeline__dot" /><div className="min-w-0 flex-1"><p className="font-semibold">{submission.submission_source === 'ADMIN_MANUAL' ? (isAr ? 'دفعة مسجّلة من الإدارة' : 'Payment recorded by administration') : (isAr ? 'إيصال دفع' : 'Payment receipt')} · {statusLabel(submission.status)}</p><p className="mt-1 text-xs cp-portal-muted">{safeDate(submission.created_at, locale)}{submission.reviewed_at ? ' · ' + safeDate(submission.reviewed_at, locale) : ''}</p>{submission.status.toUpperCase() === 'REJECTED' && submission.rejection_reason && <p className="mt-2 text-xs text-rose-600 dark:text-rose-300">{isAr ? 'ملاحظة الإدارة: ' : 'Administrator note: '}{submission.rejection_reason}</p>}{submission.submission_source === 'ADMIN_MANUAL' && submission.note && <p className="mt-2 text-xs cp-portal-muted">{isAr ? 'ملاحظة: ' : 'Note: '}{submission.note}</p>}</div><strong className="shrink-0">{money(submission.amount_minor, locale)}</strong></div>)}</div>}
                {online && serverAvailable && <a href={'/pay/' + encodeURIComponent(token)} className="cp-portal-primary-link"><CreditCard size={18} />{isAr ? 'إرسال إيصال دفع' : 'Submit payment receipt'}</a>}
              </section>
            </>}

            {activeTab === 'goals' && <section className="cp-portal-section">
              <p className="cp-portal-eyebrow">{isAr ? 'التقدم والمكافآت' : 'PROGRESS & REWARDS'}</p>
              <h1 className="cp-portal-heading">{isAr ? 'الأهداف' : 'Goals'}</h1>
              {activeGoal ? <div className="cp-portal-goal">
                <div className="flex items-start justify-between gap-3"><div><p className="font-bold">{isAr ? 'هدف الشحن الحالي' : 'Current charging goal'}</p><p className="mt-1 text-sm cp-portal-muted">{isAr ? 'التقدم' : 'Progress'} · {activeGoal.current_progress} / {activeGoal.target_quantity}</p></div><span className="cp-portal-status">{statusLabel(activeGoal.status)}</span></div>
                <div className="cp-portal-progress"><span style={{ width: (Math.max(0, Math.min(100, activeGoal.target_quantity > 0 ? activeGoal.current_progress / activeGoal.target_quantity * 100 : 0))) + '%' }} /></div>
                {activeGoal.expires_at && <p className="mt-3 text-xs cp-portal-muted">{isAr ? 'ينتهي في' : 'Expires'} · {safeDate(activeGoal.expires_at, locale)}</p>}
                {activeGoal.bonus_recorded && activeGoal.bonus_minor !== null && <p className="mt-3 font-bold">{isAr ? 'المكافأة المثبتة' : 'Recorded reward'} · {money(activeGoal.bonus_minor, locale)}</p>}
              </div> : pendingGoalRequest ? <div className="cp-portal-request-state"><span className="cp-portal-request-state__icon"><History size={20} /></span><div><p className="font-bold">{isAr ? 'طلب إنشاء الهدف قيد المراجعة' : 'Goal request awaiting review'}</p><p className="mt-1 text-sm cp-portal-muted">{isAr ? 'الإدارة ستحدد تفاصيل الهدف عند الموافقة.' : 'The administrator will determine the goal details after approval.'}</p><p className="mt-2 text-xs cp-portal-muted">{safeDate(pendingGoalRequest.created_at, locale)}</p></div></div>
              : activityLoading ? <p className="cp-portal-empty">{isAr ? 'جارٍ التحقق من حالة الأهداف…' : 'Checking goal status…'}</p>
              : activityError || !activity ? <div className="cp-portal-goal-empty"><span className="cp-portal-goal-empty__icon"><Target size={28} /></span><h2 className="mt-3 text-lg font-bold">{isAr ? 'تعذّر تحميل حالة الهدف' : 'Goal status unavailable'}</h2><p className="mt-2 text-sm cp-portal-muted">{isAr ? 'تقدر تعيد المحاولة أو ترسل طلب إنشاء هدف للإدارة. ستتحقق الخدمة من وجود هدف فعّال قبل تسجيل الطلب.' : 'Retry, or request a goal from the administrator. The service checks for an existing active goal before recording the request.'}</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" className="cp-portal-secondary-button" disabled={!online || activityLoading} onClick={() => { void load(); void loadActivity(); }}><RefreshCw size={15} className={activityLoading ? 'animate-spin' : ''}/>{isAr ? 'إعادة المحاولة' : 'Retry'}</button><button type="button" className="cp-portal-primary-button" disabled={!online || !serverAvailable || goalRequestBusy} onClick={() => void requestGoal()}>{goalRequestBusy ? <RefreshCw className="animate-spin" size={17} /> : <Target size={17} />}{isAr ? 'طلب إنشاء هدف' : 'Request a goal'}</button></div></div>
              : <div className="cp-portal-goal-empty"><span className="cp-portal-goal-empty__icon"><Target size={28} /></span><h2 className="mt-3 text-lg font-bold">{isAr ? 'ما عندك هدف حاليًا' : 'No active goal yet'}</h2><p className="mt-2 text-sm cp-portal-muted">{isAr ? 'تقدر ترسل طلبًا للإدارة، وهي تتولى تحديد تفاصيل الهدف واعتماده.' : 'You can request a goal; the administrator decides its details and approval.'}</p><button type="button" className="cp-portal-primary-button" disabled={!online || goalRequestBusy} onClick={() => void requestGoal()}>{goalRequestBusy ? <RefreshCw className="animate-spin" size={17} /> : <Target size={17} />}{isAr ? 'طلب إنشاء هدف' : 'Request a goal'}</button></div>}
              {data.goals.filter((goal) => goal.status.toUpperCase() !== 'ACTIVE').length > 0 && <div className="cp-portal-subsection"><h2 className="font-bold">{isAr ? 'الأهداف السابقة' : 'Previous goals'}</h2>{data.goals.filter((goal) => goal.status.toUpperCase() !== 'ACTIVE').map((goal,index)=><div key={index} className="cp-portal-history-row"><span>{statusLabel(goal.status)} · {goal.current_progress}/{goal.target_quantity}</span><span>{goal.bonus_recorded && goal.bonus_minor !== null ? money(goal.bonus_minor, locale) : '—'}</span></div>)}</div>}
            </section>}

            {activeTab === 'more' && moreView === 'profile' && <section className="cp-portal-section">
              <p className="cp-portal-eyebrow">{isAr ? 'بياناتك الشخصية' : 'YOUR DETAILS'}</p><h1 className="cp-portal-heading">{isAr ? 'حسابي' : 'My account'}</h1>
              <div className="cp-portal-profile"><div><span>{isAr ? 'اسم العميل' : 'Customer name'}</span><strong>{data.customer_name}</strong></div><div><span>{isAr ? 'رقم الحساب' : 'Account number'}</span><strong><bdi>{data.customer_code}</bdi></strong></div><div><span>{isAr ? 'آخر تسجيل دخول على هذا الجهاز' : 'Last sign-in on this device'}</span><strong>{activity?.last_login_at ? safeDate(activity.last_login_at, locale) : '—'}</strong></div><div><span>{isAr ? 'الجلسة الحالية · تنتهي في' : 'Current session · expires'}</span><strong>{activity?.session?.expires_at ? safeDate(activity.session.expires_at, locale) : '—'}</strong></div></div>
              <div className="cp-portal-subsection"><h2 className="font-bold">{isAr ? 'أمان الحساب' : 'Account security'}</h2><p className="mt-2 text-sm cp-portal-muted">{isAr ? 'إعادة تعيين كلمة المرور تحتاج موافقة الإدارة، وبعد الموافقة يجب اختيار كلمة مرور جديدة.' : 'Password reset requires administrator approval. After approval, you must set a new password.'}</p><button type="button" className="cp-portal-secondary-button" disabled={!online || !serverAvailable || resetRequestBusy} onClick={() => void requestPasswordReset()}>{resetRequestBusy ? <RefreshCw size={17} className="animate-spin" /> : <KeyRound size={17} />}{isAr ? 'طلب إعادة تعيين كلمة المرور' : 'Request password reset'}</button></div>
            </section>}

            {activeTab === 'more' && moreView === 'events' && <section className="cp-portal-section">
              <p className="cp-portal-eyebrow">{isAr ? 'قريبًا' : 'COMING SOON'}</p><h1 className="cp-portal-heading">{isAr ? 'الأحداث' : 'Events'}</h1>
              <div className="cp-portal-notice"><CalendarDaysFallback /><div><p className="font-bold">{isAr ? 'هذه الصفحة قيد التطوير' : 'This page is under development'}</p><p className="mt-1 text-sm cp-portal-muted">{isAr ? 'نعمل على تجهيز قسم الأحداث، وسيظهر هنا عند اكتماله.' : 'We are preparing the events section. It will appear here when ready.'}</p></div></div>
            </section>}

            {activeTab === 'more' && moreView === 'notifications' && <section className="cp-portal-section">
              <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><p className="cp-portal-eyebrow">{isAr ? 'آخر المستجدات' : 'LATEST UPDATES'}</p><h1 className="cp-portal-heading">{isAr ? 'الإشعارات' : 'Notifications'}</h1></div><button type="button" className="cp-portal-secondary-button" disabled={!online || !serverAvailable || activityLoading || eventRows.length === 0} onClick={() => void markAllNotificationsRead()}><CheckCircle2 size={16}/>{isAr ? 'تعليم الكل كمقروء' : 'Mark all as read'}</button></div>
              {notificationsMessage && <p role="status" className="mt-2 text-sm cp-portal-muted">{notificationsMessage}</p>}
              {activity?.events.some((event) => event.event_type === 'TEMP_PASSWORD_ISSUED') && <div className="cp-portal-notice"><Bell size={18} /><p>{isAr ? 'تمت الموافقة على طلب إعادة تعيين كلمة المرور. اتبع تعليمات تغيير كلمة المرور عند تسجيل الدخول.' : 'Your password-reset request was approved. Follow the password-change instructions when signing in.'}</p></div>}
              {eventRows.length ? <div className="cp-portal-timeline">{eventRows.map((event)=><div key={event.id} className="cp-portal-timeline__row"><span className="cp-portal-timeline__dot" /><div className="min-w-0 flex-1"><p className="font-semibold">{event.title}</p><p className="mt-1 text-xs cp-portal-muted">{event.detail} · {safeDate(event.created_at, locale)}</p></div></div>)}</div> : <p className="cp-portal-empty">{isAr ? 'لا توجد إشعارات حتى الآن.' : 'No notifications yet.'}</p>}
            </section>}


            {activeTab === 'more' && moreView === 'settings' && settingsSubpage === 'main' && <section className="cp-portal-section">
              <p className="cp-portal-eyebrow">{isAr ? 'تفضيلاتك' : 'PREFERENCES'}</p><h1 className="cp-portal-heading">{isAr ? 'الإعدادات' : 'Settings'}</h1>
              <div className="cp-portal-subsection">
                <div className="cp-portal-setting-row"><div><p className="font-semibold">{isAr ? 'المظهر' : 'Appearance'}</p><p className="mt-1 text-xs cp-portal-muted">{isAr ? 'داكن افتراضيًا ويمكنك تغييره' : 'Dark by default; change it anytime'}</p></div><button type="button" className="cp-portal-setting-button" onClick={() => { toggleTheme(); setShowOfflineDot(false); }}>{resolvedTheme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}{resolvedTheme === 'dark' ? (isAr ? 'فاتح' : 'Light') : (isAr ? 'داكن' : 'Dark')}{showOfflineDot && <span aria-label={isAr ? 'ملاحظة اتصال' : 'Connection notice'} className="cp-portal-offline-dot"/>}</button></div>
                <div className="cp-portal-setting-row"><div><p className="font-semibold">{isAr ? 'اللغة' : 'Language'}</p><p className="mt-1 text-xs cp-portal-muted">{isAr ? 'اختر لغة الواجهة' : 'Choose your interface language'}</p></div><button type="button" className="cp-portal-setting-button" onClick={() => setLocale(isAr ? 'en' : 'ar')}><Globe size={17} />{isAr ? 'English' : 'العربية'}</button></div>
              </div>
              <button type="button" className="cp-portal-setting-row w-full text-start" onClick={() => setSettingsSubpage('security')} aria-label={isAr ? 'فتح إعدادات الأمان وتسجيل الدخول' : 'Open security and sign-in settings'}>
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-cyan-500/10 text-cyan-600 dark:text-cyan-300"><ShieldCheck size={20}/></span>
                <span className="min-w-0 flex-1"><span className="block font-semibold">{isAr ? 'الأمان وتسجيل الدخول' : 'Security & sign-in'}</span><span className="mt-1 block text-xs cp-portal-muted">{isAr ? 'كلمة المرور والبصمة وحماية الحساب' : 'Password, fingerprint, and account protection'}</span></span>
                <ArrowLeft size={18} className="shrink-0 opacity-60" aria-hidden="true"/>
              </button>
              <div className="mt-5 border-t border-slate-200/70 pt-5 dark:border-emerald-950/70">
                <p className="mb-3 text-xs cp-portal-muted">{isAr ? 'معلومات التطبيق' : 'APP INFORMATION'}</p>
                <button type="button" className="cp-portal-setting-row w-full text-start" onClick={() => setSettingsSubpage('about')} aria-label={isAr ? 'عن نقطة الشحن' : 'About Charging Point'}>
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-cyan-500/10 text-cyan-600 dark:text-cyan-300"><Info size={20}/></span>
                  <span className="min-w-0 flex-1"><span className="block font-semibold">{isAr ? 'عن نقطة الشحن' : 'About Charging Point'}</span><span className="mt-1 block text-xs cp-portal-muted">{isAr ? 'نبذة عن التطبيق ومعلومات الإصدار' : 'App overview and version information'}</span></span>
                  <ArrowLeft size={18} className="shrink-0 opacity-60" aria-hidden="true"/>
                </button>
              </div>
            </section>}

            {activeTab === 'more' && moreView === 'settings' && settingsSubpage === 'security' && <section className="cp-portal-section">
              <button type="button" className="cp-portal-text-link mb-4 inline-flex items-center gap-2" onClick={() => setSettingsSubpage('main')}><ArrowLeft size={17}/>{isAr ? 'العودة إلى الإعدادات' : 'Back to settings'}</button>
              <p className="cp-portal-eyebrow">{isAr ? 'حماية حسابك' : 'PROTECT YOUR ACCOUNT'}</p><h1 className="cp-portal-heading">{isAr ? 'الأمان وتسجيل الدخول' : 'Security & sign-in'}</h1>
              <div className="cp-portal-subsection">
                <h2 className="font-bold">{isAr ? 'كلمة المرور وإعادة التعيين' : 'Password & reset'}</h2>
                <p className="mt-2 text-sm cp-portal-muted">{isAr ? 'تغيير كلمة المرور متاح من هنا. إذا نسيتها، أرسل طلب إعادة تعيين للإدارة؛ وبعد الموافقة ستحتاج إلى اختيار كلمة مرور جديدة.' : 'Change your password here. If you forget it, request a reset from the administrator; after approval, you will need to choose a new password.'}</p>
                <button type="button" className="cp-portal-secondary-button mt-3" disabled={!online || !serverAvailable || resetRequestBusy} onClick={() => void requestPasswordReset()}>{resetRequestBusy ? <RefreshCw size={17} className="animate-spin" /> : <KeyRound size={17} />}{isAr ? 'طلب إعادة تعيين كلمة المرور' : 'Request password reset'}</button>
              </div>
                            {Capacitor.isNativePlatform() && <div className="cp-portal-subsection">
                <h2 className="font-bold">{isAr ? 'الدخول بالبصمة' : 'Fingerprint sign-in'}</h2>
                <p className="mt-2 text-sm cp-portal-muted">{biometricEnrolled ? (isAr ? 'البصمة مفعّلة لهذا الحساب على هذا الجهاز. يمكنك تغييرها متى شئت.' : 'Fingerprint is enabled for this account on this device. You can change it anytime.') : (isAr ? 'لم تضف بصمة لهذا الحساب بعد.' : 'No fingerprint is enrolled for this account yet.')}</p>
                {biometricMessage && <p role="status" className="mt-2 text-sm">{biometricMessage}</p>}
                {!showBiometricManager ? <button type="button" className="cp-portal-secondary-button mt-3" disabled={!biometricAvailable || !online || !serverAvailable} onClick={() => { setBiometricMessage(''); setShowBiometricManager(true); }}><ShieldCheck size={17}/>{biometricEnrolled ? (isAr ? 'تغيير / إعادة إضافة البصمة' : 'Change / re-enroll fingerprint') : (isAr ? 'إضافة البصمة' : 'Add fingerprint')}</button>
                : <form className="cp-portal-password-form mt-3" onSubmit={(event) => { void saveCustomerBiometric(event); }}>
                  <label className="cp-portal-password-label">{isAr ? 'كلمة المرور الحالية لتأكيد هويتك' : 'Current password to verify your identity'}</label>
                  <input type="password" required autoComplete="current-password" value={biometricPassword} onChange={(event) => setBiometricPassword(event.target.value)} className="cp-portal-password-input"/>
                  <p className="text-xs cp-portal-muted">{isAr ? 'بعد التحقق من كلمة المرور سيطلب الجهاز بصمتك. لا تُرسل بيانات البصمة إلى الخادم.' : 'After your password is verified, Android will ask for your fingerprint. Your biometric data is never sent to the server.'}</p>
                  <div className="flex flex-wrap gap-2"><button type="submit" className="cp-portal-primary-button" disabled={!online || !serverAvailable || biometricBusy}>{biometricBusy ? <RefreshCw size={17} className="animate-spin"/> : <ShieldCheck size={17} />}{isAr ? 'التحقق وتفعيل البصمة' : 'Verify and enable fingerprint'}</button><button type="button" className="cp-portal-secondary-button" disabled={biometricBusy} onClick={() => { setShowBiometricManager(false); setBiometricPassword(''); setBiometricMessage(''); }}>{isAr ? 'إلغاء' : 'Cancel'}</button></div>
                </form>}
              </div>}
                            <div className="cp-portal-subsection">
                <h2 className="font-bold">{isAr ? 'تغيير كلمة المرور' : 'Change password'}</h2>
                {!showPasswordChange ? <button type="button" className="cp-portal-secondary-button" disabled={!online || !serverAvailable} onClick={() => { setActionMessage(''); setShowPasswordChange(true); }}><KeyRound size={17} />{isAr ? 'تغيير كلمة المرور' : 'Change password'}</button>
                : <form className="cp-portal-password-form" onSubmit={(event) => { event.preventDefault(); void changePortalPassword(); }}>
                  <label className="cp-portal-password-label">{isAr ? 'كلمة المرور الجديدة' : 'New password'}</label>
                  <input type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className="cp-portal-password-input" />
                  <label className="cp-portal-password-label">{isAr ? 'تأكيد كلمة المرور' : 'Confirm password'}</label>
                  <input type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={confirmNewPassword} onChange={(event) => setConfirmNewPassword(event.target.value)} className="cp-portal-password-input" />
                  <p className="text-xs cp-portal-muted">{isAr ? '8 أحرف على الأقل، وتجنّب كلمات المرور الشائعة.' : 'At least 8 characters; avoid common passwords.'}</p>
                  <div className="flex flex-wrap gap-2"><button type="submit" className="cp-portal-primary-button" disabled={!online || !serverAvailable || passwordChangeBusy}>{passwordChangeBusy ? <RefreshCw size={17} className="animate-spin" /> : <KeyRound size={17} />}{isAr ? 'حفظ كلمة المرور' : 'Save password'}</button><button type="button" className="cp-portal-secondary-button" disabled={passwordChangeBusy} onClick={() => { setShowPasswordChange(false); setNewPassword(''); setConfirmNewPassword(''); }}>{isAr ? 'إلغاء' : 'Cancel'}</button></div>
                </form>}
              </div>
              <div className="cp-portal-profile cp-portal-profile--footer"><div><span>{isAr ? 'اسم العميل' : 'Customer name'}</span><strong>{data.customer_name}</strong></div></div>
              <button type="button" className="cp-portal-signout" onClick={() => { void handleSignOut(); }} disabled={!onLogout}><UserRound size={17} />{isAr ? 'تسجيل الخروج' : 'Sign out'}</button>
            </section>}

            {activeTab === 'more' && moreView === 'settings' && settingsSubpage === 'about' && <section className="cp-portal-section">
              <button type="button" className="cp-portal-text-link mb-4 inline-flex items-center gap-2" onClick={() => setSettingsSubpage('main')}><ArrowLeft size={17}/>{isAr ? 'العودة إلى الإعدادات' : 'Back to settings'}</button>
              <p className="cp-portal-eyebrow">{isAr ? 'معلومات التطبيق' : 'APP INFORMATION'}</p><h1 className="cp-portal-heading">{isAr ? 'عن نقطة الشحن' : 'About Charging Point'}</h1>
              <div className="cp-portal-subsection">
                <h2 className="font-bold">{isAr ? 'عن نقطة الشحن' : 'About Charging Point'}</h2>
                <p className="mt-2 text-sm leading-6 cp-portal-muted">{isAr ? 'نقطة الشحن خدمة لمتابعة طلبات شحن الأجهزة وحالة كل طلب، والاطلاع على الرصيد والذمم والحركات المالية وإيصالات الدفع. يمكنك إرسال إشعار الدفع وإرفاق الإيصال، ومتابعة حالة المراجعة دون اعتبار الإرسال دفعة معتمدة قبل موافقة الإدارة. كما تتيح البوابة متابعة الأهداف والمكافآت، واستلام تحديثات الحساب والإشعارات، وتغيير كلمة المرور وإدارة الدخول بالبصمة على الجهاز المدعوم. تُحمّل البيانات الحساسة من الخدمة الموثوقة، وتُعرض آخر نسخة محفوظة عند انقطاع الاتصال مع إيقاف العمليات المالية حتى عودة التحقق.' : 'Charging Point lets you track charging orders and their statuses, view balances, amounts due, financial activity and payment receipts. You can submit a payment notice with a receipt image and track its review; submission is not treated as an approved payment until the administrator verifies it. The portal also supports goals and rewards, account updates and notifications, password changes, and device-based fingerprint sign-in on supported devices. Sensitive data is retrieved from the trusted service. A saved snapshot may be shown during an outage, while financial actions remain disabled until connectivity and verification return.'}</p>
              </div>
              <div className="cp-portal-subsection">
                <h2 className="font-bold">{isAr ? 'معلومات الإصدار' : 'Version information'}</h2>
                <div className="cp-portal-setting-row"><span className="text-sm cp-portal-muted">{isAr ? 'إصدار التطبيق' : 'App version'}</span><strong className="text-sm">{appVersion}</strong></div>
                <div className="cp-portal-setting-row"><span className="text-sm cp-portal-muted">{isAr ? 'إصدار الأمان' : 'Security version'}</span><span className="text-xs cp-portal-muted">{isAr ? 'تُدار متطلبات الأمان عبر سياسة الخادم؛ لا يوجد رقم مستقل منشور حاليًا.' : 'Security requirements are enforced by server policy; no separate public security version is currently published.'}</span></div>
              </div>
            </section>}

            <p className="cp-portal-footnote"><CheckCircle2 size={15} />{isAr ? 'عرض معلومات الحساب فقط؛ اعتماد الدفعات وتحديد الأهداف من صلاحيات الإدارة.' : 'Account information only; payment approval and goal assignment remain administrator-controlled.'}</p>
          </>}
      </main>
      <footer className="relative z-10 border-t border-slate-200/70 px-4 py-5 text-center text-xs text-slate-500 dark:border-emerald-950/70 dark:text-emerald-100/50">{isAr ? 'نقطة الشحن · بوابة العميل الآمنة' : 'Charging Point · Secure customer portal'}</footer>
      {data && !loading && !error && <CustomerPortalNavigation activeTab={activeTab} onTabChange={setActiveTab} moreView={moreView} onMoreViewChange={(view) => { setMoreView(view); if (view === 'notifications') markNotificationsSeen(); }} notificationCount={eventRows.filter((event) => !seenNotificationIds.includes(event.id)).length} isAr={isAr} />}
    </div>
  );
};
