export type JawwalBAccountKind = 'merchant' | 'friend';

export type JawwalBCodeInput = {
  accountKind: JawwalBAccountKind;
  pin: string;
  recipientPhone: string;
};

export function buildJawwalBCode(service: JawwalBCodeInput, amount: string): string {
  const kind = service.accountKind === 'merchant' ? '2' : '1';
  const phone = service.recipientPhone.replace(/\D/g, '');
  const normalizedAmount = amount.trim();
  if (!/^\d{4}$/.test(service.pin)) throw new Error('الرقم السري يجب أن يتكوّن من 4 أرقام.');
  if (!/^\d{8,15}$/.test(phone)) throw new Error('رقم المستلم غير صالح.');
  if (!/^(?:[1-9]\d*|0)(?:\.\d{1,2})?$/.test(normalizedAmount) || Number(normalizedAmount) <= 0) {
    throw new Error('أدخل مبلغًا صحيحًا أكبر من صفر.');
  }
  return '*110*' + kind + '*' + service.pin + '*' + phone + '*' + normalizedAmount + '*1#';
}
