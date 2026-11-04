import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, LoaderCircle, MessageSquareText, Send, Users, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { useI18n } from '../../i18n/i18nContext';
import { getSmsCustomerRecipients, SmsCustomerRecipient } from './dayOrdersStore';
import { sendSmsUsingSystemDefaultSim } from '../../services/nativeSms';

type RecipientStatus = 'pending' | 'sending' | 'submitted' | 'failed' | 'uncertain';

interface CampaignRecipient {
  id: string;
  name: string;
  phone: string;
  status: RecipientStatus;
  error?: string;
}

interface SavedCampaign {
  message: string;
  updatedAt: string;
  recipients: CampaignRecipient[];
}

const STORAGE_KEY = 'chargerpoint.bulkSmsCampaign.v1';

const toAsciiDigits = (value: string): string =>
  value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabicIndic = '٠١٢٣٤٥٦٧٨٩';
    const easternArabicIndic = '۰۱۲۳۴۵۶۷۸۹';
    const arabicIndex = arabicIndic.indexOf(digit);
    if (arabicIndex >= 0) return String(arabicIndex);
    const easternIndex = easternArabicIndic.indexOf(digit);
    return easternIndex >= 0 ? String(easternIndex) : digit;
  });

const normalizePhone = (value: string): { phone: string; key: string } | null => {
  const ascii = toAsciiDigits(value.trim());
  const phone = ascii.replace(/[^+\d]/g, '');
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return { phone: phone.startsWith('+') ? `+${digits}` : digits, key: digits };
};

const buildRecipients = (customers: SmsCustomerRecipient[]): CampaignRecipient[] => {
  const seen = new Set<string>();
  const recipients: CampaignRecipient[] = [];

  for (const customer of customers) {
    if (!customer.phone?.trim()) continue;
    const normalized = normalizePhone(customer.phone);
    if (!normalized || seen.has(normalized.key)) continue;
    seen.add(normalized.key);
    recipients.push({
      id: customer.id,
      name: customer.name,
      phone: normalized.phone,
      status: 'pending',
    });
  }

  return recipients;
};

const readSavedCampaign = (): SavedCampaign | null => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedCampaign;
    if (!parsed || !Array.isArray(parsed.recipients) || typeof parsed.message !== 'string') return null;
    // A reload during a native submission leaves an ambiguous outcome. Never auto-retry it.
    parsed.recipients = parsed.recipients.map((recipient) =>
      recipient.status === 'sending'
        ? { ...recipient, status: 'uncertain', error: 'لم يتم تأكيد النتيجة قبل إغلاق التطبيق' }
        : recipient
    );
    return parsed;
  } catch {
    return null;
  }
};

const persistCampaign = (campaign: SavedCampaign): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(campaign));
  } catch (error) {
    console.error('Unable to persist bulk SMS campaign locally:', error);
  }
};

export const BulkSmsReminderModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { locale } = useI18n();
  const isArabic = locale === 'ar';
  const [message, setMessage] = useState('');
  const [recipients, setRecipients] = useState<CampaignRecipient[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const stopRequestedRef = useRef(false);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [savedCampaign, setSavedCampaign] = useState<SavedCampaign | null>(null);

  useEffect(() => {
    let active = true;
    const previousCampaign = readSavedCampaign();
    setSavedCampaign(previousCampaign);
    if (previousCampaign) setMessage(previousCampaign.message);
    getSmsCustomerRecipients()
      .then((customers) => {
        if (!active) return;
        const freshRecipients = buildRecipients(customers);
        if (!previousCampaign) {
          setRecipients(freshRecipients);
          return;
        }
        const previousByPhone = new Map(previousCampaign.recipients.map((recipient) => [recipient.phone, recipient]));
        setRecipients(freshRecipients.map((recipient) => {
          const previous = previousByPhone.get(recipient.phone);
          return previous
            ? { ...recipient, status: previous.status, error: previous.error }
            : recipient;
        }));
      })
      .catch((error) => {
        console.error('Failed to prepare bulk SMS recipients:', error);
        if (active) setLoadError(isArabic ? 'تعذر قراءة قائمة الزبائن المحلية.' : 'Could not read the local customer list.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => { active = false; };
  }, [isArabic]);

  const counts = useMemo(() => ({
    pending: recipients.filter((recipient) => recipient.status === 'pending').length,
    submitted: recipients.filter((recipient) => recipient.status === 'submitted').length,
    failed: recipients.filter((recipient) => recipient.status === 'failed').length,
    uncertain: recipients.filter((recipient) => recipient.status === 'uncertain').length,
  }), [recipients]);

  const saveCurrentCampaign = (nextRecipients: CampaignRecipient[], nextMessage = message) => {
    const campaign: SavedCampaign = {
      message: nextMessage,
      updatedAt: new Date().toISOString(),
      recipients: nextRecipients,
    };
    persistCampaign(campaign);
    setSavedCampaign(campaign);
  };

  const startNewCampaign = () => {
    const nextRecipients = recipients.map((recipient) => ({ ...recipient, status: 'pending' as const, error: undefined }));
    setRecipients(nextRecipients);
    setMessage('');
    setNotice('');
    setSavedCampaign(null);
    persistCampaign({ message: '', updatedAt: new Date().toISOString(), recipients: nextRecipients });
  };

  const startSending = async () => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      setNotice(isArabic ? 'اكتب نص الرسالة أولًا.' : 'Enter the message first.');
      return;
    }
    if (recipients.length === 0) {
      setNotice(isArabic ? 'لا يوجد رقم هاتف صالح للإرسال.' : 'There are no valid phone numbers to send to.');
      return;
    }

    const confirmed = window.confirm(
      isArabic
        ? `سيتم إرسال SMS إلى ${recipients.filter((recipient) => recipient.status === 'pending').length} رقم. قد تُحتسب تكلفة على الشريحة. هل تريد المتابعة؟`
        : `SMS will be submitted to ${recipients.filter((recipient) => recipient.status === 'pending').length} numbers. Your carrier may charge for them. Continue?`
    );
    if (!confirmed) return;

    setIsSending(true);
    stopRequestedRef.current = false;
    setNotice('');
    let current = recipients.map((recipient) => ({ ...recipient }));
    saveCurrentCampaign(current, trimmedMessage);

    try {
      for (let index = 0; index < current.length; index += 1) {
        if (stopRequestedRef.current) break;
        if (current[index].status !== 'pending') continue;

        current[index] = { ...current[index], status: 'sending', error: undefined };
        setRecipients([...current]);
        saveCurrentCampaign(current, trimmedMessage);

        try {
          await sendSmsUsingSystemDefaultSim(current[index].phone, trimmedMessage);
          current[index] = { ...current[index], status: 'submitted' };
        } catch (error) {
          const code = error instanceof Error ? error.message : String(error);
          current[index] = { ...current[index], status: 'failed', error: code };
          // Stop on first failure (including missing permission/default SIM) so the user can
          // correct the phone settings before another recipient is attempted.
          setNotice(
            isArabic
              ? `توقف الإرسال عند ${current[index].name}. السبب: ${code}`
              : `Sending stopped at ${current[index].name}. Reason: ${code}`
          );
          setRecipients([...current]);
          saveCurrentCampaign(current, trimmedMessage);
          break;
        }

        setRecipients([...current]);
        saveCurrentCampaign(current, trimmedMessage);
      }

      if (stopRequestedRef.current) {
        setNotice(isArabic ? 'تم إيقاف الحملة بعد معالجة الرسالة الحالية.' : 'Campaign stopped after the current submission.');
      } else if (!current.some((recipient) => recipient.status === 'pending' || recipient.status === 'sending')) {
        setNotice(
          isArabic
            ? `انتهى الإرسال: ${current.filter((recipient) => recipient.status === 'submitted').length} قُبلت للإرسال، ${current.filter((recipient) => recipient.status === 'failed').length} فشلت، ${current.filter((recipient) => recipient.status === 'uncertain').length} نتيجتها غير محسومة.`
            : `Finished: ${current.filter((recipient) => recipient.status === 'submitted').length} submitted, ${current.filter((recipient) => recipient.status === 'failed').length} failed, ${current.filter((recipient) => recipient.status === 'uncertain').length} uncertain.`
        );
      }
    } finally {
      setIsSending(false);
      saveCurrentCampaign(current, trimmedMessage);
    }
  };

  const statusLabel = (status: RecipientStatus) => {
    if (isArabic) {
      return ({
        pending: 'بانتظار الإرسال',
        sending: 'جارٍ الإرسال',
        submitted: 'قُبلت للإرسال',
        failed: 'فشل',
        uncertain: 'النتيجة غير محسومة',
      })[status];
    }
    return ({
      pending: 'Pending',
      sending: 'Submitting',
      submitted: 'Submitted to Android',
      failed: 'Failed',
      uncertain: 'Uncertain result',
    })[status];
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-sms-title"
        className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-[#174840] dark:bg-[#082622]"
      >
        <header className="flex items-center justify-between gap-3 border-b border-gray-100 p-4 dark:border-[#14423b]">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              <MessageSquareText className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 id="bulk-sms-title" className="text-base font-bold text-gray-900 dark:text-[#daf1de]">
                {isArabic ? 'إرسال رسالة جماعية' : 'Bulk SMS reminder'}
              </h2>
              <p className="text-xs text-gray-500 dark:text-[#8eb698]">
                {isArabic ? 'من شريحة الرسائل الافتراضية في إعدادات Android' : 'Uses Android’s selected default SMS SIM'}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label={isArabic ? 'إغلاق' : 'Close'} className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-[#0c312b]">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-xl border border-gray-200 p-3 dark:border-[#14423b]">
              <Users className="mb-1 h-4 w-4 text-gray-500" />
              <p className="text-xs text-gray-500 dark:text-[#8eb698]">{isArabic ? 'مستلمون صالحون' : 'Valid recipients'}</p>
              <p className="text-lg font-bold text-gray-900 dark:text-[#daf1de]">{isLoading ? '…' : recipients.length}</p>
            </div>
            <div className="rounded-xl border border-gray-200 p-3 dark:border-[#14423b]">
              <CheckCircle2 className="mb-1 h-4 w-4 text-emerald-600" />
              <p className="text-xs text-gray-500 dark:text-[#8eb698]">{isArabic ? 'قُبلت للإرسال' : 'Submitted'}</p>
              <p className="text-lg font-bold text-gray-900 dark:text-[#daf1de]">{counts.submitted}</p>
            </div>
            <div className="rounded-xl border border-gray-200 p-3 dark:border-[#14423b]">
              <AlertTriangle className="mb-1 h-4 w-4 text-amber-600" />
              <p className="text-xs text-gray-500 dark:text-[#8eb698]">{isArabic ? 'فشلت' : 'Failed'}</p>
              <p className="text-lg font-bold text-gray-900 dark:text-[#daf1de]">{counts.failed}</p>
            </div>
            <div className="rounded-xl border border-gray-200 p-3 dark:border-[#14423b]">
              <AlertTriangle className="mb-1 h-4 w-4 text-orange-600" />
              <p className="text-xs text-gray-500 dark:text-[#8eb698]">{isArabic ? 'غير محسومة' : 'Uncertain'}</p>
              <p className="text-lg font-bold text-gray-900 dark:text-[#daf1de]">{counts.uncertain}</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="bulk-sms-message" className="block text-sm font-semibold text-gray-800 dark:text-[#daf1de]">
              {isArabic ? 'نص الرسالة' : 'Message text'}
            </label>
            <textarea
              id="bulk-sms-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={4}
              maxLength={2000}
              placeholder={isArabic ? 'اكتب التذكير الذي تريد إرساله للزبائن…' : 'Write the reminder you want to send…'}
              className="w-full resize-y rounded-xl border border-gray-200 bg-white p-3 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-[#8eb698] dark:border-[#14423b] dark:bg-[#061f1c] dark:text-[#daf1de]"
              disabled={isSending}
            />
            <p className="text-xs text-gray-500 dark:text-[#8eb698]">
              {isArabic
                ? 'قد تتحول الرسالة الطويلة أو العربية إلى عدة أجزاء SMS وتُحتسب تكلفتها حسب شركة الاتصالات.'
                : 'Long or Arabic messages may be split into multiple billable SMS parts.'}
            </p>
          </div>

          {notice && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">
              {notice}
            </div>
          )}
          {loadError && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
              {loadError}
            </div>
          )}

          <div className="rounded-xl border border-gray-200 dark:border-[#14423b]">
            <div className="border-b border-gray-100 px-3 py-2 text-sm font-semibold text-gray-800 dark:border-[#14423b] dark:text-[#daf1de]">
              {isArabic ? 'قائمة المستلمين' : 'Recipient list'}
            </div>
            <div className="max-h-48 divide-y divide-gray-100 overflow-y-auto dark:divide-[#14423b]">
              {isLoading ? (
                <div className="flex items-center justify-center gap-2 p-6 text-sm text-gray-500">
                  <LoaderCircle className="h-4 w-4 animate-spin" /> {isArabic ? 'جاري قراءة البيانات المحلية…' : 'Loading local customer data…'}
                </div>
              ) : recipients.length === 0 ? (
                <p className="p-5 text-center text-sm text-gray-500">{isArabic ? 'لا توجد أرقام هواتف صالحة.' : 'No valid phone numbers found.'}</p>
              ) : recipients.map((recipient) => (
                <div key={recipient.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-gray-900 dark:text-[#daf1de]">{recipient.name}</p>
                    <p dir="ltr" className="text-xs text-gray-500 dark:text-[#8eb698]">{recipient.phone}</p>
                  </div>
                  <span className={`shrink-0 text-xs ${
                    recipient.status === 'submitted' ? 'text-emerald-600 dark:text-emerald-400' :
                    recipient.status === 'failed' ? 'text-red-600 dark:text-red-400' :
                    recipient.status === 'uncertain' ? 'text-orange-600 dark:text-orange-400' :
                    'text-gray-500 dark:text-[#8eb698]'
                  }`}>{statusLabel(recipient.status)}</span>
                </div>
              ))}
            </div>
          </div>

          {savedCampaign && savedCampaign.recipients.some((recipient) => recipient.status === 'uncertain') && (
            <p className="text-xs text-orange-700 dark:text-orange-300">
              {isArabic
                ? 'هناك رسالة نتيجتها غير محسومة من محاولة سابقة. لن يعيد التطبيق إرسالها تلقائيًا لتجنب التكرار.'
                : 'A previous submission has an uncertain result. It will not be retried automatically to avoid duplicates.'}
            </p>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 p-4 dark:border-[#14423b]">
          <Button variant="outline" size="sm" onClick={startNewCampaign} disabled={isSending || isLoading}>
            {isArabic ? 'حملة جديدة' : 'New campaign'}
          </Button>
          <div className="flex items-center gap-2">
            {isSending && (
              <Button variant="secondary" size="sm" onClick={() => { stopRequestedRef.current = true; }}>
                {isArabic ? 'إيقاف بعد الرسالة الحالية' : 'Stop after current'}
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={startSending} disabled={isLoading || isSending || !message.trim() || recipients.length === 0 || counts.pending === 0}>
              {isSending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {isArabic ? 'بدء الإرسال' : 'Start sending'}
            </Button>
          </div>
        </footer>
      </section>
    </div>
  );
};
