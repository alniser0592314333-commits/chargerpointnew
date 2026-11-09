import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, LoaderCircle, MessageSquareText, Search, Send, Users } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { useI18n } from '../../i18n/i18nContext';
import { getCustomerQrCardData, getSmsCustomerRecipients, SmsCustomerRecipient } from './dayOrdersStore';
import { sendSmsUsingSystemDefaultSim } from '../../services/nativeSms';

type RecipientStatus = 'pending' | 'sending' | 'submitted' | 'failed' | 'uncertain';
interface Recipient extends SmsCustomerRecipient { selected: boolean; status: RecipientStatus; error?: string; }
interface SavedCampaign { updatedAt: string; recipients: Recipient[]; }
const STORAGE_KEY = 'chargerpoint.customerLinkSmsCampaign.v1';
const TEMPLATE_KEY = 'chargerpoint.customerLinkSmsTemplate.v1';
const DEFAULT_TEMPLATE = 'مرحباً {name}، نذكّرك بلطف بوجود مبلغ مستحق على حسابك: {debt}. نرجو تسديده يوم الخميس إن أمكن، وشكراً لثقتك بنا.';

const renderMessageTemplate = (template: string, recipient: Recipient, link = ''): string => {
  const debt = recipient.balanceMinor < 0
    ? `${(Math.abs(recipient.balanceMinor) / 100).toLocaleString('ar', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₪`
    : 'لا يوجد';
  return template
    .replace(/\\{name\\}/g, recipient.name)
    .replace(/\\{debt\\}/g, debt)
    .replace(/\\{link\\}/g, link);
};

const normalizePhone = (value: string): string | null => {
  const ascii = value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const ar = '٠١٢٣٤٥٦٧٨٩';
    const east = '۰۱۲۳۴۵۶۷۸۹';
    const a = ar.indexOf(digit);
    if (a >= 0) return String(a);
    const e = east.indexOf(digit);
    return e >= 0 ? String(e) : digit;
  });
  const compact = ascii.trim().replace(/[^+\d]/g, '');
  const digits = compact.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return compact.startsWith('+') ? `+${digits}` : digits;
};

const readCampaign = (): SavedCampaign | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedCampaign;
    if (!Array.isArray(parsed.recipients)) return null;
    return { ...parsed, recipients: parsed.recipients.map((r) => r.status === 'sending'
      ? { ...r, status: 'uncertain', error: 'لم يتم تأكيد نتيجة الإرسال قبل إغلاق التطبيق' }
      : r) };
  } catch { return null; }
};
const saveCampaign = (recipients: Recipient[]): boolean => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ updatedAt: new Date().toISOString(), recipients }));
    return true;
  } catch (error) { console.error('Could not persist customer-link SMS campaign:', error); return false; }
};

export const CustomerLinkSmsPage: React.FC = () => {
  const { locale } = useI18n();
  const isArabic = locale === 'ar';
  const isAndroidAdmin = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' && import.meta.env.VITE_APP_VARIANT === 'admin';
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [messageTemplate, setMessageTemplate] = useState(() => {
    try { return localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE; }
    catch { return DEFAULT_TEMPLATE; }
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let active = true;
    const previous = readCampaign();
    getSmsCustomerRecipients().then((customers: SmsCustomerRecipient[]) => {
      if (!active) return;
      const previousById = new Map((previous?.recipients || []).map((r) => [r.id, r]));
      setRecipients(customers.flatMap((customer): Recipient[] => {
        const phone = normalizePhone(customer.phone);
        if (!phone) return [];
        const old = previousById.get(customer.id);
        return [old
          ? { ...customer, phone, selected: old.selected, status: old.status, error: old.error }
          : { ...customer, phone, selected: customer.hasDebt, status: 'pending' as const }];
      }));
    }).catch((error) => {
      console.error('Failed to load customer link recipients:', error);
      if (active) setLoadError(isArabic ? 'تعذرت قراءة قائمة الزبائن من البيانات المحلية.' : 'Could not load customers from the local store.');
    }).finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [isArabic]);

  const selectedCount = recipients.filter((r) => r.selected && r.status === 'pending').length;
  const previewRecipient = recipients.find((r) => r.selected) || recipients[0];
  const hasLinkToken = messageTemplate.includes('{link}');
  const previewMessage = previewRecipient
    ? renderMessageTemplate(messageTemplate, previewRecipient, hasLinkToken ? 'https://رابط-الزبون-الشخصي' : '')
    : messageTemplate;
  const updateTemplate = (value: string) => {
    setMessageTemplate(value);
    try { localStorage.setItem(TEMPLATE_KEY, value); } catch (error) {
      console.error('Could not save SMS template locally:', error);
    }
  };
  const counts = useMemo(() => ({
    submitted: recipients.filter((r) => r.status === 'submitted').length,
    failed: recipients.filter((r) => r.status === 'failed').length,
    uncertain: recipients.filter((r) => r.status === 'uncertain').length,
  }), [recipients]);
  const visibleRecipients = recipients.filter((r) => !search.trim() || r.name.toLowerCase().includes(search.trim().toLowerCase()) || r.phone.includes(search.trim()));
  const updateRecipients = (next: Recipient[]) => {
    setRecipients(next);
    if (!saveCampaign(next)) setNotice(isArabic ? 'تعذر حفظ تقدم الحملة على الجهاز.' : 'Could not save campaign progress on this device.');
  };
  const toggleRecipient = (id: string) => {
    if (isSending) return;
    updateRecipients(recipients.map((r) => r.id === id && r.status === 'pending' ? { ...r, selected: !r.selected } : r));
  };
  const toggleAll = (checked: boolean) => {
    if (isSending) return;
    updateRecipients(recipients.map((r) => r.status === 'pending' ? { ...r, selected: checked } : r));
  };
  const startNewCampaign = () => {
    if (isSending) return;
    updateRecipients(recipients.map((r) => ({ ...r, status: 'pending' as const, selected: true, error: undefined })));
    setNotice('');
  };

  const sendSelected = async () => {
    if (!isAndroidAdmin) { setNotice(isArabic ? 'إرسال SMS متاح من تطبيق الأدمن APK فقط.' : 'SMS sending is available from the Admin APK only.'); return; }
    if (!navigator.onLine) { setNotice(isArabic ? 'يلزم الاتصال بالإنترنت لإنشاء روابط QR الشخصية والتحقق منها.' : 'An internet connection is required to create and verify each personal QR link.'); return; }
    if (!messageTemplate.trim()) { setNotice(isArabic ? 'اكتب محتوى الرسالة أولاً.' : 'Enter the message content first.'); return; }
    if (!selectedCount) { setNotice(isArabic ? 'حدد زبوناً واحداً على الأقل.' : 'Select at least one customer.'); return; }
    const confirmed = window.confirm(isArabic
      ? `سيتم إنشاء/استخدام رابط QR الشخصي لكل زبون وإرسال SMS إلى ${selectedCount} رقم. قد تُحتسب تكلفة الرسائل. هل تريد المتابعة؟`
      : `A personal QR link will be created or reused for each customer and sent by SMS to ${selectedCount} numbers. Carrier charges may apply. Continue?`);
    if (!confirmed) return;

    let current = recipients.map((r) => ({ ...r }));
    if (!saveCampaign(current)) { setNotice(isArabic ? 'تعذر حفظ الحملة؛ أوقفنا الإرسال لتجنب التكرار.' : 'Could not save the campaign; sending was stopped to avoid duplicates.'); return; }
    setIsSending(true);
    setNotice('');
    try {
      for (let index = 0; index < current.length; index += 1) {
        const recipient = current[index];
        if (!recipient.selected || recipient.status !== 'pending') continue;
        current[index] = { ...recipient, status: 'sending', error: undefined };
        setRecipients([...current]);
        if (!saveCampaign(current)) {
          current[index] = { ...current[index], status: 'pending' };
          setRecipients([...current]);
          setNotice(isArabic ? 'تعذر حفظ تقدم الحملة؛ أوقفنا الإرسال لتجنب التكرار.' : 'Could not save campaign progress; sending stopped to avoid duplicates.');
          break;
        }
        try {
          // Use the canonical token returned by the same QR service as the customer QR card.
          // Every customer is resolved independently; no customer ID is used as a public token.
          const qr = await getCustomerQrCardData(recipient.id);
          if (!qr?.publicUrl || !qr.token) throw new Error('CUSTOMER_QR_LINK_UNAVAILABLE');
          const message = isArabic
            ? `مرحباً ${recipient.name}، هذا رابط حسابك الشخصي في نقطة الشحن: ${qr.publicUrl}\nافتح الرابط للاطلاع على حسابك.`
            : `Hello ${recipient.name}, this is your personal Charging Point account link: ${qr.publicUrl}\nOpen it to view your account.`;
          await sendSmsUsingSystemDefaultSim(recipient.phone, message);
          current[index] = { ...current[index], status: 'submitted' };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          current[index] = { ...current[index], status: 'failed', error: reason };
          setNotice(isArabic ? `توقف الإرسال عند ${recipient.name}. السبب: ${reason}` : `Sending stopped at ${recipient.name}. Reason: ${reason}`);
          setRecipients([...current]);
          saveCampaign(current);
          break;
        }
        setRecipients([...current]);
        saveCampaign(current);
      }
      if (!current.some((r) => r.selected && r.status === 'pending')) {
        setNotice(isArabic
          ? `انتهت الحملة: ${current.filter((r) => r.status === 'submitted').length} قُبلت للإرسال، ${current.filter((r) => r.status === 'failed').length} فشلت، ${current.filter((r) => r.status === 'uncertain').length} غير محسومة.`
          : `Campaign finished: ${current.filter((r) => r.status === 'submitted').length} submitted, ${current.filter((r) => r.status === 'failed').length} failed, ${current.filter((r) => r.status === 'uncertain').length} uncertain.`);
      }
    } finally { setIsSending(false); saveCampaign(current); }
  };

  const statusLabel = (status: Recipient['status']) => isArabic
    ? ({ pending: 'بانتظار الإرسال', sending: 'جارٍ الإرسال', submitted: 'قُبلت للإرسال', failed: 'فشل', uncertain: 'نتيجة غير محسومة' })[status]
    : ({ pending: 'Pending', sending: 'Sending', submitted: 'Submitted', failed: 'Failed', uncertain: 'Uncertain' })[status];

  return <div className="mx-auto max-w-3xl space-y-5 px-1 py-2 sm:px-0">
    <div className="flex items-center gap-3 border-b border-gray-200 pb-4 dark:border-[#14423b]">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 dark:bg-[#0c312b] dark:text-[#8eb698]"><MessageSquareText className="h-5 w-5" /></div>
      <div><h1 className="text-xl font-bold text-gray-900 dark:text-[#daf1de]">{isArabic ? 'الرسائل والتواصل' : 'Messages & Communication'}</h1><p className="mt-1 text-xs text-gray-500 dark:text-[#8eb698]">{isArabic ? 'إرسال رابط QR الشخصي لكل زبون عبر SMS' : 'Send each customer their own QR link by SMS'}</p></div>
    </div>
    {!isAndroidAdmin && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">{isArabic ? 'إرسال الرسائل يعمل من تطبيق الأدمن APK فقط، ويستخدم شريحة SMS الافتراضية في Android.' : 'SMS sending works only in the Admin APK and uses Android’s default SMS SIM.'}</div>}
    {!navigator.onLine && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">{isArabic ? 'إنشاء الروابط الشخصية يحتاج اتصال إنترنت؛ الإرسال متوقف أثناء عدم الاتصال.' : 'Personal links require internet access; sending is paused while offline.'}</div>}
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div className="rounded-xl border border-gray-200 p-3 dark:border-[#14423b]"><Users className="mb-1 h-4 w-4 text-gray-500" /><p className="text-xs text-gray-500 dark:text-[#8eb698]">{isArabic ? 'أرقام صالحة' : 'Valid numbers'}</p><p className="text-xl font-bold">{isLoading ? '…' : recipients.length}</p></div>
      <div className="rounded-xl border border-gray-200 p-3 dark:border-[#14423b]"><CheckCircle2 className="mb-1 h-4 w-4 text-emerald-600" /><p className="text-xs text-gray-500 dark:text-[#8eb698]">{isArabic ? 'قُبلت للإرسال' : 'Submitted'}</p><p className="text-xl font-bold">{counts.submitted}</p></div>
      <div className="rounded-xl border border-gray-200 p-3 dark:border-[#14423b]"><AlertTriangle className="mb-1 h-4 w-4 text-red-600" /><p className="text-xs text-gray-500 dark:text-[#8eb698]">{isArabic ? 'فشلت' : 'Failed'}</p><p className="text-xl font-bold">{counts.failed}</p></div>
      <div className="rounded-xl border border-gray-200 p-3 dark:border-[#14423b]"><AlertTriangle className="mb-1 h-4 w-4 text-orange-600" /><p className="text-xs text-gray-500 dark:text-[#8eb698]">{isArabic ? 'غير محسومة' : 'Uncertain'}</p><p className="text-xl font-bold">{counts.uncertain}</p></div>
    </div>
    <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-[#14423b] dark:bg-[#082622]">
      <div>
        <h2 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">{isArabic ? 'محتوى الرسالة والتخصيص' : 'Message content & personalization'}</h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-[#8eb698]">{isArabic ? 'اكتب رسالتك بحرية. استخدم المتغيرات لإدراج بيانات كل زبون تلقائياً.' : 'Write freely and use variables to insert each customer’s details automatically.'}</p>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        {['{name}', '{debt}', '{link}'].map((token) => <button key={token} type="button" onClick={() => updateTemplate(messageTemplate + (messageTemplate && !messageTemplate.endsWith(' ') ? ' ' : '') + token)} className="rounded-lg border border-emerald-200 px-3 py-1.5 font-semibold text-emerald-800 hover:bg-emerald-50 dark:border-[#28665a] dark:text-[#a9d9b7]">{token === '{name}' ? (isArabic ? 'اسم الزبون' : 'Customer name') : token === '{debt}' ? (isArabic ? 'مبلغ الدين' : 'Debt amount') : (isArabic ? 'الرابط الشخصي' : 'Personal link')}</button>)}
      </div>
      <textarea value={messageTemplate} onChange={(e) => updateTemplate(e.target.value)} rows={5} maxLength={2000} disabled={isSending} placeholder={isArabic ? 'اكتب نص الرسالة هنا…' : 'Write your message here…'} className="w-full resize-y rounded-xl border border-gray-200 bg-white p-3 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-emerald-500 dark:border-[#14423b] dark:bg-[#061f1c] dark:text-[#daf1de]" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-500 dark:text-[#8eb698]">{isArabic ? 'وجود {link} فقط هو ما ينشئ الرابط؛ احذفه لإرسال رسالة نصية عادية.' : 'Only {link} generates a personal link. Remove it for a plain SMS.'}</p>
        <button type="button" onClick={() => updateTemplate(DEFAULT_TEMPLATE)} disabled={isSending} className="text-xs font-semibold text-emerald-700 underline dark:text-emerald-400">{isArabic ? 'استعادة النص الافتراضي' : 'Restore default text'}</button>
      </div>
      {previewRecipient && <div className="rounded-xl bg-gray-50 p-3 dark:bg-[#061f1c]">
        <p className="mb-2 text-xs font-bold text-gray-600 dark:text-[#a9c9b1]">{isArabic ? `معاينة الرسالة — ${previewRecipient.name}` : `Message preview — ${previewRecipient.name}`}</p>
        <p dir="auto" className="whitespace-pre-wrap break-words text-sm text-gray-800 dark:text-[#daf1de]">{previewMessage}</p>
        {hasLinkToken && <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">{isArabic ? 'سيظهر الرابط الشخصي الحقيقي لهذا الزبون عند الإرسال.' : 'The customer’s actual personal link is inserted at send time.'}</p>}
      </div>}
    </section>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <label className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-[#daf1de]"><input type="checkbox" checked={recipients.length > 0 && recipients.filter((r) => r.status === 'pending').every((r) => r.selected)} onChange={(e) => toggleAll(e.target.checked)} disabled={isSending || isLoading} className="h-4 w-4 rounded" />{isArabic ? 'تحديد الكل' : 'Select all'}<span className="text-xs font-normal text-gray-500 dark:text-[#8eb698]">({selectedCount})</span></label>
      <div className="flex gap-2">
        <button type="button" onClick={startNewCampaign} disabled={isSending || isLoading} className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-[#14423b] dark:text-[#daf1de]">{isArabic ? 'حملة جديدة' : 'New campaign'}</button>
        <button type="button" onClick={sendSelected} disabled={isSending || isLoading || selectedCount === 0 || !navigator.onLine || !messageTemplate.trim()} className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"><Send className="h-4 w-4" />{isSending ? (isArabic ? 'جارٍ الإرسال…' : 'Sending…') : (isArabic ? 'إرسال الروابط المحددة' : 'Send selected links')}</button>
      </div>
    </div>
    <div className="relative"><Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={isArabic ? 'ابحث باسم الزبون أو رقم الهاتف' : 'Search by customer name or phone'} className="w-full rounded-xl border border-gray-200 bg-white py-2.5 ps-9 pe-3 text-sm dark:border-[#14423b] dark:bg-[#061f1c] dark:text-[#daf1de]" /></div>
    {notice && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">{notice}</div>}
    {loadError && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">{loadError}</div>}
    <section className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-[#14423b] dark:bg-[#082622]">
      <div className="flex items-center justify-between border-b border-gray-100 px-3 py-3 dark:border-[#14423b]"><span className="text-sm font-semibold">{isArabic ? 'الزبائن المستلمون' : 'Recipients'}</span><span className="text-xs text-emerald-700 dark:text-emerald-400">{isArabic ? `محدد: ${selectedCount}` : `Selected: ${selectedCount}`}</span></div>
      <div className="max-h-[55vh] divide-y divide-gray-100 overflow-y-auto dark:divide-[#14423b]">
        {isLoading ? <div className="flex items-center justify-center gap-2 p-8 text-sm text-gray-500"><LoaderCircle className="h-4 w-4 animate-spin" />{isArabic ? 'جاري قراءة الزبائن…' : 'Loading customers…'}</div>
          : visibleRecipients.length === 0 ? <p className="p-8 text-center text-sm text-gray-500">{isArabic ? 'لا توجد نتائج.' : 'No results.'}</p>
          : visibleRecipients.map((r) => <label key={r.id} className="flex cursor-pointer items-center justify-between gap-3 px-3 py-3 text-sm hover:bg-gray-50 dark:hover:bg-[#0b312b]">
            <span className="flex min-w-0 items-center gap-3"><input type="checkbox" checked={r.selected} onChange={() => toggleRecipient(r.id)} disabled={isSending || r.status !== 'pending'} className="h-4 w-4 shrink-0 rounded" /><span className="min-w-0"><span className="block truncate font-semibold text-gray-900 dark:text-[#daf1de]">{r.name}</span><span dir="ltr" className="block text-xs text-gray-500 dark:text-[#8eb698]">{r.phone}</span></span></span>
            <span className={`shrink-0 text-[11px] ${r.status === 'submitted' ? 'text-emerald-600' : r.status === 'failed' ? 'text-red-600' : r.status === 'uncertain' ? 'text-orange-600' : 'text-gray-500 dark:text-[#8eb698]'}`}>{statusLabel(r.status)}</span>
          </label>)}
      </div>
    </section>
    <p className="text-[11px] leading-5 text-gray-500 dark:text-[#8eb698]">{isArabic ? 'يُستخدم رمز QR المركزي المحفوظ لكل زبون، لذلك يختلف الرابط من زبون لآخر. «قُبلت للإرسال» تعني أن Android قبل الرسالة ولا تؤكد وصولها.' : 'Each link uses that customer’s own centrally stored QR token. “Submitted” means Android accepted the SMS, not that delivery was confirmed.'}</p>
  </div>;
};
