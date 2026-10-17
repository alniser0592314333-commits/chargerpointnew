import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Check, CheckCircle2, Copy, FileImage,
  Clock3, Globe, LockKeyhole, Moon, ShieldCheck, Sun, UploadCloud,
  X, Wallet, AlertCircle, RefreshCw,
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
    short: 'JWP',
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
    short: 'PPY',
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
      <div className={`flex h-8 w-9 shrink-0 items-center justify-center rounded-full font-bold text-[10px] ${method.markClass}`}>
        {method.short}
      </div>
    );
  }
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white p-1.5 shadow-sm ring-1 ring-slate-200/80 dark:bg-slate-900 dark:ring-slate-700">
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
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const requestGeneration = useRef(0);
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
    const requestId = ++requestGeneration.current;
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
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          if (active && requestId === requestGeneration.current) setLoadError(true);
          return;
        }
        const orderData = await getPublicOrderByToken(token).catch(() => null);
        if (!active || requestId !== requestGeneration.current || !navigator.onLine) return;
        let contextFound = false;
        if (orderData) {
          setOrder(orderData);
          contextFound = true;
        } else {
          const customerData = await getPublicCustomerByToken(token);
          if (!active || requestId !== requestGeneration.current || !navigator.onLine) return;
          if (customerData) {
            setCustomer(customerData);
            contextFound = true;
          } else {
            setLoadError(true);
          }
        }

        if (contextFound) {
          const previousSubmission = await rpcResolveQrPaymentSubmission(token);
          if (active && requestId === requestGeneration.current && navigator.onLine && previousSubmission) {
            setSubmission(previousSubmission);
            setSuccess(true);
          }
        }
      } catch {
        if (active && requestId === requestGeneration.current) setLoadError(true);
      } finally {
        if (active && requestId === requestGeneration.current) setLoading(false);
      }
    })();
    return () => {
      active = false;
      requestGeneration.current += 1;
    };
  }, [token, online]);

  useEffect(() => {
    const onOffline = () => {
      requestGeneration.current += 1;
      setOnline(false);
      setOrder(null);
      setCustomer(null);
      setSubmission(null);
      setLoadError(true);
      setLoading(false);
      setSending(false);
      setSuccess(false);
    };
    const onOnline = () => setOnline(true);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, []);

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
  const orderPaymentBlockReason = !order
    ? ''
    : typeof order.customerHasPositiveCredit !== 'boolean'
      ? (isAr ? 'تعذّر التحقق من رصيد الحساب. حدّث الصفحة قبل إرسال أي دفعة.' : 'Could not verify the account balance. Refresh before sending a payment.')
      : order.orderQrSubmissionLimitReached === true && amountDue !== null && amountDue > 0
        ? (isAr ? 'تم استخدام إشعارات الدفع الثلاثة المسموح بها لهذا الطلب. تواصل مع نقطة الشحن لمتابعة المبلغ المتبقي.' : 'This order QR has used all three allowed payment notifications. Contact Charging Point to resolve the remaining amount.')
        : amountDue === null || amountDue <= 0
          ? (['DELIVERED', 'COMPLETED'].includes(String(order.status ?? '').toUpperCase())
              ? (isAr ? 'لا يوجد مبلغ مستحق على هذا الطلب حالياً.' : 'There is no remaining amount due for this order.')
              : (isAr ? 'الطلب ما زال قيد الشحن؛ لا يُطلب الدفع قبل تسجيل التسليم.' : 'This order is still charging. Payment is not due before delivery is recorded.'))
          : '';
  const orderPaymentAllowed = Boolean(order && !orderPaymentBlockReason);
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
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setError(isAr ? 'الاتصال بالإنترنت غير متاح. أعد الاتصال قبل إرسال الإيصال.' : 'You are offline. Reconnect before submitting the receipt.');
      return;
    }
    const submissionGeneration = requestGeneration.current;

    if (order && !orderPaymentAllowed) {
      setError(orderPaymentBlockReason);
      return;
    }

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
      if (!navigator.onLine || submissionGeneration !== requestGeneration.current) {
        throw new Error('OFFLINE');
      }
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          apikey: config.supabaseAnonKey,
          Authorization: `Bearer ${config.supabaseAnonKey}`,
        },
        body: form,
      });
      if (!navigator.onLine || submissionGeneration !== requestGeneration.current) {
        throw new Error('OFFLINE');
      }
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.success !== true) {
        const message = String(result.error || '');
        if (message.toLowerCase().includes('positive credit')) {
          throw new Error('CREDIT_BALANCE');
        }
        if (message.toLowerCase().includes('maximum of three payment notifications')) {
          throw new Error('MAX_SUBMISSIONS');
        }
        if (message.toLowerCase().includes('no amount is due') || message.toLowerCase().includes('no remaining amount')) {
          throw new Error('NO_AMOUNT_DUE');
        }
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
      if (code === 'OFFLINE' || !navigator.onLine) {
        setError(isAr ? 'انقطع الإنترنت قبل تأكيد الإرسال. تحقّق من سجل الإيصالات قبل إعادة المحاولة.' : 'Connection dropped before confirmation. Check receipt history before retrying.');
        return;
      }
      if (code === 'IMAGE_REQUIRED') {
        setError(isAr ? 'يرجى اختيار صورة إيصال صحيحة.' : 'Please choose a valid receipt image.');
      } else if (code === 'SOURCE_TOO_LARGE') {
        setError(isAr ? 'الصورة الأصلية كبيرة. اختَر صورة أقل من 12 ميغابايت.' : 'Original image is too large. Select an image under 12 MB.');
      } else if (code === 'IMAGE_PROCESSING_UNAVAILABLE' || code === 'IMAGE_COMPRESSION_FAILED' || code === 'IMAGE_INVALID') {
        setError(isAr ? 'تعذّر تجهيز الصورة. يرجى تجربة صورة أخرى واضحة.' : 'Could not process image. Please try another clear image.');
      } else if (code === 'COMPRESSED_TOO_LARGE') {
        setError(isAr ? 'حجم الصورة بعد الضغط ما زال كبيراً. اختَر صورة أصغر وأوضح.' : 'Compressed image remains too large. Choose a smaller image.');
      } else if (code === 'CREDIT_BALANCE') {
        setError(isAr ? 'رصيدك موجب؛ سيُستخدم لتغطية تكلفة الطلب أولاً، ولا يلزم إرسال دفعة الآن.' : 'Your account has positive credit, which is applied first. No payment is needed now.');
      } else if (code === 'MAX_SUBMISSIONS') {
        setError(isAr ? 'وصل هذا الطلب للحد الأقصى: ثلاثة إشعارات دفع من نفس رمز QR.' : 'This order QR has reached its limit of three payment notifications.');
      } else if (code === 'NO_AMOUNT_DUE') {
        setError(isAr ? 'لا يوجد مبلغ مستحق للدفع عبر رمز QR هذا. لا يُقبل الدفع إلا للمبالغ المسجلة بعد التسليم.' : 'No amount is due through this QR. Payment is accepted only for charges recognized after delivery.');
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

  return (
    <div
      dir={isRTL ? 'rtl' : 'ltr'}
      className="public-payment-page min-h-screen bg-gradient-to-br from-slate-100 via-white to-teal-50 text-slate-900 transition-colors duration-300 dark:from-[#050b0d] dark:via-[#091719] dark:to-[#102d2a] dark:text-slate-100"
    >
      {/* 1. Header Bar */}
      <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/75 backdrop-blur-xl transition-colors duration-300 dark:border-white/10 dark:bg-[#071113]/70">
        <div className="payment-portal-header-inner mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
          <a
            href="/public/about"
            className="payment-portal-brand group flex items-center gap-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500"
            aria-label={isAr ? "نقطة الشحن - الصفحة التعريفية" : "Charging Point - About"}
          >
            <span className="payment-portal-brand-mark flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm transition group-hover:bg-emerald-700 dark:bg-emerald-500 dark:group-hover:bg-emerald-600" aria-hidden="true">
              <svg viewBox="0 0 40 40" fill="none" className="h-7 w-7" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="5" width="19" height="30" rx="5" stroke="currentColor" strokeWidth="2.2"/><rect x="13" y="10" width="9" height="15" rx="2" fill="currentColor" fillOpacity=".2"/><path d="M24 17h4a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4h-1" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/><path d="m19 13-4 7h4l-2 5 6-8h-4l1-4Z" fill="currentColor"/></svg>
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

          {/* Back navigation and settings stay opposite the brand in both locales. */}
          <div className="payment-portal-header-actions flex items-center gap-2">
            <a href={backHref} className="payment-portal-header-back inline-flex min-h-9 items-center gap-2 rounded-xl border border-slate-200/90 bg-white px-3 text-xs font-bold text-slate-700 shadow-sm transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-[#1e4440] dark:bg-[#0b1f1e] dark:text-slate-200 dark:hover:bg-[#12312f]">
              {isRTL ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
              <span>{isCustomerPayment ? (isAr ? "العودة إلى حساب الزبون" : "Back to Customer Account") : (isAr ? "العودة إلى تفاصيل الطلب" : "Back to Order Details")}</span>
            </a>
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
      <main className="payment-portal-main mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-9 lg:py-12">
        {/* Navigation Breadcrumb */}
        <div className="payment-portal-breadcrumb mb-6 flex flex-wrap items-center justify-between gap-3">
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

          <div className="payment-portal-heading inline-flex items-center gap-1.5 rounded-full border border-emerald-200/70 bg-emerald-50/80 px-3 py-1 text-[11px] font-bold text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>{isAr ? 'تحويل بنكي ومحافظ رقمية' : 'Bank & Digital Wallets'}</span>
          </div>
        </div>

        {/* Loading State */}
        {loading ? (
          <div className="flex flex-col items-center justify-center rounded-3xl border border-white/80 bg-white/85 p-12 text-center shadow-xl shadow-slate-900/5 backdrop-blur-sm dark:border-white/10 dark:bg-[#0d1c1e]/90 dark:shadow-black/20">
            <RefreshCw className="h-8 w-8 animate-spin text-emerald-600 dark:text-emerald-400" />
            <p className="mt-4 text-sm font-bold text-slate-700 dark:text-slate-300">
              {isAr ? 'جارٍ تحميل بيانات الدفع والطلب…' : 'Loading payment & order details…'}
            </p>
          </div>
        ) : loadError || (!order && !customer) ? (
          /* Error State: Invalid or Expired Token */
          <div className="rounded-3xl border border-rose-200/80 bg-white/90 p-8 text-center shadow-xl shadow-slate-900/5 backdrop-blur-sm dark:border-rose-900/50 dark:bg-[#111c20]/95 dark:shadow-black/25 sm:p-12">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-50 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400">
              <AlertCircle className="h-7 w-7" />
            </span>
            <h2 className="mt-5 text-xl font-black text-slate-900 dark:text-slate-50">
              {!online ? (isAr ? 'الاتصال بالإنترنت غير متاح' : 'You are offline') : (isAr ? 'تعذّر الوصول لبيانات الدفع' : 'Payment details could not be found')}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600 dark:text-slate-400">
              {!online
                ? (isAr ? 'أخفينا بيانات الحساب والإيصال أثناء انقطاع الإنترنت. أعد الاتصال وسيتم التحقق من الرمز مجدداً.' : 'Account and receipt details are hidden while offline. Reconnect to verify this QR again.')
                : (isAr
                  ? 'الرابط غير صالح أو منتهي الصلاحية، أو تم حذفه من النظام. يرجى مسح رمز QR الصحيح مجدداً.'
                  : 'This link is invalid or expired. Please re-scan the original QR code to proceed.')}
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
          <div className={submission.status === 'PENDING' ? 'payment-pending-layout' : 'payment-status-layout'}>
          <section className={`mx-auto max-w-xl space-y-5 ${submission.status === 'PENDING' ? 'payment-pending-content' : ''}`}>
            <div className="overflow-hidden rounded-[2rem] border border-white/80 bg-white/90 p-5 shadow-2xl shadow-slate-900/10 backdrop-blur-xl transition-colors duration-300 dark:border-white/10 dark:bg-[#101e21]/95 dark:shadow-black/30 sm:p-8">
              {/* Status Header Badge */}
              <div className="flex items-center gap-4">
                <span
                  className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full shadow-inner ${
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
                    className={`inline-flex items-center rounded-full px-3 py-1 text-[10px] font-black tracking-wide uppercase ${
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
                  <h1 className="mt-2 text-xl font-black tracking-tight text-slate-900 dark:text-white sm:text-2xl">
                    {submission.status === 'APPROVED'
                      ? (isAr ? 'تم اعتماد الدفعة بنجاح' : 'Payment approved')
                      : submission.status === 'REJECTED'
                      ? (isAr ? 'تم رفض إشعار الدفع' : 'Payment notification rejected')
                      : (isAr ? 'إشعار الدفع بانتظار المراجعة' : 'Payment notification received')}
                  </h1>
                </div>
              </div>

              {/* Status Explanation */}
              <p className="mt-4 rounded-2xl bg-slate-50/90 px-4 py-3 text-sm leading-6 text-slate-600 dark:bg-white/[0.04] dark:text-slate-300">
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
              <div className="mt-5 divide-y divide-slate-200/80 rounded-2xl border border-slate-200/80 bg-white/70 p-4 text-sm dark:divide-white/10 dark:border-white/10 dark:bg-black/10">
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
          {submission.status === 'PENDING' && (
            <aside className="payment-portal-visual payment-pending-visual" aria-label={isAr ? 'معلومات عن مراجعة الدفع' : 'Payment review information'}>
              <div className="payment-portal-visual-art" aria-hidden="true">
                <svg viewBox="0 0 520 410" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <radialGradient id="pending-review-glow"><stop stopColor="#f59e0b" stopOpacity=".22"/><stop offset="1" stopColor="#f59e0b" stopOpacity="0"/></radialGradient>
                    <linearGradient id="pending-review-paper" x1="170" y1="55" x2="340" y2="355" gradientUnits="userSpaceOnUse"><stop stopColor="#fffefa"/><stop offset="1" stopColor="#e7f5ef"/></linearGradient>
                    <linearGradient id="pending-review-ring" x1="180" y1="80" x2="350" y2="330" gradientUnits="userSpaceOnUse"><stop stopColor="#fbbf24"/><stop offset="1" stopColor="#10b981"/></linearGradient>
                  </defs>
                  <ellipse cx="260" cy="205" rx="220" ry="185" fill="url(#pending-review-glow)"/>
                  <circle cx="260" cy="205" r="145" stroke="currentColor" strokeOpacity=".09" strokeWidth="1.5" strokeDasharray="5 10"/>
                  <g transform="rotate(-5 260 205)">
                    <rect x="155" y="42" width="210" height="326" rx="28" fill="url(#pending-review-paper)" stroke="url(#pending-review-ring)" strokeWidth="3"/>
                    <rect x="179" y="70" width="162" height="270" rx="18" fill="#f8fafc" stroke="#d5e8df"/>
                    <rect x="205" y="94" width="110" height="8" rx="4" fill="#0f766e" fillOpacity=".72"/>
                    <rect x="205" y="114" width="76" height="5" rx="2.5" fill="#64748b" fillOpacity=".45"/>
                    <rect x="201" y="145" width="118" height="92" rx="14" fill="#fef3c7"/>
                    <circle cx="260" cy="190" r="27" fill="#f59e0b" fillOpacity=".18" stroke="#d97706" strokeWidth="2"/>
                    <path d="M260 174v18l12 8" stroke="#b45309" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                    <rect x="204" y="256" width="112" height="6" rx="3" fill="#0f766e" fillOpacity=".55"/>
                    <rect x="204" y="273" width="84" height="6" rx="3" fill="#64748b" fillOpacity=".25"/>
                    <rect x="204" y="290" width="98" height="6" rx="3" fill="#64748b" fillOpacity=".25"/>
                    <path d="M228 318h64" stroke="#10b981" strokeWidth="5" strokeLinecap="round"/>
                  </g>
                  <rect x="45" y="118" width="106" height="66" rx="17" fill="currentColor" fillOpacity=".045" stroke="currentColor" strokeOpacity=".12"/>
                  <circle cx="68" cy="140" r="7" fill="#10b981"/><path d="m64.5 140 2.4 2.4 4.6-5" stroke="#052e2b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  <rect x="84" y="136" width="48" height="5" rx="2.5" fill="currentColor" fillOpacity=".38"/><rect x="64" y="155" width="66" height="5" rx="2.5" fill="currentColor" fillOpacity=".16"/>
                  <rect x="363" y="256" width="116" height="74" rx="18" fill="currentColor" fillOpacity=".045" stroke="currentColor" strokeOpacity=".12"/>
                  <circle cx="387" cy="280" r="8" fill="#f59e0b" fillOpacity=".2"/><path d="M387 275v6l4 3" stroke="#b45309" strokeWidth="1.8" strokeLinecap="round"/>
                  <rect x="405" y="276" width="53" height="5" rx="2.5" fill="currentColor" fillOpacity=".38"/><rect x="405" y="289" width="42" height="5" rx="2.5" fill="currentColor" fillOpacity=".16"/><rect x="382" y="309" width="76" height="5" rx="2.5" fill="#10b981" fillOpacity=".55"/>
                  <circle cx="394" cy="100" r="5" fill="#38bdf8"/><circle cx="117" cy="284" r="4" fill="#10b981"/>
                </svg>
              </div>
              <p className="payment-portal-visual-eyebrow">{isAr ? 'تم استلام إشعارك' : 'PAYMENT NOTICE RECEIVED'}</p>
              <h2>{isAr ? 'دفعتك بانتظار المراجعة' : 'Your payment is under review'}</h2>
              <p>{isAr
                ? 'تم حفظ إشعار الدفع، وسيراجع المسؤول الإيصال قبل اعتماد المبلغ. لا تحتاج لإرسال إشعار آخر لنفس الدفعة.'
                : 'Your payment notice is saved. The team will verify the receipt before approving the amount, so there is no need to submit it again.'}</p>
              <div className="payment-portal-visual-points"><span><Clock3 className="h-4 w-4" />{isAr ? 'الحالة: قيد المراجعة' : 'Status: pending review'}</span><span><ShieldCheck className="h-4 w-4" />{isAr ? 'اعتماد بعد التحقق' : 'Approval after verification'}</span></div>
            </aside>
          )}
          </div>
        ) : (
          <>
          {/* Payment form and companion illustration */}
          <div className="payment-portal-layout">
          <form onSubmit={submit} className="payment-portal-form mx-auto w-full max-w-xl space-y-4">
            {error && (
              <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm leading-5 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-200">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">{error}</div>
              </div>
            )}

            {order && !orderPaymentAllowed && (
              <div role="status" aria-live="polite" className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm leading-5 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
                <Wallet className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">{orderPaymentBlockReason}</div>
              </div>
            )}

            <section className="rounded-[1.75rem] border border-white/90 bg-white/90 p-4 shadow-2xl shadow-slate-900/5 backdrop-blur-xl transition-colors duration-300 dark:border-white/10 dark:bg-[#101e21]/95 dark:shadow-black/25 sm:p-6">
              <div className="mb-5 flex items-center justify-between gap-3">
                <div>
                  <h1 className="text-base font-extrabold text-slate-900 dark:text-slate-50">{isAr ? 'إشعار الدفع' : 'Payment notification'}</h1>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{isAr ? 'اختار وسيلة الدفع وأرفق صورة الإيصال.' : 'Choose a payment method and attach the receipt.'}</p>
                </div>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">
                  <ShieldCheck className="h-5 w-5" />
                </span>
              </div>

              <section ref={methodSectionRef} aria-label={isAr ? 'وسيلة الدفع' : 'Payment method'} className={`scroll-mt-24 rounded-xl transition ${validationError === 'method' ? 'ring-2 ring-rose-400 ring-offset-2 dark:ring-offset-[#0c1f1e]' : ''}`}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h2 className="text-xs font-bold text-slate-700 dark:text-slate-200">{isAr ? 'وسيلة الدفع' : 'Payment method'}</h2>
                  <span className="text-[10px] text-slate-400">{isAr ? 'مطلوب' : 'Required'}</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
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
                        aria-label={`${isAr ? item.ar : item.en} (${item.short})`}
                        aria-pressed={selected}
                        className={`relative flex aspect-square min-w-0 flex-col items-center justify-center gap-2 rounded-full border p-2 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-[#101e21] ${selected
                          ? 'border-teal-600 bg-teal-50 shadow-lg shadow-teal-700/10 ring-2 ring-teal-600/15 dark:border-teal-400 dark:bg-teal-950/50 dark:shadow-teal-950/40'
                          : 'border-slate-200 bg-white/80 hover:border-teal-300 hover:bg-teal-50/60 dark:border-white/15 dark:bg-white/[0.03] dark:hover:border-teal-700 dark:hover:bg-teal-950/30'
                        }`}
                      >
                        <PaymentMethodLogo method={item} />
                        <span className="text-[11px] font-extrabold tracking-wide text-slate-800 dark:text-slate-100">{item.short}</span>
                        {selected && <span className="absolute end-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-600 text-white dark:bg-emerald-500" aria-hidden="true"><Check className="h-3 w-3" /></span>}
                      </button>
                    );
                  })}
                </div>
              </section>

              <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-slate-200/80 bg-slate-50/80 px-3.5 py-3 dark:border-white/10 dark:bg-white/[0.035]">
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">{isAr ? 'رقم التحويل' : 'Transfer number'}</p>
                  <p dir="ltr" className="mt-0.5 font-mono text-base font-extrabold tracking-wider text-slate-900 dark:text-slate-100">0592369875</p>
                </div>
                <button type="button" onClick={() => void copyNumber()} className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-bold transition focus:outline-none focus:ring-2 focus:ring-emerald-500 ${copied
                  ? 'border-emerald-600 bg-emerald-600 text-white'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100 dark:border-[#24413f] dark:bg-[#102725] dark:text-slate-200 dark:hover:bg-[#163633]'
                }`}>
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copied ? (isAr ? 'تم النسخ' : 'Copied') : (isAr ? 'نسخ' : 'Copy')}</span>
                </button>
              </div>

              <section ref={receiptSectionRef} className={`mt-4 scroll-mt-24 rounded-xl transition ${validationError === 'receipt' ? 'ring-2 ring-rose-400 ring-offset-2 dark:ring-offset-[#0c1f1e]' : ''}`}>
                <div className="mb-2">
                  <h2 className="text-xs font-bold text-slate-700 dark:text-slate-200">{isAr ? 'إرفاق إشعار الدفع' : 'Attach payment receipt'}</h2>
                  <p className="mt-1 text-[11px] leading-4 text-slate-500 dark:text-slate-400">{isAr ? 'ارفع صورة واضحة لإشعار التحويل (حتى 12 ميغابايت).' : 'Upload a clear transfer receipt image (up to 12 MB).'}</p>
                </div>
                {!receipt ? (
                  <label className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 px-3 py-4 text-center transition hover:border-emerald-500 hover:bg-emerald-50/40 focus-within:ring-2 focus-within:ring-emerald-500 dark:border-[#31514e] dark:bg-[#081817] dark:hover:bg-[#0c2422]">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300"><UploadCloud className="h-5 w-5" /></span>
                    <span className="text-xs font-bold text-slate-800 dark:text-slate-100">{isAr ? 'اضغط لاختيار الصورة' : 'Tap to choose an image'}</span>
                    <input type="file" accept="image/jpeg,image/png,image/webp,image/*" className="sr-only" onChange={(e) => handleReceiptChange(e.target.files?.[0])} />
                  </label>
                ) : (
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-2.5 dark:border-[#1d4944] dark:bg-[#0a2321]/60">
                    <div className="flex min-w-0 items-center gap-2.5">
                      {receiptPreview ? <img src={receiptPreview} alt={isAr ? 'معاينة الإيصال' : 'Receipt preview'} className="h-12 w-12 shrink-0 rounded-lg object-cover ring-1 ring-slate-200 dark:ring-slate-700" /> : <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-white text-emerald-600 dark:bg-slate-800"><FileImage className="h-5 w-5" /></span>}
                      <div className="min-w-0">
                        <p className="truncate text-xs font-bold text-slate-900 dark:text-slate-100">{receipt.name}</p>
                        <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">{(receipt.size / 1024).toFixed(0)} KB · {isAr ? 'جاهزة للإرسال' : 'Ready to send'}</p>
                      </div>
                    </div>
                    <button type="button" onClick={() => setReceipt(null)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300" aria-label={isAr ? 'حذف الصورة' : 'Remove image'}><X className="h-4 w-4" /></button>
                  </div>
                )}
              </section>

              <div className="mt-4">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <label htmlFor="payment-note" className="text-xs font-bold text-slate-700 dark:text-slate-200">{isAr ? 'ملاحظة' : 'Note'}</label>
                  <span className="text-[10px] text-slate-400">{isAr ? 'اختياري' : 'Optional'}</span>
                </div>
                <textarea
                  id="payment-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value.slice(0, 500))}
                  rows={2}
                  maxLength={500}
                  placeholder={isAr ? 'ملاحظة قصيرة (إن وجدت)…' : 'Add a short note if needed…'}
                  className="w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/15 dark:border-white/15 dark:bg-[#0a1518] dark:text-slate-100 dark:placeholder:text-slate-500"
                />
              </div>

              <p className="mt-3 flex items-start gap-2 text-[11px] leading-4 text-slate-500 dark:text-slate-400">
                <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span>{isAr ? 'يُرسل الإشعار عبر اتصال آمن، ولا يُعتمد الدفع إلا بعد مراجعة الإيصال.' : 'The notification is sent over a secure connection. Payment is credited only after receipt review.'}</span>
              </p>
            </section>

            <button
              type="submit"
              disabled={sending || (Boolean(order) && !orderPaymentAllowed)}
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-extrabold text-white shadow-sm transition hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-emerald-500 dark:hover:bg-emerald-600 dark:focus:ring-offset-[#071313]"
            >
              {sending ? <><RefreshCw className="h-4 w-4 animate-spin" /><span>{isAr ? 'جارٍ إرسال الإشعار…' : 'Sending notification…'}</span></> : <><ShieldCheck className="h-4 w-4" /><span>{isAr ? 'إرسال إشعار الدفع' : 'Send payment notification'}</span></>}
            </button>
          </form>
          <aside className="payment-portal-visual" aria-label={isAr ? "خدمات نقطة الشحن" : "Charging Point service information"}>
            <div className="payment-portal-visual-art" aria-hidden="true">
              <svg viewBox="0 0 520 410" xmlns="http://www.w3.org/2000/svg">
                <defs><radialGradient id="cp-glow"><stop stopColor="#10b981" stopOpacity=".24"/><stop offset="1" stopColor="#10b981" stopOpacity="0"/></radialGradient><linearGradient id="cp-phone" x1="180" y1="65" x2="330" y2="345" gradientUnits="userSpaceOnUse"><stop stopColor="#315650"/><stop offset="1" stopColor="#0c2422"/></linearGradient><linearGradient id="cp-screen" x1="205" y1="100" x2="310" y2="315" gradientUnits="userSpaceOnUse"><stop stopColor="#34d399"/><stop offset="1" stopColor="#0f766e"/></linearGradient></defs>
                <ellipse cx="260" cy="205" rx="220" ry="190" fill="url(#cp-glow)"/><circle cx="94" cy="105" r="5" fill="#10b981"/><circle cx="410" cy="85" r="4" fill="#34d399"/><circle cx="420" cy="294" r="6" fill="#0d9488"/>
                <path d="M96 128c-27 14-36 37-28 59M419 113c26 16 34 38 25 59" stroke="#0d9488" strokeOpacity=".5" strokeWidth="2" strokeLinecap="round" strokeDasharray="4 8"/>
                <rect x="165" y="42" width="190" height="324" rx="32" fill="url(#cp-phone)" stroke="#6ba99a" strokeWidth="2"/><rect x="177" y="56" width="166" height="296" rx="24" fill="#071b1a"/><rect x="190" y="83" width="140" height="250" rx="17" fill="url(#cp-screen)"/><rect x="244" y="67" width="32" height="4" rx="2" fill="#a7d8c7"/>
                <rect x="216" y="112" width="88" height="8" rx="4" fill="#ecfdf5" fillOpacity=".85"/><rect x="230" y="128" width="60" height="5" rx="2.5" fill="#ecfdf5" fillOpacity=".5"/><circle cx="260" cy="222" r="40" fill="#ecfdf5" fillOpacity=".18"/><path d="m268 183-29 43h21l-7 31 36-48h-23l2-26Z" fill="#ecfdf5"/>
                <path d="M260 366v16c0 13 10 23 23 23h25" stroke="#0d9488" strokeWidth="5" strokeLinecap="round"/><rect x="305" y="393" width="45" height="14" rx="6" fill="#315650" stroke="#6ba99a" strokeWidth="2"/>
                <rect x="72" y="239" width="92" height="63" rx="17" fill="#fffefa" stroke="#d6e7df" strokeWidth="2"/><rect x="88" y="254" width="42" height="30" rx="6" fill="#e0f7ed"/><path d="m109 256-10 15h8l-3 10 14-17h-9l2-8Z" fill="#0f766e"/><path d="M141 260h10M141 269h10M141 278h6" stroke="#0f766e" strokeOpacity=".55" strokeWidth="3" strokeLinecap="round"/>
                <rect x="350" y="178" width="95" height="61" rx="16" fill="#fffefa" stroke="#d6e7df" strokeWidth="2"/><circle cx="373" cy="208" r="10" fill="#d1fae5"/><path d="m368 208 4 4 7-8" stroke="#047857" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M391 201h38M391 211h28" stroke="#0f766e" strokeOpacity=".45" strokeWidth="3" strokeLinecap="round"/>
              </svg>
            </div>
            <p className="payment-portal-visual-eyebrow">{isAr ? "نقطة الشحن · خدمة الدفع" : "CHARGING POINT · PAYMENT SERVICE"}</p>
            <h2>{isAr ? "تحويل بسيط، ومراجعة واضحة" : "A simple transfer. A clear review."}</h2>
            <p>{isAr ? "اختَر محفظتك أو البنك، أرفق الإيصال، وسنراجع إشعار الدفع قبل اعتماد أي مبلغ." : "Choose your bank or wallet, attach your receipt, and your payment notification will be reviewed before any amount is credited."}</p>
            <div className="payment-portal-visual-points"><span><CheckCircle2 className="h-4 w-4" />{isAr ? "ثلاث وسائل تحويل متاحة" : "Three transfer methods"}</span><span><ShieldCheck className="h-4 w-4" />{isAr ? "اعتماد بعد مراجعة الإيصال" : "Receipt review before approval"}</span></div>
          </aside>
          </div>
          </>
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
