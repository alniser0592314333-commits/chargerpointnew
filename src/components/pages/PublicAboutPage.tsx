import React from 'react';
import {
  ArrowUpRight, CheckCircle2, Globe, Moon, ShieldCheck, Smartphone,
  Sun, WalletCards, Zap,
} from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';

export const PublicAboutPage: React.FC = () => {
  const { locale, setLocale, isRTL } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const isAr = locale === 'ar';

  const features = [
    {
      icon: Smartphone,
      title: isAr ? 'تفاصيل الطلب بوضوح' : 'Clear order details',
      description: isAr ? 'عرض الأجهزة وحالة الطلب والأسعار المسجّلة في صفحة QR عامة للقراءة فقط.' : 'View devices, order status and recorded prices through a read-only public QR page.',
    },
    {
      icon: WalletCards,
      title: isAr ? 'إشعار دفع منظّم' : 'Structured payment notification',
      description: isAr ? 'اختيار طريقة التحويل وإرفاق إيصال واضح، مع مراجعة الإشعار قبل تسجيل الدفعة.' : 'Choose a transfer method and attach a clear receipt; the notification is reviewed before any payment is recorded.',
    },
    {
      icon: ShieldCheck,
      title: isAr ? 'مراجعة قبل التأكيد' : 'Review before confirmation',
      description: isAr ? 'إرسال الإيصال لا يغيّر الرصيد أو حالة الطلب تلقائياً. التغيير المالي يتم بعد اعتماد الإدارة.' : 'Sending a receipt does not automatically change a balance or order status. Financial changes happen only after admin approval.',
    },
  ];

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} className="min-h-screen bg-[#f4f7f7] text-[#142c2c] dark:bg-[#071b1b] dark:text-[#e7f2ef] transition-colors">
      <header className="border-b border-[#dce6e4] bg-white/90 dark:bg-[#0a2423]/90 dark:border-[#1c4140]">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <a href="/public/about" className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#0f766e] text-white shadow-sm"><Zap className="h-5 w-5" /></span>
            <span>
              <span className="block text-sm font-bold tracking-tight">{isAr ? 'نقطة الشحن' : 'Charging Point'}</span>
              <span className="block text-[11px] text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'بوابة العميل' : 'Customer portal'}</span>
            </span>
          </a>
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => setLocale(isAr ? 'en' : 'ar')} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-[#365653] hover:bg-[#edf4f2] dark:text-[#c8d9d4] dark:hover:bg-[#133533]" aria-label="Toggle language"><Globe className="h-4 w-4" />{isAr ? 'English' : 'عربي'}</button>
            <button type="button" onClick={toggleTheme} className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#dce6e4] hover:bg-[#edf4f2] dark:border-[#244746] dark:hover:bg-[#133533]" aria-label="Toggle theme">{theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4 text-amber-300" />}</button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:py-12">
        <section className="overflow-hidden rounded-3xl bg-[#103c38] px-6 py-9 text-white shadow-[0_18px_60px_rgba(16,60,56,0.12)] sm:px-10 sm:py-12">
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#b9d8d0]">{isAr ? 'عن البوابة' : 'ABOUT THE PORTAL'}</p>
          <h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">{isAr ? 'تجربة واضحة وآمنة لمتابعة طلبك' : 'A clear, considered way to follow your order'}</h1>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-[#d0e4df] sm:text-base">{isAr ? 'بوابة نقطة الشحن تجمع تفاصيل الطلب وخيارات إرسال إشعار الدفع في تجربة واحدة بسيطة، مع إبقاء المراجعة المالية ضمن التطبيق الإداري.' : 'Charging Point brings order details and payment-notification options into one straightforward experience, while keeping financial review inside the administrative app.'}</p>
        </section>

        <section className="mt-7 grid gap-4 md:grid-cols-3">
          {features.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <article key={feature.title} className="rounded-2xl border border-[#dce6e4] bg-white p-5 shadow-[0_8px_30px_rgba(16,55,51,0.035)] dark:border-[#1c4140] dark:bg-[#0a2423] sm:p-6">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#edf5f2] text-[#0f766e] dark:bg-[#133533] dark:text-[#a9d8cc]"><Icon className="h-5 w-5" /></span>
                <p className="mt-4 text-[10px] font-bold tracking-[0.16em] text-[#0f766e] dark:text-[#83cbbd]">0{index + 1}</p>
                <h2 className="mt-2 text-base font-semibold">{feature.title}</h2>
                <p className="mt-2 text-sm leading-6 text-[#607874] dark:text-[#a7beb9]">{feature.description}</p>
              </article>
            );
          })}
        </section>

        <section className="mt-7 rounded-2xl border border-[#dce6e4] bg-white p-5 dark:border-[#1c4140] dark:bg-[#0a2423] sm:p-7">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#edf5f2] text-[#0f766e] dark:bg-[#133533]"><CheckCircle2 className="h-4 w-4" /></span>
            <div>
              <h2 className="text-base font-semibold">{isAr ? 'كيف تتم مراجعة الدفع؟' : 'How payment review works'}</h2>
              <ol className="mt-3 space-y-3 text-sm leading-6 text-[#607874] dark:text-[#a7beb9]">
                <li className="flex gap-2"><span className="font-semibold text-[#0f766e]">1.</span><span>{isAr ? 'اختَر طريقة التحويل المناسبة وحوّل المبلغ الظاهر في ملخص الطلب.' : 'Choose a transfer method and transfer the amount shown in the order summary.'}</span></li>
                <li className="flex gap-2"><span className="font-semibold text-[#0f766e]">2.</span><span>{isAr ? 'أرفق صورة الإيصال وأرسل إشعار الدفع.' : 'Attach the receipt image and send the payment notification.'}</span></li>
                <li className="flex gap-2"><span className="font-semibold text-[#0f766e]">3.</span><span>{isAr ? 'تراجع الإدارة الإيصال. عند الاعتماد فقط تُسجّل الدفعة وتُوزّع على المستحقات من الأقدم للأحدث، وأي فائض يبقى رصيداً للزبون.' : 'An admin reviews the receipt. Only after approval is the payment recorded and allocated oldest-to-newest; any remainder stays as customer credit.'}</span></li>
              </ol>
            </div>
          </div>
        </section>

        <div className="mt-6 flex items-start gap-3 rounded-xl border border-[#dce6e4] bg-[#edf5f2] p-4 text-xs leading-5 text-[#41635d] dark:border-[#1c4140] dark:bg-[#0c2927] dark:text-[#b4d0c8]">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#0f766e]" />
          <p>{isAr ? 'هذه البوابة لا تعرض روابط إدارية أو بيانات دخول. إيصال التحويل إشعار للمراجعة، وليس تأكيداً آلياً للدفع.' : 'This portal exposes no admin links or credentials. A transfer receipt is a review notification, not automatic payment confirmation.'}</p>
        </div>
      </main>

      <footer className="border-t border-[#dce6e4] px-4 py-5 text-center text-[11px] text-[#7d9690] dark:border-[#1c4140] dark:text-[#779791]">
        {isAr ? 'نقطة الشحن · بوابة العميل' : 'Charging Point · Customer Portal'}
      </footer>
    </div>
  );
};
