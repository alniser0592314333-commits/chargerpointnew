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
  const { locale, t } = useI18n();
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
        }
      } catch (err) {
        console.warn('PWA Install trigger exception:', err);
        setShowUnsupportedModal(true);
      } finally {
        setIsInstalling(false);
      }
    } else {
      // Browser/environment does not support direct beforeinstallprompt trigger
      setShowUnsupportedModal(true);
    }
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

  return (
    <div className="bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] rounded-2xl p-5 shadow-xs space-y-4 transition-colors mt-6">
      {/* 1. Card Header */}
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
                  : 'أنت تقوم حالياً بتشغيل المنظومة مباشرة كتطبيق ويب كلي مثبّت على هذا الجهاز.'
                : locale === 'en'
                  ? 'Click the install button to install directly to your device home screen.'
                  : 'اضغط على زر التثبيت أدناه لتنزيل المنظومة وتثبيتها مباشرة على جهازك.'}
            </p>
          </div>
        </div>
      </div>

      {/* 2. Success Notification Banner */}
      {installSuccess && (
        <div className="flex items-center gap-2.5 p-3 rounded-xl bg-emerald-50 dark:bg-[#0e3a33] border border-emerald-200 dark:border-[#14423b] text-emerald-800 dark:text-[#a3e6be] text-xs font-semibold">
          <Sparkles className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span>
            {locale === 'en'
              ? 'Application installed successfully! You can now launch it directly from your home screen.'
              : 'تم تثبيت المنظومة بنجاح على جهازك! يمكنك الآن فتحها واستخدامها مباشرة من الشاشة الرئيسية.'}
          </span>
        </div>
      )}

      {/* 3. Action Area */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-1">
        <div className="text-xs text-gray-600 dark:text-[#8eb698] space-y-1">
          {isInstalled ? (
            <div className="flex items-center gap-1.5 text-emerald-700 dark:text-[#a3e6be] font-medium">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
              <span>
                {locale === 'en'
                  ? 'Application is active in standalone app mode.'
                  : 'التطبيق مثبّت ومفعّل ويعمل في نمط الشاشة المستقلة (Standalone Mode).'}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-gray-600 dark:text-[#8eb698]">
              <Download className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span>
                {locale === 'en'
                  ? 'Click install to begin automatic direct installation.'
                  : 'اضغط على زر التثبيت ليبدأ التنزيل والتثبيت المباشر فوراً على جهازك.'}
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
              {locale === 'en' ? 'Uninstall & Exit System' : 'إلغاء التثبيت وتنسيق الجلسة'}
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

      {/* 4. Modal: Unsupported Browser / Environment Modal */}
      {showUnsupportedModal && !isInstalled && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100 dark:border-[#0f302b]">
              <div className="flex items-center gap-2.5 text-amber-600 dark:text-amber-400">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <h3 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">
                  {locale === 'en'
                    ? 'Direct Installation Unsupported'
                    : 'المتصفح الحالي لا يدعم التثبيت المباشر التلقائي'}
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
                    ? 'Your current browser or preview window does not support direct automatic Web App installation.'
                    : 'عفواً، المتصفح الحالي أو نافذة المعاينة الحالية لا تدعم إطلاق التثبيت المباشر التلقائي لبرامج الويب (PWA).'}
                </p>
                <p className="text-[11px] text-amber-800 dark:text-amber-400">
                  {locale === 'en'
                    ? 'Please open the link directly in Google Chrome, Microsoft Edge, or Samsung Internet to enable direct 1-click installation.'
                    : 'لتشغيل التثبيت التلقائي الفوري بضغطة زر، يرجى فتح رابط المنظومة مباشرة في متصفح جوجل كروم (Google Chrome) أو مايكروسوفت إيدج (Microsoft Edge).'}
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

      {/* 5. Modal: Uninstall Confirmation Modal */}
      {showUninstallModal && isInstalled && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-red-600 dark:text-red-400 pb-3 border-b border-gray-100 dark:border-[#0f302b]">
              <div className="w-9 h-9 rounded-xl bg-red-50 dark:bg-red-950/50 flex items-center justify-center shrink-0">
                <ShieldAlert className="w-5 h-5 text-red-600 dark:text-red-400" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">
                  {locale === 'en' ? 'Uninstall & Exit Application' : 'إلغاء التثبيت وتنسيق النظام'}
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
                  بسبب سياسات الأمان في أنظمة التشغيل (Android / iOS / Windows)، لا تملك مواقع الويب صلاحية إزالة ملفات التطبيقات المثبتة من نظام التشغيل مباشرة.
                </p>
              </div>

              <div className="space-y-2 bg-gray-50 dark:bg-[#041714] p-3 rounded-xl border border-gray-100 dark:border-[#123832]">
                <p className="font-semibold text-gray-900 dark:text-[#daf1de]">
                  لإلغاء التثبيت وحذف التطبيق من جهازك نهائياً:
                </p>
                <ul className="list-disc list-inside space-y-1.5 text-gray-700 dark:text-[#8eb698]">
                  <li>
                    <strong>على الهواتف (Android / iPhone):</strong> اضغط مطولاً على أيقونة التطبيق في الشاشة الرئيسية ثم اختر <strong>إلغاء التثبيت (Uninstall / Remove App)</strong>.
                  </li>
                  <li>
                    <strong>على الكمبيوتر (Chrome / Edge):</strong> انقر على النقاط الثلاث في أعلى نافذة التطبيق ثم اختر <strong>إلغاء تثبيت التطبيق (Uninstall)</strong>.
                  </li>
                </ul>
              </div>

              <p className="text-gray-500 dark:text-[#8eb698]">
                الضغط على زر الخروج أدناه سيقوم بتسجيل الخروج من حسابك، إنهاء الجلسة بأمان، وطردك للصفحة الرئيسية.
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
                {locale === 'en' ? 'Logout & Exit' : 'تسجيل الخروج وطرد الجلسة'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
