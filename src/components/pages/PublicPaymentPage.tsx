import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, CheckCircle2, Copy, FileImage,
  Clock3, Globe, LockKeyhole, ShieldCheck, UploadCloud, X, Zap,
} from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
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
    id: 'BANK_OF_PALESTINE',
    ar: 'بنك فلسطين',
    en: 'Bank of Palestine',
    short: 'BOP',
    descriptionAr: 'تحويل بنكي',
    descriptionEn: 'Bank transfer',
    markClass: 'bg-[#e7f1e9] text-[#1d6a45]',
    logoUrl: 'https://bopwebsitestorage.blob.core.windows.net/assets/news/9sJP6saDV32QxvHqVHnTxo74fVXnHdPcCBzT2okA.jpg',
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
];

const PaymentMethodLogo: React.FC<{ method: typeof methods[number] }> = ({ method }) => {
  const [failed, setFailed] = useState(false);
  if (failed || !method.logoUrl) {
    return <span className={`mb-3 flex h-10 min-w-10 items-center justify-center rounded-lg px-2 text-[11px] font-black tracking-tight ${method.markClass}`}>{method.short}</span>;
  }
  return <img src={method.logoUrl} alt={method.short} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="mb-3 h-10 w-14 rounded-md object-contain" />;
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

  const isAr = locale === 'ar';
  const [order, setOrder] = useState<PublicOrderQrData | null>(null);
  const [customer, setCustomer] = useState<PublicCustomerQrData | null>(null);
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
  const [validationError, setValidationError] = useState<'method' | 'receipt' | null>(null);
  const methodSectionRef = useRef<HTMLElement | null>(null);
  const receiptSectionRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    setOrder(null);
    setCustomer(null);
    setSubmission(null);
    setSuccess(false);
    setMethod('');
    setReceipt(null);
    setNote('');
    setError('');
    setCopied(false);
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
  const amountDue = order ? (typeof order.orderDueMinor === 'number' ? order.orderDueMinor : null) : null;
  const backHref = isCustomerPayment ? `/c/${token}` : `/o/${token}`;
  const formatAmount = (amount: number) => formatCurrency(amount);

  const copyNumber = async () => {
    try {
      await navigator.clipboard.writeText('0592369875');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setValidationError(null);
      setError(isAr ? 'تعذّر نسخ الرقم. انسخه يدوياً.' : 'Could not copy the number. Please copy it manually.');
    }
  };

  const handleReceiptChange = (file?: File) => {
    setError('');
    setValidationError(null);
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
    setValidationError(null);
    if (!method) {
      setValidationError('method');
      setError(isAr ? 'يجب اختيار وسيلة الدفع قبل إرسال الإشعار.' : 'Please select a payment method before sending the notification.');
      methodSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!receipt) {
      setValidationError('receipt');
      setError(isAr ? 'يجب إرفاق صورة إشعار الدفع قبل الإرسال.' : 'Please attach a payment receipt image before sending.');
      receiptSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if ((!order && !customer) || (order && (amountDue === null || amountDue <= 0))) {
      setError(isAr ? 'المبلغ المستحق غير متاح حالياً. ارجع للطلب وحاول لاحقاً.' : 'The outstanding amount is not available right now. Return to the order and try again later.');
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
        amount_minor: Number(result.amount_minor ?? 0),
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

  const pageTitle = isAr ? 'صفحة الدفع' : 'Payment page';

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} className="public-portal-page min-h-screen bg-[#f4f7f7] text-[#142c2c] dark:bg-[#071b1b] dark:text-[#e7f2ef] transition-colors">
      <header className="border-b border-[#dce6e4] bg-white/95 dark:bg-[#0a2423]/95 dark:border-[#1c4140]">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <a href={backHref} className="flex items-center gap-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-600">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#0f766e] text-white">
              <Zap className="h-5 w-5" />
            </span>
            <span>
              <span className="block text-sm font-bold tracking-tight">{isAr ? 'نقطة الشحن' : 'Charging Point'}</span>
              <span className="block text-[11px] text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'خدمات الدفع' : 'Payment services'}</span>
            </span>
          </a>
          <button type="button" onClick={() => setLocale(isAr ? 'en' : 'ar')} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[#dce6e4] px-3 py-2 text-xs font-semibold text-[#365653] transition hover:bg-[#edf4f2] dark:border-[#315653] dark:text-[#c8d9d4] dark:hover:bg-[#133533]" aria-label="Toggle language">
            <Globe className="h-4 w-4" /> {isAr ? 'English' : 'عربي'}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-6 px-4 py-7 sm:px-6 sm:py-9">
        <div className="space-y-3">
          <a href={backHref} className="inline-flex items-center gap-2 text-xs font-semibold text-[#52716c] transition hover:text-[#0f766e] dark:text-[#a4c0b9]">
            {isRTL ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
            {isCustomerPayment ? (isAr ? 'العودة إلى حساب الزبون' : 'Back to customer account') : (isAr ? 'العودة إلى تفاصيل الطلب' : 'Back to order details')}
          </a>
          <div className="space-y-1.5">
            <p className="text-xs font-bold tracking-wide text-[#0f766e] dark:text-[#83cbbd]">{isAr ? 'الدفع والتحويل' : 'PAYMENT & TRANSFER'}</p>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{pageTitle}</h1>
            <p className="max-w-xl text-sm leading-6 text-[#607874] dark:text-[#a7beb9]">
              {isAr ? 'انسخ رقم الدفع، واختر وسيلة التحويل، ثم أرفق صورة إشعار الدفع لإرسالها للمراجعة.' : 'Copy the payment number, select a transfer method, then attach your receipt for review.'}
            </p>
          </div>
        </div>

        {loading ? (
          <div className="rounded-2xl border border-[#dce6e4] bg-white p-8 text-center text-sm text-[#6b8580] shadow-sm dark:border-[#1c4140] dark:bg-[#0a2423] dark:text-[#9bb6b0]">
            {isAr ? 'جارٍ تحميل بيانات الدفع…' : 'Loading payment details…'}
          </div>
        ) : loadError || (!order && !customer) ? (
          <div className="rounded-2xl border border-rose-200 bg-white p-8 text-center shadow-sm dark:border-rose-900 dark:bg-[#0a2423]">
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300"><X className="h-5 w-5" /></span>
            <h2 className="mt-4 font-semibold">{isAr ? 'تعذّر العثور على بيانات الدفع' : 'Payment details not found'}</h2>
            <p className="mt-2 text-sm leading-6 text-[#607874] dark:text-[#a7beb9]">{isAr ? 'قد يكون الرابط غير صالح أو منتهي الصلاحية. افتح رابط الدفع الصحيح أو ارجع إلى صفحة الطلب.' : 'This link may be invalid or expired. Open a valid payment link or return to the order page.'}</p>
          </div>
        ) : success ? (
          <section className="rounded-2xl border border-[#dce6e4] bg-white p-6 shadow-[0_12px_36px_rgba(16,55,51,0.05)] dark:border-[#1c4140] dark:bg-[#0a2423] sm:p-8">
            <span className={`flex h-12 w-12 items-center justify-center rounded-full ${submission?.status === 'APPROVED' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : submission?.status === 'REJECTED' ? 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300'}`}>
              {submission?.status === 'REJECTED' ? <X className="h-6 w-6" /> : submission?.status === 'PENDING' ? <Clock3 className="h-6 w-6" /> : <CheckCircle2 className="h-6 w-6" />}
            </span>
            <h2 className="mt-5 text-xl font-bold">
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
                {submission.status === 'APPROVED' ? (
                  <div className="flex items-center justify-between gap-3"><span className="text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'المبلغ المعتمد' : 'Approved amount'}</span><span className="font-semibold tabular-nums">{formatAmount(Number(submission.amount_minor))}</span></div>
                ) : (
                  <p className="text-xs leading-5 text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'سيتم تحديد المبلغ بعد مراجعة الإيصال والتحقق منه.' : 'The amount will be set after the receipt is reviewed and verified.'}</p>
                )}
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
              {submission?.status !== 'PENDING' && (isCustomerPayment || (typeof order?.orderDueMinor === 'number' && order.orderDueMinor > 0)) && (
                <button type="button" onClick={() => { setSuccess(false); setSubmission(null); setError(''); }} className="inline-flex items-center gap-2 rounded-xl bg-[#0f766e] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#115e59]">{isAr ? 'إشعار دفع جديد' : 'New payment notification'}</button>
              )}
            </div>
          </section>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            {error && validationError === null && (
              <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">{error}</div>
            )}

            <section className="rounded-2xl border border-[#dce6e4] bg-white p-5 shadow-[0_12px_36px_rgba(16,55,51,0.045)] dark:border-[#1c4140] dark:bg-[#0a2423] sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold text-[#607874] dark:text-[#a7beb9]">{isAr ? 'رقم الدفع' : 'Payment number'}</p>
                  <p dir="ltr" className="mt-2 text-2xl font-bold tracking-[0.08em] text-[#142c2c] dark:text-[#e7f2ef] sm:text-3xl">0592369875</p>
                </div>
                <button type="button" onClick={() => void copyNumber()} aria-label={isAr ? 'نسخ رقم الدفع' : 'Copy payment number'} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#b9d2cc] bg-[#f5faf8] px-4 py-2.5 text-sm font-semibold text-[#0f766e] transition hover:bg-[#eaf4f1] focus:outline-none focus:ring-2 focus:ring-[#0f766e] dark:border-[#315653] dark:bg-[#102f2d] dark:text-[#a9d8cc] dark:hover:bg-[#163d3a]">
                  <Copy className="h-4 w-4" /> {copied ? (isAr ? 'تم النسخ' : 'Copied') : (isAr ? 'نسخ الرقم' : 'Copy number')}
                </button>
              </div>
              {copied && <p role="status" aria-live="polite" className="mt-3 text-xs font-semibold text-[#17613c] dark:text-[#a9e6c0]">{isAr ? 'تم نسخ رقم الدفع بنجاح.' : 'Payment number copied.'}</p>}
            </section>

            <section ref={methodSectionRef} className="scroll-mt-8 rounded-2xl border border-[#dce6e4] bg-white p-5 shadow-[0_12px_36px_rgba(16,55,51,0.045)] dark:border-[#1c4140] dark:bg-[#0a2423] sm:p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold">{isAr ? 'وسيلة الدفع' : 'Payment method'}</h2>
                  <p className="mt-1 text-xs text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'اختر وسيلة واحدة لإتمام التحويل.' : 'Select one method for your transfer.'}</p>
                </div>
                <span className="text-xs font-semibold text-rose-600 dark:text-rose-300">{isAr ? 'مطلوب' : 'Required'}</span>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2.5 sm:gap-3">
                {methods.map((item) => {
                  const selected = method === item.id;
                  return (
                    <button key={item.id} type="button" onClick={() => { setMethod(item.id); setError(''); setValidationError(null); }}
                      aria-pressed={selected}
                      className={`relative flex min-h-[112px] flex-col items-center justify-center rounded-xl border p-2.5 text-center transition-all focus:outline-none focus:ring-2 focus:ring-[#0f766e] sm:min-h-[124px] sm:p-3 ${selected ? 'border-[#0f766e] bg-[#f0f8f6] shadow-[0_0_0_1px_#0f766e] dark:bg-[#10302e]' : 'border-[#dce6e4] bg-white hover:border-[#a8c7c0] dark:border-[#244746] dark:bg-[#0b2928] dark:hover:border-[#3b6e67]'}`}>
                      {selected && <CheckCircle2 className="absolute end-2 top-2 h-4 w-4 text-[#0f766e] dark:text-[#9cd6c9]" />}
                      <PaymentMethodLogo method={item} />
                      <span className="text-xs font-bold leading-5 sm:text-sm">{isAr ? item.ar : item.en}</span>
                      <span className="mt-1 text-[10px] leading-4 text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? item.descriptionAr : item.descriptionEn}</span>
                    </button>
                  );
                })}
              </div>
              {error && validationError === 'method' && <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold leading-5 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">{error}</p>}
            </section>

            <section ref={receiptSectionRef} className="scroll-mt-8 rounded-2xl border border-[#dce6e4] bg-white p-5 shadow-[0_12px_36px_rgba(16,55,51,0.045)] dark:border-[#1c4140] dark:bg-[#0a2423] sm:p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold">{isAr ? 'إرفاق إشعار الدفع' : 'Attach payment receipt'}</h2>
                  <p className="mt-1 text-xs leading-5 text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'يرجى إرفاق صورة واضحة لإشعار التحويل حتى نتمكن من مراجعته.' : 'Please attach a clear image of the transfer receipt so it can be reviewed.'}</p>
                </div>
                <span className="text-xs font-semibold text-rose-600 dark:text-rose-300">{isAr ? 'مطلوب' : 'Required'}</span>
              </div>
              <label className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-[#a8c7c0] bg-[#f8fbfa] px-4 py-7 text-center transition hover:border-[#0f766e] hover:bg-[#f0f8f6] dark:border-[#315653] dark:bg-[#0b2928] dark:hover:bg-[#10302e]">
                <UploadCloud className="h-7 w-7 text-[#0f766e] dark:text-[#83cbbd]" />
                <span className="mt-3 text-sm font-semibold">{receipt ? receipt.name : (isAr ? 'اضغط لاختيار صورة الإيصال' : 'Tap to choose a receipt image')}</span>
                <span className="mt-1 max-w-sm text-[11px] leading-5 text-[#6b8580] dark:text-[#9bb6b0]">{isAr ? 'يُقبل ملف صورة فقط. ستُضغط الصورة قبل الرفع مع الحفاظ على وضوح بيانات التحويل.' : 'Image files only. The image is compressed before upload while keeping transfer details readable.'}</span>
                <input type="file" accept="image/jpeg,image/png,image/webp,image/*" className="sr-only" onChange={(e) => handleReceiptChange(e.target.files?.[0])} />
              </label>
              {error && validationError === 'receipt' && <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold leading-5 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">{error}</p>}
              {receiptPreview && (
                <div className="mt-3 flex items-center gap-3 rounded-xl border border-[#dce6e4] p-3 dark:border-[#244746]">
                  <img src={receiptPreview} alt={isAr ? 'معاينة الإيصال' : 'Receipt preview'} className="h-16 w-16 rounded-lg object-cover" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold">{receipt?.name}</p>
                    <p className="mt-1 text-[11px] text-[#6b8580] dark:text-[#9bb6b0]">{receipt ? `${(receipt.size / 1024).toFixed(0)} KB` : ''}</p>
                  </div>
                  <button type="button" onClick={() => setReceipt(null)} className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-[#edf4f2] dark:hover:bg-[#133533]" aria-label={isAr ? 'إزالة الصورة' : 'Remove image'}><X className="h-4 w-4" /></button>
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-[#dce6e4] bg-white p-5 shadow-[0_12px_36px_rgba(16,55,51,0.045)] dark:border-[#1c4140] dark:bg-[#0a2423] sm:p-6">
              <label className="block text-sm font-semibold">
                {isAr ? 'ملاحظة (اختياري)' : 'Note (optional)'}
                <textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} rows={3} maxLength={500}
                  placeholder={isAr ? 'أضف ملاحظة تساعد في مطابقة التحويل، إن لزم…' : 'Add a note to help match the transfer, if needed…'}
                  className="mt-2 w-full resize-y rounded-xl border border-[#dce6e4] bg-white px-3.5 py-3 text-sm font-normal outline-none transition placeholder:text-[#8aa19c] focus:border-[#0f766e] focus:ring-2 focus:ring-[#0f766e]/10 dark:border-[#315653] dark:bg-[#0b2928] dark:placeholder:text-[#779791]" />
                <span className="mt-1 block text-end text-[10px] font-normal text-[#7d9690]">{note.length}/500</span>
              </label>
            </section>

            <button type="submit" disabled={sending || (Boolean(order) && (amountDue === null || amountDue <= 0))}
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#0f766e] px-5 py-3.5 text-sm font-bold text-white shadow-sm transition hover:bg-[#115e59] focus:outline-none focus:ring-2 focus:ring-[#0f766e] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45 dark:focus:ring-offset-[#071b1b]">
              {sending ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <ShieldCheck className="h-4 w-4" />}
              {sending ? (isAr ? 'جارٍ تجهيز الصورة والإرسال…' : 'Preparing image and sending…') : (isAr ? 'إرسال إشعار الدفع' : 'Send payment notification')}
            </button>

            <div className="rounded-xl border border-[#dce6e4] bg-[#edf5f2] p-4 text-xs leading-6 text-[#41635d] dark:border-[#1c4140] dark:bg-[#0c2927] dark:text-[#b4d0c8]">
              <p className="flex items-start gap-2 font-semibold">
                <LockKeyhole className="mt-1 h-4 w-4 shrink-0 text-[#0f766e] dark:text-[#83cbbd]" />
                <span>{isAr ? 'لن يتغير رصيدك أو حالة الطلب قبل اعتماد إشعار الدفع.' : 'Your balance and order status will not change until the payment notification is approved.'}</span>
              </p>
              <p className="mt-2 ps-6">{isAr ? 'بعد الاعتماد، تُوزّع الدفعة على المستحقات من الأقدم إلى الأحدث، وأي مبلغ فائض يُضاف إلى رصيدك.' : 'After approval, the payment is allocated to the oldest outstanding items first; any excess remains as customer credit.'}</p>
            </div>

            <div className="rounded-xl border border-[#dce6e4] bg-white p-4 text-xs leading-6 text-[#607874] dark:border-[#1c4140] dark:bg-[#0a2423] dark:text-[#a7beb9]">
              <p className="flex items-center gap-2 font-semibold text-[#365653] dark:text-[#c8d9d4]"><FileImage className="h-4 w-4 text-[#0f766e] dark:text-[#83cbbd]" />{isAr ? 'خصوصية الإيصال' : 'Receipt privacy'}</p>
              <p className="mt-2">{isAr ? 'يُحفظ الإيصال في مساحة خاصة، ولا يطّلع عليه إلا المراجعون المصرّح لهم داخل النظام.' : 'Your receipt is stored privately and can only be viewed by authorized reviewers in the system.'}</p>
            </div>
          </form>
        )}
      </main>

      <footer className="border-t border-[#dce6e4] px-4 py-5 text-center text-[11px] text-[#7d9690] dark:border-[#1c4140] dark:text-[#779791]">
        <span>{isAr ? 'نقطة الشحن · خدمات الدفع' : 'Charging Point · Payment services'}</span>
      </footer>
    </div>
  );
};
