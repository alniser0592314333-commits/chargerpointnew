import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ShieldCheck, Fingerprint, LoaderCircle, LockKeyhole } from 'lucide-react';
import { authService } from '../../services/auth/authService';
import { enrollAccountBiometric, getAccountBiometricStatus, isNativeBiometricAvailable } from '../../services/auth/accountBiometric';
import { useI18n } from '../../i18n/i18nContext';

export const AdminBiometricSettings: React.FC = () => {
  const { locale } = useI18n();
  const ar = locale === 'ar';
  const [available, setAvailable] = useState(false);
  const [enrolled, setEnrolled] = useState(false);
  const [password, setPassword] = useState('');
  const [bin, setBin] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  const copy = (a: string, e: string) => ar ? a : e;
  const refresh = async () => {
    setAvailable(await isNativeBiometricAvailable());
    const auth = await authService.getSupabaseAuthSession();
    if (auth?.access_token) {
      try { setEnrolled((await getAccountBiometricStatus(auth.access_token)).enrolled); } catch { setEnrolled(false); }
    }
  };
  useEffect(() => { void refresh(); }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      if (!available || !Capacitor.isNativePlatform()) throw new Error('BIOMETRIC_NOT_AVAILABLE');
      const currentPassword = password;
      const currentBin = bin.trim();
      if (!currentPassword || !/^\d{4,}$/.test(currentBin)) throw new Error('PASSWORD_AND_BIN_REQUIRED');

      // Verify password and BIN before enrollment; the Edge Function repeats both
      // checks server-side before issuing the biometric challenge.
      const currentAuth = await authService.getSupabaseAuthSession();
      const currentSession = await authService.getCurrentSession();
      const verified = await authService.verifyCurrentPassword(currentAuth?.user?.email || currentSession?.email || '', currentPassword, currentBin);
      if (!verified.success) throw new Error(verified.error || 'IDENTITY_VERIFICATION_FAILED');

      const accessToken = (await authService.getSupabaseAuthSession())?.access_token;
      if (!accessToken) throw new Error('AUTH_REQUIRED');
      await enrollAccountBiometric(accessToken, 'ChargerPoint administrator', {
        password: currentPassword,
        bin: currentBin,
      });
      setPassword(''); setBin(''); setOpen(false);
      setMessage(copy('تم التحقق من كلمة المرور ورمز BIN وتفعيل البصمة لهذا الحساب.', 'Password and BIN verified; fingerprint sign-in is enabled for this account.'));
      await refresh();
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      setError(code === 'BIOMETRIC_NOT_AVAILABLE'
        ? copy('هذا الجهاز لا يدعم البصمة القوية أو لم يتم إعدادها.', 'Strong biometrics are unavailable or not configured on this device.')
        : code === 'WRONG_BIN' || code === 'BIN_REQUIRED'
          ? copy('رمز BIN غير صحيح.', 'The BIN is incorrect.')
          : code === 'BIN_LOCKED_FROZEN'
            ? copy('تم قفل رمز BIN. استخدم مسار الاستعادة.', 'The BIN is locked. Use the recovery flow.')
            : code === 'REAUTHENTICATION_FAILED'
              ? copy('كلمة المرور غير صحيحة.', 'The password is incorrect.')
              : code === 'PASSWORD_AND_BIN_REQUIRED'
                ? copy('أدخل كلمة المرور ورمز BIN الصحيح (4 أرقام على الأقل).', 'Enter your password and a valid BIN (at least 4 digits).')
                : copy('تعذر التحقق أو تفعيل البصمة. تحقق من البيانات والاتصال وحاول مجددًا.', 'Verification or fingerprint setup failed. Check your details and connection, then try again.'));
    } finally { setBusy(false); }
  };

  if (!Capacitor.isNativePlatform()) return null;
  return <section className="rounded-2xl border border-gray-200/80 bg-white/70 p-4 space-y-3 dark:border-[#123832] dark:bg-[#061e1a]/70">
    <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-50 text-emerald-700 dark:bg-[#0c312b] dark:text-[#8eb698]"><Fingerprint size={21}/></span><div className="min-w-0 flex-1"><h3 className="font-bold text-gray-900 dark:text-[#daf1de]">{copy('الدخول بالبصمة', 'Fingerprint sign-in')}</h3><p className="text-xs text-gray-500 dark:text-[#8eb698]">{enrolled ? copy('البصمة مفعّلة لهذا الحساب على هذا الجهاز.', 'Fingerprint is enabled for this account on this device.') : copy('لم تتم إضافة بصمة لهذا الحساب بعد.', 'No fingerprint is enrolled for this account yet.')}</p></div><ShieldCheck size={18} className={enrolled ? 'text-emerald-600' : 'text-gray-400'}/></div>
    <p className="text-xs leading-5 text-gray-500 dark:text-[#8eb698]">{copy('تُحفظ البصمة على الجهاز فقط. لتغييرها يلزم التحقق من كلمة المرور ورمز BIN.', 'Biometric data stays on the device. Changing it requires your password and BIN.')}</p>
    {message && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p>}
    {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{error}</p>}
    {!open ? <button type="button" disabled={!available} onClick={() => { setOpen(true); setError(''); setMessage(''); }} className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-700/20 px-4 py-3 text-sm font-semibold text-emerald-800 disabled:opacity-50 dark:border-[#285347] dark:text-[#daf1de]"><Fingerprint size={17}/>{enrolled ? copy('تغيير / إعادة إضافة البصمة', 'Change / re-enroll fingerprint') : copy('إضافة البصمة الآن', 'Add fingerprint now')}</button>
      : <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <label className="block text-sm font-medium">{copy('كلمة المرور الحالية', 'Current password')}<input type="password" required autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} className="mt-1 w-full rounded-xl border border-gray-300 bg-transparent px-3 py-2.5 dark:border-[#285347]"/></label>
        <label className="block text-sm font-medium">{copy('رمز BIN', 'Security BIN')}<input type="password" required inputMode="numeric" pattern="[0-9]{4,}" autoComplete="off" value={bin} onChange={e=>setBin(e.target.value)} className="mt-1 w-full rounded-xl border border-gray-300 bg-transparent px-3 py-2.5 dark:border-[#285347]"/></label>
        <div className="flex gap-2"><button type="submit" disabled={busy} className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-700 px-3 py-3 text-sm font-bold text-white disabled:opacity-50">{busy ? <LoaderCircle size={16} className="animate-spin"/> : <LockKeyhole size={16} />}{copy('تأكيد وتفعيل البصمة', 'Verify & enable fingerprint')}</button><button type="button" disabled={busy} onClick={()=>{setOpen(false);setPassword('');setBin('');setError('');}} className="rounded-xl border border-gray-300 px-3 py-3 text-sm dark:border-[#285347]">{copy('إلغاء','Cancel')}</button></div>
      </form>}
  </section>;
};
