import { globalSyncBridge } from '../../infrastructure/sync/syncBridge';
import React, { useState, useEffect, useRef } from 'react';
import { useI18n } from '../../i18n/i18nContext';
import { QRDesignConfig, QRDesignType } from '../qr/types';
import {
  getActiveQrDesign,
  setActiveQrDesign,
  DEFAULT_CUSTOMER_QR_DESIGN,
  DEFAULT_ORDER_QR_DESIGN,
  subscribeQrDesignChanges,
} from '../qr/defaultDesigns';
import { QrDesignRenderer } from '../qr/QrDesignRenderer';
import { queueQrDesignSetting } from './dayOrdersStore';
import { Button } from '../ui/Button';
import {
  Check,
  RotateCcw,
  Save,
  ArrowUp,
  ArrowDown,
  Layers,
  Image as ImageIcon,
  Palette,
  Type,
  Maximize2,
  Calendar,
  LayoutTemplate,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Info,
} from 'lucide-react';

export const QrDesignSettingsPage: React.FC = () => {
  const { t, locale } = useI18n();

  // Pull only new change-log entries while this QR screen is visible.
  useEffect(() => {
    let running = false;
    const pullNewChanges = async () => {
      if (running || document.visibilityState !== 'visible' || navigator.onLine === false) return;
      running = true;
      try { await globalSyncBridge.requestLatestDataReload(); }
      catch (error) { console.warn('QR design cloud refresh failed:', error); }
      finally { running = false; }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void pullNewChanges(); };
    document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(() => { void pullNewChanges(); }, 20000);
    void pullNewChanges();
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Selected Type: CUSTOMER vs ORDER (strictly independent)
  const [selectedType, setSelectedType] = useState<QRDesignType>('CUSTOMER');

  // Draft States (Presentation-only, isolated per type, not committed until Save)
  const [draftCustomer, setDraftCustomer] = useState<QRDesignConfig>(() =>
    getActiveQrDesign('CUSTOMER')
  );
  const [draftOrder, setDraftOrder] = useState<QRDesignConfig>(() =>
    getActiveQrDesign('ORDER')
  );

  const [savedSuccess, setSavedSuccess] = useState(false);

  const lastCommittedRef = useRef({ CUSTOMER: getActiveQrDesign('CUSTOMER'), ORDER: getActiveQrDesign('ORDER') });
  useEffect(() => subscribeQrDesignChanges((type, design, source) => {
    const previous = lastCommittedRef.current[type];
    const draft = type === 'CUSTOMER' ? draftCustomer : draftOrder;
    const wasClean = JSON.stringify(draft) === JSON.stringify(previous);
    lastCommittedRef.current[type] = design;
    if (source === 'remote' && wasClean) {
      if (type === 'CUSTOMER') setDraftCustomer(design);
      else setDraftOrder(design);
      setSavedSuccess(false);
    }
  }), [draftCustomer, draftOrder]);


  // Accordion State: Only one section open at a time (default: 'spacing' / dimensions)
  const [activeSection, setActiveSection] = useState<string | null>('spacing');
  const [sectionOrder, setSectionOrder] = useState<string[]>([
    'spacing',
    'colors',
    'logo',
    'order',
    'text',
    'date',
    'template',
  ]);

  const toggleSection = (sectionId: string) => {
    if (activeSection === sectionId) {
      setActiveSection(null);
    } else {
      setActiveSection(sectionId);
      setSectionOrder((prev) => {
        const filtered = prev.filter((id) => id !== sectionId);
        return [sectionId, ...filtered];
      });
    }
  };

  // Active Draft depending on selected tab
  const currentDraft = selectedType === 'CUSTOMER' ? draftCustomer : draftOrder;

  const updateCurrentDraft = (updater: (prev: QRDesignConfig) => QRDesignConfig) => {
    setSavedSuccess(false);
    if (selectedType === 'CUSTOMER') {
      setDraftCustomer((prev) => updater(prev));
    } else {
      setDraftOrder((prev) => updater(prev));
    }
  };

  // Compare Draft with committed Active Design
  const activeCommitted = getActiveQrDesign(selectedType);
  const isDirty = JSON.stringify(currentDraft) !== JSON.stringify(activeCommitted);

  // Check if either type has unsaved changes for tab badges
  const isCustomerDirty =
    JSON.stringify(draftCustomer) !== JSON.stringify(getActiveQrDesign('CUSTOMER'));
  const isOrderDirty =
    JSON.stringify(draftOrder) !== JSON.stringify(getActiveQrDesign('ORDER'));

  // Prompt confirmation on leaving if current draft is dirty
  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  // Save handler: Commits Draft to Active Design
  const handleSave = async () => {
    setSavedSuccess(false);
    try {
      await queueQrDesignSetting(selectedType, currentDraft);
      setActiveQrDesign(selectedType, currentDraft);
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 3000);
    } catch (error) {
      console.error('Failed to queue QR design setting:', error);
      window.alert(locale === 'ar' ? 'تعذر حفظ التصميم للمزامنة.' : 'Could not queue the design for sync.');
    }
  };

  // Reset handler: Reverts Draft to Default without touching the other type
  const handleReset = () => {
    const defaultDesign =
      selectedType === 'CUSTOMER'
        ? { ...DEFAULT_CUSTOMER_QR_DESIGN }
        : { ...DEFAULT_ORDER_QR_DESIGN };

    if (selectedType === 'CUSTOMER') {
      setDraftCustomer(defaultDesign);
    } else {
      setDraftOrder(defaultDesign);
    }
    setSavedSuccess(false);
  };

  // Move section in contentOrder
  const moveSection = (index: number, direction: 'up' | 'down') => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= currentDraft.contentOrder.length) return;

    updateCurrentDraft((prev) => {
      const newOrder = [...prev.contentOrder];
      const temp = newOrder[index];
      newOrder[index] = newOrder[targetIndex];
      newOrder[targetIndex] = temp;
      return { ...prev, contentOrder: newOrder };
    });
  };

  // Human-readable section names
  const getSectionLabel = (section: string): string => {
    const labels: Record<string, { ar: string; en: string }> = {
      chargingPointTop: { ar: 'تسمية نقطة الشحن (علوية)', en: 'Charging Point Label (Top)' },
      customerName: { ar: 'اسم العميل (بيانات خام)', en: 'Customer Name (Raw Data)' },
      customerCode: { ar: 'الرمز التعريفي للعميل', en: 'Customer ID' },
      qrCode: { ar: 'رمز QR', en: 'QR Code' },
      chargingPointBottom: { ar: 'تسمية نقطة الشحن (سفلية)', en: 'Charging Point Label (Bottom)' },
      thankYouMessage: { ar: 'رسالة الشكر', en: 'Thank You Message' },
      date: { ar: 'التاريخ', en: 'Date' },
      orderHeader: { ar: 'ترويسة الطلب', en: 'Order Header' },
      orderNumber: { ar: 'رقم الطلب', en: 'Order Number' },
      customerSnippet: { ar: 'ملخص العميل', en: 'Customer Snippet' },
      orderFooter: { ar: 'تذييل الطلب', en: 'Order Footer' },
    };
    const found = labels[section];
    if (!found) return section;
    return locale === 'en' ? found.en : found.ar;
  };

  const sectionMeta: Record<string, { label: string; icon: React.ReactNode }> = {
    spacing: {
      label: locale === 'en' ? 'Dimensions & Spacing' : 'المقاسات والتباعد',
      icon: <Maximize2 className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />,
    },
    colors: {
      label: t('colorSettings'),
      icon: <Palette className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />,
    },
    logo: {
      label: t('logoSettings'),
      icon: <ImageIcon className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />,
    },
    order: {
      label: t('layoutAndOrder'),
      icon: <Layers className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />,
    },
    text: {
      label: locale === 'en' ? 'Labels & Texts' : 'النصوص والتسميات',
      icon: <Type className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />,
    },
    date: {
      label: locale === 'en' ? 'Date Visibility & Format' : 'التاريخ والتنسيق',
      icon: <Calendar className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />,
    },
    template: {
      label: locale === 'en' ? 'Card Template' : 'قالب البطاقة',
      icon: <LayoutTemplate className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />,
    },
  };

  const renderSectionContent = (sectionId: string) => {
    switch (sectionId) {
      case 'spacing':
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-1">
              <div>
                <label className="block text-xs text-gray-600 dark:text-[#8eb698] mb-1.5 font-medium">
                  {t('padding')} ({currentDraft.padding}px)
                </label>
                <input
                  type="range"
                  min="8"
                  max="40"
                  step="2"
                  value={currentDraft.padding}
                  onChange={(e) =>
                    updateCurrentDraft((prev) => ({
                      ...prev,
                      padding: Number(e.target.value),
                    }))
                  }
                  className="w-full accent-emerald-600 cursor-pointer"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-600 dark:text-[#8eb698] mb-1.5 font-medium">
                  {t('spacing')} ({currentDraft.spacing}px)
                </label>
                <input
                  type="range"
                  min="4"
                  max="32"
                  step="2"
                  value={currentDraft.spacing}
                  onChange={(e) =>
                    updateCurrentDraft((prev) => ({
                      ...prev,
                      spacing: Number(e.target.value),
                    }))
                  }
                  className="w-full accent-emerald-600 cursor-pointer"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-600 dark:text-[#8eb698] mb-1.5 font-medium">
                  {t('borderRadius')} ({currentDraft.borderRadius}px)
                </label>
                <input
                  type="range"
                  min="0"
                  max="32"
                  step="2"
                  value={currentDraft.borderRadius}
                  onChange={(e) =>
                    updateCurrentDraft((prev) => ({
                      ...prev,
                      borderRadius: Number(e.target.value),
                    }))
                  }
                  className="w-full accent-emerald-600 cursor-pointer"
                />
              </div>
            </div>

            {/* QR Size and Quiet Zone */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-gray-100 dark:border-[#0f302b]">
              <div>
                <label className="block text-xs text-gray-600 dark:text-[#8eb698] mb-1.5 font-medium">
                  {locale === 'en' ? 'QR Size' : 'حجم رمز QR'} ({currentDraft.qr.size}px)
                </label>
                <input
                  type="range"
                  min="120"
                  max="240"
                  step="10"
                  value={currentDraft.qr.size}
                  onChange={(e) =>
                    updateCurrentDraft((prev) => ({
                      ...prev,
                      qr: { ...prev.qr, size: Number(e.target.value) },
                    }))
                  }
                  className="w-full accent-emerald-600 cursor-pointer"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-600 dark:text-[#8eb698] mb-1.5 font-medium">
                  {locale === 'en' ? 'Quiet Zone (Margin)' : 'هامش الأمان المحيط بالرمز'} (
                  {currentDraft.qr.margin})
                </label>
                <input
                  type="range"
                  min="0"
                  max="4"
                  step="1"
                  value={currentDraft.qr.margin}
                  onChange={(e) =>
                    updateCurrentDraft((prev) => ({
                      ...prev,
                      qr: { ...prev.qr, margin: Number(e.target.value) },
                    }))
                  }
                  className="w-full accent-emerald-600 cursor-pointer"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-600 dark:text-[#8eb698] mb-1.5 font-medium">
                  {locale === 'en' ? 'Error Correction' : 'تصحيح الأخطاء'}
                </label>
                <select
                  value={currentDraft.qr.errorCorrectionLevel}
                  onChange={(e) =>
                    updateCurrentDraft((prev) => ({
                      ...prev,
                      qr: {
                        ...prev.qr,
                        errorCorrectionLevel: e.target.value as 'L' | 'M' | 'Q' | 'H',
                      },
                    }))
                  }
                  className="w-full text-xs bg-gray-50 dark:bg-[#041714] border border-gray-200 dark:border-[#123832] rounded-lg px-2.5 py-1.5 text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-1 focus:ring-emerald-500"
                >
                  <option value="L">L (7% - Low)</option>
                  <option value="M">M (15% - Medium Standard)</option>
                  <option value="Q">Q (25% - High)</option>
                  <option value="H">H (30% - Ultra High)</option>
                </select>
              </div>
            </div>
          </div>
        );

      case 'colors':
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
              <div>
                <label className="block text-xs text-gray-600 dark:text-[#8eb698] mb-1.5 font-medium">
                  {t('backgroundColor')}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={currentDraft.backgroundColor}
                    onChange={(e) =>
                      updateCurrentDraft((prev) => ({
                        ...prev,
                        backgroundColor: e.target.value,
                      }))
                    }
                    className="w-8 h-8 rounded border border-gray-300 dark:border-[#14423b] cursor-pointer bg-transparent"
                  />
                  <input
                    type="text"
                    value={currentDraft.backgroundColor}
                    onChange={(e) =>
                      updateCurrentDraft((prev) => ({
                        ...prev,
                        backgroundColor: e.target.value,
                      }))
                    }
                    className="flex-1 text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-lg px-2 py-1.5 text-gray-900 dark:text-[#daf1de] font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-600 dark:text-[#8eb698] mb-1.5 font-medium">
                  {t('textColor')}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={currentDraft.foregroundColor}
                    onChange={(e) =>
                      updateCurrentDraft((prev) => ({
                        ...prev,
                        foregroundColor: e.target.value,
                      }))
                    }
                    className="w-8 h-8 rounded border border-gray-300 dark:border-[#14423b] cursor-pointer bg-transparent"
                  />
                  <input
                    type="text"
                    value={currentDraft.foregroundColor}
                    onChange={(e) =>
                      updateCurrentDraft((prev) => ({
                        ...prev,
                        foregroundColor: e.target.value,
                      }))
                    }
                    className="flex-1 text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-lg px-2 py-1.5 text-gray-900 dark:text-[#daf1de] font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-600 dark:text-[#8eb698] mb-1.5 font-medium">
                  {t('borderColor')}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={currentDraft.borderColor}
                    onChange={(e) =>
                      updateCurrentDraft((prev) => ({
                        ...prev,
                        borderColor: e.target.value,
                      }))
                    }
                    className="w-8 h-8 rounded border border-gray-300 dark:border-[#14423b] cursor-pointer bg-transparent"
                  />
                  <input
                    type="text"
                    value={currentDraft.borderColor}
                    onChange={(e) =>
                      updateCurrentDraft((prev) => ({
                        ...prev,
                        borderColor: e.target.value,
                      }))
                    }
                    className="flex-1 text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-lg px-2 py-1.5 text-gray-900 dark:text-[#daf1de] font-mono"
                  />
                </div>
              </div>
            </div>
          </div>
        );

      case 'logo':
        return (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
              <div>
                <label className="text-xs font-semibold text-gray-900 dark:text-[#daf1de] block">
                  {t('showLogo')}
                </label>
                <p className="text-[11px] text-gray-500 dark:text-[#8eb698]">
                  {locale === 'en'
                    ? 'Display brand logo (Default: Hidden / none)'
                    : 'عرض شعار المنظومة (الافتراضي: مخفي بدون شعار)'}
                </p>
              </div>
              <input
                type="checkbox"
                checked={currentDraft.logo.show}
                onChange={(e) =>
                  updateCurrentDraft((prev) => ({
                    ...prev,
                    logo: {
                      ...prev.logo,
                      show: e.target.checked,
                      placement: e.target.checked && prev.logo.placement === 'none' ? 'top' : prev.logo.placement,
                    },
                  }))
                }
                className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
              />
            </div>

            {currentDraft.logo.show && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-gray-100 dark:border-[#0f302b]">
                <div>
                  <label className="block text-xs text-gray-600 dark:text-[#8eb698] mb-1.5 font-medium">
                    {t('logoPlacement')}
                  </label>
                  <select
                    value={currentDraft.logo.placement}
                    onChange={(e) =>
                      updateCurrentDraft((prev) => ({
                        ...prev,
                        logo: {
                          ...prev.logo,
                          placement: e.target.value as any,
                        },
                      }))
                    }
                    className="w-full text-xs bg-gray-50 dark:bg-[#041714] border border-gray-200 dark:border-[#123832] rounded-lg px-2.5 py-1.5 text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="none">{t('logoPlacementNone')}</option>
                    <option value="top">{t('logoPlacementTop')}</option>
                    <option value="center">{t('logoPlacementCenter')}</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-gray-600 dark:text-[#8eb698] mb-1.5 font-medium">
                    {t('logoSize')} ({currentDraft.logo.size}px)
                  </label>
                  <input
                    type="range"
                    min="24"
                    max="64"
                    step="4"
                    value={currentDraft.logo.size}
                    onChange={(e) =>
                      updateCurrentDraft((prev) => ({
                        ...prev,
                        logo: {
                          ...prev.logo,
                          size: Number(e.target.value),
                        },
                      }))
                    }
                    className="w-full accent-emerald-600 cursor-pointer"
                  />
                </div>

                <div>
                  <label className="block text-xs text-gray-600 dark:text-[#8eb698] mb-1.5 font-medium">
                    {t('logoCircleSize')} ({currentDraft.logo.circleSize || 56}px)
                  </label>
                  <input
                    type="range"
                    min="32"
                    max="96"
                    step="4"
                    value={currentDraft.logo.circleSize || 56}
                    onChange={(e) =>
                      updateCurrentDraft((prev) => ({
                        ...prev,
                        logo: {
                          ...prev.logo,
                          circleSize: Number(e.target.value),
                        },
                      }))
                    }
                    className="w-full accent-emerald-600 cursor-pointer"
                  />
                </div>
              </div>
            )}
          </div>
        );

      case 'order':
        return (
          <div className="space-y-3">
            <p className="text-xs text-gray-500 dark:text-[#8eb698] pt-1">
              {locale === 'en'
                ? 'Use arrows to reorder card elements. Changes reflect immediately in preview.'
                : 'استخدم الأسهم لإعادة ترتيب عناصر الملصق. تظهر التغييرات فورياً في المعاينة.'}
            </p>

            <div className="space-y-1.5">
              {currentDraft.contentOrder.map((section, index) => (
                <div
                  key={`${section}-${index}`}
                  className="flex items-center justify-between p-2.5 bg-gray-50 dark:bg-[#041714] rounded-lg border border-gray-200/80 dark:border-[#123832]"
                >
                  <span className="text-xs font-medium text-gray-800 dark:text-[#daf1de]">
                    {getSectionLabel(section)}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => moveSection(index, 'up')}
                      disabled={index === 0}
                      className="h-7 w-7 p-0"
                      aria-label={t('moveUp')}
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => moveSection(index, 'down')}
                      disabled={index === currentDraft.contentOrder.length - 1}
                      className="h-7 w-7 p-0"
                      aria-label={t('moveDown')}
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );

      case 'text':
        return (
          <div className="space-y-4">
            <div className="flex items-start gap-2 p-2.5 bg-emerald-50/60 dark:bg-emerald-950/20 border border-emerald-100 dark:border-emerald-800/30 rounded-lg text-emerald-800 dark:text-[#8eb698] text-xs">
              <Info className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                {locale === 'en'
                  ? 'Customer Name is RAW customer identity data and is never translated or altered by design labels.'
                  : 'اسم العميل هو بيان هوية أصيل (RAW) ولا يخضع للترجمة أو التعديل عبر تسميات التصميم.'}
              </span>
            </div>

            <div className="space-y-3 pt-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-900 dark:text-[#daf1de]">
                  {locale === 'en' ? 'Charging Point Labels' : 'تسميات نقطة الشحن'}
                </span>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-[#8eb698] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={currentDraft.chargingPointLabel.showTop}
                      onChange={(e) =>
                        updateCurrentDraft((prev) => ({
                          ...prev,
                          chargingPointLabel: {
                            ...prev.chargingPointLabel,
                            showTop: e.target.checked,
                          },
                        }))
                      }
                      className="w-3.5 h-3.5 rounded text-emerald-600 cursor-pointer"
                    />
                    <span>{locale === 'en' ? 'Top' : 'علوية'}</span>
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-[#8eb698] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={currentDraft.chargingPointLabel.showBottom}
                      onChange={(e) =>
                        updateCurrentDraft((prev) => ({
                          ...prev,
                          chargingPointLabel: {
                            ...prev.chargingPointLabel,
                            showBottom: e.target.checked,
                          },
                        }))
                      }
                      className="w-3.5 h-3.5 rounded text-emerald-600 cursor-pointer"
                    />
                    <span>{locale === 'en' ? 'Bottom' : 'سفلية'}</span>
                  </label>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-gray-500 dark:text-[#8eb698] mb-1 font-medium">
                    {locale === 'en' ? 'Arabic Label' : 'النص بالعربية'}
                  </label>
                  <input
                    type="text"
                    value={currentDraft.chargingPointLabel?.textAr ?? ''}
                    onChange={(e) =>
                      updateCurrentDraft((prev) => ({
                        ...prev,
                        chargingPointLabel: {
                          ...prev.chargingPointLabel,
                          textAr: e.target.value,
                        },
                      }))
                    }
                    className="w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-lg px-2.5 py-1.5 text-gray-900 dark:text-[#daf1de]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-gray-500 dark:text-[#8eb698] mb-1 font-medium">
                    {locale === 'en' ? 'English Label' : 'النص بالإنجليزية'}
                  </label>
                  <input
                    type="text"
                    value={currentDraft.chargingPointLabel?.textEn ?? ''}
                    onChange={(e) =>
                      updateCurrentDraft((prev) => ({
                        ...prev,
                        chargingPointLabel: {
                          ...prev.chargingPointLabel,
                          textEn: e.target.value,
                        },
                      }))
                    }
                    className="w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-lg px-2.5 py-1.5 text-gray-900 dark:text-[#daf1de]"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-3 pt-3 border-t border-gray-100 dark:border-[#123d37]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-900 dark:text-[#daf1de]">
                  {t('showThankYou')}
                </span>
                <input
                  type="checkbox"
                  checked={currentDraft.thankYouMessage.show}
                  onChange={(e) =>
                    updateCurrentDraft((prev) => ({
                      ...prev,
                      thankYouMessage: {
                        ...prev.thankYouMessage,
                        show: e.target.checked,
                      },
                    }))
                  }
                  className="w-4 h-4 rounded text-emerald-600 cursor-pointer"
                />
              </div>

              {currentDraft.thankYouMessage.show && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-gray-500 dark:text-[#8eb698] mb-1 font-medium">
                      {locale === 'en' ? 'Arabic Message' : 'الرسالة بالعربية'}
                    </label>
                    <input
                      type="text"
                      value={currentDraft.thankYouMessage?.textAr ?? ''}
                      onChange={(e) =>
                        updateCurrentDraft((prev) => ({
                          ...prev,
                          thankYouMessage: {
                            ...prev.thankYouMessage,
                            textAr: e.target.value,
                          },
                        }))
                      }
                      className="w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-lg px-2.5 py-1.5 text-gray-900 dark:text-[#daf1de]"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-gray-500 dark:text-[#8eb698] mb-1 font-medium">
                      {locale === 'en' ? 'English Message' : 'الرسالة بالإنجليزية'}
                    </label>
                    <input
                      type="text"
                      value={currentDraft.thankYouMessage?.textEn ?? ''}
                      onChange={(e) =>
                        updateCurrentDraft((prev) => ({
                          ...prev,
                          thankYouMessage: {
                            ...prev.thankYouMessage,
                            textEn: e.target.value,
                          },
                        }))
                      }
                      className="w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-lg px-2.5 py-1.5 text-gray-900 dark:text-[#daf1de]"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        );

      case 'date':
        return (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
              <div>
                <label className="text-xs font-semibold text-gray-900 dark:text-[#daf1de] block">
                  {t('showDate')}
                </label>
                <p className="text-[11px] text-gray-500 dark:text-[#8eb698]">
                  {locale === 'en'
                    ? 'Show generation date on the printed card'
                    : 'عرض تاريخ الطباعة على ملصق البطاقة'}
                </p>
              </div>
              <input
                type="checkbox"
                checked={currentDraft.date.show}
                onChange={(e) =>
                  updateCurrentDraft((prev) => ({
                    ...prev,
                    date: {
                      ...prev.date,
                      show: e.target.checked,
                    },
                  }))
                }
                className="w-4 h-4 rounded text-emerald-600 cursor-pointer"
              />
            </div>

            {currentDraft.date.show && (
              <div className="pt-3 border-t border-gray-100 dark:border-[#123d37]">
                <label className="block text-xs text-gray-600 dark:text-[#8eb698] mb-1.5 font-medium">
                  {locale === 'en' ? 'Date Format' : 'تنسيق التاريخ'}
                </label>
                <select
                  value={currentDraft.date.format}
                  onChange={(e) =>
                    updateCurrentDraft((prev) => ({
                      ...prev,
                      date: {
                        ...prev.date,
                        format: e.target.value as 'YYYY-MM-DD' | 'YYYY/MM/DD',
                      },
                    }))
                  }
                  className="w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-lg px-2.5 py-1.5 text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-1 focus:ring-emerald-500"
                >
                  <option value="YYYY-MM-DD">YYYY-MM-DD (2026-09-26)</option>
                  <option value="YYYY/MM/DD">YYYY/MM/DD (2026/09/26)</option>
                </select>
              </div>
            )}
          </div>
        );

      case 'template':
        return (
          <div className="space-y-3">
            <div className="pt-2">
              <label className="block text-xs text-gray-600 dark:text-[#8eb698] mb-1.5 font-medium">
                {locale === 'en' ? 'Template Structure' : 'هيكل القالب'}
              </label>
              <select
                value={currentDraft.template}
                onChange={(e) =>
                  updateCurrentDraft((prev) => ({
                    ...prev,
                    template: e.target.value as any,
                  }))
                }
                className="w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-lg px-2.5 py-1.5 text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                <option value="standard">{t('templateStandard')}</option>
                <option value="minimal">{t('templateMinimal')}</option>
                <option value="badge">{t('templateBadge')}</option>
              </select>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-20 px-4 sm:px-6">
      {/* 1. Page Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-200 dark:border-[#14423b] pb-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-[#daf1de] tracking-tight">
            {t('qrDesignTitle')}
          </h1>
          <p className="text-xs text-gray-500 dark:text-[#8eb698] mt-0.5">
            {t('qrDesignSubtitle')}
          </p>
        </div>

        {/* Action Controls in Header */}
        <div className="flex items-center gap-2">
          {isDirty && (
            <span className="text-xs text-amber-600 dark:text-amber-400 font-medium px-2 py-1 bg-amber-50 dark:bg-amber-950/40 rounded-md border border-amber-200 dark:border-amber-800/40 animate-pulse">
              {t('unsavedChanges')}
            </span>
          )}

          {savedSuccess && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium px-2 py-1 bg-emerald-50 dark:bg-emerald-950/40 rounded-md border border-emerald-200 dark:border-emerald-800/40 flex items-center gap-1">
              <Check className="w-3.5 h-3.5" />
              {t('designSavedSuccess')}
            </span>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            className="text-xs h-9 px-3"
            aria-label={t('resetToDefault')}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{t('resetToDefault')}</span>
          </Button>

          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={!isDirty}
            className="text-xs h-9 px-4 font-semibold"
            aria-label={t('saveDesign')}
          >
            <Save className="w-3.5 h-3.5" />
            <span>{t('saveDesign')}</span>
          </Button>
        </div>
      </div>

      {/* 2. Customer QR / Order QR Selector */}
      <div className="flex items-center gap-2 p-1 bg-gray-100 dark:bg-[#06201c] rounded-lg max-w-sm border border-gray-200 dark:border-[#123d37]">
        <button
          type="button"
          onClick={() => setSelectedType('CUSTOMER')}
          className={`flex-1 py-1.5 px-3 rounded-md text-xs font-semibold transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
            selectedType === 'CUSTOMER'
              ? 'bg-white dark:bg-[#0c312b] text-gray-900 dark:text-[#daf1de] shadow-sm'
              : 'text-gray-600 dark:text-[#8eb698] hover:text-gray-900 dark:hover:text-[#daf1de]'
          }`}
          aria-selected={selectedType === 'CUSTOMER'}
          role="tab"
        >
          <span>{t('customerQrTab')}</span>
          {isCustomerDirty && (
            <span className="w-2 h-2 rounded-full bg-amber-500" title={t('unsavedChanges')} />
          )}
        </button>
        <button
          type="button"
          onClick={() => setSelectedType('ORDER')}
          className={`flex-1 py-1.5 px-3 rounded-md text-xs font-semibold transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
            selectedType === 'ORDER'
              ? 'bg-white dark:bg-[#0c312b] text-gray-900 dark:text-[#daf1de] shadow-sm'
              : 'text-gray-600 dark:text-[#8eb698] hover:text-gray-900 dark:hover:text-[#daf1de]'
          }`}
          aria-selected={selectedType === 'ORDER'}
          role="tab"
        >
          <span>{t('orderQrTab')}</span>
          {isOrderDirty && (
            <span className="w-2 h-2 rounded-full bg-amber-500" title={t('unsavedChanges')} />
          )}
        </button>
      </div>

      {/* 3. QR LIVE PREVIEW (DIRECTLY AT THE TOP) */}
      <div className="bg-gray-50 dark:bg-[#06201c] rounded-2xl border border-gray-200 dark:border-[#123d37] p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-gray-200/60 dark:border-[#14423b]/60 pb-3">
          <span className="text-xs font-bold text-gray-800 dark:text-[#daf1de] uppercase tracking-wider flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-emerald-600 dark:text-[#8eb698]" />
            {t('livePreview')}
          </span>
          <span className="text-[11px] text-gray-500 dark:text-[#5e8674] font-medium">
            {locale === 'en'
              ? 'Target standard print format: 5 × 6 cm'
              : 'المقاس القياسي المستهدف للطباعة: 5 × 6 سم'}
          </span>
        </div>

        {/* Centered Realistic Preview with QrDesignRenderer */}
        <div className="flex items-center justify-center py-2 min-h-[380px]">
          {selectedType === 'CUSTOMER' ? (
            <QrDesignRenderer
              identity={{
                publicUrl: `${origin}/c/preview-customer`,
                publicToken: 'preview-customer',
              }}
              content={{
                customerName: 'أحمد محمد', // Strictly RAW, never translated
                customerCode: 'A7K2',
              }}
              design={currentDraft}
              locale={locale as 'ar' | 'en'}
              cardId="customer-qr-preview"
            />
          ) : (
            <QrDesignRenderer
              identity={{
                publicUrl: `${origin}/o/preview-order`,
                publicToken: 'preview-order',
              }}
              content={{
                orderNumber: 28,
                customerName: 'أحمد محمد', // Strictly RAW, never translated
                customerCode: 'A7K2',
              }}
              design={currentDraft}
              locale={locale as 'ar' | 'en'}
              cardId="order-qr-preview"
            />
          )}
        </div>
      </div>

      {/* 4. ACCORDION SETTINGS (Native Mobile-First Grouped Container with Dynamic Reordering to Top) */}
      <div className="bg-white dark:bg-[#061f1c] rounded-2xl border border-gray-200/80 dark:border-[#123832] divide-y divide-gray-100 dark:divide-[#0f302b] shadow-2xs overflow-hidden">
        {sectionOrder.map((sectionId) => {
          const meta = sectionMeta[sectionId];
          const isOpen = activeSection === sectionId;
          return (
            <div key={sectionId}>
              <button
                type="button"
                onClick={() => toggleSection(sectionId)}
                className="w-full px-4 py-3.5 flex items-center justify-between text-start cursor-pointer hover:bg-gray-50/50 dark:hover:bg-[#0b2924] transition-colors"
                aria-expanded={isOpen}
              >
                <div className="flex items-center gap-2.5">
                  {meta.icon}
                  <span className="text-sm font-semibold text-gray-900 dark:text-[#daf1de]">
                    {meta.label}
                  </span>
                </div>
                {isOpen ? (
                  <ChevronUp className="w-4 h-4 text-gray-500 dark:text-[#8eb698]" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-gray-500 dark:text-[#8eb698]" />
                )}
              </button>

              {isOpen && (
                <div className="px-4 pb-4 pt-2 bg-gray-50/30 dark:bg-[#041714]/30 space-y-4">
                  {renderSectionContent(sectionId)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 5. Bottom Action Bar */}
      <div className="flex items-center justify-between pt-4 border-t border-gray-200 dark:border-[#14423b]">
        <Button
          variant="outline"
          size="sm"
          onClick={handleReset}
          className="text-xs h-9 px-3 gap-1.5"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>{t('resetToDefault')}</span>
        </Button>

        <div className="flex items-center gap-2">
          {isDirty && (
            <span className="text-xs text-amber-600 dark:text-amber-400 font-medium hidden sm:inline">
              {t('unsavedChanges')}
            </span>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={!isDirty}
            className="text-xs h-9 px-5 font-semibold gap-1.5"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{t('saveDesign')}</span>
          </Button>
        </div>
      </div>
    </div>
  );
};
