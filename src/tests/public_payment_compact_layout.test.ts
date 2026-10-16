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

  it('uses circular payment choices and a theme-aware page background', () => {
    expect(source).toContain('flex aspect-square min-w-0 flex-col items-center');
    expect(source).toContain('rounded-full');
    expect(source).toContain('from-slate-100 via-white to-teal-50');
    expect(source).toContain('dark:from-[#050b0d] dark:via-[#091719] dark:to-[#102d2a]');
    expect(source).toContain('duration-300');
  });

  it('redesigns the pending-review screen with clear status and theme-aware surfaces', () => {
    expect(source).toContain('إشعار الدفع بانتظار المراجعة');
    expect(source).toContain('PENDING REVIEW');
    expect(source).toContain('dark:bg-[#101e21]/95');
    expect(source).toContain('rounded-full px-3 py-1');
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
