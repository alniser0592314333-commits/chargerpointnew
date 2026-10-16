import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Check, CheckCircle2, Copy, FileImage,
  Clock3, Globe, LockKeyhole, Moon, ShieldCheck, Sun, UploadCloud,
  X, Zap, CreditCard, Building2, Smartphone, Wallet, AlertCircle, RefreshCw,
} from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';
import {
  getPublicCustomerByToken,
  getPublicOrderByToken,
  getItemLocalizedDeviceName,
  PublicCustomerQrData,
  PublicOrderQrData,
} from './dayOrdersStore';
import { config } from '../../config/env';
import {
  PublicQrPaymentSubmissionRpcResult,
  rpcResolveQrPaymentSubmission,
} from '../../services/supabase/client';

type PaymentMethod = 'JAWAL_PAY' | 'PALPAY' | 'BANK_OF_PALESTINE';

interface PaymentMethodItem {
  id: PaymentMethod;
  ar: string;
  en: string;
  short: string;
  descriptionAr: string;
  descriptionEn: string;
  badgeAr: string;
  badgeEn: string;
  markClass: string;
  logoUrl: string;
}

const PAYMENT_METHODS: PaymentMethodItem[] = [
  {
    id: 'BANK_OF_PALESTINE',
    ar: 'بنك فلسطين',
    en: 'Bank of Palestine',
    short: 'BOP',
    descriptionAr: 'تحويل بنكي مباشر',
    descriptionEn: 'Direct bank transfer',
    badgeAr: 'حساب بنكي',
    badgeEn: 'Bank Account',
    markClass: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300',
    logoUrl: 'https://bopwebsitestorage.blob.core.windows.net/assets/news/9sJP6saDV32QxvHqVHnTxo74fVXnHdPcCBzT2okA.jpg',
  },
  {
    id: 'JAWAL_PAY',
    ar: 'جوال باي',
    en: 'Jawwal Pay',
    short: 'Jawwal Pay',
    descriptionAr: 'محفظة إلكترونية فورية',
    descriptionEn: 'Instant digital wallet',
    badgeAr: 'محفظة رقمية',
    badgeEn: 'Digital Wallet',
    markClass: 'bg-rose-50 text-rose-800 dark:bg-rose-950/70 dark:text-rose-300',
    logoUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/15/79/dc/1579dcea-3b6b-459a-3fb8-752262e39b6f/AppIcon-0-1x_U007emarketing-0-8-0-0-sRGB-85-220-0.png/512x512bb.jpg',
  },
  {
    id: 'PALPAY',
    ar: 'بال باي (محفظتي)',
    en: 'PalPay (Mahfazati)',
    short: 'PalPay',
    descriptionAr: 'محفظة بال باي الإلكترونية',
    descriptionEn: 'PalPay mobile wallet',
    badgeAr: 'محفظة رقمية',
    badgeEn: 'Mobile Wallet',
    markClass: 'bg-purple-50 text-purple-800 dark:bg-purple-950/70 dark:text-purple-300',
    logoUrl: 'https://bopwebsitestorage.blob.core.windows.net/assets/uploads/l9IcwMLAVdCnG7anhRZRTisqSbNCcsYK1NV4LwZM.png',
  },
];

const PaymentMethodLogo: React.FC<{ method: PaymentMethodItem }> = ({ method }) => {
  const [failed, setFailed] = useState(false);
  if (failed || !method.logoUrl) {
    return (
      <div className={`flex h-10 w-12 shrink-0 items-center justify-center rounded-lg font-bold text-xs ${method.markClass}`}>
        {method.short}
      </div>
    );
  }
  return (
    <div className="flex h-11 w-13 shrink-0 items-center justify-center rounded-xl bg-white p-1.5 shadow-sm ring-1 ring-slate-200/80 dark:bg-slate-800 dark:ring-slate-700">
      <img
        src={method.logoUrl}
        alt={method.short}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="h-full w-full object-contain"
      />
    </div>
  );
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
  const { theme, resolvedTheme, toggleTheme } = useTheme();

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
    setValidationError(null);
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
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      setValidationError(null);
      setError(isAr ? 'تعذّر نسخ الرقم تلقائياً. يرجى نسخه يدوياً.' : 'Could not copy automatically. Please copy manually.');
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
      setError(isAr ? 'يرجى اختيار ملف صورة صالح (JPEG أو PNG أو WebP).' : 'Please choose a valid image file (JPEG, PNG, or WebP).');
      return;
    }
    if (file.size > MAX_SOURCE_FILE_BYTES) {
      setError(isAr ? 'حجم الصورة كبير جداً. يرجى اختيار صورة أقل من 12 ميغابايت.' : 'File too large. Please select an image under 12 MB.');
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
      setError(isAr ? 'يرجى اختيار وسيلة الدفع أولاً للمتابعة.' : 'Please choose a payment method to proceed.');
      methodSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!receipt) {
      setValidationError('receipt');
      setError(isAr ? 'يرجى إرفاق صورة إشعار أو إيصال التحويل لإتمام الإرسال.' : 'Please attach your payment receipt image to complete submission.');
      receiptSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if ((!order && !customer) || (order && (amountDue === null || amountDue <= 0))) {
      setError(isAr ? 'المبلغ المستحق غير متاح أو تم سداده بالفعل. ارجع إلى صفحة الطلب.' : 'The balance due is unavailable or already paid. Please return to your order page.');
      return;
    }
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      setError(isAr ? 'خدمة استقبال الإشعارات غير متاحة حالياً. يرجى المحاولة لاحقاً.' : 'Payment submission service is currently offline. Please try again later.');
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
      if (code === 'IMAGE_REQUIRED') {
        setError(isAr ? 'يرجى اختيار صورة إيصال صحيحة.' : 'Please choose a valid receipt image.');
      } else if (code === 'SOURCE_TOO_LARGE') {
        setError(isAr ? 'الصورة الأصلية كبيرة. اختَر صورة أقل من 12 ميغابايت.' : 'Original image is too large. Select an image under 12 MB.');
      } else if (code === 'IMAGE_PROCESSING_UNAVAILABLE' || code === 'IMAGE_COMPRESSION_FAILED' || code === 'IMAGE_INVALID') {
        setError(isAr ? 'تعذّر تجهيز الصورة. يرجى تجربة صورة أخرى واضحة.' : 'Could not process image. Please try another clear image.');
      } else if (code === 'COMPRESSED_TOO_LARGE') {
        setError(isAr ? 'حجم الصورة بعد الضغط ما زال كبيراً. اختَر صورة أصغر وأوضح.' : 'Compressed image remains too large. Choose a smaller image.');
      } else if (code === 'PENDING_EXISTS') {
        setError(isAr ? 'يوجد إشعار دفع سابق بانتظار المراجعة بالفعل لهذا الطلب أو الحساب.' : 'A previous payment notification is already awaiting review for this order or account.');
        const currentSubmission = await rpcResolveQrPaymentSubmission(token);
        if (currentSubmission) {
          setSubmission(currentSubmission);
          setSuccess(true);
          setError('');
        }
      } else if (code === 'RATE_LIMIT') {
        setError(isAr ? 'تم إرسال عدة إشعارات خلال وقت قصير. يرجى الانتظار قليلاً.' : 'Too many notifications submitted recently. Please wait a moment and try again.');
      } else {
        setError(isAr ? 'تعذّر إرسال الإشعار حالياً. بياناتك محفوظة؛ يرجى إعادة المحاولة.' : 'Could not submit notification. Your entries are saved; please try again.');
      }
    } finally {
      setSending(false);
    }
  };

  const pageTitle = isAr ? 'بوابة الدفع والتحويل' : 'Payment & Transfer Portal';

  return (
    <div
      dir={isRTL ? 'rtl' : 'ltr'}
      className="min-h-screen bg-slate-50 text-slate-900 transition-colors duration-200 dark:bg-[#071313] dark:text-slate-100"
    >
      {/* 1. Header Bar */}
      <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/80 backdrop-blur-md dark:border-[#163532] dark:bg-[#071313]/85">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
          <a
            href={backHref}
            className="group flex items-center gap-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm transition group-hover:bg-emerald-700 dark:bg-emerald-500 dark:group-hover:bg-emerald-600">
              <Zap className="h-5 w-5" />
            </span>
            <div className="flex flex-col text-start">
              <strong className="text-sm font-black tracking-tight text-slate-900 dark:text-slate-50">
                {isAr ? 'نقطة الشحن' : 'Charging Point'}
              </strong>
              <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                {isAr ? 'خدمة الدفع والتحويل' : 'Payment & Transfer Service'}
              </span>
            </div>
          </a>

          {/* Quick Header Actions: Theme & Language */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleTheme}
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200/90 bg-white text-slate-700 shadow-sm transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-[#1e4440] dark:bg-[#0b1f1e] dark:text-slate-200 dark:hover:bg-[#12312f]"
              aria-label={isAr ? 'تبديل المظهر (فاتح / داكن)' : 'Toggle theme (Light / Dark)'}
              title={isAr ? 'المظهر' : 'Theme'}
            >
              {resolvedTheme === 'dark' ? (
                <Sun className="h-4 w-4 text-amber-400" />
              ) : (
                <Moon className="h-4 w-4 text-slate-600" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setLocale(isAr ? 'en' : 'ar')}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-slate-200/90 bg-white px-3 text-xs font-bold text-slate-700 shadow-sm transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-[#1e4440] dark:bg-[#0b1f1e] dark:text-slate-200 dark:hover:bg-[#12312f]"
              aria-label={isAr ? 'Switch to English' : 'التحويل للعربية'}
            >
              <Globe className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              <span>{isAr ? 'English' : 'عربي'}</span>
            </button>
          </div>
        </div>
      </header>

      {/* 2. Main Container */}
      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8 lg:py-10">
        {/* Navigation Breadcrumb */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <a
            href={backHref}
            className="inline-flex items-center gap-2 text-xs font-bold text-emerald-700 transition hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300"
          >
            {isRTL ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
            <span>
              {isCustomerPayment
                ? (isAr ? 'العودة إلى حساب الزبون' : 'Back to Customer Account')
                : (isAr ? 'العودة إلى تفاصيل الطلب' : 'Back to Order Details')}
            </span>
          </a>

          <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200/70 bg-emerald-50/80 px-3 py-1 text-[11px] font-bold text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>{isAr ? 'تحويل بنكي ومحافظ رقمية' : 'Bank & Digital Wallets'}</span>
          </div>
        </div>

        {/* Loading State */}
        {loading ? (
          <div className="flex flex-col items-center justify-center rounded-3xl border border-slate-200/80 bg-white p-12 text-center shadow-sm dark:border-[#193a38] dark:bg-[#0c1f1e]">
            <RefreshCw className="h-8 w-8 animate-spin text-emerald-600 dark:text-emerald-400" />
            <p className="mt-4 text-sm font-bold text-slate-700 dark:text-slate-300">
              {isAr ? 'جارٍ تحميل بيانات الدفع والطلب…' : 'Loading payment & order details…'}
            </p>
          </div>
        ) : loadError || (!order && !customer) ? (
          /* Error State: Invalid or Expired Token */
          <div className="rounded-3xl border border-rose-200 bg-white p-8 text-center shadow-sm dark:border-rose-900/60 dark:bg-[#0c1f1e] sm:p-12">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-50 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400">
              <AlertCircle className="h-7 w-7" />
            </span>
            <h2 className="mt-5 text-xl font-black text-slate-900 dark:text-slate-50">
              {isAr ? 'تعذّر الوصول لبيانات الدفع' : 'Payment details could not be found'}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600 dark:text-slate-400">
              {isAr
                ? 'الرابط غير صالح أو منتهي الصلاحية، أو تم حذفه من النظام. يرجى مسح رمز QR الصحيح مجدداً.'
                : 'This link is invalid or expired. Please re-scan the original QR code to proceed.'}
            </p>
            <div className="mt-6">
              <a
                href="/"
                className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-xs font-bold text-white shadow-sm transition hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
              >
                {isAr ? 'الصفحة الرئيسية' : 'Home page'}
              </a>
            </div>
          </div>
        ) : success && submission ? (
          /* Success / Existing Submission Screen */
          <section className="mx-auto max-w-2xl space-y-6">
            <div className="overflow-hidden rounded-3xl border border-slate-200/90 bg-white p-6 shadow-md transition dark:border-[#1b3d3a] dark:bg-[#0c1f1e] sm:p-8">
              {/* Status Header Badge */}
              <div className="flex items-center gap-4">
                <span
                  className={`flex h-13 w-13 shrink-0 items-center justify-center rounded-2xl ${
                    submission.status === 'APPROVED'
                      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                      : submission.status === 'REJECTED'
                      ? 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300'
                      : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                  }`}
                >
                  {submission.status === 'APPROVED' ? (
                    <CheckCircle2 className="h-7 w-7" />
                  ) : submission.status === 'REJECTED' ? (
                    <X className="h-7 w-7" />
                  ) : (
                    <Clock3 className="h-7 w-7" />
                  )}
                </span>
                <div>
                  <span
                    className={`inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-black tracking-wide uppercase ${
                      submission.status === 'APPROVED'
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                        : submission.status === 'REJECTED'
                        ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300'
                        : 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
                    }`}
                  >
                    {submission.status === 'APPROVED'
                      ? (isAr ? 'معتمد' : 'APPROVED')
                      : submission.status === 'REJECTED'
                      ? (isAr ? 'مرفوض' : 'REJECTED')
                      : (isAr ? 'قيد المراجعة' : 'PENDING REVIEW')}
                  </span>
                  <h1 className="mt-1 text-2xl font-black tracking-tight text-slate-900 dark:text-slate-50">
                    {submission.status === 'APPROVED'
                      ? (isAr ? 'تم اعتماد الدفعة بنجاح' : 'Payment approved')
                      : submission.status === 'REJECTED'
                      ? (isAr ? 'تم رفض إشعار الدفع' : 'Payment notification rejected')
                      : (isAr ? 'إشعار الدفع بانتظار المراجعة' : 'Payment notification received')}
                  </h1>
                </div>
              </div>

              {/* Status Explanation */}
              <p className="mt-4 text-sm leading-6 text-slate-600 dark:text-slate-400">
                {submission.status === 'APPROVED'
                  ? (isAr
                      ? 'تم التحقق من إيصال التحويل واعتماد المبلغ رسمياً في السجل المالي للنظام.'
                      : 'The receipt was verified and the payment amount was officially credited.')
                  : submission.status === 'REJECTED'
                  ? (isAr
                      ? 'تم رفض الإشعار بعد التدقيق. لم يتم خصم أو إضافة مبالغ لحسابك.'
                      : 'The notification was rejected upon review. No balance change was recorded.')
                  : (isAr
                      ? 'تم حفظ إشعارك وصورة الإيصال بنجاح. سيقوم المسؤول بمطابقة الإيصال واعتماده قريباً.'
                      : 'Your notification and receipt are securely saved and will be reviewed shortly by our team.')}
              </p>

              {/* Submission Metadata Breakdown */}
              <div className="mt-6 divide-y divide-slate-200/80 rounded-2xl border border-slate-200/90 bg-slate-50/70 p-4 text-sm dark:divide-slate-800 dark:border-[#1d4440] dark:bg-[#071716]">
                <div className="flex items-center justify-between pb-3">
                  <span className="text-slate-500 dark:text-slate-400">{isAr ? 'وسيلة التحويل' : 'Payment Method'}</span>
                  <span className="font-bold text-slate-900 dark:text-slate-100">
                    {PAYMENT_METHODS.find((item) => item.id === submission.payment_method)?.[isAr ? 'ar' : 'en'] || submission.payment_method}
                  </span>
                </div>

                {submission.status === 'APPROVED' ? (
                  <div className="flex items-center justify-between py-3">
                    <span className="text-slate-500 dark:text-slate-400">{isAr ? 'المبلغ المعتمد' : 'Approved Amount'}</span>
                    <span className="text-base font-black text-emerald-600 dark:text-emerald-400 tabular-nums">
                      {formatAmount(Number(submission.amount_minor))}
                    </span>
                  </div>
                ) : (
                  <div className="py-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
                    {isAr
                      ? 'المبلغ النهائي يُحدّد ويعتمد بواسطة الإدارة بعد التدقيق والمطابقة مع كشف الحساب.'
                      : 'The approved amount will be set after verifying with bank/wallet records.'}
                  </div>
                )}

                {submission.status === 'APPROVED' && (
                  <>
                    <div className="flex items-center justify-between py-3">
                      <span className="text-slate-500 dark:text-slate-400">{isAr ? 'الرصيد قبل الاعتماد' : 'Balance before'}</span>
                      <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-200">
                        {submission.balance_before_minor == null ? '—' : formatAmount(Number(submission.balance_before_minor))}
                      </span>
                    </div>
                    <div className="flex items-center justify-between py-3">
                      <span className="text-slate-500 dark:text-slate-400">{isAr ? 'الرصيد بعد الاعتماد' : 'Balance after'}</span>
                      <span className="font-black tabular-nums text-emerald-600 dark:text-emerald-400">
                        {submission.balance_after_minor == null ? '—' : formatAmount(Number(submission.balance_after_minor))}
                      </span>
                    </div>
                  </>
                )}

                <div className="flex items-center justify-between pt-3 text-xs text-slate-500 dark:text-slate-400">
                  <span>{isAr ? 'توقيت التحديث' : 'Timestamp'}</span>
                  <span dir="ltr" className="tabular-nums">
                    {new Date(submission.reviewed_at || submission.created_at).toLocaleString(
                      isAr ? 'ar-PS' : 'en-GB',
                      { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
                    )}
                  </span>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <a
                  href={backHref}
                  className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-5 text-sm font-bold text-slate-800 shadow-sm transition hover:bg-slate-50 dark:border-[#1e4440] dark:bg-[#071716] dark:text-slate-200 dark:hover:bg-[#0d2624]"
                >
                  {isCustomerPayment
                    ? (isAr ? 'العودة إلى حساب الزبون' : 'Back to Customer Account')
                    : (isAr ? 'العودة إلى الطلب' : 'Back to Order')}
                </a>

                {submission.status !== 'PENDING' && (isCustomerPayment || (typeof order?.orderDueMinor === 'number' && order.orderDueMinor > 0)) && (
                  <button
                    type="button"
                    onClick={() => {
                      setSuccess(false);
                      setSubmission(null);
                      setError('');
                    }}
                    className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-5 text-sm font-bold text-white shadow-md transition hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600"
                  >
                    {isAr ? 'إرسال إشعار دفع جديد' : 'New payment notification'}
                  </button>
                )}
              </div>
            </div>
          </section>
        ) : (
          /* Active Payment Form: Modern, Two-Column (Responsive) Layout */
          <form onSubmit={submit} className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:gap-8">
            {/* LEFT / PRIMARY COLUMN: Steps & Actions (Col 7 on desktop) */}
            <div className="space-y-6 lg:col-span-7">
              {/* Global Error Banner */}
              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-3 rounded-2xl border border-rose-300 bg-rose-50/90 p-4 text-sm font-medium leading-6 text-rose-900 shadow-sm dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200"
                >
                  <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600 dark:text-rose-400" />
                  <div className="flex-1">{error}</div>
                </div>
              )}

              {/* STEP 1: Destination Account & One-Tap Copy */}
              <section className="overflow-hidden rounded-3xl border border-slate-200/90 bg-white p-6 shadow-sm transition hover:shadow-md dark:border-[#1a3c3a] dark:bg-[#0c1f1e]">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-100 text-xs font-black text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300">
                      1
                    </span>
                    <h2 className="text-base font-black text-slate-900 dark:text-slate-50">
                      {isAr ? 'رقم التحويل المعتمد' : 'Destination Payment Number'}
                    </h2>
                  </div>
                  <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold text-slate-600 dark:bg-[#122c2a] dark:text-slate-300">
                    {isAr ? 'رقم موحّد' : 'Universal'}
                  </span>
                </div>

                <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                  {isAr
                    ? 'استخدم هذا الرقم كوجهة تحويل في تطبيق بنك فلسطين أو محفظة جوال باي أو بال باي:'
                    : 'Use this recipient number in Bank of Palestine, Jawwal Pay, or PalPay app:'}
                </p>

                {/* Big Number Banner with Immediate Copy Button */}
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200/80 bg-emerald-50/60 p-4 dark:border-[#1e4844] dark:bg-[#0a2321]/60">
                  <div>
                    <span className="block text-[11px] font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-400">
                      {isAr ? 'رقم الهاتف / الحساب' : 'Account / Mobile Number'}
                    </span>
                    <span
                      dir="ltr"
                      className="mt-1 block font-mono text-2xl font-black tracking-widest text-slate-900 dark:text-slate-50 sm:text-3xl"
                    >
                      0592369875
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => void copyNumber()}
                    className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-5 text-xs font-bold transition shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 ${
                      copied
                        ? 'bg-emerald-600 text-white dark:bg-emerald-500'
                        : 'bg-white text-emerald-800 hover:bg-emerald-100/70 dark:bg-[#133532] dark:text-emerald-300 dark:hover:bg-[#18423f]'
                    }`}
                    aria-label={isAr ? 'نسخ رقم الدفع' : 'Copy payment number'}
                  >
                    {copied ? (
                      <>
                        <Check className="h-4 w-4" />
                        <span>{isAr ? 'تم النسخ!' : 'Copied!'}</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-4 w-4" />
                        <span>{isAr ? 'نسخ الرقم' : 'Copy Number'}</span>
                      </>
                    )}
                  </button>
                </div>

                {copied && (
                  <p role="status" aria-live="polite" className="mt-2 text-center text-xs font-bold text-emerald-600 dark:text-emerald-400">
                    {isAr ? 'تم نسخ الرقم بنجاح إلى الحافظة.' : 'Number copied to clipboard successfully.'}
                  </p>
                )}
              </section>

              {/* STEP 2: Choose Payment Method */}
              <section
                ref={methodSectionRef}
                className={`scroll-mt-24 rounded-3xl border bg-white p-6 shadow-sm transition dark:bg-[#0c1f1e] ${
                  validationError === 'method'
                    ? 'border-rose-400 ring-2 ring-rose-300 dark:border-rose-600 dark:ring-rose-900/50'
                    : 'border-slate-200/90 dark:border-[#1a3c3a]'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-100 text-xs font-black text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300">
                      2
                    </span>
                    <h2 className="text-base font-black text-slate-900 dark:text-slate-50">
                      {isAr ? 'اختر وسيلة التحويل التي استخدمتها' : 'Select Used Transfer Method'}
                    </h2>
                  </div>
                  <span className="text-xs font-bold text-rose-500 dark:text-rose-400">
                    {isAr ? '* مطلوب' : '* Required'}
                  </span>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {PAYMENT_METHODS.map((item) => {
                    const selected = method === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setMethod(item.id);
                          setError('');
                          setValidationError(null);
                        }}
                        aria-pressed={selected}
                        className={`group relative flex flex-col justify-between rounded-2xl border p-4 text-start transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-emerald-500 ${
                          selected
                            ? 'border-emerald-600 bg-emerald-50/70 shadow-sm ring-1 ring-emerald-600 dark:border-emerald-500 dark:bg-[#0e2d2a] dark:ring-emerald-500'
                            : 'border-slate-200/90 bg-white hover:border-slate-300 hover:bg-slate-50/60 dark:border-[#193a38] dark:bg-[#081817] dark:hover:border-[#224f4c]'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <PaymentMethodLogo method={item} />
                          <span
                            className={`flex h-5 w-5 items-center justify-center rounded-full border transition ${
                              selected
                                ? 'border-emerald-600 bg-emerald-600 text-white dark:border-emerald-400 dark:bg-emerald-500'
                                : 'border-slate-300 bg-transparent group-hover:border-slate-400 dark:border-slate-600'
                            }`}
                          >
                            {selected && <Check className="h-3.5 w-3.5" />}
                          </span>
                        </div>

                        <div className="mt-3">
                          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                            {isAr ? item.ar : item.en}
                          </h3>
                          <p className="mt-1 text-[11px] leading-4 text-slate-500 dark:text-slate-400">
                            {isAr ? item.descriptionAr : item.descriptionEn}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* STEP 3: Upload Transfer Receipt */}
              <section
                ref={receiptSectionRef}
                className={`scroll-mt-24 rounded-3xl border bg-white p-6 shadow-sm transition dark:bg-[#0c1f1e] ${
                  validationError === 'receipt'
                    ? 'border-rose-400 ring-2 ring-rose-300 dark:border-rose-600 dark:ring-rose-900/50'
                    : 'border-slate-200/90 dark:border-[#1a3c3a]'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-100 text-xs font-black text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300">
                      3
                    </span>
                    <h2 className="text-base font-black text-slate-900 dark:text-slate-50">
                      {isAr ? 'إرفاق إيصال التحويل' : 'Attach Transfer Receipt'}
                    </h2>
                  </div>
                  <span className="text-xs font-bold text-rose-500 dark:text-rose-400">
                    {isAr ? '* مطلوب' : '* Required'}
                  </span>
                </div>

                <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                  {isAr
                    ? 'التقط لقطة شاشة لإشعار التحويل من تطبيق البنك أو المحفظة وأرفقها هنا للتحقق:'
                    : 'Upload a screenshot of the completed transfer confirmation for review:'}
                </p>

                {/* Upload Drag/Tap Surface */}
                {!receipt ? (
                  <label className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50/60 p-6 text-center transition hover:border-emerald-500 hover:bg-emerald-50/30 focus-within:ring-2 focus-within:ring-emerald-500 dark:border-[#224d49] dark:bg-[#081817] dark:hover:border-emerald-500 dark:hover:bg-[#0c2422]">
                    <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950/80 dark:text-emerald-300">
                      <UploadCloud className="h-6 w-6" />
                    </span>
                    <span className="mt-3 text-sm font-bold text-slate-800 dark:text-slate-200">
                      {isAr ? 'اضغط لاختيار صورة الإيصال' : 'Tap to select receipt image'}
                    </span>
                    <span className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                      {isAr
                        ? 'يدعم صور JPEG أو PNG أو WebP (تُضغط الصورة تلقائياً لسرعة الرفع)'
                        : 'Supports JPEG, PNG, WebP (auto-compressed for fast upload)'}
                    </span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/*"
                      className="sr-only"
                      onChange={(e) => handleReceiptChange(e.target.files?.[0])}
                    />
                  </label>
                ) : (
                  /* Attached Receipt Preview Card */
                  <div className="mt-4 flex items-center justify-between gap-4 rounded-2xl border border-emerald-200/80 bg-emerald-50/50 p-4 dark:border-[#1d4944] dark:bg-[#0a2321]/60">
                    <div className="flex items-center gap-3.5 overflow-hidden">
                      {receiptPreview ? (
                        <img
                          src={receiptPreview}
                          alt={isAr ? 'معاينة الإيصال' : 'Receipt preview'}
                          className="h-14 w-14 rounded-xl object-cover ring-1 ring-slate-200 dark:ring-slate-700"
                        />
                      ) : (
                        <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-white text-emerald-600 dark:bg-slate-800">
                          <FileImage className="h-6 w-6" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-slate-900 dark:text-slate-100">
                          {receipt.name}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                          {(receipt.size / 1024).toFixed(0)} KB · {isAr ? 'جاهزة للإرسال' : 'Ready'}
                        </p>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setReceipt(null)}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200/90 bg-white text-slate-600 shadow-sm transition hover:bg-rose-50 hover:text-rose-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-rose-950 dark:hover:text-rose-400"
                      aria-label={isAr ? 'حذف الصورة' : 'Remove image'}
                      title={isAr ? 'حذف' : 'Remove'}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </section>

              {/* STEP 4: Optional Transfer Note */}
              <section className="rounded-3xl border border-slate-200/90 bg-white p-6 shadow-sm transition dark:border-[#1a3c3a] dark:bg-[#0c1f1e]">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-100 text-xs font-black text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300">
                      4
                    </span>
                    <label htmlFor="payment-note" className="text-base font-black text-slate-900 dark:text-slate-50">
                      {isAr ? 'ملاحظة أو اسم المحوّل' : 'Note or Sender Name'}
                    </label>
                  </div>
                  <span className="text-xs font-semibold text-slate-400">
                    {isAr ? '(اختياري)' : '(Optional)'}
                  </span>
                </div>

                <div className="mt-3">
                  <textarea
                    id="payment-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value.slice(0, 500))}
                    rows={2}
                    maxLength={500}
                    placeholder={
                      isAr
                        ? 'مثال: تم التحويل من حساب فلان، أو رقم حركة التحويل…'
                        : 'e.g., Transfer sent from account holder name or reference number…'
                    }
                    className="w-full resize-none rounded-2xl border border-slate-200/90 bg-slate-50/50 px-4 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-500/10 dark:border-[#1e4642] dark:bg-[#081817] dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-emerald-400 dark:focus:bg-[#0c1f1e]"
                  />
                  <div className="mt-1 text-end text-[11px] tabular-nums text-slate-400">
                    {note.length}/500
                  </div>
                </div>
              </section>

              {/* STEP 5: Submit Button CTA */}
              <div className="pt-2">
                <button
                  type="submit"
                  disabled={sending || (Boolean(order) && (amountDue === null || amountDue <= 0))}
                  className="flex min-h-14 w-full items-center justify-center gap-2.5 rounded-2xl bg-emerald-600 px-6 py-4 text-base font-black text-white shadow-lg shadow-emerald-600/25 transition hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-emerald-500 dark:shadow-emerald-950/40 dark:hover:bg-emerald-600 dark:focus:ring-offset-[#071313]"
                >
                  {sending ? (
                    <>
                      <RefreshCw className="h-5 w-5 animate-spin" />
                      <span>{isAr ? 'جارٍ تجهيز الإشعار والإرسال…' : 'Preparing & Submitting…'}</span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="h-5 w-5" />
                      <span>{isAr ? 'إرسال إشعار الدفع' : 'Submit Payment Notification'}</span>
                    </>
                  )}
                </button>

                <p className="mt-3 text-center text-xs leading-5 text-slate-500 dark:text-slate-400">
                  <LockKeyhole className="me-1 inline h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  {isAr
                    ? 'يتم فحص وتدقيق كل إشعار يدوياً قبل اعتماد الرصيد رسمياً في النظام.'
                    : 'Each submission is verified manually before your balance is credited.'}
                </p>
              </div>
            </div>

            {/* RIGHT / SECONDARY COLUMN: Summary Card & Details (Col 5 on desktop) */}
            <aside className="space-y-6 lg:col-span-5">
              {/* Order / Customer Financial Summary Card */}
              <div className="overflow-hidden rounded-3xl border border-slate-200/90 bg-white shadow-sm dark:border-[#1a3c3a] dark:bg-[#0c1f1e]">
                {/* Header Strip */}
                <div className="border-b border-slate-200/80 bg-slate-50/80 px-6 py-4 dark:border-[#1a3c3a] dark:bg-[#091b1a]">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-black uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                      {isCustomerPayment
                        ? (isAr ? 'حساب الزبون' : 'CUSTOMER ACCOUNT')
                        : (isAr ? 'بيانات الطلب' : 'ORDER DETAILS')}
                    </span>
                    {order && (
                      <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-black text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                        {isAr ? `طلب #${order.orderNumber}` : `Order #${order.orderNumber}`}
                      </span>
                    )}
                  </div>

                  <h3 className="mt-1 truncate text-lg font-black text-slate-900 dark:text-slate-50">
                    {order?.customerName || customer?.customerName || '—'}
                  </h3>

                  {(order?.customerCode || customer?.customerCode) && (
                    <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                      {isAr ? 'رمز العميل: ' : 'Customer code: '}
                      {order?.customerCode || customer?.customerCode}
                    </span>
                  )}
                </div>

                <div className="space-y-4 p-6">
                  {/* Amount Due Highlight */}
                  {order && (
                    <div className="rounded-2xl border border-emerald-200/80 bg-emerald-50/50 p-4 dark:border-[#1d4440] dark:bg-[#08201e]/60">
                      <span className="block text-xs font-bold text-emerald-800 dark:text-emerald-400">
                        {isAr ? 'المبلغ المطلوب سداده' : 'Total Amount Due'}
                      </span>
                      <div dir="ltr" className="mt-1 text-3xl font-black tabular-nums text-slate-900 dark:text-slate-50">
                        {amountDue !== null ? formatAmount(amountDue) : '—'}
                      </div>
                      <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">
                        {typeof order.orderTotalMinor === 'number' && (
                          <span>
                            {isAr ? 'إجمالي الطلب: ' : 'Order total: '}
                            {formatAmount(order.orderTotalMinor)}
                          </span>
                        )}
                      </span>
                    </div>
                  )}

                  {/* Devices List (if order has items) */}
                  {order?.items?.length ? (
                    <div className="space-y-2 border-t border-slate-200/80 pt-4 dark:border-slate-800">
                      <div className="text-xs font-bold text-slate-500 dark:text-slate-400">
                        {isAr ? 'الأجهزة المسجلة في الطلب:' : 'Order Items:'}
                      </div>

                      <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
                        {order.items.map((item, index) => {
                          const itemName = locale === 'en'
                            ? (item.name_en || getItemLocalizedDeviceName(item.device_type_id || item.name, 'en', item.name))
                            : (item.name_ar || item.name);

                          return (
                            <div
                              key={`${item.name}-${index}`}
                              className="flex items-center justify-between gap-3 py-2 text-xs"
                            >
                              <div className="min-w-0 flex-1">
                                <span className="font-bold text-slate-800 dark:text-slate-200">
                                  {itemName}
                                </span>
                                {item.has_charger && (
                                  <span className="ms-1.5 text-[10px] text-emerald-600 dark:text-emerald-400">
                                    {isAr ? '(مع شاحن)' : '(with charger)'}
                                  </span>
                                )}
                              </div>
                              <span className="shrink-0 font-bold tabular-nums text-slate-700 dark:text-slate-300">
                                {typeof item.total_price_minor === 'number'
                                  ? formatAmount(item.total_price_minor)
                                  : '—'}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {/* Customer Payment Context Explanation */}
                  {isCustomerPayment && (
                    <div className="rounded-2xl border border-slate-200/80 bg-slate-50 p-4 text-xs leading-5 text-slate-600 dark:border-[#1d4440] dark:bg-[#071716] dark:text-slate-300">
                      {isAr
                        ? 'سيتم تسجيل الإشعار وربطه بملف حسابك. بعد اعتماد الإيصال، تُسدّد مستحقاتك تلقائياً من الأقدم إلى الأحدث.'
                        : 'Your payment notification is linked directly to your customer account. Verified amounts settle debts on a FIFO basis.'}
                    </div>
                  )}
                </div>
              </div>

              {/* Security & Verification Card */}
              <div className="rounded-3xl border border-slate-200/90 bg-slate-50/80 p-5 text-xs leading-6 text-slate-600 shadow-sm dark:border-[#1a3c3a] dark:bg-[#0a1c1b] dark:text-slate-400">
                <div className="flex items-center gap-2 font-bold text-slate-800 dark:text-slate-200">
                  <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <span>{isAr ? 'إجراءات الأمان والتدقيق' : 'Security & Verification'}</span>
                </div>
                <p className="mt-2">
                  {isAr
                    ? 'يُحفظ إيصالك في مساحة تخزين آمنة ومشفّرة، ولا يُعتمد أي مبلغ إلا بعد مطابقة إشعار البنك أو المحفظة فعلياً.'
                    : 'Receipts are encrypted and stored privately. Amounts are only credited once confirmed by our accounting team.'}
                </p>
              </div>
            </aside>
          </form>
        )}
      </main>

      {/* 3. Footer Bar */}
      <footer className="mt-12 border-t border-slate-200/80 py-6 text-center text-xs text-slate-500 dark:border-[#163532] dark:text-slate-400">
        <p>
          {isAr
            ? 'نقطة الشحن (ChargerPoint) · بوابة الدفع والتحويل الآمنة'
            : 'Charging Point (ChargerPoint) · Secure Payment & Transfer Portal'}
        </p>
      </footer>
    </div>
  );
};
