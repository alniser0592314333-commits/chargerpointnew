import React, { useState, useEffect } from 'react';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Plus, QrCode, Edit3, CheckCircle2, AlertCircle } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { 
  getOrdersForDay, 
  deliverAllOrdersInDay, 
  getBusinessDay, 
  UIDayOrderDetail, 
  useStoreSubscription 
} from './dayOrdersStore';
import { BusinessDayEntity } from '../../domain/models';

export interface DayDetailPageProps {
  dayId: string;
  onBack: () => void;
  onAddOrder?: (dayId: string) => void;
  onOpenOrderQr?: (dayId: string, orderId: string) => void;
  onEditOrder?: (dayId: string, orderId: string) => void;
}

export const DayDetailPage: React.FC<DayDetailPageProps> = ({
  dayId,
  onBack,
  onAddOrder,
  onOpenOrderQr,
  onEditOrder,
}) => {
  const { locale, t, formatDate, formatWeekday, formatTime, formatCurrency } = useI18n();
  const storeVersion = useStoreSubscription(['orders', 'orderItems', 'businessDays']);
  const [businessDay, setBusinessDay] = useState<BusinessDayEntity | null>(null);

  useEffect(() => {
    getBusinessDay(dayId).then(setBusinessDay);
  }, [dayId, storeVersion]);

  // Extract date string from businessDay or dayId as fallback
  const displayDate = businessDay?.businessDate || (dayId.startsWith('day-') ? dayId.replace('day-', '') : dayId);
  const weekday = formatWeekday(displayDate);
  const formattedDate = formatDate(displayDate);

  // Load orders for this day from Phase 5 Store
  const [orders, setOrders] = useState<UIDayOrderDetail[]>([]);
  const [isDeliverAllModalOpen, setIsDeliverAllModalOpen] = useState(false);
  const [binInput, setBinInput] = useState('');
  const [binError, setBinError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadOrders = () => {
    getOrdersForDay(dayId, locale).then((data) => {
      setOrders(data);
    });
  };

  useEffect(() => {
    let active = true;
    getOrdersForDay(dayId, locale).then((data) => {
      if (active) setOrders(data);
    });
    return () => {
      active = false;
    };
  }, [dayId, locale, storeVersion]);

  // Restore scroll position to target order if hash exists
  useEffect(() => {
    if (orders.length > 0) {
      const hash = window.location.hash;
      if (hash && hash.startsWith('#order-card-')) {
        setTimeout(() => {
          const targetEl = document.querySelector(hash);
          if (targetEl) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 100);
      }
    }
  }, [orders]);

  // Sort orders NEWEST FIRST
  const sortedOrders = [...orders].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  // Summary Metrics
  const orderCount = orders.length;
  const validNumberGroups = new Map<number, UIDayOrderDetail[]>();
  const numberingIssues = orders.filter((order) => !Number.isInteger(order.orderNumber) || order.orderNumber <= 0);
  for (const order of orders) {
    if (!Number.isInteger(order.orderNumber) || order.orderNumber <= 0) continue;
    const group = validNumberGroups.get(order.orderNumber) ?? [];
    group.push(order);
    validNumberGroups.set(order.orderNumber, group);
  }
  for (const group of validNumberGroups.values()) {
    if (group.length > 1) numberingIssues.push(...group);
  }

  const totalValueMinor = orders.reduce(
    (sum, ord) => sum + ord.items.reduce((iSum, item) => iSum + item.priceMinor, 0),
    0
  );

  const getOrderStatusBadge = (status?: string) => {
    switch (status) {
      case 'delivered':
      case 'completed':
        return (
          <span className="px-2 py-0.5 text-xs font-medium bg-emerald-50 text-emerald-700 dark:bg-[#0d362f] dark:text-[#7ae09e] rounded-md border border-emerald-200 dark:border-[#14423b]">
            {t('statusDelivered')}
          </span>
        );
      case 'cancelled':
        return (
          <span className="px-2 py-0.5 text-xs font-medium bg-red-50 text-red-700 dark:bg-[#360d13] dark:text-[#e07a7a] rounded-md border border-red-200 dark:border-[#421419]">
            {t('statusCancelled')}
          </span>
        );
      case 'charging':
      case 'in_progress':
      default:
        return (
          <span className="px-2 py-0.5 text-xs font-medium bg-sky-50 text-sky-700 dark:bg-[#0d2f36] dark:text-[#7ad8e0] rounded-md border border-sky-200 dark:border-[#143b42]">
            {t('statusCharging')}
          </span>
        );
    }
  };

  const getPaymentStatusBadge = (paymentStatus?: 'PAID' | 'PARTIAL' | 'UNPAID') => {
    switch (paymentStatus) {
      case 'PAID':
        return (
          <span className="px-2 py-0.5 text-xs font-medium bg-emerald-50 text-emerald-700 dark:bg-[#0d362f] dark:text-[#7ae09e] rounded-md border border-emerald-200 dark:border-[#14423b]">
            {t('paymentPaid')}
          </span>
        );
      case 'PARTIAL':
        return (
          <span className="px-2 py-0.5 text-xs font-medium bg-amber-50 text-amber-700 dark:bg-[#36270d] dark:text-[#e0be7a] rounded-md border border-amber-200 dark:border-[#423314]">
            {t('paymentPartial')}
          </span>
        );
      case 'UNPAID':
      default:
        return (
          <span className="px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-700 dark:bg-[#0d2623] dark:text-[#8eb698] rounded-md border border-gray-200 dark:border-[#14423b]">
            {t('paymentUnpaid')}
          </span>
        );
    }
  };

  // Mobile Edge-Swipe Back Gesture
  useEffect(() => {
    let startX = 0;
    let startY = 0;
    let isEdgeTouch = false;

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        const x = e.touches[0].clientX;
        const y = e.touches[0].clientY;
        const width = window.innerWidth;
        if (x < 40 || x > width - 40) {
          startX = x;
          startY = y;
          isEdgeTouch = true;
        } else {
          isEdgeTouch = false;
        }
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (isEdgeTouch && e.changedTouches.length === 1) {
        const endX = e.changedTouches[0].clientX;
        const endY = e.changedTouches[0].clientY;
        const deltaX = endX - startX;
        const deltaY = Math.abs(endY - startY);
        const width = window.innerWidth;

        if (deltaY < 50 && Math.abs(deltaX) > 45) {
          if ((startX < 40 && deltaX > 45) || (startX > width - 40 && deltaX < -45)) {
            onBack();
          }
        }
      }
      isEdgeTouch = false;
    };

    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchend', handleTouchEnd);
    };
  }, [onBack]);

  return (
    <div className="max-w-2xl mx-auto py-6 px-4 sm:px-6 space-y-6 text-gray-900 dark:text-[#daf1de]">
      {/* DAY HEADER */}
      <div className="pb-4 border-b border-gray-200 dark:border-[#14423b] space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-[#daf1de]">
              {weekday || formattedDate}
            </h1>
            {weekday && (
              <p className="text-xs text-gray-500 dark:text-[#8eb698] mt-0.5">
                {formattedDate}
              </p>
            )}
          </div>

          <Button
            variant="primary"
            size="sm"
            onClick={() => onAddOrder && onAddOrder(dayId)}
            className="gap-1.5 shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>{t('addOrder')}</span>
          </Button>
        </div>

        {/* Small inline summary (No large KPI cards) */}
        <div className="flex items-center justify-between text-xs text-gray-600 dark:text-[#8eb698] pt-1">
          <span>
            {orderCount === 1 ? t('orderSingleCount') : t('ordersCount', { count: orderCount })}
          </span>
          <span className="font-semibold text-gray-900 dark:text-[#daf1de]">
            {t('dayTotal')}
            {formatCurrency(totalValueMinor)}
          </span>
        </div>
      </div>

      {numberingIssues.length > 0 && (
        <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100 space-y-2">
          <div className="font-bold">
            {locale === 'ar' ? 'تنبيه: يوجد خلل في أرقام طلبات هذا اليوم' : 'Warning: order-number conflicts detected for this day'}
          </div>
          <p>
            {locale === 'ar'
              ? 'لم يتم تغيير أي رقم تلقائياً. استخدم «إعادة ترقيم يوم» من الإعدادات بعد التحقق.'
              : 'No numbers were changed automatically. Use “Renumber Day” in Settings after review.'}
          </p>
          <ul className="list-disc ps-5 space-y-1">
            {Array.from(new Map(numberingIssues.map((order) => [order.id, order])).values()).map((order) => (
              <li key={order.id}>
                {locale === 'ar' ? 'الطلب' : 'Order'} #{Number.isInteger(order.orderNumber) && order.orderNumber > 0 ? order.orderNumber : (locale === 'ar' ? 'غير محدد' : 'missing')}
                {' — '}{order.customerName}
                {order.orderNumber > 0 && validNumberGroups.get(order.orderNumber)?.length ? (
                  <span> ({locale === 'ar' ? 'رقم مكرر' : 'duplicate number'})</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ORDER LIST (Vertical List, Newest First, Divider-First Layout) */}
      {sortedOrders.length === 0 ? (
        <div className="py-16 text-center space-y-4 py-12">
          <p className="text-sm font-medium text-gray-500 dark:text-[#8eb698]">
            {t('noOrdersForDay')}
          </p>
          <Button
            variant="primary"
            size="sm"
            onClick={() => onAddOrder && onAddOrder(dayId)}
            className="gap-1.5"
          >
            <Plus className="w-4 h-4" />
            <span>{t('addOrder')}</span>
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {sortedOrders.map((order, idx) => {
            const orderTotalMinor = order.items.reduce((s, item) => s + item.priceMinor, 0);

            return (
              <React.Fragment key={order.id}>
                {/* ORDER SECTION */}
                <div id={`order-card-${order.id}`} className="space-y-3 pt-1">
                  {/* 1. ORDER NUMBER + TIME */}
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-base font-bold font-mono text-gray-900 dark:text-[#daf1de]">
                      {Number.isInteger(order.orderNumber) && order.orderNumber > 0 ? t('orderNumberShort', { number: order.orderNumber }) : (locale === 'ar' ? 'رقم غير محدد' : 'Number missing')}
                    </span>
                    <span className="text-xs text-gray-400 dark:text-[#8eb698]">
                      {formatTime(order.createdAt)}
                    </span>
                  </div>

                  {/* 2. CUSTOMER NAME + EXEMPTION STATUS */}
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div>
                      <h3 className="text-base font-bold text-gray-900 dark:text-[#daf1de]">
                        {order.customerName}
                      </h3>

                      {/* 3. CUSTOMER ID */}
                      <p className="text-xs font-mono text-gray-500 dark:text-[#8eb698] mt-0.5">
                        {order.customerId}
                      </p>
                    </div>

                    {order.chargerFeeExempt && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 dark:text-[#7ae09e] rounded-full border border-emerald-200/80 dark:border-emerald-800/40 shadow-2xs">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        <span>{locale === 'ar' ? 'معفي من رسوم الشاحن' : 'Exempt from charger fee'}</span>
                      </span>
                    )}
                  </div>

                  {/* 4. ORDER STATUS + PAYMENT STATUS */}
                  <div className="flex items-center gap-2 pt-0.5">
                    {getOrderStatusBadge(order.status)}
                    {getPaymentStatusBadge(order.paymentStatus)}
                  </div>

                  {/* 5. DEVICES SECTION */}
                  <div className="pt-2 space-y-2">
                    <p className="text-xs font-semibold text-gray-700 dark:text-[#8eb698]">
                      {t('devices')}:
                    </p>
                    <div className="space-y-2 text-xs">
                      {order.items.map((item) => (
                        <div key={item.id} className="flex items-center justify-between gap-2 text-gray-800 dark:text-[#daf1de]">
                          <span className="font-medium truncate">• {item.deviceName}</span>
                          <div className="flex items-center gap-2 shrink-0">
                            {!order.chargerFeeExempt && (
                              <span
                                className={`text-[11px] font-medium px-2 py-0.5 rounded-md border ${
                                  item.hasCharger
                                    ? 'bg-amber-50 text-amber-800 border-amber-200/80 dark:bg-amber-950/40 dark:text-[#e0be7a] dark:border-amber-800/40'
                                    : 'bg-gray-100 text-gray-600 border-gray-200/60 dark:bg-[#0c312b] dark:text-[#8eb698] dark:border-[#14423b]'
                                }`}
                              >
                                {item.hasCharger
                                  ? locale === 'ar' ? 'مع شاحن' : 'With Charger'
                                  : locale === 'ar' ? 'بدون شاحن' : 'Without Charger'}
                              </span>
                            )}
                            <span className="font-semibold text-gray-900 dark:text-[#daf1de] font-mono">
                              {formatCurrency(item.priceMinor)}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 6. TOTAL */}
                  <div className="pt-2 border-t border-gray-100 dark:border-[#103831] flex items-center justify-between text-xs">
                    <span className="font-bold text-gray-700 dark:text-[#8eb698]">
                      {t('orderTotal')}
                    </span>
                    <span className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">
                      {formatCurrency(orderTotalMinor)}
                    </span>
                  </div>

                  {/* 7. ORDER ACTIONS */}
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => onOpenOrderQr && onOpenOrderQr(dayId, order.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border border-gray-200 dark:border-[#14423b] text-gray-700 dark:text-[#daf1de] hover:bg-gray-50 dark:hover:bg-[#0b312b] transition-colors cursor-pointer"
                    >
                      <QrCode className="w-3.5 h-3.5 text-gray-500 dark:text-[#8eb698]" />
                      <span>QR</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onEditOrder && onEditOrder(dayId, order.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border border-gray-200 dark:border-[#14423b] text-gray-700 dark:text-[#daf1de] hover:bg-gray-50 dark:hover:bg-[#0b312b] transition-colors cursor-pointer"
                    >
                      <Edit3 className="w-3.5 h-3.5 text-gray-500 dark:text-[#8eb698]" />
                      <span>{t('edit')}</span>
                    </button>
                  </div>
                </div>

                {/* 8. ORDER SEPARATOR (Horizontal Divider Line between orders) */}
                {idx < sortedOrders.length - 1 && (
                  <hr className="border-t border-gray-200 dark:border-[#14423b] my-5" />
                )}
              </React.Fragment>
            );
          })}

          {/* DELIVER ALL ORDERS ACTION SECTION */}
          <div className="pt-6 space-y-4">
            <hr className="border-t border-gray-200 dark:border-[#14423b]" />
            <div className="flex justify-center">
              <Button
                variant="secondary"
                size="md"
                onClick={async () => {
                  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                    setIsSubmitting(true);
                    try {
                      const res = await deliverAllOrdersInDay(dayId, '');
                      if (res.success) loadOrders();
                      else setBinError(res.error || 'تعذر وضع العملية في طابور المزامنة');
                    } finally {
                      setIsSubmitting(false);
                    }
                    return;
                  }
                  setBinError('');
                  setBinInput('');
                  setIsDeliverAllModalOpen(true);
                }}
                className="gap-2 text-emerald-700 dark:text-[#7ae09e] border-emerald-300 dark:border-[#1e5246] hover:bg-emerald-50 dark:hover:bg-[#0c332b]"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>{t('deliverAllOrders') || 'تسليم جميع الطلبات'}</span>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* DELIVER ALL ORDERS BIN MODAL */}
      <Modal
        isOpen={isDeliverAllModalOpen}
        onClose={() => {
          setIsDeliverAllModalOpen(false);
          setBinInput('');
          setBinError('');
        }}
        title={t('deliverAllOrdersTitle') || 'تأكيد تسليم جميع طلبات اليوم'}
      >
        <div className="space-y-4">
          <p className="text-xs text-gray-600 dark:text-[#8eb698]">
            {t('deliverAllOrdersConfirmPrompt') ||
              'سيتم تحويل جميع الطلبات القابلة للتسليم في هذا اليوم إلى حالة "تم التسليم". يرجى إدخال رمز BIN للتأكيد.'}
          </p>

          {binError && (
            <div className="p-3 rounded-lg bg-red-50 dark:bg-[#360d13] border border-red-200 dark:border-[#421419] text-red-700 dark:text-[#e07a7a] text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{binError}</span>
            </div>
          )}

          <div>
            <label htmlFor="deliver-all-bin" className="block text-xs font-semibold text-gray-700 dark:text-[#daf1de] mb-1">
              {t('enterBinCode') || 'رمز BIN (4 أرقام)'}
            </label>
            <Input
              id="deliver-all-bin"
              type="password"
              maxLength={8}
              placeholder="••••"
              value={binInput}
              onChange={(e) => setBinInput(e.target.value)}
              className="text-center tracking-widest font-mono text-base"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setIsDeliverAllModalOpen(false);
                setBinInput('');
                setBinError('');
              }}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={isSubmitting || binInput.trim().length < 4}
              onClick={async () => {
                setBinError('');
                setIsSubmitting(true);
                try {
                  const res = await deliverAllOrdersInDay(dayId, binInput.trim());
                  if (!res.success) {
                    setBinError(res.error || t('invalidBinError') || 'رمز BIN غير صحيح');
                  } else {
                    setIsDeliverAllModalOpen(false);
                    setBinInput('');
                    loadOrders();
                  }
                } catch (err: any) {
                  setBinError(err.message || 'حدث خطأ أثناء تسليم الطلبات');
                } finally {
                  setIsSubmitting(false);
                }
              }}
            >
              {isSubmitting ? t('loading') : t('confirm') || 'تأكيد التسليم'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
