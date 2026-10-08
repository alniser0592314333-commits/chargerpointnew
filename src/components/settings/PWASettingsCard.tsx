import React, { useState } from 'react';
import { useI18n } from '../../i18n/i18nContext';
import { usePWAInstall } from '../../hooks/usePWAInstall';
import { authService } from '../../services/auth/authService';
import { Button } from '../ui/Button';
import {
  Download,
  Smartphone,
  CheckCircle2,
  AlertTriangle,
  X,
  LogOut,
  ShieldAlert,
  Info,
  AlertCircle,
  Sparkles,
} from 'lucide-react';

export const PWASettingsCard: React.FC = () => {
  const { locale } = useI18n();
  const { isInstallable, isInstalled, install } = usePWAInstall();

  const [showUnsupportedModal, setShowUnsupportedModal] = useState(false);
  const [showUninstallModal, setShowUninstallModal] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installSuccess, setInstallSuccess] = useState(false);

  const handleInstallClick = async () => {
    setInstallSuccess(false);
    setShowUnsupportedModal(false);

    if (isInstallable) {
      setIsInstalling(true);
      try {
        const success = await install();
        if (success) {
          setInstallSuccess(true);
        } else {
          setShowUnsupportedModal(true);
        }
      } catch (err) {
        console.warn('PWA Install trigger exception:', err);
        setShowUnsupportedModal(true);
      } finally {
        setIsInstalling(false);
      }
    } else {
      // beforeinstallprompt is not exposed by every browser. This is not proof
      // that the PWA itself is unsupported; the browser may expose installation
      // only through its own UI (notably Samsung Internet).
      setShowUnsupportedModal(true);
    }
  };

  const getInstallInstructions = () => {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
    const isSamsung = ua.includes('samsungbrowser');
    const isChrome = ua.includes('chrome') && !isSamsung;
    const isIOS = /iphone|ipad|ipod/.test(ua);

    if (locale === 'en') {
      if (isSamsung) {
        return {
          title: 'Install from Samsung Internet',
          body: 'Samsung Internet can install this PWA even when it does not expose the in-page installation prompt. Open the browser menu or use the Install icon / Add to Apps screen option.',
        };
      }
      if (isChrome) {
        return {
          title: 'Install from Google Chrome',
          body: 'Open the Chrome menu (⋮) and choose “Install app” or “Add to Home screen”. If Chrome shows an install icon in the address bar, you can use that as well.',
        };
      }
      if (isIOS) {
        return {
          title: 'Install on iPhone / iPad',
          body: 'Open this site in Safari, tap Share, then choose “Add to Home Screen”. iOS browsers do not expose the beforeinstallprompt API used by the in-page button.',
        };
      }
      return {
        title: 'Use your browser installation option',
        body: 'The browser did not expose the in-page installation prompt. Use its Install app / Add to Home screen option from the browser menu.',
      };
    }

    if (isSamsung) {
      return {
        title: 'التثبيت من Samsung Internet',
        body: 'متصفح Samsung Internet يستطيع تثبيت المنظومة حتى عندما لا يوفّر نافذة التثبيت داخل الصفحة. افتح قائمة المتصفح أو استخدم أيقونة التثبيت واختر إضافة إلى شاشة التطبيقات.',
      };
    }
    if (isChrome) {
      return {
        title: 'التثبيت من Google Chrome',
        body: 'افتح قائمة Chrome (⋮) واختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية». إذا ظهرت أيقونة التثبيت بجانب شريط العنوان يمكنك استخدامها مباشرة.',
      };
    }
    if (isIOS) {
      return {
        title: 'التثبيت على iPhone / iPad',
        body: 'افتح المنظومة في Safari، اضغط مشاركة، ثم اختر «إضافة إلى الشاشة الرئيسية». متصفحات iOS لا توفر واجهة beforeinstallprompt التي يعتمد عليها زر التثبيت داخل الصفحة.',
      };
    }
    return {
      title: 'استخدم خيار التثبيت في المتصفح',
      body: 'المتصفح الحالي لم يوفّر نافذة التثبيت داخل الصفحة. افتح قائمة المتصفح واستخدم خيار «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».',
    };
  };

  const handleConfirmUninstallAndExit = async () => {
    try {
      await authService.logout();
    } catch {
      // Ignore logout cleanup error
    } finally {
      try {
        localStorage.removeItem('supabase_auth_session');
        localStorage.removeItem('sys_auth_token');
      } catch {}
      window.location.href = '/';
    }
  };

  const installInstructions = getInstallInstructions();

  return (
    <div className="bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] rounded-2xl p-5 shadow-xs space-y-4 transition-colors mt-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-gray-100 dark:border-[#0f302b]">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-[#0c312b] flex items-center justify-center text-emerald-600 dark:text-[#8eb698] shrink-0 border border-emerald-100 dark:border-[#14423b]">
            <Smartphone className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-gray-900 dark:text-[#daf1de] flex items-center gap-2">
              {locale === 'en' ? 'Web App (PWA) Installation' : 'تثبيت المنظومة كتطبيق (Web App)'}
              {isInstalled ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-800 dark:bg-[#0e3a33] dark:text-[#8eb698]">
                  <CheckCircle2 className="w-3 h-3" />
                  {locale === 'en' ? 'Installed' : 'تطبيق مثبّت'}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 dark:bg-[#0c2a38] dark:text-blue-300">
                  <Info className="w-3 h-3" />
                  {locale === 'en' ? 'Browser Mode' : 'يعمل عبر المتصفح'}
                </span>
              )}
            </h3>
            <p className="text-xs text-gray-500 dark:text-[#8eb698] mt-0.5">
              {isInstalled
                ? locale === 'en'
                  ? 'The system is currently running as an official installed Web App on this device.'
                  : 'أنت تقوم حالياً بتشغيل المنظومة كتطبيق ويب مثبّت على هذا الجهاز.'
                : locale === 'en'
                  ? 'Install the system as a Web App on this device.'
                  : 'ثبّت المنظومة كتطبيق ويب على هذا الجهاز.'}
            </p>
          </div>
        </div>
      </div>

      {installSuccess && (
        <div className="flex items-center gap-2.5 p-3 rounded-xl bg-emerald-50 dark:bg-[#0e3a33] border border-emerald-200 dark:border-[#14423b] text-emerald-800 dark:text-[#a3e6be] text-xs font-semibold">
          <Sparkles className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span>
            {locale === 'en'
              ? 'Application installed successfully! You can now launch it directly from your home screen.'
              : 'تم تثبيت المنظومة بنجاح على جهازك! يمكنك الآن فتحها مباشرة من الشاشة الرئيسية.'}
          </span>
        </div>
      )}

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-1">
        <div className="text-xs text-gray-600 dark:text-[#8eb698] space-y-1">
          {isInstalled ? (
            <div className="flex items-center gap-1.5 text-emerald-700 dark:text-[#a3e6be] font-medium">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
              <span>
                {locale === 'en'
                  ? 'Application is active in standalone app mode.'
                  : 'التطبيق مثبّت ومفعّل ويعمل في نمط الشاشة المستقلة.'}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-gray-600 dark:text-[#8eb698]">
              <Download className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span>
                {locale === 'en'
                  ? 'Use the install button, or the browser install option if the browser does not expose an in-page prompt.'
                  : 'استخدم زر التثبيت، أو خيار التثبيت من المتصفح إذا لم يوفّر المتصفح نافذة التثبيت داخل الصفحة.'}
              </span>
            </div>
          )}
        </div>

        <div>
          {isInstalled ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowUninstallModal(true)}
              className="text-xs font-semibold border-red-200 dark:border-red-900/40 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer h-9 px-4 gap-1.5"
            >
              <LogOut className="w-3.5 h-3.5" />
              {locale === 'en' ? 'Uninstall & Exit System' : 'إلغاء التثبيت والخروج'}
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={handleInstallClick}
              disabled={isInstalling}
              className="text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer h-9 px-5 shadow-xs gap-2"
            >
              <Download className="w-4 h-4" />
              {isInstalling
                ? locale === 'en'
                  ? 'Installing...'
                  : 'جاري التثبيت...'
                : locale === 'en'
                  ? 'Install Application'
                  : 'تثبيت التطبيق'}
            </Button>
          )}
        </div>
      </div>

      {showUnsupportedModal && !isInstalled && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100 dark:border-[#0f302b]">
              <div className="flex items-center gap-2.5 text-amber-600 dark:text-amber-400">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <h3 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">
                  {installInstructions.title}
                </h3>
              </div>
              <button
                onClick={() => setShowUnsupportedModal(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-lg p-1 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs text-gray-700 dark:text-[#daf1de] leading-relaxed">
              <div className="bg-amber-50 dark:bg-[#1a2818] border border-amber-200 dark:border-amber-900/40 p-3.5 rounded-xl text-amber-900 dark:text-amber-300">
                <p className="font-semibold mb-1">
                  {locale === 'en'
                    ? 'The browser did not expose the in-page installation prompt.'
                    : 'المتصفح لم يوفّر نافذة التثبيت المباشر داخل الصفحة.'}
                </p>
                <p className="text-[11px] text-amber-800 dark:text-amber-400">
                  {installInstructions.body}
                </p>
              </div>
            </div>

            <div className="pt-2 flex justify-end">
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => setShowUnsupportedModal(false)}
                className="text-xs font-semibold px-4 h-8 bg-emerald-600 text-white cursor-pointer"
              >
                {locale === 'en' ? 'Understood' : 'فهمت ذلك'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showUninstallModal && isInstalled && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-red-600 dark:text-red-400 pb-3 border-b border-gray-100 dark:border-[#0f302b]">
              <div className="w-9 h-9 rounded-xl bg-red-50 dark:bg-red-950/50 flex items-center justify-center shrink-0">
                <ShieldAlert className="w-5 h-5 text-red-600 dark:text-red-400" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">
                  {locale === 'en' ? 'Uninstall & Exit Application' : 'إلغاء التثبيت والخروج'}
                </h3>
                <p className="text-xs text-gray-500 dark:text-[#8eb698]">
                  {locale === 'en' ? 'PWA Uninstall Protocol' : 'تعليمات إزالة تثبيت تطبيق الويب'}
                </p>
              </div>
            </div>

            <div className="space-y-3 text-xs text-gray-600 dark:text-[#8eb698] leading-relaxed">
              <div className="bg-amber-50 dark:bg-[#1a2818] border border-amber-200 dark:border-amber-900/40 p-3 rounded-xl text-amber-800 dark:text-amber-300 space-y-1">
                <p className="font-bold flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  {locale === 'en' ? 'Browser Security Note' : 'تنبيه أمان نظام التشغيل:'}
                </p>
                <p>
                  {locale === 'en'
                    ? 'Websites cannot remove installed apps from the operating system directly.'
                    : 'بسبب سياسات الأمان في أنظمة التشغيل، لا تملك مواقع الويب صلاحية إزالة التطبيق المثبت من نظام التشغيل مباشرة.'}
                </p>
              </div>

              <div className="space-y-2 bg-gray-50 dark:bg-[#041714] p-3 rounded-xl border border-gray-100 dark:border-[#123832]">
                <p className="font-semibold text-gray-900 dark:text-[#daf1de]">
                  {locale === 'en' ? 'To uninstall the application:' : 'لإلغاء تثبيت التطبيق من جهازك:'}
                </p>
                <ul className="list-disc list-inside space-y-1.5 text-gray-700 dark:text-[#8eb698]">
                  <li>
                    <strong>{locale === 'en' ? 'Android / iPhone:' : 'الهواتف (Android / iPhone):'}</strong>{' '}
                    {locale === 'en'
                      ? 'Long-press the app icon and choose Uninstall / Remove App.'
                      : 'اضغط مطولاً على أيقونة التطبيق واختر إلغاء التثبيت / إزالة التطبيق.'}
                  </li>
                  <li>
                    <strong>{locale === 'en' ? 'Desktop:' : 'الكمبيوتر:'}</strong>{' '}
                    {locale === 'en'
                      ? 'Open the installed app menu and choose Uninstall.'
                      : 'افتح قائمة التطبيق المثبت واختر إلغاء التثبيت.'}
                  </li>
                </ul>
              </div>

              <p className="text-gray-500 dark:text-[#8eb698]">
                {locale === 'en'
                  ? 'The button below only logs you out and exits the system.'
                  : 'زر الخروج أدناه يقوم فقط بتسجيل الخروج وإنهاء الجلسة.'}
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100 dark:border-[#0f302b]">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowUninstallModal(false)}
                className="text-xs h-8 font-medium cursor-pointer"
              >
                {locale === 'en' ? 'Cancel' : 'إلغاء'}
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={handleConfirmUninstallAndExit}
                className="text-xs h-8 font-bold bg-red-600 hover:bg-red-700 text-white cursor-pointer gap-1.5"
              >
                <LogOut className="w-3.5 h-3.5" />
                {locale === 'en' ? 'Logout & Exit' : 'تسجيل الخروج والخروج'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
