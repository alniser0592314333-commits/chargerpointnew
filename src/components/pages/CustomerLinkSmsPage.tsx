import React, { useEffect, useMemo, useRef, useState } from 'react';
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
type SavedMessageTemplate = { id: string; name: string; content: string };
const SAVED_TEMPLATES_KEY = 'chargerpoint.customerLinkSmsSavedTemplates.v1';
const MESSAGE_PRESETS = {
  debt: 'مرحباً {name} 🌹\nنذكّرك بلطف بوجود مبلغ مستحق على حسابك: {debt}. بنكون شاكرين إلك لو بتقدر تسدده يوم الخميس. يعطيك العافية.',
  link: 'مرحباً {name} 🌹\nهذا رابط حسابك الشخصي لمتابعة طلباتك ومعلوماتك: {link}\nيسعدنا خدمتك دائماً.',
  general: 'مرحباً {name} 🌹\nنتمنى تكون بخير. شكراً لثقتك بنا، إحنا دائماً بخدمتك.',
} as const;
const readSavedTemplates = (): SavedMessageTemplate[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_TEMPLATES_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.content === 'string') : [];
  } catch { return []; }
};


const renderMessageTemplate = (template: string, recipient: Recipient, link = ''): string => {
  const debt = recipient.balanceMinor < 0
    ? `${(Math.abs(recipient.balanceMinor) / 100).toLocaleString('ar', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₪`
    : 'لا يوجد';
  return template
    .replace(/\{name\}/g, recipient.name)
    .replace(/\{debt\}/g, debt)
    .replace(/\{link\}/g, link);
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
  const [savedTemplates, setSavedTemplates] = useState<SavedMessageTemplate[]>(readSavedTemplates);
  const [selectedSavedTemplate, setSelectedSavedTemplate] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');
  const [recipientFilter, setRecipientFilter] = useState('all');
  const [minimumDebt, setMinimumDebt] = useState('0');
  const [sendDelay, setSendDelay] = useState('0');
  const [isPaused, setIsPaused] = useState(false);
  const pauseRef = useRef(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [campaignStartedAt, setCampaignStartedAt] = useState('');
  const [campaignFinishedAt, setCampaignFinishedAt] = useState('');

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
  const hasLinkToken = messageTemplate.includes('{link}');
  // One generic preview for the whole campaign; never expose or switch to an individual customer's data.
  const previewMessage = messageTemplate
    .replace(/\\{name\\}/g, isArabic ? 'اسم الزبون' : 'Customer name')
    .replace(/\\{debt\\}/g, isArabic ? '50.00 شيكل' : '50.00 ILS')
    .replace(/\\{link\\}/g, isArabic ? 'رابط الزبون الشخصي' : 'Customer personal link');
  const updateTemplate = (value: string) => {
    setMessageTemplate(value);
    try { localStorage.setItem(TEMPLATE_KEY, value); } catch (error) {
      console.error('Could not save SMS template locally:', error);
    }
  };
  const saveCurrentTemplate = () => {
    const name = window.prompt(isArabic ? 'اكتب اسماً للقالب' : 'Name this template');
    if (!name?.trim()) return;
    const next = [...savedTemplates.filter((item) => item.name !== name.trim()), { id: `sms-${Date.now()}`, name: name.trim(), content: messageTemplate }];
    setSavedTemplates(next);
    setSelectedSavedTemplate(next[next.length - 1].id);
    try { localStorage.setItem(SAVED_TEMPLATES_KEY, JSON.stringify(next)); }
    catch (error) { console.error('Could not save SMS templates locally:', error); setNotice(isArabic ? 'تعذر حفظ القالب على الجهاز.' : 'Could not save the template on this device.'); }
  };
  const loadSavedTemplate = (id: string) => {
    setSelectedSavedTemplate(id);
    const template = savedTemplates.find((item) => item.id === id);
    if (template) updateTemplate(template.content);
  };
  const applyPreset = (kind: keyof typeof MESSAGE_PRESETS) => {
    updateTemplate(MESSAGE_PRESETS[kind]);
    setSelectedSavedTemplate('');
  };
  const startCustomMessage = () => {
    updateTemplate('');
    setSelectedSavedTemplate('');
  };
  const counts = useMemo(() => ({
    submitted: recipients.filter((r) => r.status === 'submitted').length,
    failed: recipients.filter((r) => r.status === 'failed').length,
    uncertain: recipients.filter((r) => r.status === 'uncertain').length,
  }), [recipients]);
  const minDebtMinor = Math.max(0, Number(minimumDebt || 0)) * 100;
  const visibleRecipients = recipients.filter((r) => {
    const matchesSearch = !search.trim() || r.name.toLowerCase().includes(search.trim().toLowerCase()) || r.phone.includes(search.trim());
    const debtMinor = Math.max(0, -r.balanceMinor);
    const matchesFilter = recipientFilter === 'all' || (recipientFilter === 'debt' && r.hasDebt && debtMinor >= minDebtMinor) || (recipientFilter === 'no-debt' && !r.hasDebt) || (recipientFilter === 'selected' && r.selected) || (recipientFilter === 'unselected' && !r.selected);
    return matchesSearch && matchesFilter;
  });
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
    updateRecipients(recipients.map((r) => ({ ...r, status: 'pending' as const, selected: r.hasDebt, error: undefined })));
    setNotice('');
  };

  const sendSelected = async () => {
    if (!isAndroidAdmin) { setNotice(isArabic ? 'إرسال SMS متاح من تطبيق الأدمن APK فقط.' : 'SMS sending is available from the Admin APK only.'); return; }
    if (messageTemplate.includes('{link}') && !navigator.onLine) { setNotice(isArabic ? 'يلزم الإنترنت فقط عند استخدام متغير الرابط الشخصي.' : 'Internet is required only when the personal-link variable is used.'); return; }
    if (!messageTemplate.trim()) { setNotice(isArabic ? 'اكتب محتوى الرسالة أولاً.' : 'Enter the message content first.'); return; }
    if (!selectedCount) { setNotice(isArabic ? 'حدد زبوناً واحداً على الأقل.' : 'Select at least one customer.'); return; }
    const confirmed = window.confirm(isArabic
      ? hasLinkToken
        ? `سيتم إنشاء/استخدام رابط QR الشخصي لكل زبون وإرسال الرسالة المخصصة إلى ${selectedCount} رقم. قد تُحتسب تكلفة الرسائل. هل تريد المتابعة؟`
        : `سيتم إرسال نص الرسالة الذي كتبته إلى ${selectedCount} رقم دون إنشاء روابط QR. قد تُحتسب تكلفة الرسائل. هل تريد المتابعة؟`
      : hasLinkToken
        ? `A personal QR link will be created or reused for each customer and your message sent to ${selectedCount} numbers. Carrier charges may apply. Continue?`
        : `Your custom text message will be sent to ${selectedCount} numbers without creating QR links. Carrier charges may apply. Continue?`);
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
          let personalLink = '';
          if (messageTemplate.includes('{link}')) {
            // Resolve the canonical personal QR only when the editable template asks for it.
            const qr = await getCustomerQrCardData(recipient.id);
            if (!qr?.publicUrl || !qr.token) throw new Error('CUSTOMER_QR_LINK_UNAVAILABLE');
            personalLink = qr.publicUrl;
          }
          const message = renderMessageTemplate(messageTemplate, recipient, personalLink).trim();
          if (!message) throw new Error('SMS_MESSAGE_EMPTY');
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
      <div><h1 className="text-xl font-bold text-gray-900 dark:text-[#daf1de]">{isArabic ? 'الرسائل والتواصل' : 'Messages & Communication'}</h1><p className="mt-1 text-xs text-gray-500 dark:text-[#8eb698]">{isArabic ? 'جهّز رسالة واحدة، ثم أرسلها للزبائن بالتتابع' : 'Prepare one message, then send it to recipients one by one'}</p></div>
    </div>
    {!isAndroidAdmin && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">{isArabic ? 'إرسال الرسائل يعمل من تطبيق الأدمن APK فقط، ويستخدم شريحة SMS الافتراضية في Android.' : 'SMS sending works only in the Admin APK and uses Android’s default SMS SIM.'}</div>}
    {!navigator.onLine && hasLinkToken && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">{isArabic ? 'إنشاء الروابط الشخصية يحتاج اتصال إنترنت؛ احذف {link} لإرسال رسالة نصية عادية دون إنترنت.' : 'Personal links require internet; remove {link} to send a plain SMS offline.'}</div>}
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
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs font-semibold text-gray-600 dark:text-[#a9c9b1]">{isArabic ? 'نوع الرسالة' : 'Message type'}
          <select value={Object.entries(MESSAGE_PRESETS).find(([, content]) => content === messageTemplate)?.[0] || 'custom'} onChange={(e) => { if (e.target.value !== 'custom') applyPreset(e.target.value as keyof typeof MESSAGE_PRESETS); }} disabled={isSending} className="mt-1 w-full rounded-lg border border-gray-200 bg-white p-2 text-sm dark:border-[#14423b] dark:bg-[#061f1c] dark:text-[#daf1de]">
            <option value="debt">{isArabic ? 'تذكير بالدين' : 'Debt reminder'}</option>
            <option value="link">{isArabic ? 'رسالة رابط QR' : 'QR link message'}</option>
            <option value="general">{isArabic ? 'رسالة عامة' : 'General message'}</option>
            <option value="custom">{isArabic ? 'رسالة مخصصة (بدون تغيير)' : 'Custom (keep current text)'}</option>
          </select>
        </label>
        <label className="text-xs font-semibold text-gray-600 dark:text-[#a9c9b1]">{isArabic ? 'قوالبي المحفوظة' : 'Saved templates'}
          <select value={selectedSavedTemplate} onChange={(e) => loadSavedTemplate(e.target.value)} disabled={isSending} className="mt-1 w-full rounded-lg border border-gray-200 bg-white p-2 text-sm dark:border-[#14423b] dark:bg-[#061f1c] dark:text-[#daf1de]">
            <option value="">{isArabic ? 'اختر قالباً محفوظاً' : 'Choose a saved template'}</option>
            {savedTemplates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={saveCurrentTemplate} disabled={isSending || !messageTemplate.trim()} className="rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-800 dark:border-[#28665a] dark:text-[#a9d9b7]">{isArabic ? 'حفظ كقالب جديد' : 'Save as template'}</button>
        <span className="text-[11px] text-gray-500 dark:text-[#8eb698]">{isArabic ? 'القوالب تُحفظ على هذا الجهاز فقط.' : 'Templates are stored on this device only.'}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={startCustomMessage} disabled={isSending} className="rounded-lg border border-blue-200 px-3 py-1.5 text-xs font-semibold text-blue-800 hover:bg-blue-50 dark:border-blue-900 dark:text-blue-300">{isArabic ? 'إنشاء رسالة مخصصة بالكامل' : 'Create a fully custom message'}</button>
        <span className="text-[11px] text-gray-500 dark:text-[#8eb698]">{isArabic ? 'اكتب أي نص تريده وعدّله بحرية؛ المتغيرات اختيارية وليست إلزامية.' : 'Write and edit any text freely; tokens are optional.'}</span>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        {['{name}', '{debt}', '{link}'].map((token) => <button key={token} type="button" onClick={() => updateTemplate(messageTemplate + (messageTemplate && !messageTemplate.endsWith(' ') ? ' ' : '') + token)} className="rounded-lg border border-emerald-200 px-3 py-1.5 font-semibold text-emerald-800 hover:bg-emerald-50 dark:border-[#28665a] dark:text-[#a9d9b7]">{token === '{name}' ? (isArabic ? 'اسم الزبون' : 'Customer name') : token === '{debt}' ? (isArabic ? 'مبلغ الدين' : 'Debt amount') : (isArabic ? 'الرابط الشخصي' : 'Personal link')}</button>)}
      </div>
      <textarea value={messageTemplate} onChange={(e) => updateTemplate(e.target.value)} rows={5} maxLength={2000} disabled={isSending} placeholder={isArabic ? 'اكتب نص الرسالة هنا…' : 'Write your message here…'} className="w-full resize-y rounded-xl border border-gray-200 bg-white p-3 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-emerald-500 dark:border-[#14423b] dark:bg-[#061f1c] dark:text-[#daf1de]" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-500 dark:text-[#8eb698]">{isArabic ? 'النص بالكامل قابل للتعديل. تقدر ترسل رسالة عادية بدون رصيد أو اسم أو رابط؛ أضف المتغيرات فقط إذا احتجتها.' : 'The entire message is editable. Send plain text without balance, name, or link; add tokens only when needed.'}</p>
        <button type="button" onClick={() => updateTemplate(DEFAULT_TEMPLATE)} disabled={isSending} className="text-xs font-semibold text-emerald-700 underline dark:text-emerald-400">{isArabic ? 'استعادة النص الافتراضي' : 'Restore default text'}</button>
      </div>
      <div className="rounded-xl bg-gray-50 p-3 dark:bg-[#061f1c]">
        <p className="mb-2 text-xs font-bold text-gray-600 dark:text-[#a9c9b1]">{isArabic ? 'معاينة عامة للرسالة' : 'General message preview'}</p>
        <p dir="auto" className="whitespace-pre-wrap break-words text-sm text-gray-800 dark:text-[#daf1de]">{previewMessage}</p>
        <p className="mt-2 text-[11px] text-gray-500 dark:text-[#8eb698]">{isArabic ? 'هذه معاينة نموذجية واحدة للحملة كلها، وليست معاينة خاصة بأي زبون.' : 'This is one generic campaign preview, not a preview for an individual customer.'}</p>
        {hasLinkToken && <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">{isArabic ? 'سيُدرج رابط QR الشخصي الصحيح لكل زبون وقت إرسال رسالته.' : 'Each recipient’s actual personal QR link is inserted when their individual SMS is sent.'}</p>}
      </div>
    </section>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <label className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-[#daf1de]"><input type="checkbox" checked={recipients.length > 0 && recipients.filter((r) => r.status === 'pending').every((r) => r.selected)} onChange={(e) => toggleAll(e.target.checked)} disabled={isSending || isLoading} className="h-4 w-4 rounded" />{isArabic ? 'تحديد الكل' : 'Select all'}<span className="text-xs font-normal text-gray-500 dark:text-[#8eb698]">({selectedCount})</span></label>
      <div className="flex gap-2">
        <button type="button" onClick={startNewCampaign} disabled={isSending || isLoading} className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-[#14423b] dark:text-[#daf1de]">{isArabic ? 'حملة جديدة' : 'New campaign'}</button>
        <button type="button" onClick={sendSelected} disabled={isSending || isLoading || selectedCount === 0 || (hasLinkToken && !navigator.onLine) || !messageTemplate.trim()} className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"><Send className="h-4 w-4" />{isSending ? (isArabic ? 'جارٍ الإرسال…' : 'Sending…') : (isArabic ? 'إرسال بالتتابع' : 'Send one by one')}</button>
      </div>
    </div>
    <div className="relative"><Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={isArabic ? 'ابحث باسم الزبون أو رقم الهاتف' : 'Search by customer name or phone'} className="w-full rounded-xl border border-gray-200 bg-white py-2.5 ps-9 pe-3 text-sm dark:border-[#14423b] dark:bg-[#061f1c] dark:text-[#daf1de]" /></div>
    {notice && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">{notice}</div>}
    {loadError && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">{loadError}</div>}
    <section className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-[#14423b] dark:bg-[#082622]">
      <div className="flex items-center justify-between border-b border-gray-100 px-3 py-3 dark:border-[#14423b]"><span className="text-sm font-semibold">{isArabic ? 'قائمة الإرسال بالتتابع' : 'Sequential sending list'}</span><span className="text-xs text-emerald-700 dark:text-emerald-400">{isArabic ? `محدد: ${selectedCount}` : `Selected: ${selectedCount}`}</span></div>
      <div className="max-h-[55vh] divide-y divide-gray-100 overflow-y-auto dark:divide-[#14423b]">
        {isLoading ? <div className="flex items-center justify-center gap-2 p-8 text-sm text-gray-500"><LoaderCircle className="h-4 w-4 animate-spin" />{isArabic ? 'جاري قراءة الزبائن…' : 'Loading customers…'}</div>
          : visibleRecipients.length === 0 ? <p className="p-8 text-center text-sm text-gray-500">{isArabic ? 'لا توجد نتائج.' : 'No results.'}</p>
          : visibleRecipients.map((r) => <label key={r.id} className="flex cursor-pointer items-center justify-between gap-3 px-3 py-3 text-sm hover:bg-gray-50 dark:hover:bg-[#0b312b]">
            <span className="flex min-w-0 items-center gap-3"><input type="checkbox" checked={r.selected} onChange={() => toggleRecipient(r.id)} disabled={isSending || r.status !== 'pending'} className="h-4 w-4 shrink-0 rounded" /><span className="min-w-0"><span className="block truncate font-semibold text-gray-900 dark:text-[#daf1de]">{r.name}</span><span dir="ltr" className="block text-xs text-gray-500 dark:text-[#8eb698]">{r.phone}</span></span></span>
            <span className={`shrink-0 text-[11px] ${r.status === 'submitted' ? 'text-emerald-600' : r.status === 'failed' ? 'text-red-600' : r.status === 'uncertain' ? 'text-orange-600' : 'text-gray-500 dark:text-[#8eb698]'}`}>{statusLabel(r.status)}</span>
          </label>)}
      </div>
    </section>
    <p className="text-[11px] leading-5 text-gray-500 dark:text-[#8eb698]">{isArabic ? 'يتم إرسال رسالة واحدة وانتظار نتيجة Android قبل الانتقال للرقم التالي. عند الفشل يتوقف التسلسل. «قُبلت للإرسال» تعني أن Android قبل الرسالة ولا تؤكد وصولها.' : 'Each SMS is sent individually; the app waits for Android’s result before moving to the next number. A failure stops the sequence. “Submitted” does not confirm delivery.'}</p>
  </div>;
};
