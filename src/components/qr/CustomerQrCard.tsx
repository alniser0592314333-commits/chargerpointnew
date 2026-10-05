import React from 'react';
import { useI18n } from '../../i18n/i18nContext';
import { QRDesignConfig } from './types';
import { getActiveQrDesign } from './defaultDesigns';
import { QrDesignRenderer } from './QrDesignRenderer';

export interface CustomerQrCardProps {
  customerName: string;
  customerCode: string;
  qrValue: string;
  design?: QRDesignConfig;
  className?: string;
  cardId?: string;
}

/**
 * Customer QR Card Component
 * Strictly decoupled presentation layer delegating to the configuration-driven QrDesignRenderer.
 *
 * Rules:
 * - Uses active Customer QR design by default (or custom design prop override).
 * - Contains ZERO identity mutation logic.
 * - Respects logo placement (default: 'none' -> no center logo).
 * - Preserves customerName exactly as stored (never translated).
 */
export const CustomerQrCard: React.FC<CustomerQrCardProps> = ({
  customerName,
  customerCode,
  qrValue,
  design,
  className = '',
  cardId = 'customer-qr-card',
}) => {
  const { locale } = useI18n();
  const activeDesign = design || getActiveQrDesign('CUSTOMER');

  return (
    <QrDesignRenderer
      identity={{ publicUrl: qrValue }}
      content={{ customerName, customerCode }}
      design={activeDesign}
      locale={locale as 'ar' | 'en'}
      className={className}
      cardId={cardId}
    />
  );
};
