import React, { useState, useRef, useEffect } from "react";
import { useI18n } from "../../i18n/i18nContext";
import { useTheme } from "../../theme/themeContext";
import { AppLogo } from "../qr/AppLogo";
import { BackupDataManagement } from "../settings/BackupDataManagement";
import { SyncCenter } from "../settings/SyncCenter";
import { PWASettingsCard } from "../settings/PWASettingsCard";
import { authService, UserSession } from "../../services/auth/authService";
import {
  getSavedLogos,
  getActiveLogo,
  saveLogoSet,
  saveCustomLogo,
  updateLogoItem,
  setActiveLogo,
  deleteCustomLogo,
  useActiveLogo,
  isLogoComplete,
  optimizeLogoFile,
  AppLogoItem,
} from "../../services/storage/logoStorage";
import { Button } from "../ui/Button";
import {
  Sun,
  Moon,
  Laptop,
  Languages,
  QrCode,
  User,
  Info,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  Smartphone,
  Palette,
  Globe,
  KeyRound,
  Plus,
  Upload,
  Camera,
  Check,
  Trash2,
  Lock,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  ListOrdered,
} from "lucide-react";

export interface SettingsPageProps {
  onNavigate?: (path: string) => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ onNavigate }) => {
  const { t, locale, setLocale, isRTL } = useI18n();
  const { theme, setTheme } = useTheme();

  const [session, setSession] = useState<UserSession | null>(null);
  useEffect(() => {
    let isMounted = true;
    authService.getCurrentSession().then((s) => {
      if (isMounted) setSession(s);
    });
    return () => {
      isMounted = false;
    };
  }, []);

  const isSuperAdmin = session?.role === "SUPER_ADMIN";
  const hasPermission = (perm: string) => {
    return isSuperAdmin || (session?.permissions?.includes(perm as any) ?? false);
  };

  // -------------------------------------------------------------
  // PART 1: SECURE 2-STEP CHANGE BIN FLOW
  // -------------------------------------------------------------
  type BinStep = "IDLE" | "VERIFY" | "NEW_BIN";
  const [binStep, setBinStep] = useState<BinStep>("IDLE");
  const [usernameInput, setUsernameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [newBin, setNewBin] = useState("");
  const [confirmBin, setConfirmBin] = useState("");
  const [isBinLoading, setIsBinLoading] = useState(false);
  const [binError, setBinError] = useState<string | null>(null);
  const [binSuccess, setBinSuccess] = useState<string | null>(null);
  const [verifiedToken, setVerifiedToken] = useState<string | undefined>(undefined);

  const handleStartChangeBin = () => {
    setBinError(null);
    setBinSuccess(null);
    setUsernameInput("");
    setPasswordInput("");
    setNewBin("");
    setConfirmBin("");
    setVerifiedToken(undefined);
    setBinStep("VERIFY");
  };

  const handleCancelChangeBin = () => {
    setBinError(null);
    setUsernameInput("");
    setPasswordInput("");
    setNewBin("");
    setConfirmBin("");
    setVerifiedToken(undefined);
    setBinStep("IDLE");
  };

  // STEP 1: Server-Authoritative Identity Verification
  const handleVerifyIdentity = async (e: React.FormEvent) => {
    e.preventDefault();
    setBinError(null);
    const cleanUser = usernameInput.trim();
    const cleanPass = passwordInput;

    if (!cleanUser || !cleanPass) {
      setBinError(
        locale === "ar"
          ? "يرجى إدخال اسم المستخدم وكلمة مرور الحساب"
          : "Please enter username and account password"
      );
      return;
    }

    setIsBinLoading(true);
    try {
      const res = await authService.verifyCurrentPassword(cleanUser, cleanPass);
      if (res.success) {
        setVerifiedToken(res.token);
        setPasswordInput(""); // Clear sensitive password immediately from memory
        setBinStep("NEW_BIN");
        setBinError(null);
      } else {
        setBinError(
          res.error ||
            (locale === "ar"
              ? "تعذر التحقق من بيانات الحساب."
              : "Unable to verify account credentials.")
        );
      }
    } catch (err: any) {
      setBinError(
        locale === "ar"
          ? "تعذر التحقق من بيانات الحساب."
          : "Unable to verify account credentials."
      );
    } finally {
      setIsBinLoading(false);
    }
  };

  // STEP 2: Save New BIN
  const handleSaveNewBin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBinError(null);
    setBinSuccess(null);
    const cleanBin = newBin.trim();
    const cleanConfirm = confirmBin.trim();

    if (!cleanBin || !/^\d{4,}$/.test(cleanBin)) {
      setBinError(
        locale === "ar"
          ? "رمز الأمان (BIN) يجب أن يتكون من 4 أرقام على الأقل"
          : "Security BIN code must be at least 4 numeric digits"
      );
      return;
    }

    if (cleanBin !== cleanConfirm) {
      setBinError(
        locale === "ar"
          ? "تأكيد رمز الأمان غير متطابق"
          : "Security BIN confirmation does not match"
      );
      return;
    }

    setIsBinLoading(true);
    try {
      const res = await authService.changeAdminBin(cleanBin, verifiedToken);
      if (res.success) {
        setNewBin("");
        setConfirmBin("");
        setVerifiedToken(undefined);
        setBinStep("IDLE");
        setBinSuccess(
          locale === "ar"
            ? "تم تحديث BIN بنجاح."
            : "Security BIN updated successfully."
        );
      } else {
        setBinError(
          res.error ||
            (locale === "ar"
              ? "فشل تحديث رمز الأمان"
              : "Failed to update security BIN")
        );
      }
    } catch (err: any) {
      setBinError(
        err?.message ||
          (locale === "ar" ? "خطأ في الاتصال" : "Connection error")
      );
    } finally {
      setIsBinLoading(false);
    }
  };

  // -------------------------------------------------------------
  // PART 3: APPLICATION LOGO MANAGEMENT (Canonical White Logo & Dark Logo)
  // -------------------------------------------------------------
  const activeLogo = useActiveLogo();
  const [isAddingLogo, setIsAddingLogo] = useState(false);
  const [editingLogoId, setEditingLogoId] = useState<string | null>(null);
  const [logoNameInput, setLogoNameInput] = useState("");
  const [newWhiteDataUrl, setNewWhiteDataUrl] = useState<string | null>(null);
  const [newDarkDataUrl, setNewDarkDataUrl] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoSuccess, setLogoSuccess] = useState<string | null>(null);

  const fileInputWhiteRef = useRef<HTMLInputElement>(null);
  const fileInputDarkRef = useRef<HTMLInputElement>(null);
  const fileInputCameraWhiteRef = useRef<HTMLInputElement>(null);
  const fileInputCameraDarkRef = useRef<HTMLInputElement>(null);

  const [isProcessingFile, setIsProcessingFile] = useState(false);

  const handleProcessLogoFile = async (file: File, target: 'white' | 'dark') => {
    setLogoError(null);
    setLogoSuccess(null);

    // Validate MIME type
    const validTypes = ["image/png", "image/jpeg", "image/jpg", "image/svg+xml", "image/webp"];
    if (!validTypes.includes(file.type)) {
      setLogoError(
        locale === "ar"
          ? "يرجى اختيار ملف صورة صالح (PNG, JPEG, SVG, WebP)"
          : "Please select a valid image file (PNG, JPEG, SVG, WebP)"
      );
      return;
    }

    // Validate size (support up to 10MB since optimizer compresses down to crisp ~30-50KB)
    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      setLogoError(
        locale === "ar"
          ? "حجم الصورة كبير جداً، الحد الأقصى 10 ميجابايت"
          : "Image size is too large (maximum 10MB)"
      );
      return;
    }

    setIsProcessingFile(true);
    try {
      // Optimize image resolution and file size while preserving transparency and authentic ratio
      const optimizedDataUrl = await optimizeLogoFile(file, 512);
      if (!optimizedDataUrl) {
        throw new Error("Empty image payload");
      }

      if (target === 'white') {
        setNewWhiteDataUrl(optimizedDataUrl);
      } else {
        setNewDarkDataUrl(optimizedDataUrl);
      }
    } catch (err) {
      console.error("[SETTINGS] Error optimizing logo file", err);
      setLogoError(
        locale === "ar" ? "حدث خطأ أثناء معالجة ملف الصورة" : "Error processing image file"
      );
    } finally {
      setIsProcessingFile(false);
    }
  };

  const handleSaveLogoSet = () => {
    setLogoError(null);
    setLogoSuccess(null);

    if (!newWhiteDataUrl || !newDarkDataUrl) {
      setLogoError(
        locale === "ar"
          ? "يجب رفع نسختي الشعار معاً (الشعار الأبيض والشعار الداكن) لتفعيل هوية الشعار."
          : "Both White and Dark logo versions are required to activate this brand identity."
      );
      return;
    }

    const name = logoNameInput.trim() || (locale === "ar" ? "شعار مخصص" : "Custom Brand Logo");

    try {
      if (editingLogoId) {
        updateLogoItem(editingLogoId, {
          name,
          whiteDataUrl: newWhiteDataUrl,
          darkDataUrl: newDarkDataUrl,
        });
        setLogoSuccess(
          locale === "ar"
            ? "تم تحديث وتفعيل هوية الشعار بنجاح (الشعار الأبيض والشعار الداكن)"
            : "Brand logo identity updated and activated successfully (White & Dark)"
        );
      } else {
        saveLogoSet({
          name,
          whiteDataUrl: newWhiteDataUrl,
          darkDataUrl: newDarkDataUrl,
        });
        setLogoSuccess(
          locale === "ar"
            ? "تمت إضافة وتفعيل هوية الشعار بنجاح (الشعار الأبيض والشعار الداكن)"
            : "New brand logo identity added and activated successfully"
        );
      }

      setIsAddingLogo(false);
      setEditingLogoId(null);
      setLogoNameInput("");
      setNewWhiteDataUrl(null);
      setNewDarkDataUrl(null);
    } catch (err: any) {
      console.error("[SETTINGS] Failed to save logo set:", err);
      setLogoError(
        locale === "ar"
          ? "حدث خطأ أثناء حفظ الشعار، يرجى المحاولة مرة أخرى"
          : "Failed to save logo identity, please try again"
      );
    }
  };

  const handleStartAddLogo = () => {
    setLogoError(null);
    setLogoSuccess(null);
    setEditingLogoId(null);
    setLogoNameInput("");
    setNewWhiteDataUrl(null);
    setNewDarkDataUrl(null);
    setIsAddingLogo(true);
  };

  const handleStartCompleteLegacy = (item: AppLogoItem) => {
    setLogoError(null);
    setLogoSuccess(null);
    setEditingLogoId(item.id);
    setLogoNameInput(item.name);
    setNewWhiteDataUrl(item.whiteDataUrl || item.lightDataUrl || item.dataUrl || null);
    setNewDarkDataUrl(item.darkDataUrl || null);
    setIsAddingLogo(true);
  };

  const handleSelectLogo = (id: string) => {
    setLogoError(null);
    setLogoSuccess(null);
    const success = setActiveLogo(id);
    if (success) {
      setLogoSuccess(
        locale === "ar"
          ? "تم تفعيل هوية الشعار بنجاح"
          : "Active brand logo updated successfully"
      );
    } else {
      setLogoError(
        locale === "ar"
          ? "لا يمكن تفعيل هذا الشعار لأنه غير مكتمل. يرجى رفع نسختي الشعار الأبيض والداكن."
          : "Cannot activate incomplete logo set. Both White and Dark versions are required."
      );
    }
  };

  const handleDeleteLogo = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setLogoError(null);
    setLogoSuccess(null);
    const success = deleteCustomLogo(id);
    if (success) {
      setLogoSuccess(
        locale === "ar" ? "تم حذف الشعار بنجاح" : "Logo deleted successfully"
      );
    }
  };

  const savedLogosList = getSavedLogos();

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-24 px-4 sm:px-6">
      {/* 1. Header Bar: Native Official Settings Header */}
      <div className="pt-2 pb-1 border-b border-gray-200/80 dark:border-[#123832]">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-[#daf1de]">
          {t("settingsTitle")}
        </h1>
        <p className="text-xs text-gray-500 dark:text-[#8eb698] mt-1">
          {t("settingsHeaderSubtitle")}
        </p>
      </div>

      {/* 2. System Settings Groups */}
      <div className="space-y-6">
        {/* GROUP 1: General Preferences (التفضيلات العامة) */}
        <section className="pb-6 border-b border-gray-200/80 dark:border-[#123832] space-y-3">
          <div className="px-0.5 text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-[#8eb698]">
            {locale === "ar" ? "التفضيلات العامة" : "General Preferences"}
          </div>
          <div className="divide-y divide-gray-100 dark:divide-[#0f302b]">
            {/* Row 1: Appearance / Theme */}
            <div className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 min-h-[52px]">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-gray-100 dark:bg-[#0c312b] flex items-center justify-center text-gray-700 dark:text-[#8eb698] shrink-0 border border-transparent dark:border-[#14423b]">
                  <Palette className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />
                </div>
                <div>
                  <span className="text-sm font-semibold text-gray-900 dark:text-[#daf1de] block">
                    {t("appearanceSectionTitle")}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-[#8eb698]">
                    {t("appearanceSectionDesc")}
                  </span>
                </div>
              </div>
              {/* Segmented Theme Picker */}
              <div className="flex items-center bg-gray-100/90 dark:bg-[#041714] p-1 rounded-xl border border-gray-200/60 dark:border-[#123832] self-start sm:self-auto shrink-0">
                <button
                  type="button"
                  onClick={() => setTheme("light")}
                  className={`py-1.5 px-3 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer ${
                    theme === "light"
                      ? "bg-white dark:bg-[#0c312b] text-gray-900 dark:text-[#daf1de] shadow-xs font-semibold"
                      : "text-gray-600 dark:text-[#8eb698] hover:text-gray-900 dark:hover:text-[#daf1de]"
                  }`}
                  aria-pressed={theme === "light"}
                >
                  <Sun className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  <span>{t("themeLight")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setTheme("dark")}
                  className={`py-1.5 px-3 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer ${
                    theme === "dark"
                      ? "bg-white dark:bg-[#0c312b] text-gray-900 dark:text-[#daf1de] shadow-xs font-semibold"
                      : "text-gray-600 dark:text-[#8eb698] hover:text-gray-900 dark:hover:text-[#daf1de]"
                  }`}
                  aria-pressed={theme === "dark"}
                >
                  <Moon className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  <span>{t("themeDark")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setTheme("system")}
                  className={`py-1.5 px-3 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer ${
                    theme === "system"
                      ? "bg-white dark:bg-[#0c312b] text-gray-900 dark:text-[#daf1de] shadow-xs font-semibold"
                      : "text-gray-600 dark:text-[#8eb698] hover:text-gray-900 dark:hover:text-[#daf1de]"
                  }`}
                  aria-pressed={theme === "system"}
                >
                  <Laptop className="w-3.5 h-3.5 text-gray-500 dark:text-[#8eb698] shrink-0" />
                  <span>{t("themeSystem")}</span>
                </button>
              </div>
            </div>

            {/* Row 2: Language */}
            <div className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 min-h-[52px]">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-gray-100 dark:bg-[#0c312b] flex items-center justify-center text-gray-700 dark:text-[#8eb698] shrink-0 border border-transparent dark:border-[#14423b]">
                  <Globe className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />
                </div>
                <div>
                  <span className="text-sm font-semibold text-gray-900 dark:text-[#daf1de] block">
                    {t("languageSectionTitle")}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-[#8eb698]">
                    {t("languageSectionDesc")}
                  </span>
                </div>
              </div>
              {/* Segmented Language Picker */}
              <div className="flex items-center bg-gray-100/90 dark:bg-[#041714] p-1 rounded-xl border border-gray-200/60 dark:border-[#123832] self-start sm:self-auto shrink-0">
                <button
                  type="button"
                  onClick={() => setLocale("ar")}
                  className={`py-1.5 px-3.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer ${
                    locale === "ar"
                      ? "bg-white dark:bg-[#0c312b] text-gray-900 dark:text-[#daf1de] shadow-xs font-semibold"
                      : "text-gray-600 dark:text-[#8eb698] hover:text-gray-900 dark:hover:text-[#daf1de]"
                  }`}
                  aria-pressed={locale === "ar"}
                >
                  <Languages className="w-3.5 h-3.5 shrink-0" />
                  <span>{t("langArabic")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setLocale("en")}
                  className={`py-1.5 px-3.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer ${
                    locale === "en"
                      ? "bg-white dark:bg-[#0c312b] text-gray-900 dark:text-[#daf1de] shadow-xs font-semibold"
                      : "text-gray-600 dark:text-[#8eb698] hover:text-gray-900 dark:hover:text-[#daf1de]"
                  }`}
                  aria-pressed={locale === "en"}
                >
                  <Languages className="w-3.5 h-3.5 shrink-0" />
                  <span>{t("langEnglish")}</span>
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* GROUP 2: Application Identity & Brand (هوية وشعار التطبيق) */}
        {hasPermission("settings:manage") && (
          <section className="pb-6 border-b border-gray-200/80 dark:border-[#123832] space-y-4">
            <div className="px-0.5 text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-[#8eb698]">
              {locale === "ar" ? "هوية وشعار التطبيق" : "Brand & Application Identity"}
            </div>
            
            {/* PART 3: Logo Management Area */}
            <div className="space-y-4">
              {/* Header with Active Logo Dual Previews & Add Button */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex flex-col sm:flex-row sm:items-center gap-3.5 min-w-0">
                  {/* Dual Previews for Active Logo */}
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="flex flex-col items-center justify-center p-2 rounded-xl bg-white border border-gray-200/90 shadow-2xs min-w-[96px] text-center">
                      <span className="text-[9px] font-semibold text-gray-500 mb-1 block">
                        {locale === "ar" ? "الشعار الأبيض (White)" : "White Logo (Light & QR)"}
                      </span>
                      <div className="h-9 flex items-center justify-center">
                        <AppLogo size={32} customUrl={activeLogo.whiteDataUrl || activeLogo.dataUrl} variant="white" />
                      </div>
                    </div>

                    <div className="flex flex-col items-center justify-center p-2 rounded-xl bg-neutral-900 border border-neutral-800 shadow-2xs min-w-[96px] text-center">
                      <span className="text-[9px] font-semibold text-neutral-400 mb-1 block">
                        {locale === "ar" ? "الشعار الداكن (Dark)" : "Dark Logo"}
                      </span>
                      <div className="h-9 flex items-center justify-center">
                        <AppLogo size={32} customUrl={activeLogo.darkDataUrl || activeLogo.dataUrl} variant="dark" />
                      </div>
                    </div>
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-gray-900 dark:text-[#daf1de] truncate">
                        {t("logoManagementTitle") || (locale === "ar" ? "شعار التطبيق" : "Application Logo")}
                      </span>
                      <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-emerald-50 dark:bg-[#0c312b] text-emerald-700 dark:text-[#8eb698] border border-emerald-200 dark:border-[#14423b] shrink-0">
                        {activeLogo.isDefault
                          ? (locale === "ar" ? "الافتراضي" : "Default")
                          : (locale === "ar" ? "شعار مخصص (White + Dark)" : "Custom Brand Logo")}
                      </span>
                    </div>
                    <span className="text-xs text-gray-500 dark:text-[#8eb698] block truncate mt-0.5">
                      {activeLogo.name || (locale === "ar" ? "الشعار الافتراضي" : "Default Logo")}
                    </span>
                  </div>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleStartAddLogo}
                  className="text-xs h-8 px-3 gap-1.5 font-semibold text-emerald-700 dark:text-[#daf1de] border-emerald-200 dark:border-emerald-800/50 hover:bg-emerald-50 dark:hover:bg-[#0c312b] cursor-pointer self-start sm:self-auto shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{t("addLogo") || (locale === "ar" ? "إضافة شعار" : "Add Logo")}</span>
                </Button>
              </div>

              {/* Status Alerts */}
              {logoError && (
                <div className="p-2.5 rounded-xl bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-xs font-medium border border-red-200 dark:border-red-900 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{logoError}</span>
                </div>
              )}
              {logoSuccess && (
                <div className="p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 text-xs font-medium border border-emerald-200 dark:border-emerald-900 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{logoSuccess}</span>
                </div>
              )}

              {/* Add/Edit Logo Options Area (Dual White & Dark Upload) */}
              {isAddingLogo && (
                <div className="p-3.5 sm:p-4 rounded-xl bg-gray-50 dark:bg-[#041714] border border-gray-200 dark:border-[#123832] space-y-3.5">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-bold text-gray-900 dark:text-[#daf1de] block">
                        {editingLogoId
                          ? (locale === "ar" ? "إكمال هوية الشعار (White + Dark)" : "Complete Logo Identity")
                          : (locale === "ar" ? "إضافة هوية شعار جديدة (الشعار الأبيض والداكن)" : "Add Brand Logo (White & Dark)")}
                      </span>
                      <span className="text-[11px] text-gray-500 dark:text-[#8eb698] mt-0.5 block">
                        {locale === "ar"
                          ? "يتطلب النظام رفع نسختين: الشعار الأبيض (للوضع الفاتح وجميع رموز QR) والشعار الداكن (للوضع الداكن)."
                          : "Both White Logo (for Light theme & QR) and Dark Logo (for Dark theme) are required."}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setIsAddingLogo(false);
                        setEditingLogoId(null);
                      }}
                      className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer shrink-0"
                    >
                      {locale === "ar" ? "إغلاق" : "Close"}
                    </button>
                  </div>

                  <div>
                    <input
                      type="text"
                      value={logoNameInput}
                      onChange={(e) => setLogoNameInput(e.target.value)}
                      placeholder={locale === "ar" ? "اسم الشعار (مثال: شعار المتجر الرئيسي)" : "Logo name (e.g. Main Store Logo)"}
                      className="w-full px-3 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-[#123832] bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
                    />
                  </div>

                  {/* Dual Upload Cards: 1. White Logo, 2. Dark Logo */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* 1. White Logo Card */}
                    <div className="p-3 rounded-xl bg-white dark:bg-[#06201c] border border-gray-200/90 dark:border-[#14423b] space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-gray-900 dark:text-[#daf1de]">
                          {locale === "ar" ? "1. الشعار الأبيض (White Logo)" : "1. White Logo"}
                        </span>
                        <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                          {locale === "ar" ? "مطلوب" : "Required"}
                        </span>
                      </div>
                      <p className="text-[10px] text-gray-500 dark:text-[#8eb698] leading-tight">
                        {locale === "ar" ? "يستخدم في الوضع الفاتح وجميع رموز QR." : "Used for Light Theme and all QR codes."}
                      </p>

                      {newWhiteDataUrl ? (
                        <div className="p-2.5 rounded-lg bg-gray-50 border border-gray-200 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className="w-12 h-12 rounded-lg bg-white border border-gray-200/80 flex items-center justify-center shrink-0">
                              <AppLogo size={36} customUrl={newWhiteDataUrl} variant="white" />
                            </div>
                            <div className="min-w-0">
                              <span className="text-[11px] font-bold text-emerald-700 block truncate">
                                {locale === "ar" ? "✓ تم رفع الشعار الأبيض" : "✓ White Ready"}
                              </span>
                              <span className="text-[9px] text-gray-400 block">
                                {locale === "ar" ? "معاينة الوضع الفاتح و QR" : "Light & QR preview"}
                              </span>
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => fileInputWhiteRef.current?.click()}
                            className="text-[10px] h-7 px-2 shrink-0"
                          >
                            {locale === "ar" ? "تغيير" : "Change"}
                          </Button>
                        </div>
                      ) : (
                        <div className="space-y-1.5 pt-1">
                          <div className="grid grid-cols-2 gap-1.5">
                            <input
                              ref={fileInputWhiteRef}
                              type="file"
                              accept="image/png,image/jpeg,image/jpg,image/svg+xml,image/webp"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handleProcessLogoFile(file, 'white');
                                e.target.value = "";
                              }}
                              className="hidden"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => fileInputWhiteRef.current?.click()}
                              className="h-8 px-2 gap-1 text-[11px] font-medium border-gray-200 dark:border-[#14423b] hover:bg-gray-100 dark:hover:bg-[#0c312b] cursor-pointer justify-center"
                            >
                              <Upload className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                              <span>{locale === "ar" ? "رفع ملف" : "Upload"}</span>
                            </Button>

                            <input
                              ref={fileInputCameraWhiteRef}
                              type="file"
                              accept="image/*"
                              capture="environment"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handleProcessLogoFile(file, 'white');
                                e.target.value = "";
                              }}
                              className="hidden"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => fileInputCameraWhiteRef.current?.click()}
                              className="h-8 px-2 gap-1 text-[11px] font-medium border-gray-200 dark:border-[#14423b] hover:bg-gray-100 dark:hover:bg-[#0c312b] cursor-pointer justify-center"
                            >
                              <Camera className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                              <span>{locale === "ar" ? "كاميرا" : "Camera"}</span>
                            </Button>
                          </div>
                          <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium block">
                            {locale === "ar" ? "⚠️ الشعار الأبيض ناقص" : "⚠️ White Logo Missing"}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* 2. Dark Logo Card */}
                    <div className="p-3 rounded-xl bg-white dark:bg-[#06201c] border border-gray-200/90 dark:border-[#14423b] space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-gray-900 dark:text-[#daf1de]">
                          {locale === "ar" ? "2. الشعار الداكن (Dark Logo)" : "2. Dark Logo"}
                        </span>
                        <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                          {locale === "ar" ? "مطلوب" : "Required"}
                        </span>
                      </div>
                      <p className="text-[10px] text-gray-500 dark:text-[#8eb698] leading-tight">
                        {locale === "ar" ? "يستخدم في الوضع الداكن." : "Used for Dark Theme."}
                      </p>

                      {newDarkDataUrl ? (
                        <div className="p-2.5 rounded-lg bg-neutral-900 border border-neutral-800 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className="w-12 h-12 rounded-lg bg-neutral-950 border border-neutral-800 flex items-center justify-center shrink-0">
                              <AppLogo size={36} customUrl={newDarkDataUrl} variant="dark" />
                            </div>
                            <div className="min-w-0">
                              <span className="text-[11px] font-bold text-emerald-400 block truncate">
                                {locale === "ar" ? "✓ تم رفع الشعار الداكن" : "✓ Dark Ready"}
                              </span>
                              <span className="text-[9px] text-neutral-400 block">
                                {locale === "ar" ? "معاينة على خلفية داكنة" : "Dark preview"}
                              </span>
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => fileInputDarkRef.current?.click()}
                            className="text-[10px] h-7 px-2 shrink-0 text-neutral-200 border-neutral-700 hover:bg-neutral-800"
                          >
                            {locale === "ar" ? "تغيير" : "Change"}
                          </Button>
                        </div>
                      ) : (
                        <div className="space-y-1.5 pt-1">
                          <div className="grid grid-cols-2 gap-1.5">
                            <input
                              ref={fileInputDarkRef}
                              type="file"
                              accept="image/png,image/jpeg,image/jpg,image/svg+xml,image/webp"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handleProcessLogoFile(file, 'dark');
                                e.target.value = "";
                              }}
                              className="hidden"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => fileInputDarkRef.current?.click()}
                              className="h-8 px-2 gap-1 text-[11px] font-medium border-gray-200 dark:border-[#14423b] hover:bg-gray-100 dark:hover:bg-[#0c312b] cursor-pointer justify-center"
                            >
                              <Upload className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                              <span>{locale === "ar" ? "رفع ملف" : "Upload"}</span>
                            </Button>

                            <input
                              ref={fileInputCameraDarkRef}
                              type="file"
                              accept="image/*"
                              capture="environment"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handleProcessLogoFile(file, 'dark');
                                e.target.value = "";
                              }}
                              className="hidden"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => fileInputCameraDarkRef.current?.click()}
                              className="h-8 px-2 gap-1 text-[11px] font-medium border-gray-200 dark:border-[#14423b] hover:bg-gray-100 dark:hover:bg-[#0c312b] cursor-pointer justify-center"
                            >
                              <Camera className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                              <span>{locale === "ar" ? "كاميرا" : "Camera"}</span>
                            </Button>
                          </div>
                          <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium block">
                            {locale === "ar" ? "⚠️ الشعار الداكن ناقص" : "⚠️ Dark Logo Missing"}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Dual Readiness Check Banner */}
                  {newWhiteDataUrl && newDarkDataUrl ? (
                    <div className="p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 text-xs font-semibold flex items-center gap-2 border border-emerald-200 dark:border-emerald-800">
                      <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
                      <span>{locale === "ar" ? "الشعار الأبيض والشعار الداكن جاهزان للحفظ والتفعيل." : "Both White & Dark versions are ready for activation."}</span>
                    </div>
                  ) : (
                    <div className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 text-xs font-medium flex items-center gap-2 border border-amber-200 dark:border-amber-800">
                      <AlertCircle className="w-4 h-4 shrink-0 text-amber-600" />
                      <span>
                        {!newWhiteDataUrl && (locale === "ar" ? "الشعار الأبيض ناقص. " : "White logo missing. ")}
                        {!newDarkDataUrl && (locale === "ar" ? "الشعار الداكن ناقص. " : "Dark logo missing. ")}
                        {locale === "ar" ? "لا يمكن الحفظ إلا برفع النسختين معاً." : "Both versions are strictly required."}
                      </span>
                    </div>
                  )}

                  {/* Action Buttons */}
                  <div className="flex items-center justify-end gap-2 pt-1 border-t border-gray-200/80 dark:border-[#123832]">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setIsAddingLogo(false);
                        setEditingLogoId(null);
                      }}
                      className="text-xs h-8 px-3"
                    >
                      {locale === "ar" ? "إلغاء" : "Cancel"}
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={handleSaveLogoSet}
                      disabled={!newWhiteDataUrl || !newDarkDataUrl}
                      className="text-xs h-8 px-4 font-semibold"
                    >
                      <span>{t("saveAndActivateLogo") || (locale === "ar" ? "حفظ وتفعيل الشعار" : "Save & Activate")}</span>
                    </Button>
                  </div>
                </div>
              )}

              {/* Logo List */}
              <div className="space-y-2 pt-1">
                <span className="text-xs font-semibold text-gray-700 dark:text-[#8eb698] block">
                  {locale === "ar" ? "قائمة هويات الشعارات المتاحة" : "Available Brand Logo Sets"}
                </span>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {savedLogosList.map((item) => {
                    const isActive = item.id === activeLogo.id;
                    const complete = isLogoComplete(item);

                    return (
                      <div
                        key={item.id}
                        className={`p-3 rounded-xl border flex items-center justify-between gap-3 transition-all ${
                          isActive
                            ? "bg-emerald-50/60 dark:bg-[#0c312b]/60 border-emerald-300 dark:border-emerald-700/60 shadow-xs"
                            : "bg-gray-50/50 dark:bg-[#041714] border-gray-200/80 dark:border-[#123832]"
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {/* Dual Swatches */}
                          <div className="flex items-center gap-1.5 shrink-0">
                            <div className="w-10 h-10 p-1 rounded-lg bg-white border border-gray-200/90 shadow-2xs flex items-center justify-center shrink-0" title="Light Theme Preview">
                              <AppLogo size={28} customUrl={item.lightDataUrl || item.dataUrl} variant="light" />
                            </div>
                            <div className="w-10 h-10 p-1 rounded-lg bg-neutral-900 border border-neutral-800 shadow-2xs flex items-center justify-center shrink-0" title="Dark Theme Preview">
                              <AppLogo size={28} customUrl={item.darkDataUrl || item.dataUrl} variant="dark" />
                            </div>
                          </div>

                          <div className="min-w-0">
                            <span className="text-xs font-semibold text-gray-900 dark:text-[#daf1de] block truncate">
                              {item.name}
                            </span>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              {item.isDefault ? (
                                <span className="text-[10px] text-gray-500 dark:text-[#8eb698]">
                                  {locale === "ar" ? "شعار النظام الأساسي" : "System Default"}
                                </span>
                              ) : complete ? (
                                <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
                                  {locale === "ar" ? "مكتمل (Light + Dark)" : "Complete (Light + Dark)"}
                                </span>
                              ) : (
                                <span className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold flex items-center gap-1">
                                  <span>{locale === "ar" ? "غير مكتمل (ناقص)" : "Incomplete (Missing)"}</span>
                                  <span className="text-[9px] opacity-80">
                                    {!item.lightDataUrl ? "(Light ناقص)" : "(Dark ناقص)"}
                                  </span>
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {isActive ? (
                            <span className="px-2.5 py-1 text-[11px] font-bold rounded-lg bg-emerald-600 text-white flex items-center gap-1">
                              <Check className="w-3 h-3" />
                              <span>{t("currentLogoBadge") || (locale === "ar" ? "الحالي" : "Active")}</span>
                            </span>
                          ) : complete ? (
                            <button
                              type="button"
                              onClick={() => handleSelectLogo(item.id)}
                              className="px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-white dark:bg-[#061f1c] hover:bg-emerald-50 dark:hover:bg-[#0c312b] text-gray-700 hover:text-emerald-700 dark:text-[#daf1de] border border-gray-200 dark:border-[#14423b] transition-colors cursor-pointer"
                            >
                              {t("useThisLogo") || (locale === "ar" ? "استخدام" : "Use")}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleStartCompleteLegacy(item)}
                              className="px-2 py-1 text-[11px] font-semibold rounded-lg bg-amber-50 dark:bg-amber-950/50 hover:bg-amber-100 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800 transition-colors cursor-pointer"
                              title={locale === "ar" ? "رفع النسخة الناقصة لتفعيل الهوية" : "Upload missing version to activate"}
                            >
                              {locale === "ar" ? "إكمال النسخ" : "Complete Set"}
                            </button>
                          )}

                          {!item.isDefault && !isActive && (
                            <button
                              type="button"
                              onClick={(e) => handleDeleteLogo(item.id, e)}
                              className="p-1 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer"
                              title={locale === "ar" ? "حذف الشعار" : "Delete Logo"}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Row 2: QR Design */}
            <div className="pt-2">
              <button
                type="button"
                onClick={() => onNavigate?.("/app/settings/qr")}
                className="w-full py-3 px-1 flex items-center justify-between gap-3 text-start hover:bg-gray-50/60 dark:hover:bg-[#0b2924]/50 rounded-xl transition-colors cursor-pointer group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-gray-100 dark:bg-[#0c312b] flex items-center justify-center text-gray-700 dark:text-[#8eb698] shrink-0 border border-transparent dark:border-[#14423b]">
                    <QrCode className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />
                  </div>
                  <div>
                    <span className="text-sm font-semibold text-gray-900 dark:text-[#daf1de] block">
                      {t("qrDesignSectionTitle")}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-[#8eb698]">
                      {t("qrDesignSectionDesc")}
                    </span>
                  </div>
                </div>
                <div className="flex items-center text-gray-400 group-hover:text-emerald-600 dark:group-hover:text-[#daf1de] transition-colors">
                  {isRTL ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </div>
              </button>
            </div>
          </section>
        )}

        {/* GROUP 2B: Device Types Management (إدارة أنواع الأجهزة) */}
        {hasPermission("devices:manage") && (
          <section className="pb-6 border-b border-gray-200/80 dark:border-[#123832] space-y-3">
            <div className="px-0.5 text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-[#8eb698]">
              {locale === "ar" ? "إدارة الأجهزة" : "Device Types Management"}
            </div>
            <div>
              <button
                type="button"
                onClick={() => onNavigate?.("/app/settings/device-types")}
                className="w-full py-3 px-1 flex items-center justify-between gap-3 text-start hover:bg-gray-50/60 dark:hover:bg-[#0b2924]/50 rounded-xl transition-colors cursor-pointer group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-gray-100 dark:bg-[#0c312b] flex items-center justify-center text-gray-700 dark:text-[#8eb698] shrink-0 border border-transparent dark:border-[#14423b]">
                    <Smartphone className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />
                  </div>
                  <div>
                    <span className="text-sm font-semibold text-gray-900 dark:text-[#daf1de] block">
                      {locale === "ar" ? "أنواع الأجهزة" : "Device Types"}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-[#8eb698]">
                      {locale === "ar" ? "إدارة وتخصيص أسعار أنواع الأجهزة والخدمات" : "Manage device types and standard base pricing"}
                    </span>
                  </div>
                </div>
                <div className="flex items-center text-gray-400 group-hover:text-emerald-600 dark:group-hover:text-[#daf1de] transition-colors">
                  {isRTL ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </div>
              </button>
            </div>
          </section>
        )}

        {/* GROUP 3: Offline Data & Backup Engine (النسخ الاحتياطي وإدارة البيانات) */}
        {hasPermission("settings:manage") && (
          <section className="pb-6 border-b border-gray-200/80 dark:border-[#123832]">
            <BackupDataManagement />
          </section>
        )}

        {/* GROUP 4: Central Sync Engine & Outbox (مركز المزامنة السحابية) */}
        {(hasPermission("sync:manage") || hasPermission("sync:view") || hasPermission("settings:manage")) && (
          <section className="pb-6 border-b border-gray-200/80 dark:border-[#123832]">
            <SyncCenter />
          </section>
        )}

        {/* GROUP 5: Manual Order Number Management */}
        {hasPermission("orders:renumber-day") && (
          <section className="pb-6 border-b border-gray-200/80 dark:border-[#123832] space-y-3">
            <div className="px-0.5 text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-[#8eb698]">
              {locale === "ar" ? "إدارة أرقام الطلبات" : "Order Number Management"}
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-[#245047] p-3">
              <button
                type="button"
                onClick={() => onNavigate?.("/app/settings/renumber-day")}
                className="w-full flex items-center justify-between gap-3 text-start hover:bg-gray-50/60 dark:hover:bg-[#0b2924]/50 rounded-xl transition-colors cursor-pointer group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-gray-100 dark:bg-[#0c312b] flex items-center justify-center text-gray-700 dark:text-[#8eb698] shrink-0">
                    <ListOrdered className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />
                  </div>
                  <div>
                    <span className="text-sm font-semibold text-gray-900 dark:text-[#daf1de] block">
                      {locale === "ar" ? "تعديل أرقام الطلبات يدويًا" : "Manually edit order numbers"}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-[#8eb698] block mt-1">
                      {locale === "ar"
                        ? "اختر اليوم، عدّل رقم كل طلب، ثم راجع التغييرات واعتمدها. لن يعاد ترقيم الطلبات الموجودة تلقائيًا."
                        : "Choose a day, edit each order number, and review before confirming. Existing orders are never renumbered automatically."}
                    </span>
                  </div>
                </div>
                <div className="flex items-center text-gray-400 group-hover:text-emerald-600 dark:group-hover:text-[#daf1de] transition-colors">
                  {isRTL ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </div>
              </button>
            </div>
          </section>
        )}

        {/* GROUP 6: Account & Role Security (الحساب والأمان) */}
        <section className="pb-6 border-b border-gray-200/80 dark:border-[#123832] space-y-3">
          <div className="px-0.5 text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-[#8eb698]">
            {t("accountSectionTitle")}
          </div>
          <div className="divide-y divide-gray-100 dark:divide-[#0f302b]">
            {/* PART 4: Account Role Block */}
            <div className="py-3.5 flex items-center justify-between gap-3 min-h-[52px]">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-gray-100 dark:bg-[#0c312b] flex items-center justify-center text-gray-700 dark:text-[#8eb698] shrink-0 border border-transparent dark:border-[#14423b]">
                  <User className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />
                </div>
                <span className="text-sm font-semibold text-gray-900 dark:text-[#daf1de]">
                  {t("accountRole")}
                </span>
              </div>
              <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-[#0c312b] text-emerald-700 dark:text-[#8eb698] border border-emerald-200 dark:border-[#14423b] capitalize">
                {session?.role ? session.role.toLowerCase().replace('_', ' ') : '...'}
              </span>
            </div>

            {/* Session State Block */}
            <div className="py-3.5 flex items-center justify-between gap-3 min-h-[52px]">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-gray-100 dark:bg-[#0c312b] flex items-center justify-center text-gray-700 dark:text-[#8eb698] shrink-0 border border-transparent dark:border-[#14423b]">
                  <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />
                </div>
                <span className="text-sm font-semibold text-gray-900 dark:text-[#daf1de]">
                  {locale === "en" ? "Session State" : "حالة الجلسة"}
                </span>
              </div>
              <span className="text-xs text-gray-600 dark:text-[#8eb698]">
                {locale === "en" ? "Authenticated & Authorized" : "مصادق ومعتمد محلياً"}
              </span>
            </div>

            {/* Admin Management Navigation Row */}
            {hasPermission("admin:manage") && (
              <div className="py-2">
                <button
                  type="button"
                  onClick={() => onNavigate?.("/app/settings/admins")}
                  className="w-full py-2 px-1 flex items-center justify-between gap-3 text-start hover:bg-gray-50/60 dark:hover:bg-[#0b2924]/50 rounded-xl transition-colors cursor-pointer group"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-xl bg-gray-100 dark:bg-[#0c312b] flex items-center justify-center text-gray-700 dark:text-[#8eb698] shrink-0 border border-transparent dark:border-[#14423b]">
                      <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />
                    </div>
                    <div>
                      <span className="text-sm font-semibold text-gray-900 dark:text-[#daf1de] block">
                        {locale === "ar" ? "إدارة حسابات المشرفين" : "Manage Admin Accounts"}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-[#8eb698]">
                        {locale === "ar" ? "عرض الصلاحيات، تجميد وتفعيل الحسابات، وإنشاء مشرفين جدد" : "View custom permissions, suspend/activate, and create new admins"}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center text-gray-400 group-hover:text-emerald-600 dark:group-hover:text-[#daf1de] transition-colors">
                    {isRTL ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </div>
                </button>
              </div>
            )}

            {/* PART 1: Secure 2-Step BIN Change Area */}
            <div className="pt-3 space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-amber-100 dark:bg-[#1a2f1c] flex items-center justify-center text-amber-700 dark:text-amber-400 shrink-0">
                  <KeyRound className="w-4 h-4" />
                </div>
                <div>
                  <span className="text-sm font-semibold text-gray-900 dark:text-[#daf1de] block">
                    {t("changeSecurityBin") || (locale === "ar" ? "تغيير رمز الأمان BIN" : "Change Security BIN")}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-[#8eb698]">
                    {t("changeBinDesc") || (locale === "ar"
                      ? "تحديث رمز الأمان الخاص بالحساب بعد التحقق من كلمة المرور"
                      : "Update account security BIN after password verification")}
                  </span>
                </div>
              </div>

              {binError && (
                <div className="p-2.5 rounded-xl bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-xs font-medium border border-red-200 dark:border-red-900 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{binError}</span>
                </div>
              )}

              {binSuccess && (
                <div className="p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 text-xs font-medium border border-emerald-200 dark:border-emerald-900 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{binSuccess}</span>
                </div>
              )}

              {/* STATE 0: IDLE (Initial Button) */}
              {binStep === "IDLE" && (
                <div className="pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleStartChangeBin}
                    className="text-xs h-8 px-3.5 gap-1.5 font-semibold text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-700/60 hover:bg-amber-50 dark:hover:bg-amber-950/30 cursor-pointer"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>{t("changeBinBtn") || (locale === "ar" ? "تغيير BIN" : "Change BIN")}</span>
                  </Button>
                </div>
              )}

              {/* STATE 1: IDENTITY VERIFICATION (Username + Account Password) */}
              {binStep === "VERIFY" && (
                <form onSubmit={handleVerifyIdentity} className="space-y-3 pt-2 bg-gray-50/80 dark:bg-[#041714] p-3.5 rounded-xl border border-gray-200 dark:border-[#123832]">
                  <div className="flex items-center justify-between border-b border-gray-200/80 dark:border-[#0f302b] pb-2">
                    <div className="flex items-center gap-2">
                      <Lock className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      <span className="text-xs font-bold text-gray-900 dark:text-[#daf1de]">
                        {t("changeBinStep1Title") || (locale === "ar" ? "التحقق من هوية الحساب" : "Account Identity Verification")}
                      </span>
                    </div>
                    <span className="text-[10px] text-gray-400 dark:text-[#5e8674]">
                      {locale === "ar" ? "المرحلة 1 من 2" : "Step 1 of 2"}
                    </span>
                  </div>

                  <p className="text-[11px] text-gray-500 dark:text-[#8eb698] leading-relaxed">
                    {t("changeBinStep1Desc") || (locale === "ar"
                      ? "يرجى إدخال اسم المستخدم وكلمة مرور الحساب الحالية للمتابعة"
                      : "Please enter your username and current account password to proceed")}
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 dark:text-[#8eb698] mb-1">
                        {t("changeBinUsername") || (locale === "ar" ? "اسم المستخدم / البريد" : "Username / Email")}
                      </label>
                      <input
                        type="text"
                        required
                        value={usernameInput}
                        onChange={(e) => setUsernameInput(e.target.value)}
                        placeholder="username"
                        className="w-full px-3 py-2 text-xs rounded-xl border border-gray-200 dark:border-[#123832] bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 dark:text-[#8eb698] mb-1">
                        {t("changeBinCurrentPassword") || (locale === "ar" ? "كلمة مرور الحساب الحالية" : "Current Account Password")}
                      </label>
                      <input
                        type="password"
                        required
                        value={passwordInput}
                        onChange={(e) => setPasswordInput(e.target.value)}
                        placeholder="••••••••"
                        className="w-full px-3 py-2 text-xs rounded-xl border border-gray-200 dark:border-[#123832] bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      disabled={isBinLoading || !usernameInput.trim() || !passwordInput}
                      className="text-xs h-8 px-4 font-semibold cursor-pointer"
                    >
                      {isBinLoading
                        ? (locale === "ar" ? "جاري التحقق..." : "Verifying...")
                        : (t("changeBinContinue") || (locale === "ar" ? "متابعة" : "Continue"))}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleCancelChangeBin}
                      disabled={isBinLoading}
                      className="text-xs h-8 px-3 font-medium cursor-pointer"
                    >
                      {t("changeBinCancel") || (locale === "ar" ? "إلغاء" : "Cancel")}
                    </Button>
                  </div>
                </form>
              )}

              {/* STATE 2: CHANGE BIN (New BIN + Confirm BIN) */}
              {binStep === "NEW_BIN" && (
                <form onSubmit={handleSaveNewBin} className="space-y-3 pt-2 bg-gray-50/80 dark:bg-[#041714] p-3.5 rounded-xl border border-emerald-300 dark:border-[#1a4b42]">
                  <div className="flex items-center justify-between border-b border-gray-200/80 dark:border-[#0f302b] pb-2">
                    <div className="flex items-center gap-2">
                      <KeyRound className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      <span className="text-xs font-bold text-gray-900 dark:text-[#daf1de]">
                        {t("changeBinStep2Title") || (locale === "ar" ? "تعيين رمز الأمان الجديد" : "Set New Security BIN")}
                      </span>
                    </div>
                    <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold">
                      {locale === "ar" ? "المرحلة 2 من 2" : "Step 2 of 2"}
                    </span>
                  </div>

                  <p className="text-[11px] text-gray-500 dark:text-[#8eb698] leading-relaxed">
                    {t("changeBinStep2Desc") || (locale === "ar"
                      ? "أدخل رمز الأمان الجديد المكون من 4 أرقام على الأقل"
                      : "Enter your new security BIN of at least 4 digits")}
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 dark:text-[#8eb698] mb-1">
                        {t("changeBinNew") || (locale === "ar" ? "رمز الأمان (BIN) الجديد" : "New Security BIN")}
                      </label>
                      <input
                        type="password"
                        required
                        autoFocus
                        value={newBin}
                        onChange={(e) => setNewBin(e.target.value)}
                        placeholder="••••"
                        maxLength={12}
                        className="w-full px-3 py-2 text-xs rounded-xl border border-gray-200 dark:border-[#123832] bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 dark:text-[#8eb698] mb-1">
                        {t("changeBinConfirm") || (locale === "ar" ? "تأكيد رمز الأمان (BIN)" : "Confirm Security BIN")}
                      </label>
                      <input
                        type="password"
                        required
                        value={confirmBin}
                        onChange={(e) => setConfirmBin(e.target.value)}
                        placeholder="••••"
                        maxLength={12}
                        className="w-full px-3 py-2 text-xs rounded-xl border border-gray-200 dark:border-[#123832] bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      disabled={isBinLoading || !newBin.trim() || !confirmBin.trim()}
                      className="text-xs h-8 px-4 font-semibold cursor-pointer"
                    >
                      {isBinLoading
                        ? (locale === "ar" ? "جاري الحفظ..." : "Saving...")
                        : (t("changeBinSave") || (locale === "ar" ? "حفظ BIN" : "Save BIN"))}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleCancelChangeBin}
                      disabled={isBinLoading}
                      className="text-xs h-8 px-3 font-medium cursor-pointer"
                    >
                      {t("changeBinCancel") || (locale === "ar" ? "إلغاء" : "Cancel")}
                    </Button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </section>

        {/* GROUP 7: About App (حول المنظومة) */}
        <section className="space-y-3">
          <div className="px-0.5 text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-[#8eb698]">
            {t("aboutSectionTitle")}
          </div>
          <div className="divide-y divide-gray-100 dark:divide-[#0f302b]">
            <div className="py-3.5 flex items-center justify-between gap-3 min-h-[52px]">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-gray-100 dark:bg-[#0c312b] flex items-center justify-center text-gray-700 dark:text-[#8eb698] shrink-0 border border-transparent dark:border-[#14423b]">
                  <Info className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />
                </div>
                <span className="text-sm font-semibold text-gray-900 dark:text-[#daf1de]">
                  {locale === "en" ? "Application" : "اسم المنظومة"}
                </span>
              </div>
              <span className="text-xs font-medium text-gray-700 dark:text-[#daf1de]">
                {t("systemTitle")}
              </span>
            </div>

            <div className="py-3.5 flex items-center justify-between gap-3 min-h-[52px]">
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-gray-900 dark:text-[#daf1de] ps-11">
                  {t("appVersion")}
                </span>
              </div>
              <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded-md bg-gray-100 dark:bg-[#041714] text-gray-800 dark:text-[#daf1de] border border-gray-200 dark:border-[#123832]">
                1.0.0
              </span>
            </div>

            <div className="py-3.5 space-y-1">
              <span className="text-xs font-semibold text-gray-700 dark:text-[#8eb698] block">
                {t("appArchitecture")}
              </span>
              <p className="text-xs text-gray-500 dark:text-[#8eb698] leading-relaxed">
                {t("appArchitectureDesc")}
              </p>
            </div>
          </div>
        </section>

        {/* GROUP 8: Web App (PWA) Settings & Installation */}
        <section className="pt-2">
          <PWASettingsCard />
        </section>
      </div>
    </div>
  );
};
