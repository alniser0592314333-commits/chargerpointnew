import React, { useEffect, useState } from 'react';
import { Archive, ArrowRight, CalendarClock, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';

const ARCHIVE_KEY = 'chargerpoint.customerLinkSmsCampaignArchive.v1';
type ArchiveRecipient = { id: string; name: string; phone: string; status: string; error?: string; selected: boolean };
type ArchivedCampaign = { id: string; archivedAt: string; startedAt?: string; finishedAt?: string; messageTemplate: string; dueDateText?: string; sendDelay?: string; recipients: ArchiveRecipient[] };

export const SmsCampaignArchivePage: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { locale } = useI18n();
  const ar = locale === 'ar';
  const [items, setItems] = useState<ArchivedCampaign[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    try {
      const value = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '[]');
      if (Array.isArray(value)) setItems(value.filter((x) => x && typeof x.id === 'string' && Array.isArray(x.recipients)));
    } catch { setItems([]); }
  }, []);
  const date = (value?: string) => value ? new Date(value).toLocaleString(ar ? 'ar' : 'en') : (ar ? 'غير متوفر' : 'Not recorded');
  const count = (item: ArchivedCampaign, status: string) => item.recipients.filter((r) => r.selected && r.status === status).length;
  return <div className="mx-auto max-w-3xl space-y-4 px-1 py-2 sm:px-0">
    <header className="flex items-center gap-3 border-b border-gray-200 pb-4 dark:border-[#14423b]">
      <button type="button" onClick={onBack} className="rounded-lg p-2 hover:bg-gray-100 dark:hover:bg-[#0c312b]" aria-label={ar ? 'رجوع' : 'Back'}><ArrowRight className="h-5 w-5" /></button>
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200"><Archive className="h-5 w-5" /></div>
      <div><h1 className="text-lg font-bold text-gray-900 dark:text-[#daf1de]">{ar ? 'أرشيف الحملات' : 'Campaign archive'}</h1><p className="text-xs text-gray-500 dark:text-[#8eb698]">{ar ? 'سجل مستقل للحملات التي تم إنهاؤها' : 'A separate record of campaigns that were ended'}</p></div>
    </header>
    {items.length === 0 ? <div className="rounded-2xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500 dark:border-[#28665a]">{ar ? 'لا توجد حملات مؤرشفة حتى الآن.' : 'No archived campaigns yet.'}</div> :
      <div className="space-y-3">{items.map((item) => <section key={item.id} className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-[#14423b] dark:bg-[#082622]">
        <button type="button" onClick={() => setExpanded(expanded === item.id ? null : item.id)} className="flex w-full items-center justify-between gap-3 p-4 text-start">
          <span className="min-w-0 flex-1"><strong className="block text-sm text-gray-900 dark:text-[#daf1de]">{ar ? 'حملة رسائل' : 'SMS campaign'} · {date(item.archivedAt)}</strong><span className="mt-1 block text-xs text-gray-500 dark:text-[#8eb698]">{ar ? 'المستلمون المحددون: ' : 'Selected recipients: '}{item.recipients.filter(r => r.selected).length} · {ar ? 'بدأت: ' : 'Started: '}{date(item.startedAt)}</span></span>
          <span className="flex gap-3 text-xs"><span className="text-emerald-600">{count(item,'submitted')}</span><span className="text-red-600">{count(item,'failed')}</span><span className="text-orange-600">{count(item,'uncertain')}</span></span>
        </button>
        {expanded === item.id && <div className="space-y-3 border-t border-gray-100 p-4 dark:border-[#14423b]">
          <div className="rounded-lg bg-gray-50 p-3 text-sm whitespace-pre-wrap dark:bg-[#061f1c]">{item.messageTemplate}</div><p className="text-xs text-gray-500 dark:text-[#8eb698]">{ar ? 'موعد التسديد المستخدم: ' : 'Due date used: '}{item.dueDateText || (ar ? 'الخميس' : 'Thursday')} · {ar ? 'الفاصل: ' : 'Delay: '}{item.sendDelay || '0'} {ar ? 'ثانية' : 'seconds'}</p>
          <div className="flex flex-wrap gap-3 text-xs text-gray-500 dark:text-[#8eb698]"><span className="inline-flex items-center gap-1"><CalendarClock className="h-3.5 w-3.5" />{ar ? 'انتهت: ' : 'Ended: '}{date(item.finishedAt || item.archivedAt)}</span><span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />{ar ? 'قُبلت: ' : 'Submitted: '}{count(item,'submitted')}</span><span className="inline-flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5 text-red-600" />{ar ? 'فشلت: ' : 'Failed: '}{count(item,'failed')}</span></div>
          <div className="max-h-64 divide-y divide-gray-100 overflow-y-auto dark:divide-[#14423b]">{item.recipients.filter(r => r.selected).map(r => <div key={r.id} className="flex justify-between gap-3 py-2 text-xs"><span className="min-w-0"><strong className="block">{r.name}</strong><span dir="ltr" className="text-gray-500">{r.phone}</span></span><span className="shrink-0">{r.status}{r.error ? ' · '+r.error : ''}</span></div>)}</div>
        </div>}
      </section>)}</div>}
  </div>;
};
