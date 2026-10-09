import React, { useState, useEffect } from 'react';
import { useI18n } from '../../i18n/i18nContext';
import { getOrderQrCardData, UIOrderQrCardData } from './dayOrdersStore';
import { OrderQrCard } from '../qr/OrderQrCard';
import { getActiveQrDesign } from '../qr/defaultDesigns';
import { downloadQrCard } from '../qr/downloadEngine';
import { Button } from '../ui/Button';
import { Download, Share2, Check, AlertTriangle, ArrowLeft, ArrowRight } from 'lucide-react';

export interface OrderQrPageProps {
  dayId: string;
  orderId: string;
  onBack: () => void;
}

export const OrderQrPage: React.FC<OrderQrPageProps> = ({ dayId, orderId, onBack }) => {
  const { t, locale, isRTL } = useI18n();
  const [data, setData] = useState<UIOrderQrCardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);
  const [isNumberingError, setIsNumberingError] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setIsError(false);
    setIsNumberingError(false);

    getOrderQrCardData(dayId, orderId)
      .then((res) => {
        if (active) {
          if (res && Number.isInteger(res.orderNumber) && res.orderNumber > 0) {
            setData(res);
          } else {
            // Never render a fabricated or missing order number on a printed QR card.
            setData(null);
            setIsNumberingError(Boolean(res));
            setIsError(true);
          }
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          console.error('Failed to load order QR data:', err);
          setIsError(true);
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [dayId, orderId]);

  const handleShareOrCopyLink = async () => {
    if (!data?.publicUrl) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(data.publicUrl);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = data.publicUrl;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    } catch (e) {
      console.error('Failed to copy link:', e);
    }
  };

  const handleDownload = async () => {
    if (!data) return;
    setIsDownloading(true);
    try {
      const design = getActiveQrDesign('ORDER');
      const filename = `order-qr-${data.orderNumber}-${data.orderId}.png`;
      await downloadQrCard({
        identity: { publicUrl: data.publicUrl },
        content: {
          orderNumber: data.orderNumber,
          customerName: data.customerName,
          customerCode: `ORD-${data.orderNumber}`,
        },
        design,
        locale,
        filename,
      });
    } catch (err) {
      console.error('Order QR download failed:', err);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto py-6 px-4 sm:px-6 space-y-6 text-gray-900 dark:text-[#daf1de]">
      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-gray-200 dark:border-[#14423b]">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-[#0c312b] text-gray-600 dark:text-[#8eb698] cursor-pointer"
          >
            {isRTL ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
          </button>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-gray-900 dark:text-[#daf1de]">
              {data ? `${t('orderNumberPrefix', { number: data.orderNumber })}` : t('orderQrTitle') || 'رمز QR للطلب'}
            </h1>
            <p className="text-xs text-gray-500 dark:text-[#8eb698]">
              {data?.customerName}
            </p>
          </div>
        </div>

        {/* Action Buttons: Share icon + Download icon (No Print) */}
        {data && (
          <div className="flex items-center gap-2">
            {/* Share / Copy Link Icon Button */}
            <button
              type="button"
              onClick={handleShareOrCopyLink}
              title={copiedLink ? (t('linkCopied') || 'تم نسخ الرابط!') : (t('shareLink') || 'مشاركة ونسخ الرابط')}
              className="p-2 rounded-lg border border-gray-200 dark:border-[#14423b] hover:bg-gray-100 dark:hover:bg-[#0c312b] text-gray-700 dark:text-[#daf1de] transition-colors relative flex items-center justify-center cursor-pointer"
              aria-label="Share and copy link"
            >
              {copiedLink ? (
                <Check className="w-4 h-4 text-emerald-600 dark:text-[#7ae09e]" />
              ) : (
                <Share2 className="w-4 h-4" />
              )}
            </button>

            {/* Download Icon Button */}
            <button
              type="button"
              onClick={handleDownload}
              disabled={isDownloading}
              title={t('downloadCard') || 'تحميل الكارد'}
              className="p-2 rounded-lg border border-gray-200 dark:border-[#14423b] hover:bg-gray-100 dark:hover:bg-[#0c312b] text-gray-700 dark:text-[#daf1de] disabled:opacity-50 transition-colors flex items-center justify-center cursor-pointer"
              aria-label="Download QR Card"
            >
              <Download className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {/* Main Content Card Display: Single Card Only */}
      {isLoading ? (
        <div className="py-16 text-center text-xs text-gray-500 dark:text-[#8eb698]">
          {t('loading')}
        </div>
      ) : isError || !data ? (
        <div className="py-12 px-4 text-center space-y-3 bg-red-50 dark:bg-[#360d13] border border-red-200 dark:border-[#421419] rounded-2xl">
          <AlertTriangle className="w-8 h-8 text-red-600 dark:text-[#e07a7a] mx-auto" />
          <p className="text-sm font-bold text-red-700 dark:text-[#e07a7a]">
            {isNumberingError
              ? (locale === 'ar' ? 'رقم الطلب غير متاح. راجع ترقيم اليوم من الإعدادات قبل طباعة QR.' : 'Order number unavailable. Review the day numbering in Settings before printing a QR card.')
              : (locale === 'ar' ? 'الطلب غير موجود أو تعذر تحميل QR' : (t('orderNotFound') || 'Order not found or QR could not be loaded'))}
          </p>
          <Button variant="outline" size="sm" onClick={onBack}>
            {t('back')}
          </Button>
        </div>
      ) : (
        <div className="py-2">
          {/* Strictly single card with single border boundary */}
          <div className="flex justify-center">
            <OrderQrCard
              orderNumber={data.orderNumber}
              customerName={data.customerName}
              qrValue={data.publicUrl}
              cardId="order-qr-card"
              className="w-full max-w-sm"
            />
          </div>
        </div>
      )}

      {/* Toast Notification when link is copied */}
      {copiedLink && (
        <div className="fixed bottom-6 start-1/2 -translate-x-1/2 z-50 bg-emerald-700 dark:bg-emerald-600 text-white text-xs font-semibold px-4 py-2 rounded-full shadow-lg flex items-center gap-1.5 transition-all">
          <Check className="w-3.5 h-3.5" />
          <span>{t('linkCopied') || 'تم نسخ الرابط بنجاح'}</span>
        </div>
      )}
    </div>
  );
};
