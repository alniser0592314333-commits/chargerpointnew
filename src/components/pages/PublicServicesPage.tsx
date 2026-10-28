import React, { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Fingerprint, ShieldCheck, Wallet, LoaderCircle, LockKeyhole } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';
import { callCustomerAccount, customerAuth, setCustomerSession } from '../../services/customer/customerAuth';
import { getAccountBiometricStatus, isNativeBiometricAvailable, loginWithAccountBiometric } from '../../services/auth/accountBiometric';

type Props = { onBack: () => void; onOpenWallet: () => void };
export const PublicServicesPage: React.FC<Props> = ({ onBack, onOpenWallet }) => {
  const { locale, setLocale } = useI18n();
  const { resolvedTheme, toggleTheme } = useTheme();
  const isAr = locale === 'ar';
  const [hasSession, setHasSession] = useState(false);
  const [password, setPassword] = useState('');
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricReady, setBiometricReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState('');
  const t = (ar: string, en: string) => isAr ? ar : en;

  useEffect(() => {
    let active = true;
    void customerAuth.auth.getSession().then(async (session) => {
      const token = session.data.session?.access_token || '';
      const [available, status] = await Promise.all([isNativeBiometricAvailable(), token ? getAccountBiometricStatus(token).catch(() => ({ enrolled: false })) : Promise.resolve({ enrolled: false })]);
        if (!active) return;
        setHasSession(Boolean(session.data.session?.access_token));
        setBiometricAvailable(available);
      setBiometricReady(Boolean(status.enrolled));
    }).catch(() => { if (active) setHasSession(false); });
    return () => { active = false; };
  }, []);

  const verify = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (!hasSession) {
        setError(t('سجّل الدخول لحساب العميل من صفحة حسابي أولًا، ثم ارجع إلى خدمات المساعدة.', 'Sign in through the customer account page first, then return to assistance services.'));
        return;
      }
      if (biometricAvailable && biometricReady) {
        const result = await loginWithAccountBiometric('customer');
        const biometricSession = result.session as { access_token: string; refresh_token: string } | undefined;
        if (!biometricSession?.access_token || !biometricSession.refresh_token) {
          setError(t('لم يتم تأكيد الهوية بالبصمة. حاول مرة ثانية.', 'Biometric verification was not completed. Try again.'));
          return;
        }
        const sessionError = await setCustomerSession(biometricSession);
        if (sessionError) {
          setError(t('تعذّر تحديث الجلسة الآمنة.', 'Could not update the secure session.'));
          return;
        }
      }
      const session = await customerAuth.auth.getSession();
      if (!session.data.session?.access_token) {
        setHasSession(false);
        setError(t('انتهت الجلسة. سجّل الدخول من جديد.', 'Your session expired. Sign in again.'));
        return;
      }
      const response = await callCustomerAccount<{ must_change_password?: boolean }>('verify-session', {}, session.data.session.access_token);
      if (response.error || !response.data || response.data.must_change_password) {
        setError(t('الجلسة غير صالحة لفتح الخدمات. سجّل الدخول مجددًا.', 'This session cannot access services. Sign in again.'));
        return;
      }
      setVerified(true);
    } catch {
      setError(t('تعذّر التحقق الآن. تأكد من الاتصال وحاول مجددًا.', 'Could not verify right now. Check your connection and try again.'));
    } finally { setBusy(false); }
  };

  return <div className="min-h-screen bg-[#f5f7f8] text-slate-900 dark:bg-[#071a1d] dark:text-slate-100" dir={isAr ? 'rtl' : 'ltr'}>
    <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/90 backdrop-blur-xl dark:border-white/10 dark:bg-[#071a1d]/90"><div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
      <button onClick={onBack} className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold">{isAr ? <ArrowRight size={18} /> : <ArrowLeft size={18} />}{t('رجوع', 'Back')}</button>
      <div className="flex items-center gap-2"><button onClick={() => setLocale(isAr ? 'en' : 'ar')} className="rounded-xl px-3 py-2 text-xs font-bold">{isAr ? 'EN' : 'عربي'}</button><button onClick={toggleTheme} className="rounded-xl px-3 py-2 text-xs font-bold">{resolvedTheme === 'dark' ? '☀️' : '🌙'}</button></div>
    </div></header>
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12"><section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-[#0b2427] sm:p-9">
      <p className="text-xs font-bold tracking-[0.2em] text-teal-700 dark:text-teal-300">{t('بوابة العملاء', 'CUSTOMER SERVICES')}</p><h1 className="mt-3 text-3xl font-extrabold">{t('خدمات مساعدة', 'Assistance services')}</h1>
      <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600 dark:text-slate-300">{t('منطقة مستقلة لخدماتك الإضافية. لازم نتحقق من جلسة حسابك قبل عرض الخدمات.', 'A separate area for additional services. We verify your customer session before displaying services.')}</p>
      {!verified && <div className="mt-7 max-w-lg border-t border-slate-200 pt-6 dark:border-white/10"><div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-2xl bg-teal-50 text-teal-800 dark:bg-teal-300/10 dark:text-teal-200">{biometricAvailable && biometricReady ? <Fingerprint size={22} /> : <LockKeyhole size={22} />}</span><div><h2 className="font-bold">{t('تأكيد الهوية', 'Verify your identity')}</h2><p className="mt-1 text-xs text-slate-500">{biometricAvailable && biometricReady ? t('استخدم البصمة المسجلة على جهازك.', 'Use the biometric method enrolled on this device.') : t('يلزم تسجيل الدخول إلى حساب العميل بجلسة فعّالة.', 'An active customer account session is required.')}</p></div></div>
        {!hasSession && <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-300/10 dark:text-amber-100">{t('ما في جلسة عميل فعّالة. ارجع لحسابي وسجّل الدخول أولًا.', 'No active customer session. Return to My Account and sign in first.')}</p>}
        {error && <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-400/10 dark:text-rose-200">{error}</p>}
        <button onClick={() => void verify()} disabled={busy || !hasSession} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-teal-700 px-5 py-3.5 text-sm font-bold text-white disabled:opacity-50">{busy ? <LoaderCircle size={17} className="animate-spin" /> : <ShieldCheck size={17} />}{busy ? t('جارٍ التحقق…', 'Verifying…') : t('تأكيد وفتح الخدمات', 'Verify and continue')}</button>
      </div>}
      {verified && <div className="mt-7 border-t border-slate-200 pt-6 dark:border-white/10"><div className="flex items-center gap-2 text-sm font-bold text-emerald-700 dark:text-emerald-300"><ShieldCheck size={18} />{t('تم تأكيد الجلسة', 'Session verified')}</div><h2 className="mt-5 text-lg font-bold">{t('الخدمات المتاحة', 'Available services')}</h2>
        <button onClick={onOpenWallet} className="mt-4 flex w-full items-center gap-4 rounded-2xl border border-slate-200 p-4 text-start transition hover:border-teal-500 hover:bg-teal-50/60 dark:border-white/10 dark:hover:bg-teal-300/5"><span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-teal-700 text-white"><Wallet size={23} /></span><span className="min-w-0 flex-1"><strong className="block">{t('إدارة المحفظة', 'Wallet management')}</strong><span className="mt-1 block text-sm leading-6 text-slate-500 dark:text-slate-400">{t('عرض المحافظ والحركات المالية بعد تفعيل الخدمة.', 'Manage wallets and transactions after activation.')}</span></span>{isAr ? <ArrowLeft size={18} /> : <ArrowRight size={18} />}</button>
      </div>}
    </section></main>
  </div>;
};
