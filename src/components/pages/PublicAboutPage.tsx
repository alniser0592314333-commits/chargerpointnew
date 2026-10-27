import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  Zap,
  QrCode,
  Clock,
  CheckCircle2,
  ChevronDown,
  Globe,
  Moon,
  Sun,
  Menu,
  X,
  Phone,
  MessageCircle,
  MapPin,
  ShieldCheck,
  BatteryCharging,
  Smartphone,
  Wallet,
  ArrowUpRight,
  Sparkles,
  Download,
  UserCheck,
  ChevronLeft,
  ChevronRight,
  Flame,
  Info,
} from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { useTheme } from '../../theme/themeContext';
import { fetchAppReleasePolicy } from '../../services/appReleasePolicy';
import { AppLogo } from '../qr/AppLogo';
import { QrScannerModal } from '../qr/QrScannerModal';
import {
  DEFAULT_BUSINESS_HOURS,
  getBusinessHoursConfig,
  refreshBusinessHoursConfigFromServer,
  computeOperationalStatus,
  subscribeBusinessHours,
  BusinessHoursConfig,
  OperationalStatusDetail,
} from '../../services/businessHoursService';
import { getAllDeviceTypes, UIDeviceTypeItem } from './dayOrdersStore';
import './public-about.css';

type DeferredPwaInstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }> };

export const PublicAboutPage: React.FC = () => {
  const { locale, setLocale, isRTL, formatCurrency } = useI18n();
  const { resolvedTheme, toggleTheme, setTheme } = useTheme();
  const isAr = locale === 'ar';

  // Modal & Drawer State
  const [isQrModalOpen, setIsQrModalOpen] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isContactModalOpen, setIsContactModalOpen] = useState(false);
  const [activeFaqIndex, setActiveFaqIndex] = useState<number | null>(0);
  const [deferredPwaPrompt, setDeferredPwaPrompt] = useState<DeferredPwaInstallPrompt | null>(null);
  const [releaseDownloadUrl, setReleaseDownloadUrl] = useState('');
  const [isStartingDownload, setIsStartingDownload] = useState(false);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPwaPrompt(event as DeferredPwaInstallPrompt);
    };
    const onInstalled = () => setDeferredPwaPrompt(null);
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    void fetchAppReleasePolicy('customer').then(({ policy }) => {
      if (policy?.download_url) setReleaseDownloadUrl(policy.download_url.trim());
    }).catch(() => undefined);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const startDirectApkDownload = async () => {
    let url = releaseDownloadUrl;
    if (!url) {
      setIsStartingDownload(true);
      try {
        const { policy } = await fetchAppReleasePolicy('customer');
        url = policy?.download_url?.trim() || '';
        if (url) setReleaseDownloadUrl(url);
      } catch { /* Show a simple message below if policy cannot be loaded. */ }
      setIsStartingDownload(false);
    }
    if (!url) {
      window.alert(isAr ? 'تعذر جلب رابط تنزيل التطبيق. حاول مرة أخرى.' : 'Could not load the app download link. Please try again.');
      return;
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') throw new Error('HTTPS required');
      // Dropbox's dl=1 parameter requests the file directly instead of its preview page.
      if (parsed.hostname === 'www.dropbox.com' || parsed.hostname === 'dropbox.com') parsed.searchParams.set('dl', '1');
      window.location.assign(parsed.toString());
    } catch {
      window.alert(isAr ? 'رابط التنزيل غير صالح.' : 'The download link is invalid.');
    }
  };

  const installWebsiteAsPwa = async () => {
    if (deferredPwaPrompt) {
      await deferredPwaPrompt.prompt();
      const choice = await deferredPwaPrompt.userChoice;
      if (choice.outcome === 'accepted') setDeferredPwaPrompt(null);
      return;
    }
    const alreadyInstalled = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (alreadyInstalled) {
      window.alert(isAr ? 'الصفحة مثبتة بالفعل على جهازك.' : 'This page is already installed on your device.');
    } else {
      window.alert(isAr
        ? 'التثبيت المباشر غير متاح من المتصفح الحالي. افتح الموقع في Google Chrome المحدّث وتأكد أنك تستخدم الرابط الآمن https، ثم أعد المحاولة. لن نضيف اختصارًا عاديًا بدل تثبيت التطبيق.'
        : 'Direct installation is unavailable in this browser. Open this secure HTTPS site in an up-to-date Google Chrome browser and try again. We will not substitute a simple shortcut for app installation.');
    }
  };

  // Business Hours & Live Status State: local settings are used only while offline.
  const getInitialHoursConfig = () =>
    typeof navigator !== 'undefined' && navigator.onLine === false
      ? getBusinessHoursConfig()
      : DEFAULT_BUSINESS_HOURS;
  const [hoursConfig, setHoursConfig] = useState<BusinessHoursConfig>(getInitialHoursConfig);
  const hoursConfigRef = useRef(hoursConfig);
  const [operationalStatus, setOperationalStatus] = useState<OperationalStatusDetail>(() =>
    computeOperationalStatus(getInitialHoursConfig())
  );

  // Real Database Device Types State
  const [deviceTypes, setDeviceTypes] = useState<UIDeviceTypeItem[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);

  // Keep scroll-driven scenery updates outside React state so the full page does not re-render on every scroll frame.
  const pageContainerRef = useRef<HTMLDivElement | null>(null);
  const prefersReducedMotionRef = useRef(false);

  // ---------------------------------------------------------------------------
  // 1. Subscribe to Live Business Hours & Clock Ticks
  // ---------------------------------------------------------------------------
  useEffect(() => {
    // Check prefers-reduced-motion
    if (typeof window !== 'undefined') {
      prefersReducedMotionRef.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    const applyHoursConfig = (cfg: BusinessHoursConfig) => {
      hoursConfigRef.current = cfg;
      setHoursConfig(cfg);
      setOperationalStatus(computeOperationalStatus(cfg));
    };

    const updateStatus = () => {
      const cfg = typeof navigator !== 'undefined' && navigator.onLine === false
        ? getBusinessHoursConfig()
        : hoursConfigRef.current;
      applyHoursConfig(cfg);
    };

    updateStatus();

    // Hydrate from the shared server configuration; local storage is only the offline cache.
    const refreshSharedStatus = () => {
      void refreshBusinessHoursConfigFromServer().then(applyHoursConfig);
    };
    refreshSharedStatus();

    // Keep countdown local; poll shared settings less frequently for changes from other devices.
    const intervalId = window.setInterval(updateStatus, 30000);
    const sharedIntervalId = window.setInterval(refreshSharedStatus, 60000);
    const unsubscribe = subscribeBusinessHours((updatedCfg) => {
      // Ignore per-origin local edits while online; the server poll is authoritative.
      if (typeof navigator === 'undefined' || navigator.onLine !== false) return;
      applyHoursConfig(updatedCfg);
    });

    // Re-read persisted settings when returning to the tab/page as well as on clock ticks.
    const refreshFromStorage = () => refreshSharedStatus();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshSharedStatus();
    };
    window.addEventListener('focus', refreshFromStorage);
    window.addEventListener('online', refreshSharedStatus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.clearInterval(sharedIntervalId);
      window.removeEventListener('focus', refreshFromStorage);
      window.removeEventListener('online', refreshSharedStatus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      unsubscribe();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 2. Fetch Real Device Types from Database
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let mounted = true;
    getAllDeviceTypes()
      .then((items) => {
        if (mounted) {
          setDeviceTypes(items.filter((d) => d.isActive));
          setDevicesLoading(false);
        }
      })
      .catch((err) => {
        console.warn('Could not load device types from store:', err);
        if (mounted) {
          setDevicesLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 3. Parallax Scroll Handler (passive listener + one DOM update per frame)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const page = pageContainerRef.current;
    if (!page) return;

    let frameId = 0;
    let ticking = false;

    const updateParallax = () => {
      ticking = false;
      const cappedScroll = prefersReducedMotionRef.current
        ? 0
        : Math.min(window.scrollY, 1200);

      // Update only the scenery CSS variables. Do not trigger a React render for scroll.
      page.style.setProperty('--moon-y', `${-cappedScroll * 0.42}px`);
      page.style.setProperty('--moon-scale', String(Math.max(0.72, 1 - cappedScroll * 0.0003)));
      page.style.setProperty('--ridge-y', `${cappedScroll * 0.08}px`);
      page.style.setProperty('--peak-y', `${cappedScroll * 0.16}px`);
      page.style.setProperty('--hill-y', `${cappedScroll * 0.26}px`);
      page.style.setProperty('--pine-y', `${cappedScroll * 0.38}px`);
    };

    const handleScroll = () => {
      if (ticking) return;
      ticking = true;
      frameId = window.requestAnimationFrame(updateParallax);
    };

    // Apply the current position immediately, including when restoring a scrolled page.
    updateParallax();
    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (frameId) window.cancelAnimationFrame(frameId);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 4. Grouped Pricing Categories (Derived from Real Database Data)
  // ---------------------------------------------------------------------------
  const pricingSummary = useMemo(() => {
    if (!deviceTypes || deviceTypes.length === 0) {
      // Fallback display if database has not yet synced device types
      return [
        {
          id: 'smartphones',
          nameAr: 'الهواتف الذكية',
          nameEn: 'Smartphones',
          descriptionAr: 'شحن فائق السرعة مع مراقبة حرارية لجميع هواتف أبل وسامسونج وشاومي',
          descriptionEn: 'High-speed monitored charging for Apple, Samsung, Xiaomi & all phones',
          minPrice: 100,
          maxPrice: 200,
          count: 4,
          icon: Smartphone,
        },
        {
          id: 'powerbanks',
          nameAr: 'بنوك الطاقة والشواحن',
          nameEn: 'Power Banks & Accessories',
          descriptionAr: 'شحن مكثف للبطاريات المحمولة وأجهزة الشحن السريع بقدرات حتى 65W',
          descriptionEn: 'High-wattage charging for portable battery packs up to 65W',
          minPrice: 200,
          maxPrice: 300,
          count: 3,
          icon: BatteryCharging,
        },
        {
          id: 'tablets',
          nameAr: 'الأجهزة اللوحية والمحمولة',
          nameEn: 'Tablets & Portables',
          descriptionAr: 'شحن آمن لأجهزة الآيباد والتابلت وأجهزة الألعاب المحمولة',
          descriptionEn: 'Safe charging for iPads, tablets and handheld portable consoles',
          minPrice: 100,
          maxPrice: 200,
          count: 2,
          icon: Zap,
        },
      ];
    }

    // Group real devices into representative categories
    const phones = deviceTypes.filter(
      (d) =>
        d.name.includes('آيفون') ||
        d.name.includes('سامسونج') ||
        d.name.toLowerCase().includes('phone') ||
        d.name.toLowerCase().includes('galaxy')
    );
    const power = deviceTypes.filter(
      (d) =>
        d.name.includes('شاحن') ||
        d.name.includes('بطارية') ||
        d.name.toLowerCase().includes('charger') ||
        d.name.toLowerCase().includes('battery')
    );
    const others = deviceTypes.filter((d) => !phones.includes(d) && !power.includes(d));

    const buildCategory = (
      id: string,
      items: UIDeviceTypeItem[],
      titleAr: string,
      titleEn: string,
      descAr: string,
      descEn: string,
      IconComponent: any
    ) => {
      const source = items.length > 0 ? items : deviceTypes;
      const prices = source.map((d) => d.basePriceMinor);
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      return {
        id,
        nameAr: titleAr,
        nameEn: titleEn,
        descriptionAr: descAr,
        descriptionEn: descEn,
        minPrice: id === 'cat-phones' ? 100 : id === 'cat-power' ? 200 : id === 'cat-tablets' ? 100 : (isFinite(min) ? min : 200),
        maxPrice: id === 'cat-phones' ? 200 : id === 'cat-power' ? 300 : id === 'cat-tablets' ? 200 : (isFinite(max) ? max : 400),
        count: source.length,
        icon: IconComponent,
      };
    };

    return [
      buildCategory(
        'cat-phones',
        phones,
        'الهواتف الذكية',
        'Smartphones',
        'شحن آمن لجميع أنواع هواتف iPhone و Samsung و Xiaomi',
        'Safe charging for all iPhone, Samsung, and Xiaomi models',
        Smartphone
      ),
      buildCategory(
        'cat-power',
        power,
        'الشواحن وبنوك الطاقة',
        'Chargers & Power Banks',
        'شحن فائق السرعة للبطاريات المتنقلة والشواحن',
        'Fast charging for portable batteries and accessories',
        BatteryCharging
      ),
      buildCategory(
        'cat-tablets',
        others,
        'الأجهزة اللوحية والمحمولة',
        'Tablets & Portables',
        'شحن منظم لأجهزة iPad والشاشات الذكية والمحمولة',
        'Regulated charging for iPads and portable devices',
        Zap
      ),
    ];
  }, [deviceTypes]);

  // Overall database price range
  const allPrices = deviceTypes.map((d) => d.basePriceMinor);
  const globalMinPrice = allPrices.length > 0 ? Math.min(...allPrices) : 200;
  const globalMaxPrice = allPrices.length > 0 ? Math.max(...allPrices) : 600;

  // Format charger fee
  const chargerFeeDisplay = formatCurrency(hoursConfig.chargerFeeMinor || 50);

  // ---------------------------------------------------------------------------
  // 5. FAQ Accordion Items
  // ---------------------------------------------------------------------------
  const faqs = [
    {
      qAr: 'كم يستغرق شحن الجهاز عادةً؟',
      qEn: 'How long does a device take to charge?',
      aAr: 'يعتمد وقت الشحن على سعة بطارية جهازك ونسبة الشحن المتبقية. في المتوسط، يستغرق الهاتف الذكي بين 45 دقيقة إلى ساعة ونصف للوصول إلى 80-100% باستخدام منافذ الشحن السريع المعتمدة لدينا.',
      aEn: 'Charging time depends on your battery capacity and current charge level. On average, a smartphone takes 45 to 90 minutes to reach 80-100% using our certified fast-charging ports.',
    },
    {
      qAr: 'كيف أتابع حالة طلبي أثناء الشحن؟',
      qEn: 'How do I track my order during charging?',
      aAr: 'عند تسليم جهازك، يمنحك المشرف بطاقة استلام تحتوي على رمز QR مخصص لطلبك. يمكنك مسحه بكاميرا هاتفك أو من خلال زر "مسح QR" في أعلى هذه الصفحة للاطلاع على حالة الجهاز والوقت والمبلغ المطلوب في أي لحظة.',
      aEn: 'Upon handing over your device, you receive a receipt card with a dedicated QR code. You can scan it with your phone camera or through the "Scan QR" button on this page to view live status and amount due.',
    },
    {
      qAr: 'ماذا لو لم أحضر الشاحن أو الكابل الخاص بي؟',
      qEn: 'What if I do not have my charger or cable?',
      aAr: `لا مشكلة إطلاقاً! نوفر كابلات وشواحن أصلية عالية الجودة معتمدة لجميع المداخل (Type-C, Lightning, Micro-USB). تُضاف رسوم رمزية قدرها ${chargerFeeDisplay} فقط عند استخدام شاحن النقطة.`,
      aEn: `No problem at all! We provide original, certified cables for all connectors (Type-C, Lightning, Micro-USB). A nominal fee of only ${chargerFeeDisplay} is added when using our charger.`,
    },
    {
      qAr: 'ما هي طرق الدفع المعتمدة؟',
      qEn: 'What payment methods are supported?',
      aAr: 'نقبل الدفع النقدي المباشر عند الاستلام، بالإضافة إلى المحافظ الرقمية والتحويلات البنكية (جوال باي Jawwal Pay، بال باي PalPay، وتطبيق بنك فلسطين Bank of Palestine).',
      aEn: 'We accept direct cash upon pickup, as well as digital wallets and bank transfers (Jawwal Pay, PalPay, and Bank of Palestine app).',
    },
    {
      qAr: 'هل جهازي آمن أثناء وجوده في نقطة الشحن؟',
      qEn: 'Is my device safe during charging?',
      aAr: 'أجهزتكم في أمان تام ومسؤولية كاملة. يتم حفظ كل جهاز في حجيرة مخصصة ومحمية، والشحن مراقب بنظام أمان إلكتروني يمنع ارتفاع الحرارة أو زيادة التيار الكهربائي.',
      aEn: 'Your devices are completely secure. Each device is kept in a designated protected bay, and charging is monitored with electronic safety mechanisms preventing power surges or overheating.',
    },
  ];

  return (
    <div
      ref={pageContainerRef}
      dir={isRTL ? 'rtl' : 'ltr'}
      className="about-page-container selection:bg-emerald-500/20"
    >
      {/* Dynamic Atmospheric Sky Background */}
      <div className="about-sky-backdrop">
        <div className="about-sky-night" />
        <div className="about-starfield" />
      </div>

      {/* =====================================================================
          HEADER (Fixed & Elegant with Brand Logo, CTA, Drawer Toggle)
          ===================================================================== */}
      <header className="about-header">
        <div className="about-header-inner">
          {/* Brand Logo & Name */}
          <a
            href="/public/about"
            onClick={(event) => event.preventDefault()}
            className="flex items-center gap-3 group focus:outline-hidden"
            aria-label={isAr ? 'نقطة الشحن - الصفحة الرئيسية' : 'Charging Point - Home'}
          >
            <div className="h-10 w-10 shrink-0 rounded-2xl bg-gradient-to-br from-[#0f766e] to-[#0d5953] flex items-center justify-center p-2 shadow-md shadow-emerald-950/20 group-hover:scale-105 transition-transform">
              <AppLogo size={26} variant="white" />
            </div>
            <div>
              <span className="block text-sm sm:text-base font-extrabold tracking-tight text-gray-900 dark:text-[#f0fbf8]">
                {isAr ? 'نقطة الشحن' : 'Charging Point'}
              </span>
              <span className="block text-[11px] font-medium text-emerald-800 dark:text-[#88d2c4] -mt-0.5">
                {isAr ? 'حسابك وخدمات الشحن' : 'Your Account & Charging Services'}
              </span>
            </div>
          </a>

          {/* Right Header Actions */}
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Live Indicator Pill in Header */}
            <div className={`hidden md:inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold text-gray-800 dark:text-[#d2ede7] ${
              operationalStatus.isOpen
                ? 'bg-emerald-500/10 border border-emerald-500/20'
                : 'bg-rose-500/10 border border-rose-500/20'
            }`}>
              <span
                className={
                  operationalStatus.isOpen ? 'status-dot-pulse-green' : 'status-dot-pulse-red'
                }
              />
              <span>{isAr ? operationalStatus.headlineAr : operationalStatus.headlineEn}</span>
            </div>

            {/* Prominent CTA: "تفقّد طلباتك" */}
            <button
              type="button"
              onClick={() => setIsQrModalOpen(true)}
              className="header-track-btn cursor-pointer"
            >
              <QrCode className="h-4 w-4" />
              <span>{isAr ? 'تفقّد طلباتك' : 'Check Orders'}</span>
            </button>

            {/* Hamburger Button for Drawer */}
            <button
              type="button"
              onClick={() => setIsDrawerOpen(true)}
              className="header-menu-btn cursor-pointer"
              aria-label={isAr ? 'فتح القائمة الجانبية' : 'Open menu'}
            >
              <Menu className="h-5 w-5" />
            </button>
          </div>
        </div>
      </header>

      {/* =====================================================================
          DRAWER NAVIGATION MENU (Responsive, Theme, Lang, Customer Login)
          ===================================================================== */}
      {isDrawerOpen && (
        <div className="drawer-backdrop" onClick={() => setIsDrawerOpen(false)}>
          <aside
            className="drawer-panel"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={isAr ? 'القائمة الجانبية' : 'Side Navigation'}
          >
            {/* Drawer Header */}
            <div className="flex items-center justify-between border-b border-gray-100 dark:border-white/10 p-5">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-xl bg-[#0f766e] flex items-center justify-center p-1.5 text-white">
                  <AppLogo size={22} variant="white" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-gray-900 dark:text-white">
                    {isAr ? 'نقطة الشحن' : 'Charging Point'}
                  </h3>
                  <p className="text-[11px] text-gray-500 dark:text-[#88d2c4]">
                    {isAr ? 'بوابة العميل العامة' : 'Public Customer Portal'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsDrawerOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/10"
                aria-label={isAr ? 'إغلاق القائمة' : 'Close menu'}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Drawer Links & Actions */}
            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {/* Status Badge inside Drawer */}
              <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-[#071d1c] p-4 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span
                    className={
                      operationalStatus.isOpen
                        ? 'status-dot-pulse-green'
                        : 'status-dot-pulse-red'
                    }
                  />
                  <div>
                    <span className="block text-xs font-bold text-gray-900 dark:text-white">
                      {isAr ? operationalStatus.headlineAr : operationalStatus.headlineEn}
                    </span>
                    <span className="block text-[11px] text-gray-500 dark:text-[#88d2c4]">
                      {isAr ? operationalStatus.countdownTextAr : operationalStatus.countdownTextEn}
                    </span>
                  </div>
                </div>
              </div>

              {/* Navigation Items */}
              <div className="space-y-1.5">
                {/* 1. Track Orders / Scan QR */}
                <button
                  type="button"
                  onClick={() => {
                    setIsDrawerOpen(false);
                    setIsQrModalOpen(true);
                  }}
                  className="w-full flex items-center justify-between gap-3 p-3.5 rounded-xl text-start font-semibold text-sm bg-emerald-50 text-emerald-800 dark:bg-[#0f766e]/20 dark:text-[#6ee7b7] hover:bg-emerald-100 dark:hover:bg-[#0f766e]/30 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <QrCode className="h-5 w-5" />
                    <span>{isAr ? 'مسح رمز QR / تفقّد الطلب' : 'Scan QR / Track Order'}</span>
                  </div>
                  {isRTL ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>

                {/* 2. Customer Portal Login/Registration */}
                <a
                  href="/c/portal"
                  onClick={(e) => {
                    // Check if customer already has a saved token
                    const saved = localStorage.getItem('last_customer_token');
                    if (saved) {
                      e.preventDefault();
                      window.location.assign(`/c/${encodeURIComponent(saved)}`);
                    }
                  }}
                  className="w-full flex items-center justify-between gap-3 p-3.5 rounded-xl text-start font-semibold text-sm text-gray-800 dark:text-[#d5ede8] hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <UserCheck className="h-5 w-5 text-[#0f766e] dark:text-[#6ee7b7]" />
                    <div>
                      <span className="block">
                        {isAr ? 'دخول / تسجيل صفحة العميل' : 'Customer Account / Sign In'}
                      </span>
                      <span className="block text-[11px] text-gray-500 dark:text-[#88d2c4] font-normal">
                        {isAr ? 'متابعة الرصيد وسجل طلباتك' : 'View account balance & order history'}
                      </span>
                    </div>
                  </div>
                  <ArrowUpRight className="h-4 w-4 text-gray-400" />
                </a>

                {/* The native APK is already installed; keep the PWA install option on the website only. */}
                {!Capacitor.isNativePlatform() && (
                  <button
                    type="button"
                    onClick={() => { setIsDrawerOpen(false); void startDirectApkDownload(); }}
                    className="w-full flex items-center justify-between gap-3 p-3.5 rounded-xl text-start font-semibold text-sm text-gray-800 dark:text-[#d5ede8] hover:bg-gray-100 dark:hover:bg-white/5 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-3">
                      <Download className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                      <div>
                        <span className="block">{isAr ? 'تثبيت التطبيق' : 'Download App'}</span>
                        <span className="block text-[11px] text-gray-500 dark:text-[#88d2c4] font-normal">
                          {isAr ? 'بدء تنزيل ملف APK مباشرة' : 'Start APK download directly'}
                        </span>
                      </div>
                    </div>
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300">
                      {isAr ? 'متاح الآن' : 'Available now'}
                    </span>
                  </button>
                )}
                {!Capacitor.isNativePlatform() && (
                  <button
                    type="button"
                    onClick={() => { setIsDrawerOpen(false); void installWebsiteAsPwa(); }}
                    className="w-full flex items-center justify-between gap-3 p-3.5 rounded-xl text-start font-semibold text-sm text-gray-800 dark:text-[#d5ede8] hover:bg-gray-100 dark:hover:bg-white/5 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-3">
                      <Smartphone className="h-5 w-5 text-[#0f766e] dark:text-[#6ee7b7]" />
                      <div>
                        <span className="block">{isAr ? 'تثبيت تطبيق PWA' : 'Install PWA app'}</span>
                        <span className="block text-[11px] text-gray-500 dark:text-[#88d2c4] font-normal">
                          {isAr ? 'تثبيت التطبيق على الجهاز' : 'Install the app on this device'}
                        </span>
                      </div>
                    </div>
                    <ArrowUpRight className="h-4 w-4 text-gray-400" />
                  </button>
                )}

                {/* Contact Us: keep contact choices accessible from the More menu. */}
                <button
                  type="button"
                  onClick={() => {
                    setIsDrawerOpen(false);
                    setIsContactModalOpen(true);
                  }}
                  className="w-full flex items-center justify-between gap-3 p-3.5 rounded-xl text-start font-semibold text-sm text-gray-800 dark:text-[#d5ede8] hover:bg-gray-100 dark:hover:bg-white/5 transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <MessageCircle className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                    <div>
                      <span className="block">{isAr ? 'تواصل معنا' : 'Contact Us'}</span>
                      <span className="block text-[11px] text-gray-500 dark:text-[#88d2c4] font-normal">
                        {isAr ? 'واتساب أو اتصال مباشر' : 'WhatsApp or direct call'}
                      </span>
                    </div>
                  </div>
                  {isRTL ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>

              </div>

              <hr className="border-gray-200 dark:border-white/10" />

              {/* Theme & Language Controls */}
              <div className="space-y-3">
                <div className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-[#88d2c4]">
                  {isAr ? 'التفضيلات والمظهر' : 'Preferences & Appearance'}
                </div>

                {/* Actual Theme Switcher */}
                <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-white/5">
                  <div className="flex items-center gap-2.5 text-xs font-semibold">
                    {resolvedTheme === 'dark' ? (
                      <Moon className="h-4 w-4 text-amber-400" />
                    ) : (
                      <Sun className="h-4 w-4 text-amber-500" />
                    )}
                    <span>{isAr ? 'المظهر (داكن / فاتح)' : 'Theme (Dark / Light)'}</span>
                  </div>
                  <div className="flex items-center gap-1 bg-white dark:bg-black/30 p-1 rounded-lg border border-gray-200 dark:border-white/10">
                    <button
                      type="button"
                      onClick={() => setTheme('light')}
                      className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all ${
                        resolvedTheme === 'light'
                          ? 'bg-amber-100 text-amber-900 shadow-2xs'
                          : 'text-gray-500 hover:text-gray-900 dark:text-gray-400'
                      }`}
                    >
                      {isAr ? 'فاتح' : 'Light'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setTheme('dark')}
                      className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all ${
                        resolvedTheme === 'dark'
                          ? 'bg-emerald-900 text-emerald-200 shadow-2xs'
                          : 'text-gray-500 hover:text-white'
                      }`}
                    >
                      {isAr ? 'داكن' : 'Dark'}
                    </button>
                  </div>
                </div>

                {/* Actual Language Switcher */}
                <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-white/5">
                  <div className="flex items-center gap-2.5 text-xs font-semibold">
                    <Globe className="h-4 w-4 text-emerald-600 dark:text-[#6ee7b7]" />
                    <span>{isAr ? 'اللغة' : 'Language'}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setLocale(isAr ? 'en' : 'ar')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-white dark:bg-black/30 border border-gray-200 dark:border-white/10 hover:border-emerald-500 transition-colors"
                  >
                    <span>{isAr ? 'English' : 'العربية'}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Drawer Footer */}
            <div className="border-t border-gray-100 dark:border-white/10 p-5 text-center text-xs text-gray-500 dark:text-[#88d2c4]">
              {isAr ? 'نقطة الشحن · جميع الحقوق محفوظة 2026' : 'Charging Point · All rights reserved 2026'}
            </div>
          </aside>
        </div>
      )}

      {/* =====================================================================
          HERO STAGE WITH TWIN MOUNTAINS & RISING MOON PARALLAX
          ===================================================================== */}
      <section className="parallax-hero-stage pt-24 sm:pt-28">
        {/* PARALLAX LAYER 1: The Glowing Golden Moon */}
        <div className="parallax-layer-moon" aria-hidden="true">
          <div className="parallax-moon-crater-1" />
          <div className="parallax-moon-crater-2" />
          <div className="parallax-moon-crater-3" />
        </div>

        {/* PARALLAX LAYER 2: Distant Ridge Silhouette (SVG) */}
        <div className="parallax-layer-ridges" aria-hidden="true">
          <svg viewBox="0 0 1200 400" preserveAspectRatio="none" className="w-full h-full">
            <path
              d="M-50 280L120 180L240 240L380 140L520 250L680 160L820 260L960 150L1100 240L1250 170V400H-50Z"
              fill="#0c4755"
              opacity="0.85"
            />
          </svg>
        </div>

        {/* PARALLAX LAYER 3: The Twin Peaks with Snowcaps (App Identity) */}
        <div className="parallax-layer-peaks" aria-hidden="true">
          <svg viewBox="0 0 1200 500" preserveAspectRatio="none" className="w-full h-full">
            <defs>
              <linearGradient id="peak-warm-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f3914a" />
                <stop offset="100%" stopColor="#b4421b" />
              </linearGradient>
              <linearGradient id="peak-dark-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#156475" />
                <stop offset="100%" stopColor="#0a313b" />
              </linearGradient>
              <linearGradient id="snowcap-light-grad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#ffffff" />
                <stop offset="100%" stopColor="#a3e7e3" />
              </linearGradient>
            </defs>

            {/* Left Mountain Base (Cool shaded facet) */}
            <path d="M120 500L460 160L600 280L760 120L1100 500Z" fill="url(#peak-dark-grad)" />

            {/* Right Sunlit Facet (Warm Orange Mountain base) */}
            <path d="M760 120L1100 500H880L800 340L760 260Z" fill="url(#peak-warm-grad)" />
            <path d="M460 160L360 300L420 340L370 430L460 350L600 280Z" fill="url(#peak-warm-grad)" opacity="0.9" />

            {/* Snowcaps on Twin Peaks */}
            <path
              d="M760 120L690 220L730 240L700 310L790 260L820 340L860 250Z"
              fill="url(#snowcap-light-grad)"
            />
            <path
              d="M460 160L390 260L435 250L410 330L490 260L540 260Z"
              fill="url(#snowcap-light-grad)"
              opacity="0.95"
            />
          </svg>
        </div>

        {/* PARALLAX LAYER 4: Warm Foothills */}
        <div className="parallax-layer-foothills" aria-hidden="true">
          <svg viewBox="0 0 1200 300" preserveAspectRatio="none" className="w-full h-full">
            <path
              d="M-50 180C140 100 320 170 500 130S860 80 1250 170V300H-50Z"
              fill="#14606f"
              opacity="0.9"
            />
          </svg>
        </div>

        {/* PARALLAX LAYER 5: Front Pine Silhouettes */}
        <div className="parallax-layer-pines" aria-hidden="true">
          <svg viewBox="0 0 1200 160" preserveAspectRatio="none" className="w-full h-full">
            <g fill="#082a32">
              {[
                [30, 140, 0.9],
                [80, 150, 0.75],
                [140, 130, 1.1],
                [210, 145, 0.8],
                [300, 135, 1.0],
                [850, 135, 1.05],
                [920, 120, 1.2],
                [990, 145, 0.85],
                [1070, 130, 1.0],
                [1140, 150, 0.8],
              ].map(([x, y, s], i) => (
                <path
                  key={i}
                  transform={`translate(${x} ${y}) scale(${s})`}
                  d="M0 -55L14 -28H7L19 -8H9L22 14H-22L-9 -8H-19L-7 -28H-14Z"
                />
              ))}
              <rect x="-20" y="140" width="1240" height="30" />
            </g>
          </svg>
        </div>

        {/* Hero Bottom Mist Gradient */}
        <div className="parallax-hero-mist" />

        {/* Hero Foreground Content */}
        <div className="relative z-10 mx-auto max-w-4xl px-4 text-center mt-auto mb-8 sm:mb-12">
          {/* Eyebrow Pill */}
          <div className="inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-bold bg-white/10 backdrop-blur-md border border-white/20 text-[#e9fcf8] shadow-lg mb-4">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
            <span>{isAr ? 'نقطة الشحن الموثوقة' : 'Trusted Charging Point'}</span>
          </div>

          {/* Main Hero Headline */}
          <h1 className="text-3xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-white drop-shadow-md leading-tight">
            {isAr ? 'طاقة موثوقة لأجهزتك' : 'Reliable Energy for Your Devices'}
            <span className="block mt-1 sm:mt-2 text-transparent bg-clip-text bg-gradient-to-r from-emerald-200 via-teal-100 to-amber-200">
              {isAr ? 'بأمان تام ومتابعة دقيقة' : 'Complete Safety & Precision Tracking'}
            </span>
          </h1>

          <p className="mt-4 max-w-2xl mx-auto text-sm sm:text-base leading-relaxed text-[#cde7e2] font-medium drop-shadow-sm">
            {isAr
              ? 'خدمة شحن سريعة وفائقة الأمان للهواتف والأجهزة وبنوك الطاقة، مع تتبع لحظي لطلبك عبر رمز QR ونظام مالي واضح ومعتمد.'
              : 'Fast and safe charging for phones, devices, and power banks, with real-time QR tracking and transparent certified billing.'}
          </p>

          {/* Dual Action Hero Buttons */}
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3.5">
            <button
              type="button"
              onClick={() => setIsQrModalOpen(true)}
              className="inline-flex items-center gap-2.5 rounded-2xl bg-gradient-to-r from-[#0f766e] to-[#047857] px-6 py-3.5 text-sm font-bold text-white shadow-xl shadow-emerald-950/40 hover:from-[#115e59] hover:to-[#065f46] hover:scale-102 active:scale-98 transition-all cursor-pointer border border-emerald-400/30"
            >
              <QrCode className="h-5 w-5" />
              <span>{isAr ? 'مسح QR وتفقّد طلبك' : 'Scan QR & Track Order'}</span>
            </button>

            <a
              href="#pricing-section"
              className="inline-flex items-center gap-2 rounded-2xl bg-white/10 backdrop-blur-md px-6 py-3.5 text-sm font-bold text-white border border-white/25 hover:bg-white/20 transition-all cursor-pointer"
            >
              <span>{isAr ? 'عرض أسعار الشحن' : 'View Charging Rates'}</span>
              <ChevronDown className="h-4 w-4" />
            </a>
          </div>
        </div>
      </section>

      {/* =====================================================================
          MAIN BODY CONTAINER
          ===================================================================== */}
      <main className="relative z-10 mx-auto max-w-5xl px-4 sm:px-6 pb-20 space-y-16 sm:space-y-24">
        {/* ===================================================================
            SECTION 1: OPERATIONAL STATUS & WORKING HOURS (حالة العمل وأوقات الدوام)
            =================================================================== */}
        <section id="status-section" className="about-card p-6 sm:p-8">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 border-b border-gray-200/60 dark:border-white/10 pb-6">
            <div className="flex items-center gap-4">
              <div
                className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl ${
                  operationalStatus.isOpen
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                }`}
              >
                <span
                  className={
                    operationalStatus.isOpen
                      ? 'status-dot-pulse-green'
                      : 'status-dot-pulse-red'
                  }
                  style={{ width: '16px', height: '16px' }}
                />
              </div>

              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-emerald-800 dark:text-[#88d2c4]">
                    {isAr ? 'حالة نقطة الشحن الآن' : 'Current Operational Status'}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${
                      operationalStatus.isOpen
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300'
                        : 'bg-rose-100 text-rose-800 dark:bg-rose-950/80 dark:text-rose-300'
                    }`}
                  >
                    {operationalStatus.isOpen ? (isAr ? 'نشط' : 'Active') : (isAr ? 'غير نشط' : 'Inactive')}
                  </span>
                </div>

                <h2 className="text-xl sm:text-2xl font-extrabold text-gray-900 dark:text-white mt-1">
                  {isAr ? operationalStatus.headlineAr : operationalStatus.headlineEn}
                </h2>
              </div>
            </div>

            {/* Countdown Badge */}
            <div className="rounded-2xl bg-emerald-50 dark:bg-[#072422] border border-emerald-200/80 dark:border-[#144945] px-5 py-3.5 flex items-center gap-3">
              <Clock className="h-5 w-5 text-emerald-700 dark:text-emerald-400 shrink-0" />
              <div>
                <span className="block text-[11px] font-semibold text-emerald-800 dark:text-emerald-300">
                  {isAr ? 'التوقيت المحلي' : 'Local Business Timing'}
                </span>
                <span className="block text-sm font-bold text-gray-900 dark:text-white">
                  {isAr ? operationalStatus.countdownTextAr : operationalStatus.countdownTextEn}
                </span>
              </div>
            </div>
          </div>

          {/* Comparison Cards: Today vs Tomorrow Hours */}
          <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Today Card */}
            <div className="rounded-2xl border border-gray-200/80 dark:border-white/10 bg-gray-50/70 dark:bg-white/5 p-5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-emerald-800 dark:text-[#88d2c4]">
                  {isAr ? 'دوام اليوم' : "Today's Hours"}
                </span>
                <span className="rounded-md bg-emerald-600/10 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                  {isAr ? 'اليوم' : 'Today'}
                </span>
              </div>
              <div className="text-xl font-mono font-extrabold text-gray-900 dark:text-white pt-1">
                {operationalStatus.todayOpenFormatted} — {operationalStatus.todayCloseFormatted}
              </div>
              <p className="text-xs text-gray-500 dark:text-[#88d2c4]">
                {isAr
                  ? 'يتم استقبال الأجهزة وتسليمها خلال هذه الساعات'
                  : 'Devices are accepted and picked up during these hours'}
              </p>
            </div>

            {/* Tomorrow Card */}
            <div className="rounded-2xl border border-gray-200/80 dark:border-white/10 bg-gray-50/70 dark:bg-white/5 p-5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-teal-800 dark:text-[#88d2c4]">
                  {isAr ? 'دوام الغد' : "Tomorrow's Hours"}
                </span>
                <span className="rounded-md bg-teal-600/10 px-2 py-0.5 text-[10px] font-bold text-teal-700 dark:text-teal-300">
                  {isAr ? 'الغد' : 'Tomorrow'}
                </span>
              </div>
              <div className="text-xl font-mono font-extrabold text-gray-900 dark:text-white pt-1">
                {operationalStatus.tomorrowOpenFormatted} — {operationalStatus.tomorrowCloseFormatted}
              </div>
              <p className="text-xs text-gray-500 dark:text-[#88d2c4]">
                {isAr
                  ? 'تنتقل أوقات الغد تلقائياً عند حلول اليوم التالي'
                  : 'Tomorrow’s schedule rolls over automatically at midnight'}
              </p>
            </div>
          </div>
        </section>

        {/* ===================================================================
            SECTION 2: HOW THE SERVICE WORKS (كيف تعمل نقطة الشحن - 4 خطوات)
            =================================================================== */}
        <section id="workflow-section" className="space-y-8">
          <div className="text-center max-w-xl mx-auto space-y-2">
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-700 dark:text-[#6ee7b7]">
              {isAr ? 'آلية العمل البسيطة' : 'How the Service Works'}
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-gray-900 dark:text-white">
              {isAr ? 'خطوات مريحة وموثوقة من التسليم للاستلام' : 'Simple, Reliable Steps from Handover to Pickup'}
            </h2>
            <p className="text-xs sm:text-sm text-gray-600 dark:text-[#88d2c4]">
              {isAr
                ? 'صممنا عملية الشحن لتكون شفافة وسريعة، وتمنحك راحة البال الكاملة'
                : 'Designed for complete transparency, speed, and peace of mind'}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {[
              {
                step: '01',
                titleAr: 'تسليم الأجهزة',
                titleEn: 'Handover & Safety Check',
                descAr: 'تُفحص الأجهزة وتُسجّل مباشرة في المنظومة',
                descEn: 'Hand your device to our admin; it is inspected and logged into the system.',
                icon: Smartphone,
              },
              {
                step: '02',
                titleAr: 'الشحن الآمن والمستقر',
                titleEn: 'Safe Monitored Charging',
                descAr: 'يتم توصيل الجهاز بمنافذ شحن معتمدة ومحمية ضد التيارات والحرارة الزائدة.',
                descEn: 'Connected to certified charging bays with surge and temperature protection.',
                icon: Zap,
              },
              {
                step: '03',
                titleAr: 'بطاقة ورمز QR',
                titleEn: 'Live QR Status',
                descAr: 'تستلم بطاقة برمز QR لمتابعة نسبة الشحن وحالة الطلب مباشرة من هاتفك أو أي متصفح.',
                descEn: 'Receive a QR card to monitor your battery progress and status from any device.',
                icon: QrCode,
              },
              {
                step: '04',
                titleAr: 'الاستلام والدفع المرن',
                titleEn: 'Pickup & Payment',
                descAr: 'عند اكتمال الشحن، تستلم جهازك وتدفع نقداً أو عبر جوال باي أو بال باي أو بنك فلسطين.',
                descEn: 'Pick up your device and pay by cash or digital wallet (Jawwal Pay, PalPay, BOP).',
                icon: Wallet,
              },
            ].map((st) => {
              const StepIcon = st.icon;
              return (
                <div key={st.step} className="about-card p-6 relative group">
                  <span className="text-3xl font-black text-emerald-600/20 dark:text-emerald-400/20 absolute top-5 end-5 font-mono">
                    {st.step}
                  </span>
                  <div className="h-11 w-11 rounded-2xl bg-emerald-500/10 text-[#0f766e] dark:text-[#6ee7b7] flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                    <StepIcon className="h-5 w-5" />
                  </div>
                  <h3 className="text-base font-bold text-gray-900 dark:text-white mb-2">
                    {isAr ? st.titleAr : st.titleEn}
                  </h3>
                  <p className="text-xs text-gray-600 dark:text-[#88d2c4] leading-relaxed">
                    {isAr ? st.descAr : st.descEn}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        {/* ===================================================================
            SECTION 3: REAL DATABASE CHARGING PRICES (أسعار الشحن)
            =================================================================== */}
        <section id="pricing-section" className="space-y-6">
          <div className="text-center max-w-xl mx-auto space-y-2">
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-700 dark:text-[#6ee7b7]">
              {isAr ? 'الأسعار والرسوم الرسمية' : 'Official Charging Rates'}
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-gray-900 dark:text-white">
              {isAr ? 'أسعار واضحة ومحددة بدون أي مفاجآت' : 'Transparent Rates with Zero Surprises'}
            </h2>
            <p className="text-xs sm:text-sm text-gray-600 dark:text-[#88d2c4]">
              {isAr
                ? 'تُقرأ الأسعار مباشرة من قاعدة بيانات النظام المعتمدة، وتبدأ من ' +
                  formatCurrency(globalMinPrice) +
                  ' وتصل إلى ' +
                  formatCurrency(globalMaxPrice)
                : 'Rates are dynamically synchronized with our verified database, starting from ' +
                  formatCurrency(globalMinPrice) +
                  ' to ' +
                  formatCurrency(globalMaxPrice)}
            </p>
          </div>

          {/* PROMINENT MANDATORY CHARGER FEE NOTICE */}
          <div className="charger-fee-banner p-5 sm:p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-sm">
            <div className="flex items-start sm:items-center gap-3.5">
              <div className="h-10 w-10 rounded-xl bg-amber-500/20 text-amber-700 dark:text-amber-300 flex items-center justify-center shrink-0">
                <Info className="h-5 w-5" />
              </div>
              <div>
                <h4 className="text-sm font-extrabold text-amber-900 dark:text-amber-200">
                  {isAr
                    ? `عند عدم توفر شاحن مع الجهاز تُضاف رسوم ${chargerFeeDisplay}`
                    : `When no charger is provided with the device, a fee of ${chargerFeeDisplay} is added`}
                </h4>
                <p className="text-xs text-amber-800/80 dark:text-amber-300/80 mt-0.5">
                  {isAr
                    ? 'رسوم استخدام شواحن وكابلات النقطة الأصلية عالية القدرة (Type-C / Lightning / Micro-USB).'
                    : 'Applies only when using our certified in-house fast cables and charging adapters.'}
                </p>
              </div>
            </div>

            <span className="self-end sm:self-center font-mono text-xs font-extrabold px-3 py-1 rounded-lg bg-amber-500/20 text-amber-900 dark:text-amber-200 border border-amber-500/30">
              +{chargerFeeDisplay}
            </span>
          </div>

          {/* Price Category Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {pricingSummary.map((cat) => {
              const CatIcon = cat.icon;
              return (
                <div key={cat.id} className="about-card p-6 flex flex-col justify-between space-y-5">
                  <div>
                    <div className="flex items-center justify-between">
                      <div className="h-10 w-10 rounded-2xl bg-emerald-500/10 text-[#0f766e] dark:text-[#6ee7b7] flex items-center justify-center">
                        <CatIcon className="h-5 w-5" />
                      </div>
                      <span className="text-[11px] font-semibold text-gray-500 dark:text-[#88d2c4] bg-gray-100 dark:bg-white/5 px-2.5 py-1 rounded-full">
                        {isAr ? `${cat.count} فئات` : `${cat.count} categories`}
                      </span>
                    </div>

                    <h3 className="text-base font-bold text-gray-900 dark:text-white mt-4">
                      {isAr ? cat.nameAr : cat.nameEn}
                    </h3>
                    <p className="text-xs text-gray-600 dark:text-[#88d2c4] mt-1.5 leading-relaxed">
                      {isAr ? cat.descriptionAr : cat.descriptionEn}
                    </p>
                  </div>

                  <div className="pt-4 border-t border-gray-100 dark:border-white/10 flex items-baseline justify-between">
                    <span className="text-xs text-gray-500 dark:text-[#88d2c4]">
                      {isAr ? 'السعر التقديري:' : 'Estimated Rate:'}
                    </span>
                    <div className="font-mono font-extrabold text-base sm:text-lg text-emerald-800 dark:text-[#6ee7b7]">
                      {formatCurrency(cat.minPrice)}
                      {cat.minPrice !== cat.maxPrice && ` — ${formatCurrency(cat.maxPrice)}`}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ===================================================================
            SECTION 4: PAYMENT METHODS & TRUST
            =================================================================== */}
        <section id="payment-section" className="about-card p-6 sm:p-8 space-y-6">
          <div className="max-w-xl">
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-700 dark:text-[#6ee7b7]">
              {isAr ? 'طرق الدفع والشروط' : 'Payment Methods & Terms'}
            </span>
            <h2 className="text-xl sm:text-2xl font-extrabold text-gray-900 dark:text-white mt-1">
              {isAr ? 'خيارات دفع ميسرة وضمانات أمان كاملة' : 'Flexible Payment Options & Safety Guarantees'}
            </h2>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
            {[
              {
                nameAr: 'نقداً عند الاستلام',
                nameEn: 'Cash on Pickup',
                subAr: 'شيكل أو دولار',
                subEn: 'ILS or USD',
              },
              {
                nameAr: 'جوال باي (Jawwal Pay)',
                nameEn: 'Jawwal Pay',
                subAr: 'تحويل رقمي فوري',
                subEn: 'Instant Wallet',
              },
              {
                nameAr: 'بال باي (PalPay)',
                nameEn: 'PalPay Wallet',
                subAr: 'محفظة إلكترونية',
                subEn: 'Direct Transfer',
              },
              {
                nameAr: 'بنك فلسطين (BOP)',
                nameEn: 'Bank of Palestine',
                subAr: 'تطبيق بنكي مباشر',
                subEn: 'Mobile Banking',
              },
            ].map((p, idx) => (
              <div
                key={idx}
                className="rounded-2xl border border-gray-200/80 dark:border-white/10 bg-gray-50/70 dark:bg-white/5 p-4 text-center space-y-1"
              >
                <div className="h-9 w-9 rounded-xl bg-emerald-500/10 text-[#0f766e] dark:text-[#6ee7b7] flex items-center justify-center mx-auto mb-2">
                  <Wallet className="h-4 w-4" />
                </div>
                <h4 className="text-xs font-bold text-gray-900 dark:text-white">
                  {isAr ? p.nameAr : p.nameEn}
                </h4>
                <p className="text-[10px] text-gray-500 dark:text-[#88d2c4]">
                  {isAr ? p.subAr : p.subEn}
                </p>
              </div>
            ))}
          </div>

          {/* Safety & Custody Commitments */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-gray-200/60 dark:border-white/10 text-xs">
            <div className="flex items-start gap-2.5 text-gray-700 dark:text-[#c5ded8]">
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              <span>
                {isAr
                  ? 'حفظ مادي آمن ومسؤولية كاملة عن الجهاز طوال فترة الشحن'
                  : 'Full physical custody and responsibility throughout the charging period'}
              </span>
            </div>
            <div className="flex items-start gap-2.5 text-gray-700 dark:text-[#c5ded8]">
              <BatteryCharging className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              <span>
                {isAr
                  ? 'حماية إلكترونية ضد الشحن الزائد وارتفاع درجات الحرارة'
                  : 'Overcharge and thermal surge protection on all charging hubs'}
              </span>
            </div>
            <div className="flex items-start gap-2.5 text-gray-700 dark:text-[#c5ded8]">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              <span>
                {isAr
                  ? 'إيصال دفع منظم ومراجعة فورية قبل الاعتماد المالي'
                  : 'Structured receipt verification before final financial clearance'}
              </span>
            </div>
          </div>
        </section>

        {/* ===================================================================
            SECTION 5: FAQ ACCORDION (الأسئلة الشائعة)
            =================================================================== */}
        <section id="faq-section" className="space-y-6">
          <div className="text-center max-w-xl mx-auto space-y-2">
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-700 dark:text-[#6ee7b7]">
              {isAr ? 'إجابات مباشرة' : 'Frequently Asked Questions'}
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-gray-900 dark:text-white">
              {isAr ? 'كل ما تود معرفته عن الخدمة' : 'Everything You Need to Know'}
            </h2>
          </div>

          <div className="space-y-3">
            {faqs.map((faq, index) => {
              const isOpen = activeFaqIndex === index;
              return (
                <div
                  key={index}
                  className="about-card overflow-hidden transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => setActiveFaqIndex(isOpen ? null : index)}
                    className="w-full flex items-center justify-between gap-4 p-5 text-start font-bold text-sm text-gray-900 dark:text-white cursor-pointer"
                  >
                    <span>{isAr ? faq.qAr : faq.qEn}</span>
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400 transition-transform duration-200 ${
                        isOpen ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  {isOpen && (
                    <div className="px-5 pb-5 text-xs sm:text-sm text-gray-600 dark:text-[#a0c5bd] leading-relaxed border-t border-gray-100 dark:border-white/5 pt-3 animate-fade-in">
                      {isAr ? faq.aAr : faq.aEn}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* ===================================================================
            SECTION 6: LOCATION & CONTACT (الموقع والتواصل المباشر)
            =================================================================== */}
        <section id="contact-section" className="about-card p-6 sm:p-8 space-y-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="space-y-2 max-w-md">
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-700 dark:text-[#6ee7b7]">
                {isAr ? 'الموقع والتواصل' : 'Location & Inquiries'}
              </span>
              <h2 className="text-xl sm:text-2xl font-extrabold text-gray-900 dark:text-white">
                {isAr ? 'نحن متواجدون لخدمتكم يومياً' : 'We Are Here to Serve You Daily'}
              </h2>
              <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-[#88d2c4] pt-1">
                <MapPin className="h-4 w-4 text-emerald-600 shrink-0" />
                <span>
                  {isAr
                    ? 'نقطة الشحن، غزة، الفالوجة'
                    : 'Charging Point, Gaza, Al-Faluja'}
                </span>
              </div>
            </div>

            {/* Direct WhatsApp & Call Buttons */}
            <div className="flex flex-wrap items-center gap-3">
              <a
                href="https://wa.me/970592369875"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-3 text-xs font-bold text-white shadow-md hover:bg-emerald-700 transition-colors"
              >
                <MessageCircle className="h-4 w-4" />
                <span>{isAr ? 'تواصل عبر واتساب' : 'WhatsApp Us'}</span>
              </a>

              <a
                href="tel:+970592369875"
                className="inline-flex items-center gap-2 rounded-xl bg-gray-100 dark:bg-white/10 px-5 py-3 text-xs font-bold text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-white/15 transition-colors"
              >
                <Phone className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <span>{isAr ? 'اتصال مباشر' : 'Direct Call'}</span>
              </a>
            </div>
          </div>
        </section>
      </main>

      {/* =====================================================================
          FOOTER
          ===================================================================== */}
      <footer className="border-t border-gray-200/60 dark:border-white/10 bg-white/70 dark:bg-[#051c1b]/80 backdrop-blur-md py-8 px-4 text-center">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-gray-500 dark:text-[#88d2c4]">
          <div className="flex items-center gap-2.5">
            <AppLogo size={20} variant="auto" />
            <span className="font-bold text-gray-800 dark:text-gray-200">
              {isAr ? 'نقطة الشحن' : 'Charging Point'}
            </span>
            <span>·</span>
            <span>{isAr ? 'بوابة العميل العامة' : 'Customer Portal'}</span>
          </div>

          <div>
            {isAr
              ? 'المنظومة مصممة لضمان خصوصيتكم وأمان أجهزتكم.'
              : 'Designed to ensure strict device privacy and battery safety.'}
          </div>
        </div>
      </footer>

      {/* Contact Us dialog: offers the same WhatsApp and phone actions as the homepage. */}
      {isContactModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="contact-dialog-title"
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
          onClick={() => setIsContactModalOpen(false)}
        >
          <div
            className="relative w-full max-w-sm rounded-3xl bg-white dark:bg-[#0d2a29] text-gray-900 dark:text-white p-6 shadow-2xl border border-gray-200 dark:border-white/10 space-y-5"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <h3 id="contact-dialog-title" className="text-lg font-extrabold">
                  {isAr ? 'تواصل معنا' : 'Contact Us'}
                </h3>
                <p className="text-sm text-gray-600 dark:text-[#a4cac2]">
                  {isAr ? 'اختر طريقة التواصل المناسبة لك' : 'Choose how you would like to contact us'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsContactModalOpen(false)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/15"
                aria-label={isAr ? 'إغلاق' : 'Close'}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <a
              href="https://wa.me/970592369875"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setIsContactModalOpen(false)}
              className="w-full flex items-center justify-center gap-3 rounded-xl bg-emerald-600 px-5 py-3.5 text-sm font-bold text-white shadow-md hover:bg-emerald-700 transition-colors"
            >
              <MessageCircle className="h-5 w-5" />
              <span>{isAr ? 'التواصل عبر واتساب' : 'Contact via WhatsApp'}</span>
            </a>
            <a
              href="tel:+970592369875"
              onClick={() => setIsContactModalOpen(false)}
              className="w-full flex items-center justify-center gap-3 rounded-xl bg-gray-100 dark:bg-white/10 px-5 py-3.5 text-sm font-bold text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-white/15 transition-colors"
            >
              <Phone className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              <span>{isAr ? 'اتصال مباشر' : 'Direct Call'}</span>
            </a>
          </div>
        </div>
      )}

      {/* QR Scanner Modal (Camera & File upload) */}
      <QrScannerModal
        isOpen={isQrModalOpen}
        onClose={() => setIsQrModalOpen(false)}
      />


    </div>
  );
};
