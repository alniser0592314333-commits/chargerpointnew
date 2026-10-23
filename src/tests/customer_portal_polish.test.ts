import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');

describe('customer portal polish regression contract', () => {
  it('keeps the finance destination clearly labeled as payments', () => {
    const navigation = read('src/components/pages/CustomerPortalNavigation.tsx');
    expect(navigation).toContain("labelAr: 'الدفع', labelEn: 'Payments'");
  });

  it('marks customer notifications as read through the authenticated server endpoint', () => {
    const page = read('src/components/pages/PublicCustomerPortalPage.tsx');
    const endpoint = read('supabase/functions/customer-account/index.ts');
    expect(page).toContain("'mark-notifications-read'");
    expect(page).toContain("is_read");
    expect(page).toContain("isAr ? 'تعليم الكل كمقروء' : 'Mark all as read'");
    expect(endpoint).toContain('action === "mark-notifications-read"');
    expect(endpoint).toContain('sessionIsActive(link, authenticated.user.id, authenticated.claims)');
    expect(endpoint).toContain('.eq("customer_id", link.customer_id)');
    expect(endpoint).toContain('.eq("is_read", false)');
    expect(endpoint).toContain('.update({ is_read: true })');
  });

  it('does not leave a large persistent connectivity warning on the portal', () => {
    const page = read('src/components/pages/PublicCustomerPortalPage.tsx');
    const styles = read('src/components/pages/customer-portal-dashboard.css');
    expect(page).toContain('cp-portal-offline-toast');
    expect(page).toContain('offlineToastFading');
    expect(page).toContain('showOfflineDot');
    expect(styles).toContain('cp-portal-offline-toast--leaving');
    expect(page).not.toContain('role="status" className="flex items-start gap-3 rounded-xl border border-amber-300');
  });

  it('keeps locale and appearance controls in settings and provides real customer service information', () => {
    const page = read('src/components/pages/PublicCustomerPortalPage.tsx');
    expect(page).toContain("isAr ? 'عن نقطة الشحن' : 'About Charging Point'");
    expect(page).toContain("isAr ? 'إصدار التطبيق' : 'App version'");
    expect(page).toContain("isAr ? 'إصدار الأمان' : 'Security version'");
    expect(page).toContain('financial activity and payment receipts');
    expect(page).not.toContain('Change language to Arabic');
  });

  it('localizes the actual Android activity label as well as app_name', () => {
    const workflow = read('.github/workflows/build-android-apks.yml');
    expect(workflow).toContain('("app_name", "title_activity_main")');
    expect(workflow).toContain('("ar", arabic_name), ("en", base_name)');
  });

  it('allows preparing a customer-only signed release without rebuilding the admin release', () => {
    const workflow = read('.github/workflows/prepare-android-release.yml');
    expect(workflow).toContain('release_target');
    expect(workflow).toContain('default: customer');
    expect(workflow).toContain('options:\n          - customer\n          - admin\n          - both');
    expect(workflow).toContain('inputs.release_target');
    expect(workflow).toContain('default: "1.0.5"');
  });

  it('retries stale customer session issuance after a successful biometric proof', () => {
    const biometric = read('supabase/functions/account-biometric/index.ts');
    expect(biometric).toContain('const customerSessionAttempts = cred.account_type === "customer" ? 4 : 1');
    expect(biometric).toContain('Retrying session issuance server-side');
    expect(biometric).toContain('issuedAt > Number(current.auth_issued_at || 0)');
  });

  it('places the payment notification action before the payment form fields', () => {
    const payment = read('src/components/pages/PublicPaymentPage.tsx');
    const form = payment.indexOf('<form onSubmit={submit} className="payment-portal-form');
    const submit = payment.indexOf("isAr ? 'إرسال إشعار الدفع' : 'Send payment notification'");
    expect(form).toBeGreaterThan(-1);
    expect(submit).toBeGreaterThan(form);
    expect(submit).toBeLessThan(payment.indexOf('isAr ? \'وسيلة الدفع\' : \'Payment method\'', form));
  });
});
