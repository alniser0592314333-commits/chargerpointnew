import React, { useState, useEffect, useRef } from 'react';
import jsQR from 'jsqr';
import { Camera, Upload, X, AlertCircle, RefreshCw, CheckCircle2, ArrowRight } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';

interface QrScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onResult?: (rawText: string) => void;
}

export const QrScannerModal: React.FC<QrScannerModalProps> = ({ isOpen, onClose, onResult }) => {
  const { locale, isRTL } = useI18n();
  const isAr = locale === 'ar';

  const [activeTab, setActiveTab] = useState<'camera' | 'file'>('camera');
  const [cameraPermissionState, setCameraPermissionState] = useState<'prompt' | 'granted' | 'denied' | 'error'>('prompt');
  const [cameraErrorDetail, setCameraErrorDetail] = useState<string>('');
  const [isScanning, setIsScanning] = useState(false);
  const [detectedResult, setDetectedResult] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isProcessingFile, setIsProcessingFile] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameIdRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Stop camera stream safely
  const stopCamera = () => {
    if (animFrameIdRef.current) {
      cancelAnimationFrame(animFrameIdRef.current);
      animFrameIdRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsScanning(false);
  };

  // Start camera stream
  const startCamera = async () => {
    stopCamera();
    setCameraPermissionState('prompt');
    setCameraErrorDetail('');
    setDetectedResult(null);

    if (!navigator?.mediaDevices?.getUserMedia) {
      setCameraPermissionState('error');
      setCameraErrorDetail(
        isAr
          ? 'المتصفح لا يدعم الوصول للكاميرا في هذه البيئة. يمكنك استخدام خيار "رفع صورة".'
          : 'Browser does not support camera access in this environment. You can use the "Upload Image" option.'
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true');
        await videoRef.current.play();
        setCameraPermissionState('granted');
        setIsScanning(true);
        scanFrame();
      }
    } catch (err: any) {
      console.warn('Camera access error:', err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setCameraPermissionState('denied');
        setCameraErrorDetail(
          isAr
            ? 'تم رفض إذن الكاميرا. يرجى تفعيل إذن الكاميرا من إعدادات المتصفح ثم الضغط على "إعادة المحاولة".'
            : 'Camera permission was denied. Please allow camera access in browser settings and click "Try Again".'
        );
      } else {
        setCameraPermissionState('error');
        setCameraErrorDetail(
          isAr
            ? `تعذّر تشغيل الكاميرا (${err.message || 'خطأ غير معروف'}). يمكنك استخدام خيار اختيار صورة بدلاً منها.`
            : `Could not start camera (${err.message || 'Unknown error'}). You can upload an image instead.`
        );
      }
    }
  };

  // Continuous frame analysis
  const scanFrame = () => {
    if (!videoRef.current || !canvasRef.current || !streamRef.current) return;

    const video = videoRef.current;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert',
        });

        if (code && code.data) {
          handleSuccess(code.data);
          return;
        }
      }
    }

    animFrameIdRef.current = requestAnimationFrame(scanFrame);
  };

  // Process decoded result & route appropriately
  const handleSuccess = (rawText: string) => {
    stopCamera();
    setDetectedResult(rawText);

    if (onResult) {
      onResult(rawText);
      return;
    }

    // Default application routing parser
    setTimeout(() => {
      resolveAndNavigate(rawText);
    }, 450);
  };

  const resolveAndNavigate = (rawText: string) => {
    const text = rawText.trim();

    try {
      // Check if it's a full URL
      if (text.startsWith('http://') || text.startsWith('https://')) {
        const url = new URL(text);
        // If from the same host, route smoothly
        if (url.origin === window.location.origin) {
          window.location.assign(url.pathname + url.search + url.hash);
          return;
        }
        // If path matches application routes (/o/, /c/, /pay/)
        if (
          url.pathname.startsWith('/o/') ||
          url.pathname.startsWith('/c/') ||
          url.pathname.startsWith('/pay/') ||
          url.pathname.startsWith('/public/order/') ||
          url.pathname.startsWith('/public/qr/customer/')
        ) {
          window.location.assign(url.pathname + url.search);
          return;
        }
        window.location.assign(text);
        return;
      }
    } catch {}

    // Relative path or raw token
    if (text.startsWith('/o/') || text.startsWith('/c/') || text.startsWith('/pay/')) {
      window.location.assign(text);
      return;
    }

    // Raw token: default to order lookup or customer lookup
    // If token starts with cust- or similar
    if (text.toLowerCase().includes('cust') || text.startsWith('c_')) {
      window.location.assign(`/c/${encodeURIComponent(text)}`);
    } else {
      window.location.assign(`/o/${encodeURIComponent(text)}`);
    }
  };

  // Handle image file selection
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFileError(null);
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setFileError(isAr ? 'يرجى اختيار ملف صورة صالح (PNG, JPG, WebP).' : 'Please choose a valid image file (PNG, JPG, WebP).');
      return;
    }

    setIsProcessingFile(true);
    const reader = new FileReader();

    reader.onload = (loadEvent) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          setIsProcessingFile(false);
          setFileError(isAr ? 'تعذّر معالجة الصورة في المتصفح.' : 'Could not process image in browser.');
          return;
        }

        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);

        setIsProcessingFile(false);
        if (code && code.data) {
          handleSuccess(code.data);
        } else {
          setFileError(
            isAr
              ? 'لم يتم العثور على رمز QR واضح في هذه الصورة. تأكد من وضوح الصورة وجرّب صورة أخرى.'
              : 'No clear QR code was detected in this image. Ensure the image is clear and try again.'
          );
        }
      };
      img.onerror = () => {
        setIsProcessingFile(false);
        setFileError(isAr ? 'فشل تحميل الصورة.' : 'Failed to load image.');
      };
      img.src = loadEvent.target?.result as string;
    };

    reader.onerror = () => {
      setIsProcessingFile(false);
      setFileError(isAr ? 'تعذّر قراءة الملف.' : 'Could not read file.');
    };

    reader.readAsDataURL(file);
  };

  useEffect(() => {
    if (isOpen && activeTab === 'camera') {
      startCamera();
    } else {
      stopCamera();
    }
    return () => {
      stopCamera();
    };
  }, [isOpen, activeTab]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-fade-in"
      dir={isRTL ? 'rtl' : 'ltr'}
    >
      <div className="relative w-full max-w-md overflow-hidden rounded-3xl border border-white/10 bg-[#0d2a29] text-white shadow-2xl transition-all">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <h2 id="qr-modal-title" className="text-base font-bold text-[#e7fbf7]">
              {isAr ? 'مسح رمز QR' : 'Scan QR Code'}
            </h2>
            <p className="text-xs text-[#90b7af]">
              {isAr ? 'تفقّد تفاصيل طلبك أو افتح حسابك فوراً' : 'Check order details or open your account'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/5 text-[#d1e7e2] transition-colors hover:bg-white/10 hover:text-white"
            aria-label={isAr ? 'إغلاق' : 'Close'}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tab Selection */}
        <div className="grid grid-cols-2 p-2 bg-[#09201f] border-b border-white/5 text-xs font-semibold">
          <button
            type="button"
            onClick={() => setActiveTab('camera')}
            className={`flex items-center justify-center gap-2 rounded-xl py-2.5 transition-all ${
              activeTab === 'camera'
                ? 'bg-[#154642] text-[#6ee7b7] shadow-sm'
                : 'text-[#85a8a1] hover:text-white'
            }`}
          >
            <Camera className="h-4 w-4" />
            <span>{isAr ? 'الكاميرا المباشرة' : 'Live Camera'}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('file')}
            className={`flex items-center justify-center gap-2 rounded-xl py-2.5 transition-all ${
              activeTab === 'file'
                ? 'bg-[#154642] text-[#6ee7b7] shadow-sm'
                : 'text-[#85a8a1] hover:text-white'
            }`}
          >
            <Upload className="h-4 w-4" />
            <span>{isAr ? 'اختيار صورة / ملف' : 'Upload Image / File'}</span>
          </button>
        </div>

        {/* Body Content */}
        <div className="p-5">
          {detectedResult ? (
            <div className="flex flex-col items-center justify-center py-8 text-center space-y-3">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
                <CheckCircle2 className="h-10 w-10 animate-bounce" />
              </div>
              <h3 className="text-lg font-bold text-white">
                {isAr ? 'تم قراءة الرمز بنجاح!' : 'QR Code Recognized!'}
              </h3>
              <p className="text-xs text-[#a3c9c1] max-w-xs break-all">
                {detectedResult}
              </p>
              <p className="text-xs text-emerald-400 font-semibold animate-pulse">
                {isAr ? 'جارٍ تحويلك لمتابعة الطلب…' : 'Redirecting to your order…'}
              </p>
            </div>
          ) : activeTab === 'camera' ? (
            <div>
              {cameraPermissionState === 'denied' || cameraPermissionState === 'error' ? (
                <div className="flex flex-col items-center justify-center py-6 text-center space-y-4">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-rose-500/15 text-rose-400">
                    <AlertCircle className="h-8 w-8" />
                  </div>
                  <div className="space-y-1.5 max-w-xs">
                    <h3 className="text-sm font-bold text-white">
                      {isAr ? 'صلاحية الكاميرا غير مفعلة' : 'Camera Access Needed'}
                    </h3>
                    <p className="text-xs text-[#b0cec8] leading-relaxed">
                      {cameraErrorDetail}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                    <button
                      type="button"
                      onClick={startCamera}
                      className="inline-flex items-center gap-2 rounded-xl bg-[#0f766e] px-4 py-2.5 text-xs font-semibold text-white shadow-lg transition-all hover:bg-[#115e59]"
                    >
                      <RefreshCw className="h-4 w-4" />
                      <span>{isAr ? 'إعادة المحاولة' : 'Try Again'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('file')}
                      className="inline-flex items-center gap-2 rounded-xl bg-white/10 px-4 py-2.5 text-xs font-semibold text-white transition-all hover:bg-white/15"
                    >
                      <Upload className="h-4 w-4" />
                      <span>{isAr ? 'رفع صورة بدلاً من ذلك' : 'Upload Image Instead'}</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="relative overflow-hidden rounded-2xl bg-black aspect-square max-h-[300px] flex items-center justify-center">
                  <video
                    ref={videoRef}
                    className="h-full w-full object-cover"
                    muted
                    playsInline
                  />
                  <canvas ref={canvasRef} className="hidden" />

                  {/* Viewfinder Target Graphic */}
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
                    <div className="relative h-44 w-44 rounded-2xl border-2 border-emerald-400/60 shadow-[0_0_0_9999px_rgba(0,0,0,0.5)]">
                      {/* Scanning laser line */}
                      <div className="absolute inset-x-0 h-0.5 bg-gradient-to-r from-transparent via-emerald-400 to-transparent animate-scan" />
                      {/* Corner Accents */}
                      <div className="absolute top-0 left-0 h-4 w-4 border-t-2 border-l-2 border-emerald-400" />
                      <div className="absolute top-0 right-0 h-4 w-4 border-t-2 border-r-2 border-emerald-400" />
                      <div className="absolute bottom-0 left-0 h-4 w-4 border-b-2 border-l-2 border-emerald-400" />
                      <div className="absolute bottom-0 right-0 h-4 w-4 border-b-2 border-r-2 border-emerald-400" />
                    </div>
                  </div>

                  <div className="absolute bottom-3 inset-x-0 text-center">
                    <span className="inline-block rounded-full bg-black/60 px-3 py-1 text-[11px] font-medium text-emerald-300 backdrop-blur-sm">
                      {isAr ? 'وجّه الكاميرا نحو رمز QR' : 'Point camera at QR code'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                className="hidden"
                id="qr-file-input"
              />

              <div
                onClick={() => fileInputRef.current?.click()}
                className="group flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-white/20 bg-[#092221] p-8 text-center cursor-pointer transition-all hover:border-emerald-400 hover:bg-[#0c2a29]"
              >
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/5 text-emerald-400 group-hover:scale-110 transition-transform">
                  <Upload className="h-7 w-7" />
                </div>
                <h3 className="mt-3 text-sm font-semibold text-white">
                  {isAr ? 'اضغط لاختيار صورة الـ QR' : 'Click to select QR image'}
                </h3>
                <p className="mt-1 text-xs text-[#8cb2aa]">
                  {isAr ? 'يدعم PNG أو JPG أو لقطات الشاشة' : 'Supports PNG, JPG or screenshots'}
                </p>
                {isProcessingFile && (
                  <div className="mt-4 flex items-center gap-2 text-xs text-emerald-400 font-medium">
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    <span>{isAr ? 'جارٍ فحص وقراءة الصورة…' : 'Analyzing image…'}</span>
                  </div>
                )}
              </div>

              {fileError && (
                <div className="flex items-start gap-2 rounded-xl bg-rose-500/15 border border-rose-500/30 p-3 text-xs text-rose-200">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-rose-400" />
                  <p>{fileError}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Guidance */}
        <div className="border-t border-white/5 bg-[#081a19] px-5 py-3.5 text-center text-[11px] text-[#7da69f]">
          {isAr
            ? 'رمز QR مطبوع على بطاقة استلام طلبك أو في رسالة الواتساب'
            : 'QR code is printed on your receipt card or in your WhatsApp message'}
        </div>
      </div>
    </div>
  );
};
