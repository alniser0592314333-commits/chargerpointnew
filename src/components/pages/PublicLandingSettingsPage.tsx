import React,{useEffect,useState} from 'react';
import {ArrowLeft,Clock3,Save,Activity,RefreshCw} from 'lucide-react';
import {useI18n} from '../../i18n/i18nContext';
import {invokeSupabaseRpc} from '../../services/supabase/client';
import {Button} from '../ui/Button';

type Hours={is_active:boolean;open_time:string;close_time:string;next_open_time:string;next_close_time:string};
type LandingData={hours?:Partial<Hours>;devices?:unknown[];charger_fee_minor?:number};
const empty:Hours={is_active:false,open_time:'',close_time:'',next_open_time:'',next_close_time:''};

export const PublicLandingSettingsPage:React.FC<{onBack:()=>void}>=({onBack})=>{
 const {locale}=useI18n();const ar=locale==='ar';
 const [form,setForm]=useState<Hours>(empty);const [loading,setLoading]=useState(true);const [saving,setSaving]=useState(false);const [error,setError]=useState('');const [success,setSuccess]=useState(false);
 const load=async()=>{setLoading(true);setError('');const {data,error}=await invokeSupabaseRpc<LandingData>('public_landing_content',{},undefined,true,false,true);if(error||!data){setError(ar?'تعذّر تحميل الإعدادات. تحقق من الاتصال.':'Could not load settings. Check your connection.');}else{setForm({...empty,...(data.hours||{})});}setLoading(false);};
 useEffect(()=>{void load();},[]);
 const save=async()=>{setError('');setSuccess(false);if(!form.open_time||!form.close_time||!form.next_open_time||!form.next_close_time){setError(ar?'أدخل وقت الفتح والإغلاق لليوم واليوم التالي.':'Enter opening and closing times for both days.');return;}setSaving(true);const result=await invokeSupabaseRpc<Hours>('update_public_landing_settings',{p_settings:form});if(result.error||!result.data){setError(ar?'لم تُحفظ الإعدادات. تأكد من صلاحية إدارة الإعدادات والاتصال.':'Settings were not saved. Check settings-management permission and connection.');}else{setForm({...empty,...result.data});setSuccess(true);}setSaving(false);};
 const field=(key:keyof Omit<Hours,'is_active'>,label:string)=><label className="block space-y-2 text-sm"><span className="text-gray-700 dark:text-[#daf1de]">{label}</span><input type="time" required value={form[key]} onChange={e=>setForm(s=>({...s,[key]:e.target.value}))} className="w-full h-11 rounded-xl border border-gray-200 dark:border-[#14423b] bg-white dark:bg-[#051d1a] px-3 text-gray-900 dark:text-[#daf1de]"/></label>;
 return <div className="max-w-3xl mx-auto space-y-6 pb-24 px-4 sm:px-6">
  <div className="pt-2 pb-4 border-b border-gray-200 dark:border-[#14423b]"><button onClick={onBack} className="mb-3 inline-flex items-center gap-2 text-xs text-gray-500 hover:text-emerald-600"><ArrowLeft size={15}/>{ar?'العودة للإعدادات':'Back to settings'}</button><h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-[#daf1de]">{ar?'إعدادات الصفحة العامة':'Public landing settings'}</h1><p className="mt-2 text-xs leading-6 text-gray-500 dark:text-[#8eb698]">{ar?'تحكم بحالة نشاط نقطة الشحن وأوقات العمل التي يراها جميع الزوار. الأسعار تُقرأ مباشرة من قائمة أسعار الأجهزة ولا تُعدّل من هنا.':'Control the activity status and operating hours shown to all visitors. Prices are read live from the device price list and cannot be changed here.'}</p></div>
  {loading?<div className="py-10 text-center text-sm text-gray-500">{ar?'جارٍ تحميل الإعدادات…':'Loading settings…'}</div>:<div className="space-y-5">
   <section className="rounded-2xl border border-gray-200 dark:border-[#14423b] p-5 sm:p-6 space-y-5">
    <div className="flex items-start gap-3"><span className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-[#0c312b] text-emerald-700 dark:text-emerald-300 grid place-items-center"><Activity size={19}/></span><div className="flex-1"><h2 className="font-bold text-gray-900 dark:text-[#daf1de]">{ar?'حالة النشاط':'Activity status'}</h2><p className="text-xs text-gray-500 dark:text-[#8eb698] mt-1">{ar?'تظهر كنقطة خضراء متوهجة عند النشاط وحمراء عند عدم النشاط.':'Shown as a glowing green dot when active and red when inactive.'}</p></div></div>
    <label className="flex items-center justify-between gap-4 rounded-xl border border-gray-200 dark:border-[#14423b] p-4 cursor-pointer"><span><strong className="block text-sm text-gray-900 dark:text-[#daf1de]">{form.is_active?(ar?'النقطة نشطة':'Point is active'):(ar?'النقطة غير نشطة':'Point is inactive')}</strong><small className="block mt-1 text-xs text-gray-500 dark:text-[#8eb698]">{ar?'تغيير الحالة يظهر مباشرة للزوار بعد الحفظ.':'Changes appear publicly after saving.'}</small></span><input type="checkbox" checked={form.is_active} onChange={e=>setForm(s=>({...s,is_active:e.target.checked}))} className="h-5 w-5 accent-emerald-600"/></label>
   </section>
   <section className="rounded-2xl border border-gray-200 dark:border-[#14423b] p-5 sm:p-6 space-y-5"><div className="flex items-start gap-3"><span className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-[#0c312b] text-emerald-700 dark:text-emerald-300 grid place-items-center"><Clock3 size={19}/></span><div><h2 className="font-bold text-gray-900 dark:text-[#daf1de]">{ar?'ساعات العمل':'Operating hours'}</h2><p className="text-xs text-gray-500 dark:text-[#8eb698] mt-1">{ar?'حدد وقت الفتح والإغلاق لليوم واليوم التالي.':'Set opening and closing times for today and the next day.'}</p></div></div>
    <div><h3 className="text-sm font-semibold mb-3 text-gray-900 dark:text-[#daf1de]">{ar?'اليوم':'Today'}</h3><div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{field('open_time',ar?'وقت الفتح':'Opening time')}{field('close_time',ar?'وقت الإغلاق':'Closing time')}</div></div>
    <div><h3 className="text-sm font-semibold mb-3 text-gray-900 dark:text-[#daf1de]">{ar?'اليوم التالي':'Next day'}</h3><div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{field('next_open_time',ar?'وقت الفتح':'Opening time')}{field('next_close_time',ar?'وقت الإغلاق':'Closing time')}</div></div>
   </section>
   {error&&<p role="alert" className="rounded-xl border border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-900 p-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
   {success&&<p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 dark:border-emerald-900 p-3 text-sm text-emerald-700 dark:text-emerald-300">{ar?'تم حفظ الإعدادات. ستظهر على الصفحة العامة عند تحديث بياناتها.':'Settings saved. The public page will show them when its data refreshes.'}</p>}
   <div className="flex flex-wrap gap-3"><Button variant="primary" disabled={saving} onClick={()=>void save()} className="gap-2"><Save size={16}/>{saving?(ar?'جارٍ الحفظ…':'Saving…'):(ar?'حفظ الإعدادات':'Save settings')}</Button><Button variant="outline" disabled={saving} onClick={()=>void load()} className="gap-2"><RefreshCw size={15}/>{ar?'إعادة تحميل':'Reload'}</Button></div>
  </div>}
 </div>;
};
