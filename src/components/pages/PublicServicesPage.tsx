import React from 'react';
import { CircleHelp, Languages, Moon, Sun, Wallet, LockKeyhole, Settings, X } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';
import './public-services.css';

type Props = { onBack?: () => void; onOpenWallet?: () => void };
const DEVELOPMENT_ACCESS_CODE = 'CPN-DEV-7264';
const DEVELOPMENT_ACCESS_KEY = 'cpn-services-dev-access';

/**
 * Public catalogue of customer-facing assistance services.
 * The wallet card delegates navigation to the host app; authentication and wallet operations remain in their existing flows.
 */
export const PublicServicesPage: React.FC<Props> = ({ onOpenWallet }) => {
  const { locale, setLocale } = useI18n();
  const { resolvedTheme, toggleTheme } = useTheme();
  const isAr = locale === 'ar';
  const t = (ar: string, en: string) => isAr ? ar : en;

  if (!unlocked) {
    return (
      <main className="public-services-page flex min-h-screen items-center justify-center px-4 py-10 text-slate-800 dark:text-slate-100" dir={isAr ? 'rtl' : 'ltr'}>
        <section className="public-services-shell w-full max-w-md rounded-3xl p-6 sm:p-8">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-teal-700/10 text-teal-800 dark:text-teal-200"><LockKeyhole size={25} /></div>
          <p className="mt-5 text-center text-xs font-extrabold uppercase tracking-[0.18em] text-teal-700 dark:text-teal-300">{t('وضع التطوير', 'DEVELOPMENT MODE')}</p>
          <h1 className="mt-2 text-center text-2xl font-extrabold">{t('خدمات مساعدة — قيد التطوير', 'Assistance Services — Under Development')}</h1>
          <p className="mt-3 text-center text-sm leading-7 text-slate-600 dark:text-slate-300">{t('هذه الصفحة قيد التطوير وغير متاحة للزوار حاليًا. أدخل كود التطوير للمتابعة.', 'This page is under development and is not available to visitors yet. Enter the development code to continue.')}</p>
          <form className="mt-6 grid gap-3" onSubmit={event => { event.preventDefault(); if (code.trim() !== DEVELOPMENT_ACCESS_CODE) { setCodeError(t('كود التطوير غير صحيح.', 'Incorrect development code.')); return; } try { window.sessionStorage.setItem(DEVELOPMENT_ACCESS_KEY, '1'); } catch {} setCodeError(''); setUnlocked(true); }}>
            <label className="grid gap-2 text-sm font-semibold">{t('كود التطوير', 'Development code')}<input type="password" autoComplete="off" required value={code} onChange={event => setCode(event.target.value)} className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 dark:border-white/15 dark:bg-[#071a1d]" /></label>
            {codeError && <p role="alert" className="text-sm text-rose-600 dark:text-rose-300">{codeError}</p>}
            <button type="submit" className="rounded-xl bg-teal-700 px-5 py-3 text-sm font-bold text-white">{t('دخول إلى وضع التطوير', 'Enter development mode')}</button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main
      className="public-services-page min-h-screen px-4 pb-12 pt-5 text-slate-800 transition-colors duration-300 dark:text-slate-100 sm:px-6 sm:pt-8"
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
          <div className="relative shrink-0">
            <button type="button" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)} className="public-services-control inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-bold transition hover:-translate-y-0.5">
              {settingsOpen ? <X size={15} /> : <Settings size={15} />}<span>{t('الإعدادات', 'Settings')}</span>
            </button>
            {settingsOpen && <section className="absolute end-0 top-11 z-30 w-64 rounded-2xl border border-slate-200 bg-white p-4 shadow-xl dark:border-white/10 dark:bg-[#0b2420]">
              <h2 className="mb-3 text-xs font-extrabold uppercase tracking-wide text-slate-500 dark:text-slate-400">{t('التفضيلات الشخصية', 'Personal Preferences')}</h2>
              <div className="grid gap-2">
                <button type="button" onClick={() => setLocale(isAr ? 'en' : 'ar')} className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm font-semibold hover:bg-slate-100 dark:hover:bg-white/5"><Languages size={16} />{t('اللغة', 'Language')}<span className="ms-auto text-xs">{isAr ? 'EN' : 'عربي'}</span></button>
                <button type="button" onClick={toggleTheme} className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm font-semibold hover:bg-slate-100 dark:hover:bg-white/5">{resolvedTheme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}{resolvedTheme === 'dark' ? t('الوضع الفاتح', 'Light mode') : t('الوضع الداكن', 'Dark mode')}</button>
              </div>
            </section>}
          </div>
        </header>

        <section className="mt-8 sm:mt-12" aria-labelledby="public-services-title">
          <div className="mb-5 max-w-2xl">
            <p className="public-services-eyebrow text-xs font-bold uppercase tracking-[0.18em]">{t('بوابتك للخدمات', 'YOUR SERVICE HUB')}</p>
            <h2 id="public-services-title" className="mt-2 text-2xl font-extrabold tracking-tight sm:text-3xl">
              {t('اختَر الخدمة التي تحتاجها', 'Choose the service you need')}
            </h2>
            <p className="mt-3 text-sm leading-7 text-slate-600 dark:text-slate-300 sm:text-base">
              {t('نعمل على توفير خدمات مساعدة إضافية في مكان واحد. الخدمات المعروضة هنا للتعريف بها فقط حالياً.', 'We are bringing helpful services together in one place. The service shown here is currently for information only.')}
            </p>
          </div>

          <article className="public-wallet-card group relative overflow-hidden rounded-3xl p-5 sm:p-7">
            <div className="public-wallet-orb public-wallet-orb-one" aria-hidden="true" />
            <div className="public-wallet-orb public-wallet-orb-two" aria-hidden="true" />
            <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center sm:gap-7">
              <div className="public-wallet-mark grid h-20 w-20 shrink-0 place-items-center rounded-[1.65rem] sm:h-24 sm:w-24" aria-hidden="true">
                <Wallet size={43} strokeWidth={1.55} />
                <span className="public-wallet-mark-dot" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-xl font-extrabold sm:text-2xl">{t('إدارة المحافظ', 'Wallet Management')}</h3>
                  <span className="public-services-coming rounded-full px-3 py-1 text-[11px] font-bold">{t('قريباً', 'Coming soon')}</span>
                </div>
                <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-600 dark:text-slate-300 sm:text-base">
                  {t('خدمة مخصصة لإدارة المحفظة الإلكترونية ومتابعة تفاصيلها. سيتم توفير وظائف الخدمة لاحقاً.', 'A dedicated service for managing an electronic wallet and viewing its details. Service functionality will be introduced later.')}
                </p>
                <div className="mt-5">
                  <button type="button" onClick={() => onOpenWallet?.()} className="public-wallet-action inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold transition hover:-translate-y-0.5">
                    <Wallet size={17} />
                    {t('إدارة المحافظ', 'Wallet Management')}
                  </button>
                </div>
              </div>
              <div className="public-wallet-decoration hidden shrink-0 sm:grid" aria-hidden="true">
                <div className="public-wallet-mini-card"><span /><span /><span /></div>
                <div className="public-wallet-mini-line" />
              </div>
            </div>
          </article>
        </section>

        <footer className="mt-10 text-center text-xs text-slate-500 dark:text-slate-400">
          {t('نقطة الشحن · خدمات مساعدة', 'Charging Point · Assistance Services')}
        </footer>
      </div>
    </main>
  );
};

export default PublicServicesPage;
