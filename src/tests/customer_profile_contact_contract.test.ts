import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');

describe('admin customer profile contact experience', () => {
  it('keeps the customer profile actions tied to the selected customer', () => {
    const page = read('src/components/pages/CustomerDetailPage.tsx');
    expect(page).toContain('handleCallCustomer');
    expect(page).toContain('setIsSmsComposerOpen(true)');
    expect(page).toContain('customerId={customer.id}');
    expect(page).toContain('customerPhone={customer.phone}');
    expect(page).toContain('setIsCallPhoneModalOpen(true)');
    expect(page).toContain('window.location.href = `tel:${phone}`');
  });

  it('reuses the exact saved message-template storage used by Messages & Communication', () => {
    const composer = read('src/components/pages/CustomerSingleSmsComposer.tsx');
    const messageCenter = read('src/components/pages/CustomerLinkSmsPage.tsx');
    expect(composer).toContain("'chargerpoint.customerLinkSmsSavedTemplates.v1'");
    expect(messageCenter).toContain("'chargerpoint.customerLinkSmsSavedTemplates.v1'");
    expect(composer).toContain("'chargerpoint.customerLinkSmsTemplate.v1'");
    expect(composer).toContain('sendSmsUsingSystemDefaultSim(normalizedPhone, sms)');
    expect(composer).toContain('getCustomerQrCardData(customerId)');
  });

  it('requires a single recipient phone and does not invoke the bulk campaign sender', () => {
    const composer = read('src/components/pages/CustomerSingleSmsComposer.tsx');
    expect(composer).toContain('Send an SMS only to ${customerName}');
    expect(composer).toContain('sendSmsUsingSystemDefaultSim(normalizedPhone, sms)');
    expect(composer).not.toContain('getSmsCustomerRecipients');
    expect(composer).not.toContain('chargerpoint.customerLinkSmsCampaign.v1');
  });

  it('retains the existing top-up, QR, account controls and account creation date', () => {
    const page = read('src/components/pages/CustomerDetailPage.tsx');
    expect(page).toContain('handleOpenTopUp');
    expect(page).toContain('handleQrClick');
    expect(page).toContain('handleOpenAccountControlModal');
    expect(page).toContain('formatDate(customer.createdAt)');
  });
});
