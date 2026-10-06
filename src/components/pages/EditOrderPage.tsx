import React, { useState, useRef, useEffect } from 'react';
import { Button } from '../ui/Button';
import { Textarea } from '../ui/Textarea';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Plus, Trash2, AlertTriangle, Check, ChevronDown } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import {
  UIEditOrderDetail,
  UIEditOrderItem,
  UIDeviceTypeOption,
  getOrderForEdit,
  getDeviceTypesOptions,
  calculateDeviceItemPreviewPrice,
  updateOrderWithPhase5Engine,
} from './dayOrdersStore';

export interface EditOrderPageProps {
  dayId: string;
  orderId: string;
  onBack: () => void;
  onSuccess: (dayId: string, orderId: string) => void;
}

export interface NewDeviceFormItem {
  tempId: string;
  deviceTypeId: string;
  hasCharger: boolean;
}

export const EditOrderPage: React.FC<EditOrderPageProps> = ({
  dayId,
  orderId,
  onBack,
  onSuccess,
}) => {
  const { locale, t, formatCurrency } = useI18n();

  // Load Order and Devices State
  const [order, setOrder] = useState<UIEditOrderDetail | null>(null);
  const [deviceOptions, setDeviceOptions] = useState<UIDeviceTypeOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Editable Form State
  const [status, setStatus] = useState<'pending' | 'charging' | 'delivered' | 'cancelled'>('pending');
  const [isStatusDropdownOpen, setIsStatusDropdownOpen] = useState(false);
  const statusMenuRef = useRef<HTMLDivElement | null>(null);

  const [notes, setNotes] = useState('');
  const [existingItems, setExistingItems] = useState<UIEditOrderItem[]>([]);
  const [removedItemIds, setRemovedItemIds] = useState<string[]>([]);
  const [newItems, setNewItems] = useState<NewDeviceFormItem[]>([]);

  // Ref for auto-scrolling
  const lastDeviceRef = useRef<HTMLDivElement | null>(null);

  // Click outside to close status dropdown
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (statusMenuRef.current && !statusMenuRef.current.contains(e.target as Node)) {
        setIsStatusDropdownOpen(false);
      }
    };
    if (isStatusDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isStatusDropdownOpen]);

  // Load Order and Devices on Mount or when locale changes
  useEffect(() => {
    let active = true;
    setIsLoading(true);

    Promise.all([getOrderForEdit(orderId, locale), getDeviceTypesOptions(locale)]).then(
      ([ordData, opts]) => {
        if (!active) return;
        if (ordData) {
          setOrder(ordData);
          setStatus(ordData.status);
          setNotes(ordData.notes || '');
          setExistingItems(ordData.items.filter((i) => i.status !== 'cancelled'));
        } else {
          setErrorMessage(t('orderNotFound'));
        }
        setDeviceOptions(opts);
        setIsLoading(false);
      }
    );

    return () => {
      active = false;
    };
  }, [orderId, locale]);

  // Mobile Edge-Swipe Back Gesture Listener
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

  // Handle removing existing item
  const handleRemoveExistingItem = (itemId: string) => {
    const activeExistingCount = existingItems.filter((i) => !removedItemIds.includes(i.id)).length;
    const totalRemaining = activeExistingCount - 1 + newItems.length;

    if (totalRemaining < 1) {
      setErrorMessage(t('cannotRemoveAllDevices'));
      return;
    }

    setRemovedItemIds((prev) => [...prev, itemId]);
    setErrorMessage('');
  };

  // Handle adding new device row
  const handleAddNewDeviceRow = () => {
    if (deviceOptions.length === 0) return;
    const newRow: NewDeviceFormItem = {
      tempId: `new_dev_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      deviceTypeId: deviceOptions[0].id,
      hasCharger: false,
    };
    setNewItems((prev) => [...prev, newRow]);
    setErrorMessage('');

    setTimeout(() => {
      if (lastDeviceRef.current) {
        lastDeviceRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 100);
  };

  // Handle removing new device row
  const handleRemoveNewDeviceRow = (index: number) => {
    const activeExistingCount = existingItems.filter((i) => !removedItemIds.includes(i.id)).length;
    const totalRemaining = activeExistingCount + (newItems.length - 1);

    if (totalRemaining < 1) {
      setErrorMessage(t('cannotRemoveAllDevices'));
      return;
    }

    setNewItems((prev) => prev.filter((_, i) => i !== index));
    setErrorMessage('');
  };

  // Handle charger toggle for newly added device
  const handleNewChargerToggle = (index: number, hasCharger: boolean) => {
    setNewItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, hasCharger } : item))
    );
  };

  // Format debt limit
  const formatDebtLimit = (minor: number) => {
    const val = Math.abs(minor / 100);
    return `${val} ₪`;
  };

  // Format Order Creation Date & Time (Hour, Minute, and Date)
  const formatOrderDateTime = (isoString?: string) => {
    if (!isoString) return '';
    try {
      const d = new Date(isoString);
      return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-US', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(d);
    } catch {
      return isoString;
    }
  };

  // Compute live totals
  const activeExistingItems = existingItems.filter((i) => !removedItemIds.includes(i.id));

  const existingTotalMinor = activeExistingItems.reduce(
    (sum, item) => sum + item.priceMinor,
    0
  );

  const newTotalMinor = newItems.reduce((sum, dev) => {
    const calculated = calculateDeviceItemPreviewPrice(dev.deviceTypeId, dev.hasCharger, false);
    return sum + calculated;
  }, 0);

  const grandTotalMinor = existingTotalMinor + newTotalMinor;

  // BIN Verification State for Sensitive Status Changes (Delivered / Cancelled)
  const [isBinModalOpen, setIsBinModalOpen] = useState(false);
  const [binInput, setBinInput] = useState('');
  const [binError, setBinError] = useState('');

  // Handle saving modifications
  const executeSave = async (binCode?: string) => {
    setErrorMessage('');
    setBinError('');

    if (activeExistingItems.length + newItems.length < 1) {
      setErrorMessage(t('cannotRemoveAllDevices'));
      return;
    }

    setIsSaving(true);
    try {
      const itemsToAdd = newItems.map((n) => ({
        deviceTypeId: n.deviceTypeId,
        hasCharger: n.hasCharger,
      }));

      const result = await updateOrderWithPhase5Engine(
        orderId,
        notes,
        status,
        itemsToAdd,
        removedItemIds,
        binCode
      );

      if (result.success) {
        setIsBinModalOpen(false);
        onSuccess(dayId, orderId);
      } else {
        if (isBinModalOpen) {
          setBinError(result.error || t('invalidBinError') || 'رمز BIN غير صحيح');
        } else {
          setErrorMessage(result.error || t('errorOccurred'));
        }
      }
    } catch (err: any) {
      if (isBinModalOpen) {
        setBinError(err.message || 'حدث خطأ أثناء التأكيد');
      } else {
        setErrorMessage(err.message || t('errorOccurred'));
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = () => {
    setErrorMessage('');
    if (activeExistingItems.length + newItems.length < 1) {
      setErrorMessage(t('cannotRemoveAllDevices'));
      return;
    }

    const requiresBin = (status === 'delivered' || status === 'cancelled') && status !== order?.status;
    if (requiresBin) {
      setBinInput('');
      setBinError('');
      setIsBinModalOpen(true);
    } else {
      executeSave();
    }
  };

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto py-12 px-4 text-center text-gray-500 dark:text-[#8eb698] text-sm">
        {t('loadingOrderData')}
      </div>
    );
  }

  if (!order) {
    return (
      <div className="max-w-3xl mx-auto py-12 px-4 text-center space-y-4">
        <p className="text-red-600 dark:text-[#e07a7a] font-bold">{t('orderNotFound')}</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto py-6 px-4 sm:px-6 space-y-6 text-gray-900 dark:text-[#daf1de] pb-24">
      {/* 1. Header: Title, Customer Name, Creation Timestamp, #Number with Blue Underline, and Status Menu */}
      <div className="pb-4 border-b border-gray-200/80 dark:border-[#14423b] flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-[#daf1de]">
            {t('editOrderTitle')}
          </h1>
          <p className="text-sm font-semibold text-gray-700 dark:text-[#8eb698] truncate">
            {order.customerName}
          </p>
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          {/* Order Creation Timestamp (Hour, Minute & Date) */}
          <span className="text-xs font-medium text-gray-500 dark:text-[#8eb698]">
            {formatOrderDateTime(order.createdAt)}
          </span>

          <div className="flex items-center gap-4">
            {/* Order Sequence Number: #1 in blue with blue underline */}
            <div className="inline-block border-b-2 border-blue-600 dark:border-blue-400 pb-0.5">
              <span className="text-xl sm:text-2xl font-bold font-mono text-blue-600 dark:text-blue-400">
                #{order.orderNumber}
              </span>
            </div>

            {/* Status Dropdown Menu (No oval border, clean text + arrow) */}
            <div className="relative" ref={statusMenuRef}>
              <button
                type="button"
                onClick={() => setIsStatusDropdownOpen(!isStatusDropdownOpen)}
                className="flex items-center gap-1.5 text-xs font-bold text-gray-800 dark:text-[#daf1de] hover:text-emerald-700 dark:hover:text-[#7ae09e] transition-colors cursor-pointer py-1 px-1.5 rounded-lg"
              >
                <span>
                  {status === 'delivered'
                    ? t('statusDelivered')
                    : status === 'cancelled'
                    ? t('statusCancelled')
                    : t('statusCharging')}
                </span>
                <ChevronDown className={`w-3.5 h-3.5 text-gray-500 dark:text-[#8eb698] transition-transform ${isStatusDropdownOpen ? 'rotate-180' : ''}`} />
              </button>

              {isStatusDropdownOpen && (
                <div className="absolute end-0 top-full mt-1.5 w-40 bg-white dark:bg-[#061f1c] rounded-xl shadow-lg border border-gray-200 dark:border-[#14423b] py-1 z-30 divide-y divide-gray-100 dark:divide-[#0f302b]">
                  <button
                    type="button"
                    onClick={() => {
                      setStatus('pending');
                      setIsStatusDropdownOpen(false);
                    }}
                    className={`w-full text-start px-3 py-2 text-xs font-medium transition-colors hover:bg-gray-50 dark:hover:bg-[#0c312b] cursor-pointer flex items-center justify-between ${
                      status === 'pending' ? 'font-bold text-emerald-700 dark:text-[#7ae09e]' : 'text-gray-700 dark:text-[#daf1de]'
                    }`}
                  >
                    <span>{t('statusCharging')}</span>
                    {status === 'pending' && <Check className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setStatus('delivered');
                      setIsStatusDropdownOpen(false);
                    }}
                    className={`w-full text-start px-3 py-2 text-xs font-medium transition-colors hover:bg-gray-50 dark:hover:bg-[#0c312b] cursor-pointer flex items-center justify-between ${
                      status === 'delivered' ? 'font-bold text-emerald-700 dark:text-[#7ae09e]' : 'text-gray-700 dark:text-[#daf1de]'
                    }`}
                  >
                    <span>{t('statusDelivered')}</span>
                    {status === 'delivered' && <Check className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setStatus('cancelled');
                      setIsStatusDropdownOpen(false);
                    }}
                    className={`w-full text-start px-3 py-2 text-xs font-medium transition-colors hover:bg-gray-50 dark:hover:bg-[#0c312b] cursor-pointer flex items-center justify-between ${
                      status === 'cancelled' ? 'font-bold text-rose-600 dark:text-rose-400' : 'text-gray-700 dark:text-[#daf1de]'
                    }`}
                  >
                    <span>{t('statusCancelled')}</span>
                    {status === 'cancelled' && <Check className="w-3.5 h-3.5" />}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Global Error Banner */}
      {errorMessage && (
        <div className="p-3.5 rounded-xl bg-red-50 dark:bg-[#360d13] border border-red-200 dark:border-[#421419] text-red-700 dark:text-[#e07a7a] text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* SECTION 1: CUSTOMER INFO (Directly on page surface, ZERO card-in-card) */}
      <section className="space-y-3 pb-5 border-b border-gray-200/80 dark:border-[#14423b]">
        <div className="pb-1 flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">
            {t('customerInfo')}
          </h2>
          <span className="text-xs font-mono font-bold text-blue-600 dark:text-blue-400">
            {order.customerId}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div className="space-y-0.5">
            <span className="text-gray-500 dark:text-[#8eb698] block">
              {locale === 'ar' ? 'اسم العميل' : 'Customer Name'}
            </span>
            <span className="font-semibold text-gray-900 dark:text-[#daf1de] block truncate">
              {order.customerName}
            </span>
          </div>

          <div className="space-y-0.5">
            <span className="text-gray-500 dark:text-[#8eb698] block">
              {t('phoneNumber')}
            </span>
            <span className="font-medium text-gray-700 dark:text-[#daf1de] dir-ltr text-start block">
              {order.customerPhone || t('noPhone')}
            </span>
          </div>

          <div className="space-y-0.5">
            <span className="text-gray-500 dark:text-[#8eb698] block">
              {t('debtLimit')}
            </span>
            <span className="font-medium text-gray-700 dark:text-[#daf1de] block">
              {formatDebtLimit(order.debtLimitMinor)}
            </span>
          </div>

          <div className="space-y-0.5">
            <span className="text-gray-500 dark:text-[#8eb698] block">
              {t('balanceAtOrderCreation')}
            </span>
            <span className="font-bold text-gray-900 dark:text-[#daf1de] block">
              {order.customerBalanceSnapshotMinor !== undefined ? (
                formatCurrency(order.customerBalanceSnapshotMinor)
              ) : (
                <span className="text-gray-400 dark:text-[#5e8674] font-normal">
                  {t('unavailableForLegacyOrders')}
                </span>
              )}
            </span>
          </div>
        </div>
      </section>

      {/* SECTION 2: REGISTERED DEVICES / SERVICES (Directly on page surface, ZERO card-in-card) */}
      <section className="space-y-4 pb-5 border-b border-gray-200/80 dark:border-[#14423b]">
        <div className="flex items-center justify-between pb-1">
          <h2 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">
            {locale === 'ar' ? 'الأجهزة والخدمات المسجلة' : 'Registered Devices & Services'}
          </h2>
          <span className="text-xs text-gray-500 dark:text-[#8eb698]">
            ({activeExistingItems.length + newItems.length} {locale === 'ar' ? 'أجهزة' : 'devices'})
          </span>
        </div>

        <div className="divide-y divide-gray-100 dark:divide-[#0f302b]">
          {/* Existing Order Items */}
          {activeExistingItems.map((item, idx) => (
            <div
              key={item.id}
              className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="space-y-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-gray-500 dark:text-[#8eb698]">
                    #{idx + 1}
                  </span>
                  <span className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">
                    {item.deviceName}
                  </span>
                  <span className="text-[11px] text-gray-500 dark:text-[#8eb698]">
                    ({item.hasCharger ? t('withCharger') : t('withoutCharger')})
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-4 self-end sm:self-auto shrink-0">
                <span className="text-sm font-bold font-mono text-gray-900 dark:text-[#daf1de]">
                  {formatCurrency(item.priceMinor)}
                </span>
                <button
                  type="button"
                  onClick={() => handleRemoveExistingItem(item.id)}
                  className="p-1 rounded-md text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer"
                  title={t('remove')}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}

          {/* Newly Added Items */}
          {newItems.map((dev, idx) => {
            const isLastNew = idx === newItems.length - 1;
            const itemIndex = activeExistingItems.length + idx + 1;
            const devOpt = deviceOptions.find((d) => d.id === dev.deviceTypeId) || deviceOptions[0];
            const deviceTotal = calculateDeviceItemPreviewPrice(dev.deviceTypeId, dev.hasCharger, false);

            return (
              <div
                key={dev.tempId}
                ref={isLastNew ? lastDeviceRef : null}
                className="py-3.5 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-blue-600 dark:text-blue-400">
                    {t('deviceNumberNew', { number: itemIndex })}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRemoveNewDeviceRow(idx)}
                    className="p-1 rounded-md text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer"
                    title={t('remove')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-[#8eb698] mb-1">
                      {t('deviceType')}
                    </label>
                    <select
                      value={dev.deviceTypeId ?? ''}
                      onChange={(e) => {
                        const selectedId = e.target.value;
                        setNewItems((prev) =>
                          prev.map((it, i) => (i === idx ? { ...it, deviceTypeId: selectedId } : it))
                        );
                      }}
                      className="w-full rounded-lg border border-gray-200 dark:border-[#14423b] bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] text-xs px-3 py-2 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    >
                      {deviceOptions.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.name} — ({formatCurrency(opt.priceMinor)})
                        </option>
                      ))}
                    </select>
                  </div>

                  {devOpt?.supportsCharger && (
                    <div className="flex flex-col justify-end">
                      <label className="block text-xs font-medium text-gray-600 dark:text-[#8eb698] mb-1">
                        {t('hasChargerOption')}
                      </label>
                      <div className="flex items-center bg-gray-100 dark:bg-[#041714] p-1 rounded-lg border border-gray-200/60 dark:border-[#14423b] self-start">
                        <button
                          type="button"
                          onClick={() => handleNewChargerToggle(idx, false)}
                          className={`px-3 py-1 rounded-md text-xs font-medium transition-all cursor-pointer ${
                            !dev.hasCharger
                              ? 'bg-white dark:bg-[#0c312b] text-gray-900 dark:text-[#daf1de] shadow-xs font-bold'
                              : 'text-gray-600 dark:text-[#8eb698]'
                          }`}
                        >
                          {t('withoutCharger')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleNewChargerToggle(idx, true)}
                          className={`px-3 py-1 rounded-md text-xs font-medium transition-all cursor-pointer ${
                            dev.hasCharger
                              ? 'bg-white dark:bg-[#0c312b] text-emerald-600 dark:text-[#7ae09e] shadow-xs font-bold'
                              : 'text-gray-600 dark:text-[#8eb698]'
                          }`}
                        >
                          {t('withCharger')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-end text-xs font-mono font-bold text-gray-900 dark:text-[#daf1de]">
                  {formatCurrency(deviceTotal)}
                </div>
              </div>
            );
          })}
        </div>

        <div className="pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleAddNewDeviceRow}
            className="text-xs h-8 px-3 gap-1.5 font-semibold text-emerald-700 dark:text-[#daf1de] border-emerald-200 dark:border-emerald-800/50 hover:bg-emerald-50 dark:hover:bg-[#0c312b] cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{t('addDevice')}</span>
          </Button>
        </div>
      </section>

      {/* SECTION 3: ORDER NOTES & FINAL SAVE */}
      <section className="space-y-4">
        <div>
          <label className="block text-xs font-bold text-gray-700 dark:text-[#8eb698] mb-1.5">
            {t('orderNotes')}
          </label>
          <Textarea
            placeholder={t('enterOrderNotes')}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
          />
        </div>

        <div className="pt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-600 dark:text-[#8eb698]">
              {t('orderTotal')}:
            </span>
            <span className="text-xl sm:text-2xl font-bold font-mono text-emerald-600 dark:text-[#7ae09e]">
              {formatCurrency(grandTotalMinor)}
            </span>
          </div>

          <Button
            variant="primary"
            size="md"
            onClick={handleSave}
            disabled={isSaving}
            className="gap-2 min-w-[140px] font-bold"
          >
            {isSaving ? (
              <span>{t('loading')}</span>
            ) : (
              <>
                <Check className="w-4 h-4" />
                <span>{t('saveChanges')}</span>
              </>
            )}
          </Button>
        </div>
      </section>

      {/* SENSITIVE OPERATION BIN MODAL */}
      <Modal
        isOpen={isBinModalOpen}
        onClose={() => {
          setIsBinModalOpen(false);
          setBinInput('');
          setBinError('');
        }}
        title={
          status === 'delivered'
            ? t('confirmDeliveryTitle') || 'تأكيد تسليم الطلب'
            : t('confirmCancellationTitle') || 'تأكيد إلغاء الطلب'
        }
      >
        <div className="space-y-4">
          <p className="text-xs text-gray-600 dark:text-[#8eb698]">
            {status === 'delivered'
              ? t('confirmDeliveryPrompt') || 'سيتم تسليم الطلب وتحصيل القيمة من رصيد العميل بناءً على السعر التاريخي للطلب. يرجى إدخال رمز BIN لتأكيد التسليم.'
              : t('confirmCancellationPrompt') || 'سيتم إلغاء الطلب وعكس القيمة المالية. يرجى إدخال رمز BIN لتأكيد الإلغاء.'}
          </p>

          <div className="p-3.5 rounded-xl bg-gray-50 dark:bg-[#061f1c] border border-gray-200 dark:border-[#14423b] flex items-center justify-between text-xs">
            <span className="font-semibold text-gray-700 dark:text-[#8eb698]">
              {t('orderTotalSnapshot') || 'سعر الطلب (النسخة التاريخية)'}:
            </span>
            <span className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">
              {formatCurrency(grandTotalMinor)}
            </span>
          </div>

          {binError && (
            <div className="p-3 rounded-lg bg-red-50 dark:bg-[#360d13] border border-red-200 dark:border-[#421419] text-red-700 dark:text-[#e07a7a] text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{binError}</span>
            </div>
          )}

          <div>
            <label htmlFor="edit-order-bin" className="block text-xs font-semibold text-gray-700 dark:text-[#daf1de] mb-1">
              {t('enterBinCode') || 'رمز BIN (4 أرقام)'}
            </label>
            <Input
              id="edit-order-bin"
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
                setIsBinModalOpen(false);
                setBinInput('');
                setBinError('');
              }}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={isSaving || binInput.trim().length < 4}
              onClick={() => executeSave(binInput.trim())}
            >
              {isSaving ? t('loading') : t('confirm') || 'تأكيد'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
