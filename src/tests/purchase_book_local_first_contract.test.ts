import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Purchase book local-first architecture contract', () => {
  const read = (file:string) => fs.readFileSync(path.resolve(process.cwd(),file),'utf8');
  const migration = read('supabase/migrations/20261111090000_purchase_book_local_first.sql');
  const store = read('src/components/pages/dayOrdersStore.ts');
  const service = read('src/services/purchaseBook/purchaseBookService.ts');
  const page = read('src/components/pages/PurchaseBookPage.tsx');
  const sidebar = read('src/components/shell/Sidebar.tsx');
  const backup = read('src/services/backup/backupService.ts');

  it('creates the seven independent purchase book tables with safe catalog and foreign-key behavior', () => {
    for (const table of ['purchase_suppliers','purchase_items','purchase_payment_methods','purchase_months','purchase_weeks','purchase_days','purchase_orders']) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    }
    expect(migration).toContain("currency IN ('ILS','USD','JOD')");
    expect(migration).toContain("payment_status<>'PAID' OR payment_method_id IS NOT NULL");
    expect(migration).toContain('purchase_date date NOT NULL UNIQUE');
    expect(migration).toContain('ON DELETE RESTRICT');
  });

  it('routes every purchase mutation through the existing canonical sync command processor', () => {
    for (const command of ['SAVE_PURCHASE_SUPPLIER','SAVE_PURCHASE_ITEM','SAVE_PURCHASE_PAYMENT_METHOD','SAVE_PURCHASE_MONTH','SAVE_PURCHASE_WEEK','SAVE_PURCHASE_DAY','SAVE_PURCHASE_ORDER','MARK_PURCHASE_ORDER_PAID']) {
      expect(migration).toContain(`WHEN '${command}'`);
      expect(store).toContain(`'${command}'`);
    }
    expect(store).toContain('localDb.setWithTx(tx, purchaseTableKeys[table], entity.id, entity)');
    expect(store).toContain('purchaseTypeMap');
    expect(store).toContain('notifyStoreAfterTransaction(\'purchaseBook\'');
    expect(service).toContain('ctx.commandRepo.record');
    expect(service).not.toContain('invokeSupabaseRpc');
    expect(service).not.toContain('invokeSupabaseRestGet');
  });

  it('includes purchase entities in both new-device bootstrap and authoritative backup snapshots', () => {
    for (const table of ['purchase_suppliers','purchase_items','purchase_payment_methods','purchase_months','purchase_weeks','purchase_days','purchase_orders']) {
      expect(migration).toContain(`'${table}'`);
    }
    expect(store).toContain('purchaseSuppliersRes');
    expect(store).toContain('purchaseWeeksRes');
    expect(store).toContain('purchaseOrdersRes');
    expect(backup).toContain("localDb.list('purchaseOrders')");
    expect(backup).toContain("localDb.setWithTx(tx, 'purchaseOrders'");
  });

  it('uses deterministic date identities, prevents duplicate current days, and closes the previous week', () => {
    expect(service).toContain('stableCalendarId(`purchase-day:${date}`)');
    expect(service).toContain('days.find(day=>day.purchaseDate===date)');
    expect(service).toContain('weeks.filter(row=>!row.isClosed');
    expect(service).toContain("localStorage.getItem('purchase_week_start_day')");
    expect(service).toContain('return Number(raw) : 6');
    expect(service).toContain('PURCHASE_DAY_MISSING');
  });

  it('requires a payment method when a purchase is paid and preserves the unpaid debt until paid', () => {
    expect(service).toContain("input.paymentStatus==='PAID'&&!input.paymentMethodId");
    expect(service).toContain("paymentStatus:'PAID'");
    expect(service).toContain("'MARK_PURCHASE_ORDER_PAID'");
    expect(page).toContain('تحويل إلى مدفوع');
    expect(page).toContain('لا يوجد يوم حالي');
    expect(page).toContain('إنشاء يوم ومتابعة');
  });

  it('provides Arabic administration routes, supplier pages, and local catalog management', () => {
    expect(page).toContain('إدارة الإضافات');
    expect(page).toContain('إضافة جهة جديدة');
    expect(page).toContain('إضافة عنصر جديد');
    expect(page).toContain('إضافة طريقة دفع');
    expect(page).toContain('بداية الأسبوع');
    expect(sidebar).toContain("'/app/purchases'");
    expect(sidebar).toContain('/app/purchases/supplier/');
  });

  it('keeps all purchase data in the existing backup and restore lifecycle', () => {
    for (const key of ['purchaseSuppliers','purchaseItems','purchasePaymentMethods','purchaseMonths','purchaseWeeks','purchaseDays','purchaseOrders']) {
      expect(backup).toContain(key);
    }
  });
});
