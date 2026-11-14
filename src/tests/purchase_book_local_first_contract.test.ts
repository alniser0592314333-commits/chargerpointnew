import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Purchase book local-first architecture contract', () => {
  const read = (file:string) => fs.readFileSync(path.resolve(process.cwd(),file),'utf8');
  const migration = read('supabase/migrations/20261111090000_purchase_book_local_first.sql');
  const isolationMigration = read('supabase/migrations/20261114120000_purchase_book_admin_isolation.sql');
  const syncEngine = read('src/infrastructure/sync/syncEngine.ts');
  const models = read('src/domain/models.ts');
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

  it('preserves the deployed canonical order numbering and order-item edit rules', () => {
    expect(migration).toContain('order_renumber_audit');
    expect(migration).toContain('business_day_order_sequences');
    expect(migration).toContain("IF COALESCE(auth.role(), '') = 'service_role'");
    expect(migration).not.toContain('Offline devices may submit reserved numbers out of order');
    expect(migration).toContain('autoDelivery');
    expect(migration).toContain("IF COALESCE(auth.role(), '') = 'service_role'");
    expect(migration).toContain("WHEN 'UPDATE_ORDER_ITEM'");
    expect(migration).toContain("WHEN 'RENUMBER_DAY_ORDERS'");
  });

  it('routes every purchase mutation through the existing canonical sync command processor', () => {
    for (const command of ['SAVE_PURCHASE_SUPPLIER','SAVE_PURCHASE_ITEM','SAVE_PURCHASE_PAYMENT_METHOD','SAVE_PURCHASE_MONTH','SAVE_PURCHASE_WEEK','SAVE_PURCHASE_DAY','SAVE_PURCHASE_ORDER','MARK_PURCHASE_ORDER_PAID']) {
      expect(migration).toContain(`'${command}'`);
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
    expect(backup).toContain('currentBackupAdminId');
    expect(backup).toContain('isOwnedPurchaseRow(row, activeAdminId)');
    expect(backup).toContain('adminId:r.admin_id');
    expect(backup).toContain('stripPurchaseChangeLog');
    expect(backup).toContain('stripPurchaseMutationSnapshots');
    expect(backup).toContain("localDb.setWithTx(tx, 'purchaseOrders'");
    expect(backup).toContain("for (const row of onlineData.purchaseOrders || [])");
    expect(backup).toContain("for (const row of d.purchaseOrders || [])");
  });

  it('uses deterministic date identities, prevents duplicate current days, and closes the previous week', () => {
    expect(service).toContain('stableCalendarId(`purchase-day:${adminId}:${date}`)');
    expect(service).toContain('days.find(day=>day.purchaseDate===date)');
    expect(service).toContain('weeks.filter(row=>!row.isClosed');
    expect(service).toContain('PURCHASE_WEEK_OVERLAP');
    expect(service).toContain('nextAfterLast');
    expect(service).toContain('const weekStartDay=await getPurchaseWeekStartDay()');
    expect(service).toContain('const alignedCurrentStart=dateString(current)<month.startDate?month.startDate:dateString(current)');
    expect(service).toContain('nextAfterLast>alignedCurrentStart ? nextAfterLast : alignedCurrentStart');
    expect(service).toContain('PURCHASE_UUID_UNAVAILABLE');
    expect(service).toContain("await localDb.set('system_settings','purchase_week_start_day',setting)");
    expect(service).toContain('PURCHASE_DAY_MISSING');
  });

  it('requires a payment method when a purchase is paid and preserves the unpaid debt until paid', () => {
    expect(service).toContain("input.paymentStatus==='PAID'&&!input.paymentMethodId");
    expect(service).toContain('PURCHASE_SUPPLIER_INVALID');
    expect(service).toContain('PURCHASE_DAY_CLOSED');
    expect(migration).toContain('Purchase supplier is missing or inactive');
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


  it('isolates purchase rows, parent references, snapshots, delta feeds, and offline queues by admin', () => {
    for (const table of ['purchase_suppliers','purchase_items','purchase_payment_methods','purchase_months','purchase_weeks','purchase_days','purchase_orders']) {
      expect(isolationMigration).toContain(`ALTER TABLE public.${table} ADD COLUMN IF NOT EXISTS admin_id uuid REFERENCES public.admins(id)`);
      expect(isolationMigration).toContain(`ALTER TABLE public.${table} ALTER COLUMN admin_id SET NOT NULL`);
      expect(isolationMigration).toContain('CREATE POLICY purchase_book_admin_isolation ON public.%I');
    }
    expect(isolationMigration).toContain('enforce_purchase_book_admin_owner');
    expect(isolationMigration).toContain('purchase_orders_supplier_owner_fk');
    expect(isolationMigration).toContain('purchase_orders_item_owner_fk');
    expect(isolationMigration).toContain('purchase_orders_method_owner_fk');
    expect(isolationMigration).toContain('capture_sync_bootstrap_snapshot__shared_unfiltered');
    expect(isolationMigration).toContain('capture_authoritative_business_snapshot__shared_unfiltered');
    expect(isolationMigration).toContain('purchase_entity_belongs_to_admin');
    expect(isolationMigration).toContain('pull_canonical_changes__shared_unfiltered');
    expect(isolationMigration).toContain('pull_canonical_delta_changes');
    expect(models).toContain('export interface PurchaseOwnedEntity extends BaseEntity { adminId?: ID; }');
    expect(service).toContain('currentPurchaseAdminId');
    expect(service).toContain('adminId, name:cleanName');
    expect(service).toContain('purchase-month:${adminId}:');
    expect(syncEngine).toContain('i.actorAdminId === activePurchaseAdminId');
    expect(store).toContain('row?.adminId === activePurchaseAdminId');
    expect(store).toContain('adminId: row.admin_id');
  });

  it('does not erase the independent purchase book during operational-data reset', () => {
    const localDb = read('src/infrastructure/localDb/localDb.ts');
    const resetList = localDb.slice(localDb.indexOf('const operationalTables = ['), localDb.indexOf('];', localDb.indexOf('const operationalTables = [')));
    for (const table of ['purchaseSuppliers','purchaseItems','purchasePaymentMethods','purchaseMonths','purchaseWeeks','purchaseDays','purchaseOrders']) {
      expect(resetList).not.toContain(table);
    }
  });

  it('keeps all purchase data in the existing backup and restore lifecycle', () => {
    for (const key of ['purchaseSuppliers','purchaseItems','purchasePaymentMethods','purchaseMonths','purchaseWeeks','purchaseDays','purchaseOrders']) {
      expect(backup).toContain(key);
    }
  });
});
