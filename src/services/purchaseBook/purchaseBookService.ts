import {
  PurchaseBookEntity, PurchaseBookTable, PurchaseCatalogEntity, PurchaseMonthEntity,
  PurchaseWeekEntity, PurchaseDayEntity, PurchaseOrderEntity, PurchaseCurrency,
} from '../../domain/models';
import { repoContext, ensureStoreHydrated } from '../../components/pages/dayOrdersStore';
import { RepositoryContext } from '../../application/useCases';
import { localDb } from '../../infrastructure/localDb/localDb';
import { recordSyncDiagnosticEvent } from '../../infrastructure/sync/syncDiagnosticJournal';
import { getLocalBusinessDateStr } from '../../utils/dateFormatter';

export class PurchaseBookOperationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PurchaseBookOperationError';
  }
}

const nowIso = () => new Date().toISOString();
const uuid = () => globalThis.crypto?.randomUUID?.() || `purchase-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const pad = (value: number) => String(value).padStart(2, '0');
const dateString = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
const parseDate = (value: string) => new Date(`${value}T12:00:00`);

function stableCalendarId(key: string): string {
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9, h3 = 0x85ebca6b, h4 = 0xc2b2ae35;
  for (let i=0;i<key.length;i++) {
    const n=key.charCodeAt(i);
    h1=Math.imul(h1^n,0x01000193); h2=Math.imul(h2^n,0x85ebca6b);
    h3=Math.imul(h3^n,0xc2b2ae35); h4=Math.imul(h4^n,0x27d4eb2d);
  }
  const hex=[h1,h2,h3,h4].map(v=>(v>>>0).toString(16).padStart(8,'0')).join('').slice(0,32).split('');
  hex[12]='5'; hex[16]=((parseInt(hex[16],16)&3)|8).toString(16);
  const raw=hex.join('');
  return `${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`;
}

function commandTypeFor(table: PurchaseBookTable): string {
  return table === 'suppliers' ? 'SAVE_PURCHASE_SUPPLIER'
    : table === 'items' ? 'SAVE_PURCHASE_ITEM'
    : table === 'methods' ? 'SAVE_PURCHASE_PAYMENT_METHOD'
    : table === 'months' ? 'SAVE_PURCHASE_MONTH'
    : table === 'weeks' ? 'SAVE_PURCHASE_WEEK'
    : table === 'days' ? 'SAVE_PURCHASE_DAY'
    : 'SAVE_PURCHASE_ORDER';
}

function saveInTransaction(
  ctx: RepositoryContext,
  table: PurchaseBookTable,
  entity: PurchaseBookEntity,
  previous?: PurchaseBookEntity,
  forcedCommand?: string,
  forcedPayload?: Record<string, unknown>,
): void {
  ctx.purchaseRepo!.save(table, entity);
  const type = forcedCommand || commandTypeFor(table);
  const basePayload = forcedPayload || entity;
  const stableCalendarCreate = !previous && (table === 'months' || table === 'weeks' || table === 'days');
  const commandPayload = stableCalendarCreate
    ? Object.fromEntries(Object.entries(basePayload).filter(([key]) => key !== 'createdAt' && key !== 'updatedAt'))
    : previous ? { ...basePayload, expectedVersion: previous.version } : basePayload;
  ctx.commandRepo.record(
    previous ? uuid() : entity.id,
    type,
    commandPayload,
    previous?.version,
  );
}

async function runPurchaseOperation<T>(label: string, work: () => Promise<T>): Promise<T> {
  try {
    await ensureStoreHydrated();
    return await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordSyncDiagnosticEvent({
      type: 'command_failed',
      commandId: `purchase-book-${Date.now()}`,
      error: `${label}: ${message}`.slice(0, 2000),
      timestamp: nowIso(),
    });
    if (error instanceof PurchaseBookOperationError) throw error;
    throw new PurchaseBookOperationError('PURCHASE_BOOK_OPERATION_FAILED', `تعذّر تنفيذ العملية: ${label}. السبب: ${message}`);
  }
}

export async function listPurchaseRows(table: PurchaseBookTable): Promise<PurchaseBookEntity[]> {
  return runPurchaseOperation('قراءة بيانات دفتر المشتريات', async () => {
    return [...await repoContext.purchaseRepo!.findAll(table)];
  });
}

export async function savePurchaseCatalog(
  table: 'suppliers' | 'items' | 'methods',
  name: string,
  existing?: PurchaseCatalogEntity,
): Promise<PurchaseCatalogEntity> {
  return runPurchaseOperation('حفظ الإضافة', async () => {
    const cleanName=name.trim();
    if (!cleanName) throw new PurchaseBookOperationError('PURCHASE_NAME_REQUIRED','الاسم مطلوب.');
    if (cleanName.length>120) throw new PurchaseBookOperationError('PURCHASE_NAME_TOO_LONG','الاسم طويل جداً.');
    const rows=await repoContext.purchaseRepo!.findAll(table) as PurchaseCatalogEntity[];
    if (rows.some(row=>row.id!==existing?.id && row.isActive && row.name.trim().toLocaleLowerCase()===cleanName.toLocaleLowerCase())) {
      throw new PurchaseBookOperationError('PURCHASE_NAME_DUPLICATE','هذا الاسم موجود مسبقاً.');
    }
    const timestamp=nowIso();
    const entity: PurchaseCatalogEntity={
      id:existing?.id || uuid(), name:cleanName, isActive:true, deletedAt:undefined,
      createdAt:existing?.createdAt || timestamp, updatedAt:timestamp, version:(existing?.version || 0)+1,
    };
    await repoContext.transactionManager.runInTransaction((ctx) => {
      saveInTransaction(ctx,table,entity,existing);
    });
    return entity;
  });
}

export async function hidePurchaseCatalog(table:'suppliers'|'items'|'methods', entity:PurchaseCatalogEntity):Promise<void>{
  return runPurchaseOperation('إخفاء الإضافة',async()=>{
    const updated:PurchaseCatalogEntity={...entity,isActive:false,deletedAt:nowIso(),updatedAt:nowIso(),version:entity.version+1};
    await repoContext.transactionManager.runInTransaction((ctx)=>{
      saveInTransaction(ctx,table,updated,entity);
    });
  });
}

export async function getPurchaseWeekStartDay():Promise<number>{
  const setting=await localDb.get<any>('system_settings','purchase_week_start_day');
  const raw=setting?.valueString ?? setting?.value_string;
  if(raw!==undefined && Number.isInteger(Number(raw)) && Number(raw)>=0 && Number(raw)<=6) return Number(raw);
  const localValue=typeof localStorage!=='undefined'?localStorage.getItem('purchase_week_start_day'):null;
  return raw!==undefined && Number.isInteger(Number(raw)) ? Number(raw) : 6;
}

export async function setPurchaseWeekStartDay(day:number):Promise<void>{
  return runPurchaseOperation('تغيير بداية الأسبوع',async()=>{
    if(!Number.isInteger(day)||day<0||day>6) throw new PurchaseBookOperationError('PURCHASE_WEEK_START_INVALID','يوم بداية الأسبوع غير صالح.');
    if(typeof localStorage!=='undefined') localStorage.setItem('purchase_week_start_day',String(day));
    await repoContext.transactionManager.runInTransaction((ctx)=>{
      ctx.commandRepo.record(uuid(),'SET_SYSTEM_SETTING',{
        key:'purchase_week_start_day',valueType:'string',valueString:String(day),entityId:'purchase_week_start_day',
      });
    });
  });
}

function monthRange(year:number,month:number){
  const start=`${year}-${pad(month)}-01`;
  const last=new Date(year,month,0);
  return {start,end:dateString(last)};
}

async function createCalendarDay(date:string,manualWeek=false):Promise<PurchaseDayEntity|null>{
  const months=await repoContext.purchaseRepo!.findAll('months') as PurchaseMonthEntity[];
  const weeks=await repoContext.purchaseRepo!.findAll('weeks') as PurchaseWeekEntity[];
  const days=await repoContext.purchaseRepo!.findAll('days') as PurchaseDayEntity[];
  const existingDay=days.find(day=>day.purchaseDate===date);
  if(existingDay) return existingDay;

  const parsed=parseDate(date);
  const year=parsed.getFullYear(), month=parsed.getMonth()+1;
  const range=monthRange(year,month);
  const monthId=stableCalendarId(`purchase-month:${year}-${pad(month)}`);
  const existingMonth=months.find(row=>row.id===monthId) || {
    id:monthId,year,month,startDate:range.start,endDate:range.end,isClosed:false,
    createdAt:nowIso(),updatedAt:nowIso(),version:1,
  } as PurchaseMonthEntity;

  const weekStartDay=await getPurchaseWeekStartDay();
  const offset=(parsed.getDay()-weekStartDay+7)%7;
  const calculatedStart=parseDate(date);
  calculatedStart.setDate(calculatedStart.getDate()-offset);
  let start=manualWeek?date:dateString(calculatedStart);
  if(start<range.start) start=range.start;
  let endDate=parseDate(start);
  endDate.setDate(endDate.getDate()+6);
  let end=dateString(endDate);
  if(end>range.end) end=range.end;
  const weekId=stableCalendarId(`purchase-week:${monthId}:${start}`);
  let targetWeek=weeks.find(row=>row.id===weekId && !row.isClosed) || null;
  const openWeeks=weeks.filter(row=>!row.isClosed && row.id!==targetWeek?.id);
  const dayFits=targetWeek && date>=targetWeek.startDate && date<=targetWeek.endDate;
  if(!targetWeek || !dayFits){
    let nextId=weekId;
    let suffix=2;
    while(weeks.some(row=>row.id===nextId)) nextId=stableCalendarId(`purchase-week:${monthId}:${start}:${suffix++}`);
    targetWeek={
      id:nextId,monthId,startDate:start,endDate:end,isClosed:false,
      createdAt:nowIso(),updatedAt:nowIso(),version:1,
    };
  }

  const timestamp=nowIso();
  const day:PurchaseDayEntity={
    id:stableCalendarId(`purchase-day:${date}`),weekId:targetWeek.id,purchaseDate:date,isClosed:false,
    createdAt:timestamp,updatedAt:timestamp,version:1,
  };
  await repoContext.transactionManager.runInTransaction((ctx)=>{
    if(!months.some(row=>row.id===monthId)) saveInTransaction(ctx,'months',existingMonth as PurchaseMonthEntity);
    for(const week of openWeeks){
      const closed={...week,isClosed:true,updatedAt:timestamp,version:week.version+1};
      saveInTransaction(ctx,'weeks',closed,week);
    }
    if(!weeks.some(row=>row.id===targetWeek!.id)) saveInTransaction(ctx,'weeks',targetWeek as PurchaseWeekEntity);
    saveInTransaction(ctx,'days',day);
  });
  return day;
}

export async function createCurrentPurchaseDay():Promise<PurchaseDayEntity>{
  return runPurchaseOperation('إنشاء يوم المشتريات',async()=>{
    const today=getLocalBusinessDateStr();
    const day=await createCalendarDay(today);
    if(!day) throw new PurchaseBookOperationError('PURCHASE_DAY_NOT_CREATED','تعذّر إنشاء يوم المشتريات.');
    return day;
  });
}

export async function createPurchaseWeek(monthId:string):Promise<PurchaseWeekEntity>{
  return runPurchaseOperation('إنشاء أسبوع المشتريات',async()=>{
    const months=await repoContext.purchaseRepo!.findAll('months') as PurchaseMonthEntity[];
    const weeks=await repoContext.purchaseRepo!.findAll('weeks') as PurchaseWeekEntity[];
    const month=months.find(row=>row.id===monthId);
    if(!month) throw new PurchaseBookOperationError('PURCHASE_MONTH_NOT_FOUND','الشهر غير موجود.');
    const timestamp=nowIso();
    const openWeeks=weeks.filter(row=>!row.isClosed);
    const today=getLocalBusinessDateStr();
    const lastWeek=weeks.filter(row=>row.monthId===monthId).sort((a,b)=>b.endDate.localeCompare(a.endDate))[0];
    const fallbackStart=lastWeek?dateString(new Date(parseDate(lastWeek.endDate).getTime()+86400000)):month.startDate;
    const start=today>=month.startDate&&today<=month.endDate?today:fallbackStart;
    if(start>month.endDate) throw new PurchaseBookOperationError('PURCHASE_MONTH_FULL','لا توجد مساحة لبدء أسبوع جديد داخل هذا الشهر.');
    const endCandidate=parseDate(start);endCandidate.setDate(endCandidate.getDate()+6);
    const weekEnd=dateString(endCandidate)>month.endDate?month.endDate:dateString(endCandidate);
    let weekId=stableCalendarId(`purchase-week:${monthId}:${start}`);
    let suffix=2;while(weeks.some(row=>row.id===weekId)) weekId=stableCalendarId(`purchase-week:${monthId}:${start}:${suffix++}`);
    const week:PurchaseWeekEntity={
      id:weekId,monthId,startDate:start,endDate:weekEnd,isClosed:false,
      createdAt:timestamp,updatedAt:timestamp,version:1,
    };
    await repoContext.transactionManager.runInTransaction((ctx)=>{
      for(const old of openWeeks) saveInTransaction(ctx,'weeks',{...old,isClosed:true,updatedAt:timestamp,version:old.version+1},old);
      const existing=weeks.find(row=>row.id===week.id);
      if(!existing) saveInTransaction(ctx,'weeks',week);
    });
    return week;
  });
}

export async function getCurrentPurchaseDay():Promise<PurchaseDayEntity|null>{
  return runPurchaseOperation('التحقق من يوم المشتريات الحالي',async()=>{
    const today=getLocalBusinessDateStr();
    const days=await repoContext.purchaseRepo!.findAll('days') as PurchaseDayEntity[];
    return days.find(day=>day.purchaseDate===today) || null;
  });
}

export async function addPurchaseOrder(input:{
  supplierId:string;itemId:string;paymentMethodId?:string;amount:number;currency:PurchaseCurrency;paymentStatus:'PAID'|'UNPAID';
}):Promise<PurchaseOrderEntity>{
  return runPurchaseOperation('إضافة طلب شراء',async()=>{
    if(!Number.isFinite(input.amount)||input.amount<=0) throw new PurchaseBookOperationError('PURCHASE_AMOUNT_INVALID','السعر يجب أن يكون رقماً أكبر من صفر.');
    if(input.paymentStatus==='PAID'&&!input.paymentMethodId) throw new PurchaseBookOperationError('PURCHASE_METHOD_REQUIRED','اختر طريقة الدفع للطلب المدفوع.');
    const precision=input.currency==='JOD'?1000:100;
    const amountMinor=Math.round(input.amount*precision);
    const purchasedAt=nowIso();
    const days=await repoContext.purchaseRepo!.findAll('days') as PurchaseDayEntity[];
    const day=days.find(row=>row.purchaseDate===getLocalBusinessDateStr());
    if(!day) throw new PurchaseBookOperationError('PURCHASE_DAY_MISSING','لا يوجد يوم حالي. أنشئ اليوم ثم أعد إضافة الطلب.');
    const order:PurchaseOrderEntity={
      id:uuid(),purchaseDayId:day.id,supplierId:input.supplierId,itemId:input.itemId,paymentMethodId:input.paymentMethodId,
      amountMinor,currency:input.currency,paymentStatus:input.paymentStatus,purchasedAt,
      paidAt:input.paymentStatus==='PAID'?purchasedAt:undefined,createdAt:purchasedAt,updatedAt:purchasedAt,version:1,
    };
    await repoContext.transactionManager.runInTransaction((ctx)=>{
      saveInTransaction(ctx,'orders',order);
    });
    return order;
  });
}

export async function markPurchaseOrderPaid(order:PurchaseOrderEntity,paymentMethodId?:string):Promise<PurchaseOrderEntity>{
  return runPurchaseOperation('تحويل طلب إلى مدفوع',async()=>{
    const method=paymentMethodId || order.paymentMethodId;
    if(!method) throw new PurchaseBookOperationError('PURCHASE_METHOD_REQUIRED','اختر طريقة الدفع قبل تحويل الطلب إلى مدفوع.');
    if(order.paymentStatus==='PAID') return order;
    const updated:PurchaseOrderEntity={...order,paymentMethodId:method,paymentStatus:'PAID',paidAt:nowIso(),updatedAt:nowIso(),version:order.version+1};
    await repoContext.transactionManager.runInTransaction((ctx)=>{
      saveInTransaction(ctx,'orders',updated,order,'MARK_PURCHASE_ORDER_PAID',{id:order.id,paymentMethodId:method});
    });
    return updated;
  });
}

export function purchaseAmountToMinor(amount:number,currency:PurchaseCurrency):number{
  return Math.round(amount*(currency==='JOD'?1000:100));
}
export function purchaseMinorToAmount(amountMinor:number,currency:PurchaseCurrency):number{
  return amountMinor/(currency==='JOD'?1000:100);
}
