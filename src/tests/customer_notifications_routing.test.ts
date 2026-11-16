import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

describe('notification routing and customer account management', () => {
  it('keeps debt reminders out of the administrator account inbox', () => {
    const edge = read('supabase/functions/customer-account/index.ts');
    const adminList = edge.slice(edge.indexOf('if (action === "admin-list")'), edge.indexOf('if (action === "admin-review-wallet-activation")'));
    expect(adminList).toContain('"RESET_REQUESTED"');
    expect(adminList).toContain('"PASSWORD_CHANGED"');
    expect(adminList).not.toContain('"DEBT_PAYMENT_REMINDER"');
  });

  it('routes debt reminder push to the customer finance tab and bypasses only the expired portal session', () => {
    const push = read('supabase/functions/native-push/index.ts');
    expect(push).toContain('allowExpiredCustomerAppSession = true');
    expect(push).toContain('eventType === "DEBT_PAYMENT_REMINDER" ? "/customer/finance" : "/public/about"');
    expect(push).toContain('p_allow_expired_customer_app_session: allowExpiredCustomerAppSession');
    expect(push).not.toContain('p_allow_account_status_notice: allowExpiredCustomerAppSession');
  });

  it('exposes customer accounts as a separate admin route and menu item', () => {
    const app = read('src/App.tsx');
    const desktop = read('src/components/shell/Sidebar.tsx');
    const mobile = read('src/components/shell/MobileNav.tsx');
    const payments = read('src/components/pages/NotificationsRequestsPage.tsx');
    expect(app).toContain("case '/app/customer-accounts'");
    expect(desktop).toContain("'/app/customer-accounts'");
    expect(mobile).toContain("'/app/customer-accounts'");
    expect(payments).not.toContain('CustomerAccountNotificationsPanel');
  });

  it('loads customer phone numbers and sends reset passwords through the default Android SIM', () => {
    const edge = read('supabase/functions/customer-account/index.ts');
    const panel = read('src/components/pages/CustomerAccountNotificationsPanel.tsx');
    expect(edge).toContain('customers(name,phone)');
    expect(panel).toContain('sendSmsUsingSystemDefaultSim');
    expect(panel).toContain('إرسال كلمة المرور SMS');
    expect(panel).toContain('smsSubmitted');
    expect(panel).toContain('retryIssuedSms');
  });
});
