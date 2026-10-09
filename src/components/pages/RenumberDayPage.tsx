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
  phase5UseCases,
  getCurrentAdminAuthorizationContext,
} from './dayOrdersStore';
import { authService, UserSession } from '../../services/auth/authService';
import { localDb } from '../../infrastructure/localDb/localDb';
import { syncEventEmitter } from '../../infrastructure/sync/syncEngine';

interface NumberedOrder {
  id: string;
  customerName: string;
  createdAt: string;
  oldNumber: number;
  expectedVersion: number;
  newNumber: number;
}

export const RenumberDayPage: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { locale, formatTime } = useI18n();
  const isArabic = locale === 'ar';
  const storeVersion = useStoreSubscription(['businessDays', 'orders']);
  const [session, setSession] = useState<UserSession | null>(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [days, setDays] = useState<UIDaySummary[]>([]);
  const [selectedDayId, setSelectedDayId] = useState('');
  const [orders, setOrders] = useState<NumberedOrder[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingCommandId, setPendingCommandId] = useState<string | null>(null);
  const [commandPending, setCommandPending] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let active = true;
    authService.getCurrentSession().then((value) => { if (active) setSession(value); }).catch(() => { if (active) setSession(null); }).finally(() => { if (active) setAuthLoaded(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!pendingCommandId) return;
    let active = true;
    const refreshStatus = async () => {
      const history = await localDb.getHistoryByCommandId(pendingCommandId);
      if (!active) return;
      if (!history) {
        setCommandPending(true);
        setNotice(isArabic
          ? 'تم تسجيل العملية محليًا؛ بانتظار ظهور حالتها في المزامنة.'
          : 'The operation is queued locally and waiting for its sync status.');
        return;
      }
      if (history.state === 'SUCCESS' || history.state === 'SUCCEEDED') {
        setCommandPending(false);
        setNotice(isArabic
          ? 'أكد الخادم نجاح إعادة الترقيم. أعد فتح اليوم للتحقق من الأرقام المعتمدة.'
          : 'The server confirmed renumbering. Reopen the day to verify the accepted numbers.');
      } else if (['FAILED', 'FAILED_PERMANENT', 'CONFLICT', 'BLOCKED'].includes(history.state)) {
        setCommandPending(false);
        setRefreshTick((value) => value + 1);
        setSyncError(history.errorMessage || (isArabic
          ? 'رفضت المزامنة العملية أو تعارضت مع تغييرات أخرى. أعد تحميل اليوم وراجع الأرقام قبل المحاولة.'
          : 'Sync rejected the operation or found a conflict. Reload the day and review the numbers before retrying.'));
        setNotice('');
      } else {
        setCommandPending(true);
        setNotice(isArabic
          ? 'إعادة الترقيم معلّقة بانتظار تأكيد الخادم.'
          : 'Renumbering is pending server confirmation.');
      }
    };
    void refreshStatus();
    const unsubscribe = syncEventEmitter.subscribe((event) => {
      if ('commandId' in event && event.commandId === pendingCommandId) void refreshStatus();
    });
    return () => { active = false; unsubscribe(); };
  }, [pendingCommandId, isArabic]);

  const isSuperAdmin = String(session?.role || '').toUpperCase().replace(/\s+/g, '_') === 'SUPER_ADMIN';
  const allowed = isSuperAdmin || Boolean(session?.permissions?.includes('orders:renumber-day'));

  useEffect(() => {
    if (!authLoaded || !allowed) return;
    let active = true;
    getDaysList().then((rows) => {
      if (!active) return;
      setDays(rows);
      if (!selectedDayId && rows.length) setSelectedDayId(rows[0].id);
    }).catch((e) => { if (active) setError(String(e?.message || e)); });
    return () => { active = false; };
  }, [authLoaded, allowed, storeVersion]);

  useEffect(() => {
    if (!authLoaded || !allowed || !selectedDayId) { setOrders([]); return; }
    let active = true;
    setLoading(true);
    setOrders([]);
    Promise.all([
      getOrdersForDay(selectedDayId, locale),
      Promise.resolve(),
    ]).then(async ([rows]) => {
      const numbered: NumberedOrder[] = [];
      for (const row of rows as UIDayOrderDetail[]) {
        const entity = await repoContext.orderRepo.findById(row.id);
        if (!entity) {
          throw new Error(locale === 'ar'
            ? 'يوجد طلب غير مثبت محليًا أو لم تكتمل مزامنته. انتظر اكتمال المزامنة ثم حدّث الصفحة قبل إعادة الترقيم.'
            : 'An order is not yet available as a canonical local record. Wait for sync to finish, then refresh before renumbering.');
        }
        numbered.push({
          id: row.id,
          customerName: row.customerName,
          createdAt: row.createdAt,
          oldNumber: row.orderNumber,
          expectedVersion: entity.version,
          newNumber: entity.displayNumber,
        });
      }
      numbered.sort((a, b) => (a.oldNumber > 0 ? a.oldNumber : Number.MAX_SAFE_INTEGER) - (b.oldNumber > 0 ? b.oldNumber : Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
      if (active) {
        setOrders(numbered);
        setError('');
      }
    }).catch((e) => { if (active) setError(String(e?.message || e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [authLoaded, allowed, selectedDayId, locale, storeVersion, refreshTick]);

  const changed = useMemo(() => orders.some((row) => row.oldNumber !== row.newNumber), [orders]);
  const numberingValidation = useMemo(() => {
    if (!orders.length) return '';
    const numbers = orders.map((row) => row.newNumber);
    if (numbers.some((number) => !Number.isInteger(number) || number < 1 || number > orders.length)) {
      return isArabic
        ? `أدخل أرقامًا صحيحة من 1 إلى ${orders.length} لكل الطلبات.`
        : `Enter a whole number from 1 to ${orders.length} for every order.`;
    }
    if (new Set(numbers).size !== numbers.length) {
      return isArabic ? 'يوجد رقم طلب مكرر. يجب أن يكون لكل طلب رقم مختلف.' : 'Duplicate order numbers are not allowed.';
    }
    const sorted = [...numbers].sort((a, b) => a - b);
    if (sorted.some((number, index) => number !== index + 1)) {
      return isArabic ? 'الأرقام يجب أن تكون متسلسلة من 1 دون فجوات.' : 'Order numbers must be consecutive from 1 without gaps.';
    }
    return '';
  }, [orders, isArabic]);
  const hasValidNumberSet = useMemo(() => {
    if (!orders.length) return false;
    const numbers = orders.map((row) => row.newNumber).sort((a, b) => a - b);
    return numbers.every((number, index) => Number.isInteger(number) && number === index + 1);
  }, [orders]);

  const displayOrders = useMemo(
    () => hasValidNumberSet ? [...orders].sort((a, b) => a.newNumber - b.newNumber) : orders,
    [orders, hasValidNumberSet]
  );

  const move = (orderId: string, delta: number) => {
    setOrders((current) => {
      const numbers = current.map((row) => row.newNumber).sort((a, b) => a - b);
      const hasValidSet = current.length > 0 && numbers.every((number, index) => Number.isInteger(number) && number === index + 1);
      const next = hasValidSet ? [...current].sort((a, b) => a.newNumber - b.newNumber) : [...current];
      const index = next.findIndex((row) => row.id === orderId);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((row, i) => ({ ...row, newNumber: i + 1 }));
    });
    setNotice('');
    setError('');
  };

  const submit = async () => {
    if (!selectedDayId || !orders.length || !allowed || numberingValidation) return;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const auth = getCurrentAdminAuthorizationContext();
      const commandId = crypto.randomUUID();
      const result = await phase5UseCases.renumberDayOrders(
        auth,
        commandId,
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
      setPendingCommandId(commandId);
      setCommandPending(true);
      setNotice(isArabic
        ? 'تم تسجيل العملية محليًا؛ بانتظار تأكيد الخادم.'
        : 'The operation is queued locally and awaiting server confirmation.');
    } catch (e: any) {
      setError(e?.message || (isArabic ? 'تعذّر تسجيل التغيير' : 'Could not queue the change'));
    } finally {
      setLoading(false);
    }
  };

  if (!authLoaded) {
    return <main className="max-w-xl mx-auto p-6 text-center" role="status">{isArabic ? 'جارٍ التحقق من الصلاحية…' : 'Checking authorization…'}</main>;
  }

  if (!session || !allowed) {
    return <div className="max-w-xl mx-auto p-6 space-y-3"><ShieldAlert className="w-8 h-8 text-amber-600" /><h1 className="text-xl font-bold">{isArabic ? 'غير مصرح' : 'Not authorized'}</h1><p>{isArabic ? 'تحتاج إلى تسجيل الدخول وصلاحية إعادة ترقيم يوم.' : 'Sign in with the Renumber Day permission to continue.'}</p><Button onClick={onBack}>{isArabic ? 'رجوع' : 'Back'}</Button></div>;
  }

  return (
    <main className="max-w-2xl mx-auto p-4 sm:p-6 space-y-5 text-gray-900 dark:text-[#daf1de]">
      <header className="flex items-start gap-3">
        <Button variant="outline" size="sm" onClick={onBack} aria-label={isArabic ? 'رجوع' : 'Back'}><ArrowLeft className="w-4 h-4" /></Button>
        <div><h1 className="text-xl font-bold">{isArabic ? 'إعادة ترقيم يوم' : 'Renumber Day'}</h1><p className="text-sm text-gray-500 dark:text-[#8eb698]">{isArabic ? 'اختر اليوم ثم أدخل رقم كل طلب مباشرة أو استخدم الأسهم. راجع التغييرات قبل اعتمادها.' : 'Choose a day, enter each order number directly or use the arrows, then review before confirming.'}</p></div>
      </header>

      <label className="block space-y-2">
        <span className="text-sm font-semibold">{isArabic ? 'اليوم' : 'Business day'}</span>
        <select className="w-full rounded-xl border border-gray-300 dark:border-[#245047] bg-white dark:bg-[#061f1c] p-3" value={selectedDayId} onChange={(e) => { setSelectedDayId(e.target.value); setNotice(''); setError(''); setSyncError(''); }} disabled={loading}>
          {days.map((day) => <option key={day.id} value={day.id}>{day.date}{day.isClosed ? (isArabic ? ' — مغلق' : ' — Closed') : (isArabic ? ' — مفتوح' : ' — Open')}</option>)}
        </select>
      </label>

      {(error || syncError) && <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/30 dark:text-red-200" >{syncError || error}</div>}
      {notice && <div role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">{notice}</div>}

      {loading ? <div className="py-8 text-center"><RefreshCw className="inline w-5 h-5 animate-spin" /> {isArabic ? 'جارٍ التحميل…' : 'Loading…'}</div> : (
        <section className="space-y-2">
          <div className="text-xs text-gray-500 dark:text-[#8eb698]">{isArabic ? 'الرقم الحالي ← الرقم الجديد' : 'Current number → new number'}</div>
          {displayOrders.map((order, index) => (
            <div key={order.id} className="flex items-center gap-3 rounded-xl border border-gray-200 dark:border-[#245047] p-3">
              <div className="w-16 shrink-0 text-xs tabular-nums text-gray-500 dark:text-[#8eb698]">#{order.oldNumber > 0 ? order.oldNumber : (isArabic ? 'ناقص' : 'missing')}</div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold truncate">{order.customerName}</div>
                <div className="text-xs text-gray-500 dark:text-[#8eb698]">{formatTime(order.createdAt)}</div>
              </div>
              <label className="flex shrink-0 items-center gap-1 text-xs">
                <span className="text-gray-500 dark:text-[#8eb698]">{isArabic ? 'الجديد' : 'New #'}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={orders.length}
                  step={1}
                  value={order.newNumber > 0 ? String(order.newNumber) : ''}
                  disabled={loading || commandPending}
                  aria-label={isArabic ? `رقم الطلب الجديد للزبون ${order.customerName} الساعة ${formatTime(order.createdAt)}` : `New order number for ${order.customerName} at ${formatTime(order.createdAt)}`}
                  onChange={(event) => {
                    const raw = event.currentTarget.value;
                    const nextNumber = raw === '' ? 0 : Number(raw);
                    setOrders((current) => current.map((row) => row.id === order.id ? { ...row, newNumber: nextNumber } : row));
                    setNotice('');
                    setError('');
                  }}
                  className="w-16 rounded-lg border border-gray-300 bg-white px-2 py-2 text-center text-sm tabular-nums text-gray-900 dark:border-[#245047] dark:bg-[#061f1c] dark:text-[#daf1de]"
                />
              </label>
              <div className="flex gap-1">
                <button type="button" disabled={index === 0 || loading || commandPending} onClick={() => move(order.id, -1)} aria-label={isArabic ? 'تحريك لأعلى' : 'Move up'} className="p-2 rounded-lg border border-gray-300 dark:border-[#245047] disabled:opacity-30"><ArrowUp className="w-4 h-4" /></button>
                <button type="button" disabled={index === orders.length - 1 || loading || commandPending} onClick={() => move(order.id, 1)} aria-label={isArabic ? 'تحريك لأسفل' : 'Move down'} className="p-2 rounded-lg border border-gray-300 dark:border-[#245047] disabled:opacity-30"><ArrowDown className="w-4 h-4" /></button>
              </div>
            </div>
          ))}
          {!orders.length && <p className="py-8 text-center text-sm text-gray-500">{isArabic ? 'لا توجد طلبات في هذا اليوم.' : 'No orders for this day.'}</p>}
          {numberingValidation && <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">{numberingValidation}</p>}
        </section>
      )}

      <div className="flex gap-2">
        <Button variant="outline" onClick={() => {
          setOrders((current) => [...current]
            .sort((a, b) => (a.oldNumber > 0 ? a.oldNumber : Number.MAX_SAFE_INTEGER) - (b.oldNumber > 0 ? b.oldNumber : Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))
            .map((row) => ({ ...row, newNumber: row.oldNumber })));
          setNotice('');
          setError('');
        }} disabled={loading || commandPending || !orders.length}>{isArabic ? 'استعادة الأرقام الحالية' : 'Restore current numbers'}</Button>
        <Button onClick={() => setConfirmOpen(true)} disabled={loading || commandPending || !orders.length || !changed || Boolean(numberingValidation)}>{isArabic ? 'مراجعة واعتماد الترتيب' : 'Review and confirm order'}</Button>
      </div>

      <Modal isOpen={confirmOpen} onClose={() => setConfirmOpen(false)} title={isArabic ? 'تأكيد إعادة الترقيم' : 'Confirm renumbering'}>
        <div className="space-y-4">
          <p className="text-sm">{isArabic ? 'سيتم إرسال ترتيب هذه الطلبات إلى المزامنة. إذا تغيّرت بيانات اليوم على الخادم، يجب رفض العملية وإعادة تحميل القائمة. لن يتم تجاهل التعارض.' : 'This order will be queued for sync. If the day changed on the server, the operation must be rejected and reviewed again.'}</p>
          <div className="max-h-64 overflow-y-auto space-y-1 text-sm">
            {[...orders].sort((a, b) => a.newNumber - b.newNumber).map((row) => <div key={row.id} className="flex justify-between gap-3 border-b border-gray-100 dark:border-[#245047] py-1"><span className="min-w-0 truncate">{row.customerName} <span className="text-xs text-gray-500">({formatTime(row.createdAt)})</span></span><span className="shrink-0 tabular-nums">#{row.oldNumber > 0 ? row.oldNumber : '—'} → #{row.newNumber}</span></div>)}
          </div>
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setConfirmOpen(false)}>{isArabic ? 'إلغاء' : 'Cancel'}</Button><Button onClick={submit} disabled={loading || commandPending || Boolean(numberingValidation)}>{isArabic ? 'تأكيد وإرسال' : 'Confirm and queue'}</Button></div>
        </div>
      </Modal>
    </main>
  );
};
