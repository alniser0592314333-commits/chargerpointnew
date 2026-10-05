import { describe, it, expect, beforeEach } from 'vitest';
import {
  getActiveQrDesign,
  setActiveQrDesign,
  resetActiveQrDesign,
  DEFAULT_CUSTOMER_QR_DESIGN,
  DEFAULT_ORDER_QR_DESIGN,
} from '../components/qr/defaultDesigns';
import {
  getCustomerQrCardData,
  getOrCreateCustomerQrToken,
  resetStoreMemory,
  seedDemoOperationalData,
} from '../components/pages/dayOrdersStore';
import { QRDesignConfig } from '../components/qr/types';
import { downloadQrCard } from '../components/qr/downloadEngine';
import { localDb } from '../infrastructure/localDb/localDb';

describe('Phase 6.5.4B: QR Design Settings UX & Draft/Active Decoupling', () => {
  beforeEach(async () => {
    await localDb.clear();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    resetStoreMemory();
    await seedDemoOperationalData();
    resetActiveQrDesign('CUSTOMER');
    resetActiveQrDesign('ORDER');
  });

  // 1. Decoupled Identity: QR Identity is 100% separate from Design Settings
  it('1. QR Identity remains completely unaffected by Design configuration updates', async () => {
    const initialData = await getCustomerQrCardData('cust-1');
    const initialToken = initialData!.token;
    const initialUrl = initialData!.publicUrl;

    // Simulate saving a radical design change in Settings UI
    const updatedCustomerDesign: QRDesignConfig = {
      ...getActiveQrDesign('CUSTOMER'),
      backgroundColor: '#111827',
      foregroundColor: '#f3f4f6',
      template: 'badge',
      borderRadius: 16,
      date: { show: false, format: 'YYYY/MM/DD' },
      logo: { show: true, placement: 'top', size: 48 },
      version: 2,
    };
    setActiveQrDesign('CUSTOMER', updatedCustomerDesign);

    // Re-fetch customer QR card data
    const afterData = await getCustomerQrCardData('cust-1');
    expect(afterData!.token).toBe(initialToken);
    expect(afterData!.publicUrl).toBe(initialUrl);
    expect(afterData!.customerName).toBe(initialData!.customerName);
    expect(afterData!.customerCode).toBe(initialData!.customerCode);
  });

  // 2. Independence: CUSTOMER changes do not affect ORDER design
  it('2. CUSTOMER design modifications do not mutate ORDER design configuration', () => {
    const initialOrderDesign = { ...getActiveQrDesign('ORDER') };

    const modifiedCustomerDesign: QRDesignConfig = {
      ...getActiveQrDesign('CUSTOMER'),
      backgroundColor: '#fef08a',
      foregroundColor: '#854d0e',
      borderRadius: 24,
      template: 'minimal',
    };
    setActiveQrDesign('CUSTOMER', modifiedCustomerDesign);

    const currentCustomerDesign = getActiveQrDesign('CUSTOMER');
    const currentOrderDesign = getActiveQrDesign('ORDER');

    expect(currentCustomerDesign.backgroundColor).toBe('#fef08a');
    expect(currentOrderDesign.backgroundColor).toBe(initialOrderDesign.backgroundColor);
    expect(currentOrderDesign.template).toBe(initialOrderDesign.template);
    expect(currentOrderDesign.borderRadius).toBe(initialOrderDesign.borderRadius);
  });

  // 3. Independence: ORDER changes do not affect CUSTOMER design
  it('3. ORDER design modifications do not mutate CUSTOMER design configuration', () => {
    const initialCustomerDesign = { ...getActiveQrDesign('CUSTOMER') };

    const modifiedOrderDesign: QRDesignConfig = {
      ...getActiveQrDesign('ORDER'),
      backgroundColor: '#0f172a',
      foregroundColor: '#38bdf8',
      borderRadius: 0,
      template: 'badge',
    };
    setActiveQrDesign('ORDER', modifiedOrderDesign);

    const currentCustomerDesign = getActiveQrDesign('CUSTOMER');
    const currentOrderDesign = getActiveQrDesign('ORDER');

    expect(currentOrderDesign.backgroundColor).toBe('#0f172a');
    expect(currentCustomerDesign.backgroundColor).toBe(initialCustomerDesign.backgroundColor);
    expect(currentCustomerDesign.template).toBe(initialCustomerDesign.template);
  });

  // 4. Reset to default restores only the targeted type
  it('4. Resetting CUSTOMER restores default without affecting custom ORDER configuration', () => {
    setActiveQrDesign('CUSTOMER', {
      ...getActiveQrDesign('CUSTOMER'),
      backgroundColor: '#123456',
    });
    setActiveQrDesign('ORDER', {
      ...getActiveQrDesign('ORDER'),
      backgroundColor: '#654321',
    });

    // Reset customer only
    resetActiveQrDesign('CUSTOMER');

    const customerDesign = getActiveQrDesign('CUSTOMER');
    const orderDesign = getActiveQrDesign('ORDER');

    expect(customerDesign.backgroundColor).toBe(DEFAULT_CUSTOMER_QR_DESIGN.backgroundColor);
    expect(orderDesign.backgroundColor).toBe('#654321');
  });

  // 5. Resetting ORDER restores default without affecting custom CUSTOMER configuration
  it('5. Resetting ORDER restores default without affecting custom CUSTOMER configuration', () => {
    setActiveQrDesign('CUSTOMER', {
      ...getActiveQrDesign('CUSTOMER'),
      backgroundColor: '#112233',
    });
    setActiveQrDesign('ORDER', {
      ...getActiveQrDesign('ORDER'),
      backgroundColor: '#445566',
    });

    resetActiveQrDesign('ORDER');

    const customerDesign = getActiveQrDesign('CUSTOMER');
    const orderDesign = getActiveQrDesign('ORDER');

    expect(customerDesign.backgroundColor).toBe('#112233');
    expect(orderDesign.backgroundColor).toBe(DEFAULT_ORDER_QR_DESIGN.backgroundColor);
  });

  // 6. Section Reordering: Content order modification works cleanly
  it('6. Section reordering updates contentOrder without corrupting sections', () => {
    const defaultDesign = getActiveQrDesign('CUSTOMER');
    const invertedOrder = [...defaultDesign.contentOrder].reverse();

    const updatedDesign: QRDesignConfig = {
      ...defaultDesign,
      contentOrder: invertedOrder,
    };
    setActiveQrDesign('CUSTOMER', updatedDesign);

    const retrievedDesign = getActiveQrDesign('CUSTOMER');
    expect(retrievedDesign.contentOrder).toEqual(invertedOrder);
    expect(retrievedDesign.contentOrder.length).toBe(defaultDesign.contentOrder.length);
  });

  // 7. Typography and Spacing Configuration persists
  it('7. Typography and spacing adjustments persist correctly', () => {
    const modifiedDesign: QRDesignConfig = {
      ...getActiveQrDesign('CUSTOMER'),
      typography: {
        titleSize: 18,
        nameSize: 16,
        codeSize: 14,
        subtitleSize: 12,
        bodySize: 13,
      },
      padding: 24,
      spacing: 16,
      qr: {
        size: 190,
        errorCorrectionLevel: 'M',
        margin: 2,
      },
    };
    setActiveQrDesign('CUSTOMER', modifiedDesign);

    const retrieved = getActiveQrDesign('CUSTOMER');
    expect(retrieved.typography.titleSize).toBe(18);
    expect(retrieved.typography.bodySize).toBe(13);
    expect(retrieved.padding).toBe(24);
    expect(retrieved.spacing).toBe(16);
    expect(retrieved.qr.size).toBe(190);
  });

  // 8. Logo placement settings persist correctly
  it('8. Logo placement and size settings persist correctly', () => {
    const modifiedDesign: QRDesignConfig = {
      ...getActiveQrDesign('CUSTOMER'),
      logo: {
        show: true,
        placement: 'top',
        size: 52,
      },
    };
    setActiveQrDesign('CUSTOMER', modifiedDesign);

    const retrieved = getActiveQrDesign('CUSTOMER');
    expect(retrieved.logo.show).toBe(true);
    expect(retrieved.logo.placement).toBe('top');
    expect(retrieved.logo.size).toBe(52);
  });

  // 9. Opening/Viewing Customer QR never triggers Save or alters Active Design
  it('9. Opening or viewing Customer QR does not mutate active design or require save', async () => {
    const activeDesignBefore = { ...getActiveQrDesign('CUSTOMER') };
    const cardData = await getCustomerQrCardData('cust-2');
    expect(cardData).not.toBeNull();
    const activeDesignAfter = getActiveQrDesign('CUSTOMER');
    expect(activeDesignAfter).toEqual(activeDesignBefore);
  });

  // 10. Downloading QR card never triggers Save or alters Active Design
  it('10. Downloading QR card uses active design without altering active configuration', async () => {
    const activeDesignBefore = { ...getActiveQrDesign('CUSTOMER') };
    const cardData = await getCustomerQrCardData('cust-3');
    
    await downloadQrCard({
      identity: { publicUrl: cardData!.publicUrl, publicToken: cardData!.token },
      content: { customerName: cardData!.customerName, customerCode: cardData!.customerCode },
      design: activeDesignBefore,
      locale: 'ar',
    });

    const activeDesignAfter = getActiveQrDesign('CUSTOMER');
    expect(activeDesignAfter).toEqual(activeDesignBefore);
  });
});
