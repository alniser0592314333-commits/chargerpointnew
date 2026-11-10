import React from 'react';
import { Archive, FileText, MessageSquareText, Send, Users, ChevronLeft } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';

type MessageSection = 'compose' | 'templates' | 'recipients' | 'campaigns' | 'archive';

export const MessageCenterHomePage: React.FC<{ onNavigate: (section: MessageSection) => void }> = ({ onNavigate }) => {
  const { locale } = useI18n();
  const ar = locale === 'ar';
  const sections = [
    { id: 'compose' as const, icon: MessageSquareText, title: ar ? 'كتابة رسالة' : 'Compose message', desc: ar ? 'اكتب الرسالة وخصص بيانات كل زبون' : 'Write and personalize each customer message', tone: 'bg-emerald-50 text-emerald-700 dark:bg-[#0c312b] dark:text-[#a9d9b7]' },
    { id: 'templates' as const, icon: FileText, title: ar ? 'قوالب الرسائل' : 'Message templates', desc: ar ? 'القوالب الجاهزة والمحفوظه وتعديلها' : 'Manage reusable message templates', tone: 'bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300' },
    { id: 'recipients' as const, icon: Users, title: ar ? 'المستلمون' : 'Recipients', desc: ar ? 'اختيار الزبائن والبحث والتصفية' : 'Select, search and filter customers', tone: 'bg-violet-50 text-violet-700 dark:bg-violet-950/30 dark:text-violet-300' },
    { id: 'campaigns' as const, icon: Send, title: ar ? 'إدارة الحملات' : 'Campaign management', desc: ar ? 'بدء الإرسال والإيقاف والاستئناف وإنهاء الحملة' : 'Start, pause, resume and finish campaigns', tone: 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300' },
    { id: 'archive' as const, icon: Archive, title: ar ? 'أرشيف الحملات' : 'Campaign archive', desc: ar ? 'الرجوع لنتائج الحملات السابقة' : 'Review completed campaign reports', tone: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200' },
  ];
  return <div className="mx-auto max-w-3xl space-y-5 px-1 py-2 sm:px-0">
    <header className="border-b border-gray-200 pb-4 dark:border-[#14423b]">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 dark:bg-[#0c312b] dark:text-[#a9d9b7]"><MessageSquareText className="h-5 w-5" /></div>
        <div><h1 className="text-xl font-bold text-gray-900 dark:text-[#daf1de]">{ar ? 'مركز الرسائل والتواصل' : 'Messages & communication'}</h1><p className="mt-1 text-xs text-gray-500 dark:text-[#8eb698]">{ar ? 'كل وظيفة في صفحة مستقلة وواضحة' : 'Each task has its own focused page'}</p></div>
      </div>
    </header>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {sections.map(({ id, icon: Icon, title, desc, tone }) => <button key={id} type="button" onClick={() => onNavigate(id)} className="group flex min-h-28 items-center gap-4 rounded-2xl border border-gray-200 bg-white p-4 text-start shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-md dark:border-[#14423b] dark:bg-[#082622] dark:hover:border-[#28665a]">
        <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${tone}`}><Icon className="h-5 w-5" /></span>
        <span className="min-w-0 flex-1"><strong className="block text-sm font-bold text-gray-900 dark:text-[#daf1de]">{title}</strong><span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-[#8eb698]">{desc}</span></span>
        <ChevronLeft className="h-4 w-4 shrink-0 text-gray-400 transition group-hover:-translate-x-1" />
      </button>)}
    </div>
  </div>;
};
