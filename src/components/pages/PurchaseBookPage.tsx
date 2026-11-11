import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, CalendarDays, X, ChevronDown, Settings2, Pencil, EyeOff, CircleAlert } from 'lucide-react';
import {
  PurchaseCatalogEntity, PurchaseMonthEntity, PurchaseWeekEntity,
  PurchaseDayEntity, PurchaseOrderEntity, PurchaseCurrency,
} from '../../domain/models';
import { useStoreSubscription } from './dayOrdersStore';
import {
  addPurchaseOrder, createCurrentPurchaseDay, createPurchaseWeek, hidePurchaseCatalog,
  listPurchaseRows, markPurchaseOrderPaid, purchaseMinorToAmount, savePurchaseCatalog, PurchaseBookOperationError, getPurchaseWeekStartDay, setPurchaseWeekStartDay,
} from '../../services/purchaseBook/purchaseBookService';

type CurrencyTotals = Record<PurchaseCurrency, number>;
const currencies: PurchaseCurrency[] = ['ILS','USD','JOD'];
const emptyTotals = ():CurrencyTotals => ({ILS:0,USD:0,JOD:0});
const money = (minor:number,currency:PurchaseCurrency) => new Intl.NumberFormat('ar', {
  minimumFractionDigits: currency==='JOD'?3:2, maximumFractionDigits: currency==='JOD'?3:2,
}).format(purchaseMinorToAmount(minor,currency)) + ' ' + (currency==='ILS'?'₪':currency==='USD'?'$':'د.أ');
const localToday = () => {
  const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const timeLabel = (value:string) => new Date(value).toLocaleTimeString('ar',{hour:'2-digit',minute:'2-digit'});
const dateLabel = (value:string) => new Date(value+'T12:00:00').toLocaleDateString('ar',{day:'numeric',month:'long',year:'numeric'});

interface PurchaseBookPageProps { supplierId?: string; onNavigate?: (path:string)=>void; }

export const PurchaseBookPage:React.FC<PurchaseBookPageProps> = ({supplierId,onNavigate}) => {
  const version=useStoreSubscription('purchaseBook');
  const [suppliers,setSuppliers]=useState<PurchaseCatalogEntity[]>([]);
  const [items,setItems]=useState<PurchaseCatalogEntity[]>([]);
  const [methods,setMethods]=useState<PurchaseCatalogEntity[]>([]);
  const [months,setMonths]=useState<PurchaseMonthEntity[]>([]);
  const [weeks,setWeeks]=useState<PurchaseWeekEntity[]>([]);
  const [days,setDays]=useState<PurchaseDayEntity[]>([]);
  const [orders,setOrders]=useState<PurchaseOrderEntity[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [showOrderForm,setShowOrderForm]=useState(false);
  const [showPayDialog,setShowPayDialog]=useState<PurchaseOrderEntity|null>(null);
  const [payMethodId,setPayMethodId]=useState('');
  const [showNoDayDialog,setShowNoDayDialog]=useState(false);
  const [showAdditions,setShowAdditions]=useState(false);
  const [weekStartDay,setWeekStartDay]=useState(6);
  const [catalogType,setCatalogType]=useState<'suppliers'|'items'|'methods'>('suppliers');
  const [catalogName,setCatalogName]=useState('');
  const [editingCatalog,setEditingCatalog]=useState<PurchaseCatalogEntity|null>(null);
  const [amount,setAmount]=useState('');
  const [currency,setCurrency]=useState<PurchaseCurrency>('ILS');
  const [paymentStatus,setPaymentStatus]=useState<'PAID'|'UNPAID'>('UNPAID');
  const [supplierIdValue,setSupplierIdValue]=useState('');
  const [itemIdValue,setItemIdValue]=useState('');
  const [methodIdValue,setMethodIdValue]=useState('');
  const [quickAdd,setQuickAdd]=useState<'suppliers'|'items'|'methods'|null>(null);
  const [quickName,setQuickName]=useState('');
  const today=localToday();

  const reload=useCallback(async()=>{
    try{
      const [s,i,m,mo,w,d,o]=await Promise.all([
        listPurchaseRows('suppliers'),listPurchaseRows('items'),listPurchaseRows('methods'),
        listPurchaseRows('months'),listPurchaseRows('weeks'),listPurchaseRows('days'),listPurchaseRows('orders'),
      ]);
      setSuppliers(s as PurchaseCatalogEntity[]);setItems(i as PurchaseCatalogEntity[]);setMethods(m as PurchaseCatalogEntity[]);
      setMonths(mo as PurchaseMonthEntity[]);setWeeks(w as PurchaseWeekEntity[]);setDays(d as PurchaseDayEntity[]);setOrders(o as PurchaseOrderEntity[]);
      setError('');
    }catch(e){setError(e instanceof Error?e.message:'تعذّر تحميل دفتر المشتريات.');}
    finally{setLoading(false);}
  },[]);
  useEffect(()=>{void reload();},[reload,version]);
  useEffect(()=>{getPurchaseWeekStartDay().then(setWeekStartDay).catch(e=>setError(e.message));},[]);

  const activeSuppliers=suppliers.filter(x=>x.isActive);
  const activeItems=items.filter(x=>x.isActive);
  const activeMethods=methods.filter(x=>x.isActive);
  const supplier=suppliers.find(x=>x.id===supplierId);
  const visibleOrders=useMemo(()=>orders.filter(o=>!supplierId||o.supplierId===supplierId),[orders,supplierId]);
  const nameOf=(list:PurchaseCatalogEntity[],id?:string)=>list.find(x=>x.id===id)?.name || '—';
  const totalsFor=(rows:PurchaseOrderEntity[], unpaidOnly=false):CurrencyTotals=>{
    const totals=emptyTotals();
    rows.forEach(row=>{if(!unpaidOnly||row.paymentStatus==='UNPAID')totals[row.currency]+=row.amountMinor;});
    return totals;
  };
  const overall=totalsFor(visibleOrders);
  const debt=totalsFor(visibleOrders,true);
  const summaryRows=(totals:CurrencyTotals)=>currencies.filter(c=>totals[c]!==0).map(c=>({currency:c,amount:totals[c]}));

  const openOrderForm=()=>{setError('');setNotice('');setShowOrderForm(true);};
  const submitOrder=async()=>{
    try{
      if(!supplierIdValue||!itemIdValue||!amount){setError('أكمل الجهة والعنصر والسعر أولاً.');return;}
      if(paymentStatus==='PAID'&&!methodIdValue){setError('اختر طريقة الدفع للطلب المدفوع.');return;}
      await addPurchaseOrder({supplierId:supplierIdValue,itemId:itemIdValue,paymentMethodId:methodIdValue||undefined,amount:Number(amount),currency,paymentStatus});
      setShowOrderForm(false);setAmount('');setNotice('تمت إضافة الطلب وحفظه محلياً.');setError('');await reload();
    }catch(e){
      if(e instanceof PurchaseBookOperationError && e.code==='PURCHASE_DAY_MISSING'){setShowNoDayDialog(true);return;}
      setError(e instanceof Error?e.message:'تعذّر حفظ الطلب.');
    }
  };
  const createDayThenContinue=async()=>{
    try{await createCurrentPurchaseDay();setShowNoDayDialog(false);setError('');await submitOrder();}
    catch(e){setError(e instanceof Error?e.message:'تعذّر إنشاء اليوم الحالي.');setShowNoDayDialog(false);}
  };
  const createDay=async()=>{
    try{await createCurrentPurchaseDay();setNotice('تم إنشاء يوم المشتريات الحالي.');setError('');await reload();}
    catch(e){setError(e instanceof Error?e.message:'تعذّر إنشاء اليوم الحالي.');}
  };
  const quickCreate=async()=>{
    if(!quickAdd||!quickName.trim())return;
    try{
      const created=await savePurchaseCatalog(quickAdd,quickName);
      if(quickAdd==='suppliers')setSupplierIdValue(created.id);
      if(quickAdd==='items')setItemIdValue(created.id);
      if(quickAdd==='methods')setMethodIdValue(created.id);
      setQuickAdd(null);setQuickName('');await reload();
    }catch(e){setError(e instanceof Error?e.message:'تعذّرت إضافة الخيار.');}
  };
  const confirmPaid=async()=>{
    if(!showPayDialog)return;
    try{
      await markPurchaseOrderPaid(showPayDialog,payMethodId||undefined);
      setShowPayDialog(null);setPayMethodId('');setNotice('تم تحويل الطلب إلى مدفوع.');setError('');await reload();
    }catch(e){setError(e instanceof Error?e.message:'تعذّر تحويل الطلب إلى مدفوع.');}
  };
  const saveCatalogForm=async()=>{
    try{
      if(!catalogName.trim())return;
      await savePurchaseCatalog(catalogType,catalogName,editingCatalog||undefined);
      setCatalogName('');setEditingCatalog(null);await reload();
    }catch(e){setError(e instanceof Error?e.message:'تعذّر حفظ الإضافة.');}
  };
  const hideCatalogItem=async(row:PurchaseCatalogEntity)=>{
    try{await hidePurchaseCatalog(catalogType,row);await reload();}
    catch(e){setError(e instanceof Error?e.message:'تعذّر إخفاء الإضافة.');}
  };

  const groupedMonths=[...months].sort((a,b)=>b.startDate.localeCompare(a.startDate));
  const supplierOrders=visibleOrders;
  const orderCard=(order:PurchaseOrderEntity)=>(
    <div key={order.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 border-b border-gray-100 dark:border-[#123d37] last:border-0">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-gray-900 dark:text-[#daf1de]">
          <span>{nameOf(suppliers,order.supplierId)}</span><span className="text-gray-300">•</span><span>{nameOf(items,order.itemId)}</span>
        </div>
        <div className="text-[11px] text-gray-500 dark:text-[#8eb698] flex flex-wrap gap-2">
          <span>{timeLabel(order.purchasedAt)}</span>
          <span>طريقة الدفع: {nameOf(methods,order.paymentMethodId)}</span>
          <span>{order.paymentStatus==='PAID'?'مدفوع':'غير مدفوع'}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className={`font-mono font-bold text-sm ${order.paymentStatus==='UNPAID'?'text-rose-600 dark:text-rose-400':'text-gray-900 dark:text-[#daf1de]'}`}>{money(order.amountMinor,order.currency)}</span>
        {order.paymentStatus==='UNPAID'&&<button onClick={()=>{setShowPayDialog(order);setPayMethodId(order.paymentMethodId||'');}} className="text-[11px] font-bold rounded-lg border border-emerald-600/30 text-emerald-700 dark:text-emerald-300 px-3 py-2 hover:bg-emerald-50 dark:hover:bg-[#0c312b]">تحويل إلى مدفوع</button>}
      </div>
    </div>
  );

  const periodOrders=(day:PurchaseDayEntity)=>supplierOrders.filter(o=>o.purchaseDayId===day.id);
  const isCurrentDay=(day:PurchaseDayEntity)=>day.purchaseDate===today;
  const renderDay=(day:PurchaseDayEntity)=>(
    <details key={day.id} open={isCurrentDay(day)} className="rounded-lg border border-gray-100 dark:border-[#123d37] px-3 sm:px-4">
      <summary className="cursor-pointer list-none py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2"><CalendarDays className="w-4 h-4 text-emerald-700 dark:text-emerald-300"/><span className="text-xs font-bold">{dateLabel(day.purchaseDate)}</span>{isCurrentDay(day)&&<span className="text-[10px] rounded-full bg-emerald-50 text-emerald-700 px-2 py-1 dark:bg-[#123d37] dark:text-emerald-200">اليوم</span>}</div>
        <div className="flex items-center gap-3"><span className="text-xs font-mono text-gray-500">{summaryRows(totalsFor(periodOrders(day))).map(x=>money(x.amount,x.currency)).join(' • ')||'0'}</span><ChevronDown className="w-4 h-4 text-gray-400"/></div>
      </summary>
      <div className="pb-3">
        {periodOrders(day).sort((a,b)=>b.purchasedAt.localeCompare(a.purchasedAt)).map(orderCard)}
        {!supplierId&&isCurrentDay(day)&&<button onClick={openOrderForm} className="mt-2 inline-flex items-center gap-2 text-xs font-bold text-emerald-700 dark:text-emerald-300"><Plus className="w-4 h-4"/>إضافة طلب</button>}
      </div>
    </details>
  );

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 pb-24 space-y-5 text-gray-900 dark:text-[#daf1de]" dir="rtl">
      <header className="border-b border-gray-200 dark:border-[#14423b] pb-4">
        <div className="flex items-start justify-between gap-3">
          <div><h1 className="text-xl font-bold tracking-tight">{supplierId?(supplier?.name||'الجهة'): 'دفتر المشتريات'}</h1><p className="text-xs text-gray-500 dark:text-[#8eb698] mt-1">تسجيل المشتريات ومتابعة المستحقات حسب الجهة والعملة</p></div>
          {supplierId&&<button onClick={()=>onNavigate?.('/app/purchases')} className="text-xs text-emerald-700 dark:text-emerald-300">كل المشتريات</button>}
        </div>
      </header>

      {error&&<div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-800 dark:bg-rose-950/20 dark:border-rose-900 dark:text-rose-200 p-3 text-xs flex gap-2"><CircleAlert className="w-4 h-4 shrink-0"/>{error}</div>}
      {notice&&<div className="rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/20 dark:border-emerald-900 dark:text-emerald-200 p-3 text-xs">{notice}</div>}

      {!supplierId&&<div className="flex flex-wrap gap-2">
        <button onClick={openOrderForm} className="inline-flex items-center gap-2 rounded-xl bg-emerald-700 text-white px-4 py-2.5 text-xs font-bold hover:bg-emerald-800"><Plus className="w-4 h-4"/>إضافة طلب</button>
        <button onClick={createDay} className="inline-flex items-center gap-2 rounded-xl border border-gray-200 dark:border-[#28564d] px-4 py-2.5 text-xs font-bold hover:bg-gray-50 dark:hover:bg-[#0c312b]"><CalendarDays className="w-4 h-4"/>إضافة يوم</button>
        <button onClick={()=>setShowAdditions(v=>!v)} className="inline-flex items-center gap-2 rounded-xl border border-gray-200 dark:border-[#28564d] px-4 py-2.5 text-xs font-bold hover:bg-gray-50 dark:hover:bg-[#0c312b]"><Settings2 className="w-4 h-4"/>الإضافات</button>
      </div>}

      {loading?<div className="animate-pulse space-y-3"><div className="h-28 rounded-xl bg-gray-100 dark:bg-[#082622]"/><div className="h-48 rounded-xl bg-gray-100 dark:bg-[#082622]"/></div>:<>
        <section className="rounded-xl border border-gray-200 dark:border-[#14423b] bg-white dark:bg-[#082622] p-4 sm:p-5">
          <h2 className="text-sm font-bold mb-3">{supplierId?'ملخص الجهة':'ملخص دفتر المشتريات'}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><div className="text-[11px] text-gray-500 dark:text-[#8eb698] mb-2">إجمالي المشتريات</div>{summaryRows(overall).length?summaryRows(overall).map(x=><div key={x.currency} className="font-mono font-bold text-sm py-0.5">{money(x.amount,x.currency)}</div>):<div className="text-sm text-gray-400">0</div>}</div>
            <div><div className="text-[11px] text-gray-500 dark:text-[#8eb698] mb-2">إجمالي الديون الحالية</div>{summaryRows(debt).length?summaryRows(debt).map(x=><div key={x.currency} className="font-mono font-bold text-sm text-rose-600 dark:text-rose-400 py-0.5">{money(x.amount,x.currency)}</div>):<div className="text-sm text-gray-400">0</div>}</div>
          </div>
        </section>

        {showAdditions&&!supplierId&&<section className="rounded-xl border border-gray-200 dark:border-[#14423b] bg-white dark:bg-[#082622] p-4 space-y-4">
          <h2 className="text-sm font-bold">إدارة الإضافات</h2>
          <label className="block text-xs font-semibold">بداية الأسبوع
            <select value={weekStartDay} onChange={e=>{const value=Number(e.target.value);setWeekStartDay(value);setPurchaseWeekStartDay(value).catch(err=>setError(err.message));}} className="mt-1 w-full sm:w-64 rounded-lg border border-gray-200 dark:border-[#28564d] bg-transparent p-2.5">
              <option value={6}>السبت</option><option value={0}>الأحد</option><option value={1}>الاثنين</option><option value={2}>الثلاثاء</option><option value={3}>الأربعاء</option><option value={4}>الخميس</option><option value={5}>الجمعة</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-2">{([{id:'suppliers',label:'الجهات'},{id:'items',label:'العناصر'},{id:'methods',label:'طرق الدفع'}] as const).map(t=><button key={t.id} onClick={()=>{setCatalogType(t.id);setEditingCatalog(null);setCatalogName('');}} className={`rounded-lg px-3 py-2 text-xs font-bold ${catalogType===t.id?'bg-emerald-700 text-white':'bg-gray-100 dark:bg-[#0c312b]'}`}>{t.label}</button>)}</div>
          <div className="flex gap-2"><input value={catalogName} onChange={e=>setCatalogName(e.target.value)} placeholder={editingCatalog?'تعديل الاسم':'اسم جديد'} className="min-w-0 flex-1 rounded-lg border border-gray-200 dark:border-[#28564d] bg-transparent px-3 py-2 text-xs"/><button onClick={saveCatalogForm} className="rounded-lg bg-emerald-700 text-white px-4 text-xs font-bold">{editingCatalog?'حفظ':'إضافة'}</button></div>
          <div className="divide-y divide-gray-100 dark:divide-[#123d37]">{(catalogType==='suppliers'?suppliers:catalogType==='items'?items:methods).map(row=><div key={row.id} className="flex items-center justify-between py-2 text-xs"><span className={row.isActive?'':'line-through text-gray-400'}>{row.name}</span><div className="flex gap-3"><button onClick={()=>{setEditingCatalog(row);setCatalogName(row.name);}} className="text-emerald-700 dark:text-emerald-300"><Pencil className="w-4 h-4"/></button>{row.isActive&&<button onClick={()=>hideCatalogItem(row)} className="text-gray-400"><EyeOff className="w-4 h-4"/></button>}</div></div>)}</div>
        </section>}

        <section className="space-y-3">
          {groupedMonths.length===0?<div className="rounded-xl border border-dashed border-gray-300 dark:border-[#28564d] p-8 text-center text-xs text-gray-500">لا توجد مشتريات مسجلة لهذه الجهة بعد.</div>:groupedMonths.map(month=>{
            const monthWeeks=weeks.filter(w=>w.monthId===month.id).sort((a,b)=>b.startDate.localeCompare(a.startDate));
            const monthOrders=supplierOrders.filter(o=>days.some(d=>d.purchaseDate>=month.startDate&&d.purchaseDate<=month.endDate&&d.id===o.purchaseDayId));
            const monthTotal=totalsFor(monthOrders);
            return <details key={month.id} open={month.startDate.slice(0,7)===today.slice(0,7)} className="rounded-xl border border-gray-200 dark:border-[#14423b] bg-white dark:bg-[#082622] overflow-hidden">
              <summary className="cursor-pointer list-none p-4 flex items-center justify-between gap-3"><div className="font-bold text-sm">{new Date(month.startDate+'T12:00:00').toLocaleDateString('ar',{month:'long',year:'numeric'})}</div><div className="text-xs font-mono text-gray-500">{summaryRows(monthTotal).map(x=>money(x.amount,x.currency)).join(' • ')||'0'}</div></summary>
              <div className="px-3 sm:px-4 pb-4 space-y-3">
                {!supplierId&&<div className="flex justify-end"><button onClick={()=>createPurchaseWeek(month.id).then(reload).catch(e=>setError(e.message))} className="text-[11px] font-bold text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1"><Plus className="w-3.5 h-3.5"/>إضافة أسبوع</button></div>}
                {monthWeeks.map(week=>{
                  const weekDays=days.filter(d=>d.weekId===week.id).sort((a,b)=>b.purchaseDate.localeCompare(a.purchaseDate));
                  const weekOrders=supplierOrders.filter(o=>weekDays.some(d=>d.id===o.purchaseDayId));
                  const weekTotal=totalsFor(weekOrders);
                  return <details key={week.id} open={weekDays.some(isCurrentDay)} className="rounded-lg border border-gray-100 dark:border-[#123d37] p-3">
                    <summary className="cursor-pointer list-none flex items-center justify-between gap-3 py-1"><span className="text-xs font-bold">الأسبوع {dateLabel(week.startDate)} — {dateLabel(week.endDate)}{week.isClosed?' • مغلق':''}</span><span className="text-[11px] font-mono text-gray-500">{summaryRows(weekTotal).map(x=>money(x.amount,x.currency)).join(' • ')||'0'}</span></summary>
                    <div className="pt-3 space-y-2">{weekDays.map(renderDay)}</div>
                  </details>;
                })}
              </div>
            </details>;
          })}
        </section>
      </>}
      
      {showOrderForm&&<div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={()=>setShowOrderForm(false)}>
        <div role="dialog" aria-modal="true" className="w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] p-5 space-y-4" onClick={e=>e.stopPropagation()}>
          <div className="flex items-center justify-between"><h2 className="font-bold text-base">إضافة طلب شراء</h2><button onClick={()=>setShowOrderForm(false)}><X className="w-5 h-5"/></button></div>
          {error&&<p className="text-xs text-rose-600">{error}</p>}
          <div className="space-y-3">
            <label className="block text-xs font-semibold">الجهة <select value={supplierIdValue} onChange={e=>{if(e.target.value==='__add__'){setQuickAdd('suppliers');setQuickName('');}else setSupplierIdValue(e.target.value);}} className="mt-1 w-full rounded-lg border border-gray-200 dark:border-[#28564d] bg-transparent p-3"><option value="">اختر الجهة</option>{activeSuppliers.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}<option value="__add__">+ إضافة جهة جديدة</option></select></label>
            <label className="block text-xs font-semibold">العنصر المشترى <select value={itemIdValue} onChange={e=>{if(e.target.value==='__add__'){setQuickAdd('items');setQuickName('');}else setItemIdValue(e.target.value);}} className="mt-1 w-full rounded-lg border border-gray-200 dark:border-[#28564d] bg-transparent p-3"><option value="">اختر العنصر</option>{activeItems.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}<option value="__add__">+ إضافة عنصر جديد</option></select></label>
            <label className="block text-xs font-semibold">طريقة الدفع {paymentStatus==='PAID'?'(مطلوبة)':'(اختيارية)'} <select value={methodIdValue} onChange={e=>{if(e.target.value==='__add__'){setQuickAdd('methods');setQuickName('');}else setMethodIdValue(e.target.value);}} className="mt-1 w-full rounded-lg border border-gray-200 dark:border-[#28564d] bg-transparent p-3"><option value="">اختر طريقة الدفع</option>{activeMethods.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}<option value="__add__">+ إضافة طريقة دفع</option></select></label>
            <div className="grid grid-cols-2 gap-3"><label className="block text-xs font-semibold">السعر<input type="number" min="0.001" step={currency==='JOD'?'0.001':'0.01'} value={amount} onChange={e=>setAmount(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 dark:border-[#28564d] bg-transparent p-3"/></label><label className="block text-xs font-semibold">العملة<select value={currency} onChange={e=>setCurrency(e.target.value as PurchaseCurrency)} className="mt-1 w-full rounded-lg border border-gray-200 dark:border-[#28564d] bg-transparent p-3"><option value="ILS">شيكل (ILS)</option><option value="USD">دولار (USD)</option><option value="JOD">دينار (JOD)</option></select></label></div>
            <label className="block text-xs font-semibold">حالة الدفع<select value={paymentStatus} onChange={e=>setPaymentStatus(e.target.value as 'PAID'|'UNPAID')} className="mt-1 w-full rounded-lg border border-gray-200 dark:border-[#28564d] bg-transparent p-3"><option value="UNPAID">غير مدفوع</option><option value="PAID">مدفوع</option></select></label>
          </div>
          {quickAdd&&<div className="rounded-xl border border-emerald-200 dark:border-[#28564d] p-3 space-y-2"><div className="text-xs font-bold">إضافة {quickAdd==='suppliers'?'جهة':quickAdd==='items'?'عنصر':'طريقة دفع'} دون إغلاق النموذج</div><div className="flex gap-2"><input autoFocus value={quickName} onChange={e=>setQuickName(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-gray-200 dark:border-[#28564d] bg-transparent px-3 py-2 text-xs" placeholder="الاسم"/><button onClick={quickCreate} className="rounded-lg bg-emerald-700 text-white px-3 text-xs font-bold">إضافة</button><button onClick={()=>setQuickAdd(null)} className="text-xs">إلغاء</button></div></div>}
          <div className="flex gap-2"><button onClick={submitOrder} className="flex-1 rounded-xl bg-emerald-700 text-white py-3 text-xs font-bold">إضافة الطلب</button><button onClick={()=>setShowOrderForm(false)} className="rounded-xl border border-gray-200 dark:border-[#28564d] px-4 py-3 text-xs">إلغاء</button></div>
        </div>
      </div>}

      {showNoDayDialog&&<div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"><div role="dialog" className="w-full max-w-sm rounded-2xl bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] p-5 space-y-4"><div className="flex gap-2 items-center"><CircleAlert className="w-5 h-5 text-amber-500"/><h2 className="font-bold text-sm">لا يوجد يوم حالي</h2></div><p className="text-xs text-gray-500">يجب إنشاء يوم المشتريات الحالي قبل تسجيل الطلب.</p><div className="flex gap-2"><button onClick={createDayThenContinue} className="flex-1 bg-emerald-700 text-white rounded-lg py-2.5 text-xs font-bold">إنشاء يوم ومتابعة</button><button onClick={()=>setShowNoDayDialog(false)} className="border border-gray-200 dark:border-[#28564d] rounded-lg px-4 text-xs">إلغاء</button></div></div></div>}

      {showPayDialog&&<div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"><div role="dialog" aria-modal="true" className="w-full max-w-sm rounded-2xl bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] p-5 space-y-4"><h2 className="font-bold text-sm">تأكيد تحويل الطلب إلى مدفوع</h2><div className="text-xs space-y-1 text-gray-600 dark:text-[#8eb698]"><p>الجهة: {nameOf(suppliers,showPayDialog.supplierId)}</p><p>العنصر: {nameOf(items,showPayDialog.itemId)}</p><p>السعر: {money(showPayDialog.amountMinor,showPayDialog.currency)}</p><p>التاريخ: {dateLabel(showPayDialog.purchasedAt.slice(0,10))}</p></div><p className="text-xs">سيتم إلغاء احتساب هذا الطلب ضمن الديون الحالية.</p>{!showPayDialog.paymentMethodId&&<label className="block text-xs font-semibold">طريقة الدفع<select value={payMethodId} onChange={e=>setPayMethodId(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 dark:border-[#28564d] bg-transparent p-3"><option value="">اختر طريقة الدفع</option>{activeMethods.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>}<div className="flex gap-2"><button onClick={confirmPaid} className="flex-1 bg-emerald-700 text-white rounded-lg py-2.5 text-xs font-bold">موافق</button><button onClick={()=>setShowPayDialog(null)} className="border border-gray-200 dark:border-[#28564d] rounded-lg px-4 text-xs">إلغاء</button></div></div></div>}
    </div>
  );
};

