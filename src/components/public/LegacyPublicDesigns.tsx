import React, { useState } from 'react';
import {
  Activity, ArrowLeft, ArrowRight, BatteryCharging, CalendarClock, CheckCircle2,
  ChevronLeft, ChevronRight, Clock3, CreditCard, Globe, MapPin, Menu, Moon,
  PackageCheck, QrCode, Search, ShieldCheck, Smartphone, Sun, Zap, X,
  CircleHelp, Laptop, Flame, CircleDollarSign, Sparkles, RotateCw,
} from 'lucide-react';

const go = (path: string) => { window.location.href = path; };
const money = (value: string) => value;

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="flex items-center gap-2.5">
    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-emerald-400/20 bg-emerald-400/10 text-emerald-400 shadow-lg shadow-emerald-950/30"><Zap className="h-5 w-5 fill-current" /></span>
    {!compact && <span className="text-sm font-black tracking-tight text-white">منظومة الصيانة والشحن</span>}
  </div>;
}

function Header({ subtitle, home = false }: { subtitle?: string; home?: boolean }) {
  const [menu, setMenu] = useState(false);
  return <header className="sticky top-0 z-40 border-b border-white/10 bg-[#0b1412]/90 backdrop-blur-xl">
    <div className="mx-auto flex h-[68px] max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
      <button onClick={() => go('/design/home')} className="text-right"><Brand /></button>
      {home ? <nav className="hidden items-center gap-6 md:flex">
        {[["الرئيسية","hero"],["الأسعار","pricing"],["كيف تعمل الخدمة","how-it-works"],["أوقات العمل","working-hours"],["الموقع","location"]].map(([label,id]) => <button key={id} onClick={() => document.getElementById(id)?.scrollIntoView({behavior:'smooth'})} className="text-xs font-bold text-slate-400 transition hover:text-white">{label}</button>)}
      </nav> : <div className="hidden text-right sm:block"><p className="text-sm font-black text-white">{subtitle}</p><p className="mt-0.5 text-[11px] text-slate-400">جلسة شحن موثقة ومؤمنة</p></div>}
      <div className="flex items-center gap-2">
        <button aria-label="تغيير اللغة" className="hidden items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-bold text-slate-300 sm:flex"><Globe className="h-3.5 w-3.5" /> English</button>
        <button onClick={() => setMenu(!menu)} aria-label="القائمة الرئيسية" className="grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/[0.04] text-slate-200 transition hover:bg-white/10">{menu ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}</button>
      </div>
    </div>
    {menu && <div className="border-t border-white/10 bg-[#101c19] px-4 py-3 md:hidden">
      <div className="mx-auto flex max-w-7xl flex-col gap-1">
        <button onClick={() => go('/design/home')} className="rounded-lg px-3 py-2.5 text-right text-sm font-bold text-slate-200 hover:bg-white/5">الصفحة الرئيسية</button>
        <button onClick={() => go('/design/customer')} className="rounded-lg px-3 py-2.5 text-right text-sm font-bold text-slate-200 hover:bg-white/5">بوابة متابعة الزبون</button>
        <button onClick={() => go('/design/order')} className="rounded-lg px-3 py-2.5 text-right text-sm font-bold text-slate-200 hover:bg-white/5">صفحة الطلب ورمز QR</button>
      </div>
    </div>}
  </header>;
}

function Footer() {
  return <footer className="border-t border-white/10 px-4 py-7 text-center text-[11px] text-slate-500">© نقطة الشحن · خدمة شحن آمنة وموثوقة</footer>;
}

export const LegacyLandingDesign: React.FC = () => {
  return <div dir="rtl" className="legacy-public-page min-h-screen bg-[#0b1412] text-slate-100">
    <Header home />
    <main>
      <section id="hero" className="relative overflow-hidden border-b border-white/10">
        <div className="pointer-events-none absolute -right-24 -top-28 h-96 w-96 rounded-full bg-emerald-500/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-20 left-0 h-80 w-80 rounded-full bg-teal-500/10 blur-3xl" />
        <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-4 py-14 sm:px-6 md:py-20 lg:grid-cols-12 lg:px-8">
          <div className="space-y-6 text-center lg:col-span-7 lg:text-right">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3.5 py-1.5 text-xs font-black text-emerald-300"><Sparkles className="h-3.5 w-3.5" /> طاقة نظيفة ومستقرة 100% | شحن موثوق وسريع</div>
            <h1 className="text-3xl font-black leading-[1.2] tracking-tight text-white sm:text-4xl md:text-5xl">خدمة شحن الهواتف والأجهزة <span className="text-emerald-400">بالطاقة المتجددة</span></h1>
            <p className="mx-auto max-w-2xl text-sm font-medium leading-8 text-slate-400 sm:text-base lg:mx-0">حلول شحن سريعة وآمنة وموثوقة لكافة الهواتف، البطاريات، والأجهزة الإلكترونية. تابع شحن أجهزتك، حالة طلباتك والمبلغ المستحق عليك بكل سهولة وشفافية.</p>
            <div className="flex flex-col justify-center gap-4 pt-2 sm:flex-row lg:justify-start">
              <div><button onClick={() => go('/design/customer')} className="group flex w-full items-center justify-center gap-2.5 rounded-2xl bg-emerald-400 px-7 py-4 text-sm font-black text-[#08110f] shadow-lg shadow-emerald-500/20 transition hover:-translate-y-0.5 hover:bg-emerald-300 active:scale-95 sm:w-auto"><Search className="h-4 w-4" /><span>تفقد طلباتك</span><ChevronLeft className="h-4 w-4 transition group-hover:-translate-x-1" /></button><p className="mt-2 text-[11px] text-slate-500">تابع شحن أجهزتك، حالة طلباتك والمبلغ المستحق عليك بسهولة</p></div>
              <div><button onClick={() => go('/design/order')} className="flex w-full items-center justify-center gap-2.5 rounded-2xl border border-white/10 bg-white/[0.04] px-7 py-4 text-sm font-black text-white transition hover:bg-white/[0.08] active:scale-95 sm:w-auto"><CreditCard className="h-4 w-4 text-emerald-400" /> الدفع الآن</button><p className="mt-2 text-[11px] text-slate-500">سداد المستحقات عبر مسح رمز QR الخاص بطلبك</p></div>
            </div>
            <div className="mx-auto grid max-w-lg grid-cols-3 gap-3 border-t border-white/10 pt-6 lg:mx-0">
              {[{icon:Sun,title:'طاقة شمسية',desc:'مستقرة وآمنة'},{icon:QrCode,title:'تتبع بالـ QR',desc:'رمز لكل جهاز'},{icon:ShieldCheck,title:'حماية العتاد',desc:'تنظيم الجهد'}].map((x) => <div key={x.title} className="rounded-2xl border border-white/10 bg-white/[0.035] p-3 text-center"><x.icon className="mx-auto mb-1 h-4 w-4 text-emerald-400" /><span className="block text-[11px] font-black text-white">{x.title}</span><span className="text-[10px] text-slate-500">{x.desc}</span></div>)}
            </div>
          </div>
          <div className="lg:col-span-5">
            <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#101c19]/90 p-5 shadow-2xl shadow-black/30 sm:p-7">
              <div className="absolute -right-8 -top-8 h-36 w-36 rounded-full bg-emerald-400/10 blur-2xl" />
              <div className="relative flex items-center justify-between border-b border-white/10 pb-5">
                <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl border border-emerald-400/20 bg-emerald-400/10 text-emerald-400"><Zap className="h-5 w-5 animate-pulse" /></span><div><p className="text-xs font-black text-white">محطة الشحن المباشرة</p><p className="mt-1 text-[11px] font-bold text-emerald-300">جاهزة لاستقبال الأجهزة</p></div></div>
                <span className="flex items-center gap-2 rounded-lg bg-emerald-400/10 px-2.5 py-1 text-[11px] font-bold text-emerald-300"><span className="h-2 w-2 animate-ping rounded-full bg-emerald-400" /> نشط</span>
              </div>
              <div className="relative space-y-4 py-6">
                {[{icon:Smartphone,title:'شحن الهواتف الذكية',price:'1.00 ₪',width:'w-4/5',color:'bg-emerald-400'},{icon:Flame,title:'كشافات الإضاءة واللدات',price:'1.00 ₪',width:'w-3/5',color:'bg-amber-400'},{icon:BatteryCharging,title:'شحن البطاريات',price:'حسب السعة',width:'w-2/3',color:'bg-teal-400'}].map(x => <div key={x.title} className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.035] p-4"><div className="flex items-center justify-between gap-2 text-xs"><span className="flex items-center gap-2 font-bold text-white"><x.icon className="h-4 w-4 text-emerald-400" />{x.title}</span><span className="font-black text-emerald-300">{x.price}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-white/10"><div className={x.width+' h-full animate-pulse rounded-full '+x.color} /></div></div>)}
              </div>
              <div className="flex items-center justify-between border-t border-white/10 pt-4 text-[11px]"><span className="flex items-center gap-1.5 text-slate-400"><Activity className="h-3.5 w-3.5 text-emerald-400" /> مراقبة الشحن لحظياً</span><span className="font-bold text-emerald-300">آمن · سريع · موثوق</span></div>
            </div>
          </div>
        </div>
      </section>
      <section id="pricing" className="border-b border-white/10 bg-white/[0.02] py-16 md:py-20"><div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8"><div className="mx-auto mb-10 max-w-2xl text-center"><p className="mb-3 text-xs font-black tracking-[.2em] text-emerald-400">OUR SERVICES</p><h2 className="text-2xl font-black tracking-tight text-white sm:text-4xl">خدمات وأسعار واضحة</h2><p className="mt-3 text-sm leading-7 text-slate-400">خدمات شحن متنوعة، بتكلفة واضحة واهتمام بأمان أجهزتك.</p></div><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[{icon:Smartphone,title:'شحن الهواتف الذكية',desc:'شحن الهواتف بمختلف أنواعها مع متابعة حالة الجهاز.',price:'1.00 ₪'},{icon:BatteryCharging,title:'شحن البطاريات',desc:'حلول شحن للبطاريات بأحجام وسعات مختلفة.',price:'حسب السعة'},{icon:Laptop,title:'الأجهزة الإلكترونية',desc:'خدمة شحن للأجهزة الإلكترونية والملحقات المتوافقة.',price:'حسب الجهاز'}].map(x=><article key={x.title} className="rounded-2xl border border-white/10 bg-[#101c19] p-6 transition hover:-translate-y-1 hover:border-emerald-400/30"><span className="mb-5 grid h-12 w-12 place-items-center rounded-xl bg-emerald-400/10 text-emerald-400"><x.icon className="h-5 w-5" /></span><h3 className="text-base font-black text-white">{x.title}</h3><p className="mt-2 min-h-12 text-xs leading-6 text-slate-400">{x.desc}</p><p className="mt-5 border-t border-white/10 pt-4 text-sm font-black text-emerald-300">{x.price}</p></article>)}</div></div></section>
      <section id="how-it-works" className="border-b border-white/10 py-16 md:py-20"><div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8"><div className="mx-auto mb-10 max-w-2xl text-center"><p className="mb-3 text-xs font-black tracking-[.2em] text-emerald-400">SIMPLE STEPS</p><h2 className="text-2xl font-black text-white sm:text-4xl">كيف تعمل الخدمة؟</h2></div><div className="grid gap-4 md:grid-cols-3">{[{n:'01',title:'سلّم جهازك',desc:'نستلم الجهاز ونسجل تفاصيل الطلب بدقة.'},{n:'02',title:'تابع حالة الشحن',desc:'استخدم رابطك أو رمز QR لمتابعة حالة الطلب.'},{n:'03',title:'استلم جهازك',desc:'عند جاهزية الجهاز، راجع المستحقات واستلمه.'}].map(x=><div key={x.n} className="rounded-2xl border border-white/10 bg-white/[0.03] p-6"><span className="font-mono text-3xl font-black text-emerald-400/50">{x.n}</span><h3 className="mt-4 text-base font-black text-white">{x.title}</h3><p className="mt-2 text-xs leading-6 text-slate-400">{x.desc}</p></div>)}</div></div></section>
      <section id="working-hours" className="border-b border-white/10 bg-white/[0.02] py-16"><div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 md:grid-cols-2 lg:px-8"><div><span className="mb-3 inline-flex rounded-full bg-emerald-400/10 px-3 py-1 text-xs font-bold text-emerald-300"><Clock3 className="ml-1.5 h-3.5 w-3.5" /> أوقات العمل</span><h2 className="text-2xl font-black text-white sm:text-3xl">نحن هنا لخدمتك</h2><p className="mt-3 text-sm leading-7 text-slate-400">تفقد أوقات العمل قبل زيارة نقطة الشحن.</p></div><div className="rounded-2xl border border-white/10 bg-[#101c19] p-6"><div className="flex items-center justify-between border-b border-white/10 pb-4"><span className="text-sm font-bold text-slate-300">يوميًا</span><span className="text-sm font-black text-emerald-300">9:00 صباحًا – 1:00 ظهرًا</span></div><p className="mt-4 text-xs text-slate-500">قد تختلف الأوقات في المناسبات والعطل.</p></div></div></section>
      <section id="location" className="py-16 md:py-20"><div className="mx-auto grid max-w-7xl items-center gap-8 px-4 sm:px-6 md:grid-cols-2 lg:px-8"><div><span className="mb-3 inline-flex rounded-full bg-emerald-400/10 px-3 py-1 text-xs font-bold text-emerald-300"><MapPin className="ml-1.5 h-3.5 w-3.5" /> موقعنا</span><h2 className="text-2xl font-black text-white sm:text-3xl">نقطة الشحن بالقرب منك</h2><p className="mt-3 text-sm leading-7 text-slate-400">تواصل معنا لمعرفة موقع نقطة الخدمة قبل زيارتك.</p></div><div className="flex min-h-44 items-center justify-center rounded-3xl border border-white/10 bg-[radial-gradient(ellipse_at_center,rgba(16,185,129,.12),transparent_65%)] p-8"><div className="text-center"><MapPin className="mx-auto h-9 w-9 text-emerald-400" /><p className="mt-3 text-sm font-black text-white">موقع نقطة الشحن</p><p className="mt-1 text-xs text-slate-500">تفاصيل الموقع ستظهر هنا</p></div></div></div></section>
    </main><Footer />
  </div>;
};

export const LegacyCustomerDesign: React.FC = () => {
  const [filter, setFilter] = useState('الكل');
  return <div dir="rtl" className="legacy-public-page min-h-screen bg-[#0b1412] text-slate-100">
    <Header subtitle="بوابة متابعة الزبون" />
    <main className="mx-auto w-full max-w-5xl space-y-5 px-4 py-7 sm:px-6 md:py-10">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[11px] font-black tracking-[.18em] text-emerald-400">CUSTOMER PORTAL</p><h1 className="mt-2 text-2xl font-black text-white sm:text-3xl">أهلًا، أحمد محمد</h1><p className="mt-1 text-xs text-slate-400">تابع طلباتك ومستحقاتك من مكان واحد</p></div><button onClick={() => go('/design/home')} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-bold text-slate-300 hover:bg-white/10"><ArrowRight className="h-4 w-4" /> الصفحة الرئيسية</button></div>
      <div className="grid gap-4 sm:grid-cols-3">{[{label:'إجمالي الطلبات',value:'8',icon:PackageCheck,cls:'text-sky-300 bg-sky-400/10'},{label:'المبلغ المستحق',value:'₪ 24.00',icon:CircleDollarSign,cls:'text-amber-300 bg-amber-400/10'},{label:'طلبات جاهزة',value:'2',icon:CheckCircle2,cls:'text-emerald-300 bg-emerald-400/10'}].map(x=><div key={x.label} className="rounded-2xl border border-white/10 bg-[#101c19] p-5"><span className={'mb-4 grid h-10 w-10 place-items-center rounded-xl '+x.cls}><x.icon className="h-5 w-5" /></span><p className="text-xs font-bold text-slate-400">{x.label}</p><p className="mt-2 text-2xl font-black text-white">{x.value}</p></div>)}</div>
      <section className="rounded-3xl border border-white/10 bg-[#101c19] p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-5"><div className="flex items-center gap-3"><span className="grid h-12 w-12 place-items-center rounded-2xl bg-emerald-400/10 text-emerald-300"><span className="text-lg font-black">أم</span></span><div><h2 className="text-base font-black text-white">أحمد محمد</h2><p className="mt-1 text-[11px] text-slate-400">رمز الزبون <b className="mr-1 font-mono text-emerald-300">C-1042</b></p></div></div><span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-[11px] font-bold text-emerald-300"><ShieldCheck className="h-3.5 w-3.5" /> حساب موثق</span></div>
        <div className="grid gap-3 pt-5 sm:grid-cols-2"><div className="rounded-2xl border border-white/5 bg-black/10 p-4"><p className="text-[11px] text-slate-500">الرصيد الحالي</p><p className="mt-1 text-xl font-black text-amber-300">₪ 24.00 مستحق</p><p className="mt-1 text-[11px] text-slate-500">المبلغ المعروض تجريبي للتصميم</p></div><div className="rounded-2xl border border-white/5 bg-black/10 p-4"><p className="text-[11px] text-slate-500">آخر تحديث</p><p className="mt-1 text-sm font-bold text-white">اليوم، 10:30 صباحًا</p><p className="mt-1 text-[11px] text-slate-500">حالة الطلبات تظهر في القائمة أدناه</p></div></div>
      </section>
      <section className="overflow-hidden rounded-3xl border border-white/10 bg-[#101c19]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 p-5"><div><h2 className="text-base font-black text-white">طلبات الشحن</h2><p className="mt-1 text-xs text-slate-400">عرض توضيحي لشكل قائمة الطلبات</p></div><button onClick={() => setFilter('الكل')} className="flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-xs font-bold text-slate-300"><RotateCw className="h-3.5 w-3.5" /> تحديث</button></div>
        <div className="flex gap-2 overflow-x-auto border-b border-white/10 px-5 py-3">{['الكل','قيد الشحن','جاهز للاستلام','تم التسليم'].map(x=><button key={x} onClick={() => setFilter(x)} className={'shrink-0 rounded-xl px-3 py-2 text-xs font-bold transition '+(filter===x?'bg-emerald-400 text-[#07110f]':'bg-white/[0.04] text-slate-400 hover:bg-white/10')}>{x}</button>)}</div>
        <div className="divide-y divide-white/[0.07]">{[{num:'025',name:'Samsung Galaxy',date:'15 أكتوبر 2026 · 09:20',status:'قيد الشحن',price:'₪ 8.00'},{num:'024',name:'Xiaomi Redmi',date:'14 أكتوبر 2026 · 12:10',status:'جاهز للاستلام',price:'₪ 6.00'},{num:'023',name:'كشاف إضاءة',date:'13 أكتوبر 2026 · 10:45',status:'تم التسليم',price:'₪ 10.00'}].filter(x=>filter==='الكل'||x.status===filter).map(x=><button onClick={() => go('/design/order')} key={x.num} className="flex w-full flex-wrap items-center justify-between gap-4 p-5 text-right transition hover:bg-white/[0.025]"><div className="flex min-w-0 items-center gap-3"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-emerald-300"><Smartphone className="h-5 w-5" /></span><div className="min-w-0"><p className="text-sm font-black text-white">{x.name}</p><p className="mt-1 text-[11px] text-slate-500">طلب #{x.num} · {x.date}</p></div></div><div className="flex items-center gap-3"><div className="text-left"><span className={'inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold '+(x.status==='تم التسليم'?'border-slate-600 bg-slate-700/30 text-slate-300':x.status==='جاهز للاستلام'?'border-emerald-400/20 bg-emerald-400/10 text-emerald-300':'border-sky-400/20 bg-sky-400/10 text-sky-300')}>{x.status}</span><p className="mt-1 text-xs font-black text-white">{x.price}</p></div><ChevronLeft className="h-4 w-4 text-slate-500" /></div></button>)}</div>
      </section>
      <div className="rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.05] p-4 text-xs leading-6 text-slate-400"><ShieldCheck className="ml-2 inline h-4 w-4 text-emerald-300" />هذه البوابة مخصصة لعرض معلومات حسابك وطلبات الشحن. الأرقام المعروضة حاليًا أمثلة تصميمية فقط وليست بيانات حقيقية.</div>
    </main><Footer />
  </div>;
};

export const LegacyOrderDesign: React.FC = () => {
  return <div dir="rtl" className="legacy-public-page min-h-screen bg-[#0b1412] px-4 py-6 text-slate-100 sm:px-6 md:py-8">
    <main className="mx-auto w-full max-w-xl space-y-5">
      <div className="flex items-center justify-between border-b border-white/10 pb-4"><div className="flex items-center gap-3"><Brand compact /><div><h1 className="text-sm font-black text-white">بوابة متابعة طلب الشحن</h1><p className="mt-1 flex items-center gap-1 text-[11px] text-slate-400"><ShieldCheck className="h-3.5 w-3.5 text-emerald-400" /> جلسة شحن موثقة ومؤمنة</p></div></div><button onClick={() => go('/design/customer')} className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-bold text-slate-300 hover:bg-white/10"><ArrowLeft className="h-3.5 w-3.5" /> رجوع</button></div>
      <button onClick={() => document.getElementById('demo-payment')?.scrollIntoView({behavior:'smooth'})} className="group relative flex w-full items-center justify-between gap-3 rounded-2xl border border-emerald-400/25 bg-[#101c19] p-4 text-right shadow-xl shadow-emerald-950/10 transition hover:border-emerald-400/50"><span className="absolute -inset-0.5 -z-10 rounded-2xl bg-gradient-to-r from-emerald-500/20 to-teal-500/20 blur" /><span className="flex items-center gap-3"><span className="grid h-12 w-12 place-items-center rounded-xl bg-emerald-400 text-[#07110f]"><CreditCard className="h-5 w-5 animate-pulse" /></span><span><span className="block text-sm font-black text-white">سداد الرسوم ورفع إشعار الدفع</span><span className="mt-1 block text-xs text-emerald-300">إرفاق إيصال التحويل للمراجعة وتأكيد السداد</span></span></span><Sparkles className="h-5 w-5 text-emerald-300" /></button>
      <section className="rounded-3xl border border-white/10 bg-[#101c19] p-5 shadow-2xl sm:p-6">
        <div className="flex items-center justify-between border-b border-white/10 pb-4"><div><span className="text-xs font-semibold text-slate-400">رقم الطلب</span><p className="mt-1 font-mono text-3xl font-black text-white">#025</p></div><div className="text-left"><span className="mb-1 block text-xs font-semibold text-slate-400">حالة الشحن</span><span className="inline-flex items-center gap-1.5 rounded-full border border-sky-400/20 bg-sky-400/10 px-3 py-1.5 text-xs font-bold text-sky-300"><Zap className="h-3.5 w-3.5" /> قيد الشحن</span></div></div>
        <div className="mt-4 flex items-center justify-between rounded-2xl border border-white/5 bg-black/10 p-3.5 text-xs"><div><span className="block text-[11px] text-slate-500">الزبون</span><span className="mt-1 block text-sm font-black text-white">أحمد محمد</span></div><div className="text-left"><span className="block text-[11px] text-slate-500">رمز الزبون</span><span className="mt-1 block rounded border border-emerald-400/20 bg-emerald-400/10 px-2 py-0.5 font-mono font-bold text-emerald-300">C-1042</span></div></div>
        <div className="mt-4 space-y-3 rounded-2xl border border-white/5 bg-white/[0.02] p-4"><div className="flex items-center justify-between text-xs"><span className="flex items-center gap-1.5 text-slate-400"><CalendarClock className="h-3.5 w-3.5" /> وقت استلام الطلب</span><span className="font-medium text-slate-300">15 أكتوبر 2026 · 09:20</span></div><div className="flex items-center justify-between text-xs"><span className="flex items-center gap-1.5 text-slate-400"><Clock3 className="h-3.5 w-3.5" /> آخر تحديث</span><span className="font-medium text-slate-300">15 أكتوبر 2026 · 10:05</span></div></div>
        <div className="mt-5"><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-black text-white">الأجهزة والخدمات</h2><span className="text-xs text-slate-500">عنصران</span></div><div className="divide-y divide-white/[0.07]">{[{name:'Samsung Galaxy',desc:'هاتف ذكي · مع شاحن',price:'₪ 5.00'},{name:'Xiaomi Redmi',desc:'هاتف ذكي · مع شاحن',price:'₪ 3.00'}].map(x=><div key={x.name} className="flex items-center justify-between gap-3 py-4"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-white/[0.04] text-emerald-300"><Smartphone className="h-5 w-5" /></span><div><p className="text-sm font-bold text-white">{x.name}</p><p className="mt-1 text-[11px] text-slate-500">{x.desc}</p></div></div><span className="text-xs font-black text-white">{x.price}</span></div>)}</div></div>
        <div className="mt-2 space-y-3 border-t border-white/10 pt-5"><div className="flex items-center justify-between text-xs text-slate-400"><span>إجمالي الطلب</span><span className="font-bold text-white">₪ 8.00</span></div><div className="flex items-center justify-between text-xs text-slate-400"><span>المدفوع</span><span className="font-bold text-emerald-300">₪ 0.00</span></div><div className="flex items-center justify-between rounded-xl bg-amber-400/10 p-3 text-sm"><span className="font-black text-amber-200">المبلغ المستحق</span><span className="font-black text-amber-200">₪ 8.00</span></div></div>
      </section>
      <section id="demo-payment" className="rounded-3xl border border-white/10 bg-[#101c19] p-5 sm:p-6"><div className="mb-4 flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-400/10 text-emerald-300"><CreditCard className="h-5 w-5" /></span><div><h2 className="text-sm font-black text-white">إشعار الدفع</h2><p className="mt-1 text-[11px] text-slate-400">واجهة شكلية فقط — الإرسال غير مربوط</p></div></div><div className="space-y-3"><label className="block text-xs font-bold text-slate-300">طريقة الدفع</label><div className="grid grid-cols-3 gap-2">{['جوال باي','بال باي','بنك فلسطين'].map(x=><button key={x} className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[11px] font-bold text-slate-300 transition hover:border-emerald-400/40 hover:bg-emerald-400/5">{x}</button>)}</div><label className="block pt-2 text-xs font-bold text-slate-300">صورة إيصال التحويل</label><div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/20 bg-black/10 px-4 py-8 text-center"><QrCode className="h-7 w-7 text-emerald-300" /><p className="mt-2 text-xs font-bold text-white">اختيار صورة الإيصال</p><p className="mt-1 text-[11px] text-slate-500">سيتم ربط هذه الوظيفة لاحقًا</p></div><button type="button" className="w-full rounded-xl bg-emerald-400 px-4 py-3 text-sm font-black text-[#07110f]">إرسال إشعار الدفع (معاينة فقط)</button></div></section>
      <p className="text-center text-[11px] leading-6 text-slate-500">صفحة تصميم تجريبي. البيانات والأزرار غير متصلة بالتطبيق أو قاعدة البيانات.</p>
    </main>
  </div>;
};

const LegacyPublicDesigns: React.FC<{ page: 'home' | 'customer' | 'order' }> = ({ page }) => {
  if (page === 'customer') return <LegacyCustomerDesign />;
  if (page === 'order') return <LegacyOrderDesign />;
  return <LegacyLandingDesign />;
};
export default LegacyPublicDesigns;
