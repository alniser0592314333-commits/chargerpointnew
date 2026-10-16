import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../supabase/migrations/20261016220000_apply_customer_credit_to_order_qr_remainder.sql', import.meta.url),
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

  it('applies available customer credit to the order remainder without exposing the full account balance', () => {
    expect(migration).toContain("'customer_has_positive_credit', (v_customer_balance_minor > 0)");
    expect(migration).toContain("'order_due_minor', v_due_minor");
    expect(migration).toContain("v_due_minor := greatest(v_due_minor - greatest(v_customer_balance_minor, 0), 0);");
    expect(migration).not.toContain("IF v_customer_balance_minor > 0 THEN");
    expect(orderPage).toContain("customerHasPositiveCredit");
    expect(orderPage).toContain("'CREDIT_COVERED'");
    expect(orderPage).toContain('!orderQrSubmissionLimitReached');
    expect(orderPage).toContain('سيُخصم رصيدك من قيمة الطلب');
    expect(paymentPage).toContain('server-calculated remainder already includes applicable customer credit');
    expect(paymentPage).not.toContain("typeof order.customerHasPositiveCredit !== 'boolean'");
    expect(paymentPage).toContain('orderPaymentAllowed');
    expect(edgeFunction).not.toContain('if (resolvedOrder.customer_has_positive_credit)');
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

  it('fails closed when the authoritative remaining amount cannot be verified', () => {
    expect(paymentPage).toContain('amountDue === null || amountDue <= 0');
    expect(paymentPage).toContain('There is no remaining amount due for this order.');
    expect(paymentPage).toContain('disabled={sending || (Boolean(order) && !orderPaymentAllowed)}');
  });
});
