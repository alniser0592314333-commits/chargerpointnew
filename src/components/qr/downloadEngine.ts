/**
 * QR Download & Canvas Rendering Engine
 * Phase 6.5.3: QR Design System Foundation
 *
 * Requirements:
 * 1. Preview == Download == Print in terms of layout, text, QR, logo, and spacing.
 * 2. Deterministic target: 5 x 6 cm proportional label (ratio 5:6).
 * 3. Default design has logoPlacement: 'none' -> Downloaded image has ZERO logo in center!
 * 4. Pure presentation: NEVER generates, modifies, or rotates QR identities.
 */

import QRCode from 'qrcode';
import { QRDesignConfig, QRCustomerContent, QROrderContent } from './types';
import { getCanonicalQrLogo } from '../../services/storage/logoStorage';
import { calculateLogoPosition, calculateLogoSafeZone, getCircularSafeZone, createQrRenderMatrix } from './qrGeometry';

export interface DownloadQrCardOptions {
  identity: {
    publicUrl: string;
    publicToken?: string;
  };
  content: QRCustomerContent | QROrderContent;
  design: QRDesignConfig;
  locale?: 'ar' | 'en';
  filename?: string;
}

export const downloadQrCard = async ({
  identity,
  content,
  design,
  locale = 'ar',
  filename,
}: DownloadQrCardOptions): Promise<boolean> => {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return false;
  }

  const isOrder = 'orderNumber' in content || design.designType === 'ORDER';
  const orderContent = isOrder ? (content as QROrderContent) : null;
  const customerContent = !isOrder ? (content as QRCustomerContent) : null;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  // High-resolution canvas matching 5 x 6 cm ratio (e.g. 600 x 720 px)
  const width = 600;
  const height = 720;
  canvas.width = width;
  canvas.height = height;

  // 1. Solid Clean Background with card border
  ctx.save();
  ctx.fillStyle = design.backgroundColor || '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // Subtle clean border matching card boundary
  ctx.strokeStyle = design.borderColor || '#e5e7eb';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, width - 4, height - 4);
  ctx.restore();

  // 2. Generate QR Code Data URL
  const qrDataUrl = await QRCode.toDataURL(identity.publicUrl, {
    width: 440,
    margin: design.qr.margin || 1,
    errorCorrectionLevel: design.qr.errorCorrectionLevel || 'H',
    color: {
      dark: '#000000',
      light: '#ffffff',
    },
  });

  return new Promise((resolve, reject) => {
    const qrImg = new Image();
    qrImg.onload = async () => {
      try {
        ctx.textAlign = 'center';

        let currentY = 55;

        for (const section of design.contentOrder) {
          switch (section) {
            case 'chargingPointTop': {
              if (!design.chargingPointLabel.showTop) break;
              const text =
                locale === 'en'
                  ? design.chargingPointLabel.textEn
                  : design.chargingPointLabel.textAr;
              ctx.font = 'bold 18px sans-serif';
              ctx.fillStyle = '#374151';
              ctx.fillText(text, width / 2, currentY);
              currentY += 40;
              break;
            }

            case 'customerName': {
              if (!design.customerName.show || !customerContent?.customerName) break;
              ctx.font = 'bold 30px sans-serif';
              ctx.fillStyle = design.foregroundColor || '#111827';
              ctx.fillText(customerContent.customerName, width / 2, currentY);
              currentY += 36;
              break;
            }

            case 'customerCode': {
              if (!design.customerCode.show || !customerContent?.customerCode) break;
              const label =
                locale === 'en'
                  ? design.customerCode.labelEn
                  : design.customerCode.labelAr;
              ctx.font = 'bold 18px monospace';
              ctx.fillStyle = '#4b5563';
              ctx.fillText(`${label}: ${customerContent.customerCode}`, width / 2, currentY);
              currentY += 28;
              break;
            }

            case 'orderHeader': {
              const text =
                locale === 'en'
                  ? design.chargingPointLabel.textEn
                  : design.chargingPointLabel.textAr;
              ctx.font = 'bold 18px sans-serif';
              ctx.fillStyle = '#374151';
              ctx.fillText(text, width / 2, currentY);
              currentY += 40;
              break;
            }

            case 'orderNumber': {
              if (!orderContent?.orderNumber) break;
              ctx.font = 'bold 30px sans-serif';
              ctx.fillStyle = design.foregroundColor || '#111827';
              const text =
                locale === 'en'
                  ? `Order #${orderContent.orderNumber}`
                  : `طلب #${orderContent.orderNumber}`;
              ctx.fillText(text, width / 2, currentY);
              currentY += 34;
              if (orderContent.customerName) {
                ctx.font = 'bold 18px sans-serif';
                ctx.fillStyle = '#4b5563';
                ctx.fillText(orderContent.customerName, width / 2, currentY);
                currentY += 28;
              }
              break;
            }

            case 'customerSnippet': {
              if (!orderContent?.customerCode) break;
              ctx.font = '16px monospace';
              ctx.fillStyle = '#6b7280';
              ctx.fillText(orderContent.customerCode, width / 2, currentY);
              currentY += 24;
              break;
            }

            case 'qrCode': {
              const qrDisplaySize = 340;
              const qrX = (width - qrDisplaySize) / 2;
              const qrY = currentY + 5;

              // Draw white background for QR container
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(qrX, qrY, qrDisplaySize, qrDisplaySize);

              // Get True Render Matrix (True Module Knockout conditional on logoVisible)
              const logoVisible = design.logo.show && design.logo.placement === 'center';
              const circleSize = design.logo.circleSize || 56;
              const renderResult = createQrRenderMatrix(
                identity.publicUrl,
                design.qr.errorCorrectionLevel,
                design.qr.margin,
                circleSize,
                qrDisplaySize,
                logoVisible
              );

              const totalUnits = renderResult.size;
              const moduleSize = qrDisplaySize / totalUnits;

              ctx.fillStyle = design.foregroundColor || '#000000';
              for (let r = 0; r < totalUnits; r++) {
                for (let c = 0; c < totalUnits; c++) {
                  if (renderResult.matrix[r][c]) {
                    ctx.fillRect(
                      qrX + c * moduleSize,
                      qrY + r * moduleSize,
                      moduleSize + 0.05,
                      moduleSize + 0.05
                    );
                  }
                }
              }

              // ONLY draw center logo if design explicitly enables it with placement 'center'
              // Default design has placement: 'none' -> ZERO logo in center!
              if (design.logo.show && design.logo.placement === 'center') {
                const logoSize = design.logo.size * 1.5;
                const pos = calculateLogoPosition(
                  qrX,
                  qrY,
                  qrDisplaySize,
                  logoSize,
                  identity.publicUrl,
                  design.qr.errorCorrectionLevel,
                  design.qr.margin
                );
                const logoX = pos.logoX;
                const logoY = pos.logoY;

                // Pristine Center Logo rendering (NO white circle overlay/arc!)
                const qrLogoUrl = getCanonicalQrLogo();
                if (qrLogoUrl) {
                  try {
                    const centerImg = new Image();
                    centerImg.crossOrigin = 'anonymous';
                    await new Promise<void>((resolve, reject) => {
                      centerImg.onload = () => resolve();
                      centerImg.onerror = () => reject(new Error('Center QR logo failed to load'));
                      centerImg.src = qrLogoUrl;

                      // Handle cached data URLs and already-completed image requests.
                      if (centerImg.complete && centerImg.naturalWidth > 0) {
                        resolve();
                      }
                    });
                    ctx.drawImage(centerImg, logoX, logoY, logoSize, logoSize);
                  } catch (e) {
                    // Keep the QR downloadable if the optional logo cannot be loaded.
                    console.warn('[QR_DOWNLOAD] Failed to draw center logo', e);
                  }
                }
              }

              currentY = qrY + qrDisplaySize + 28;
              break;
            }

            case 'chargingPointBottom': {
              if (!design.chargingPointLabel.showBottom) break;
              const text =
                locale === 'en'
                  ? design.chargingPointLabel.textEn
                  : design.chargingPointLabel.textAr;
              ctx.font = 'bold 18px sans-serif';
              ctx.fillStyle = '#4b5563';
              ctx.fillText(text, width / 2, currentY);
              currentY += 28;
              break;
            }

            case 'thankYouMessage': {
              if (!design.thankYouMessage.show) break;
              const text =
                locale === 'en'
                  ? design.thankYouMessage.textEn
                  : design.thankYouMessage.textAr;
              ctx.font = 'medium 15px sans-serif';
              ctx.fillStyle = '#6b7280';
              ctx.fillText(text, width / 2, currentY);
              currentY += 24;
              break;
            }

            case 'orderFooter': {
              const text =
                locale === 'en'
                  ? design.thankYouMessage.textEn
                  : design.thankYouMessage.textAr;
              ctx.font = 'medium 15px sans-serif';
              ctx.fillStyle = '#6b7280';
              ctx.fillText(text, width / 2, currentY);
              currentY += 24;
              break;
            }

            case 'date': {
              if (!design.date.show) break;
              const now = new Date();
              const dateStr =
                content.date ||
                (design.date.format === 'YYYY/MM/DD'
                  ? `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`
                  : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`);
              ctx.font = '13px monospace';
              ctx.fillStyle = '#9ca3af';
              ctx.fillText(dateStr, width / 2, currentY);
              currentY += 20;
              break;
            }

            default:
              break;
          }
        }

        // Trigger download
        const codeSuffix = customerContent?.customerCode || orderContent?.orderNumber || 'qr';
        const finalFilename = filename || `qr-${codeSuffix}.png`;
        const link = document.createElement('a');
        link.download = finalFilename;
        link.href = canvas.toDataURL('image/png');
        link.click();
        resolve(true);
      } catch (err) {
        reject(err);
      }
    };
    qrImg.onerror = (err) => reject(err);
    qrImg.src = qrDataUrl;
  });
};
