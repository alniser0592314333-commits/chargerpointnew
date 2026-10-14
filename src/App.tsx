/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { ThemeProvider } from './theme/themeContext';
import { I18nProvider } from './i18n/i18nContext';
import { ToastProvider } from './components/ui/Toast';
import { AuthenticatedLayout } from './components/shell/AuthenticatedLayout';
import { LoginPage } from './components/pages/LoginPage';
import { ResetPasswordPage } from './components/pages/ResetPasswordPage';
import { authService } from './services/auth/authService';
import { isCurrentAccountSessionActive, registerCurrentAccountSession } from './services/auth/accountSessionService';
import { refreshStoreFromRemote, ensureStoreHydrated, subscribeStoreBootstrapProgress } from './components/pages/dayOrdersStore';
import type { StoreBootstrapProgress } from './components/pages/dayOrdersStore';
import { globalSyncBridge } from './infrastructure/sync/syncBridge';
import { HomePage } from './components/pages/HomePage';
import { DaysOrdersPage } from './components/pages/DaysOrdersPage';
import { DayDetailPage } from './components/pages/DayDetailPage';
import { AddOrderPage } from './components/pages/AddOrderPage';
import { EditOrderPage } from './components/pages/EditOrderPage';
import { FeaturePlaceholderPage } from './components/pages/FeaturePlaceholderPage';
import { CustomersPage } from './components/pages/CustomersPage';
import { CustomerDetailPage } from './components/pages/CustomerDetailPage';
import { CustomerQrDesignPage } from './components/pages/CustomerQrDesignPage';
import { CustomerQrPage } from './components/pages/CustomerQrPage';
import { OrderQrPage } from './components/pages/OrderQrPage';
import { PublicCustomerQrPage } from './components/pages/PublicCustomerQrPage';
import { PublicOrderPage } from './components/pages/PublicOrderPage';
import { FinancialsPage } from './components/pages/FinancialsPage';
import { FinancialCustomersPage } from './components/pages/FinancialCustomersPage';
import { FinancialCustomerDetailPage } from './components/pages/FinancialCustomerDetailPage';
import { GoalsPage } from './components/pages/GoalsPage';
import { NotificationsRequestsPage } from './components/pages/NotificationsRequestsPage';
import { SettingsPage } from './components/pages/SettingsPage';
import { RenumberDayPage } from './components/pages/RenumberDayPage';
import { QrDesignSettingsPage } from './components/pages/QrDesignSettingsPage';
import { DeviceTypesPage } from './components/pages/DeviceTypesPage';
import { NotFoundPage } from './components/pages/NotFoundPage';
import { UnauthorizedPage } from './components/pages/UnauthorizedPage';
import { AdminManagementPage } from './components/pages/AdminManagementPage';
import { UserSession } from './services/auth/authService';
import { registerSuspensionHandler } from './services/supabase/client';
import { ShieldAlert } from 'lucide-react';
import { DesignSystemPlayground } from './components/playground/DesignSystemPlayground';
import { Button } from './components/ui/Button';

export function parseRoute(pathAndHash: string): { pathname: string; hash: string; search: string } {
  try {
    const dummyOrigin = 'http://localhost';
    const url = new URL(pathAndHash, dummyOrigin);
    return {
      // The installed PWA starts at /app/ while the canonical application route is /app.
      // Normalize the trailing slash so installed and browser launches share one route state.
      pathname: url.pathname === '/app/' ? '/app' : url.pathname,
      hash: url.hash,
      search: url.search,
    };
  } catch {
    const cleanPath = pathAndHash.split('#')[0].split('?')[0];
    const hash = pathAndHash.includes('#') ? '#' + pathAndHash.split('#')[1] : '';
    const search = pathAndHash.includes('?') ? '?' + pathAndHash.split('?')[1].split('#')[0] : '';
    return { pathname: cleanPath, hash, search };
  }
}

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isAuthChecking, setIsAuthChecking] = useState<boolean>(true);
  const [userSession, setUserSession] = useState<UserSession | null>(null);
  const [isSuspended, setIsSuspended] = useState<boolean>(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [isBootRetrying, setIsBootRetrying] = useState(false);
  const [bootstrapProgress, setBootstrapProgress] = useState<StoreBootstrapProgress>({
    phase: 'IDLE', percent: 0, completedRows: 0, totalRows: 0, message: '',
  });
  const [currentPath, setCurrentPathState] = useState(() => {
    return window.location.pathname && window.location.pathname !== '/'
      ? window.location.pathname
      : '/app';
  });

  // Centralized Navigate function syncing with window.history
  const navigate = (newPath: string, replace = false) => {
    if (replace) {
      window.history.replaceState({ path: newPath }, '', newPath);
    } else if (newPath !== currentPath) {
      window.history.pushState({ path: newPath }, '', newPath);
    }
    setCurrentPathState(newPath);
  };

  useEffect(() => subscribeStoreBootstrapProgress(setBootstrapProgress), []);

  // Authoritatively check auth, then gate application access on local store readiness.
  useEffect(() => {
    let isMounted = true;
    let authenticatedSession: UserSession | null = null;
    const initAuth = async () => {
      try {
        const result = await authService.captureAuthCallback().catch(() => ({ session: null, error: 'Error', type: null }));
        if (result.type === 'recovery') navigate('/reset-password', true);

        authenticatedSession = await authService.getCurrentSession();
        if (isMounted) {
          setIsAuthenticated(Boolean(authenticatedSession));
          setUserSession(authenticatedSession);
        }

        if (authenticatedSession) {
          // Register the current Auth session without blocking normal startup if the feature migration has not reached this environment yet.
          try { await registerCurrentAccountSession(); } catch (sessionRegistrationError) { console.warn('Account session registration is unavailable; continuing normal startup.', sessionRegistrationError); }
          // Never suppress bootstrap errors: a fresh device must not open on an
          // empty or partially hydrated model. Existing local data remains usable
          // when a remote read fails before any local replacement begins.
          await ensureStoreHydrated();
          await refreshStoreFromRemote();
        }
      } catch (error: any) {
        if (isMounted) {
          if (authenticatedSession) {
            setIsAuthenticated(true);
            setUserSession(authenticatedSession);
            setBootError(error?.message || 'STORE_BOOTSTRAP_FAILED');
          } else {
            setIsAuthenticated(false);
          }
        }
      } finally {
        if (isMounted) setIsAuthChecking(false);
      }
    };
    void initAuth();
    return () => { isMounted = false; };
  }, []);

  const retryStoreBootstrap = async () => {
    if (isBootRetrying) return;
    setIsBootRetrying(true);
    try {
      await ensureStoreHydrated();
      await refreshStoreFromRemote();
      setBootError(null);
    } catch (error: any) {
      setBootError(error?.message || 'STORE_BOOTSTRAP_FAILED');
    } finally {
      setIsBootRetrying(false);
    }
  };

  // Low-cost pull-only refresh while the authenticated app is visible.
  // Push remains event-driven by the existing Outbox coordinator.
  useEffect(() => {
    if (!isAuthenticated || isSuspended || isAuthChecking || bootError) return;
    let active = false;
    const pullLatest = async () => {
      if (active || document.visibilityState !== 'visible' || navigator.onLine === false) return;
      active = true;
      try {
        // Revoked sessions are returned to login at the next online verification cycle.
        try {
          const sessionActive = await isCurrentAccountSessionActive();
          if (!sessionActive) {
            await authService.logout();
            setIsAuthenticated(false);
            setUserSession(null);
            navigate('/app', true);
            return;
          }
        } catch (sessionCheckError) {
          // Keep the app available during rollout or transient network/RPC failures.
          console.warn('Account session verification temporarily unavailable.', sessionCheckError);
        }
        const result = await globalSyncBridge.requestLatestDataReload();
        if (result.needsReconciliation) await globalSyncBridge.notifyOutboxWorkAvailable();
      } catch (error) {
        console.warn('Background incremental pull failed; will retry on the next cycle:', error);
      } finally {
        active = false;
      }
    };
    const timer = window.setInterval(() => { void pullLatest(); }, 30_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void pullLatest();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    void pullLatest();
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [isAuthenticated, isSuspended, isAuthChecking, bootError]);

  // Register central suspension handler
  useEffect(() => {
    registerSuspensionHandler(() => {
      setIsSuspended(true);
    });
  }, []);

  // Lightweight visibility/focus lifecycle verification
  useEffect(() => {
    const handleFocus = async () => {
      if (isAuthenticated && !isSuspended) {
        try {
          const session = await authService.getCurrentSession(true); // Authoritatively verify with server
          if (!session) {
            setIsSuspended(true);
          }
        } catch {
          // Fail-closed/safe: ignore transient network issues but let authService handle rehydration
        }
      }
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [isAuthenticated, isSuspended]);

  // Safe goBack helper
  const goBack = (fallbackPath: string) => {
    if (window.history.state && window.history.state.path) {
      window.history.back();
    } else {
      navigate(fallbackPath, true);
    }
  };

  // Listen to browser Back/Forward (popstate)
  useEffect(() => {
    // Save initial history state if empty
    if (!window.history.state || !window.history.state.path) {
      window.history.replaceState({ path: currentPath }, '', currentPath);
    }

    const handlePopState = (e: PopStateEvent) => {
      const targetPath = e.state?.path || window.location.pathname || '/app';
      setCurrentPathState(targetPath);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const renderContent = () => {
    const { pathname } = parseRoute(currentPath);

    // 0. Public Customer & Order QR Routes (Publicly accessible, zero auth, strictly read-only)
    if (pathname.startsWith('/c/')) {
      const token = pathname.replace('/c/', '');
      return <PublicCustomerQrPage token={token} />;
    }
    if (pathname.startsWith('/public/qr/customer/')) {
      const token = pathname.replace('/public/qr/customer/', '');
      return <PublicCustomerQrPage token={token} />;
    }
    if (pathname.startsWith('/o/')) {
      const token = pathname.replace('/o/', '');
      return <PublicOrderPage token={token} />;
    }
    if (pathname.startsWith('/public/order/')) {
      const token = pathname.replace('/public/order/', '');
      return <PublicOrderPage token={token} />;
    }
    if (pathname.startsWith('/public/qr/order/')) {
      const token = pathname.replace('/public/qr/order/', '');
      return <PublicOrderPage token={token} />;
    }
    
    if (pathname === '/reset-password') {
      return <ResetPasswordPage onNavigate={(path) => navigate(path)} />;
    }

    if (bootError) {
      return (
        <div className="min-h-[70vh] flex items-center justify-center p-6">
          <div className="max-w-lg w-full rounded-2xl border border-amber-200 dark:border-amber-900/50 bg-white dark:bg-gray-900 p-6 space-y-4 text-center">
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">تعذّر تجهيز قاعدة البيانات المحلية</h2>
            <p className="text-sm text-gray-600 dark:text-gray-300">لم نفتح النظام لأن التهيئة لم تكتمل بأمان. تأكد من الاتصال ثم أعد المحاولة. بياناتك المحلية لم تُعتبر جاهزة قبل التحقق.</p>
            <p className="text-xs text-gray-500 break-words">{bootError}</p>
            <Button variant="primary" disabled={isBootRetrying} onClick={() => void retryStoreBootstrap()} className="w-full">
              {isBootRetrying ? 'جارٍ إعادة المحاولة…' : 'إعادة المحاولة'}
            </Button>
          </div>
        </div>
      );
    }

    if (pathname === '/playground') {
      return (
        <div className="space-y-4">
          <div className="p-4 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center">
            <Button variant="outline" size="sm" onClick={() => navigate('/app')}>
              العودة إلى التطبيق الرئيسي
            </Button>
            <span className="text-xs text-gray-500">Design System Playground</span>
          </div>
          <DesignSystemPlayground />
        </div>
      );
    }

    if (isAuthChecking) {
      const showBootstrapProgress = bootstrapProgress.phase === 'FETCHING' || bootstrapProgress.phase === 'INSTALLING';
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-[#061f1c] p-6">
          <div className="w-full max-w-md flex flex-col items-center gap-4 rounded-2xl border border-gray-200 dark:border-emerald-900/40 bg-white/90 dark:bg-[#082a25] p-6 shadow-xl">
            <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            <div className="text-sm font-semibold text-gray-800 dark:text-emerald-100">جارٍ تجهيز النظام بأمان</div>
            {showBootstrapProgress && (
              <div className="w-full space-y-2">
                <div className="flex items-center justify-between gap-3 text-xs text-gray-600 dark:text-emerald-200">
                  <span>{bootstrapProgress.message}</span>
                  <span className="tabular-nums font-semibold">{bootstrapProgress.percent}%</span>
                </div>
                <div className="w-full h-2 rounded-full bg-gray-200 dark:bg-emerald-950 overflow-hidden">
                  <div className="h-full rounded-full bg-emerald-500 transition-all duration-200" style={{ width: `${bootstrapProgress.percent}%` }} />
                </div>
                {bootstrapProgress.totalRows > 0 && (
                  <div className="text-[11px] text-gray-500 dark:text-emerald-300 text-center">
                    {bootstrapProgress.completedRows.toLocaleString()} / {bootstrapProgress.totalRows.toLocaleString()} سجل تم تجهيزه
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      );
    }

    if (!isAuthenticated) {
      return (
        <LoginPage
          bootstrapProgress={bootstrapProgress}
          onLoginSuccess={async () => {
            // Login success is not application readiness. Complete local bootstrap
            // first; a rejected bootstrap is shown by LoginPage and can be retried.
            await ensureStoreHydrated();
            await refreshStoreFromRemote();
            const session = await authService.getCurrentSession();
            if (session) {
              try { await registerCurrentAccountSession(); } catch (sessionRegistrationError) { console.warn('Account session registration is unavailable; continuing after login.', sessionRegistrationError); }
            }
            setUserSession(session);
            setBootError(null);
            setIsAuthenticated(true);
            navigate('/app', true);
          }}
        />
      );
    }

    // 1. Authenticated Customer QR Route
    if (pathname.startsWith('/app/qr/customer/')) {
      const customerId = pathname.replace('/app/qr/customer/', '');
      return <CustomerQrPage customerId={customerId} />;
    }

    if (pathname.includes('/add-order')) {
      const match = pathname.match(/\/app\/days\/([^/]+)\/add-order/);
      const dayId = match ? match[1] : pathname.split('/')[3] || '';
      return (
        <AddOrderPage
          dayId={dayId}
          onBack={() => goBack(`/app/days/${dayId}`)}
          onSuccess={(targetDayId) => navigate(`/app/days/${targetDayId}`, true)}
          onEditOrder={(targetDayId, orderId) =>
            navigate(`/app/days/${targetDayId}/orders/${orderId}/edit`)
          }
        />
      );
    }

    // 2. Order QR Route (Isolated regex match)
    const orderQrMatch = pathname.match(/\/app\/days\/([^/]+)\/orders\/([^/]+)\/qr/);
    if (orderQrMatch) {
      const dayId = orderQrMatch[1];
      const orderId = orderQrMatch[2];

      return (
        <OrderQrPage
          dayId={dayId}
          orderId={orderId}
          onBack={() => goBack(dayId ? `/app/days/${dayId}` : '/app/days')}
        />
      );
    }

    if (pathname.includes('/edit')) {
      const match = pathname.match(/\/app\/days\/([^/]+)\/orders\/([^/]+)\/edit/);
      const dayId = match ? match[1] : '';
      const orderId = match ? match[2] : pathname.split('/')[3] || '';

      return (
        <EditOrderPage
          dayId={dayId}
          orderId={orderId}
          onBack={() => goBack(dayId ? `/app/days/${dayId}` : '/app/days')}
          onSuccess={(targetDayId, targetOrderId) => {
            const targetPath = `/app/days/${targetDayId}#order-card-${targetOrderId}`;
            window.location.hash = `order-card-${targetOrderId}`;
            navigate(targetPath, true);
          }}
        />
      );
    }

    if (pathname.startsWith('/app/financials/customers/') && pathname !== '/app/financials/customers') {
      const customerId = pathname.replace('/app/financials/customers/', '');
      return <FinancialCustomerDetailPage customerId={customerId} />;
    }

    if (pathname === '/app/financials/customers') {
      return (
        <FinancialCustomersPage
          onSelectCustomer={(customerId) => navigate(`/app/financials/customers/${customerId}`)}
        />
      );
    }

    if (pathname.startsWith('/app/customers/') && pathname !== '/app/customers') {
      const customerId = pathname.replace('/app/customers/', '');
      return (
        <CustomerDetailPage
          customerId={customerId}
          onNavigateToQr={(custID) => navigate(`/app/qr/customer/${custID}`)}
        />
      );
    }

    if (pathname.startsWith('/app/days/') && pathname !== '/app/days') {
      const dayId = pathname.replace('/app/days/', '');
      return (
        <DayDetailPage
          dayId={dayId}
          onBack={() => goBack('/app/days')}
          onAddOrder={(dId) => navigate(`/app/days/${dId}/add-order`)}
          onOpenOrderQr={(dId, oId) => navigate(`/app/days/${dId}/orders/${oId}/qr`)}
          onEditOrder={(dId, oId) => navigate(`/app/days/${dId}/orders/${oId}/edit`)}
        />
      );
    }

    switch (pathname) {
      case '/app':
        return (
          <HomePage
            onNavigate={(path) => navigate(path)}
            onSelectOrder={(dayId, orderId) => {
              window.location.hash = `order-card-${orderId}`;
              navigate(`/app/days/${dayId}#order-card-${orderId}`);
            }}
          />
        );
      case '/app/days':
        return (
          <DaysOrdersPage
            onSelectDay={(dayId) => navigate(`/app/days/${dayId}`)}
          />
        );
      case '/app/customers':
        return (
          <CustomersPage
            onSelectCustomer={(customerId) => navigate(`/app/customers/${customerId}`)}
            onSelectOrder={(dayId, orderId) => {
              window.location.hash = `order-card-${orderId}`;
              navigate(`/app/days/${dayId}#order-card-${orderId}`);
            }}
          />
        );
      case '/app/financials':
        return <FinancialsPage onNavigate={(path) => navigate(path)} />;
      case '/app/goals': {
        const isSuperAdmin = Boolean(userSession && String(userSession.role || '').toUpperCase().replace(/\s+/g, '_') === 'SUPER_ADMIN');
        const goalPagePermissions = new Set<string>(['goals:view', 'goals:requests:view', 'goals:manage', 'goals:approve']);
        const canViewGoals = isSuperAdmin || Boolean(userSession?.permissions?.some((permission) => goalPagePermissions.has(permission)));
        if (!userSession || !canViewGoals) return <UnauthorizedPage />;
        return <GoalsPage />;
      }
      case '/app/notifications':
        return <NotificationsRequestsPage />;
      case '/app/settings':
        return <SettingsPage onNavigate={(path) => navigate(path)} onLogout={async () => {
          await authService.logout();
          setIsAuthenticated(false);
          setUserSession(null);
          navigate("/login", true);
        }} />;
      case '/app/settings/renumber-day': {
        const canRenumber = Boolean(userSession && String(userSession.role || '').toUpperCase().replace(/\s+/g, '_') === 'SUPER_ADMIN') || Boolean(userSession?.permissions?.includes('orders:renumber-day'));
        if (!userSession || !canRenumber) return <UnauthorizedPage />;
        return <RenumberDayPage onBack={() => goBack('/app/settings')} />;
      }
      case '/app/settings/admins': {
        const isSuperAdmin = Boolean(userSession && String(userSession.role || '').toUpperCase().replace(/\s+/g, '_') === 'SUPER_ADMIN');
        const hasAdminManage = isSuperAdmin || Boolean(userSession?.permissions?.includes('admin:manage'));
        if (!userSession || !hasAdminManage) {
          return <UnauthorizedPage />;
        }
        return <AdminManagementPage />;
      }
      case '/app/settings/device-types': {
        const isSuperAdmin = Boolean(userSession && String(userSession.role || '').toUpperCase().replace(/\s+/g, '_') === 'SUPER_ADMIN');
        const hasDevicesManage = isSuperAdmin || Boolean(userSession?.permissions?.includes('devices:manage'));
        if (!userSession || !hasDevicesManage) {
          return <UnauthorizedPage />;
        }
        return <DeviceTypesPage />;
      }
      case '/app/settings/qr':
      case '/app/qr-design': {
        const isSuperAdmin = Boolean(userSession && String(userSession.role || '').toUpperCase().replace(/\s+/g, '_') === 'SUPER_ADMIN');
        const hasSettingsManage = isSuperAdmin || Boolean(userSession?.permissions?.includes('settings:manage'));
        if (!userSession || !hasSettingsManage) {
          return <UnauthorizedPage />;
        }
        return <QrDesignSettingsPage />;
      }
      default:
        return <NotFoundPage onGoHome={() => navigate('/app')} />;
    }
  };

  return (
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          {isSuspended ? (
            <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col items-center justify-center p-6 text-center select-none animate-in fade-in duration-300">
              <div className="max-w-md w-full bg-white dark:bg-[#061f1c] rounded-3xl p-8 border border-gray-200 dark:border-red-950/40 shadow-xl space-y-6">
                <div className="w-16 h-16 rounded-2xl bg-red-50 dark:bg-red-950/30 flex items-center justify-center text-red-600 dark:text-red-400 mx-auto border border-red-100 dark:border-red-900/40">
                  <ShieldAlert className="w-8 h-8" />
                </div>
                <div className="space-y-2">
                  <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-[#daf1de]">
                    تم تجميد الحساب
                  </h1>
                  <p className="text-sm text-gray-500 dark:text-[#8eb698] leading-relaxed">
                    تم تعليق هذا الحساب من قِبل المشرف العام للمنظومة. يرجى تسجيل الخروج والاتصال بالإدارة للمزيد من التفاصيل.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="primary"
                  onClick={async () => {
                    await authService.logout();
                    setIsAuthenticated(false);
                    setUserSession(null);
                    setIsSuspended(false);
                    navigate('/login', true);
                  }}
                  className="w-full text-sm font-semibold h-11 bg-red-600 text-white border-red-600 hover:bg-red-700 cursor-pointer"
                >
                  تسجيل الخروج
                </Button>
              </div>
            </div>
          ) : isAuthenticated && !bootError && currentPath !== '/playground' ? (
            <AuthenticatedLayout
              currentPath={currentPath}
              userSession={userSession}
              onNavigate={(p) => navigate(p)}
            >
              {renderContent()}
            </AuthenticatedLayout>
          ) : (
            <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col">
              {isAuthenticated && !bootError && (
                <div className="bg-indigo-600 text-white text-xs py-1 px-4 text-center flex justify-between items-center">
                  <span>وضع المعاينة الهندسية للمنظومة</span>
                  <Button variant="outline" size="sm" className="bg-white/10 text-white border-white/20 text-xs h-7" onClick={() => navigate('/playground')}>
                    فتح مختبر التصميم (Playground)
                  </Button>
                </div>
              )}
              <div className="flex-1">{renderContent()}</div>
            </div>
          )}
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
