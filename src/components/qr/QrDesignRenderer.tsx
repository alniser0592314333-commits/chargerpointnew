import React, { useEffect, useRef, useState } from 'react';
import {
  QRDesignConfig,
  QRIdentity,
  QRCustomerContent,
  QROrderContent,
  QRCustomerSection,
  QROrderSection,
} from './types';
import { QrCodeRenderer } from './QrCodeRenderer';
import { AppLogo } from './AppLogo';

export interface QrDesignRendererProps {
  identity: {
    publicUrl: string;
    publicToken?: string;
  };
  content: QRCustomerContent | QROrderContent;
  design: QRDesignConfig;
  locale?: 'ar' | 'en';
  className?: string;
  cardId?: string;
}

/**
 * QrDesignRenderer
 * Pure presentation component.
 *
 * Rules:
 * 1. NEVER creates, rotates, or modifies tokens.
 * 2. NEVER calls network or storage APIs.
 * 3. Renders dynamically based on `design.contentOrder`.
 * 4. Preserves customerName exactly as stored (never translated).
 * 5. Uses active design logo placement (if 'none', no logo rendered).
 * 6. Supports deterministic 5 x 6 cm print target layout.
 */
export const QrDesignRenderer: React.FC<QrDesignRendererProps> = ({
  identity,
  content,
  design,
  locale = 'ar',
  className = '',
  cardId = 'qr-design-card',
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const contentViewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentScale, setContentScale] = useState(1);

  // The print-target ratio must determine the frame size, not the intrinsic
  // height of the fixed-pixel QR/text content. On narrow screens, scale the
  // content down only when necessary so it stays inside that portrait frame.
  useEffect(() => {
    const card = cardRef.current;
    const viewport = contentViewportRef.current;
    const innerContent = contentRef.current;
    if (!card || !viewport || !innerContent) return;

    const updateScale = () => {
      const availableHeight = viewport.clientHeight;
      const naturalHeight = innerContent.scrollHeight;
      const nextScale =
        availableHeight > 0 && naturalHeight > 0
          ? Math.min(1, availableHeight / naturalHeight)
          : 1;
      setContentScale((previous) =>
        Math.abs(previous - nextScale) < 0.005 ? previous : nextScale
      );
    };

    updateScale();
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateScale)
      : null;
    observer?.observe(card);
    observer?.observe(viewport);
    observer?.observe(innerContent);
    window.addEventListener('resize', updateScale);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateScale);
    };
  }, [design]);

  const isOrderContent = 'orderNumber' in content || design.designType === 'ORDER';
  const orderContent = isOrderContent ? (content as QROrderContent) : null;
  const customerContent = !isOrderContent ? (content as QRCustomerContent) : null;

  // Format date helper
  const dateString =
    content.date ||
    (() => {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      return design.date.format === 'YYYY/MM/DD'
        ? `${year}/${month}/${day}`
        : `${year}-${month}-${day}`;
    })();

  const renderSection = (section: QRCustomerSection | QROrderSection, index: number) => {
    switch (section) {
      case 'chargingPointTop': {
        if (!design.chargingPointLabel.showTop) return null;
        const text =
          locale === 'en'
            ? design.chargingPointLabel.textEn
            : design.chargingPointLabel.textAr;
        return (
          <div key={`section-${index}`} className="flex justify-center">
            <span
              style={{ fontSize: `${design.typography.titleSize}px` }}
              className="inline-block px-3 py-0.5 bg-gray-100 dark:bg-[#0c312b] rounded-full font-bold text-gray-800 dark:text-[#daf1de] uppercase tracking-wide border border-transparent dark:border-[#14423b] print:border-black print:bg-transparent print:text-black"
            >
              {text}
            </span>
          </div>
        );
      }

      case 'customerName': {
        if (!design.customerName.show || !customerContent?.customerName) return null;
        return (
          <div key={`section-${index}`} className="px-1">
            <h2
              style={{ fontSize: `${design.typography.nameSize}px` }}
              className="font-black text-gray-900 dark:text-[#daf1de] print:text-black break-words leading-tight"
            >
              {customerContent.customerName}
            </h2>
          </div>
        );
      }

      case 'customerCode': {
        if (!design.customerCode.show || !customerContent?.customerCode) return null;
        const label =
          locale === 'en'
            ? design.customerCode.labelEn
            : design.customerCode.labelAr;
        return (
          <div
            key={`section-${index}`}
            style={{ fontSize: `${design.typography.codeSize}px` }}
            className="flex items-center justify-center gap-1.5 text-gray-600 dark:text-[#8eb698] print:text-black"
          >
            <span>{label}:</span>
            <span className="font-mono font-bold px-2 py-0.5 bg-gray-100 dark:bg-[#0c312b] text-gray-900 dark:text-[#daf1de] rounded border border-transparent dark:border-[#14423b] print:border print:border-black print:bg-transparent print:text-black">
              {customerContent.customerCode}
            </span>
          </div>
        );
      }

      case 'orderHeader': {
        const text =
          locale === 'en'
            ? design.chargingPointLabel.textEn
            : design.chargingPointLabel.textAr;
        return (
          <div key={`section-${index}`} className="flex justify-center">
            <span
              style={{ fontSize: `${design.typography.titleSize}px` }}
              className="inline-block px-3 py-0.5 bg-gray-100 dark:bg-[#0c312b] rounded-full font-bold text-gray-800 dark:text-[#daf1de] print:text-black"
            >
              {text}
            </span>
          </div>
        );
      }

      case 'orderNumber': {
        if (!orderContent?.orderNumber) return null;
        return (
          <div key={`section-${index}`} className="px-1 space-y-1">
            <h2
              style={{ fontSize: `${design.typography.nameSize}px` }}
              className="font-black text-gray-900 dark:text-[#daf1de] print:text-black"
            >
              {locale === 'en' ? `Order #${orderContent.orderNumber}` : `طلب #${orderContent.orderNumber}`}
            </h2>
            {orderContent.customerName && (
              <p className="text-xs text-gray-600 dark:text-[#8eb698] print:text-black">
                {orderContent.customerName}
              </p>
            )}
          </div>
        );
      }

      case 'customerSnippet': {
        if (!orderContent?.customerCode) return null;
        return (
          <div key={`section-${index}`} className="text-xs font-mono text-gray-500 print:text-black">
            {orderContent.customerCode}
          </div>
        );
      }

      case 'qrCode': {
        // Logo decoration placement resolution: strictly uses canonical White Logo without theme switching
        const logoVisible = design.logo.show && design.logo.placement === 'center';
        const centerLogoNode = logoVisible ? (
          <AppLogo size={design.logo.size} isQr={true} variant="qr" />
        ) : undefined;

        return (
          <div key={`section-${index}`} className="flex justify-center py-1">
            <QrCodeRenderer
              value={identity.publicUrl}
              size={design.qr.size}
              errorCorrectionLevel={design.qr.errorCorrectionLevel}
              margin={design.qr.margin}
              centerLogo={centerLogoNode}
              logoSize={design.logo.size * 1.5}
              logoCircleSize={design.logo.circleSize}
              logoVisible={logoVisible}
              id={`${cardId}-code`}
            />
          </div>
        );
      }

      case 'chargingPointBottom': {
        if (!design.chargingPointLabel.showBottom) return null;
        const text =
          locale === 'en'
            ? design.chargingPointLabel.textEn
            : design.chargingPointLabel.textAr;
        return (
          <div
            key={`section-${index}`}
            style={{ fontSize: `${design.typography.subtitleSize}px` }}
            className="pt-1.5 border-t border-gray-100 dark:border-[#14423b] print:border-black font-semibold text-gray-600 dark:text-[#8eb698] print:text-black"
          >
            {text}
          </div>
        );
      }

      case 'thankYouMessage': {
        if (!design.thankYouMessage.show) return null;
        const text =
          locale === 'en'
            ? design.thankYouMessage.textEn
            : design.thankYouMessage.textAr;
        return (
          <div
            key={`section-${index}`}
            style={{ fontSize: `${design.typography.bodySize}px` }}
            className="text-gray-500 dark:text-[#7fa38a] print:text-black font-medium"
          >
            {text}
          </div>
        );
      }

      case 'orderFooter': {
        const text =
          locale === 'en'
            ? design.thankYouMessage.textEn
            : design.thankYouMessage.textAr;
        return (
          <div
            key={`section-${index}`}
            style={{ fontSize: `${design.typography.bodySize}px` }}
            className="pt-1.5 border-t border-gray-100 dark:border-[#14423b] print:border-black text-gray-500 print:text-black"
          >
            {text}
          </div>
        );
      }

      case 'date': {
        if (!design.date.show) return null;
        return (
          <div
            key={`section-${index}`}
            style={{ fontSize: `${design.typography.bodySize - 1}px` }}
            className="text-[10px] text-gray-400 dark:text-[#5e8674] print:text-black font-mono"
          >
            {dateString}
          </div>
        );
      }

      default:
        return null;
    }
  };

  return (
    <div
      id={cardId}
      ref={cardRef}
      style={{
        borderRadius: `${design.borderRadius}px`,
        padding: 0,
        width: '100%',
        maxWidth: '380px',
        boxSizing: 'border-box',
        position: 'relative',
        overflow: 'hidden',
        // Absolutely-positioned content below cannot force this frame back to
        // its intrinsic content height; the saved print target owns the ratio.
        aspectRatio: `${design.printTarget.widthMm} / ${design.printTarget.heightMm}`,
      }}
      className={`bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] mx-auto shadow-md text-center transition-colors print:border print:border-black print:shadow-none print:bg-white print:max-w-none print:w-full ${className}`}
    >
      <div
        ref={contentViewportRef}
        style={{
          position: 'absolute',
          inset: `${design.padding}px`,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start',
          overflow: 'hidden',
        }}
      >
        <div
          ref={contentRef}
          style={{
            width: '100%',
            transform: `scale(${contentScale})`,
            transformOrigin: 'top center',
          }}
          className="space-y-3"
        >
          {/* Top Logo if placement is 'top' (Canonical White Logo) */}
          {design.logo.show && design.logo.placement === 'top' && (
            <div className="flex justify-center pb-1">
              <AppLogo size={design.logo.size} isQr={true} variant="qr" />
            </div>
          )}

          {/* Render sections in strict configuration order */}
          {design.contentOrder.map((section, idx) => renderSection(section, idx))}
        </div>
      </div>
    </div>
  );
};
