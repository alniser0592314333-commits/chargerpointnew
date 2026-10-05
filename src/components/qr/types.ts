/**
 * QR Design System Foundation Types
 * Phase 6.5.3: QR Design System Foundation
 *
 * Core Principle: Strict Separation of Concerns:
 * - QR Identity: stable public identifier & capability metadata
 * - QR Content: sanitized public-safe data allowed to appear in card
 * - QR Design: visual configuration (layout, colors, spacing, logo, typography)
 * - QR Renderer: presentation-only function render(identity, content, design, locale)
 */

export type QRDesignType = 'CUSTOMER' | 'ORDER';

export type QRLogoPlacement = 'none' | 'center' | 'top';

export type QRTemplateType = 'standard' | 'minimal' | 'badge';

export type QRCustomerSection =
  | 'chargingPointTop'
  | 'customerName'
  | 'customerCode'
  | 'qrCode'
  | 'chargingPointBottom'
  | 'thankYouMessage'
  | 'date';

export type QROrderSection =
  | 'orderHeader'
  | 'orderNumber'
  | 'customerSnippet'
  | 'qrCode'
  | 'orderFooter'
  | 'date';

export interface QRTypographyConfig {
  titleSize: number; // in px
  nameSize: number;
  codeSize: number;
  subtitleSize: number;
  bodySize: number;
}

export interface QRLogoConfig {
  show: boolean;
  placement: QRLogoPlacement;
  size: number; // in px
  circleSize?: number; // in px
  url?: string;
}

export interface QRMatrixConfig {
  size: number; // in px on screen preview
  errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H';
  margin: number;
}

export interface QRDesignConfig {
  id: string;
  designType: QRDesignType;
  version: number;
  name: string;
  template: QRTemplateType;

  // Visual appearance
  backgroundColor: string;
  foregroundColor: string;
  borderColor: string;
  borderRadius: number; // in px
  padding: number; // in px
  spacing: number; // in px

  // Typography scale
  typography: QRTypographyConfig;

  // Logo decoration
  logo: QRLogoConfig;

  // QR Matrix properties
  qr: QRMatrixConfig;

  // Content visibility & placements
  customerName: {
    show: boolean;
    placement: 'header' | 'body';
  };
  customerCode: {
    show: boolean;
    placement: 'header' | 'body';
    labelAr: string;
    labelEn: string;
  };
  chargingPointLabel: {
    showTop: boolean;
    showBottom: boolean;
    textAr: string;
    textEn: string;
  };
  thankYouMessage: {
    show: boolean;
    textAr: string;
    textEn: string;
  };
  date: {
    show: boolean;
    format: 'YYYY-MM-DD' | 'YYYY/MM/DD';
  };

  // Section order layout (configuration-driven instead of hardcoded JSX)
  contentOrder: (QRCustomerSection | QROrderSection)[];

  // Target print dimensions (standardized to 50mm x 60mm = 5 x 6 cm)
  printTarget: {
    widthMm: number;
    heightMm: number;
    ratio: string; // '5:6'
  };
}

export interface QRIdentity {
  type: QRDesignType;
  targetId: string;
  publicToken: string;
  publicUrl: string;
  status: 'ACTIVE' | 'REVOKED' | 'ROTATED';
}

export interface QRCustomerContent {
  customerName: string;
  customerCode: string;
  date?: string;
}

export interface QROrderContent {
  orderNumber: number;
  displayNumber?: number;
  customerName?: string;
  customerCode?: string;
  itemsCount?: number;
  date?: string;
}

export type QRContent = QRCustomerContent | QROrderContent;
