import React, { useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { MessageSquareText, Send, X } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { getCustomerQrCardData } from './dayOrdersStore';
import { sendSmsUsingSystemDefaultSim } from '../../services/nativeSms';

interface SavedTemplate { id: string; name: string; content: string; }
const SAVED_TEMPLATES_KEY = 'chargerpoint.customerLinkSmsSavedTemplates.v1';
const TEMPLATE_KEY = 'chargerpoint.customerLinkSmsTemplate.v1';
const DUE_DATE_KEY = 'chargerpoint.customerLinkSmsDueDate.v1';
const DEFAULT_TEMPLATE = 'مرحباً {name}، نذكّرك بلطف بوجود مبلغ مستحق على حسابك: {debt}. نرجو تسديده يوم {due_date} إن أمكن، وشكراً لثقتك بنا.';

const readTemplates = (): SavedTemplate[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_TEMPLATES_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.content === 'string') : [];
  } catch { return []; }
};

const renderTemplate = (template: string, name: string, phone: string, balanceMinor: number, link: string, dueDate: string, locale: string) => {
  const debt = balanceMinor < 0
    ? `${(Math.abs(balanceMinor) / 100).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₪`
    : 'لا يوجد';
  return template
    .replace(/\\{name\\}/g, name)
    .replace(/\\{debt\\}/g, debt)
    .replace(/\\{link\\}/g, link)
    .replace(/\\{phone\\}/g, phone)
    .replace(/\\{date\\}/g, new Date().toLocaleDateString(locale))
    .replace(/\\{due_date\\}/g, dueDate);
};

export const CustomerSingleSmsComposer: React.FC<{
  customerId: string;
  customerName: string;
  customerPhone?: string;
  balanceMinor: number;
  onClose: () => void;
}> = ({ customerId, customerName, customerPhone, balanceMinor, onClose }) => {
  const { locale } = useI18n();
  const ar = locale === 'ar';
  const [phone, setPhone] = useState(customerPhone || '');
  const [templates] = useState(readTemplates);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [message, setMessage] = useState(() => {
    try { return localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE; } catch { return DEFAULT_TEMPLATE; }
  });
  const [error, setError] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [notice, setNotice] = useState('');

  const preview = useMemo(() => renderTemplate(
    message, customerName, phone, balanceMinor, '{رابط الزبون الشخصي}',
    (() => { try { return localStorage.getItem(DUE_DATE_KEY) || 'الخميس'; } catch { return 'الخميس'; } })(),
    ar ? 'ar' : 'en'
  ), [message, customerName, phone, balanceMinor, ar]);
  const isAndroidAdmin = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' && import.meta.env.VITE_APP_VARIANT === 'admin';

  const chooseTemplate = (id: string) => {
    setSelectedTemplate(id);
    if (!id) {
      try { setMessage(localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE); } catch { setMessage(DEFAULT_TEMPLATE); }
      return;
    }
    const selected = templates.find((item) => item.id === id);
    if (selected) setMessage(selected.content);
  };

  const send = async () => {
    setError('');
    setNotice('');
    const normalizedPhone = phone.trim().replace(/[٠-٩۰-۹]/g, (digit) => {
      const a = '٠١٢٣٤٥٦٧٨٩'.indexOf(digit);
      if (a >= 0) return String(a);
      const e = '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit);
      return e >= 0 ? String(e) : digit;
    }).replace(/[^+\\d]/g, '');
    const digits = normalizedPhone.replace(/\\D/g, '');
    if (digits.length < 7 || digits.length > 15) {
      setError(ar ? 'أدخل رقم هاتف صحيحًا لهذا الزبون.' : 'Enter a valid phone number for this customer.');
      return;
    }
    if (!message.trim()) {
      setError(ar ? 'اكتب نص الرسالة أولاً.' : 'Enter a message first.');
      return;
    }
    if (!isAndroidAdmin) {
      setError(ar ? 'إرسال SMS متاح من تطبيق الأدمن APK فقط.' : 'SMS is available from the Admin APK only.');
      return;
    }
    if (message.includes('{link}') && !navigator.onLine) {
      setError(ar ? 'يلزم الاتصال بالإنترنت لإدراج الرابط الشخصي.' : 'Internet is required to insert the personal link.');
      return;
    }
    if (!window.confirm(ar ? `سيتم إرسال رسالة SMS إلى ${customerName} فقط على الرقم ${normalizedPhone}. قد تُحتسب تكلفة على الشريحة. هل تريد المتابعة؟` : `Send an SMS only to ${customerName} at ${normalizedPhone}? Carrier charges may apply.`)) return;

    setIsSending(true);
    try {
      let personalLink = '';
      if (message.includes('{link}')) {
        const qr = await getCustomerQrCardData(customerId);
        if (!qr?.publicUrl || !qr.token) throw new Error('CUSTOMER_QR_LINK_UNAVAILABLE');
        personalLink = qr.publicUrl;
      }
      let dueDate = 'الخميس';
      try { dueDate = localStorage.getItem(DUE_DATE_KEY) || dueDate; } catch { /* use default */ }
      const sms = renderTemplate(message, customerName, normalizedPhone, balanceMinor, personalLink, dueDate, ar ? 'ar' : 'en').trim();
      await sendSmsUsingSystemDefaultSim(normalizedPhone, sms);
      setNotice(ar ? 'تم تسليم الرسالة إلى نظام Android للإرسال. هذا لا يؤكد وصولها إلى هاتف الزبون.' : 'Android accepted the SMS submission. This does not confirm delivery to the customer.');
      setTimeout(onClose, 1600);
    } catch (e) {
      const code = e instanceof Error ? e.message : String(e);
      setError(ar ? `تعذر إرسال الرسالة: ${code}` : `Could not submit SMS: ${code}`);
    } finally {
      setIsSending(false);
    }
  };

  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={ar ? 'مراسلة الزبون' : 'Message customer'}>
    <div className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-[#14423b] dark:bg-[#082622]">
      <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-[#14423b]">
        <div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 dark:bg-[#0c312b] dark:text-[#a9d9b7]"><MessageSquareText className="h-5 w-5" /></span><div><h2 className="text-base font-bold text-gray-900 dark:text-[#daf1de]">{ar ? 'مراسلة الزبون' : 'Message customer'}</h2><p className="text-xs text-gray-500 dark:text-[#8eb698]">{customerName} · {ar ? 'مستلم واحد فقط' : 'One recipient only'}</p></div></div>
        <button type="button" onClick={onClose} disabled={isSending} className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-[#0c312b]" aria-label={ar ? 'إغلاق' : 'Close'}><X className="h-5 w-5" /></button>
      </div>
      <div className="space-y-4 p-5">
        <label className="block text-xs font-semibold text-gray-700 dark:text-[#a9d4b4]">{ar ? 'رقم الهاتف' : 'Phone number'}<input value={phone} onChange={(e) => setPhone(e.target.value)} dir="ltr" inputMode="tel" placeholder="059xxxxxxx" className="mt-1.5 w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-start text-sm text-gray-900 outline-none focus:border-emerald-500 dark:border-[#14423b] dark:bg-[#061f1c] dark:text-[#daf1de]" /></label>
        <label className="block text-xs font-semibold text-gray-700 dark:text-[#a9d4b4]">{ar ? 'استخدم قالبًا جاهزًا' : 'Use a saved template'}<select value={selectedTemplate} onChange={(e) => chooseTemplate(e.target.value)} className="mt-1.5 w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm dark:border-[#14423b] dark:bg-[#061f1c] dark:text-[#daf1de]"><option value="">{ar ? 'رسالة مخصصة / القالب الحالي' : 'Custom message / current template'}</option>{templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <div className="flex flex-wrap gap-2 text-[11px] text-gray-500 dark:text-[#8eb698]">{['name','debt','link','phone','date','due_date'].map((key) => <button key={key} type="button" onClick={() => setMessage((value) => value + `{${key}}`)} className="rounded-lg border border-emerald-200 px-2.5 py-1.5 font-semibold text-emerald-800 dark:border-[#28665a] dark:text-[#a9d9b7]">+ {key}</button>)}</div>
        <label className="block text-xs font-semibold text-gray-700 dark:text-[#a9d4b4]">{ar ? 'نص الرسالة (تقدر تعدله أو تكتب رسالة جديدة)' : 'Message text (edit the template or write your own)'}<textarea value={message} onChange={(e) => { setMessage(e.target.value); setSelectedTemplate(''); }} rows={7} maxLength={2000} dir="auto" className="mt-1.5 w-full resize-y rounded-xl border border-gray-200 bg-white p-3 text-sm leading-6 text-gray-900 outline-none focus:border-emerald-500 dark:border-[#14423b] dark:bg-[#061f1c] dark:text-[#daf1de]" /></label>
        <div className="rounded-xl bg-gray-50 p-3 dark:bg-[#061f1c]"><p className="mb-2 text-xs font-bold text-gray-600 dark:text-[#8eb698]">{ar ? 'معاينة الرسالة' : 'Message preview'}</p><p dir="auto" className="whitespace-pre-wrap break-words text-sm text-gray-800 dark:text-[#daf1de]">{preview}</p></div>
        {error && <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">{error}</p>}
        {notice && <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200">{notice}</p>}
        {!isAndroidAdmin && <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">{ar ? 'إرسال SMS متاح من تطبيق الأدمن APK فقط، ويستخدم شريحة Android الافتراضية.' : 'SMS is available in the Admin APK only and uses Android’s default SMS SIM.'}</p>}
        <div className="flex justify-end gap-2 border-t border-gray-100 pt-4 dark:border-[#14423b]"><button type="button" onClick={onClose} disabled={isSending} className="rounded-xl border border-gray-200 px-4 py-2.5 text-xs font-semibold dark:border-[#14423b]">{ar ? 'إلغاء' : 'Cancel'}</button><button type="button" onClick={send} disabled={isSending || !message.trim()} className="inline-flex items-center gap-2 rounded-xl bg-emerald-700 px-5 py-2.5 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-50">{isSending ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" /> : <Send className="h-4 w-4" />}{ar ? 'إرسال للزبون' : 'Send to customer'}</button></div>
      </div>
    </div>
  </div>;
};
