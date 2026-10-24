import React, { useEffect, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { AlertTriangle, LockKeyhole, Wallet, X } from 'lucide-react';
import { customerAuth } from '../../services/customer/customerAuth';
import { buildJawwalBCode } from '../../services/localPaymentHelperCode';

type StoredService = { id: string; provider?: string; pin: string; recipientPhone?: string; accountKind?: 'friend' | 'merchant' };
type NativePaymentApi = {
  getServices(): Promise<{ value: string }>;
  setServices(options: { value: string }): Promise<void>;
  placeCall(options: { code: string; steps: string[] }): Promise<void>;
};
const NativePayment = registerPlugin<NativePaymentApi>('LocalPaymentHelper');

type Props = { mode: 'setup' | 'payment' | 'reconfigure' };

export const CustomerJawwalAutomation: React.FC<Props> = ({ mode }) => {
  const [isAr, setIsAr] = useState(document.documentElement.lang.toLowerCase().startsWith('ar'));
  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : false);
  const [pin, setPin] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [successToast, setSuccessToast] = useState('');
  const t = (ar: string, en: string) => isAr ? ar : en;

  useEffect(() => {
    const online = () => setIsOnline(true);
    const offline = () => setIsOnline(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', offline); };
  }, []);

  useEffect(() => {
    const update = () => setIsAr(document.documentElement.lang.toLowerCase().startsWith('ar'));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    const refreshConfigured = () => {
      if (!Capacitor.isNativePlatform()) return;
      void NativePayment.getServices().then(({ value }) => {
        if (!active) return;
        const list = value ? JSON.parse(value) : [];
        const service = Array.isArray(list) ? list.find((item: StoredService) => item?.provider === 'jawwal-pay' && /^\d{4}$/.test(item.pin)) : null;
        setConfigured(Boolean(service));
      }).catch(() => undefined);
    };
    window.addEventListener('cp-jawwal-pay-config-updated', refreshConfigured);
    if (Capacitor.isNativePlatform()) {
      void NativePayment.getServices().then(({ value }) => {
        if (!active) return;
        const list = value ? JSON.parse(value) : [];
        const service = Array.isArray(list) ? list.find((item: StoredService) => item?.provider === 'jawwal-pay' && /^\d{4}$/.test(item.pin)) : null;
        if (service) { setConfigured(true); setPin(service.pin); }
      }).catch(() => { if (active) setError(t('تعذّرت قراءة الإعدادات الآمنة على هذا الجهاز.', 'Could not read secure settings on this device.')); });
    }
    return () => { active = false; window.removeEventListener('cp-jawwal-pay-config-updated', refreshConfigured); };
  }, []);

  const savePin = async () => {
    setError(''); setNotice('');
    if (!/^\d{4}$/.test(pin)) { setError(t('أدخل الرقم السري لجوال باي المكوّن من 4 أرقام.', 'Enter the 4-digit Jawwal Pay PIN.')); return; }
    if (!Capacitor.isNativePlatform()) { setError(t('إضافة وسيلة الدفع الآمنة متاحة في تطبيق أندرويد فقط.', 'Secure payment setup is available in the Android app only.')); return; }
    setBusy(true);
    try {
      const { value } = await NativePayment.getServices();
      const list = value ? JSON.parse(value) : [];
      const others = Array.isArray(list) ? list.filter((item: StoredService) => item?.provider !== 'jawwal-pay') : [];
      others.push({ id: 'customer-jawwal-pay', provider: 'jawwal-pay', name: 'Jawwal Pay', accountKind: 'friend', pin, recipientPhone: '', createdAt: Date.now(), ussdSteps: [] });
      await NativePayment.setServices({ value: JSON.stringify(others) });
      setConfigured(true); setPin('');
      window.dispatchEvent(new Event('cp-jawwal-pay-config-updated'));
      setSuccessToast(t('تمت إضافة وسيلة الدفع بنجاح.', 'Payment method added successfully.'));
      window.setTimeout(() => setSuccessToast(''), 3200);
    } catch {
      setError(t('تعذّر الحفظ الآمن. لم يتم حفظ الرقم السري.', 'Secure save failed. The PIN was not saved.'));
    } finally { setBusy(false); }
  };

  const startPayment = async () => {
    setError(''); setNotice('');
    const normalized = amount.trim().replace(',', '.');
    if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(normalized) || Number(normalized) <= 0) {
      setError(t('أدخل مبلغًا صحيحًا أكبر من صفر.', 'Enter a valid amount greater than zero.'));
      return;
    }
    if (!Capacitor.isNativePlatform()) { setError(t('الدفع المباشر متاح من تطبيق أندرويد فقط.', 'Direct payment is available in the Android app only.')); return; }
    if (!navigator.onLine) { setError(t('يلزم الاتصال بالإنترنت لإرسال الدفعة إلى الإدارة.', 'An internet connection is required to notify the administrator.')); return; }
    setBusy(true);
    try {
      const { value } = await NativePayment.getServices();
      const list = value ? JSON.parse(value) : [];
      const service = Array.isArray(list) ? list.find((item: StoredService) => item?.provider === 'jawwal-pay' && /^\d{4}$/.test(item.pin)) : null;
      if (!service) { setConfigured(false); throw new Error('SETUP'); }
      const { data: recipientData, error: recipientError } = await customerAuth.rpc('get_jawwal_pay_recipient');
      const recipientPhone = (recipientData as { recipient_phone?: string } | null)?.recipient_phone || '';
      if (recipientError || !new RegExp('^05[0-9]{8}$').test(recipientPhone)) throw new Error('RECIPIENT_UNAVAILABLE');
      const code = buildJawwalBCode({ accountKind: 'friend', pin: service.pin, recipientPhone }, normalized);
      const minor = Math.round(Number(normalized) * 100);
      const { data: submission, error: submitError } = await customerAuth.rpc('submit_customer_jawwal_pay_payment', { p_amount_minor: minor });
      if (submitError || !submission || (submission as { success?: boolean }).success !== true) {
        const message = submitError?.message || '';
        if (/already awaiting review/i.test(message)) throw new Error('PENDING');
        throw new Error('SUBMIT');
      }
      await NativePayment.placeCall({ code, steps: [] });
      setNotice(t('تم إرسال طلب الدفع بقيمة ' + normalized + ' شيكل إلى الإدارة، والدفعة الآن بانتظار الاعتماد. أكمل خطوات جوال باي على الهاتف وتأكد من رسالة العملية الرسمية.', 'Payment request for ILS ' + normalized + ' was sent to the administrator and is pending approval. Complete Jawwal Pay on your phone and verify the provider’s official result.'));
      setAmount('');
      setOpen(false);
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      setError(code === 'PENDING'
        ? t('لديك دفعة بانتظار المراجعة بالفعل. انتظر قرار الإدارة قبل إرسال دفعة أخرى.', 'You already have a payment awaiting review. Wait for the administrator before submitting another.')
        : code === 'SETUP'
          ? t('إعداد وسيلة الدفع غير موجود. أضفها من الصفحة الرئيسية أولًا.', 'Payment setup is missing. Add it from Home first.')
          : code === 'RECIPIENT_UNAVAILABLE'
            ? t('تعذّر جلب رقم التحويل الحالي من الخادم. تأكد من الإنترنت ولم يبدأ الاتصال.', 'Could not retrieve the current recipient number. Check internet; no call was started.')
            : code === 'SUBMIT'
            ? t('تعذّر إرسال طلب الدفع للإدارة. لم يبدأ اتصال جوال باي؛ تحقق من الإنترنت وحاول مجددًا.', 'Could not submit the payment request. Jawwal Pay was not started; check internet and try again.')
            : t('تعذّر بدء اتصال جوال باي. تحقّق من صلاحية الاتصال والشريحة، وراجع حالة طلب الدفع في الحساب قبل إعادة المحاولة.', 'Could not start Jawwal Pay. Check call permission and SIM, and review the payment request in your account before retrying.'));
    } finally { setBusy(false); }
  };

  // Keep the amount dialog above Android's soft keyboard and account navigation.
  useEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    const update = () => {
      const height = viewport?.height || window.innerHeight;
      document.documentElement.style.setProperty('--cp-jawwal-viewport-height', `${Math.round(height)}px`);
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  if (mode === 'payment' && !isOnline) return null;

  if ((mode === 'setup' && configured) || (mode === 'reconfigure' && successToast)) {
    return successToast ? <div role="status" className="fixed inset-x-4 top-4 z-[150] mx-auto max-w-md rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-900 shadow-xl dark:border-emerald-400/30 dark:bg-[#103a32] dark:text-emerald-100">{successToast}</div> : null;
  }

  if (mode === 'setup' || mode === 'reconfigure') return <section className="mt-3 rounded-2xl border border-sky-200/80 bg-sky-50/70 p-4 text-slate-900 shadow-sm dark:border-white/10 dark:bg-white/[0.04] dark:text-white">
    <div className="flex items-center gap-3">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300"><Wallet size={20}/></span>
      <div className="min-w-0 flex-1"><h3 className="font-extrabold">{mode === 'reconfigure' ? t('إعادة إعداد وسيلة الدفع', 'Reset payment method') : t('أتمتة', 'Automation')}</h3><p className="text-xs text-slate-600 dark:text-slate-300">{mode === 'reconfigure' ? t('أدخل الرقم السري الجديد لجوال باي', 'Enter your new Jawwal Pay PIN') : t('إضافة وسيلة دفع جوال باي لهذا الجهاز', 'Add Jawwal Pay to this device')}</p></div>
      <LockKeyhole size={15} className="text-slate-500"/>
    </div>
    <div className="mt-3 space-y-2 rounded-xl border border-amber-300/80 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100">
      <p className="flex items-start gap-2"><AlertTriangle size={17} className="mt-0.5 shrink-0"/><span>{t('أدخل الرقم السري المكوّن من 4 أرقام لحفظ وسيلة الدفع بأمان على هذا الجهاز. عند الدفع سيبدأ اتصال جوال باي، وسيبقى رصيدك دون تغيير حتى تعتمد الإدارة الدفعة.', 'Enter your 4-digit PIN to securely add this payment method on this device. A Jawwal Pay call starts when paying; your balance will not change until the administrator approves the payment.')}</span></p>
      <p className="ps-6 text-xs">{t('يجب اختيار شريحة الاتصال المرتبطة بحساب جوال باي. الرقم السري يُحفظ مشفّرًا على الهاتف ولا يُرسل إلى خادم التطبيق.', 'Select the calling SIM linked to your Jawwal Pay account. Your PIN is encrypted on this phone and is never sent to the app server.')}</p>
      <button type="button" onClick={() => setNotice(t('تذكّر اختيار شريحة جوال باي قبل الاتصال.', 'Remember to select the Jawwal Pay SIM before calling.'))} className="ms-6 text-xs font-bold text-blue-700 underline underline-offset-2 dark:text-sky-300">{t('فهمت ذلك', 'Got it')}</button>
    </div>
    <form onSubmit={e=>{e.preventDefault(); void savePin()}} className="mt-3 space-y-3"><label className="block text-sm font-semibold">{t('الرقم السري لجوال باي', 'Jawwal Pay PIN')}<input autoComplete="off" inputMode="numeric" pattern="[0-9]*" maxLength={4} type="password" value={pin} onChange={e=>setPin(e.target.value.replace(/[^0-9]/g,'').slice(0,4))} className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-base dark:border-white/15 dark:bg-[#071d1c]" placeholder="••••" /></label><button type="submit" disabled={busy || !/^\d{4}$/.test(pin)} className="w-full rounded-xl bg-sky-700 px-4 py-3 font-bold text-white disabled:opacity-40">{busy ? t('جارٍ الحفظ…', 'Saving…') : mode === 'reconfigure' ? t('حفظ الرقم السري الجديد', 'Save new PIN') : t('إضافة وسيلة الدفع', 'Add payment method')}</button></form>
    {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 p-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-200">{error}</p>}
    {notice && <p role="status" className="mt-3 rounded-lg bg-sky-50 p-2 text-sm text-sky-800 dark:bg-sky-500/10 dark:text-sky-200">{notice}</p>}
  </section>;

  if (!configured) return null;
  return <div className="mt-3">
    <button type="button" onClick={()=>{setOpen(true);setError('');setNotice('');}} className="w-full rounded-xl bg-sky-700 px-4 py-3 font-bold text-white shadow-sm hover:bg-sky-800"><Wallet size={17} className="me-2 inline-block"/>{t('دفع بواسطة جوال باي', 'Pay with Jawwal Pay')}</button>
    {notice && <p role="status" className="mt-3 rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-100">{notice}</p>}
    {error && <p role="alert" className="mt-3 rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/10 dark:text-rose-200">{error}</p>}
    {open && <div className="cp-jawwal-payment-overlay fixed inset-0 z-[140] flex items-end justify-center bg-black/65 p-2 sm:items-center"><div role="dialog" aria-modal="true" className="cp-jawwal-payment-dialog w-full max-w-sm rounded-2xl bg-white p-4 text-slate-900 shadow-2xl dark:bg-[#0d2a29] dark:text-white">
      <div className="flex items-center justify-between gap-3"><h3 className="text-lg font-extrabold">{t('دفع بواسطة جوال باي', 'Pay with Jawwal Pay')}</h3><button type="button" aria-label={t('إغلاق','Close')} onClick={()=>setOpen(false)} className="rounded-lg p-1"><X size={19}/></button></div>
      <form onSubmit={e=>{e.preventDefault();void startPayment()}} className="mt-4 space-y-3"><label className="block text-sm font-semibold">{t('المبلغ (شيكل)', 'Amount (ILS)')}<input autoFocus inputMode="decimal" type="number" min="0.01" step="0.01" required value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00" className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-lg text-slate-900 outline-none focus:border-sky-500 dark:border-white/15 dark:bg-[#071d1c] dark:text-white"/></label>
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-300">{t('سيُرسل طلب الدفعة إلى الإدارة للمراجعة، ثم يبدأ اتصال جوال باي. لن يتغير رصيدك حتى اعتماد الدفعة.', 'The payment request will be sent for administrator review, then Jawwal Pay starts. Your balance changes only after approval.')}</p>
        <button type="submit" disabled={busy || !amount.trim()} className="w-full rounded-xl bg-sky-700 px-4 py-3 font-bold text-white disabled:opacity-40">{busy ? t('جارٍ الإرسال…', 'Submitting…') : t('دفع', 'Pay')}</button></form>
      {error && <p role="alert" className="mt-3 text-sm text-rose-600 dark:text-rose-300">{error}</p>}
    </div></div>}
  </div>;
};
