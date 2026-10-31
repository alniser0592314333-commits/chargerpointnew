import React from 'react';
import { CircleHelp, Languages, Moon, Sun, Wallet, ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';
import './public-services.css';

type Props = { onBack?: () => void; onOpenWallet?: () => void };

/**
 * Compact public catalogue of customer-facing assistance services.
 * Wallet navigation stays delegated to the host app and its existing guarded route.
 */
export const PublicServicesPage: React.FC<Props> = ({ onOpenWallet }) => {
  const { locale, setLocale } = useI18n();
  const { resolvedTheme, toggleTheme } = useTheme();
  const isAr = locale === 'ar';
  const t = (ar: string, en: string) => isAr ? ar : en;

  return (
    <main
      className="public-services-page min-h-screen px-4 pb-10 pt-4 text-slate-800 transition-colors duration-300 dark:text-slate-100 sm:px-6 sm:pt-6"
      dir={isAr ? 'rtl' : 'ltr'}
    >
      <div className="public-services-shell mx-auto max-w-5xl">
        <header className="public-services-header flex flex-nowrap items-center justify-between gap-3 rounded-2xl px-3 py-2.5 sm:px-5 sm:py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="public-services-header-icon grid h-9 w-9 shrink-0 place-items-center rounded-xl" aria-hidden="true">
              <CircleHelp size={19} strokeWidth={1.9} />
            </span>
            <div className="min-w-0">
              <h1 className="text-base font-extrabold tracking-tight sm:text-lg">{t('خدمات مساعدة', 'Assistance Services')}</h1>
              <p className="hidden text-[11px] text-slate-500 dark:text-slate-400 sm:block">{t('خدمات إضافية متاحة لك', 'Additional services available to you')}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2" aria-label={t('إعدادات العرض', 'Display settings')}>
            <button
              type="button"
              onClick={() => setLocale(isAr ? 'en' : 'ar')}
              className="public-services-control inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-bold transition hover:-translate-y-0.5"
              aria-label={t('Switch language to English', 'تغيير اللغة إلى العربية')}
              title={t('English', 'العربية')}
            >
              <Languages size={15} />
              <span>{isAr ? 'EN' : 'عربي'}</span>
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              className="public-services-control grid h-9 w-9 place-items-center rounded-lg transition hover:-translate-y-0.5"
              aria-label={resolvedTheme === 'dark' ? t('التبديل للوضع النهاري', 'Switch to light mode') : t('التبديل للوضع الليلي', 'Switch to dark mode')}
              title={resolvedTheme === 'dark' ? t('الوضع النهاري', 'Light mode') : t('الوضع الليلي', 'Dark mode')}
            >
              {resolvedTheme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>
        </header>

        <section className="mt-5 sm:mt-7" aria-labelledby="public-services-title">
          <div className="mb-5 max-w-2xl">
            <h2 id="public-services-title" className="text-2xl font-extrabold tracking-tight sm:text-3xl">
              {t('اختر الخدمة التي تحتاجها', 'Choose the service you need')}
            </h2>
            <p className="mt-2 text-sm leading-7 text-slate-600 dark:text-slate-300 sm:text-base">
              {t('نعمل على توفير خدمات مساعدة إضافية في مكان واحد. الخدمات المعروضة هنا للتعريف بها فقط حالياً.', 'We are bringing helpful services together in one place. The service shown here is currently for information only.')}
            </p>
          </div>

          <button
            type="button"
            onClick={() => onOpenWallet?.()}
            className="public-wallet-shortcut group flex w-full items-center gap-3 rounded-2xl p-3 text-start transition sm:max-w-md sm:gap-4 sm:p-4"
            aria-label={t('فتح إدارة المحافظ', 'Open Wallet Management')}
          >
            <span className="public-wallet-shortcut-icon grid h-12 w-12 shrink-0 place-items-center rounded-xl sm:h-14 sm:w-14" aria-hidden="true">
              <Wallet size={26} strokeWidth={1.7} />
            </span>
            <span className="min-w-0 flex-1 text-base font-bold sm:text-lg">
              {t('إدارة المحافظ', 'Wallet Management')}
            </span>
            {isAr
              ? <ChevronLeft className="public-wallet-shortcut-arrow shrink-0" size={19} aria-hidden="true" />
              : <ChevronRight className="public-wallet-shortcut-arrow shrink-0" size={19} aria-hidden="true" />}
          </button>
        </section>

        <footer className="mt-8 text-center text-xs text-slate-500 dark:text-slate-400">
          {t('نقطة الشحن · خدمات مساعدة', 'Charging Point · Assistance Services')}
        </footer>
      </div>
    </main>
  );
};

export default PublicServicesPage;
