import React, { useEffect, useState } from 'react';
import {
  ArrowLeft, ArrowRight, CheckCircle2, Copy, FileImage,
  Globe, LockKeyhole, Moon, ShieldCheck, Sun, UploadCloud, X, Zap,
} from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';
import { getPublicCustomerByToken, getPublicOrderByToken, PublicCustomerQrData, PublicOrderQrData } from './dayOrdersStore';
import { config } from '../../config/env';
import { PublicQrPaymentSubmissionRpcResult, rpcResolveQrPaymentSubmission } from '../../services/supabase/client';

type PaymentMethod = 'JAWAL_PAY' | 'PALPAY' | 'BANK_OF_PALESTINE';

const methods: Array<{
  id: PaymentMethod;
  ar: string;
  en: string;
  short: string;
  descriptionAr: string;
  descriptionEn: string;
  markClass: string;
  logoUrl: string;
}> = [
  {
    id: 'JAWAL_PAY',
    ar: 'جوال باي',
    en: 'Jawwal Pay',
    short: 'jawwal pay',
    descriptionAr: 'محفظة إلكترونية',
    descriptionEn: 'Digital wallet',
    markClass: 'bg-[#f5e9ed] text-[#8e2342]',
    logoUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/15/79/dc/1579dcea-3b6b-459a-3fb8-752262e39b6f/AppIcon-0-1x_U007emarketing-0-8-0-0-sRGB-85-220-0.png/512x512bb.jpg',
  },
  {
    id: 'PALPAY',
    ar: 'بال باي',
    en: 'PalPay',
    short: 'PALPAY',
    descriptionAr: 'محفظتي',
    descriptionEn: 'Mahfazati wallet',
    markClass: 'bg-[#f2e8ff] text-[#6634a5]',
    logoUrl: 'https://bopwebsitestorage.blob.core.windows.net/assets/uploads/l9IcwMLAVdCnG7anhRZRTisqSbNCcsYK1NV4LwZM.png',
  },
  {
    id: 'BANK_OF_PALESTINE',
    ar: 'بنك فلسطين',
    en: 'Bank of Palestine',
    short: 'BOP',
    descriptionAr: 'تحويل بنكي',
    descriptionEn: 'Bank transfer',
    markClass: 'bg-[#e7f1e9] text-[#1d6a45]',
    logoUrl: 'https://bopwebsitestorage.blob.core.windows.net/assets/news/9sJP6saDV32QxvHqVHnTxo74fVXnHdPcCBzT2okA.jpg',
  },
];

const PaymentMethodLogo: React.FC<{ method: typeof methods[number] }> = ({ method }) => {
  const [failed, setFailed] = useState(false);
  if (failed || !method.logoUrl) {
    return <span className={`mb-3 flex h-10 min-w-10 items-center justify-center rounded-lg px-2 text-[11px] font-black tracking-tight ${method.markClass}`}>{method.short}</span>;
  }
  return <img src={method.logoUrl} alt={method.short} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="mb-3 h-10 w-14 rounded-md object-contain" />;
};

const parseCustomerAmountMinor = (value: string): number | null => {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const minor = Math.round(amount * 100);
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
};

const MAX_SOURCE_FILE_BYTES = 12 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 2 * 1024 * 1024;

async function compressReceipt(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) throw new Error('IMAGE_REQUIRED');
  if (file.size > MAX_SOURCE_FILE_BYTES) throw new Error('SOURCE_TOO_LARGE');

  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height) throw new Error('IMAGE_INVALID');
    const maxDimension = 1600;
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('IMAGE_PROCESSING_UNAVAILABLE');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const toBlob = (type: string, quality: number) =>
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('IMAGE_COMPRESSION_FAILED')), type, quality);
      });

    let output: Blob;
    try {
      output = await toBlob('image/webp', 0.82);
      if (output.type !== 'image/webp') output = await toBlob('image/jpeg', 0.84);
    } catch {
      output = await toBlob('image/jpeg', 0.78);
    }

    if (output.size > MAX_COMPRESSED_BYTES) {
      output = await toBlob('image/jpeg', 0.68);
    }
    if (output.size > MAX_COMPRESSED_BYTES) throw new Error('COMPRESSED_TOO_LARGE');

    const extension = output.type === 'image/webp' ? 'webp' : 'jpg';
    return new File([output], `payment-receipt.${extension}`, {
      type: output.type,
      lastModified: Date.now(),
    });
  } finally {
    bitmap.close();
  }
}

export interface PublicPaymentPageProps {
  token: string;
}

export const PublicPaymentPage: React.FC<PublicPaymentPageProps> = ({ token }) => {
  const { locale, setLocale, formatCurrency, isRTL } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const isAr = locale === 'ar';
  const [order, setOrder] = useState<PublicOrderQrData | null>(null);
  const [customer, setCustomer] = useState<PublicCustomerQrData | null>(null);
  const [amountInput, setAmountInput] = useState('');
  const [submission, setSubmission] = useState<PublicQrPaymentSubmissionRpcResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    setOrder(null);
    setCustomer(null);
    setSubmission(null);
    setSuccess(false);
    setAmountInput('');
    void (async () => {
      try {
        const orderData = await getPublicOrderByToken(token).catch(() => null);
        if (!active) return;
        let contextFound = false;
        if (orderData) {
          setOrder(orderData);
          contextFound = true;
        } else {
          const customerData = await getPublicCustomerByToken(token);
          if (!active) return;
          if (customerData) {
            setCustomer(customerData);
            contextFound = true;
          } else {
            setLoadError(true);
          }
        }

        if (contextFound) {
          const previousSubmission = await rpcResolveQrPaymentSubmission(token);
          if (active && previousSubmission) {
            setSubmission(previousSubmission);
            setSuccess(true);
          }
        }
      } catch {
        if (active) setLoadError(true);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [token]);

  useEffect(() => {
    if (!receipt) {
      setReceiptPreview(null);
      return;
    }
    const url = URL.createObjectURL(receipt);
    setReceiptPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [receipt]);

  const isCustomerPayment = Boolean(customer && !order);
  const amountDue = order
    ? (typeof order.orderDueMinor === 'number' ? order.orderDueMinor : null)
    : (isCustomerPayment ? parseCustomerAmountMinor(amountInput) : null);
  const backHref = isCustomerPayment ? `/c/${token}` : `/o/${token}`;
  const formatAmount = (amount: number) => formatCurrency(amount);

  const copyNumber = async () => {
    try {
      await navigator.clipboard.writeText('0592369875');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError(isAr ? 'تعذّر نسخ الرقم. انسخه يدوياً.' : 'Could not copy the number. Please copy it manually.');
    }
  };

  const handleReceiptChange = (file?: File) => {
    setError('');
    setSuccess(false);
    if (!file) {
      setReceipt(null);
      return;
    }
    if (!file.type.startsWith('image/')) {
      setError(isAr ? 'ارفع صورة واضحة للإيصال فقط.' : 'Please upload a clear receipt image.');
      return;
    }
    if (file.size > MAX_SOURCE_FILE_BYTES) {
      setError(isAr ? 'حجم الصورة الأصلي كبير جداً. اختَر صورة أصغر.' : 'The original image is too large. Please choose a smaller image.');
      return;
    }
    setReceipt(file);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (!method) {
      setError(isAr ? 'اختَر طريقة الدفع أولاً.' : 'Choose a payment method first.');
      return;
    }
    if (!receipt) {
      setError(isAr ? 'صورة إيصال التحويل مطلوبة لإرسال الإشعار.' : 'A transfer receipt image is required.');
      return;
    }
    if ((!order && !customer) || amountDue === null || amountDue <= 0) {
      setError(isCustomerPayment ? (isAr ? 'أدخل مبلغاً صحيحاً أكبر من صفر.' : 'Enter a valid amount greater than zero.') : (isAr ? 'المبلغ المستحق غير متاح حالياً. ارجع للطلب وحاول لاحقاً.' : 'The outstanding amount is not available right now. Return to the order and try again later.'));
      return;
    }
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      setError(isAr ? 'خدمة الدفع غير متاحة حالياً. حاول لاحقاً.' : 'The payment service is unavailable right now. Please try again later.');
      return;
    }

    setSending(true);
    try {
      const compressed = await compressReceipt(receipt);
      const form = new FormData();
      form.append('token', token);
      form.append('payment_method', method);
      if (isCustomerPayment) form.append('amount_minor', String(amountDue));
      form.append('note', note.trim().slice(0, 500));
      form.append('receipt', compressed, compressed.name);

      const endpoint = `${config.supabaseUrl.replace(/\/+$/, '')}/functions/v1/submit-qr-payment`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          apikey: config.supabaseAnonKey,
          Authorization: `Bearer ${config.supabaseAnonKey}`,
        },
        body: form,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.success !== true) {
        const message = String(result.error || '');
        if (message.includes('already awaiting review') || response.status === 409) {
          throw new Error('PENDING_EXISTS');
        }
        if (response.status === 429) throw new Error('RATE_LIMIT');
        throw new Error('SUBMIT_FAILED');
      }

      setSubmission({
        status: 'PENDING',
        amount_minor: Number(result.amount_minor ?? amountDue),
        payment_method: method,
        created_at: new Date().toISOString(),
        reviewed_at: null,
      });
      setSuccess(true);
      setReceipt(null);
      setNote('');
      void rpcResolveQrPaymentSubmission(token).then((latest) => {
        if (latest) setSubmission(latest);
      });
    } catch (err: any) {
      const code = err?.message || '';
      if (code === 'IMAGE_REQUIRED') setError(isAr ? 'اختَر صورة إيصال صحيحة.' : 'Choose a valid receipt image.');
      else if (code === 'SOURCE_TOO_LARGE') setError(isAr ? 'الصورة الأصلية كبيرة. اختَر صورة أصغر من 12 ميغابايت.' : 'The original image is too large. Choose one under 12 MB.');
      else if (code === 'IMAGE_PROCESSING_UNAVAILABLE' || code === 'IMAGE_COMPRESSION_FAILED' || code === 'IMAGE_INVALID') setError(isAr ? 'تعذّر تجهيز الصورة. جرّب صورة أخرى واضحة.' : 'Could not process this image. Please try another clear image.');
      else if (code === 'COMPRESSED_TOO_LARGE') setError(isAr ? 'بعد الضغط بقي حجم الصورة كبيراً. اختَر صورة أوضح وأصغر.' : 'The compressed image is still too large. Choose a smaller image.');
      else if (code === 'PENDING_EXISTS') {
        setError(isAr ? 'يوجد إشعار دفع لهذا الحساب أو الطلب بانتظار المراجعة بالفعل.' : 'A payment notification for this account or order is already awaiting review.');
        const currentSubmission = await rpcResolveQrPaymentSubmission(token);
        if (currentSubmission) {
          setSubmission(currentSubmission);
          setSuccess(true);
          setError('');
        }
      }
      else if (code === 'RATE_LIMIT') setError(isAr ? 'تم إرسال عدة إشعارات لهذا الحساب أو الطلب. حاول لاحقاً.' : 'Several notifications were sent for this account or order. Please try again later.');
      else setError(isAr ? 'لم يتم إرسال الإشعار. بياناتك ما زالت موجودة؛ جرّب مرة ثانية.' : 'The notification was not sent. Your entries are preserved; please try again.');
    } finally {
      setSending(false);
    }
  };

  const pageTitle = isAr ? 'إشعار دفع' : 'Payment notification';

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} className="min-h-screen bg-[#f4f7f7] text-[#142c2c] dark:bg-[#071b1b] dark:text-[#e7f2ef] transition-colors">
      <header className="border-b border-[#dce6e4] bg-white/90 dark:bg-[#0a2423]/90 dark:border-[#1c4140]">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <a href={backHref} className="flex items-center gap-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-600">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#0f766e] text-white shadow-sm">
              <Zap className="h-5 w-5" />
            </span>
            <span>
              <span className="block text-sm font-bold tracking-tight">{isAr ? 'نقطة الشحن' : 'Charging Point'}</span>
              <span className="block text-[11px] text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'بوابة الدفع الآمنة' : 'Secure payment portal'}</span>
            </span>
          </a>
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => setLocale(isAr ? 'en' : 'ar')} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-[#365653] hover:bg-[#edf4f2] dark:text-[#c8d9d4] dark:hover:bg-[#133533]" aria-label="Toggle language">
              <Globe className="h-4 w-4" /> {isAr ? 'English' : 'عربي'}
            </button>
            <button type="button" onClick={toggleTheme} className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#dce6e4] hover:bg-[#edf4f2] dark:border-[#244746] dark:hover:bg-[#133533]" aria-label="Toggle theme">
              {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4 text-amber-300" />}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-5xl gap-6 px-4 py-7 sm:px-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:py-10">
        <section className="min-w-0 space-y-5">
          <div className="space-y-2">
            <a href={backHref} className="inline-flex items-center gap-2 text-xs font-semibold text-[#52716c] hover:text-[#0f766e] dark:text-[#a4c0b9]">
              {isRTL ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
              {isCustomerPayment ? (isAr ? 'العودة إلى حساب الزبون' : 'Back to customer account') : (isAr ? 'العودة إلى تفاصيل الطلب' : 'Back to order details')}
            </a>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0f766e]">{isAr ? 'بوابة العميل' : 'CUSTOMER PORTAL'}</p>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{pageTitle}</h1>
            <p className="max-w-xl text-sm leading-6 text-[#607874] dark:text-[#a7beb9]">
              {isCustomerPayment ? (isAr ? 'أدخل المبلغ الذي حوّلته على حسابك، ثم أرفق صورة الإيصال. الدفع يتم خارج التطبيق ويُراجع الإشعار يدوياً.' : 'Enter the amount you transferred to your customer account, then attach the receipt. Payment happens outside this app and the notification is reviewed manually.') : (isAr ? 'حوّل المبلغ، ثم أرفق صورة الإيصال حتى نراجع العملية. إرسال الإشعار لا يعني تأكيد الدفع تلقائياً.' : 'Complete the transfer, then attach the receipt so we can review it. Sending a notification does not automatically confirm payment.')}
            </p>
          </div>

          {loading ? (
            <div className="rounded-2xl border border-[#dce6e4] bg-white p-8 text-sm text-[#6b8580] shadow-sm dark:border-[#1c4140] dark:bg-[#0a2423]">{isAr ? 'جاري تحميل بيانات الطلب…' : 'Loading order details…'}</div>
          ) : loadError || !order ? (
            <div className="rounded-2xl border border-rose-200 bg-white p-8 text-center shadow-sm dark:border-rose-900 dark:bg-[#0a2423]">
              <h2 className="font-semibold">{isAr ? 'تعذّر العثور على الطلب' : 'Order not found'}</h2>
              <p className="mt-2 text-sm text-[#607874] dark:text-[#a7beb9]">{isAr ? 'رمز QR غير صالح أو منتهي، أو لا يرتبط بطلب أو حساب عميل نشط.' : 'This QR code is invalid, expired, or not linked to an active order or customer account.'}</p>
            </div>
          ) : success ? (
            <div className="rounded-2xl border border-[#dce6e4] bg-white p-8 shadow-sm dark:border-[#1c4140] dark:bg-[#0a2423]">
              <span className={`flex h-12 w-12 items-center justify-center rounded-full ${submission?.status === 'APPROVED' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : submission?.status === 'REJECTED' ? 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300'}`}>
                {submission?.status === 'REJECTED' ? <X className="h-6 w-6" /> : <CheckCircle2 className="h-6 w-6" />}
              </span>
              <h2 className="mt-5 text-xl font-semibold">
                {submission?.status === 'APPROVED' ? (isAr ? 'تم اعتماد الدفعة' : 'Payment approved')
                  : submission?.status === 'REJECTED' ? (isAr ? 'تم رفض إشعار الدفع' : 'Payment notification rejected')
                  : (isAr ? 'إشعار الدفع بانتظار المراجعة' : 'Payment notification awaiting review')}
              </h2>
              <p className="mt-2 text-sm leading-6 text-[#607874] dark:text-[#a7beb9]">
                {submission?.status === 'APPROVED'
                  ? (isAr ? 'تم اعتماد الإشعار وتسجيل الدفعة عبر المسار المالي الحالي.' : 'The notification was approved and the payment was recorded through the existing financial flow.')
                  : submission?.status === 'REJECTED'
                    ? (isAr ? 'لم تُسجّل دفعة ولم يتغير رصيد حسابك بسبب هذا الإشعار.' : 'No payment was recorded and your account balance was not changed by this notification.')
                    : (isAr ? 'تم حفظ إشعارك. لن يتغير رصيد الحساب قبل مراجعته واعتماده.' : 'Your notification is saved. Your account balance will not change until it is reviewed and approved.')}
              </p>
              {submission && (
                <div className="mt-5 space-y-3 rounded-xl border border-[#dce6e4] bg-[#f7faf9] p-4 text-sm dark:border-[#244746] dark:bg-[#0b2928]">
                  <div className="flex items-center justify-between gap-3"><span className="text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'المبلغ' : 'Amount'}</span><span className="font-semibold tabular-nums">{formatAmount(Number(submission.amount_minor))}</span></div>
                  <div className="flex items-center justify-between gap-3"><span className="text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'طريقة الدفع' : 'Payment method'}</span><span className="font-semibold">{methods.find((item) => item.id === submission.payment_method)?.[isAr ? 'ar' : 'en'] || submission.payment_method}</span></div>
                  {submission.status === 'APPROVED' && (
                    <>
                      <div className="flex items-center justify-between gap-3 border-t border-[#dce6e4] pt-3 dark:border-[#244746]"><span className="text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'رصيد الحساب قبل الاعتماد' : 'Balance before approval'}</span><span className="font-semibold tabular-nums">{submission.balance_before_minor == null ? '—' : formatAmount(Number(submission.balance_before_minor))}</span></div>
                      <div className="flex items-center justify-between gap-3"><span className="text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'رصيد الحساب بعد الاعتماد' : 'Balance after approval'}</span><span className="font-semibold tabular-nums text-[#0f766e] dark:text-[#83cbbd]">{submission.balance_after_minor == null ? '—' : formatAmount(Number(submission.balance_after_minor))}</span></div>
                    </>
                  )}
                  <p className="text-[11px] text-[#7d9690]">{isAr ? 'آخر تحديث' : 'Last update'}: {new Date(submission.reviewed_at || submission.created_at).toLocaleString(isAr ? 'ar-PS' : 'en-GB', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
                </div>
              )}
              <div className="mt-6 flex flex-wrap gap-3">
                <a href={backHref} className="inline-flex items-center gap-2 rounded-xl border border-[#dce6e4] px-4 py-3 text-sm font-semibold transition hover:bg-[#edf4f2] dark:border-[#315653] dark:hover:bg-[#133533]">{isCustomerPayment ? (isAr ? 'العودة إلى حساب الزبون' : 'Return to customer account') : (isAr ? 'العودة إلى الطلب' : 'Return to order')}</a>
                {submission?.status !== 'PENDING' && (
                  <button type="button" onClick={() => { setSuccess(false); setSubmission(null); setError(''); if (isCustomerPayment) setAmountInput(''); }} className="inline-flex items-center gap-2 rounded-xl bg-[#0f766e] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#115e59]">
                    {isAr ? 'إشعار دفع جديد' : 'New payment notification'}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-5">
              {isCustomerPayment && (
                <section className="rounded-2xl border border-[#dce6e4] bg-white p-5 shadow-[0_8px_30px_rgba(16,55,51,0.04)] dark:border-[#1c4140] dark:bg-[#0a2423] sm:p-6">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-base font-semibold">{isAr ? '1. أدخل مبلغ التحويل' : '1. Enter transfer amount'}</h2>
                      <p className="mt-1 text-xs text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'اكتب المبلغ الذي حوّلته فعلياً، بدون إنشاء طلب جديد.' : 'Enter the amount you actually transferred; no new order is created.'}</p>
                    </div>
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#eaf4f1] text-xs font-bold text-[#0f766e] dark:bg-[#133533] dark:text-[#a9d8cc]">01</span>
                  </div>
                  <label className="mt-4 block text-xs font-semibold text-[#365653] dark:text-[#c8d9d4]">
                    {isAr ? 'المبلغ' : 'Amount'}
                    <input type="number" inputMode="decimal" min="0.01" step="0.01" required value={amountInput} onChange={(e) => { setAmountInput(e.target.value); setError(''); }} placeholder={isAr ? 'مثال: 50.00' : 'e.g. 50.00'} className="mt-2 w-full rounded-xl border border-[#dce6e4] bg-white px-3.5 py-3 text-lg font-semibold tabular-nums outline-none transition placeholder:text-[#8aa19c] focus:border-[#0f766e] focus:ring-2 focus:ring-[#0f766e]/10 dark:border-[#315653] dark:bg-[#0b2928] dark:placeholder:text-[#779791]" />
                  </label>
                  <p className="mt-2 text-[11px] text-[#6b8580] dark:text-[#9bb6b0]">{amountDue !== null && amountDue > 0 ? (isAr ? `سيتم إرسال إشعار بمبلغ ${formatAmount(amountDue)}` : `Notification amount: ${formatAmount(amountDue)}`) : (isAr ? 'أدخل مبلغاً أكبر من صفر.' : 'Enter an amount greater than zero.')}</p>
                </section>
              )}
              <section className="rounded-2xl border border-[#dce6e4] bg-white p-5 shadow-[0_8px_30px_rgba(16,55,51,0.04)] dark:border-[#1c4140] dark:bg-[#0a2423] sm:p-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold">{isCustomerPayment ? (isAr ? '2. اختر طريقة التحويل' : '2. Choose a transfer method') : (isAr ? '1. اختر طريقة التحويل' : '1. Choose a transfer method')}</h2>
                    <p className="mt-1 text-xs text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'اختيار واحد مطلوب' : 'One option is required'}</p>
                  </div>
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#eaf4f1] text-xs font-bold text-[#0f766e] dark:bg-[#133533] dark:text-[#a9d8cc]">01</span>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  {methods.map((item) => {
                    const selected = method === item.id;
                    return (
                      <button key={item.id} type="button" onClick={() => { setMethod(item.id); setError(''); }}
                        aria-pressed={selected}
                        className={`relative flex min-h-[122px] flex-col items-start rounded-xl border p-3.5 text-start transition-all focus:outline-none focus:ring-2 focus:ring-[#0f766e] ${selected ? 'border-[#0f766e] bg-[#f0f8f6] shadow-[0_0_0_1px_#0f766e] dark:bg-[#10302e]' : 'border-[#dce6e4] bg-white hover:border-[#a8c7c0] dark:border-[#244746] dark:bg-[#0b2928] dark:hover:border-[#3b6e67]'}`}>
                        {selected && <CheckCircle2 className="absolute end-3 top-3 h-4 w-4 text-[#0f766e] dark:text-[#9cd6c9]" />}
                        <PaymentMethodLogo method={item} />
                        <span className="text-sm font-semibold">{isAr ? item.ar : item.en}</span>
                        <span className="mt-1 text-[11px] text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? item.descriptionAr : item.descriptionEn}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-2xl border border-[#dce6e4] bg-white p-5 shadow-[0_8px_30px_rgba(16,55,51,0.04)] dark:border-[#1c4140] dark:bg-[#0a2423] sm:p-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold">{isCustomerPayment ? (isAr ? '3. بيانات التحويل' : '3. Transfer details') : (isAr ? '2. بيانات التحويل' : '2. Transfer details')}</h2>
                    <p className="mt-1 text-xs text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'استخدم الرقم نفسه للطريقة المختارة' : 'Use the same destination number for the selected method'}</p>
                  </div>
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#eaf4f1] text-xs font-bold text-[#0f766e] dark:bg-[#133533] dark:text-[#a9d8cc]">02</span>
                </div>
                <div className="mt-4 rounded-xl border border-[#dce6e4] bg-[#f7faf9] p-4 dark:border-[#244746] dark:bg-[#0b2928]">
                  <button type="button" onClick={() => void copyNumber()} aria-label={isAr ? 'نسخ رقم التحويل' : 'Copy transfer number'} className="flex w-full items-center justify-between gap-3 rounded-lg text-start outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e]">
                    <span>
                      <span className="block text-[11px] text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'رقم التحويل · اضغط للنسخ' : 'Transfer number · tap to copy'}</span>
                      <span dir="ltr" className="mt-1 block text-xl font-semibold tracking-[0.06em]">0592369875</span>
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-[#dce6e4] bg-white px-3 py-2 text-xs font-semibold hover:bg-[#edf4f2] dark:border-[#315653] dark:bg-[#102f2d] dark:hover:bg-[#163d3a]">
                      <Copy className="h-3.5 w-3.5" /> {isAr ? 'نسخ' : 'Copy'}
                    </span>
                  </button>
                  {copied && <p role="status" aria-live="polite" className="mt-3 rounded-lg bg-[#eaf7ef] px-3 py-2 text-xs font-semibold text-[#17613c] dark:bg-[#12372a] dark:text-[#a9e6c0]">{isAr ? 'تم نسخ الرقم بنجاح' : 'Number copied successfully'}</p>}
                </div>
                <div className="mt-4 flex items-start gap-3 rounded-xl bg-[#f0f8f6] p-3.5 text-xs leading-5 text-[#41635d] dark:bg-[#10302e] dark:text-[#b4d0c8]">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#0f766e]" />
                  <p>{isAr ? 'تأكد من نجاح التحويل في تطبيقك قبل إرسال الإشعار. الإيصال يُراجع يدوياً ولا يُعتبر وحده إثباتاً نهائياً للدفع.' : 'Make sure the transfer completed in your payment app before submitting. The receipt is reviewed manually and is not itself final confirmation of payment.'}</p>
                </div>
              </section>

              <section className="rounded-2xl border border-[#dce6e4] bg-white p-5 shadow-[0_8px_30px_rgba(16,55,51,0.04)] dark:border-[#1c4140] dark:bg-[#0a2423] sm:p-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold">{isCustomerPayment ? (isAr ? '4. أرفق إيصال التحويل' : '4. Attach the transfer receipt') : (isAr ? '3. أرفق إيصال التحويل' : '3. Attach the transfer receipt')}</h2>
                    <p className="mt-1 text-xs text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'صورة واضحة مطلوبة' : 'A clear image is required'}</p>
                  </div>
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#eaf4f1] text-xs font-bold text-[#0f766e] dark:bg-[#133533] dark:text-[#a9d8cc]">03</span>
                </div>
                <label className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-[#a8c7c0] bg-[#f8fbfa] px-4 py-7 text-center transition hover:border-[#0f766e] hover:bg-[#f0f8f6] dark:border-[#315653] dark:bg-[#0b2928] dark:hover:bg-[#10302e]">
                  <UploadCloud className="h-7 w-7 text-[#0f766e]" />
                  <span className="mt-3 text-sm font-semibold">{receipt ? receipt.name : (isAr ? 'اضغط لاختيار صورة الإيصال' : 'Choose a receipt image')}</span>
                  <span className="mt-1 text-[11px] text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'سيتم ضغط الصورة قبل الرفع لتقليل الحجم مع الحفاظ على وضوحها' : 'The image will be compressed before upload while preserving readability'}</span>
                  <input type="file" accept="image/jpeg,image/png,image/webp,image/*" className="sr-only" onChange={(e) => handleReceiptChange(e.target.files?.[0])} />
                </label>
                {receiptPreview && (
                  <div className="mt-3 flex items-center gap-3 rounded-xl border border-[#dce6e4] p-3 dark:border-[#244746]">
                    <img src={receiptPreview} alt={isAr ? 'معاينة الإيصال' : 'Receipt preview'} className="h-16 w-16 rounded-lg object-cover" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold">{receipt?.name}</p>
                      <p className="mt-1 text-[11px] text-[#6b8580] dark:text-[#9bb6b0]">{receipt ? `${(receipt.size / 1024).toFixed(0)} KB` : ''}</p>
                    </div>
                    <button type="button" onClick={() => setReceipt(null)} className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[#edf4f2] dark:hover:bg-[#133533]" aria-label={isAr ? 'إزالة الصورة' : 'Remove image'}><X className="h-4 w-4" /></button>
                  </div>
                )}
                <label className="mt-5 block text-xs font-semibold text-[#365653] dark:text-[#c8d9d4]">
                  {isAr ? 'ملاحظة (اختياري)' : 'Note (optional)'}
                  <textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} rows={3} maxLength={500}
                    placeholder={isAr ? 'أضف أي معلومة تساعد في مطابقة التحويل…' : 'Add any detail that may help match the transfer…'}
                    className="mt-2 w-full resize-y rounded-xl border border-[#dce6e4] bg-white px-3.5 py-3 text-sm font-normal outline-none transition placeholder:text-[#8aa19c] focus:border-[#0f766e] focus:ring-2 focus:ring-[#0f766e]/10 dark:border-[#315653] dark:bg-[#0b2928] dark:placeholder:text-[#779791]" />
                  <span className="mt-1 block text-end text-[10px] font-normal text-[#7d9690]">{note.length}/500</span>
                </label>
              </section>

              {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">{error}</div>}

              <button type="submit" disabled={sending || !method || !receipt || amountDue === null || amountDue <= 0}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#0f766e] px-5 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#115e59] focus:outline-none focus:ring-2 focus:ring-[#0f766e] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45 dark:focus:ring-offset-[#071b1b]">
                {sending ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <ShieldCheck className="h-4 w-4" />}
                {sending ? (isAr ? 'جاري ضغط الصورة والإرسال…' : 'Compressing and sending…') : (isAr ? 'إرسال إشعار الدفع' : 'Send payment notification')}
              </button>
              <p className="text-center text-[11px] leading-5 text-[#6b8580] dark:text-[#9bb6b0]"><LockKeyhole className="me-1 inline h-3.5 w-3.5" />{isAr ? 'لن يتغير رصيدك أو حالة الطلب قبل اعتماد الإشعار. بعد الاعتماد، تُوزّع الدفعة على المستحقات من الأقدم للأحدث، وأي فائض يبقى رصيداً للزبون.' : 'Your balance and order status will not change until approval. The payment is then allocated to the oldest outstanding items first; any remainder stays as customer credit.'}</p>
            </form>
          )}
        </section>

        <aside className="h-fit space-y-4 lg:sticky lg:top-6">
          {isCustomerPayment && customer && !loadError && (
            <div className="overflow-hidden rounded-2xl border border-[#dce6e4] bg-white shadow-[0_8px_30px_rgba(16,55,51,0.05)] dark:border-[#1c4140] dark:bg-[#0a2423]">
              <div className="bg-[#103c38] px-5 py-5 text-white">
                <p className="text-[11px] font-semibold text-[#b9d8d0]">{isAr ? 'دفعة على حساب الزبون' : 'CUSTOMER ACCOUNT PAYMENT'}</p>
                <p className="mt-2 text-sm font-medium">{customer.customerName}</p>
                <p className="mt-1 text-xs text-[#b9d8d0]">{isAr ? 'مرجع العميل' : 'Customer reference'}: {customer.customerCode}</p>
              </div>
              <div className="p-5 text-sm">
                <div className="flex items-center justify-between gap-3"><span className="text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'مبلغ الإشعار' : 'Notification amount'}</span><span className="font-semibold tabular-nums">{amountDue !== null && amountDue > 0 ? formatAmount(amountDue) : '—'}</span></div>
                <p className="mt-3 text-xs leading-5 text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'سيُربط الإشعار بحسابك، وبعد الاعتماد تُوزّع الدفعة على المستحقات من الأقدم للأحدث.' : 'The notification is linked to your customer account; after approval, payment is allocated to the oldest outstanding items first.'}</p>
              </div>
            </div>
          )}
          {order && !loadError && (
            <div className="overflow-hidden rounded-2xl border border-[#dce6e4] bg-white shadow-[0_8px_30px_rgba(16,55,51,0.05)] dark:border-[#1c4140] dark:bg-[#0a2423]">
              <div className="bg-[#103c38] px-5 py-5 text-white">
                <p className="text-[11px] font-semibold text-[#b9d8d0]">{isAr ? 'ملخص الطلب' : 'ORDER SUMMARY'}</p>
                <p className="mt-2 text-sm font-medium">{order.customerName}</p>
                <p className="mt-1 text-xs text-[#b9d8d0]">{isAr ? `طلب رقم ${order.orderNumber}` : `Order #${order.orderNumber}`}</p>
              </div>
              <div className="space-y-4 p-5">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'إجمالي الطلب' : 'Order total'}</span>
                  <span className="font-semibold tabular-nums">{typeof order.orderTotalMinor === 'number' ? formatAmount(order.orderTotalMinor) : '—'}</span>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-[#e5ecea] pt-4 dark:border-[#244746]">
                  <span className="text-sm font-semibold">{isAr ? 'المبلغ المطلوب تحويله' : 'Transfer amount'}</span>
                  <span className="text-xl font-semibold tracking-tight tabular-nums text-[#0f766e] dark:text-[#83cbbd]">{amountDue !== null ? formatAmount(amountDue) : '—'}</span>
                </div>
                {order.items?.length ? (
                  <div className="space-y-2 border-t border-[#e5ecea] pt-4 dark:border-[#244746]">
                    {order.items.slice(0, 5).map((item, index) => (
                      <div key={`${item.name}-${index}`} className="flex items-start justify-between gap-3 text-xs">
                        <span className="min-w-0 text-[#607874] dark:text-[#a7beb9]">{item.name}{item.has_charger ? (isAr ? ' · مع شاحن' : ' · with charger') : ''}</span>
                        <span className="shrink-0 font-medium tabular-nums">{typeof item.total_price_minor === 'number' ? formatAmount(item.total_price_minor) : '—'}</span>
                      </div>
                    ))}
                    {order.items.length > 5 && <p className="text-[11px] text-[#7d9690]">{isAr ? `و ${order.items.length - 5} أجهزة أخرى` : `and ${order.items.length - 5} more items`}</p>}
                  </div>
                ) : null}
                {amountDue === 0 && (
                  <p className="rounded-lg bg-[#f0f8f6] p-3 text-xs leading-5 text-[#41635d] dark:bg-[#10302e] dark:text-[#b4d0c8]">{isAr ? 'لا يوجد مبلغ متبقٍ على هذا الطلب حالياً.' : 'There is no remaining amount on this order.'}</p>
                )}
              </div>
            </div>
          )}
          <div className="rounded-2xl border border-[#dce6e4] bg-[#edf5f2] p-4 text-xs leading-5 text-[#41635d] dark:border-[#1c4140] dark:bg-[#0c2927] dark:text-[#b4d0c8]">
            <div className="flex items-center gap-2 font-semibold"><FileImage className="h-4 w-4 text-[#0f766e]" />{isAr ? 'خصوصية الإيصال' : 'Receipt privacy'}</div>
            <p className="mt-2">{isAr ? 'يُحفظ الإيصال في مساحة خاصة، ولا يظهر إلا للمراجعين المصرّح لهم داخل التطبيق.' : 'Receipts are stored privately and are visible only to authorized reviewers inside the app.'}</p>
          </div>
        </aside>
      </main>

      <footer className="border-t border-[#dce6e4] px-4 py-5 text-center text-[11px] text-[#7d9690] dark:border-[#1c4140] dark:text-[#779791]">
        <span>{isAr ? 'نقطة الشحن · بوابة العميل' : 'Charging Point · Customer Portal'}</span>
        <span className="mx-2">·</span>
        <a href="/public/about" className="font-semibold hover:text-[#0f766e] dark:hover:text-[#83cbbd]">{isAr ? 'عن التطبيق' : 'About'}</a>
      </footer>
    </div>
  );
};
