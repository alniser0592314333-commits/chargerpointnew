import { describe, expect, it } from 'vitest';
import { buildJawwalBCode, buildPalPayCode } from '../services/localPaymentHelperCode';

describe('Jawwal B local payment helper code builder', () => {
  it('builds the merchant code with type 2 and puts amount before *1#', () => {
    expect(buildJawwalBCode({
      accountKind: 'merchant',
      pin: '1234',
      recipientPhone: '0599123456',
    }, '25')).toBe('*110*2*1234*0599123456*25*1#');
  });

  it('builds the friend code with type 1', () => {
    expect(buildJawwalBCode({
      accountKind: 'friend',
      pin: '9876',
      recipientPhone: '059 912 3456',
    }, '23.5')).toBe('*110*1*9876*0599123456*23.5*1#');
  });

  it('rejects an invalid PIN, phone, zero or malformed amount', () => {
    expect(() => buildJawwalBCode({ accountKind: 'merchant', pin: '123', recipientPhone: '0599123456' }, '25')).toThrow();
    expect(() => buildJawwalBCode({ accountKind: 'merchant', pin: '1234', recipientPhone: '12' }, '25')).toThrow();
    expect(() => buildJawwalBCode({ accountKind: 'merchant', pin: '1234', recipientPhone: '0599123456' }, '0')).toThrow();
    expect(() => buildJawwalBCode({ accountKind: 'merchant', pin: '1234', recipientPhone: '0599123456' }, '25*1#')).toThrow();
  });
});


describe('PalPay USSD code', () => {
  it('builds the requested recipient and amount code', () => {
    expect(buildPalPayCode({ recipientPhone: '0599123456' }, '12.5')).toBe('*370*1*1*0599123456*12.5#');
  });
});
