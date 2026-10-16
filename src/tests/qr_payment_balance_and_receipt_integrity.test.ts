import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../supabase/migrations/20261016140000_fix_qr_payment_balance_and_receipt_integrity.sql', import.meta.url),
  'utf8',
);
const edgeFunction = readFileSync(
  new URL('../../supabase/functions/submit-qr-payment/index.ts', import.meta.url),
  'utf8',
);
const orderPage = readFileSync(
  new URL('../components/pages/PublicOrderPage.tsx', import.meta.url),
  'utf8',
);
const paymentPage = readFileSync(
  new URL('../components/pages/PublicPaymentPage.tsx', import.meta.url),
  'utf8',
);

describe('QR payment eligibility and receipt storage integrity', () => {
  it('counts only financially recognized items as payable order debt', () => {
    expect(migration).toContain("oi.financial_status = 'RECOGNIZED'");
    expect(migration).toContain('oi.financially_recognized_at IS NOT NULL');
    expect(migration).toContain("'payment_status', CASE");
    expect(migration).toContain("ELSE 'NOT_DUE'");
  });

  it('uses customer credit only as a boolean and blocks order-QR payment when credit is positive', () => {
    expect(migration).toContain("'customer_has_positive_credit', (v_customer_balance_minor > 0)");
    expect(migration).toContain("IF v_customer_balance_minor > 0 THEN");
    expect(orderPage).toContain("customerHasPositiveCredit");
    expect(orderPage).toContain("'CREDIT_COVERED'");
    expect(paymentPage).toContain('order.customerHasPositiveCredit');
    expect(paymentPage).toContain('orderPaymentAllowed');
  });

  it('caps order-QR submissions at three across the lifetime of that order QR', () => {
    expect(migration).toContain('Maximum of three payment notifications reached for this order QR');
    expect(migration).toContain('WHERE s.order_id = v_order_id');
    expect(edgeFunction).toContain('Order QR lifetime cap');
    expect(edgeFunction).toContain('Maximum of three payment notifications reached for this order QR.');
  });

  it('reads back and verifies the exact uploaded receipt before persisting its path', () => {
    expect(edgeFunction).toContain('storage.createSignedUrl(path, 300)');
    expect(edgeFunction).toContain('storage.download(path)');
    expect(edgeFunction).toContain('crypto.subtle.digest("SHA-256"');
    expect(edgeFunction.indexOf('uploadVerifiedReceipt(supabase')).toBeLessThan(
      edgeFunction.indexOf('supabase.rpc("submit_qr_payment"'),
    );
    expect(edgeFunction).toContain('No payment notification was saved; please try again.');
  });

  it('fails closed if credit state cannot be verified on the payment form', () => {
    expect(paymentPage).toContain('Could not verify the account balance');
    expect(paymentPage).toContain('disabled={sending || (Boolean(order) && !orderPaymentAllowed)}');
  });
});
