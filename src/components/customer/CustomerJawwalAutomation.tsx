import React, { useEffect, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { AlertTriangle, LockKeyhole, Wallet } from 'lucide-react';
import { buildJawwalBCode } from '../../services/localPaymentHelperCode';

type StoredService = { id: string; provider?: string; pin: string; recipientPhone?: string; accountKind?: 'friend' | 'merchant' };
type NativePaymentApi = {
  getServices(): Promise<{ value: string }>;
  setServices(options: { value: string }): Promise<void>;
  placeCall(options: { code: string; steps: string[] }): Promise<void>;
};
const NativePayment = registerPlugin<NativePaymentApi>('LocalPaymentHelper');
const CONSENT_KEY = 'cp_jawwal_automation_terms_v1';
const PHONE = '0592369875';

export const CustomerJawwalAutomation: React.FC = () => {
  const [isAr, setIsAr] = useState(document.documentElement.lang.toLowerCase().startsWith('ar'));
  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [pin, setPin] = useState('');
  const [amount, setAmount] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const t = (ar: string, en: string) => isAr ? ar : en;

  useEffect(() => {
    const update = () => setIsAr(document.documentElement.lang.toLowerCase().startsWith('ar'));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    try { setAccepted(window.localStorage.getItem(CONSENT_KEY) === 'yes'); } catch {}
    if (Capacitor.isNativePlatform()) {
      void NativePayment.getServices().then(({ value }) => {
        if (!active) return;
        const list = value ? JSON.parse(value) : [];
        const service = Array.isArray(list) ? list.find((item: StoredService) => item?.provider === 'jawwal-pay' && /^\\d{4}$/.test(item.pin)) : null;
        if (service) { setConfigured(true); setPin(service.pin); }
      }).catch(() => { if (active) setError(t('تعذّرت قراءة الإعدادات الآمنة على هذا الجهاز.', 'Could not read secure settings on this device.')); });
    }
    return () => { active = false; };
  }, []);

  const savePin = async () => {
    setError(''); setNotice('');
    if (!/^\\d{4}$/.test(pin)) { setError(t('أدخل الرقم السري لجوال باي المكوّن من 4 أرقام.', 'Enter the 4-digit Jawwal Pay PIN.')); return; }
    if (!Capacitor.isNativePlatform()) { setError(t('حفظ الرقم السري الآمن متاح في تطبيق أندرويد فقط.', 'Secure PIN storage is available in the Android app only.')); return; }
    setBusy(true);
    try {
      const { value } = await NativePayment.getServices();
      const list = value ? JSON.parse(value) : [];
      const others = Array.isArray(list) ? list.filter((item: StoredService) => item?.provider !== 'jawwal-pay') : [];
      others.push({ id: 'customer-jawwal-pay', provider: 'jawwal-pay', name: 'Jawwal Pay', accountKind: 'friend', pin, recipientPhone: PHONE, createdAt: Date.now(), ussdSteps: [] });
      await NativePayment.setServices({ value: JSON.stringify(others) });
      setConfigured(true); setOpen(false); setPin('');
      setNotice(t('تم حفظ إعداد الأتمتة على هذا الجهاز فقط.', 'Automation settings saved on this device only.'));
    } catch {
      setError(t('تعذّر الحفظ الآمن. لم يتم حفظ الرقم السري.', 'Secure save failed. The PIN was not saved.'));
    } finally { setBusy(false); }
  };

  const startPayment = async () => {
    setError(''); setNotice('');
    if (!configured) { setOpen(true); return; }
    let code = '';
    try { code = buildJawwalBCode({ accountKind: 'friend', pin, recipientPhone: PHONE }, amount); }
    catch (e) { setError(e instanceof Error ? t(e.message, 'Enter a valid amount greater than zero.') : t('راجع المبلغ.', 'Check the amount.')); return; }
    if (!Capacitor.isNativePlatform()) { setError(t('الدفع المباشر متاح من تطبيق أندرويد فقط.', 'Direct payment is available in the Android app only.')); return; }
    setBusy(true);
    try {
      await NativePayment.placeCall({ code, steps: [] });
      setNotice(t('تم فتح اتصال جوال باي. راجع شاشة الهاتف وأكمل العملية؛ فتح الاتصال لا يعني أن الدفع نجح.', 'Jawwal Pay was opened. Review the phone screen and complete the transaction; opening the call does not mean payment succeeded.'));
      setAmount('');
    } catch {
      setError(t('تعذّر بدء الاتصال. تحقق من صلاحية الاتصال وإعداد الشريحة.', 'Could not start the call. Check call permission and SIM settings.'));
    } finally { setBusy(false); }
  };

  return <section className="mt-3 rounded-2xl border border-sky-200/80 bg-sky-50/70 p-4 text-slate-900 shadow-sm dark:border-white/10 dark:bg-white/[0.04] dark:text-white">
    <div className="flex items-center gap-3">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300"><Wallet size={20}/></span>
      <div className="min-w-0 flex-1"><h3 className="font-extrabold">{t('أتمتة', 'Automation')}</h3><p className="text-xs text-slate-600 dark:text-slate-300">{t('الدفع بواسطة جوال باي', 'Pay with Jawwal Pay')}</p></div>
      <span className="text-xs text-slate-500 dark:text-slate-400"><LockKeyhole size={15}/></span>
    </div>
    <div className="mt-3 space-y-2 rounded-xl border border-amber-300/80 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100">
      <p className="flex items-start gap-2"><AlertTriangle size={17} className="mt-0.5 shrink-0"/><span>{t('بمجرد إدخال المبلغ والضغط على دفع، سيبدأ تحويل المبلغ مباشرة عبر جوال باي. راجع المبلغ قبل المتابعة.', 'Entering the amount and tapping Pay starts the Jawwal Pay transfer directly. Check the amount before continuing.')}</span></p>
      <p className="ps-6 text-xs">{t('يجب أن تكون الشريحة المحددة للاتصال هي الشريحة المرتبطة بحساب جوال باي.', 'The selected calling SIM must be the SIM linked to your Jawwal Pay account.')}</p>
      <button type="button" onClick={() => { try { window.localStorage.setItem('cp_jawwal_sim_hint_ack_v1','yes'); } catch {} setNotice(t('تذكّر اختيار شريحة جوال باي قبل الاتصال.', 'Remember to select the Jawwal Pay SIM before calling.')); }} className="ms-6 text-xs font-bold text-blue-700 underline underline-offset-2 dark:text-sky-300">{t('فهمت ذلك', 'Got it')}</button>
    </div>
    {!configured ? <button type="button" onClick={() => setOpen(true)} className="mt-3 w-full rounded-xl bg-sky-700 px-4 py-3 font-bold text-white hover:bg-sky-800">{t('إعداد الأتمتة', 'Set up automation')}</button> : <div className="mt-3 space-y-3">
      <label className="block text-sm font-semibold">{t('المبلغ (شيكل)', 'Amount (ILS)')}<input inputMode="decimal" type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder={t('أدخل المبلغ', 'Enter amount')} className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-base text-slate-900 outline-none focus:border-sky-500 dark:border-white/15 dark:bg-[#071d1c] dark:text-white"/></label>
      <button type="button" disabled={busy || !amount.trim()} onClick={() => void startPayment()} className="w-full rounded-xl bg-sky-700 px-4 py-3 font-bold text-white disabled:opacity-50">{busy ? t('جارٍ التجهيز…', 'Starting…') : t('دفع بواسطة جوال باي', 'Pay with Jawwal Pay')}</button>
      <button type="button" onClick={() => { setPin(''); setOpen(true); }} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold dark:border-white/15">{t('تغيير الرقم السري المحفوظ', 'Change saved PIN')}</button>
    </div>}
    {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 p-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-200">{error}</p>}
    {notice && <p role="status" className="mt-3 rounded-lg bg-sky-50 p-2 text-sm text-sky-800 dark:bg-sky-500/10 dark:text-sky-200">{notice}</p>}
    {open && <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/65 p-3 sm:items-center"><div role="dialog" aria-modal="true" className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 text-slate-900 shadow-2xl dark:bg-[#0d2a29] dark:text-white">
      <h3 className="text-lg font-extrabold">{t('إعداد أتمتة جوال باي', 'Set up Jawwal Pay automation')}</h3>
      {!accepted ? <div className="mt-3 space-y-3"><div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm leading-6 text-amber-950 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100"><p className="font-extrabold">{t('شروط الاستخدام وإخلاء المسؤولية', 'Terms and disclaimer')}</p><ul className="mt-2 list-disc space-y-1 ps-5"><li>{t('الميزة اختيارية، وأنت مسؤول عن التأكد من المبلغ والمستلم والشريحة قبل الدفع.', 'This feature is optional. You are responsible for checking the amount, recipient, and SIM before payment.')}</li><li>{t('يُحفظ الرقم السري مشفّرًا محليًا على هذا الهاتف باستخدام Android Keystore، ولا يُرسل إلى خادم أو قاعدة بيانات التطبيق.', 'The PIN is encrypted and stored locally on this phone using Android Keystore. It is not sent to the app server or database.')}</li><li>{t('حذف التطبيق أو بياناته قد يحذف الإعدادات المحفوظة. لا تشارك هاتفك أو رمزك السري.', 'Uninstalling the app or clearing its data may erase saved settings. Do not share your phone or PIN.')}</li><li>{t('التطبيق يبدأ اتصال USSD فقط ولا يستطيع ضمان قبول العملية أو استرجاع مبلغها. تحقق من رسالة جوال باي الرسمية.', 'The app only starts a USSD call and cannot guarantee approval or reversal. Verify the official Jawwal Pay result.')}</li><li>{t('باختيارك المتابعة، تتحمل مسؤولية استخدام الميزة والعمليات التي تؤكدها عبر مزود الخدمة.', 'By continuing, you accept responsibility for using this feature and transactions confirmed through the provider.')}</li></ul></div><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consentChecked} onChange={e=>setConsentChecked(e.target.checked)} className="mt-1 accent-sky-600"/><span>{t('قرأت الشروط وإخلاء المسؤولية وأوافق.', 'I have read and accept the terms and disclaimer.')}</span></label><button disabled={!consentChecked} onClick={()=>{try{window.localStorage.setItem(CONSENT_KEY,'yes')}catch{} setAccepted(true)}} className="w-full rounded-xl bg-sky-700 px-4 py-3 font-bold text-white disabled:opacity-40">{t('موافقة ومتابعة', 'Accept and continue')}</button></div> : <form onSubmit={e=>{e.preventDefault(); void savePin()}} className="mt-3 space-y-3"><p className="text-sm text-slate-600 dark:text-slate-300">{t('أدخل الرقم السري فقط. سيُحفظ على هذا الجهاز ولن يُرفع إلى الخادم.', 'Enter only your PIN. It is saved on this device and will not be uploaded to the server.')}</p><label className="block text-sm font-semibold">{t('الرقم السري لجوال باي', 'Jawwal Pay PIN')}<input autoComplete="off" inputMode="numeric" maxLength={4} type="password" value={pin} onChange={e=>setPin(e.target.value.replace(/\\D/g,'').slice(0,4))} className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-base dark:border-white/15 dark:bg-[#071d1c]" placeholder="••••" /></label><button type="submit" disabled={busy || !/^\\d{4}$/.test(pin)} className="w-full rounded-xl bg-sky-700 px-4 py-3 font-bold text-white disabled:opacity-40">{busy ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ الرقم السري', 'Save PIN')}</button></form>}
      <button type="button" onClick={()=>setOpen(false)} className="mt-3 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm dark:border-white/15">{t('إغلاق', 'Close')}</button>
    </div></div>}
  </section>;
};
