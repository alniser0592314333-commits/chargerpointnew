import React, { useEffect, useMemo, useState } from 'react';
import { BookOpen, Plus, ArrowRight, ArrowLeft, CalendarDays, ReceiptText, Wallet, Search, X, Save, RefreshCw } from 'lucide-react';
import { customerAuth } from '../../services/customer/customerAuth';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';

type Ledger = { id: string; ownerId: string; name: string; createdAt: string; openingAmountMinor: number; openingCurrency: string; openingDirection: 'THEY_OWE_ME' | 'I_OWE'; };
type Entry = { id: string; ownerId: string; ledgerId: string; number: number; kind: 'OPERATION' | 'PAYMENT'; description: string; amountMinor: number; currency: string; direction: 'THEY_OWE_ME' | 'I_OWE'; method: 'CASH' | 'DEBT' | 'APP'; createdAt: string; };
const DB = 'customer-debt-ledger-v1';
const CURRENCIES = ['ILS', 'JOD', 'USD', 'EUR'];
const currencyLabel: Record<string,string> = { ILS: '₪ شيكل', JOD: 'د.أ دينار', USD: '$ دولار', EUR: '€ يورو' };
const openDb = () => new Promise<IDBDatabase>((resolve,reject) => {
  const req = indexedDB.open(DB, 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('ledgers')) db.createObjectStore('ledgers', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('entries')) {
      const store = db.createObjectStore('entries', { keyPath: 'id' });
      store.createIndex('ledgerId', 'ledgerId');
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function allOwned<T extends {ownerId:string}>(storeName: string, ownerId: string): Promise<T[]> {
  const db = await openDb();
  try { return await new Promise((resolve,reject) => { const req=db.transaction(storeName,'readonly').objectStore(storeName).getAll(); req.onsuccess=()=>resolve((req.result as T[]).filter(x=>x.ownerId===ownerId)); req.onerror=()=>reject(req.error); }); }
  finally { db.close(); }
}
async function putRecord(storeName:string, value:unknown) {
  const db=await openDb();
  try { await new Promise<void>((resolve,reject)=>{ const tx=db.transaction(storeName,'readwrite'); tx.objectStore(storeName).put(value); tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error); }); }
  finally { db.close(); }
}
const money = (minor:number, currency:string) => new Intl.NumberFormat('ar', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor/100) + ' ' + (currencyLabel[currency] || currency);
const nowLocal = () => new Date().toISOString();

export const DebtLedgerPage: React.FC = () => {
  const { locale } = useI18n();
  const { resolvedTheme } = useTheme();
  const ar = locale === 'ar';
  const dark = resolvedTheme === 'dark';
  const [ownerId,setOwnerId] = useState('');
  const [ledgers,setLedgers] = useState<Ledger[]>([]);
  const [entries,setEntries] = useState<Entry[]>([]);
  const [selected,setSelected] = useState<string|null>(null);
  const [search,setSearch] = useState('');
  const [mode,setMode] = useState<'list'|'create'|'operation'|'payment'>('list');
  const [name,setName] = useState('');
  const [opening,setOpening] = useState(false);
  const [openingAmount,setOpeningAmount] = useState('');
  const [openingCurrency,setOpeningCurrency] = useState('ILS');
  const [openingDirection,setOpeningDirection] = useState<'THEY_OWE_ME'|'I_OWE'>('THEY_OWE_ME');
  const [description,setDescription] = useState('');
  const [amount,setAmount] = useState('');
  const [currency,setCurrency] = useState('ILS');
  const [direction,setDirection] = useState<'THEY_OWE_ME'|'I_OWE'>('THEY_OWE_ME');
  const [method,setMethod] = useState<'CASH'|'DEBT'|'APP'>('DEBT');
  const [busy,setBusy] = useState(true);
  const [error,setError] = useState('');
  const t=(a:string,e:string)=>ar?a:e;
  const refresh = async (uid:string) => {
    const [l,e]=await Promise.all([allOwned<Ledger>('ledgers',uid),allOwned<Entry>('entries',uid)]);
    setLedgers(l.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));
    setEntries(e);
  };
  useEffect(()=>{ let alive=true; void customerAuth.auth.getSession().then(async ({data})=>{ const uid=data.session?.user?.id; if(!uid) return; await refresh(uid); if(alive)setOwnerId(uid); }).catch(()=>setError(t('تعذّر تحميل الدفاتر المحلية.','Could not load local ledgers.'))).finally(()=>{if(alive)setBusy(false);}); return ()=>{alive=false;}; },[]);
  const current=ledgers.find(x=>x.id===selected)||null;
  const currentEntries=useMemo(()=>entries.filter(x=>x.ledgerId===selected).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),[entries,selected]);
  const balances=useMemo(()=>{ const result:Record<string,number>={}; if(!current)return result; if(current.openingAmountMinor)result[current.openingCurrency]=(current.openingDirection==='THEY_OWE_ME'?1:-1)*current.openingAmountMinor; for(const e of entries.filter(x=>x.ledgerId===current.id)){ const sign=e.direction==='THEY_OWE_ME'?1:-1; const impact=e.kind==='PAYMENT'?-sign*e.amountMinor:(e.method==='DEBT'?sign*e.amountMinor:0); result[e.currency]=(result[e.currency]||0)+impact; } return result; },[current,entries]);
  const saveLedger=async()=>{ if(!ownerId||!name.trim())return; setBusy(true); try{const item:Ledger={id:crypto.randomUUID(),ownerId,name:name.trim(),createdAt:nowLocal(),openingAmountMinor:opening?Math.round(Number(openingAmount)*100):0,openingCurrency,openingDirection}; await putRecord('ledgers',item); await refresh(ownerId); setSelected(item.id); setName('');setOpening(false);setOpeningAmount('');setMode('list');}catch{setError(t('تعذّر الحفظ محليًا. تأكد من مساحة التخزين.','Could not save locally. Check available storage.'));}finally{setBusy(false);} };
  const saveEntry=async()=>{ if(!ownerId||!current||!amount||!Number.isFinite(Number(amount))||Number(amount)<=0)return; setBusy(true); try{ const previous=entries.filter(x=>x.ledgerId===current.id&&x.kind===(mode==='payment'?'PAYMENT':'OPERATION')).reduce((m,x)=>Math.max(m,x.number),0); const item:Entry={id:crypto.randomUUID(),ownerId,ledgerId:current.id,number:previous+1,kind:mode==='payment'?'PAYMENT':'OPERATION',description:description.trim(),amountMinor:Math.round(Number(amount)*100),currency,direction,method:mode==='payment'?(method==='DEBT'?'CASH':method):method,createdAt:nowLocal()}; await putRecord('entries',item); await refresh(ownerId); setDescription('');setAmount('');setMode('list');}catch{setError(t('تعذّر الحفظ محليًا.','Could not save locally.'));}finally{setBusy(false);} };
  const bg=dark?'bg-[#171717] text-white':'bg-white text-slate-900';
  const surface=dark?'border-white/10 bg-[#101010]':'border-slate-200 bg-white';
  const input='w-full rounded-xl border border-white/15 bg-transparent px-3 py-3 text-sm outline-none focus:border-white/40';
  const button='rounded-xl border border-white/15 px-4 py-3 text-sm font-bold transition hover:bg-white/5 disabled:opacity-50';
  if(busy&&!ownerId)return <div className="p-6 text-sm opacity-70">{t('جارٍ تحميل دفتر الديون…','Loading debt ledger…')}</div>;
  return <div className={`min-h-[60vh] ${bg}`} dir={ar?'rtl':'ltr'}>
    <div className="mb-5 flex items-center justify-between gap-3"><div><h2 className="text-xl font-extrabold">{t('دفتر الديون','Debt ledger')}</h2><p className="mt-1 text-xs opacity-60">{t('دفاتر تعاملاتك وأرصدتك حسب العملة','Your relationship ledgers and balances by currency')}</p></div>{mode==='list'&&!current&&<button className={button} onClick={()=>setMode('create')}><Plus size={17} className="inline"/> {t('دفتر جديد','New ledger')}</button>}</div>
    {error&&<p role="alert" className="mb-3 rounded-xl border border-red-400/30 p-3 text-sm text-red-500">{error}</p>}
    {mode==='create'&&<section className={`rounded-2xl border p-4 ${surface}`}><div className="mb-4 flex items-center justify-between"><h3 className="font-bold">{t('إنشاء دفتر جديد','Create a ledger')}</h3><button onClick={()=>setMode('list')}><X size={18}/></button></div><label className="mb-2 block text-sm">{t('اسم الشخص / الدفتر','Person / ledger name')}</label><input className={input} value={name} onChange={e=>setName(e.target.value)} placeholder={t('اكتب الاسم','Enter a name')} maxLength={100}/><p className="mt-3 text-xs opacity-60">{t('تاريخ الإنشاء','Created')}: {new Date().toLocaleString(ar?'ar':'en')}</p><label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={opening} onChange={e=>setOpening(e.target.checked)}/>{t('إضافة رصيد سابق','Add opening balance')}</label>{opening&&<div className="mt-3 grid gap-3 sm:grid-cols-2"><input className={input} type="number" min="0.01" step="0.01" value={openingAmount} onChange={e=>setOpeningAmount(e.target.value)} placeholder={t('المبلغ','Amount')}/><select className={input} value={openingCurrency} onChange={e=>setOpeningCurrency(e.target.value)}>{CURRENCIES.map(c=><option key={c} value={c}>{currencyLabel[c]}</option>)}</select><select className={input+' sm:col-span-2'} value={openingDirection} onChange={e=>setOpeningDirection(e.target.value as any)}><option value="THEY_OWE_ME">{t('الشخص عليه إلي','They owe me')}</option><option value="I_OWE">{t('أنا عليّ إله','I owe them')}</option></select></div>}<button disabled={!name.trim()||busy||(opening&&(!openingAmount||Number(openingAmount)<=0))} onClick={()=>void saveLedger()} className="mt-4 w-full rounded-xl bg-white px-4 py-3 text-sm font-extrabold text-black disabled:opacity-40">{t('إضافة الدفتر','Create ledger')}</button></section>}
    {current&&mode==='list'&&<><button onClick={()=>setSelected(null)} className="mb-4 flex items-center gap-2 text-sm opacity-70"><ArrowRight size={16}/>{t('كل الدفاتر','All ledgers')}</button><section className={`mb-4 rounded-2xl border p-4 ${surface}`}><div className="flex items-center gap-2"><BookOpen size={20}/><div><h3 className="font-extrabold">{current.name}</h3><p className="text-xs opacity-60">{t('تاريخ الإنشاء','Created')}: {new Date(current.createdAt).toLocaleString(ar?'ar':'en')}</p></div></div><div className="mt-4 grid gap-2 sm:grid-cols-2">{Object.entries(balances).map(([c,v])=><div key={c} className="rounded-xl border border-white/10 p-3"><p className="text-xs opacity-60">{currencyLabel[c]||c}</p><p className="mt-1 text-lg font-extrabold">{money(Math.abs(v),c)}</p><p className="text-xs opacity-60">{v>0?t('إلك عنده','They owe you'):v<0?t('عليك إله','You owe them'):t('متعادل','Settled')}</p></div>)}</div><div className="mt-4 grid grid-cols-2 gap-2"><button className={button} onClick={()=>setMode('operation')}><Plus size={16} className="inline"/> {t('إضافة عملية','Add operation')}</button><button className={button} onClick={()=>setMode('payment')}><Wallet size={16} className="inline"/> {t('إضافة دفعة','Add payment')}</button></div></section><h4 className="mb-3 font-bold">{t('سجل الدفتر','Ledger history')}</h4><div className="grid gap-2">{currentEntries.map(e=><article key={e.id} className={`rounded-xl border p-3 ${surface}`}><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><ReceiptText size={17}/><b className="text-sm">{e.kind==='OPERATION'?t('عملية','Operation'):t('دفعة','Payment')} #{e.number}</b></div><b>{money(e.amountMinor,e.currency)}</b></div><p className="mt-2 text-sm opacity-80">{e.description||t('بدون وصف','No description')}</p><p className="mt-1 text-xs opacity-55">{new Date(e.createdAt).toLocaleString(ar?'ar':'en')} · {e.method==='CASH'?t('كاش','Cash'):e.method==='APP'?t('تطبيق دفع','Payment app'):t('دين','Debt')} · {e.direction==='THEY_OWE_ME'?t('عليه إلي','They owe me'):t('عليّ إله','I owe them')}</p></article>)}{currentEntries.length===0&&<p className="py-8 text-center text-sm opacity-55">{t('ما في حركات مسجلة بعد.','No entries yet.')}</p>}</div></>}
    {!current&&mode==='list'&&<><div className="mb-3 flex items-center gap-2 rounded-xl border border-white/10 px-3"><Search size={17} className="opacity-50"/><input className="w-full bg-transparent py-3 text-sm outline-none" placeholder={t('ابحث عن اسم…','Search names…')} value={search} onChange={e=>setSearch(e.target.value)}/></div><div className="grid gap-2">{ledgers.filter(x=>x.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(l=><button key={l.id} onClick={()=>setSelected(l.id)} className={`flex items-center justify-between rounded-xl border p-4 text-start ${surface}`}><span className="flex items-center gap-3"><BookOpen size={19}/><span><b className="block">{l.name}</b><small className="opacity-55">{new Date(l.createdAt).toLocaleDateString(ar?'ar':'en')}</small></span></span><ArrowLeft size={17}/></button>)}{ledgers.length===0&&<div className="py-12 text-center text-sm opacity-55">{t('لسه ما أنشأت أي دفتر. ابدأ بإضافة أول شخص.','No ledgers yet. Add your first person.')}</div>}</div></>}
    {(mode==='operation'||mode==='payment')&&current&&<section className={`rounded-2xl border p-4 ${surface}`}><div className="mb-4 flex items-center justify-between"><h3 className="font-bold">{mode==='operation'?t('إضافة عملية','Add operation'):t('إضافة دفعة','Add payment')}</h3><button onClick={()=>setMode('list')}><X size={18}/></button></div><p className="mb-3 text-xs opacity-60">{t('الوقت والتاريخ يسجلان تلقائيًا عند الحفظ','Date and time are captured when saved')}</p><label className="mb-2 block text-sm">{mode==='operation'?t('وصف الأغراض أو التعامل','Items / transaction description'):t('وصف الدفعة (اختياري)','Payment description (optional)')}</label><textarea className={input+' min-h-24'} value={description} onChange={e=>setDescription(e.target.value)} maxLength={1000}/><div className="mt-3 grid gap-3 sm:grid-cols-2"><input className={input} type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} placeholder={t('المبلغ','Amount')}/><select className={input} value={currency} onChange={e=>setCurrency(e.target.value)}>{CURRENCIES.map(c=><option key={c} value={c}>{currencyLabel[c]}</option>)}</select><select className={input+' sm:col-span-2'} value={direction} onChange={e=>setDirection(e.target.value as any)}><option value="THEY_OWE_ME">{t('الشخص عليه إلي','They owe me')}</option><option value="I_OWE">{t('أنا عليّ إله','I owe them')}</option></select><select className={input+' sm:col-span-2'} value={method} onChange={e=>setMethod(e.target.value as any)}><option value="CASH">{t('كاش','Cash')}</option>{mode==='operation'&&<option value="DEBT">{t('دين','Debt')}</option>}<option value="APP">{t('تطبيق دفع','Payment app')}</option></select></div><button disabled={busy||!amount||Number(amount)<=0} onClick={()=>void saveEntry()} className="mt-4 w-full rounded-xl bg-white px-4 py-3 text-sm font-extrabold text-black disabled:opacity-40"><Save size={16} className="inline"/> {t('حفظ','Save')}</button></section>}
    <p className="mt-5 flex items-center gap-2 text-xs opacity-50"><RefreshCw size={13}/>{t('الحفظ المحلي يعمل دون إنترنت على هذا الجهاز. المزامنة السحابية قيد استكمال الربط الآمن.','Local saving works offline on this device. Secure cloud sync integration is still being completed.')}</p>
  </div>;
};
