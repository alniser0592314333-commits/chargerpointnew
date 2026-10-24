import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');

describe('customer portal polish regression contract', () => {
  it('holds the customer native launch screen until the correct intro or destination has painted', () => {
    const component = read('src/components/pages/FirstVisitWelcomeIntro.tsx');
    const config = JSON.parse(read('capacitor.customer.config.json'));
    const packageJson = JSON.parse(read('package.json'));
    expect(packageJson.dependencies['@capacitor/splash-screen']).toBeDefined();
    expect(config.plugins.SplashScreen.launchAutoHide).toBe(false);
    expect(component).toContain("import { SplashScreen } from '@capacitor/splash-screen'");
    expect(component).toContain('window.requestAnimationFrame');
    expect(component).toContain('window.cancelAnimationFrame');
    expect(component).toContain('SplashScreen.hide()');
    expect(component).toContain('nativeSplashHidden.current');
  });

  it('resolves customer login by the canonical UUID-derived code without querying a nonexistent customers column', () => {
    const endpoint = read('supabase/functions/customer-account/index.ts');
    const biometric = read('supabase/functions/account-biometric/index.ts');
    expect(endpoint).toContain('const customerCode = (customerId: string)');
    expect(endpoint).toContain('.gte("id", `${prefix}0000-0000-0000-0000-000000000000`)');
    expect(endpoint).not.toContain('.eq("customer_code", token)');
    expect(endpoint).not.toContain('.select("id,name,customer_code,is_active,status,deleted_at")');
    expect(biometric).toContain('if (!isCustomerUuid && /^[0-9a-f]{4}$/i.test(identifier))');
    expect(biometric).toContain('.gte("id", prefix + "0000-0000-0000-0000-000000000000")');
  });

  it('keeps the biometric prompt from opening before Android activity state is ready', () => {
    const plugin = read('scripts/android/AccountBiometricPlugin.java');
    const styles = read('src/public-portal.css');
    expect(plugin).toContain('Lifecycle.State.RESUMED');
    expect(plugin).toContain('mainHandler.postDelayed(showPrompt[0], 120)');
    expect(plugin).toContain('BIOMETRIC_PROMPT_NOT_READY');
    expect(styles).toContain('html:has(.cp-auth), body:has(.cp-auth), #root:has(.cp-auth)');
    expect(styles).toContain('background-color: #061c24 !important');
  });

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
    expect(workflow).toContain('RELEASE_TARGET="${{ inputs.release_target }}"');
    expect(workflow).toContain('if [[ "$RELEASE_TARGET" == "customer" || "$RELEASE_TARGET" == "both" ]]');
    expect(workflow).toContain('if [[ "$RELEASE_TARGET" == "admin" || "$RELEASE_TARGET" == "both" ]]');
  });

  it('retries a transient Android biometric availability probe before suppressing the prompt', () => {
    const client = read('src/services/auth/accountBiometric.ts');
    const availability = client.slice(
      client.indexOf('export const isNativeBiometricAvailable'),
      client.indexOf('export async function enrollAccountBiometric'),
    );
    expect(availability).toContain('for (let attempt = 0; attempt < 2; attempt++)');
    expect(availability).toContain('await wait(250)');
    expect(availability).toContain('NativeBiometric.isAvailable()');
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
    const submit = payment.indexOf("isAr ? 'إرسال إيصال الدفع' : 'Send Payment Receipt'");
    expect(form).toBeGreaterThan(-1);
    expect(submit).toBeGreaterThan(form);
    expect(submit).toBeLessThan(payment.indexOf('isAr ? \'وسيلة الدفع\' : \'Payment method\'', form));
  });

  it('uses an authoritative uncapped Jawwal pending count and refreshes after submission', () => {
    const page = read('src/components/pages/PublicCustomerPortalPage.tsx');
    const endpoint = read('supabase/functions/customer-account/index.ts');
    const automation = read('src/components/customer/CustomerJawwalAutomation.tsx');
    expect(endpoint).toContain('pending_jawwal_payments_count = Number(pendingJawwalCount)');
    expect(endpoint).toContain('.eq("submission_source", "CUSTOMER_JAWAL_PAY")');
    expect(endpoint).toContain('.eq("status", "PENDING")');
    expect(page).toContain('data.pending_jawwal_payments_count');
    expect(page).toContain('onSubmissionCreated={() =>');
    expect(automation).toContain('onSubmissionCreated?.()');
  });

  it('rebinds customer push registration when the authenticated session changes', () => {
    const page = read('src/components/pages/PublicCustomerPortalPage.tsx');
    const push = read('src/services/nativePushNotifications.ts');
    expect(page).toContain('customerAuth.auth.onAuthStateChange');
    expect(page).toContain("event === 'SIGNED_OUT'");
    expect(page).toContain('pushSessionKeyRef.current = key');
    expect(push).toContain('queuedStartRequest = request');
    expect(push).toContain('run it after the old attempt ends');
  });

  it('keeps receipt submission and Jawwal Pay as clearly distinct bilingual actions', () => {
    const payment = read('src/components/pages/PublicPaymentPage.tsx');
    const automation = read('src/components/customer/CustomerJawwalAutomation.tsx');
    expect(payment).toContain("isAr ? 'إرسال إيصال الدفع' : 'Send Payment Receipt'");
    expect(automation).toContain("t('الدفع بواسطة جوال باي', 'Pay with Jawwal Pay')");
    expect(automation).not.toContain("t('أتمتة الدفع عبر جوال باي', 'Automated Jawwal Pay')");
  });
});
