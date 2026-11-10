import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Archive, CheckCircle2, FileText, LoaderCircle, MessageSquareText, Search, Send, Users } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { useI18n } from '../../i18n/i18nContext';
import { getCustomerQrCardData, getSmsCustomerRecipients, SmsCustomerRecipient } from './dayOrdersStore';
import { sendSmsUsingSystemDefaultSim } from '../../services/nativeSms';

type RecipientStatus = 'pending' | 'sending' | 'submitted' | 'failed' | 'uncertain';
interface Recipient extends SmsCustomerRecipient { selected: boolean; status: RecipientStatus; error?: string; }
interface SavedMessageTemplate { id: string; name: string; content: string; }
interface SavedCampaign {
  id: string; updatedAt: string; startedAt?: string; finishedAt?: string;
  status?: 'draft' | 'sending' | 'paused' | 'stopped' | 'completed' | 'ended';
  messageTemplate?: string; dueDateText?: string; sendDelay?: string; recipients: Recipient[];
}
type Section = 'compose' | 'templates' | 'recipients' | 'campaigns' | 'archive';
const STORAGE_KEY = 'chargerpoint.customerLinkSmsCampaign.v1';
const ARCHIVE_KEY = 'chargerpoint.customerLinkSmsCampaignArchive.v1';
const TEMPLATE_KEY = 'chargerpoint.customerLinkSmsTemplate.v1';
const SAVED_TEMPLATES_KEY = 'chargerpoint.customerLinkSmsSavedTemplates.v1';
const DUE_DATE_KEY = 'chargerpoint.customerLinkSmsDueDate.v1';
const DEFAULT_DUE_DATE = 'الخميس';
const DEFAULT_TEMPLATE = 'مرحباً {name}، نذكّرك بلطف بوجود مبلغ مستحق على حسابك: {debt}. نرجو تسديده يوم {due_date} إن أمكن، وشكراً لثقتك بنا.';
const MESSAGE_PRESETS = {
  debt: 'مرحباً {name} 🌹\nنذكّرك بلطف بوجود مبلغ مستحق على حسابك: {debt}. بنكون شاكرين إلك لو بتقدر تسدده يوم {due_date}. يعطيك العافية.',
  link: 'مرحباً {name} 🌹\nهذا رابط حسابك الشخصي لمتابعة طلباتك ومعلوماتك: {link}\nيسعدنا خدمتك دائماً.',
  general: 'مرحباً {name} 🌹\nنتمنى تكون بخير. شكراً لثقتك بنا، إحنا دائماً بخدمتك.',
} as const;

const readCampaign = (): SavedCampaign | null => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!parsed || !Array.isArray(parsed.recipients)) return null;
    const interrupted = parsed.recipients.some((r: Recipient) => r.status === 'sending');
    return {
      ...parsed,
      id: typeof parsed.id === 'string' ? parsed.id : `legacy-${parsed.updatedAt || Date.now()}`,
      status: interrupted ? 'stopped' : parsed.status,
      recipients: parsed.recipients.map((r: Recipient) => r.status === 'sending'
        ? { ...r, status: 'uncertain', error: 'لم يتم تأكيد نتيجة الإرسال قبل إغلاق التطبيق' }
        : r),
    };
  } catch { return null; }
};
const readSavedTemplates = (): SavedMessageTemplate[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_TEMPLATES_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.content === 'string') : [];
  } catch { return []; }
};
const normalizePhone = (value: string): string | null => {
  const ascii = value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const ar = '٠١٢٣٤٥٦٧٨٩'; const east = '۰۱۲۳۴۵۶۷۸۹';
    const a = ar.indexOf(digit); if (a >= 0) return String(a);
    const e = east.indexOf(digit); return e >= 0 ? String(e) : digit;
  });
  const compact = ascii.trim().replace(/[^+\d]/g, '');
  const digits = compact.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return compact.startsWith('+') ? `+${digits}` : digits;
};
const renderMessageTemplate = (template: string, recipient: Recipient, link = '', dueDate = DEFAULT_DUE_DATE, locale = 'ar'): string => {
  const debt = recipient.balanceMinor < 0
    ? `${(Math.abs(recipient.balanceMinor) / 100).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₪`
    : 'لا يوجد';
  return template.replace(/\{name\}/g, recipient.name).replace(/\{debt\}/g, debt)
    .replace(/\{link\}/g, link).replace(/\{phone\}/g, recipient.phone)
    .replace(/\{date\}/g, new Date().toLocaleDateString(locale)).replace(/\{due_date\}/g, dueDate);
};

export const CustomerLinkSmsPage: React.FC<{
  section: 'compose' | 'templates' | 'recipients' | 'campaigns';
  onBack: () => void;
  onNavigate: (section: Section) => void;
}> = ({ section, onBack, onNavigate }) => {
  const { locale } = useI18n();
  const ar = locale === 'ar';
  const isAndroidAdmin = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' && import.meta.env.VITE_APP_VARIANT === 'admin';
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [dueDateText, setDueDateText] = useState(() => { try { return localStorage.getItem(DUE_DATE_KEY) || DEFAULT_DUE_DATE; } catch { return DEFAULT_DUE_DATE; } });
  const [messageTemplate, setMessageTemplate] = useState(() => {
    try { return localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE; } catch { return DEFAULT_TEMPLATE; }
  });
  const [savedTemplates, setSavedTemplates] = useState(readSavedTemplates);
  const [selectedSavedTemplate, setSelectedSavedTemplate] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');
  const [recipientFilter, setRecipientFilter] = useState('all');
  const [minimumDebt, setMinimumDebt] = useState('0');
  const [sendDelay, setSendDelay] = useState('0');
  const [campaignId, setCampaignId] = useState(() => readCampaign()?.id || `sms-${Date.now()}`);
  const [campaignStartedAt, setCampaignStartedAt] = useState(() => readCampaign()?.startedAt || '');
  const [campaignFinishedAt, setCampaignFinishedAt] = useState(() => readCampaign()?.finishedAt || '');
  const pauseRef = useRef(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const saveCampaign = (next: Recipient[], metadata: Partial<SavedCampaign> = {}): boolean => {
    try {
      const previous = readCampaign();
      const payload: SavedCampaign = {
        id: metadata.id ?? previous?.id ?? campaignId,
        updatedAt: new Date().toISOString(),
        startedAt: metadata.startedAt ?? previous?.startedAt ?? campaignStartedAt,
        finishedAt: metadata.finishedAt ?? previous?.finishedAt ?? campaignFinishedAt,
        status: metadata.status ?? previous?.status ?? 'draft',
        messageTemplate: metadata.messageTemplate ?? messageTemplate,
        dueDateText: metadata.dueDateText ?? dueDateText,
        sendDelay: metadata.sendDelay ?? sendDelay,
        recipients: next,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch (error) { console.error('Could not persist SMS campaign:', error); return false; }
  };

  useEffect(() => {
    let active = true;
    const previous = readCampaign();
    if (previous) {
      setCampaignId(previous.id);
      setCampaignStartedAt(previous.startedAt || '');
      setCampaignFinishedAt(previous.finishedAt || '');
      if (typeof previous.messageTemplate === 'string') setMessageTemplate(previous.messageTemplate);
      if (typeof previous.dueDateText === 'string') setDueDateText(previous.dueDateText);
      if (typeof previous.sendDelay === 'string') setSendDelay(previous.sendDelay);
    }
    getSmsCustomerRecipients().then((customers: SmsCustomerRecipient[]) => {
      if (!active) return;
      const oldById = new Map((previous?.recipients || []).map((r) => [r.id, r]));
      const next = customers.flatMap((customer): Recipient[] => {
        const phone = normalizePhone(customer.phone);
        if (!phone) return [];
        const old = oldById.get(customer.id);
        return [old ? { ...customer, phone, selected: old.selected, status: old.status, error: old.error }
          : { ...customer, phone, selected: customer.hasDebt, status: 'pending' }];
      });
      setRecipients(next);
      if (!previous) {
        const id = `sms-${Date.now()}`;
        setCampaignId(id);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ id, updatedAt: new Date().toISOString(), status: 'draft', messageTemplate, dueDateText, sendDelay, recipients: next })); } catch { /* sending remains disabled until persistence succeeds */ }
      }
    }).catch((error) => {
      console.error('Failed to load SMS recipients:', error);
      if (active) setLoadError(ar ? 'تعذرت قراءة قائمة الزبائن من البيانات المحلية.' : 'Could not load customers from the local store.');
    }).finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [ar]);

  const updateDueDate = (value: string) => {
    setDueDateText(value);
    try {
      localStorage.setItem(DUE_DATE_KEY, value);
      const previous = readCampaign();
      if (previous) localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...previous, dueDateText: value, updatedAt: new Date().toISOString() }));
    } catch (error) { console.error('Could not save campaign due date:', error); }
  };
  const updateTemplate = (value: string) => {
    setMessageTemplate(value);
    try {
      localStorage.setItem(TEMPLATE_KEY, value);
      const previous = readCampaign();
      if (previous) localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...previous, messageTemplate: value, updatedAt: new Date().toISOString() }));
    } catch (error) { console.error('Could not save SMS template:', error); }
  };
  const saveCurrentTemplate = () => {
    const name = window.prompt(ar ? 'اكتب اسماً للقالب' : 'Name this template');
    if (!name?.trim()) return;
    const next = [...savedTemplates.filter((x) => x.name !== name.trim()), { id: `sms-${Date.now()}`, name: name.trim(), content: messageTemplate }];
    try { localStorage.setItem(SAVED_TEMPLATES_KEY, JSON.stringify(next)); setSavedTemplates(next); setSelectedSavedTemplate(next[next.length - 1].id); }
    catch { setNotice(ar ? 'تعذر حفظ القالب على الجهاز.' : 'Could not save the template on this device.'); }
  };
  const loadSavedTemplate = (id: string) => {
    setSelectedSavedTemplate(id);
    const found = savedTemplates.find((x) => x.id === id);
    if (found) updateTemplate(found.content);
  };
  const deleteSavedTemplate = (id: string) => {
    if (!window.confirm(ar ? 'حذف هذا القالب من الجهاز؟' : 'Delete this saved template?')) return;
    const next = savedTemplates.filter((x) => x.id !== id);
    try { localStorage.setItem(SAVED_TEMPLATES_KEY, JSON.stringify(next)); setSavedTemplates(next); if (selectedSavedTemplate === id) setSelectedSavedTemplate(''); }
    catch { setNotice(ar ? 'تعذر حذف القالب.' : 'Could not delete the template.'); }
  };
  const applyPreset = (kind: keyof typeof MESSAGE_PRESETS) => updateTemplate(MESSAGE_PRESETS[kind]);
  const insertToken = (token: string) => {
    const editor = editorRef.current;
    const start = editor?.selectionStart ?? messageTemplate.length;
    const end = editor?.selectionEnd ?? messageTemplate.length;
    updateTemplate(messageTemplate.slice(0, start) + token + messageTemplate.slice(end));
    window.setTimeout(() => { editorRef.current?.focus(); editorRef.current?.setSelectionRange(start + token.length, start + token.length); }, 0);
  };

  const hasLinkToken = messageTemplate.includes('{link}');
  const previewMessage = messageTemplate.replace(/\{name\}/g, ar ? 'اسم الزبون' : 'Customer name')
    .replace(/\{debt\}/g, ar ? '50.00 شيكل' : '50.00 ILS')
    .replace(/\{link\}/g, ar ? 'رابط الزبون الشخصي' : 'Customer personal link')
    .replace(/\{phone\}/g, '059XXXXXXX').replace(/\{date\}/g, new Date().toLocaleDateString(ar ? 'ar' : 'en'))
    .replace(/\{due_date\}/g, dueDateText);
  const smsLength = useMemo(() => {
    const gsmBasic = /^[A-Za-z0-9 @£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,-.\/:;<=>?¡ÄÖÑÜ§¿äöñüà]*$/;
    const extension = new Set(['^', '{', '}', '\\', '[', ']', '~', '|', '€']);
    const gsm = [...messageTemplate].every((char) => gsmBasic.test(char) || extension.has(char));
    const units = gsm ? [...messageTemplate].reduce((n, char) => n + (extension.has(char) ? 2 : 1), 0) : messageTemplate.length;
    return { units, parts: units <= (gsm ? 160 : 70) ? 1 : Math.ceil(units / (gsm ? 153 : 67)), encoding: gsm ? 'GSM-7' : 'Unicode' };
  }, [messageTemplate]);

  const selectedCount = recipients.filter((r) => r.selected && r.status === 'pending').length;
  const counts = useMemo(() => ({
    submitted: recipients.filter((r) => r.status === 'submitted').length,
    failed: recipients.filter((r) => r.status === 'failed').length,
    uncertain: recipients.filter((r) => r.status === 'uncertain').length,
  }), [recipients]);
  const campaignProgress = useMemo(() => {
    const selected = recipients.filter((r) => r.selected);
    return { total: selected.length, done: selected.filter((r) => ['submitted', 'failed', 'uncertain'].includes(r.status)).length };
  }, [recipients]);
  const visibleRecipients = recipients.filter((r) => {
    const q = search.trim().toLowerCase();
    const matchesSearch = !q || r.name.toLowerCase().includes(q) || r.phone.includes(q);
    const debt = Math.max(0, -r.balanceMinor);
    const minDebt = Math.max(0, Number(minimumDebt || 0)) * 100;
    const matchesFilter = recipientFilter === 'all' || (recipientFilter === 'debt' && r.hasDebt && debt >= minDebt) ||
      (recipientFilter === 'no-debt' && !r.hasDebt) || (recipientFilter === 'selected' && r.selected) || (recipientFilter === 'unselected' && !r.selected);
    return matchesSearch && matchesFilter;
  });
  const updateRecipients = (next: Recipient[]) => {
    setRecipients(next);
    if (!saveCampaign(next)) setNotice(ar ? 'تعذر حفظ تقدم الحملة على الجهاز.' : 'Could not save campaign progress.');
  };
  const toggleRecipient = (id: string) => {
    if (isSending) return;
    updateRecipients(recipients.map((r) => r.id === id && r.status === 'pending' ? { ...r, selected: !r.selected } : r));
  };
  const toggleAll = (checked: boolean) => {
    if (isSending) return;
    updateRecipients(recipients.map((r) => r.status === 'pending' ? { ...r, selected: checked } : r));
  };
  const archiveCurrentCampaign = (nextRecipients = recipients): boolean => {
    try {
      const old = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '[]');
      const archive = Array.isArray(old) ? old : [];
      const archivedAt = new Date().toISOString();
      const previous = readCampaign();
      const item = {
        ...(previous || {}), id: campaignId, archivedAt,
        startedAt: campaignStartedAt || previous?.startedAt || undefined,
        finishedAt: campaignFinishedAt || archivedAt, status: 'ended',
        messageTemplate, dueDateText, sendDelay, recipients: nextRecipients,
      };
      localStorage.setItem(ARCHIVE_KEY, JSON.stringify([item, ...archive.filter((x: any) => x?.id !== campaignId)].slice(0, 100)));
      localStorage.removeItem(STORAGE_KEY);
      return true;
    } catch (error) { console.error('Could not archive SMS campaign:', error); return false; }
  };
  const createFreshCampaign = (next: Recipient[]) => {
    const id = `sms-${Date.now()}`;
    setCampaignId(id); setCampaignStartedAt(''); setCampaignFinishedAt('');
    setRecipients(next);
    saveCampaign(next, { id, startedAt: '', finishedAt: '', status: 'draft', messageTemplate });
  };
  const startNewCampaign = () => {
    if (isSending || !window.confirm(ar ? 'سيتم حفظ الحملة الحالية في الأرشيف وبدء حملة جديدة. هل تريد المتابعة؟' : 'Archive the current campaign and start a new one?')) return;
    if ((campaignStartedAt || recipients.some((r) => r.status !== 'pending')) && !archiveCurrentCampaign()) {
      setNotice(ar ? 'تعذر أرشفة الحملة؛ لم نغيّر بياناتها.' : 'Could not archive the campaign; no data was changed.'); return;
    }
    createFreshCampaign(recipients.map((r) => ({ ...r, status: 'pending' as const, selected: r.hasDebt, error: undefined })));
    setNotice(ar ? 'بدأت حملة جديدة. الحملة السابقة محفوظة في الأرشيف.' : 'New campaign started; previous campaign is archived.');
  };
  const endCampaign = () => {
    if (isSending || !window.confirm(ar ? 'إنهاء الحملة وأرشفة تقريرها؟' : 'End this campaign and archive its report?')) return;
    if (!archiveCurrentCampaign()) { setNotice(ar ? 'تعذر حفظ الأرشيف؛ أبقينا الحملة كما هي.' : 'Archive failed; current campaign was kept.'); return; }
    createFreshCampaign(recipients.map((r) => ({ ...r, status: 'pending', selected: r.hasDebt, error: undefined })));
    setNotice(ar ? 'تم إنهاء الحملة وأرشفة تقريرها. يمكنك بدء حملة جديدة.' : 'Campaign ended and archived. You can start a new campaign.');
  };

  const togglePause = () => {
    pauseRef.current = !pauseRef.current;
    setIsPaused(pauseRef.current);
    saveCampaign(recipients, { status: pauseRef.current ? 'paused' : 'sending' });
    setNotice(pauseRef.current ? (ar ? 'تم إيقاف الحملة مؤقتاً بعد الرسالة الحالية.' : 'Campaign paused after the current SMS.') : (ar ? 'تم استئناف الحملة.' : 'Campaign resumed.'));
  };

  const sendSelected = async () => {
    if (!isAndroidAdmin) { setNotice(ar ? 'إرسال SMS متاح من تطبيق الأدمن APK فقط.' : 'SMS sending is available from the Admin APK only.'); return; }
    if (hasLinkToken && !navigator.onLine) { setNotice(ar ? 'يلزم الإنترنت عند استخدام متغير الرابط الشخصي.' : 'Internet is required when using the personal-link token.'); return; }
    if (!messageTemplate.trim()) { setNotice(ar ? 'اكتب محتوى الرسالة أولاً.' : 'Enter the message first.'); return; }
    if (!selectedCount) { setNotice(ar ? 'حدد زبوناً واحداً على الأقل.' : 'Select at least one recipient.'); return; }
    if (!window.confirm(ar ? `سيتم إرسال الرسالة إلى ${selectedCount} رقم. قد تُحتسب تكلفة SMS. هل تريد المتابعة؟` : `Send SMS to ${selectedCount} numbers? Carrier charges may apply.`)) return;
    let current = recipients.map((r) => ({ ...r }));
    const startedAt = campaignStartedAt || new Date().toISOString();
    if (!saveCampaign(current, { id: campaignId, startedAt, finishedAt: '', status: 'sending', messageTemplate })) {
      setNotice(ar ? 'تعذر حفظ الحملة؛ أوقفنا الإرسال لتجنب التكرار.' : 'Could not save campaign; sending stopped to avoid duplicates.'); return;
    }
    setCampaignStartedAt(startedAt); setCampaignFinishedAt('');
    setIsSending(true); pauseRef.current = false; setIsPaused(false); setNotice('');
    try {
      for (let index = 0; index < current.length; index++) {
        const recipient = current[index];
        if (!recipient.selected || recipient.status !== 'pending') continue;
        while (pauseRef.current) await new Promise((resolve) => window.setTimeout(resolve, 250));
        current[index] = { ...recipient, status: 'sending', error: undefined };
        setRecipients([...current]);
        if (!saveCampaign(current, { status: 'sending', startedAt, finishedAt: '' })) {
          current[index] = { ...current[index], status: 'pending' }; setRecipients([...current]);
          setNotice(ar ? 'تعذر حفظ تقدم الحملة؛ أوقفنا الإرسال لتجنب التكرار.' : 'Could not save progress; sending stopped.'); break;
        }
        try {
          let personalLink = '';
          if (messageTemplate.includes('{link}')) {
            const qr = await getCustomerQrCardData(recipient.id);
            if (!qr?.publicUrl || !qr.token) throw new Error('CUSTOMER_QR_LINK_UNAVAILABLE');
            personalLink = qr.publicUrl;
          }
          const sms = renderMessageTemplate(messageTemplate, recipient, personalLink, dueDateText, ar ? 'ar' : 'en').trim();
          if (!sms) throw new Error('SMS_MESSAGE_EMPTY');
          await sendSmsUsingSystemDefaultSim(recipient.phone, sms);
          current[index] = { ...current[index], status: 'submitted' };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          current[index] = { ...current[index], status: 'failed', error: reason };
          setNotice(ar ? `توقف الإرسال عند ${recipient.name}. السبب: ${reason}` : `Sending stopped at ${recipient.name}: ${reason}`);
          setRecipients([...current]); saveCampaign(current, { status: 'stopped', startedAt }); break;
        }
        setRecipients([...current]); saveCampaign(current, { status: 'sending', startedAt });
        const delayMs = Number(sendDelay) * 1000;
        if (delayMs > 0 && current.some((r, i) => i > index && r.selected && r.status === 'pending')) {
          const deadline = Date.now() + delayMs;
          while (Date.now() < deadline) {
            while (pauseRef.current) await new Promise((resolve) => window.setTimeout(resolve, 250));
            await new Promise((resolve) => window.setTimeout(resolve, Math.min(250, deadline - Date.now())));
          }
        }
      }
      if (!current.some((r) => r.selected && r.status === 'pending')) {
        setNotice(ar ? `انتهت الحملة: ${current.filter((r) => r.status === 'submitted').length} قُبلت، ${current.filter((r) => r.status === 'failed').length} فشلت، ${current.filter((r) => r.status === 'uncertain').length} غير محسومة.` : `Finished: ${current.filter((r) => r.status === 'submitted').length} submitted, ${current.filter((r) => r.status === 'failed').length} failed, ${current.filter((r) => r.status === 'uncertain').length} uncertain.`);
      }
    } finally {
      setIsSending(false); pauseRef.current = false; setIsPaused(false);
      const finishedAt = new Date().toISOString();
      setCampaignFinishedAt(finishedAt);
      const hasPending = current.some((r) => r.selected && r.status === 'pending');
      saveCampaign(current, { id: campaignId, startedAt, finishedAt, status: hasPending ? 'stopped' : 'completed', messageTemplate });
    }
  };

  const statusLabel = (status: RecipientStatus) => ar
    ? ({ pending: 'بانتظار الإرسال', sending: 'جارٍ الإرسال', submitted: 'قُبلت للإرسال', failed: 'فشل', uncertain: 'نتيجة غير محسومة' })[status]
    : ({ pending: 'Pending', sending: 'Sending', submitted: 'Submitted', failed: 'Failed', uncertain: 'Uncertain' })[status];
  const titles: Record<typeof section, string> = {
    compose: ar ? 'كتابة الرسالة' : 'Compose message',
    templates: ar ? 'قوالب الرسائل' : 'Message templates',
    recipients: ar ? 'المستلمون' : 'Recipients',
    campaigns: ar ? 'إدارة الحملات' : 'Campaign management',
  };

  return <div className="mx-auto max-w-3xl space-y-5 px-1 py-2 sm:px-0">
    <header className="flex items-center gap-3 border-b border-gray-200 pb-4 dark:border-[#14423b]">
      <button type="button" onClick={onBack} disabled={isSending} className="rounded-lg p-2 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-[#0c312b]" aria-label={ar ? 'رجوع' : 'Back'}><ArrowLeft className="h-5 w-5" /></button>
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 dark:bg-[#0c312b] dark:text-[#8eb698]"><MessageSquareText className="h-5 w-5" /></div>
      <div className="min-w-0 flex-1"><h1 className="text-xl font-bold text-gray-900 dark:text-[#daf1de]">{titles[section]}</h1><p className="mt-1 text-xs text-gray-500 dark:text-[#8eb698]">{ar ? 'كل مهمة في صفحة مستقلة' : 'Each task has its own page'}</p></div>
      {(campaignStartedAt || recipients.some((r) => r.status !== 'pending')) && <button type="button" onClick={endCampaign} disabled={isSending} className="rounded-lg border border-red-200 px-2.5 py-2 text-xs font-semibold text-red-700 disabled:opacity-50 dark:border-red-900 dark:text-red-300">{ar ? 'إنهاء الحملة' : 'End campaign'}</button>}
      <button type="button" onClick={() => onNavigate('archive')} disabled={isSending} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-2 text-xs font-semibold disabled:opacity-40 dark:border-[#14423b]"><Archive className="h-4 w-4" />{ar ? 'الأرشيف' : 'Archive'}</button>
    </header>
    {!isAndroidAdmin && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">{ar ? 'إرسال SMS متاح من تطبيق الأدمن APK فقط، ويستخدم شريحة Android الافتراضية.' : 'SMS sending is available in the Admin APK only and uses Android’s default SMS SIM.'}</div>}
    {notice && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">{notice}</div>}
    {loadError && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">{loadError}</div>}

    {section === 'compose' && <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-[#14423b] dark:bg-[#082622]">
      <div><h2 className="text-sm font-bold">{ar ? 'محتوى الرسالة والتخصيص' : 'Message content & personalization'}</h2><p className="mt-1 text-xs text-gray-500">{ar ? 'اكتب بحرية وأضف المتغيرات التي تحتاجها فقط.' : 'Write freely and add only the variables you need.'}</p></div>
      <label className="block text-xs font-semibold">{ar ? 'موعد التسديد المستخدم في {due_date}' : 'Due date used for {due_date}'}<input value={dueDateText} onChange={(e) => updateDueDate(e.target.value)} disabled={isSending} maxLength={60} className="mt-1 w-full rounded-lg border border-gray-200 bg-white p-2.5 text-sm dark:border-[#14423b] dark:bg-[#061f1c]" placeholder={ar ? 'مثلاً: الخميس القادم' : 'e.g. next Thursday'} /></label>
      <textarea ref={editorRef} value={messageTemplate} onChange={(e) => updateTemplate(e.target.value)} rows={7} maxLength={2000} disabled={isSending} placeholder={ar ? 'اكتب نص الرسالة هنا…' : 'Write your message…'} className="w-full resize-y rounded-xl border border-gray-200 bg-white p-3 text-sm text-gray-900 dark:border-[#14423b] dark:bg-[#061f1c] dark:text-[#daf1de]" />
      <div className="flex flex-wrap gap-2 text-xs">{Object.entries({ name: ar ? 'اسم الزبون' : 'Customer name', debt: ar ? 'مبلغ الدين' : 'Debt amount', link: ar ? 'الرابط الشخصي' : 'Personal link', phone: ar ? 'رقم الهاتف' : 'Phone number', date: ar ? 'تاريخ اليوم' : 'Today', due_date: ar ? 'موعد التسديد' : 'Due date' }).map(([key, label]) => <button key={key} type="button" onClick={() => insertToken(`{${key}}`)} disabled={isSending} className="rounded-lg border border-emerald-200 px-3 py-1.5 font-semibold text-emerald-800 dark:border-[#28665a] dark:text-[#a9d9b7]">+ {label}</button>)}</div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500"><span>{ar ? `الأحرف: ${smsLength.units} • الترميز: ${smsLength.encoding} • أجزاء SMS المقدرة: ${smsLength.parts}` : `Units: ${smsLength.units} • ${smsLength.encoding} • Estimated parts: ${smsLength.parts}`}</span><button type="button" onClick={() => updateTemplate(DEFAULT_TEMPLATE)} className="font-semibold text-emerald-700 underline">{ar ? 'استعادة النص الافتراضي' : 'Restore default'}</button></div>
      <div className="rounded-xl bg-gray-50 p-3 dark:bg-[#061f1c]"><p className="mb-2 text-xs font-bold">{ar ? 'معاينة الرسالة' : 'Preview'}</p><p dir="auto" className="whitespace-pre-wrap break-words text-sm">{previewMessage}</p>{hasLinkToken && <p className="mt-2 text-[11px] text-amber-700">{ar ? 'سيتم إدراج رابط QR الخاص بكل زبون عند الإرسال.' : 'Each customer’s own QR link is inserted at send time.'}</p>}</div>
      <div className="flex justify-end"><button type="button" onClick={() => onNavigate('recipients')} className="rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white">{ar ? 'التالي: المستلمون' : 'Next: recipients'}</button></div>
    </section>}

    {section === 'templates' && <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-[#14423b] dark:bg-[#082622]">
      <h2 className="text-sm font-bold">{ar ? 'القوالب الجاهزة' : 'Built-in presets'}</h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">{Object.entries(MESSAGE_PRESETS).map(([key, value]) => <button key={key} type="button" onClick={() => { applyPreset(key as keyof typeof MESSAGE_PRESETS); onNavigate('compose'); }} className="rounded-xl border border-gray-200 p-3 text-start text-xs dark:border-[#14423b]"><strong className="block text-sm">{key === 'debt' ? (ar ? 'تذكير بالدين' : 'Debt reminder') : key === 'link' ? (ar ? 'رابط QR' : 'QR link') : (ar ? 'رسالة عامة' : 'General message')}</strong><span className="mt-1 line-clamp-3 block text-gray-500">{value}</span></button>)}</div>
      <div className="border-t border-gray-100 pt-4 dark:border-[#14423b]"><h3 className="mb-3 text-sm font-bold">{ar ? 'قوالبي المحفوظة على هذا الجهاز' : 'Saved templates on this device'}</h3>
        {savedTemplates.length === 0 ? <p className="text-xs text-gray-500">{ar ? 'لم تحفظ قوالب بعد. اكتب رسالة ثم احفظها من المحرر.' : 'No saved templates yet. Write a message and save it from the editor.'}</p> : <div className="space-y-2">{savedTemplates.map((item) => <div key={item.id} className="flex items-center gap-2 rounded-lg border border-gray-200 p-3 dark:border-[#14423b]"><div className="min-w-0 flex-1"><strong className="block text-sm">{item.name}</strong><span className="block truncate text-xs text-gray-500">{item.content}</span></div><button type="button" onClick={() => { loadSavedTemplate(item.id); onNavigate('compose'); }} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs text-white">{ar ? 'تحميل' : 'Load'}</button><button type="button" onClick={() => deleteSavedTemplate(item.id)} className="rounded-lg border border-red-200 px-3 py-2 text-xs text-red-700">{ar ? 'حذف' : 'Delete'}</button></div>)}</div>}
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => onNavigate('compose')} className="rounded-lg border border-gray-200 px-3 py-2 text-xs dark:border-[#14423b]">{ar ? 'فتح محرر الرسائل' : 'Open message editor'}</button><button type="button" onClick={saveCurrentTemplate} disabled={!messageTemplate.trim()} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs text-white">{ar ? 'حفظ النص الحالي كقالب' : 'Save current message as template'}</button></div>
      </div>
    </section>}

    {section === 'recipients' && <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-[#14423b] dark:bg-[#082622]">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="text-xs font-semibold">{ar ? 'تصفية الزبائن' : 'Filter customers'}<select value={recipientFilter} onChange={(e) => setRecipientFilter(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 bg-white p-2 text-sm dark:border-[#14423b] dark:bg-[#061f1c]"><option value="all">{ar ? 'الكل' : 'All'}</option><option value="debt">{ar ? 'عليهم دين' : 'Has debt'}</option><option value="no-debt">{ar ? 'بدون دين' : 'No debt'}</option><option value="selected">{ar ? 'المحددون' : 'Selected'}</option><option value="unselected">{ar ? 'غير المحددين' : 'Unselected'}</option></select></label>
        <label className="text-xs font-semibold">{ar ? 'أقل مبلغ دين (شيكل)' : 'Minimum debt (ILS)'}<input type="number" min="0" value={minimumDebt} onChange={(e) => setMinimumDebt(e.target.value)} disabled={recipientFilter !== 'debt'} className="mt-1 w-full rounded-lg border border-gray-200 p-2 text-sm dark:border-[#14423b] dark:bg-[#061f1c]" /></label>
        <label className="text-xs font-semibold">{ar ? 'الفاصل بين الرسائل' : 'Delay between SMS'}<select value={sendDelay} onChange={(e) => { setSendDelay(e.target.value); saveCampaign(recipients, { sendDelay: e.target.value }); }} className="mt-1 w-full rounded-lg border border-gray-200 p-2 text-sm dark:border-[#14423b] dark:bg-[#061f1c]"><option value="0">{ar ? 'بدون تأخير' : 'No delay'}</option><option value="2">2 {ar ? 'ثانية' : 'seconds'}</option><option value="5">5 {ar ? 'ثوانٍ' : 'seconds'}</option><option value="10">10 {ar ? 'ثوانٍ' : 'seconds'}</option></select></label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={recipients.length > 0 && recipients.filter(r => r.status === 'pending').every(r => r.selected)} onChange={(e) => toggleAll(e.target.checked)} disabled={isSending || isLoading} />{ar ? 'تحديد كل المعلّقين' : 'Select all pending'} ({selectedCount})</label><div className="relative w-full sm:max-w-xs"><Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={ar ? 'ابحث بالاسم أو الهاتف' : 'Search name or phone'} className="w-full rounded-xl border border-gray-200 py-2.5 ps-9 pe-3 text-sm dark:border-[#14423b] dark:bg-[#061f1c]" /></div></div>
      <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-[#14423b]"><div className="flex justify-between border-b border-gray-100 p-3 text-xs dark:border-[#14423b]"><strong>{ar ? 'قائمة الزبائن' : 'Customer list'}</strong><span>{ar ? `محدد: ${selectedCount}` : `Selected: ${selectedCount}`}</span></div><div className="max-h-[60vh] divide-y divide-gray-100 overflow-y-auto dark:divide-[#14423b]">
        {isLoading ? <div className="p-8 text-center text-sm text-gray-500"><LoaderCircle className="mx-auto mb-2 h-4 w-4 animate-spin" />{ar ? 'جاري قراءة الزبائن…' : 'Loading customers…'}</div> : visibleRecipients.length === 0 ? <p className="p-8 text-center text-sm text-gray-500">{ar ? 'لا توجد نتائج.' : 'No results.'}</p> : visibleRecipients.map(r => <label key={r.id} className="flex cursor-pointer items-center justify-between gap-3 px-3 py-3 text-sm"><span className="flex min-w-0 items-center gap-3"><input type="checkbox" checked={r.selected} onChange={() => toggleRecipient(r.id)} disabled={isSending || r.status !== 'pending'} /><span className="min-w-0"><strong className="block truncate">{r.name}</strong><span dir="ltr" className="block text-xs text-gray-500">{r.phone}</span><span className="text-[11px] text-gray-400">{r.hasDebt ? (ar ? 'عليه دين' : 'Has debt') : (ar ? 'بدون دين' : 'No debt')}</span></span></span><span className="shrink-0 text-[11px]">{statusLabel(r.status)}</span></label>)}
      </div></div>
      <div className="flex justify-end"><button type="button" onClick={() => onNavigate('campaigns')} className="rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white">{ar ? 'التالي: إدارة الحملة' : 'Next: campaign'}</button></div>
    </section>}

    {section === 'campaigns' && <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-[#14423b] dark:bg-[#082622]">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><div className="rounded-xl border border-gray-200 p-3 dark:border-[#14423b]"><Users className="mb-1 h-4 w-4" /><p className="text-xs text-gray-500">{ar ? 'أرقام صالحة' : 'Valid numbers'}</p><p className="text-xl font-bold">{isLoading ? '…' : recipients.length}</p></div><div className="rounded-xl border border-gray-200 p-3 dark:border-[#14423b]"><CheckCircle2 className="mb-1 h-4 w-4 text-emerald-600" /><p className="text-xs text-gray-500">{ar ? 'قُبلت' : 'Submitted'}</p><p className="text-xl font-bold">{counts.submitted}</p></div><div className="rounded-xl border border-gray-200 p-3 dark:border-[#14423b]"><AlertTriangle className="mb-1 h-4 w-4 text-red-600" /><p className="text-xs text-gray-500">{ar ? 'فشلت' : 'Failed'}</p><p className="text-xl font-bold">{counts.failed}</p></div><div className="rounded-xl border border-gray-200 p-3 dark:border-[#14423b]"><AlertTriangle className="mb-1 h-4 w-4 text-orange-600" /><p className="text-xs text-gray-500">{ar ? 'غير محسومة' : 'Uncertain'}</p><p className="text-xl font-bold">{counts.uncertain}</p></div></div>
      <div className="rounded-xl bg-gray-50 p-3 dark:bg-[#061f1c]"><div className="flex justify-between text-sm"><strong>{ar ? 'تقدم الحملة' : 'Campaign progress'}</strong><span>{campaignProgress.done}/{campaignProgress.total}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-[#0b312b]"><div className="h-full bg-emerald-600" style={{ width: campaignProgress.total ? `${campaignProgress.done / campaignProgress.total * 100}%` : '0%' }} /></div><p className="mt-2 text-xs text-gray-500">{campaignStartedAt ? (ar ? 'بدأت: ' : 'Started: ') + new Date(campaignStartedAt).toLocaleString() : (ar ? 'لم تبدأ بعد' : 'Not started yet')}{campaignFinishedAt ? ' · ' + (ar ? 'انتهت: ' : 'Ended: ') + new Date(campaignFinishedAt).toLocaleString() : ''}</p></div>
      <div className="flex flex-wrap gap-2"><button type="button" onClick={() => onNavigate('compose')} className="rounded-lg border border-gray-200 px-3 py-2 text-xs dark:border-[#14423b]">{ar ? 'تعديل الرسالة' : 'Edit message'}</button><button type="button" onClick={() => onNavigate('recipients')} className="rounded-lg border border-gray-200 px-3 py-2 text-xs dark:border-[#14423b]">{ar ? 'تعديل المستلمين' : 'Edit recipients'}</button>{isSending && <button type="button" onClick={togglePause} className="rounded-lg border border-amber-300 px-3 py-2 text-xs text-amber-800">{isPaused ? (ar ? 'استئناف' : 'Resume') : (ar ? 'إيقاف مؤقت' : 'Pause')}</button>}<button type="button" onClick={startNewCampaign} disabled={isSending || isLoading} className="rounded-lg border border-gray-200 px-3 py-2 text-xs dark:border-[#14423b]">{ar ? 'حملة جديدة' : 'New campaign'}</button><button type="button" onClick={endCampaign} disabled={isSending || isLoading} className="rounded-lg border border-red-200 px-3 py-2 text-xs text-red-700">{ar ? 'إنهاء الحملة وأرشفتها' : 'End & archive campaign'}</button><button type="button" onClick={sendSelected} disabled={isSending || isLoading || selectedCount === 0 || (hasLinkToken && !navigator.onLine) || !messageTemplate.trim()} className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"><Send className="h-4 w-4" />{isSending ? (ar ? 'جارٍ الإرسال…' : 'Sending…') : (ar ? 'إرسال بالتتابع' : 'Send sequentially')}</button></div>
      <div className="rounded-xl border border-gray-200 p-3 dark:border-[#14423b]"><div className="mb-2 flex justify-between text-xs"><strong>{ar ? 'نتائج الحملة' : 'Campaign results'}</strong><span>{campaignProgress.done}/{campaignProgress.total}</span></div><div className="max-h-64 divide-y divide-gray-100 overflow-y-auto dark:divide-[#14423b]">{recipients.filter(r => r.selected).map(r => <div key={r.id} className="flex justify-between gap-3 py-2 text-xs"><span className="truncate">{r.name}</span><span className="shrink-0">{statusLabel(r.status)}{r.error ? ' · ' + r.error : ''}</span></div>)}</div></div>
      <p className="text-[11px] leading-5 text-gray-500">{ar ? 'قُبلت للإرسال تعني أن Android قبل الرسالة، ولا تؤكد وصولها. الرسائل ذات النتيجة غير المحسومة لا يعاد إرسالها تلقائياً.' : 'Submitted means Android accepted the SMS, not that it was delivered. Uncertain messages are never retried automatically.'}</p>
    </section>}
  </div>;
};
