import React, { useState, useEffect } from 'react';
import { useI18n } from '../../i18n/i18nContext';
import {
  UIDeviceTypeItem,
  getAllDeviceTypes,
  addDeviceTypeWithPhase5,
  updateDeviceTypeWithPhase5,
  reorderDeviceTypesWithPhase5,
  deleteDeviceTypeWithPhase5,
  getDeviceDisplayName,
} from './dayOrdersStore';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import {
  Plus,
  Edit2,
  Trash2,
  ArrowUp,
  ArrowDown,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Smartphone,
} from 'lucide-react';

export const DeviceTypesPage: React.FC = () => {
  const { t, locale, formatCurrency } = useI18n();

  const [deviceTypes, setDeviceTypes] = useState<UIDeviceTypeItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingDevice, setEditingDevice] = useState<UIDeviceTypeItem | null>(null);

  // Delete Confirmation Modal State
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [deviceToDelete, setDeviceToDelete] = useState<UIDeviceTypeItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Form Fields
  const [formNameAr, setFormNameAr] = useState('');
  const [formNameEn, setFormNameEn] = useState('');
  const [formPriceNIS, setFormPriceNIS] = useState('');
  const [formChargerFeeEnabled, setFormChargerFeeEnabled] = useState(true);
  const [formIsActive, setFormIsActive] = useState(true);
  const [formSortOrder, setFormSortOrder] = useState<number>(0);
  const [formError, setFormError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load Device Types
  const loadDeviceTypes = async () => {
    setIsLoading(true);
    setErrorMessage('');
    try {
      const items = await getAllDeviceTypes();
      setDeviceTypes(items);
    } catch (err: any) {
      setErrorMessage(err.message || t('errorOccurred'));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadDeviceTypes();
  }, []);

  // Open Modal for Create
  const handleOpenAddModal = () => {
    setEditingDevice(null);
    setFormNameAr('');
    setFormNameEn('');
    setFormPriceNIS('');
    setFormChargerFeeEnabled(true);
    setFormIsActive(true);
    const maxOrder = deviceTypes.reduce((max, d) => Math.max(max, d.sortOrder || 0), 0);
    setFormSortOrder(maxOrder + 1);
    setFormError('');
    setIsModalOpen(true);
  };

  // Open Modal for Edit
  const handleOpenEditModal = (dev: UIDeviceTypeItem) => {
    setEditingDevice(dev);
    setFormNameAr(dev.nameAr || dev.name);
    setFormNameEn(dev.nameEn || '');
    setFormPriceNIS((dev.basePriceMinor / 100).toString());
    setFormChargerFeeEnabled(dev.chargerFeeEnabled ?? true);
    setFormIsActive(dev.isActive);
    setFormSortOrder(dev.sortOrder ?? 0);
    setFormError('');
    setIsModalOpen(true);
  };

  // Close Modal
  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingDevice(null);
    setFormError('');
  };

  // Submit Modal Form (Add or Edit)
  const handleSubmitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    const trimmedAr = formNameAr.trim();
    const trimmedEn = formNameEn.trim();
    if (!trimmedAr) {
      setFormError(t('deviceTypeNameRequired'));
      return;
    }

    const priceNum = parseFloat(formPriceNIS);
    if (isNaN(priceNum) || priceNum < 0) {
      setFormError(t('devicePriceInvalid'));
      return;
    }

    const priceMinor = Math.round(priceNum * 100);
    setIsSubmitting(true);

    try {
      if (editingDevice) {
        // Edit Existing Device Type
        const res = await updateDeviceTypeWithPhase5(editingDevice.id, {
          name: trimmedAr,
          nameAr: trimmedAr,
          nameEn: trimmedEn || undefined,
          priceMinor,
          chargerFeeEnabled: formChargerFeeEnabled,
          isActive: formIsActive,
          sortOrder: formSortOrder,
        });

        if (!res.success) {
          setFormError(res.error || t('errorOccurred'));
          setIsSubmitting(false);
          return;
        }

        setSuccessMessage(t('deviceTypeUpdatedSuccess'));
      } else {
        // Add New Device Type
        const res = await addDeviceTypeWithPhase5(
          trimmedAr,
          priceMinor,
          formIsActive,
          formSortOrder,
          formChargerFeeEnabled,
          trimmedEn || undefined,
          trimmedAr
        );

        if (!res.success) {
          setFormError(res.error || t('errorOccurred'));
          setIsSubmitting(false);
          return;
        }

        setSuccessMessage(t('deviceTypeCreatedSuccess'));
      }

      setIsModalOpen(false);
      await loadDeviceTypes();
      setTimeout(() => setSuccessMessage(''), 4000);
    } catch (err: any) {
      setFormError(err.message || t('errorOccurred'));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Toggle Active/Inactive Quick Action
  const handleToggleActive = async (dev: UIDeviceTypeItem) => {
    try {
      const nextActive = !dev.isActive;
      const res = await updateDeviceTypeWithPhase5(dev.id, {
        isActive: nextActive,
      });

      if (res.success) {
        setSuccessMessage(nextActive ? t('deviceTypeReactivated') : t('deviceTypeDeactivated'));
        await loadDeviceTypes();
        setTimeout(() => setSuccessMessage(''), 3000);
      } else {
        setErrorMessage(res.error || t('errorOccurred'));
      }
    } catch (err: any) {
      setErrorMessage(err.message || t('errorOccurred'));
    }
  };

  // Reorder Item Up or Down
  const handleMoveOrder = async (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= deviceTypes.length) return;

    const listCopy = [...deviceTypes];
    const currentItem = listCopy[index];
    const targetItem = listCopy[targetIndex];

    // Swap sort orders
    const currentOrder = currentItem.sortOrder;
    const targetOrder = targetItem.sortOrder;

    currentItem.sortOrder = targetOrder;
    targetItem.sortOrder = currentOrder;

    listCopy[index] = targetItem;
    listCopy[targetIndex] = currentItem;

    setDeviceTypes(listCopy);

    const ordering = [
      { id: currentItem.id, sortOrder: currentItem.sortOrder },
      { id: targetItem.id, sortOrder: targetItem.sortOrder },
    ];

    await reorderDeviceTypesWithPhase5(ordering);
  };

  // Open Delete Confirmation Dialog
  const handleOpenDeleteDialog = (dev: UIDeviceTypeItem) => {
    if (dev.hasHistoricalOrders) {
      setErrorMessage(t('deleteDeviceTypeInUseError'));
      return;
    }
    setDeviceToDelete(dev);
    setIsDeleteDialogOpen(true);
  };

  // Close Delete Confirmation Dialog
  const handleCloseDeleteDialog = () => {
    if (isDeleting) return;
    setIsDeleteDialogOpen(false);
    setDeviceToDelete(null);
  };

  // Confirm and Execute Hard Delete
  const handleConfirmDelete = async () => {
    if (!deviceToDelete) return;

    if (deviceToDelete.hasHistoricalOrders) {
      setErrorMessage(t('deleteDeviceTypeInUseError'));
      setIsDeleteDialogOpen(false);
      setDeviceToDelete(null);
      return;
    }

    setIsDeleting(true);
    setErrorMessage('');

    try {
      const res = await deleteDeviceTypeWithPhase5(deviceToDelete.id);
      if (!res.success) {
        setErrorMessage(res.error || t('errorOccurred'));
      } else {
        setSuccessMessage(t('deleteDeviceTypeSuccess'));
        setIsDeleteDialogOpen(false);
        setDeviceToDelete(null);
        await loadDeviceTypes();
        setTimeout(() => setSuccessMessage(''), 3000);
      }
    } catch (err: any) {
      setErrorMessage(err.message || t('errorOccurred'));
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-16 px-4 sm:px-6">
      {/* 1. Header Bar: Title and Primary Action */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-gray-200 dark:border-[#14423b] pb-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-[#daf1de] tracking-tight">
            {t('deviceTypesTitle')}
          </h1>
          <p className="text-xs text-gray-500 dark:text-[#8eb698] mt-0.5">
            {t('deviceTypesSubtitle')}
          </p>
        </div>

        <Button
          type="button"
          onClick={handleOpenAddModal}
          className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold px-4 py-2 flex items-center justify-center gap-1.5 cursor-pointer shadow-xs self-start sm:self-auto"
        >
          <Plus className="w-4 h-4 shrink-0" />
          <span>{t('addDeviceType')}</span>
        </Button>
      </div>

      {/* 2. Notifications & Alerts */}
      {successMessage && (
        <div className="p-3 bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800/40 rounded-xl text-xs text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      {errorMessage && (
        <div className="p-3 bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800/40 rounded-xl text-xs text-rose-800 dark:text-rose-300 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* 3. Device Types List */}
      <div className="space-y-2">
        <div className="px-1 text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-[#8eb698]">
          {locale === 'ar' ? 'أنواع الأجهزة المعتمدة' : 'Registered Device Types'} ({deviceTypes.length})
        </div>

        <div className="bg-white dark:bg-[#061f1c] rounded-2xl border border-gray-200/80 dark:border-[#123832] divide-y divide-gray-100 dark:divide-[#0f302b] shadow-2xs overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-xs text-gray-500 dark:text-[#8eb698]">
              {t('loading')}
            </div>
          ) : deviceTypes.length === 0 ? (
            <div className="p-8 text-center space-y-3">
              <Smartphone className="w-8 h-8 text-gray-400 dark:text-[#8eb698]/50 mx-auto" />
              <p className="text-xs text-gray-500 dark:text-[#8eb698]">
                {t('noDeviceTypes')}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleOpenAddModal}
                className="text-xs"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{t('addDeviceType')}</span>
              </Button>
            </div>
          ) : (
            deviceTypes.map((dev, index) => {
              const displayName = getDeviceDisplayName(dev, locale);

              return (
                <div
                  key={dev.id}
                  className={`p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-colors ${
                    dev.isActive
                      ? 'hover:bg-gray-50/50 dark:hover:bg-[#0b2924]'
                      : 'bg-gray-50/40 dark:bg-[#041714]/40 opacity-75'
                  }`}
                >
                  {/* Left/Start side: Position, Name, Historical info */}
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Display Order Controls */}
                    <div className="flex items-center gap-0.5 shrink-0 bg-gray-50 dark:bg-[#041714] p-1 rounded-lg border border-gray-200/80 dark:border-[#123832]">
                      <button
                        type="button"
                        onClick={() => handleMoveOrder(index, -1)}
                        disabled={index === 0}
                        title={t('moveUp')}
                        className="p-1 text-gray-400 hover:text-gray-700 dark:hover:text-[#daf1de] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <span className="text-[11px] font-mono text-gray-500 dark:text-[#8eb698] px-1 min-w-[1.2rem] text-center">
                        {dev.sortOrder ?? index + 1}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleMoveOrder(index, 1)}
                        disabled={index === deviceTypes.length - 1}
                        title={t('moveDown')}
                        className="p-1 text-gray-400 hover:text-gray-700 dark:hover:text-[#daf1de] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* Name & Indicators */}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-gray-900 dark:text-[#daf1de] truncate">
                          {displayName}
                        </span>
                        {/* Active/Inactive Badge */}
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 border ${
                            dev.isActive
                              ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border-emerald-200/60 dark:border-emerald-800/40'
                              : 'bg-gray-100 dark:bg-gray-800/60 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700'
                          }`}
                        >
                          {dev.isActive ? t('activeState') : t('inactiveState')}
                        </span>
                      </div>

                      {/* Bilingual Subtitle if alternative name exists */}
                      {locale === 'ar' && dev.nameEn && (
                        <span className="text-[11px] text-gray-500 dark:text-[#8eb698] font-sans block">
                          {dev.nameEn}
                        </span>
                      )}
                      {locale === 'en' && dev.nameAr && dev.nameAr !== dev.nameEn && (
                        <span className="text-[11px] text-gray-500 dark:text-[#8eb698] block">
                          {dev.nameAr}
                        </span>
                      )}

                      {dev.hasHistoricalOrders && (
                        <span className="text-[10px] text-gray-400 dark:text-[#8eb698]/70 block mt-0.5">
                          {locale === 'en' ? 'Used in past orders' : 'مستخدم في طلبات سابقة'}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Right/End side: Price & Action Buttons */}
                  <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-gray-100 dark:border-[#0f302b]">
                    {/* Service Price */}
                    <div className="text-end">
                      <span className="text-[10px] text-gray-500 dark:text-[#8eb698] block">
                        {t('deviceServicePrice')}
                      </span>
                      <span className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">
                        {formatCurrency(dev.basePriceMinor)}
                      </span>
                    </div>

                    {/* Quick Active Toggle */}
                    <button
                      type="button"
                      onClick={() => handleToggleActive(dev)}
                      className={`text-xs px-2.5 py-1 rounded-lg border font-medium transition-all cursor-pointer ${
                        dev.isActive
                          ? 'border-gray-200/80 dark:border-[#123832] text-gray-600 dark:text-[#8eb698] hover:bg-gray-100 dark:hover:bg-[#0c312b]'
                          : 'border-emerald-500/60 text-emerald-700 dark:text-emerald-400 bg-emerald-50/50 dark:bg-emerald-950/40 hover:bg-emerald-100/60'
                      }`}
                      title={dev.isActive ? t('deactivate') : t('activate')}
                    >
                      {dev.isActive ? t('deactivate') : t('activate')}
                    </button>

                    {/* Edit Action Button */}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleOpenEditModal(dev)}
                      className="text-xs h-7 px-2.5 flex items-center gap-1 cursor-pointer"
                      title={t('edit')}
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                      <span>{t('edit')}</span>
                    </Button>

                    {/* Hard Delete Action Button */}
                    <button
                      type="button"
                      onClick={() => handleOpenDeleteDialog(dev)}
                      className={`text-xs h-7 px-2.5 rounded-lg border font-medium transition-all flex items-center gap-1 cursor-pointer ${
                        dev.hasHistoricalOrders
                          ? 'border-gray-200 dark:border-gray-800 text-gray-400 dark:text-gray-600 bg-gray-50/40 dark:bg-gray-900/20 cursor-not-allowed opacity-50'
                          : 'border-rose-200 dark:border-rose-900/40 text-rose-600 dark:text-rose-400 bg-rose-50/30 dark:bg-rose-950/30 hover:bg-rose-100/70 dark:hover:bg-rose-900/50 hover:border-rose-300'
                      }`}
                      title={dev.hasHistoricalOrders ? t('deleteDeviceTypeInUseError') : t('deleteDeviceType')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>{t('deleteDeviceType')}</span>
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 4. Add / Edit Device Type Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        title={editingDevice ? t('editDeviceType') : t('addNewDeviceType')}
        className="max-w-md bg-white dark:bg-[#082622] border-gray-200 dark:border-[#14423b]"
      >
        <form onSubmit={handleSubmitForm} className="space-y-4">
          {formError && (
            <div className="p-3 bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800/40 rounded-xl text-xs text-rose-800 dark:text-rose-300 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          {editingDevice && editingDevice.hasHistoricalOrders && (
            <div className="p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200/80 dark:border-amber-800/40 rounded-xl text-xs text-amber-800 dark:text-amber-300">
              {t('deviceTypeUsedWarning')}
            </div>
          )}

          {/* Bilingual Device Name Fields */}
          <div className="space-y-3">
            {/* Arabic Name (Required) */}
            <div>
              <label className="block text-xs font-semibold text-gray-700 dark:text-[#daf1de] mb-1">
                {t('deviceTypeNameAr') || 'اسم نوع الجهاز (بالعربية)'} <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                dir="rtl"
                value={formNameAr}
                onChange={(e) => setFormNameAr(e.target.value)}
                placeholder={t('enterDeviceTypeNameAr') || 'أدخل اسم الجهاز بالعربية (مثال: هاتف شاومي)'}
                required
                className="w-full px-3 py-2 text-xs rounded-lg border border-gray-200 dark:border-[#14423b] bg-white dark:bg-[#06201c] text-gray-900 dark:text-[#daf1de] placeholder-gray-400 dark:placeholder-gray-600 focus:outline-hidden focus:border-emerald-500 transition-colors"
              />
            </div>

            {/* English Name (Optional) */}
            <div>
              <label className="block text-xs font-semibold text-gray-700 dark:text-[#daf1de] mb-1">
                {t('deviceTypeNameEn') || 'اسم نوع الجهاز (بالإنجليزية)'}
                <span className="text-[11px] font-normal text-gray-500 dark:text-[#8eb698] ms-1">({locale === 'ar' ? 'اختياري' : 'Optional'})</span>
              </label>
              <input
                type="text"
                dir="ltr"
                value={formNameEn}
                onChange={(e) => setFormNameEn(e.target.value)}
                placeholder={t('enterDeviceTypeNameEn') || 'Enter English name (e.g. Xiaomi Phone)'}
                className="w-full px-3 py-2 text-xs rounded-lg border border-gray-200 dark:border-[#14423b] bg-white dark:bg-[#06201c] text-gray-900 dark:text-[#daf1de] placeholder-gray-400 dark:placeholder-gray-600 focus:outline-hidden focus:border-emerald-500 transition-colors"
              />
              <p className="text-[10px] text-gray-500 dark:text-[#8eb698] mt-1">
                {t('deviceTypeNameHelp')}
              </p>
            </div>
          </div>

          {/* Service Price Field */}
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-[#daf1de] mb-1">
              {t('deviceServicePrice')} (NIS) <span className="text-rose-500">*</span>
            </label>
            <input
              type="number"
              step="0.5"
              min="0"
              value={formPriceNIS}
              onChange={(e) => setFormPriceNIS(e.target.value)}
              placeholder={t('enterDeviceServicePrice')}
              required
              className="w-full px-3 py-2 text-xs rounded-lg border border-gray-200 dark:border-[#14423b] bg-white dark:bg-[#06201c] text-gray-900 dark:text-[#daf1de] placeholder-gray-400 dark:placeholder-gray-600 focus:outline-hidden focus:border-emerald-500 transition-colors"
            />
          </div>

          {/* Display Order Field */}
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-[#daf1de] mb-1">
              {t('displayOrder')}
            </label>
            <input
              type="number"
              min="0"
              value={formSortOrder}
              onChange={(e) => setFormSortOrder(parseInt(e.target.value, 10) || 0)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-gray-200 dark:border-[#14423b] bg-white dark:bg-[#06201c] text-gray-900 dark:text-[#daf1de] placeholder-gray-400 dark:placeholder-gray-600 focus:outline-hidden focus:border-emerald-500 transition-colors"
            />
          </div>

          {/* Charger Fee Applicable Toggle */}
          <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-[#061f1c] border border-gray-200 dark:border-[#14423b]">
            <div className="space-y-0.5">
              <span className="text-xs font-bold text-gray-900 dark:text-[#daf1de]">
                {t('chargerFeeEnabled') || 'تطبيق رسوم الشاحن'}
              </span>
              <p className="text-[11px] text-gray-500 dark:text-[#8eb698]">
                {t('chargerFeeEnabledHelp') || 'تطبيق رسوم الشاحن عند اختيار "بدون شاحن"'}
              </p>
            </div>
            <input
              type="checkbox"
              checked={formChargerFeeEnabled}
              onChange={(e) => setFormChargerFeeEnabled(e.target.checked)}
              className="w-4 h-4 text-emerald-600 border-gray-300 rounded-sm focus:ring-emerald-500 cursor-pointer"
            />
          </div>

          {/* Active State Toggle */}
          <div className="flex items-center justify-between pt-1">
            <span className="text-xs font-semibold text-gray-700 dark:text-[#daf1de]">
              {t('deviceActiveState')}
            </span>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formIsActive}
                onChange={(e) => setFormIsActive(e.target.checked)}
                className="w-4 h-4 text-emerald-600 border-gray-300 rounded-sm focus:ring-emerald-500 cursor-pointer"
              />
              <span className="text-xs text-gray-600 dark:text-[#8eb698]">
                {formIsActive ? t('activeState') : t('inactiveState')}
              </span>
            </label>
          </div>

          {/* Form Actions */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-100 dark:border-[#123d37]">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCloseModal}
              disabled={isSubmitting}
              className="text-xs cursor-pointer"
            >
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={isSubmitting}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-2 cursor-pointer"
            >
              {isSubmitting ? t('loading') : t('save')}
            </Button>
          </div>
        </form>
      </Modal>

      {/* 5. Hard Delete Confirmation Modal */}
      <Modal
        isOpen={isDeleteDialogOpen}
        onClose={handleCloseDeleteDialog}
        title={t('deleteDeviceTypeTitle')}
        className="max-w-md bg-white dark:bg-[#082622] border-gray-200 dark:border-[#14423b]"
      >
        <div className="space-y-4">
          <div className="p-3.5 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 rounded-xl text-xs flex items-start gap-3">
            <Trash2 className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold text-rose-900 dark:text-rose-200">
                {locale === 'en'
                  ? `Permanently delete "${deviceToDelete ? getDeviceDisplayName(deviceToDelete, locale) : ''}"?`
                  : `حذف "${deviceToDelete ? getDeviceDisplayName(deviceToDelete, locale) : ''}" نهائياً؟`}
              </p>
              <p className="text-rose-700 dark:text-rose-300">
                {t('deleteDeviceTypeConfirm')}
              </p>
            </div>
          </div>

          <div className="bg-gray-50 dark:bg-[#061f1c] p-3 rounded-lg border border-gray-200 dark:border-[#14423b] text-xs space-y-1.5">
            <div className="flex justify-between text-gray-600 dark:text-[#8eb698]">
              <span>{t('deviceTypeName')}:</span>
              <span className="font-semibold text-gray-900 dark:text-[#daf1de]">
                {deviceToDelete ? getDeviceDisplayName(deviceToDelete, locale) : ''}
              </span>
            </div>
            <div className="flex justify-between text-gray-600 dark:text-[#8eb698]">
              <span>{t('deviceServicePrice')}:</span>
              <span className="font-semibold text-gray-900 dark:text-[#daf1de]">
                {deviceToDelete ? formatCurrency(deviceToDelete.basePriceMinor) : ''}
              </span>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-100 dark:border-[#123d37]">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCloseDeleteDialog}
              disabled={isDeleting}
              className="text-xs cursor-pointer"
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleConfirmDelete}
              disabled={isDeleting}
              className="bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold px-4 py-2 flex items-center gap-1.5 cursor-pointer shadow-xs"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{isDeleting ? (locale === 'en' ? 'Deleting...' : 'جاري الحذف...') : t('confirmDelete')}</span>
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
