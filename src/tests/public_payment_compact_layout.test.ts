import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Public payment page compact layout', () => {
  const source = readFileSync(new URL('../components/pages/PublicPaymentPage.tsx', import.meta.url), 'utf8');

  it('keeps payment methods in one compact three-column row with short labels', () => {
    expect(source).toContain('grid grid-cols-3 gap-2');
    expect(source).toContain("short: 'BOP'");
    expect(source).toContain("short: 'JWP'");
    expect(source).toContain("short: 'PPY'");
    expect(source).toContain('{item.short}');
  });

  it('removes the separate order/customer details sidebar', () => {
    expect(source).not.toContain('Order Items:');
    expect(source).not.toContain('lg:grid-cols-12');
    expect(source).toContain('Simple single-card payment form');
  });

  it('keeps receipt validation and optional note in the payment card', () => {
    expect(source).toContain('Attach payment receipt');
    expect(source).toContain('id="payment-note"');
    expect(source).toContain('Payment is credited only after receipt review.');
  });
});
