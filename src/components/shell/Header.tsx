import React, { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../i18n/i18nContext';
import { AppLogo } from '../qr/AppLogo';
import { useActiveLogo } from '../../services/storage/logoStorage';
import { localDb } from '../../infrastructure/localDb/localDb';
import { syncEventEmitter } from '../../infrastructure/sync/syncEngine';
import { globalSyncBridge } from '../../infrastructure/sync/syncBridge';
import { RefreshCw, CheckCircle2, Clock, AlertCircle, WifiOff, Download } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { getPWAInstallState, promptPWAInstall, subscribePWAInstall } from '../../services/pwaInstallService';

export interface HeaderProps {
  onOpenMobileNav: () => void;
  currentPath: string;
  notificationCount?: number;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenMobileNav,
  currentPath,
  notificationCount = 0,
}) => {
  const { locale, t } = useI18n();
  const activeLogo = useActiveLogo();
  const [pwaInstallState, setPwaInstallState] = useState(() => getPWAInstallState());

  // The authenticated admin header has its own PWA install action. Public
  // customer pages use their separate entry point and install experience.
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    setPwaInstallState(getPWAInstallState());
    return subscribePWAInstall(() => setPwaInstallState(getPWAInstallState()));
  }, []);

  const handleInstallAdminPWA = async () => {
    if (pwaInstallState.installable) {
      try {
        await promptPWAInstall();
      } catch (error) {
        console.warn('Admin PWA install prompt failed.', error);
      }
      return;
    }

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const message = isIOS
      ? (locale === 'ar'
          ? 'لتثبيت نقطة الشحن كتطبيق: اضغط مشاركة في Safari ثم اختر «إضافة إلى الشاشة الرئيسية».'
          : 'To install Charging Point as an app, tap Share in Safari, then choose “Add to Home Screen”.')
      : (locale === 'ar'
          ? 'التثبيت المباشر غير متاح من المتصفح الحالي. افتح التطبيق في Chrome، ثم من القائمة اختر «تثبيت التطبيق» وليس «إنشاء اختصار».'
          : 'Direct installation is unavailable in this browser. Open the app in Chrome, then choose “Install app” from the menu—not “Create shortcut”.');
    window.alert(message);
  };

  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [outboxRecords, setOutboxRecords] = useState<any[]>([]);

  // Monitor network connectivity
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      globalSyncBridge.notifyOutboxWorkAvailable().catch(() => {});
    };
    const handleOffline = () => setIsOnline(false);

    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      }
    };
  }, []);

  const refreshSyncData = useCallback(async () => {
    try {
      const outbox = await localDb.listOutbox();
      setOutboxRecords(outbox);
    } catch (err) {
      console.warn('Header failed to load sync data:', err);
    }
  }, []);

  // Subscribe to sync events & fast interval for instant UI reactivity
  useEffect(() => {
    refreshSyncData();

    const unsubscribe = syncEventEmitter.subscribe((evt) => {
      if (evt.type === 'sync_started') {
        setIsSyncing(true);
      } else if (evt.type === 'sync_finished') {
        setIsSyncing(false);
        refreshSyncData();
      } else {
        refreshSyncData();
      }
    });

    // 2-second fast polling to guarantee immediate sync state reflection
    const interval = setInterval(() => {
      refreshSyncData();
    }, 2000);

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [refreshSyncData]);

  // Derived Metrics & State
  const pendingCount = outboxRecords.filter(
    (i) => i.status === 'pending' || i.status === 'blocked'
  ).length;

  const syncingCount = outboxRecords.filter(
    (i) => i.status === 'syncing'
  ).length;

  const activeFailedCount = outboxRecords.filter(
    (i) => i.status === 'rejected' || i.status === 'conflict'
  ).length;

  const deriveState = (): 'OFFLINE' | 'SYNCING' | 'PENDING' | 'FAILED' | 'SYNCED' => {
    if (!isOnline) return 'OFFLINE';
    if (isSyncing || syncingCount > 0) return 'SYNCING';
    if (pendingCount > 0) return 'PENDING';
    if (activeFailedCount > 0) return 'FAILED';
    return 'SYNCED';
  };

  const activeState = deriveState();

  const handleManualSyncClick = async () => {
    if (isSyncing || !isOnline) return;
    setIsSyncing(true);
    try {
      await globalSyncBridge.requestManualSync();
    } catch (e) {
      console.warn('Manual sync trigger error:', e);
    } finally {
      setIsSyncing(false);
      refreshSyncData();
    }
  };

  const getBadgeStyle = () => {
    switch (activeState) {
      case 'OFFLINE':
        return {
          label: locale === 'ar' ? 'يعمل دون إنترنت' : 'Offline',
          icon: <WifiOff className="w-3 h-3 shrink-0" />,
          classes: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 border border-gray-300 dark:border-gray-700',
        };
      case 'SYNCING':
        return {
          label: locale === 'ar' ? 'جاري المزامنة...' : 'Syncing...',
          icon: <RefreshCw className="w-3 h-3 animate-spin shrink-0" />,
          classes: 'bg-purple-100 dark:bg-purple-950/60 text-purple-800 dark:text-purple-300 border border-purple-200 dark:border-purple-800/40 animate-pulse',
        };
      case 'PENDING':
        return {
          label:
            locale === 'ar'
              ? pendingCount > 1
                ? `معلق (${pendingCount})`
                : 'معلق'
              : pendingCount > 1
              ? `Pending (${pendingCount})`
              : 'Pending',
          icon: <Clock className="w-3 h-3 shrink-0" />,
          classes: 'bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800/40',
        };
      case 'FAILED':
        return {
          label: locale === 'ar' ? 'خطأ مزامنة' : 'Sync Error',
          icon: <AlertCircle className="w-3 h-3 shrink-0" />,
          classes: 'bg-rose-100 dark:bg-rose-950/60 text-rose-800 dark:text-rose-300 border border-rose-200 dark:border-rose-800/40',
        };
      case 'SYNCED':
      default:
        return {
          label: locale === 'ar' ? 'متزامن' : 'Synced',
          icon: <CheckCircle2 className="w-3 h-3 shrink-0 text-emerald-600 dark:text-[#7ae09e]" />,
          classes: 'bg-emerald-100 dark:bg-[#0d362f] text-emerald-800 dark:text-[#8eb698] border border-emerald-200 dark:border-[#194e44]',
        };
    }
  };

  const badge = getBadgeStyle();

  // Keep the product brand fixed in the shared header, independent of the active page.
  const brandTitle = locale === 'ar' ? 'نقطة الشحن' : 'Charging Point';

  return (
    <header className="bg-white dark:bg-[#072420] border-b border-gray-200 dark:border-[#123d37] px-4 py-2.5 sm:py-3 transition-colors sticky top-0 z-30 shadow-2xs">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-3">
        {/* 1. Identity & Navigation Zone: Clickable Logo opens Menu + Displays Current Page Title */}
        <div className="flex items-center min-w-0">
          <button
            type="button"
            onClick={onOpenMobileNav}
            aria-label={activeLogo.name ? `${activeLogo.name} - ${brandTitle}` : brandTitle}
            title={activeLogo.name || t('systemManagementTitle')}
            className="flex items-center gap-2.5 shrink-0 cursor-pointer p-1.5 -ms-1.5 rounded-xl hover:bg-gray-100 dark:hover:bg-[#0c312b] transition-all select-none"
            data-testid="header-brand-identity"
          >
            <span className="relative inline-flex shrink-0">
              <AppLogo size={32} variant="auto" className="shrink-0" />
              {notificationCount > 0 && <span data-testid="header-notification-badge" aria-label={(locale === 'ar' ? 'إشعارات غير مقروءة: ' : 'Unread notifications: ') + notificationCount} className="absolute -end-1 -top-1 inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full border-2 border-white bg-rose-600 px-1 text-[9px] font-extrabold leading-none text-white dark:border-[#072420]">{notificationCount > 99 ? '99+' : notificationCount}</span>}
            </span>
            <span className="font-bold text-sm sm:text-base text-gray-900 dark:text-[#daf1de] tracking-tight truncate max-w-[200px] sm:max-w-[300px]">
              {brandTitle}
            </span>
          </button>
        </div>

        {/* 2. Sync Status & Practical Action Zone */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {/* Admin-only install action: icon-only, hidden in native/standalone app. */}
          {!Capacitor.isNativePlatform() &&
            !pwaInstallState.installed && (
              <button
                type="button"
                onClick={() => void handleInstallAdminPWA()}
                aria-label={locale === 'ar' ? 'تثبيت تطبيق الإدارة' : 'Install admin app'}
                title={locale === 'ar' ? 'تثبيت تطبيق الإدارة' : 'Install admin app'}
                className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-gray-200 text-gray-700 transition hover:bg-gray-100 active:scale-95 dark:border-[#194e44] dark:text-[#daf1de] dark:hover:bg-[#0c312b]"
                data-testid="admin-pwa-install"
              >
                <Download className="h-[18px] w-[18px]" aria-hidden="true" />
              </button>
            )}

          {/* Sync Status Badge */}
          <div className="flex items-center" data-testid="header-sync-status">
            <button
              type="button"
              onClick={handleManualSyncClick}
              disabled={isSyncing || !isOnline}
              title={
                locale === 'ar'
                  ? 'انقر لتحديث المزامنة يدوياً'
                  : 'Click to trigger manual sync'
              }
              className={`text-xs px-2.5 py-1 rounded-full font-medium inline-flex items-center gap-1.5 cursor-pointer hover:opacity-90 active:scale-95 transition-all select-none ${badge.classes}`}
            >
              {badge.icon}
              <span>{badge.label}</span>
            </button>
          </div>

        </div>
      </div>
    </header>
  );
};
