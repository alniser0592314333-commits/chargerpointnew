/**
 * Default QR Design Configurations & Active Design Resolver
 * Phase 6.5.3: QR Design System Foundation
 *
 * Provides:
 * - Independent configurations for CUSTOMER_QR vs ORDER_QR.
 * - Configuration-driven layout (not hardcoded JSX).
 * - Default design with logo.placement = 'none' (Download without logo).
 * - Standard 5 x 6 cm print target specification.
 * - Idempotent active design resolution (fallback to defaults without DB migration).
 */

import { QRDesignConfig, QRDesignType } from './types';

export const DEFAULT_CUSTOMER_QR_DESIGN: QRDesignConfig = {
  id: 'default-customer-v1',
  designType: 'CUSTOMER',
  version: 1,
  name: 'Standard Customer Label',
  template: 'standard',

  // Appearance
  backgroundColor: '#ffffff',
  foregroundColor: '#111827',
  borderColor: '#e5e7eb',
  borderRadius: 16,
  padding: 24,
  spacing: 16,

  // Typography Scale (px)
  typography: {
    titleSize: 12,
    nameSize: 22,
    codeSize: 13,
    subtitleSize: 12,
    bodySize: 11,
  },

  // Logo Decoration: Defaults to 'none' as requested (Download without logo)
  logo: {
    show: false,
    placement: 'none',
    size: 36,
    circleSize: 56,
  },

  // QR Matrix Parameters
  qr: {
    size: 210,
    errorCorrectionLevel: 'H',
    margin: 1,
  },

  // Content Visibility & Placements
  customerName: {
    show: true,
    placement: 'header',
  },
  customerCode: {
    show: true,
    placement: 'header',
    labelAr: 'الرمز التعريفي',
    labelEn: 'Customer ID',
  },
  chargingPointLabel: {
    showTop: true,
    showBottom: true,
    textAr: 'نقطة الشحن',
    textEn: 'Charging Point',
  },
  thankYouMessage: {
    show: true,
    textAr: 'شكرًا لتعاملكم معنا',
    textEn: 'Thank you for your business',
  },
  date: {
    show: true,
    format: 'YYYY-MM-DD',
  },

  // Configuration-driven layout order
  contentOrder: [
    'chargingPointTop',
    'customerName',
    'customerCode',
    'qrCode',
    'chargingPointBottom',
    'thankYouMessage',
    'date',
  ],

  // Print target: Standard 5 x 6 cm label
  printTarget: {
    widthMm: 50,
    heightMm: 60,
    ratio: '5:6',
  },
};

export const DEFAULT_ORDER_QR_DESIGN: QRDesignConfig = {
  id: 'default-order-v1',
  designType: 'ORDER',
  version: 1,
  name: 'Standard Order Receipt Tag',
  template: 'standard',

  // Appearance
  backgroundColor: '#ffffff',
  foregroundColor: '#111827',
  borderColor: '#e5e7eb',
  borderRadius: 16,
  padding: 24,
  spacing: 16,

  // Typography Scale
  typography: {
    titleSize: 12,
    nameSize: 20,
    codeSize: 14,
    subtitleSize: 12,
    bodySize: 11,
  },

  // Logo Decoration: Defaults to 'none'
  logo: {
    show: false,
    placement: 'none',
    size: 36,
    circleSize: 56,
  },

  qr: {
    size: 210,
    errorCorrectionLevel: 'H',
    margin: 1,
  },

  customerName: {
    show: true,
    placement: 'body',
  },
  customerCode: {
    show: false,
    placement: 'body',
    labelAr: 'الرمز التعريفي',
    labelEn: 'Customer ID',
  },
  chargingPointLabel: {
    showTop: true,
    showBottom: false,
    textAr: 'نقطة الشحن',
    textEn: 'Charging Point',
  },
  thankYouMessage: {
    show: true,
    textAr: 'شكرًا لتعاملكم معنا',
    textEn: 'Thank you for your business',
  },
  date: {
    show: true,
    format: 'YYYY-MM-DD',
  },

  contentOrder: [
    'orderHeader',
    'orderNumber',
    'customerSnippet',
    'qrCode',
    'orderFooter',
    'date',
  ],

  printTarget: {
    widthMm: 50,
    heightMm: 60,
    ratio: '5:6',
  },
};

// In-Memory & Persistent Active Design Store (Separate for Customer vs Order)
const STORAGE_KEY_PREFIX = 'app_qr_design_config_';

function loadStoredDesign(type: QRDesignType, defaultDesign: QRDesignConfig): QRDesignConfig {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return { ...defaultDesign };
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + type);
    if (!raw) return { ...defaultDesign };
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.designType === type) {
      return { ...defaultDesign, ...parsed };
    }
  } catch (err) {
    console.warn(`Failed to load stored QR design for ${type}:`, err);
  }
  return { ...defaultDesign };
}

function saveStoredDesign(type: QRDesignType, design: QRDesignConfig): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.setItem(STORAGE_KEY_PREFIX + type, JSON.stringify(design));
    }
  } catch (err) {
    console.warn(`Failed to save QR design for ${type}:`, err);
  }
}

type QrDesignListener = (type: QRDesignType, design: QRDesignConfig, source: 'local' | 'remote') => void;
const qrDesignListeners = new Set<QrDesignListener>();

export const subscribeQrDesignChanges = (listener: QrDesignListener): (() => void) => {
  qrDesignListeners.add(listener);
  return () => qrDesignListeners.delete(listener);
};

function emitQrDesignChange(type: QRDesignType, design: QRDesignConfig, source: 'local' | 'remote'): void {
  const snapshot = JSON.parse(JSON.stringify(design)) as QRDesignConfig;
  qrDesignListeners.forEach((listener) => {
    try { listener(type, snapshot, source); }
    catch (error) { console.warn('QR design listener failed:', error); }
  });
}

const activeDesigns: Record<QRDesignType, QRDesignConfig> = {
  CUSTOMER: loadStoredDesign('CUSTOMER', DEFAULT_CUSTOMER_QR_DESIGN),
  ORDER: loadStoredDesign('ORDER', DEFAULT_ORDER_QR_DESIGN),
};

/**
 * Resolves the active QR design for the given type.
 * Returns custom active design if set, otherwise returns the default design.
 * Pure presentation resolver: NEVER generates tokens or calls APIs.
 */
export const getActiveQrDesign = (type: QRDesignType): QRDesignConfig => {
  const current = activeDesigns[type] || (type === 'CUSTOMER' ? DEFAULT_CUSTOMER_QR_DESIGN : DEFAULT_ORDER_QR_DESIGN);
  return JSON.parse(JSON.stringify(current));
};

/**
 * Sets a custom active design for a specific type without affecting the other type.
 * Persists durably to localStorage.
 */
export const setActiveQrDesign = (type: QRDesignType, design: QRDesignConfig, source: 'local' | 'remote' = 'local'): void => {
  if (design.designType !== type) {
    throw new Error(`Design type mismatch: expected ${type}, got ${design.designType}`);
  }
  const validated = { ...design, version: design.version || 1 };
  activeDesigns[type] = JSON.parse(JSON.stringify(validated));
  saveStoredDesign(type, activeDesigns[type]);
  emitQrDesignChange(type, activeDesigns[type], source);
};

/**
 * Resets active design to default for a specific type and persists.
 */
export const resetActiveQrDesign = (type: QRDesignType): void => {
  if (type === 'CUSTOMER') {
    activeDesigns.CUSTOMER = { ...DEFAULT_CUSTOMER_QR_DESIGN };
    saveStoredDesign('CUSTOMER', activeDesigns.CUSTOMER);
    emitQrDesignChange('CUSTOMER', activeDesigns.CUSTOMER, 'local');
  } else {
    activeDesigns.ORDER = { ...DEFAULT_ORDER_QR_DESIGN };
    saveStoredDesign('ORDER', activeDesigns.ORDER);
    emitQrDesignChange('ORDER', activeDesigns.ORDER, 'local');
  }
};
