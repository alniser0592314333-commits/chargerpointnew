import React from 'react';
import { useI18n } from '../../i18n/i18nContext';
import { QRDesignConfig } from './types';
import { useActiveQrDesign } from './defaultDesigns';
import { QrDesignRenderer } from './QrDesignRenderer';

export interface OrderQrCardProps {
  orderNumber: number;
  customerName: string;
  qrValue: string;
  design?: QRDesignConfig;
  className?: string;
  cardId?: string;
}

export const OrderQrCard: React.FC<OrderQrCardProps> = ({
  orderNumber,
  customerName,
  qrValue,
  design,
  className = '',
  cardId = 'order-qr-card',
}) => {
  const { locale, t } = useI18n();
  const activeDesign = useActiveQrDesign('ORDER');
  const resolvedDesign = design || activeDesign;

  return (
    <QrDesignRenderer
      identity={{ publicUrl: qrValue }}
      content={{
        orderNumber,
        customerName,
        customerCode: `ORD-${orderNumber}`,
      }}
      design={resolvedDesign}
      locale={locale as 'ar' | 'en'}
      className={className}
      cardId={cardId}
    />
  );
};
