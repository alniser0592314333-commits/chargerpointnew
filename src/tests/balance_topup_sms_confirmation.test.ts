import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');

describe('balance top-up confirmation channels', () => {
  it('sends an SMS only after the top-up succeeds, using this customer and this transaction result', () => {
    const page = read('src/components/pages/CustomerDetailPage.tsx');
    const handler = page.slice(page.indexOf('const handleCommitTopUp'), page.indexOf('const loadData'));
    expect(handler.indexOf('if (!res.success)')).toBeGreaterThan(-1);
    expect(handler.indexOf('if (!res.success)')).toBeLessThan(handler.indexOf('sendSmsUsingSystemDefaultSim'));
    expect(handler).toContain('customer.phone');
    expect(handler).toContain('customer.name');
    expect(handler).toContain('money(amountMinor)');
    expect(handler).toContain('money(res.newBalanceMinor)');
    expect(handler).toContain('chargerpoint.balanceTopUpSmsSent.v1');
    expect(handler).toContain('sendSmsUsingSystemDefaultSim(smsPhone, smsMessage)');
  });

  it('keeps the existing default Android SMS SIM implementation', () => {
    const service = read('src/services/nativeSms.ts');
    const plugin = read('scripts/android/NativeSmsPlugin.java');
    expect(service).toContain('sendSmsUsingSystemDefaultSim');
    expect(service).toContain('NativeSms.sendSms({ phone, message })');
    expect(plugin).toContain('SmsManager.getDefault()');
    expect(plugin).toContain('getSubscriptionId()');
    expect(plugin).toContain('getSmsManagerForSubscriptionId(subscriptionId)');
  });

  it('provides an editable message template with per-customer placeholders', () => {
    const settings = read('src/components/pages/BalanceTopUpSmsTemplatePage.tsx');
    const home = read('src/components/pages/MessageCenterHomePage.tsx');
    const app = read('src/App.tsx');
    expect(settings).toContain('chargerpoint.balanceTopUpSmsTemplate.v1');
    expect(settings).toContain('{customer_name}');
    expect(settings).toContain('{amount}');
    expect(settings).toContain('{current_balance}');
    expect(home).toContain("id: 'payment-template'");
    expect(app).toContain("'/app/messages/payment-template'");
  });

  it('keeps in-app ledger activity and enriches external push with authoritative name and balance', () => {
    const portal = read('src/components/pages/PublicCustomerPortalPage.tsx');
    const edge = read('supabase/functions/native-push/index.ts');
    expect(portal).toContain("...(activity?.ledger || []).map((entry)");
    expect(portal).toContain('notificationCount={eventRows.filter');
    expect(edge).toContain('admin.rpc("native_push_customer_balance"');
    expect(edge).toContain('admin.from("customers").select("name")');
    expect(edge).toContain('رصيدك الحالي بعد الإضافة');
    expect(edge).toContain('عزيزنا المشترك');
  });
});
