import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { ChevronDown, ChevronUp, LifeBuoy, Plus, Trash2, Wallet, ShieldAlert, PhoneCall, LockKeyhole, X } from 'lucide-react';
import { buildJawwalBCode } from '../../services/localPaymentHelperCode';

type AccountKind = 'merchant' | 'friend';
type JawwalBService = {
  id: string;
  name: string;
  accountKind: AccountKind;
  pin: string;
  recipientPhone: string;
  createdAt: number;
  ussdSteps?: string[];
};
type LocalPaymentHelperPluginApi = {
  getServices(): Promise<{ value: string }>;
  setServices(options: { value: string }): Promise<void>;
  placeCall(options: { code: string; steps: string[] }): Promise<void>;
  openAccessibilitySettings(): Promise<void>;
  isAutomationEnabled(): Promise<{ enabled: boolean }>;

};
const NativePaymentHelper = registerPlugin<LocalPaymentHelperPluginApi>('LocalPaymentHelper');
const CONSENT_KEY = 'cp_local_payment_helper_disclaimer_accepted_v1';
const WEB_SESSION_KEY = 'cp_local_payment_helper_demo_services_v1';
const OPEN_EVENT = 'cp-open-local-payment-helper';

function makeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
}

async function loadServices(): Promise<JawwalBService[]> {
  if (Capacitor.isNativePlatform()) {
    const result = await NativePaymentHelper.getServices();
    if (!result.value) return [];
    const parsed = JSON.parse(result.value);
    return Array.isArray(parsed) ? parsed : [];
  }
  // Browser preview is intentionally session-only; never persist a financial PIN
  // in browser localStorage when the Android Keystore plugin is unavailable.
  try {
    const value = window.sessionStorage.getItem(WEB_SESSION_KEY);
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function saveServices(services: JawwalBService[]): Promise<void> {
  const value = JSON.stringify(services);
  if (Capacitor.isNativePlatform()) {
    await NativePaymentHelper.setServices({ value });
    return;
  }
  window.sessionStorage.setItem(WEB_SESSION_KEY, value);
}

export const openLocalPaymentHelper = () => window.dispatchEvent(new Event(OPEN_EVENT));

export const LocalPaymentHelper: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [services, setServices] = useState<JawwalBService[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [accountKind, setAccountKind] = useState<AccountKind>('merchant');
  const [pin, setPin] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [ussdSteps, setUssdSteps] = useState<string[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setServices(await loadServices());
    } catch {
      setError('تعذّر قراءة الخدمات المحفوظة. لم نستخدم تخزينًا بديلًا غير آمن.');
    }
  }, []);

  const open = useCallback(() => {
    let accepted = false;
    try { accepted = window.localStorage.getItem(CONSENT_KEY) === 'yes'; } catch {}
    setConsentAccepted(accepted);
    setConsentChecked(false);
    setNotice('');
    setError('');
    setIsOpen(true);
    if (accepted) void load();
  }, [load]);

  useEffect(() => {
    window.addEventListener(OPEN_EVENT, open);
    return () => window.removeEventListener(OPEN_EVENT, open);
  }, [open]);

  const acceptDisclaimer = async () => {
    if (!consentChecked) return;
    try { window.localStorage.setItem(CONSENT_KEY, 'yes'); } catch {}
    setConsentAccepted(true);
    await load();
  };

  const resetForm = () => {
    setName('');
    setAccountKind('merchant');
    setPin('');
    setRecipientPhone('');
    setUssdSteps([]);
    setShowCreate(false);
  };

  const createService = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setNotice('');
    const cleanName = name.trim();
    const cleanPhone = recipientPhone.replace(/[^0-9]/g, '');
    if (!cleanName) { setError('اكتب اسمًا للخدمة.'); return; }
    if (!/^\d{4}$/.test(pin)) { setError('الرقم السري يجب أن يتكوّن من 4 أرقام بالضبط.'); return; }
    if (!/^\d{8,15}$/.test(cleanPhone)) { setError('أدخل رقم جوال المستلم بالأرقام فقط.'); return; }
    const next = [...services, {
      id: makeId(),
      name: cleanName,
      accountKind,
      pin,
      recipientPhone: cleanPhone,
      ussdSteps: cleanSteps,
      createdAt: Date.now(),
    }];
    try {
      await saveServices(next);
      setServices(next);
      setExpandedId(next[next.length - 1].id);
      resetForm();
      setNotice('تم حفظ الخدمة على هذا الجهاز فقط.');
    } catch {
      setError('تعذّر حفظ الخدمة محليًا. لم يتم إرسال بياناتها إلى خادم.');
    }
  };

  const deleteService = async (id: string) => {
    const next = services.filter((service) => service.id !== id);
    try {
      await saveServices(next);
      setServices(next);
      if (expandedId === id) setExpandedId(null);
      setNotice('تم حذف الخدمة من هذا الجهاز.');
      setError('');
    } catch { setError('تعذّر حذف الخدمة المحلية.'); }
  };

  const pay = async (service: JawwalBService) => {
    setError('');
    setNotice('');
    let code = '';
    try { code = buildJawwalBCode(service, amounts[service.id] || ''); }
    catch (e) { setError(e instanceof Error ? e.message : 'راجع بيانات الخدمة والمبلغ.'); return; }

    setBusy(true);
    try {
      if (Capacitor.isNativePlatform()) {
        if ((service.ussdSteps || []).length > 0) {
          const status = await NativePaymentHelper.isAutomationEnabled();
          if (!status.enabled) {
            await NativePaymentHelper.openAccessibilitySettings();
            setError('فعّل خدمة «أتمتة خطوات USSD» من إعدادات إمكانية الوصول، ثم ارجع واضغط دفع مرة أخرى.');
            return;
          }
        }
        await NativePaymentHelper.placeCall({ code, steps: service.ussdSteps || [] });
        setNotice((service.ussdSteps || []).length > 0 ? 'بدأ الاتصال. سيحاول الهاتف إدخال الخطوات المحفوظة تلقائيًا؛ راقب الشاشة وتأكد من نتيجة العملية.' : 'تم طلب بدء الاتصال. أكمل أي خطوات تظهر في شاشة USSD.');
      } else {
        // Browser preview can only open the dialer; direct calling is native-APK-only.
        window.location.href = 'tel:' + encodeURIComponent(code);
        setNotice('في معاينة الويب قد تحتاج للضغط على اتصال يدويًا؛ الاتصال المباشر مخصص لنسخة أندرويد.');
      }
    } catch {
      setError('لم يبدأ الاتصال. تأكد من صلاحية الاتصال وأن الجهاز يدعم رمز USSD.');
    } finally {
      setBusy(false);
    }
  };

  const accountKindLabel = (kind: AccountKind) => kind === 'merchant' ? 'تاجر' : 'صديق';
  const canCreate = useMemo(() => name.trim().length > 0 && /^\d{4}$/.test(pin) && /^\d{8,15}$/.test(recipientPhone.replace(/[^0-9]/g, '')), [name, pin, recipientPhone]);

  return (
    <>
      <button
        type="button"
        onClick={open}
        className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-emerald-300/30 bg-[#0b3c3a] px-3 py-2 text-xs font-bold text-white shadow-md transition hover:bg-[#12534f] focus:outline-none focus:ring-2 focus:ring-emerald-400"
        aria-label="فتح خدمات المساعدة"
      >
        <LifeBuoy size={17} aria-hidden="true" />
        <span className="hidden sm:inline">خدمات مساعدة</span>
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/65 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={() => setIsOpen(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="cp-payment-helper-title"
            className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-gray-200 bg-white p-5 text-gray-900 dark:border-white/10 dark:bg-[#0d2a29] dark:text-white shadow-2xl sm:rounded-3xl sm:p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="mb-5 flex items-start justify-between gap-3">
              <div>
                <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300">
                  <LifeBuoy size={23} />
                </div>
                <h2 id="cp-payment-helper-title" className="text-xl font-extrabold">خدمات مساعدة</h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-[#a4cac2]">اختصارات محلية لتسهيل خطواتك اليومية</p>
              </div>
              <button type="button" onClick={() => setIsOpen(false)} className="rounded-full p-2 text-gray-500 dark:text-[#a4cac2] hover:bg-gray-100 dark:hover:bg-white/10" aria-label="إغلاق">
                <X size={21} />
              </button>
            </header>

            {!consentAccepted ? (
              <div className="space-y-4">
                <div className="rounded-2xl border border-amber-300 bg-amber-50 dark:border-amber-400/30 dark:bg-amber-500/10 p-4">
                  <div className="mb-2 flex items-center gap-2 font-extrabold text-amber-900 dark:text-amber-200">
                    <ShieldAlert size={20} />
                    <span>إخلاء مسؤولية وشروط الاستخدام</span>
                  </div>
                  <ul className="list-disc space-y-2 ps-5 text-sm leading-6 text-amber-950 dark:text-amber-100">
                    <li>هذه ميزة اختيارية لتسهيل إنشاء رموز الاتصال فقط؛ أنت مسؤول عن صحة بيانات المستلم والمبلغ ونوع الحساب.</li>
                    <li>لا يرسل التطبيق هذه الخدمات إلى حسابك أو قاعدة بيانات ChargerPointNew، ولا يزامنها مع أجهزتك الأخرى.</li>
                    <li>على نسخة أندرويد، تحفظ بيانات الخدمة محليًا مشفّرة بمفتاح Android Keystore على هذا الهاتف. حذف التطبيق أو بياناته قد يؤدي إلى فقدان الخدمات نهائيًا.</li>
                    <li>عند بدء الاتصال، قد يظهر رمز USSD في تطبيق الهاتف أو سجل المكالمات؛ لا تستخدم الميزة على جهاز مشترك، واحمِ هاتفك ورقمك السري.</li>
                    <li>الاتصال لا يثبت نجاح الدفع. راجع تفاصيل USSD ونتيجة مزود الخدمة بنفسك، ولا تؤكد أي عملية لا تعرفها.</li>
                  </ul>
                </div>
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 p-3 dark:border-white/10 text-sm leading-6">
                  <input type="checkbox" checked={consentChecked} onChange={(event) => setConsentChecked(event.target.checked)} className="mt-1 h-4 w-4 accent-emerald-600" />
                  <span>قرأت إخلاء المسؤولية وأوافق على استخدام الخدمة على مسؤوليتي.</span>
                </label>
                <button type="button" disabled={!consentChecked} onClick={() => void acceptDisclaimer()} className="w-full rounded-xl bg-emerald-600 px-4 py-3 font-bold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40">
                  حسناً، متابعة
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-2xl border border-gray-200 bg-gray-50 p-3 dark:border-white/10 dark:bg-[#071d1c]">
                  <div className="flex items-center gap-2 text-sm font-bold">
                    <LockKeyhole size={17} className="text-emerald-700 dark:text-emerald-300" />
                    <span>حفظ محلي على هذا الجهاز</span>
                  </div>
                  <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-bold text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300">جوال B فقط</span>
                </div>

                {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
                {notice && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</p>}

                {!showCreate ? (
                  <button type="button" onClick={() => { setShowCreate(true); setError(''); setNotice(''); }} className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 font-bold text-white shadow-sm hover:bg-emerald-700">
                    <Plus size={18} /> إضافة خدمة جوال B
                  </button>
                ) : (
                  <form onSubmit={(event) => void createService(event)} className="space-y-3 rounded-2xl border border-gray-200 p-4 dark:border-white/10">
                    <h3 className="font-extrabold">إضافة خدمة دفع جديدة</h3>
                    <p className="text-xs leading-5 text-gray-500 dark:text-[#a4cac2]">أدخل بيانات الخدمة، ويمكنك إضافة خطوات USSD حسب تسلسل شركة الاتصالات.</p>
                    <label className="block space-y-1 text-sm font-semibold">
                      <span>اسم الخدمة</span>
                      <input required maxLength={60} value={name} onChange={(event) => setName(event.target.value)} placeholder="مثال: سوبرماركت حمدان" className="w-full rounded-xl border border-gray-300 bg-white px-3 py-3 text-base dark:border-white/15 dark:bg-[#071d1c] dark:text-white outline-none focus:border-emerald-500" />
                    </label>
                    <fieldset className="space-y-2">
                      <legend className="text-sm font-semibold">نوع الحساب المستلم</legend>
                      <div className="grid grid-cols-2 gap-2">
                        <button type="button" aria-pressed={accountKind === 'merchant'} onClick={() => setAccountKind('merchant')} className={`rounded-xl border px-3 py-3 text-sm font-bold ${accountKind === 'merchant' ? 'border-emerald-600 bg-emerald-50 text-emerald-800 dark:border-emerald-400 dark:bg-emerald-500/15 dark:text-emerald-200' : 'border-gray-300 bg-white dark:border-white/15 dark:bg-[#071d1c]'}`}>تاجر · 2</button>
                        <button type="button" aria-pressed={accountKind === 'friend'} onClick={() => setAccountKind('friend')} className={`rounded-xl border px-3 py-3 text-sm font-bold ${accountKind === 'friend' ? 'border-emerald-600 bg-emerald-50 text-emerald-800 dark:border-emerald-400 dark:bg-emerald-500/15 dark:text-emerald-200' : 'border-gray-300 bg-white dark:border-white/15 dark:bg-[#071d1c]'}`}>صديق · 1</button>
                      </div>
                    </fieldset>
                    <label className="block space-y-1 text-sm font-semibold">
                      <span>الرقم السري لجوال B (4 أرقام)</span>
                      <input required type="password" inputMode="numeric" autoComplete="new-password" maxLength={4} pattern="[0-9]{4}" value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="••••" className="w-full rounded-xl border border-gray-300 bg-white px-3 py-3 text-base dark:border-white/15 dark:bg-[#071d1c] dark:text-white outline-none focus:border-emerald-500" />
                    </label>
                    <div className="space-y-3 rounded-xl border border-emerald-200 p-3 dark:border-emerald-400/20">
                      <div>
                        <h4 className="font-extrabold">خطوات USSD الإضافية (اختياري)</h4>
                        <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-[#a4cac2]">اكتب النص الذي تريد إدخاله في كل نافذة بعد بدء الاتصال. مثال: 1. اتركها فارغة إذا لم توجد خطوات.</p>
                      </div>
                      {ussdSteps.map((step, index) => (
                        <div key={index} className="flex items-start gap-2">
                          <label className="min-w-0 flex-1 space-y-1 text-sm font-semibold">
                            <span>الخطوة {index + 1}</span>
                            <textarea required maxLength={80} rows={2} value={step} onChange={(event) => setUssdSteps((current) => current.map((value, i) => i === index ? event.target.value : value))} placeholder={index === 0 ? 'مثال: 1' : 'النص المطلوب في النافذة التالية'} className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-base dark:border-white/15 dark:bg-[#071d1c] dark:text-white outline-none focus:border-emerald-500" />
                          </label>
                          <button type="button" onClick={() => setUssdSteps((current) => current.filter((_, i) => i !== index))} className="mt-6 rounded-lg p-2 text-red-600 hover:bg-red-50" aria-label={'حذف الخطوة ' + (index + 1)}><Trash2 size={17} /></button>
                        </div>
                      ))}
                      {ussdSteps.length < 10 && <button type="button" onClick={() => setUssdSteps((current) => [...current, ''])} className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-emerald-500 px-3 py-2 text-sm font-bold text-emerald-700 dark:text-emerald-300"><Plus size={16} /> إضافة خطوة</button>}
                    </div>
                    <label className="block space-y-1 text-sm font-semibold">
                      <span>رقم جوال المستلم</span>
                      <input required type="tel" inputMode="tel" autoComplete="off" value={recipientPhone} onChange={(event) => setRecipientPhone(event.target.value)} placeholder="059XXXXXXX" className="w-full rounded-xl border border-gray-300 bg-white px-3 py-3 text-base dark:border-white/15 dark:bg-[#071d1c] dark:text-white outline-none focus:border-emerald-500" />
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <button type="button" onClick={resetForm} className="rounded-xl border border-gray-300 px-4 py-3 font-bold text-gray-700 dark:border-white/15 dark:text-gray-200">إلغاء</button>
                      <button type="submit" disabled={!canCreate || busy} className="rounded-xl bg-emerald-600 px-4 py-3 font-bold text-white hover:bg-emerald-700 disabled:opacity-40">حفظ الخدمة</button>
                    </div>
                  </form>
                )}

                {services.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-gray-300 px-4 py-7 dark:border-white/20 text-center">
                    <Wallet size={27} className="mx-auto mb-2 text-emerald-600 dark:text-emerald-400" />
                    <p className="font-bold">ما عندك خدمات محفوظة</p>
                    <p className="mt-1 text-sm text-gray-500 dark:text-[#a4cac2]">أضف خدمة جوال B لتظهر هنا.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <h3 className="text-sm font-extrabold">خدماتك المحفوظة ({services.length})</h3>
                    {services.map((service, index) => {
                      const expanded = expandedId === service.id;
                      return (
                        <article key={service.id} className="overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-white/10 dark:bg-[#0a2423]">
                          <div className="flex items-center gap-2 p-3">
                            <button type="button" onClick={() => setExpandedId(expanded ? null : service.id)} aria-expanded={expanded} className="flex min-w-0 flex-1 items-center gap-3 text-start">
                              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#f4eee3] text-emerald-700 dark:text-emerald-300"><Wallet size={19} /></span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-extrabold">{index + 1}. {service.name}</span>
                                <span className="mt-0.5 block text-xs text-gray-500 dark:text-[#a4cac2]">جوال B · {accountKindLabel(service.accountKind)} · {service.recipientPhone}</span>
                              </span>
                              {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                            </button>
                            <button type="button" onClick={() => void deleteService(service.id)} className="rounded-lg p-2 text-red-600 hover:bg-red-50" aria-label={'حذف ' + service.name}><Trash2 size={17} /></button>
                          </div>
                          {expanded && (
                            <div className="space-y-3 border-t border-gray-200 bg-gray-50 dark:border-white/10 dark:bg-[#071d1c] p-4">
                              <label className="block space-y-1 text-sm font-bold">
                                <span>المبلغ المراد إرساله (شيكل)</span>
                                <input type="number" inputMode="decimal" min="0.01" step="0.01" value={amounts[service.id] || ''} onChange={(event) => setAmounts((current) => ({ ...current, [service.id]: event.target.value }))} placeholder="مثال: 25" className="w-full rounded-xl border border-gray-300 bg-white dark:border-white/15 dark:bg-[#071d1c] px-3 py-3 text-lg outline-none focus:border-emerald-500" />
                              </label>
                              <button type="button" disabled={busy} onClick={() => void pay(service)} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#0f766e] px-4 py-3 font-extrabold text-white shadow-sm hover:bg-[#115e59] disabled:opacity-50">
                                <PhoneCall size={18} /> {busy ? 'جارٍ بدء الاتصال…' : 'دفع والاتصال'}
                              </button>
                              <p className="text-xs leading-5 text-gray-500 dark:text-[#a4cac2]">إذا أضفت خطوات، يلزم تفعيل خدمة إمكانية الوصول ليحاول التطبيق إدخالها وإرسالها تلقائيًا. راقب الشاشة؛ قد تختلف النوافذ حسب الهاتف والشبكة، ولا يضمن بدء الاتصال نجاح التحويل.</p>
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
};
