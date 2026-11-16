import React, { useState } from 'react';
import { ArrowLeft, CheckCircle2, RotateCcw, Save } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';

const STORAGE_KEY = 'chargerpoint.balanceTopUpSmsTemplate.v1';
const DEFAULT_TEMPLATE = 'عزيزنا المشترك {customer_name}، تم إضافة رصيد إلى حسابك بقيمة {amount}. رصيدك الحالي بعد الإضافة: {current_balance}. شكراً لثقتك بنا.';

export const BalanceTopUpSmsTemplatePage: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { locale } = useI18n();
  const ar = locale === 'ar';
  const [template, setTemplate] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) || DEFAULT_TEMPLATE; }
    catch { return DEFAULT_TEMPLATE; }
  });
  const [saved, setSaved] = useState(false);
  const preview = template
    .replace(/\{customer_name\}/g, ar ? 'محمد أحمد' : 'Mohammed Ahmed')
    .replace(/\{amount\}/g, ar ? '50.00 شيكل' : 'ILS 50.00')
    .replace(/\{current_balance\}/g, ar ? '125.00 شيكل' : 'ILS 125.00');

  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, template.trim() || DEFAULT_TEMPLATE);
      setTemplate(template.trim() || DEFAULT_TEMPLATE);
      setSaved(true);
    } catch {
      setSaved(false);
    }
  };

  return <div dir={ar ? 'rtl' : 'ltr'} className="mx-auto max-w-3xl space-y-5 px-1 py-2 sm:px-0">
    <header className="flex items-center gap-3 border-b border-gray-200 pb-4 dark:border-[#14423b]">
      <button type="button" onClick={onBack} className="flex h-10 w-10 items-center justify-center rounded-xl border border-gray-200 text-gray-600 dark:border-[#14423b] dark:text-[#daf1de]" aria-label={ar ? 'رجوع' : 'Back'}>
        <ArrowLeft className="h-5 w-5" />
      </button>
      <div>
        <h1 className="text-xl font-bold text-gray-900 dark:text-[#daf1de]">{ar ? 'تخصيص رسالة الدفع' : 'Customize payment message'}</h1>
        <p className="mt-1 text-xs text-gray-500 dark:text-[#8eb698]">{ar ? 'هذه الرسالة تُرسل تلقائياً بعد نجاح إضافة الرصيد.' : 'This SMS is sent automatically after a successful balance top-up.'}</p>
      </div>
    </header>

    <section className="space-y-3">
      <label htmlFor="balance-topup-sms-template" className="block text-sm font-semibold text-gray-800 dark:text-[#daf1de]">{ar ? 'نص الرسالة' : 'Message text'}</label>
      <textarea id="balance-topup-sms-template" value={template} onChange={(event) => { setTemplate(event.target.value); setSaved(false); }} rows={7} maxLength={1200} className="w-full rounded-xl border border-gray-300 bg-white p-3 text-sm leading-7 text-gray-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-[#28665a] dark:bg-[#061d1a] dark:text-[#daf1de]" />
      <div className="rounded-xl border border-gray-200 p-3 dark:border-[#14423b]">
        <p className="mb-2 text-xs font-bold text-gray-700 dark:text-[#daf1de]">{ar ? 'المتغيرات المتاحة' : 'Available placeholders'}</p>
        <div className="grid gap-2 text-xs text-gray-600 dark:text-[#a8c8b0]">
          <p><code>{'{customer_name}'}</code> — {ar ? 'اسم الزبون' : 'Customer name'}</p>
          <p><code>{'{amount}'}</code> — {ar ? 'قيمة الرصيد المضاف' : 'Amount added'}</p>
          <p><code>{'{current_balance}'}</code> — {ar ? 'الرصيد بعد الإضافة' : 'Balance after top-up'}</p>
        </div>
      </div>
    </section>

    <section className="rounded-xl border border-gray-200 p-4 dark:border-[#14423b]">
      <p className="mb-2 text-sm font-bold text-gray-800 dark:text-[#daf1de]">{ar ? 'معاينة الرسالة' : 'Message preview'}</p>
      <p className="whitespace-pre-wrap text-sm leading-7 text-gray-700 dark:text-[#c3dfca]">{preview}</p>
      <p className="mt-3 text-[11px] text-gray-500 dark:text-[#8eb698]">{ar ? 'الأرقام في المعاينة أمثلة فقط. عند الإرسال تُستخدم بيانات كل زبون وعمليته الفعلية.' : 'Preview values are examples. Actual customer and transaction data is used when sending.'}</p>
    </section>

    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={save} className="inline-flex items-center gap-2 rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800">
        <Save className="h-4 w-4" />{ar ? 'حفظ التخصيص' : 'Save customization'}
      </button>
      <button type="button" onClick={() => { setTemplate(DEFAULT_TEMPLATE); setSaved(false); }} className="inline-flex items-center gap-2 rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 dark:border-[#28665a] dark:text-[#daf1de]">
        <RotateCcw className="h-4 w-4" />{ar ? 'استعادة الافتراضي' : 'Restore default'}
      </button>
      {saved && <span role="status" className="inline-flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-4 w-4" />{ar ? 'تم حفظ الرسالة' : 'Message saved'}</span>}
    </div>
  </div>;
};
