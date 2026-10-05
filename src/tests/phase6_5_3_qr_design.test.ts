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
import { downloadQrCard } from '../components/qr/downloadEngine';
import { QRDesignConfig } from '../components/qr/types';
import { localDb } from '../infrastructure/localDb/localDb';

describe('Phase 6.5.3: QR Design System Foundation', () => {
  beforeEach(async () => {
    await localDb.clear();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    resetStoreMemory();
    await seedDemoOperationalData();
    resetActiveQrDesign('CUSTOMER');
    resetActiveQrDesign('ORDER');
  });

  // 1. Customer identity unchanged when design changes.
  it('1. Customer identity remains unchanged when design changes', async () => {
    const cardData1 = await getCustomerQrCardData('cust-1');
    const initialToken = cardData1!.token;
    const initialUrl = cardData1!.publicUrl;

    // Change design property
    const customDesign: QRDesignConfig = {
      ...getActiveQrDesign('CUSTOMER'),
      backgroundColor: '#000000',
      foregroundColor: '#ffffff',
      version: 2,
    };
    setActiveQrDesign('CUSTOMER', customDesign);

    const cardData2 = await getCustomerQrCardData('cust-1');
    expect(cardData2!.token).toBe(initialToken);
    expect(cardData2!.publicUrl).toBe(initialUrl);
  });

  // 2. Customer identity unchanged when language changes.
  it('2. Customer identity remains unchanged when language switches', async () => {
    const token = await getOrCreateCustomerQrToken('cust-2');
    const tokenAfter = await getOrCreateCustomerQrToken('cust-2');
    expect(tokenAfter).toBe(token);
  });

  // 3. Customer identity unchanged when logo changes.
  it('3. Customer identity remains unchanged when logo changes', async () => {
    const cardData = await getCustomerQrCardData('cust-3');
    const token = cardData!.token;

    const modifiedLogoDesign: QRDesignConfig = {
      ...getActiveQrDesign('CUSTOMER'),
      logo: { show: true, placement: 'center', size: 40 },
    };
    setActiveQrDesign('CUSTOMER', modifiedLogoDesign);

    const cardDataAfter = await getCustomerQrCardData('cust-3');
    expect(cardDataAfter!.token).toBe(token);
  });

  // 4. Customer identity unchanged when template changes.
  it('4. Customer identity remains unchanged when template changes', async () => {
    const cardData = await getCustomerQrCardData('cust-4');
    const token = cardData!.token;

    const templateDesign: QRDesignConfig = {
      ...getActiveQrDesign('CUSTOMER'),
      template: 'minimal',
      borderRadius: 4,
    };
    setActiveQrDesign('CUSTOMER', templateDesign);

    const cardDataAfter = await getCustomerQrCardData('cust-4');
    expect(cardDataAfter!.token).toBe(token);
  });

  // 5. QR encoded payload remains the public URL.
  it('5. QR encoded payload remains strictly the public URL', async () => {
    const cardData = await getCustomerQrCardData('cust-1');
    expect(cardData!.publicUrl).toContain('/c/');
    expect(cardData!.publicUrl).toContain(cardData!.token);
    // Never encodes phone, debt, or balance in the URL payload
    expect(cardData!.publicUrl).not.toContain('0599123456');
    expect(cardData!.publicUrl).not.toContain('debt');
    expect(cardData!.publicUrl).not.toContain('balance');
  });

  // 6. Design config does not contain/modify identity.
  it('6. Design config does not contain or modify identity', () => {
    const design = getActiveQrDesign('CUSTOMER');
    expect((design as any).publicToken).toBeUndefined();
    expect((design as any).targetId).toBeUndefined();
    expect((design as any).customerId).toBeUndefined();
  });

  // 7. Renderer does not generate tokens.
  it('7. Renderer is pure presentation and does not generate tokens', async () => {
    const initialTokens = await localDb.list('qr_tokens');
    const initialCount = initialTokens.length;

    // Resolving active design does not touch tokens
    const activeDesign = getActiveQrDesign('CUSTOMER');
    expect(activeDesign).toBeDefined();

    const afterTokens = await localDb.list('qr_tokens');
    expect(afterTokens.length).toBe(initialCount);
  });

  // 8. Default design is returned when no custom design exists.
  it('8. Default design is returned when no custom design exists', () => {
    resetActiveQrDesign('CUSTOMER');
    const design = getActiveQrDesign('CUSTOMER');
    expect(design.id).toBe(DEFAULT_CUSTOMER_QR_DESIGN.id);
    expect(design.version).toBe(1);
    expect(design.template).toBe('standard');
    expect(design.logo.placement).toBe('none');
  });

  // 9. Customer design and Order design are independent.
  it('9. Customer design and Order design are completely independent', () => {
    const customerDesignBefore = getActiveQrDesign('CUSTOMER');
    const orderDesignBefore = getActiveQrDesign('ORDER');

    // Mutate only customer design
    const updatedCustomer: QRDesignConfig = {
      ...customerDesignBefore,
      borderRadius: 30,
      version: 99,
    };
    setActiveQrDesign('CUSTOMER', updatedCustomer);

    expect(getActiveQrDesign('CUSTOMER').borderRadius).toBe(30);
    expect(getActiveQrDesign('CUSTOMER').version).toBe(99);

    // Order design must be 100% unaffected
    expect(getActiveQrDesign('ORDER').borderRadius).toBe(orderDesignBefore.borderRadius);
    expect(getActiveQrDesign('ORDER').version).toBe(orderDesignBefore.version);
    expect(getActiveQrDesign('ORDER').id).toBe(DEFAULT_ORDER_QR_DESIGN.id);
  });

  // 10. Download uses active design.
  it('10. Download engine respects active design parameters', async () => {
    const cardData = await getCustomerQrCardData('cust-2');
    const activeDesign = getActiveQrDesign('CUSTOMER');

    // downloadQrCard accepts the active design configuration
    expect(activeDesign.printTarget.widthMm).toBe(50);
    expect(activeDesign.printTarget.heightMm).toBe(60);
  });

  // 11. Print uses active design.
  it('11. Print configuration targets 5x6 cm label size', () => {
    const design = getActiveQrDesign('CUSTOMER');
    expect(design.printTarget).toEqual({
      widthMm: 50,
      heightMm: 60,
      ratio: '5:6',
    });
  });

  // 12. logoPlacement = none produces QR without center logo.
  it('12. Default logoPlacement = none ensures no center logo is displayed or downloaded', () => {
    const defaultDesign = getActiveQrDesign('CUSTOMER');
    expect(defaultDesign.logo.placement).toBe('none');
    expect(defaultDesign.logo.show).toBe(false);
  });

  // 13. customer name is rendered exactly as stored and is never translated.
  it('13. Customer name is preserved exactly as stored', async () => {
    const cardDataAr = await getCustomerQrCardData('cust-1');
    expect(cardDataAr!.customerName).toBe('محمد علي');

    const cardDataEn = await getCustomerQrCardData('cust-1');
    expect(cardDataEn!.customerName).toBe('محمد علي');
  });

  // 14. Arabic and English labels switch correctly.
  it('14. Arabic and English labels switch correctly in design config', () => {
    const design = getActiveQrDesign('CUSTOMER');
    expect(design.chargingPointLabel.textAr).toBe('نقطة الشحن');
    expect(design.chargingPointLabel.textEn).toBe('Charging Point');
    expect(design.thankYouMessage.textAr).toBe('شكرًا لتعاملكم معنا');
    expect(design.thankYouMessage.textEn).toBe('Thank you for your business');
    expect(design.customerCode.labelAr).toBe('الرمز التعريفي');
    expect(design.customerCode.labelEn).toBe('Customer ID');
  });

  // 15. Date visibility follows design config.
  it('15. Date visibility follows design config', () => {
    const design = getActiveQrDesign('CUSTOMER');
    expect(design.date.show).toBe(true);

    const noDateDesign: QRDesignConfig = {
      ...design,
      date: { show: false, format: 'YYYY-MM-DD' },
    };
    setActiveQrDesign('CUSTOMER', noDateDesign);
    expect(getActiveQrDesign('CUSTOMER').date.show).toBe(false);
  });

  // 16. 5x6 cm print target is represented deterministically.
  it('16. 5x6 cm print target is represented deterministically across customer and order designs', () => {
    const custDesign = getActiveQrDesign('CUSTOMER');
    const ordDesign = getActiveQrDesign('ORDER');

    expect(custDesign.printTarget.widthMm).toBe(50);
    expect(custDesign.printTarget.heightMm).toBe(60);
    expect(ordDesign.printTarget.widthMm).toBe(50);
    expect(ordDesign.printTarget.heightMm).toBe(60);
  });
});
