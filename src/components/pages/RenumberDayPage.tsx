import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, RefreshCw, ShieldAlert } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import {
  getDaysList,
  getOrdersForDay,
  repoContext,
  useStoreSubscription,
  UIDaySummary,
  UIDayOrderDetail,
} from './dayOrdersStore';
import { phase5UseCases } from '../../application/useCases';
import { getCurrentAdminAuthorizationContext } from './dayOrdersStore';
import { authService, UserSession } from '../../services/auth/authService';

interface NumberedOrder {
  id: string;
  customerName: string;
  oldNumber: number;
  expectedVersion: number;
  newNumber: number;
}

export const RenumberDayPage: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { locale } = useI18n();
  const isArabic = locale === 'ar';
  const storeVersion = useStoreSubscription(['businessDays', 'orders']);
  const [session, setSession] = useState<UserSession | null>(null);
  const [days, setDays] = useState<UIDaySummary[]>([]);
  const [selectedDayId, setSelectedDayId] = useState('');
  const [orders, setOrders] = useState<NumberedOrder[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    authService.getCurrentSession().then((value) => { if (active) setSession(value); });
    return () => { active = false; };
  }, []);

  const isSuperAdmin = String(session?.role || '').toUpperCase().replace(/\s+/g, '_') === 'SUPER_ADMIN';
  const allowed = isSuperAdmin || Boolean(session?.permissions?.includes('orders:renumber-day'));

  useEffect(() => {
    let active = true;
    getDaysList().then((rows) => {
      if (!active) return;
      setDays(rows);
      if (!selectedDayId && rows.length) setSelectedDayId(rows[0].id);
    }).catch((e) => { if (active) setError(String(e?.message || e)); });
    return () => { active = false; };
  }, [storeVersion]);

  useEffect(() => {
    if (!selectedDayId) { setOrders([]); return; }
    let active = true;
    setLoading(true);
    Promise.all([
      getOrdersForDay(selectedDayId, locale),
      Promise.resolve(),
    ]).then(async ([rows]) => {
      const numbered: NumberedOrder[] = [];
      for (const row of rows as UIDayOrderDetail[]) {
        const entity = await repoContext.orderRepo.findById(row.id);
        if (!entity) continue;
        numbered.push({
          id: row.id,
          customerName: row.customerName,
          oldNumber: entity.displayNumber,
          expectedVersion: entity.version,
          newNumber: entity.displayNumber,
        });
      }
      numbered.sort((a, b) => (a.oldNumber > 0 ? a.oldNumber : Number.MAX_SAFE_INTEGER) - (b.oldNumber > 0 ? b.oldNumber : Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
      if (active) {
        setOrders(numbered.map((row, index) => ({ ...row, newNumber: index + 1 })));
        setError('');
      }
    }).catch((e) => { if (active) setError(String(e?.message || e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [selectedDayId, locale, storeVersion]);

  const changed = useMemo(() => orders.some((row, index) => row.oldNumber !== index + 1 || row.newNumber !== index + 1), [orders]);
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= orders.length) return;
    setOrders((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((row, i) => ({ ...row, newNumber: i + 1 }));
    });
    setNotice('');
  };

  const submit = async () => {
    if (!selectedDayId || !orders.length || !allowed) return;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const auth = getCurrentAdminAuthorizationContext();
      const result = await phase5UseCases.renumberDayOrders(
        auth,
        crypto.randomUUID(),
        selectedDayId,
        orders.map((row) => ({
          id: row.id,
          expectedVersion: row.expectedVersion,
          oldNumber: row.oldNumber,
          newNumber: row.newNumber,
        }))
      );
      if (!result.success) throw new Error(result.error || 'Renumber request failed');
      setConfirmOpen(false);
      setNotice(isArabic
        ? 'تم تسجيل التغيير محليًا وإرساله إلى طابور المزامنة. هذا ليس تأكيدًا نهائيًا من الخادم؛ تحقّق من مركز المزامنة قبل اعتبار العملية مكتملة.'
        : 'The change was queued locally for sync. This is not server confirmation; check Sync Center before treating it as complete.');
    } catch (e: any) {
      setError(e?.message || (isArabic ? 'تعذّر تسجيل التغيير' : 'Could not queue the change'));
    } finally {
      setLoading(false);
    }
  };

  if (session && !allowed) {
    return <div className="max-w-xl mx-auto p-6 space-y-3"><ShieldAlert className="w-8 h-8 text-amber-600" /><h1 className="text-xl font-bold">{isArabic ? 'غير مصرح' : 'Not authorized'}</h1><p>{isArabic ? 'تحتاج إلى صلاحية إعادة ترقيم يوم.' : 'The Renumber Day permission is required.'}</p><Button onClick={onBack}>{isArabic ? 'رجوع' : 'Back'}</Button></div>;
  }

  return (
    <main className="max-w-2xl mx-auto p-4 sm:p-6 space-y-5 text-gray-900 dark:text-[#daf1de]">
      <header className="flex items-start gap-3">
        <Button variant="outline" size="sm" onClick={onBack} aria-label={isArabic ? 'رجوع' : 'Back'}><ArrowLeft className="w-4 h-4" /></Button>
        <div><h1 className="text-xl font-bold">{isArabic ? 'إعادة ترقيم يوم' : 'Renumber Day'}</h1><p className="text-sm text-gray-500 dark:text-[#8eb698]">{isArabic ? 'اختر يومًا ثم رتّب الطلبات بالأسهم. لن تُعرض تفاصيل الطلب.' : 'Choose a day and reorder its orders with arrows. Order details are hidden.'}</p></div>
      </header>

      <label className="block space-y-2">
        <span className="text-sm font-semibold">{isArabic ? 'اليوم' : 'Business day'}</span>
        <select className="w-full rounded-xl border border-gray-300 dark:border-[#245047] bg-white dark:bg-[#061f1c] p-3" value={selectedDayId} onChange={(e) => { setSelectedDayId(e.target.value); setNotice(''); setError(''); }} disabled={loading}>
          {days.map((day) => <option key={day.id} value={day.id}>{day.date}{day.isClosed ? (isArabic ? ' — مغلق' : ' — Closed') : (isArabic ? ' — مفتوح' : ' — Open')}</option>)}
        </select>
      </label>

      {error && <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/30 dark:text-red-200">{error}</div>}
      {notice && <div role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">{notice}</div>}

      {loading ? <div className="py-8 text-center"><RefreshCw className="inline w-5 h-5 animate-spin" /> {isArabic ? 'جارٍ التحميل…' : 'Loading…'}</div> : (
        <section className="space-y-2">
          <div className="text-xs text-gray-500 dark:text-[#8eb698]">{isArabic ? 'الرقم الحالي ← الرقم الجديد' : 'Current number → new number'}</div>
          {orders.map((order, index) => (
            <div key={order.id} className="flex items-center gap-3 rounded-xl border border-gray-200 dark:border-[#245047] p-3">
              <div className="w-20 shrink-0 text-xs tabular-nums text-gray-500 dark:text-[#8eb698]">#{order.oldNumber > 0 ? order.oldNumber : (isArabic ? 'ناقص' : 'missing')} → <strong className="text-emerald-700 dark:text-emerald-300">#{index + 1}</strong></div>
              <div className="min-w-0 flex-1 font-semibold truncate">{order.customerName}</div>
              <div className="flex gap-1">
                <button type="button" disabled={index === 0 || loading} onClick={() => move(index, -1)} aria-label={isArabic ? 'تحريك لأعلى' : 'Move up'} className="p-2 rounded-lg border border-gray-300 dark:border-[#245047] disabled:opacity-30"><ArrowUp className="w-4 h-4" /></button>
                <button type="button" disabled={index === orders.length - 1 || loading} onClick={() => move(index, 1)} aria-label={isArabic ? 'تحريك لأسفل' : 'Move down'} className="p-2 rounded-lg border border-gray-300 dark:border-[#245047] disabled:opacity-30"><ArrowDown className="w-4 h-4" /></button>
              </div>
            </div>
          ))}
          {!orders.length && <p className="py-8 text-center text-sm text-gray-500">{isArabic ? 'لا توجد طلبات في هذا اليوم.' : 'No orders for this day.'}</p>}
        </section>
      )}

      <div className="flex gap-2">
        <Button variant="outline" onClick={() => {
          setOrders((current) => [...current].sort((a, b) => (a.oldNumber > 0 ? a.oldNumber : Number.MAX_SAFE_INTEGER) - (b.oldNumber > 0 ? b.oldNumber : Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id)).map((row, i) => ({ ...row, newNumber: i + 1 })));
          setNotice('');
        }} disabled={loading || !orders.length}>{isArabic ? 'إلغاء الترتيب' : 'Reset order'}</Button>
        <Button onClick={() => setConfirmOpen(true)} disabled={loading || !orders.length || !changed}>{isArabic ? 'مراجعة واعتماد الترتيب' : 'Review and confirm order'}</Button>
      </div>

      <Modal isOpen={confirmOpen} onClose={() => setConfirmOpen(false)} title={isArabic ? 'تأكيد إعادة الترقيم' : 'Confirm renumbering'}>
        <div className="space-y-4">
          <p className="text-sm">{isArabic ? 'سيتم إرسال ترتيب هذه الطلبات إلى المزامنة. إذا تغيّرت بيانات اليوم على الخادم، يجب رفض العملية وإعادة تحميل القائمة. لن يتم تجاهل التعارض.' : 'This order will be queued for sync. If the day changed on the server, the operation must be rejected and reviewed again.'}</p>
          <div className="max-h-64 overflow-y-auto space-y-1 text-sm">
            {orders.map((row, i) => <div key={row.id} className="flex justify-between gap-3 border-b border-gray-100 dark:border-[#245047] py-1"><span className="truncate">{row.customerName}</span><span className="shrink-0 tabular-nums">#{row.oldNumber > 0 ? row.oldNumber : '—'} → #{i + 1}</span></div>)}
          </div>
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setConfirmOpen(false)}>{isArabic ? 'إلغاء' : 'Cancel'}</Button><Button onClick={submit} disabled={loading}>{isArabic ? 'تأكيد وإرسال' : 'Confirm and queue'}</Button></div>
        </div>
      </Modal>
    </main>
  );
};
