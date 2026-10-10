import React, { useState, useRef, useEffect } from 'react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Textarea } from '../ui/Textarea';
import { FormField } from '../ui/FormField';
import { Plus, Trash2, Search, AlertTriangle, Check } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { BusinessDayEntity } from '../../domain/models';
import { checkDebtLimit } from '../../domain/rules';
import {
  UICustomerItem,
  UIDeviceTypeOption,
  UIDayOrderDetail,
  getDeviceTypesOptions,
  getBusinessDay,
  searchCustomers,
  addNewCustomer,
  findExistingCustomerOrderOnDay,
  getNextOrderNumberForDay,
  calculateDeviceItemPreviewPrice,
  createOrderWithPhase5Engine,
  getCustomersList,
  getCurrentAdminAuthorizationContext,
} from './dayOrdersStore';

export interface AddOrderPageProps {
  dayId: string;
  onBack: () => void;
  onSuccess: (dayId: string) => void;
  onEditOrder?: (dayId: string, orderId: string) => void;
}

type UICustomerSearchResult = UICustomerItem & { isOverDebtLimit?: boolean };

const isAuthenticatedSuperAdmin = (): boolean => {
  try {
    return getCurrentAdminAuthorizationContext().requireAuth().isSuperAdmin;
  } catch {
    return false;
  }
};

export interface SelectedDeviceFormItem {
  tempId: string;
  deviceTypeId: string;
  hasCharger: boolean;
}

export const AddOrderPage: React.FC<AddOrderPageProps> = ({
  dayId,
  onBack,
  onSuccess,
  onEditOrder,
}) => {
  const { locale, t, formatDate, formatWeekday, formatCurrency } = useI18n();

  // Day Entity State to resolve business date when dayId is UUID
  const [dayEntity, setDayEntity] = useState<BusinessDayEntity | null>(null);

  // Device Options & Next Order Number State
  const [deviceOptions, setDeviceOptions] = useState<UIDeviceTypeOption[]>([]);
  const [nextOrderNumber, setNextOrderNumber] = useState<number>(1);

  // Customer Mode State: 'existing' vs 'new'
  const [customerMode, setCustomerMode] = useState<'existing' | 'new'>('existing');

  // Existing Customer Search State
  const isSuperAdmin = isAuthenticatedSuperAdmin();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UICustomerSearchResult[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<UICustomerSearchResult | UICustomerItem | null>(null);

  // New Customer Form State
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [newCustomerDebtLimit, setNewCustomerDebtLimit] = useState('20');

  // Same-Customer-Same-Day Conflict Alert State
  const [existingOrderForCustomer, setExistingOrderForCustomer] = useState<UIDayOrderDetail | null>(null);
  const [dismissedConflictAlert, setDismissedConflictAlert] = useState(false);

  // Devices Form State
  const [devices, setDevices] = useState<SelectedDeviceFormItem[]>([]);

  // Load initial Phase 5 options & day entity
  useEffect(() => {
    getDeviceTypesOptions(locale).then((opts) => {
      setDeviceOptions(opts);
      if (opts.length > 0) {
        setDevices((prev) =>
          prev.length === 0
            ? [
                {
                  tempId: `dev-form-1`,
                  deviceTypeId: opts[0].id,
                  hasCharger: false,
                },
              ]
            : prev
        );
      }
    });
    getNextOrderNumberForDay(dayId).then((num) => setNextOrderNumber(num));
    getBusinessDay(dayId).then((day) => {
      if (day) setDayEntity(day);
    });
  }, [dayId, locale]);

  // Extract valid ISO date string from dayEntity or dayId
  const rawDateStr = dayEntity?.businessDate || (dayId.startsWith('day-') ? dayId.replace('day-', '') : dayId);
  const isValidIsoDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDateStr);
  const weekday = isValidIsoDate ? formatWeekday(rawDateStr) : '';
  const formattedDate = isValidIsoDate ? formatDate(rawDateStr) : rawDateStr;

  // Order Note & Form State
  const [note, setNote] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Ref for scrolling newest device into view
  const lastDeviceRef = useRef<HTMLDivElement | null>(null);

  // Perform targeted customer search via Phase 5 repository context
  useEffect(() => {
    let active = true;
    if (customerMode === 'existing' && searchQuery.trim()) {
      const loadResults = async () => {
        const results = await searchCustomers(searchQuery);
        if (!isSuperAdmin) {
          if (active) setSearchResults(results);
          return;
        }

        // The existing customer-list path computes each matching customer's
        // effective balance in one batch, avoiding one detail lookup per result.
        const customersWithBalances = await getCustomersList(searchQuery);
        const balanceById = new Map(customersWithBalances.map((customer) => [customer.id, customer.currentBalanceMinor]));
        const annotatedResults: UICustomerSearchResult[] = results.map((customer) => {
          const balance = balanceById.get(customer.id);
          return {
            ...customer,
            isOverDebtLimit: balance !== undefined
              ? !checkDebtLimit(balance, customer.debtLimitMinor, false)
              : false,
          };
        });
        if (active) setSearchResults(annotatedResults);
      };
      void loadResults();
    } else {
      setSearchResults([]);
    }
    return () => { active = false; };
  }, [searchQuery, customerMode, isSuperAdmin]);

  // Check for same-customer-same-day order when customer is selected
  const handleSelectCustomer = async (customer: UICustomerItem) => {
    setSelectedCustomer(customer);
    setSearchQuery('');
    setSearchResults([]);
    setDismissedConflictAlert(false);

    // Check if customer already has an order today using Phase 5 store
    const existingOrd = await findExistingCustomerOrderOnDay(dayId, customer.id);
    if (existingOrd) {
      setExistingOrderForCustomer(existingOrd);
    } else {
      setExistingOrderForCustomer(null);
    }
  };

  // Handle New Customer Creation via Phase 5 Engine
  const handleCreateNewCustomer = async () => {
    setErrorMessage('');
    if (!newCustomerName.trim()) {
      setErrorMessage(t('customerNameRequired'));
      return;
    }

    const debtLimitNum = parseFloat(newCustomerDebtLimit);
    const debtLimitMinor = isNaN(debtLimitNum) ? -2000 : -Math.abs(debtLimitNum * 100);

    try {
      const created = await addNewCustomer(
        newCustomerName.trim(),
        newCustomerPhone.trim(),
        debtLimitMinor
      );
      setSelectedCustomer(created);
      setNewCustomerName('');
      setNewCustomerPhone('');
      setNewCustomerDebtLimit('20');
      setExistingOrderForCustomer(null);
    } catch (err: any) {
      setErrorMessage(err.message || t('errorOccurred'));
    }
  };

  // Add another device row
  const handleAddDeviceRow = () => {
    const defaultTypeId = deviceOptions.length > 0 ? deviceOptions[0].id : '';
    const newRow: SelectedDeviceFormItem = {
      tempId: `dev-form-${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      deviceTypeId: defaultTypeId,
      hasCharger: false,
    };
    setDevices((prev) => [...prev, newRow]);

    setTimeout(() => {
      if (lastDeviceRef.current) {
        lastDeviceRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 100);
  };

  // Remove a device row
  const handleRemoveDeviceRow = (index: number) => {
    if (devices.length <= 1) return;
    setDevices((prev) => prev.filter((_, i) => i !== index));
  };

  // Change device type selection
  const handleDeviceTypeChange = (index: number, deviceTypeId: string) => {
    setDevices((prev) =>
      prev.map((item, i) => (i === index ? { ...item, deviceTypeId } : item))
    );
  };

  // Toggle charger checkbox
  const handleChargerToggle = (index: number, hasCharger: boolean) => {
    setDevices((prev) =>
      prev.map((item, i) => (i === index ? { ...item, hasCharger } : item))
    );
  };

  // Compute live total value in minor units (cents / piastres)
  const liveTotalMinor = devices.reduce((sum, item) => {
    const calculated = calculateDeviceItemPreviewPrice(
      item.deviceTypeId,
      item.hasCharger,
      selectedCustomer?.chargerFeeExempt || false
    );
    return sum + calculated;
  }, 0);

  // Submit and create order using strict Phase 5 transaction engine
  const handleSaveOrder = async () => {
    setErrorMessage('');
    if (!selectedCustomer) {
      setErrorMessage(
        locale === 'ar'
          ? 'يرجى اختيار العميل أو إضافته أولاً لإنشاء الطلب'
          : 'Please select or add a customer first'
      );
      return;
    }

    if (devices.length === 0) {
      setErrorMessage(t('cannotRemoveAllDevices'));
      return;
    }

    setIsSaving(true);
    const orderItems = devices.map((d) => ({
      deviceTypeId: d.deviceTypeId,
      hasCharger: d.hasCharger,
    }));

    const result = await createOrderWithPhase5Engine(
      dayId,
      selectedCustomer.id,
      orderItems,
      note.trim() ? note.trim() : undefined
    );

    setIsSaving(false);
    if (result.success) {
      onSuccess(dayId);
    } else {
      setErrorMessage(result.error || t('errorOccurred'));
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
    <div className="max-w-3xl mx-auto py-6 px-4 sm:px-6 space-y-6 text-gray-900 dark:text-[#daf1de]">
      {/* Header: Title & Date on Main Side, Order Number on Start Side */}
      <div className="flex items-center justify-between pb-4 border-b border-gray-200 dark:border-[#14423b] gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-[#daf1de]">
            {t('addOrderTitle')}
          </h1>
          <p className="text-sm font-medium text-gray-500 dark:text-[#8eb698]">
            {weekday ? `${weekday}، ${formattedDate}` : formattedDate}
          </p>
        </div>

        <span className="text-base font-mono font-bold text-blue-700 dark:text-[#daf1de] bg-blue-50 dark:bg-[#0c312b] border border-blue-200 dark:border-[#14423b] px-3 py-1 rounded-lg shrink-0">
          #{nextOrderNumber}
        </span>
      </div>

      {/* Global Error Banner */}
      {errorMessage && (
        <div className="p-3.5 rounded-xl bg-red-50 dark:bg-[#360d13] border border-red-200 dark:border-[#421419] text-red-700 dark:text-[#e07a7a] text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* SECTION 1: CUSTOMER SELECTION */}
      <div className="bg-white dark:bg-[#082622] rounded-xl border border-gray-200 dark:border-[#14423b] p-4 sm:p-5 space-y-4">
        <h2 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">{t('customerInfo')}</h2>

        {/* Customer Segmented Choice: Existing vs New */}
        {!selectedCustomer && (
          <div className="grid grid-cols-2 gap-2 p-1 bg-gray-100 dark:bg-[#061f1c] rounded-lg">
            <button
              type="button"
              onClick={() => {
                setCustomerMode('existing');
                setErrorMessage('');
              }}
              className={`py-2 px-3 rounded-md text-xs font-bold transition-all cursor-pointer ${
                customerMode === 'existing'
                  ? 'bg-white dark:bg-[#0c312b] text-gray-900 dark:text-[#daf1de] shadow-xs'
                  : 'text-gray-600 dark:text-[#8eb698] hover:text-gray-900 dark:hover:text-[#daf1de]'
              }`}
            >
              {t('existingCustomer')}
            </button>

            <button
              type="button"
              onClick={() => {
                setCustomerMode('new');
                setErrorMessage('');
              }}
              className={`py-2 px-3 rounded-md text-xs font-bold transition-all cursor-pointer ${
                customerMode === 'new'
                  ? 'bg-white dark:bg-[#0c312b] text-gray-900 dark:text-[#daf1de] shadow-xs'
                  : 'text-gray-600 dark:text-[#8eb698] hover:text-gray-900 dark:hover:text-[#daf1de]'
              }`}
            >
              {t('newCustomer')}
            </button>
          </div>
        )}

        {/* SELECTED CUSTOMER CARD DISPLAY */}
        {selectedCustomer ? (
          <div className="p-3.5 rounded-lg bg-emerald-50/60 dark:bg-[#061f1c] border border-emerald-200/80 dark:border-[#14423b] flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <span className={`text-xs font-bold ${isSuperAdmin && 'isOverDebtLimit' in selectedCustomer && selectedCustomer.isOverDebtLimit ? 'text-red-700 dark:text-red-400' : 'text-emerald-800 dark:text-[#daf1de]'}`}>
                  {selectedCustomer.name}
                </span>
                <span className="text-2xs font-mono font-bold bg-emerald-100 dark:bg-[#0c312b] text-emerald-800 dark:text-[#a9d4b4] px-1.5 py-0.2 rounded border border-transparent dark:border-[#14423b]">
                  {selectedCustomer.code}
                </span>
              </div>
              <p className="text-2xs text-gray-500 dark:text-[#8eb698] font-mono dir-ltr text-start">
                {selectedCustomer.phone || t('noPhone')}
              </p>
              {isSuperAdmin && 'isOverDebtLimit' in selectedCustomer && selectedCustomer.isOverDebtLimit && (
                <p className="mt-1 inline-flex items-center gap-1.5 text-[11px] font-semibold text-red-700 dark:text-red-400" role="status">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  {locale === 'ar' ? 'تنبيه: هذا العميل تجاوز حدّ المديونية المسموح.' : 'Warning: this customer is over the debt limit.'}
                </p>
              )}
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSelectedCustomer(null);
                setExistingOrderForCustomer(null);
                setDismissedConflictAlert(false);
              }}
              className="text-xs h-7 px-2.5"
            >
              {t('changeCustomer')}
            </Button>
          </div>
        ) : customerMode === 'existing' ? (
          /* EXISTING CUSTOMER SEARCH INPUT & RESULTS */
          <div className="space-y-3">
            <div className="relative">
              <Input
                type="text"
                placeholder={t('searchCustomerPrompt')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pe-9"
              />
              <Search className="w-4 h-4 text-gray-400 absolute pe-3 top-1/2 -translate-y-1/2 end-2 pointer-events-none" />
            </div>

            {searchResults.length > 0 && (
              <div className="border border-gray-200 dark:border-[#14423b] rounded-lg divide-y divide-gray-100 dark:divide-[#0f3b34] max-h-56 overflow-y-auto bg-white dark:bg-[#061f1c] shadow-sm">
                {searchResults.map((cust) => (
                  <button
                    key={cust.id}
                    type="button"
                    onClick={() => handleSelectCustomer(cust)}
                    className="w-full text-start p-3 hover:bg-gray-50 dark:hover:bg-[#0b312b] transition-colors flex items-center justify-between cursor-pointer"
                  >
                    <div className="space-y-0.5">
                      <p className={`text-xs font-bold ${isSuperAdmin && cust.isOverDebtLimit ? 'text-red-700 dark:text-red-400' : 'text-gray-900 dark:text-[#daf1de]'}`}>{cust.name}</p>
                      {isSuperAdmin && cust.isOverDebtLimit && (
                        <p className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-700 dark:text-red-400" role="status">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          {locale === 'ar' ? 'متجاوز حدّ المديونية' : 'Over debt limit'}
                        </p>
                      )}
                      <p className="text-2xs font-mono text-gray-500 dark:text-[#8eb698] dir-ltr text-start">{cust.phone || t('noPhone')}</p>
                    </div>
                    <span className="text-2xs font-mono bg-blue-50 dark:bg-[#0c312b] text-blue-700 dark:text-[#a9d4b4] border border-blue-200/80 dark:border-[#14423b] px-2 py-0.5 rounded font-bold">
                      {cust.code}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          /* NEW CUSTOMER FORM */
          <div className="space-y-3 pt-1">
            <Input
              label={`${t('customerName')} *`}
              placeholder={t('enterCustomerName')}
              value={newCustomerName}
              onChange={(e) => setNewCustomerName(e.target.value)}
            />
            <Input
              label={t('phoneNumber')}
              placeholder={t('enterPhoneNumber')}
              value={newCustomerPhone}
              onChange={(e) => setNewCustomerPhone(e.target.value)}
            />
            <Input
              label={`${t('debtLimit')} *`}
              placeholder="20 ₪"
              value={newCustomerDebtLimit}
              onChange={(e) => setNewCustomerDebtLimit(e.target.value)}
            />
            <Button
              variant="primary"
              size="sm"
              onClick={handleCreateNewCustomer}
              className="w-full mt-2"
            >
              {t('saveCustomer')}
            </Button>
          </div>
        )}

        {/* SAME-CUSTOMER SAME-DAY ALERT PROMPT */}
        {selectedCustomer && existingOrderForCustomer && !dismissedConflictAlert && (
          <div className="p-4 rounded-xl bg-amber-50 dark:bg-[#36270d] border border-amber-200 dark:border-[#423314] space-y-3">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-[#e0be7a] shrink-0 mt-0.5" />
              <div className="space-y-0.5 text-xs">
                <p className="font-bold text-amber-800 dark:text-[#daf1de]">
                  {t('sameCustomerSameDayWarning', { number: existingOrderForCustomer.orderNumber })}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  onEditOrder && onEditOrder(dayId, existingOrderForCustomer.id)
                }
                className="text-xs h-8 border-amber-300 dark:border-[#423314] text-amber-800 dark:text-[#e0be7a] bg-amber-100/60 dark:bg-[#0c312b]"
              >
                {t('viewExistingOrder')} #{existingOrderForCustomer.orderNumber}
              </Button>

              <Button
                variant="primary"
                size="sm"
                onClick={() => setDismissedConflictAlert(true)}
                className="text-xs h-8"
              >
                {t('continueAddingOrder')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* SECTION 2: DEVICES FORM */}
      <div className="bg-white dark:bg-[#082622] rounded-xl border border-gray-200 dark:border-[#14423b] p-4 sm:p-5 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">
            {t('orderNumberPrefix', { number: nextOrderNumber })}
          </h2>
        </div>

          <div className="space-y-4">
            {devices.map((dev, idx) => {
              const isLast = idx === devices.length - 1;
              const devOpt = deviceOptions.find((d) => d.id === dev.deviceTypeId) || deviceOptions[0];
              const deviceTotal = calculateDeviceItemPreviewPrice(
                dev.deviceTypeId,
                dev.hasCharger,
                selectedCustomer?.chargerFeeExempt || false
              );

              return (
                <div
                  key={dev.tempId}
                  ref={isLast ? lastDeviceRef : null}
                  className="p-3.5 rounded-lg bg-gray-50/80 dark:bg-[#061f1c] border border-gray-200/80 dark:border-[#14423b] space-y-3"
                >
                  <div className="flex items-center justify-between pb-2 border-b border-gray-200/60 dark:border-[#14423b]">
                    <span className="text-xs font-bold text-gray-700 dark:text-[#8eb698]">
                      {t('deviceNumberPlain', { number: idx + 1 })}
                    </span>

                    {devices.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveDeviceRow(idx)}
                        className="text-red-600 dark:text-[#e07a7a] hover:text-red-800 dark:hover:text-[#f87171] text-xs flex items-center gap-1 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>{t('remove')}</span>
                      </button>
                    )}
                  </div>

                  {/* Device Type Select */}
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-gray-600 dark:text-[#8eb698]">
                      {t('deviceType')}
                    </label>
                    <select
                      value={dev.deviceTypeId}
                      onChange={(e) => handleDeviceTypeChange(idx, e.target.value)}
                      className="w-full rounded-md border border-gray-300 dark:border-[#14423b] bg-white dark:bg-[#082622] text-gray-900 dark:text-[#daf1de] text-xs px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[#8eb698]"
                    >
                      {deviceOptions.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.name} — ({formatCurrency(opt.priceMinor)})
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Charger Option Toggle */}
                  {devOpt?.supportsCharger && (
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-xs text-gray-600 dark:text-[#8eb698]">
                        {t('hasChargerOption')}:
                      </span>
                      <div className="flex items-center gap-1 bg-gray-200/60 dark:bg-[#082622] p-0.5 rounded-lg border border-transparent dark:border-[#14423b]">
                        <button
                          type="button"
                          onClick={() => handleChargerToggle(idx, false)}
                          className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                            !dev.hasCharger
                              ? 'bg-white dark:bg-[#0c312b] text-gray-900 dark:text-[#daf1de] shadow-xs font-bold'
                              : 'text-gray-600 dark:text-[#8eb698]'
                          }`}
                        >
                          {t('withoutCharger')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleChargerToggle(idx, true)}
                          className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
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

                  {/* Read-Only Device Row Price */}
                  <div className="flex items-center justify-end pt-1 text-xs">
                    <span className="font-bold text-base text-gray-900 dark:text-[#daf1de]">
                      {formatCurrency(deviceTotal)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Add Device Button */}
          <div className="pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={handleAddDeviceRow}
              className="w-full sm:w-auto gap-1.5 text-xs h-9"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('addDevice')}</span>
            </Button>
          </div>

          {/* SECTION 3: ORDER NOTE */}
          <div className="pt-2">
            <FormField label={t('orderNotes')}>
              <Textarea
                placeholder={t('enterOrderNotes')}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
              />
            </FormField>
          </div>

          {/* SECTION 4: LIVE ORDER TOTAL & SAVE BUTTON */}
          <div className="pt-4 border-t border-gray-200 dark:border-[#14423b] space-y-4">
            <div className="flex items-center justify-between bg-gray-100/80 dark:bg-[#061f1c] p-3.5 rounded-xl border border-gray-200/80 dark:border-[#14423b]">
              <span className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">
                {t('orderTotal')}:
              </span>
              <span className="text-lg font-bold text-gray-900 dark:text-[#daf1de]">
                {formatCurrency(liveTotalMinor)}
              </span>
            </div>

            <div className="flex items-center justify-end gap-3">
              <Button
                variant="primary"
                size="md"
                onClick={handleSaveOrder}
                disabled={isSaving}
                className="gap-2 min-w-[120px] w-full sm:w-auto"
              >
                {isSaving ? (
                  <span>{t('loading')}</span>
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    <span>{t('saveAndCreateOrder')}</span>
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
    </div>
  );
};
