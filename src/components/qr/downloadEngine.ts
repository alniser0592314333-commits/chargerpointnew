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
  const exportScale = width / 380; // Scale the 380px preview card into the export canvas.
  // QR cards are portrait labels. A stale or malformed saved printTarget must not
  // silently turn the exported PNG into a square and create excessive side whitespace.
  const configuredAspectRatio = design.printTarget.heightMm / design.printTarget.widthMm;
  const portraitAspectRatio = Math.max(configuredAspectRatio, 6 / 5);
  const height = Math.round(width * portraitAspectRatio);
  canvas.width = width;
  canvas.height = height;

  // 1. Solid Clean Background with card border
  ctx.save();
  ctx.fillStyle = design.backgroundColor || '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // Subtle clean border matching card boundary
  ctx.strokeStyle = design.borderColor || '#e5e7eb';
  ctx.lineWidth = Math.max(1, exportScale);
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

        let currentY = design.padding * exportScale;

        // The preview renders a top-positioned logo before all configured content sections.
        if (design.logo.show && design.logo.placement === 'top') {
          const topLogoUrl = getCanonicalQrLogo();
          if (topLogoUrl) {
            try {
              const topLogo = new Image();
              topLogo.crossOrigin = 'anonymous';
              await new Promise<void>((resolve, reject) => {
                topLogo.onload = () => resolve();
                topLogo.onerror = () => reject(new Error('Top QR logo failed to load'));
                topLogo.src = topLogoUrl;
                if (topLogo.complete && topLogo.naturalWidth > 0) resolve();
              });
              const topLogoSize = design.logo.size * exportScale;
              ctx.drawImage(topLogo, (width - topLogoSize) / 2, currentY, topLogoSize, topLogoSize);
              currentY += (design.logo.size + design.spacing) * exportScale;
            } catch (e) {
              console.warn('[QR_DOWNLOAD] Failed to draw top logo', e);
            }
          }
        }

        for (const section of design.contentOrder) {
          switch (section) {
            case 'chargingPointTop': {
              if (!design.chargingPointLabel.showTop) break;
              const text =
                locale === 'en'
                  ? design.chargingPointLabel.textEn
                  : design.chargingPointLabel.textAr;
              ctx.font = `bold ${design.typography.titleSize * exportScale}px sans-serif`;
              ctx.fillStyle = design.foregroundColor || '#374151';
              ctx.fillText(text, width / 2, currentY);
              currentY += (design.typography.titleSize + design.spacing) * exportScale;
              break;
            }

            case 'customerName': {
              if (!design.customerName.show || !customerContent?.customerName) break;
              ctx.font = `bold ${design.typography.nameSize * exportScale}px sans-serif`;
              ctx.fillStyle = design.foregroundColor || '#111827';
              ctx.fillText(customerContent.customerName, width / 2, currentY);
              currentY += (design.typography.nameSize + design.spacing * 0.5) * exportScale;
              break;
            }

            case 'customerCode': {
              if (!design.customerCode.show || !customerContent?.customerCode) break;
              const label =
                locale === 'en'
                  ? design.customerCode.labelEn
                  : design.customerCode.labelAr;
              ctx.font = `bold ${design.typography.codeSize * exportScale}px monospace`;
              ctx.fillStyle = design.foregroundColor || '#4b5563';
              ctx.fillText(`${label}: ${customerContent.customerCode}`, width / 2, currentY);
              currentY += (design.typography.codeSize + design.spacing * 0.35) * exportScale;
              break;
            }

            case 'orderHeader': {
              const text =
                locale === 'en'
                  ? design.chargingPointLabel.textEn
                  : design.chargingPointLabel.textAr;
              ctx.font = `bold ${design.typography.titleSize * exportScale}px sans-serif`;
              ctx.fillStyle = design.foregroundColor || '#374151';
              ctx.fillText(text, width / 2, currentY);
              currentY += (design.typography.titleSize + design.spacing) * exportScale;
              break;
            }

            case 'orderNumber': {
              if (!orderContent?.orderNumber) break;
              ctx.font = `bold ${design.typography.nameSize * exportScale}px sans-serif`;
              ctx.fillStyle = design.foregroundColor || '#111827';
              const text =
                locale === 'en'
                  ? `Order #${orderContent.orderNumber}`
                  : `طلب #${orderContent.orderNumber}`;
              ctx.fillText(text, width / 2, currentY);
              currentY += (design.typography.nameSize + design.spacing * 0.5) * exportScale;
              if (orderContent.customerName) {
                ctx.font = `${design.typography.bodySize * exportScale}px sans-serif`;
                ctx.fillStyle = design.foregroundColor || '#4b5563';
                ctx.fillText(orderContent.customerName, width / 2, currentY);
                currentY += (design.typography.bodySize + design.spacing * 0.35) * exportScale;
              }
              break;
            }

            case 'customerSnippet': {
              if (!orderContent?.customerCode) break;
              ctx.font = `${design.typography.codeSize * exportScale}px monospace`;
              ctx.fillStyle = design.foregroundColor || '#6b7280';
              ctx.fillText(orderContent.customerCode, width / 2, currentY);
              currentY += (design.typography.codeSize + design.spacing * 0.35) * exportScale;
              break;
            }

            case 'qrCode': {
              const qrDisplaySize = design.qr.size * exportScale;
              const qrX = (width - qrDisplaySize) / 2;
              const qrY = currentY + design.spacing * exportScale;

              // Draw white background for QR container
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(qrX, qrY, qrDisplaySize, qrDisplaySize);

              // Get True Render Matrix (True Module Knockout conditional on logoVisible)
              const logoVisible = design.logo.show && design.logo.placement === 'center';
              const circleSize = (design.logo.circleSize || 56) * exportScale;
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

              // The preview QR matrix is intentionally black regardless of text foreground color.
              ctx.fillStyle = '#000000';
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
                // Match the preview exactly: the configured logo size is the rendered logo size.
                // The independently configured circleSize controls only the QR knockout/safe zone.
                const logoSize = design.logo.size * exportScale;
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

              currentY = qrY + qrDisplaySize + design.spacing * exportScale;
              break;
            }

            case 'chargingPointBottom': {
              if (!design.chargingPointLabel.showBottom) break;
              const text =
                locale === 'en'
                  ? design.chargingPointLabel.textEn
                  : design.chargingPointLabel.textAr;
              ctx.font = `bold ${design.typography.subtitleSize * exportScale}px sans-serif`;
              ctx.fillStyle = design.foregroundColor || '#4b5563';
              ctx.fillText(text, width / 2, currentY);
              currentY += (design.typography.subtitleSize + design.spacing * 0.35) * exportScale;
              break;
            }

            case 'thankYouMessage': {
              if (!design.thankYouMessage.show) break;
              const text =
                locale === 'en'
                  ? design.thankYouMessage.textEn
                  : design.thankYouMessage.textAr;
              ctx.font = `${design.typography.bodySize * exportScale}px sans-serif`;
              ctx.fillStyle = design.foregroundColor || '#6b7280';
              ctx.fillText(text, width / 2, currentY);
              currentY += (design.typography.bodySize + design.spacing * 0.35) * exportScale;
              break;
            }

            case 'orderFooter': {
              const text =
                locale === 'en'
                  ? design.thankYouMessage.textEn
                  : design.thankYouMessage.textAr;
              ctx.font = `${design.typography.bodySize * exportScale}px sans-serif`;
              ctx.fillStyle = design.foregroundColor || '#6b7280';
              ctx.fillText(text, width / 2, currentY);
              currentY += (design.typography.bodySize + design.spacing * 0.35) * exportScale;
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
              ctx.font = `${Math.max(8, design.typography.bodySize - 1) * exportScale}px monospace`;
              ctx.fillStyle = design.foregroundColor || '#9ca3af';
              ctx.fillText(dateStr, width / 2, currentY);
              currentY += (design.typography.bodySize + design.spacing * 0.25) * exportScale;
              break;
            }

            default:
              break;
          }
        }

        // Trigger download using a real, attached anchor. Mobile Chrome and
        // installed PWAs can silently ignore clicks on detached anchors, which
        // made both customer and order QR buttons appear to do nothing.
        const codeSuffix = customerContent?.customerCode || orderContent?.orderNumber || 'qr';
        const finalFilename = filename || `qr-${codeSuffix}.png`;

        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('QR_IMAGE_EXPORT_FAILED'));
            return;
          }

          const objectUrl = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = objectUrl;
          link.download = finalFilename;
          link.setAttribute('aria-hidden', 'true');
          link.style.position = 'fixed';
          link.style.left = '-10000px';
          document.body.appendChild(link);

          try {
            link.click();
            resolve(true);
          } catch (downloadError) {
            reject(downloadError);
          } finally {
            link.remove();
            // Keep the Blob URL alive briefly so the browser can start the download.
            window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
          }
        }, 'image/png');
      } catch (err) {
        reject(err);
      }
    };
    qrImg.onerror = (err) => reject(err);
    qrImg.src = qrDataUrl;
  });
};
