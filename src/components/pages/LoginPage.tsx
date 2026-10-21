import React, { useState, useEffect } from "react";
import { useI18n } from "../../i18n/i18nContext";
import { useTheme } from "../../theme/themeContext";
import { authService } from "../../services/auth/authService";
import { SupabaseAuthSession } from "../../services/supabase/client";
import type { StoreBootstrapProgress } from "./dayOrdersStore";
import { Button } from "../ui/Button";
import {
  Sun,
  Moon,
  Languages,
  Shield,
  Lock,
  Mail,
  Key,
  CheckCircle,
  AlertCircle,
  User,
  Sparkles,
  RefreshCw,
  LogOut,
} from "lucide-react";

const SAVED_ADMIN_ACCOUNTS_KEY = 'cp_saved_admin_accounts_v1';
const readSavedAdminAccounts = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_ADMIN_ACCOUNTS_KEY) || '[]');
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 160))].slice(0, 5)
      : [];
  } catch { return []; }
};
const saveAdminAccountIdentifier = (identifier: string) => {
  const clean = identifier.trim();
  if (!clean || clean.length > 160) return;
  try {
    const accounts = [clean, ...readSavedAdminAccounts().filter((item) => item.toLowerCase() !== clean.toLowerCase())].slice(0, 5);
    localStorage.setItem(SAVED_ADMIN_ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch {}
};

export interface LoginPageProps {
  onLoginSuccess: () => void | Promise<void>;
  bootstrapProgress?: StoreBootstrapProgress;
}

export type AuthUiState =
  | "INITIALIZING"
  | "SYSTEM_BOOTSTRAPPED_FALSE_NO_SESSION"
  | "NORMAL_LOGIN"
  | "IDENTITY_RESOLVING"
  | "SUPER_ADMIN_BIN_REQUIRED"
  | "SUPER_ADMIN_BIN_RECOVERY"
  | "ACCESS_DENIED_NO_ADMIN"
  | "ACCESS_DENIED_INACTIVE";

export const LoginPage: React.FC<LoginPageProps> = ({ onLoginSuccess, bootstrapProgress }) => {
  const { t, locale, setLocale, isRTL } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const isSupabase = authService.isSupabaseConfigured();

  const [uiState, setUiState] = useState<AuthUiState>("INITIALIZING");
  const [isBootstrapped, setIsBootstrapped] = useState<boolean | null>(null);
  const [, setAuthSession] = useState<SupabaseAuthSession | null>(null);

  // Form Fields
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [email, setEmail] = useState("");
  const [bin, setBin] = useState("");
  const [confirmBin, setConfirmBin] = useState("");
  const [internalEmail, setInternalEmail] = useState("");

  // Super Admin BIN Attempt Tracking & Recovery Fields
  const [isBinLocked, setIsBinLocked] = useState(false);
  const [recoveryCurrentPassword, setRecoveryCurrentPassword] = useState("");
  const [recoveryNewBin, setRecoveryNewBin] = useState("");
  const [recoveryConfirmBin, setRecoveryConfirmBin] = useState("");

  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [savedAdminAccounts, setSavedAdminAccounts] = useState<string[]>(() => readSavedAdminAccounts());
  const [showSavedAccounts, setShowSavedAccounts] = useState(() => readSavedAdminAccounts().length > 0);
  const [pendingRememberIdentifier, setPendingRememberIdentifier] = useState<string | null>(null);

  // Initialize and check Supabase bootstrap & auth callback on mount
  useEffect(() => {
    let isMounted = true;

    const initializeAuth = async () => {
      if (!isSupabase) {
        setIsBootstrapped(true);
        setUiState("NORMAL_LOGIN");
        return;
      }

      setUiState("INITIALIZING");
      setError("");

      try {
        const callbackResult = await authService.captureAuthCallback();
        if (callbackResult.error) {
          setError(callbackResult.error);
        }

        const bootstrapped = await authService.checkSystemBootstrapped();
        if (!isMounted) return;

        setIsBootstrapped(bootstrapped);
        setUiState(bootstrapped ? "NORMAL_LOGIN" : "SYSTEM_BOOTSTRAPPED_FALSE_NO_SESSION");
      } catch (err: any) {
        if (isMounted) {
          setError(
            err?.message ||
              (locale === "en"
                ? "System initialization check failed"
                : "فشل التحقق من حالة النظام")
          );
          setIsBootstrapped(true);
          setUiState("NORMAL_LOGIN");
        }
      }
    };

    initializeAuth();
    return () => {
      isMounted = false;
    };
  }, [isSupabase, locale]);

  // Support history navigation between views without manual back buttons
  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      if (e.state?.uiState) {
        setUiState(e.state.uiState);
        setError("");
        setSuccessMessage("");
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Handle Switch Account / Log out of Supabase Auth
  const handleLogout = async () => {
    await authService.logout();
    setAuthSession(null);
    setPassword("");
    setBin("");
    setConfirmBin("");
    setError("");
    setSuccessMessage("");
    const bootstrapped = isSupabase ? await authService.checkSystemBootstrapped() : true;
    setIsBootstrapped(bootstrapped);
    setUiState("NORMAL_LOGIN");
  };

  // Open First Super Admin Registration Screen
  const handleOpenCreateSuperAdmin = () => {
    setError("");
    setSuccessMessage("");
    if (typeof window !== "undefined" && window.history) {
      window.history.pushState({ uiState: "SYSTEM_BOOTSTRAPPED_FALSE_NO_SESSION" }, "");
    }
    setUiState("SYSTEM_BOOTSTRAPPED_FALSE_NO_SESSION");
  };

  const finishSuccessfulLogin = async (identifier: string, remember: boolean) => {
    if (remember) {
      saveAdminAccountIdentifier(identifier);
      setSavedAdminAccounts(readSavedAdminAccounts());
    }
    setPendingRememberIdentifier(null);
    setPassword('');
    try {
      await onLoginSuccess();
    } catch (finishError: any) {
      setError(finishError?.message || (locale === 'en' ? 'Could not finish opening the app.' : 'تعذر إكمال فتح التطبيق.'));
    }
  };

  // Submit Handler
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return; // Prevent duplicate / double-click submissions
    setError("");
    setSuccessMessage("");
    setIsSubmitting(true);

    try {
      // SCENARIO 1: Normal Login (Username + Password)
      if (uiState === "NORMAL_LOGIN") {
        const cleanUser = username.trim();
        const cleanPass = password;
        if (!cleanUser || !cleanPass) {
          setError(
            locale === "en"
              ? "Please enter both username and password"
              : "يرجى إدخال اسم المستخدم وكلمة المرور"
          );
          return;
        }

        // Store entered identifier in memory for subsequent BIN verification step if needed
        setInternalEmail(cleanUser);

        try {
          const session = await authService.login(cleanUser, cleanPass);
          if (session) {
            setPassword("");
            setPendingRememberIdentifier(cleanUser);
          } else {
            setError(
              locale === "en"
                ? "Invalid username or password"
                : "اسم المستخدم أو كلمة المرور غير صحيحة"
            );
          }
        } catch (loginErr: any) {
          const msg = loginErr?.message || "";
          if (msg === "SUPER_ADMIN_BIN_REQUIRED") {
            // Password verified! Immediately purge sensitive password from React state
            setPassword("");
            setError("");
            setUiState("SUPER_ADMIN_BIN_REQUIRED");
          } else if (msg.startsWith("INITIAL_BOOTSTRAP_FAILED")) {
            setError(
              locale === "en"
                ? "The full cloud dataset could not be loaded. Check the connection and retry; the app was not opened with partial data."
                : "تعذر تحميل بيانات السحابة كاملة. تأكد من الاتصال وأعد المحاولة؛ لم نفتح النظام ببيانات ناقصة."
            );
          } else if (msg.startsWith("LOCAL_RECONCILIATION_REQUIRED")) {
            setError(
              locale === "en"
                ? "Existing local data has no trusted sync checkpoint. Automatic replacement was blocked to protect it; do not clear app data."
                : "البيانات المحلية ليس لها نقطة مزامنة موثوقة. أوقفنا الاستبدال التلقائي لحمايتها؛ لا تمسح بيانات التطبيق."
            );
          } else if (msg === "USERNAME_LOOKUP_FAILED") {
            setError(
              locale === "en"
                ? "Unable to verify username. Please try again."
                : "تعذر التحقق من اسم المستخدم، يرجى المحاولة مرة أخرى."
            );
          } else if (msg === "RATE_LIMIT") {
            setError(
              locale === "en"
                ? "Too many login attempts. Please wait a moment and try again."
                : "تم تجاوز عدد محاولات تسجيل الدخول مؤقتاً. يرجى الانتظار قليلاً ثم المحاولة مرة أخرى."
            );
          } else if (msg === "PROFILE_RPC_FAILED") {
            setError(
              locale === "en"
                ? "Password verified, but unable to load account profile. Please try again."
                : "تم التحقق من كلمة المرور، لكن تعذر تحميل بيانات الحساب. يرجى المحاولة مرة أخرى."
            );
          } else if (msg === "NETWORK_ERROR") {
            setError(
              locale === "en"
                ? "Unable to connect to the server. Please try again."
                : "تعذر الاتصال بالخادم. يرجى المحاولة مرة أخرى."
            );
          } else if (msg === "INVALID_API_KEY") {
            setError(
              locale === "en"
                ? "System configuration error: Invalid API key."
                : "خطأ في تهيئة النظام: مفتاح API غير صالح."
            );
          } else if (msg === "EMAIL_CONFIRMATION_REQUIRED") {
            setError(
              locale === "en"
                ? "Email confirmation required. Please check your email inbox."
                : "يرجى تأكيد البريد الإلكتروني عبر الرسالة المرسلة إلى بريدك."
            );
          } else if (msg === "ACCESS_DENIED_NO_ADMIN") {
            setUiState("ACCESS_DENIED_NO_ADMIN");
          } else if (msg === "ACCESS_DENIED_INACTIVE") {
            setUiState("ACCESS_DENIED_INACTIVE");
          } else if (msg === "BIN_LOCKED_FROZEN") {
            setIsBinLocked(true);
            setError(
              locale === "en"
                ? "Security BIN entry has been locked after 3 incorrect attempts."
                : "تم تجميد إدخال رمز الأمان بعد 3 محاولات غير صحيحة."
            );
          } else if (msg === "WRONG_BIN") {
            setError(
              locale === "en"
                ? "Invalid Security BIN code"
                : "رمز الأمان (BIN) غير صحيح"
            );
          } else if (msg === "SUPER_ADMIN_BIN_REQUIRED") {
            setPassword("");
            setError("");
            setUiState("SUPER_ADMIN_BIN_REQUIRED");
          } else {
            setError(
              locale === "en"
                ? "Invalid username or password"
                : "اسم المستخدم أو كلمة المرور غير صحيحة"
            );
          }
        }
        return;
      }

      // SCENARIO 2: Super Admin Separate BIN Verification Challenge (Uses temporary session, NO double sign-in)
      if (uiState === "SUPER_ADMIN_BIN_REQUIRED") {
        const cleanBin = bin.trim();

        if (isBinLocked) {
          setError(
            locale === "en"
              ? "Security BIN entry has been locked after 3 incorrect attempts."
              : "تم تجميد إدخال رمز الأمان بعد 3 محاولات غير صحيحة."
          );
          return;
        }

        if (!/^\d{4,}$/.test(cleanBin)) {
          setError(
            locale === "en"
              ? "Security BIN must be at least 4 numeric digits"
              : "رمز الأمان (BIN) يجب أن يتكون من 4 أرقام على الأقل"
          );
          return;
        }

        try {
          // Zero calls to signInWithPassword! Uses temporary token from memory
          const session = await authService.verifySuperAdminBin(cleanBin);
          if (session) {
            setBin("");
            setIsBinLocked(false);
            setPendingRememberIdentifier(internalEmail || username.trim());
          }
        } catch (binErr: any) {
          const msg = binErr?.message || String(binErr);

          if (msg === "SESSION_EXPIRED") {
            setError(
              locale === "en"
                ? "Session expired, please sign in again"
                : "انتهت الجلسة، يرجى تسجيل الدخول مجددًا"
            );
            setUiState("NORMAL_LOGIN");
            return;
          }

          if (msg === "BIN_VERIFICATION_UNAVAILABLE") {
            setError(
              locale === "en"
                ? "Unable to verify Security BIN due to a connection error. Please try again."
                : "تعذر التحقق من رمز الأمان بسبب خطأ في الاتصال، يرجى المحاولة مرة أخرى."
            );
            return;
          }

          if (msg === "BIN_LOCKED_FROZEN") {
            setIsBinLocked(true);
            setError(
              locale === "en"
                ? "Security BIN entry has been locked after 3 incorrect attempts."
                : "تم تجميد إدخال رمز الأمان بعد 3 محاولات غير صحيحة."
            );
            return;
          }

          if (msg === "WRONG_BIN") {
            const remaining = typeof binErr?.remainingAttempts === "number" ? binErr.remainingAttempts : null;
            if (remaining === 0) {
              setIsBinLocked(true);
              setError(
                locale === "en"
                  ? "Security BIN entry has been locked after 3 incorrect attempts."
                  : "تم تجميد إدخال رمز الأمان بعد 3 محاولات غير صحيحة."
              );
            } else if (remaining !== null && remaining > 0) {
              setError(
                locale === "en"
                  ? `Invalid Security BIN code. Remaining attempts: ${remaining}`
                  : `رمز الأمان (BIN) غير صحيح. المحاولات المتبقية: ${remaining}`
              );
            } else {
              setError(
                locale === "en"
                  ? "Invalid Security BIN code"
                  : "رمز الأمان (BIN) غير صحيح"
              );
            }
            return;
          }

          setError(
            binErr?.message ||
              (locale === "en" ? "Authentication failed" : "فشل تسجيل الدخول")
          );
        }
        return;
      }

      // SCENARIO 2B: Super Admin BIN Recovery & Reset (Password-Authenticated)
      if (uiState === "SUPER_ADMIN_BIN_RECOVERY") {
        const cleanCurrentPass = recoveryCurrentPassword;
        const cleanNewBin = recoveryNewBin.trim();
        const cleanConfirmBin = recoveryConfirmBin.trim();

        if (!cleanCurrentPass) {
          setError(
            locale === "en"
              ? "Current password is required"
              : "يرجى إدخال كلمة المرور الحالية"
          );
          return;
        }

        if (!/^\d{4,}$/.test(cleanNewBin)) {
          setError(
            locale === "en"
              ? "Security BIN must be at least 4 numeric digits"
              : "رمز الأمان (BIN) يجب أن يتكون من 4 أرقام على الأقل"
          );
          return;
        }

        if (cleanNewBin !== cleanConfirmBin) {
          setError(
            locale === "en"
              ? "Security BIN confirmation does not match"
              : "تأكيد رمز الأمان غير متطابق"
          );
          return;
        }

        const identifier = internalEmail || username.trim();
        const res = await authService.recoverAndResetBin(identifier, cleanCurrentPass, cleanNewBin);
        if (res.success) {
          setIsBinLocked(false);
          setBin("");
          setRecoveryCurrentPassword("");
          setRecoveryNewBin("");
          setRecoveryConfirmBin("");
          setSuccessMessage(
            locale === "en"
              ? "Security BIN updated and unlocked successfully! You can now sign in with your new BIN."
              : "تم تحديث رمز الأمان وفك التجميد بنجاح! يمكنك الآن تسجيل الدخول بالرمز الجديد."
          );
          setUiState("SUPER_ADMIN_BIN_REQUIRED");
        } else {
          setError(res.error || (locale === "en" ? "Recovery failed" : "فشلت عملية تغيير رمز الأمان"));
        }
        return;
      }

      // SCENARIO 3: First System Setup (One-time Super Admin Bootstrap)
      if (uiState === "SYSTEM_BOOTSTRAPPED_FALSE_NO_SESSION") {
        const cleanEmail = email.trim().toLowerCase();
        const cleanUsername = username.trim();
        const cleanPass = password;
        const cleanBin = bin.trim();

        if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
          setError(locale === "en" ? "Valid email address is required" : "يرجى إدخال بريد إلكتروني صالح");
          return;
        }

        if (cleanUsername.length < 3) {
          setError(locale === "en" ? "Username must be at least 3 characters" : "اسم المستخدم يجب أن لا يقل عن 3 أحرف");
          return;
        }

        if (cleanPass.length < 6) {
          setError(locale === "en" ? "Password must be at least 6 characters" : "كلمة المرور يجب أن لا تقل عن 6 أحرف");
          return;
        }

        if (cleanPass !== confirmPassword) {
          setError(locale === "en" ? "Password confirmation does not match" : "تأكيد كلمة المرور غير متطابق");
          return;
        }

        if (!/^\d{4,}$/.test(cleanBin)) {
          setError(locale === "en" ? "Security BIN must be at least 4 numeric digits" : "رمز الأمان (BIN) يجب أن يتكون من 4 أرقام على الأقل");
          return;
        }

        if (cleanBin !== confirmBin.trim()) {
          setError(locale === "en" ? "Security BIN confirmation does not match" : "تأكيد رمز الأمان (BIN) غير متطابق");
          return;
        }

        const res = await authService.bootstrapFirstSuperAdmin({
          username: cleanUsername,
          fullName: cleanUsername,
          email: cleanEmail,
          bin: cleanBin,
          password: cleanPass,
        });

        if (res.success) {
          // Explicitly clear session to prevent any auto-login
          await authService.logout();
          setPassword("");
          setConfirmPassword("");
          setBin("");
          setConfirmBin("");
          setIsBootstrapped(true);
          setSuccessMessage(
            locale === "en"
              ? "Super Admin account created successfully"
              : "تم إنشاء حساب سوبر أدمن بنجاح"
          );
          if (typeof window !== "undefined" && window.history) {
            window.history.replaceState({ uiState: "NORMAL_LOGIN" }, "");
          }
          setUiState("NORMAL_LOGIN");
        } else {
          setError(res.error || (locale === "en" ? "Bootstrap failed" : "فشلت عملية تهيئة المشرف"));
        }
        return;
      }
    } catch (err: any) {
      setError(err?.message || (locale === "en" ? "Authentication failed" : "فشل تسجيل الدخول"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#061f1c] flex flex-col justify-between p-4 sm:p-6 transition-colors text-gray-900 dark:text-[#daf1de]">
      {/* Top Header Bar */}
      <header className="flex items-center justify-between max-w-md w-full mx-auto pt-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-600 dark:text-emerald-400 font-bold text-sm">
            <Shield className="w-4 h-4" />
          </div>
          <span className="text-xs font-bold tracking-tight text-gray-800 dark:text-[#daf1de]">
            {locale === "en" ? "Management System" : "منظومة إدارة الطلبات والعملاء"}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setLocale(locale === "en" ? "ar" : "en")}
            className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 dark:text-[#80a89a] dark:hover:bg-[#0a2e28] transition-colors cursor-pointer text-xs flex items-center gap-1"
            title="Toggle Language"
          >
            <Languages className="w-3.5 h-3.5" />
            <span className="font-semibold uppercase">{locale}</span>
          </button>
          <button
            onClick={toggleTheme}
            className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 dark:text-[#80a89a] dark:hover:bg-[#0a2e28] transition-colors cursor-pointer text-xs"
            title="Toggle Theme"
          >
            {theme === "dark" ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 flex items-center justify-center my-6">
        <div className="w-full max-w-md bg-white dark:bg-[#0b2924] border border-gray-200 dark:border-[#14423b] rounded-2xl shadow-xl p-6 sm:p-8 space-y-6">
          {/* Header Title & Subtitle */}
          <div className="text-center space-y-2">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 mb-1">
              <Shield className="w-6 h-6" />
            </div>

            <h1 className="text-lg font-extrabold text-gray-900 dark:text-[#daf1de]">
              {uiState === "SYSTEM_BOOTSTRAPPED_FALSE_NO_SESSION"
                ? locale === "en"
                  ? "Create Super Admin Account"
                  : "إنشاء حساب سوبر أدمن"
                : uiState === "SUPER_ADMIN_BIN_REQUIRED"
                ? locale === "en"
                  ? "Security Verification"
                  : "التحقق الأمني"
                : uiState === "SUPER_ADMIN_BIN_RECOVERY"
                ? locale === "en"
                  ? "Recover & Reset Security BIN"
                  : "استعادة وتعيين رمز الأمان"
                : uiState === "ACCESS_DENIED_NO_ADMIN" || uiState === "ACCESS_DENIED_INACTIVE"
                ? locale === "en"
                  ? "Access Denied"
                  : "تم رفض الوصول"
                : locale === "en"
                ? "Sign In"
                : "تسجيل الدخول"}
            </h1>

            <p className="text-xs text-gray-500 dark:text-[#80a89a] leading-relaxed">
              {uiState === "SYSTEM_BOOTSTRAPPED_FALSE_NO_SESSION"
                ? locale === "en"
                  ? "First system setup: configure Super Admin credentials and security BIN."
                  : "التهيئة الأولى للنظام: تعيين بيانات المشرف الرئيسي ورمز الأمان."
                : uiState === "SUPER_ADMIN_BIN_REQUIRED"
                ? locale === "en"
                  ? "Enter your 4+ digit Security BIN code to access the system."
                  : "أدخل رمز الأمان (BIN) للوصول للوحة التحكم."
                : uiState === "SUPER_ADMIN_BIN_RECOVERY"
                ? locale === "en"
                  ? "Verify your current password to reset your Security BIN and unlock access."
                  : "أدخل كلمة المرور الحالية لتعيين رمز أمان جديد وفك تجميد الحساب."
                : locale === "en"
                ? "Enter your credentials to access the system."
                : "أدخل بيانات حسابك المعتمد للدخول للنظام."}
            </p>
          </div>

          {/* Alert Messages */}
          {error && (
            <div className="p-3 bg-rose-50 dark:bg-red-950/40 border border-rose-200 dark:border-red-800/50 rounded-xl flex items-start gap-2.5 text-rose-700 dark:text-red-300 text-xs animate-shake">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-500" />
              <div className="flex-1 font-medium leading-relaxed">{error}</div>
            </div>
          )}

          {successMessage && (
            <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/50 rounded-xl flex items-start gap-2.5 text-emerald-700 dark:text-emerald-300 text-xs">
              <CheckCircle className="w-4 h-4 shrink-0 mt-0.5 text-emerald-500" />
              <div className="flex-1 font-medium leading-relaxed">{successMessage}</div>
            </div>
          )}

          {isSubmitting && bootstrapProgress && (bootstrapProgress.phase === "FETCHING" || bootstrapProgress.phase === "INSTALLING") && (
            <div className="p-3 rounded-xl border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/80 dark:bg-emerald-950/30 space-y-2">
              <div className="flex items-center justify-between gap-3 text-xs text-emerald-800 dark:text-emerald-200">
                <span className="font-medium">{bootstrapProgress.message}</span>
                <span className="font-bold tabular-nums">{bootstrapProgress.percent}%</span>
              </div>
              <div className="w-full h-2 rounded-full bg-emerald-100 dark:bg-emerald-950 overflow-hidden">
                <div className="h-full rounded-full bg-emerald-500 transition-all duration-200" style={{ width: `${bootstrapProgress.percent}%` }} />
              </div>
              {bootstrapProgress.totalRows > 0 && (
                <div className="text-[11px] text-emerald-700 dark:text-emerald-300 text-center">
                  {bootstrapProgress.completedRows.toLocaleString()} / {bootstrapProgress.totalRows.toLocaleString()} سجل
                </div>
              )}
            </div>
          )}

          {/* Loading Indicator */}
          {uiState === "INITIALIZING" || uiState === "IDENTITY_RESOLVING" ? (
            <div className="py-8 flex flex-col items-center justify-center space-y-3">
              <RefreshCw className="w-8 h-8 text-emerald-500 animate-spin" />
              <span className="text-xs text-gray-500 dark:text-[#5e8674]">
                {locale === "en" ? "Checking system status..." : "جاري التحقق من حالة النظام..."}
              </span>
            </div>
          ) : uiState === "ACCESS_DENIED_NO_ADMIN" || uiState === "ACCESS_DENIED_INACTIVE" ? (
            <div className="py-6 text-center space-y-4">
              <div className="p-4 bg-rose-50 dark:bg-red-950/30 border border-rose-200 dark:border-red-900/40 rounded-xl text-rose-700 dark:text-red-300 text-xs leading-relaxed font-semibold">
                {uiState === "ACCESS_DENIED_INACTIVE"
                  ? locale === "en"
                    ? "Your admin account has been disabled by management."
                    : "تم تعطيل حسابك من قبل الإدارة."
                  : locale === "en"
                  ? "Your account is authenticated, but no admin identity row exists in the system."
                  : "تم توثيق الحساب، ولكن ليس لديه سجل مسؤول في المنظومة."}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleLogout}
                className="text-xs border-gray-300 dark:border-[#14423b] text-gray-700 dark:text-[#daf1de]"
              >
                <LogOut className="w-3.5 h-3.5 mr-1.5" />
                {locale === "en" ? "Sign Out" : "تسجيل الخروج"}
              </Button>
            </div>
          ) : (
            /* Active Form */
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* ============================================================ */}
              {/* FORM TYPE 1: NORMAL LOGIN (Username + Password) */}
              {/* ============================================================ */}
              {uiState === "NORMAL_LOGIN" && (
                <>
                  {showSavedAccounts && savedAdminAccounts.length > 0 ? (
                    <div className="space-y-3" data-testid="saved-admin-accounts">
                      <p className="text-xs font-semibold text-gray-600 dark:text-[#9bb6b0]">
                        {locale === "en" ? "Choose a saved account" : "اختر حسابًا محفوظًا"}
                      </p>
                      <div className="space-y-2">
                        {savedAdminAccounts.map((account) => (
                          <button key={account} type="button" onClick={() => { setUsername(account); setPassword(""); setShowSavedAccounts(false); setError(""); }}
                            className="flex w-full items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 text-start transition hover:border-emerald-500 hover:bg-emerald-50 dark:border-[#244746] dark:bg-[#06201c] dark:hover:bg-[#0b352e]">
                            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"><User className="h-5 w-5" /></span>
                            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold">{account}</span><span className="mt-0.5 block text-xs text-gray-500 dark:text-[#80a89a]">{locale === "en" ? "Sign in with password" : "الدخول باستخدام كلمة المرور"}</span></span>
                            <Lock className="h-4 w-4 shrink-0 text-gray-400" />
                          </button>
                        ))}
                      </div>
                      <button type="button" onClick={() => { setUsername(""); setPassword(""); setShowSavedAccounts(false); }}
                        className="w-full rounded-xl border border-dashed border-gray-300 px-3 py-3 text-xs font-semibold text-gray-600 hover:border-emerald-500 dark:border-[#315653] dark:text-[#b3d5bd]">
                        {locale === "en" ? "Sign in with another account" : "الدخول بحساب آخر"}
                      </button>
                    </div>
                  ) : (
                    <>
                  {savedAdminAccounts.length > 0 && (
                    <button type="button" onClick={() => { setShowSavedAccounts(true); setUsername(""); setPassword(""); setError(""); }}
                      className="mb-1 text-xs font-semibold text-emerald-700 hover:underline dark:text-emerald-300">
                      {locale === "en" ? "Choose a saved account" : "اختيار حساب محفوظ"}
                    </button>
                  )}
                  {/* Field: Username */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-700 dark:text-[#daf1de] block">
                      {locale === "en" ? "Username" : "يوزر نيم"}
                    </label>
                    <div className="relative">
                      <User className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-[#5e8674] ${isRTL ? "right-3" : "left-3"}`} />
                      <input
                        type="text"
                        required
                        autoCapitalize="none"
                        autoComplete="username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder={locale === "en" ? "Enter username" : "اسم المستخدم"}
                        className={`w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 text-gray-900 dark:text-[#daf1de] placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 font-mono ${
                          isRTL ? "pr-9 pl-3" : "pl-9 pr-3"
                        }`}
                      />
                    </div>
                  </div>

                  {/* Field: Password */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-700 dark:text-[#daf1de] block">
                      {locale === "en" ? "Password" : "باسورد"}
                    </label>
                    <div className="relative">
                      <Lock className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-[#5e8674] ${isRTL ? "right-3" : "left-3"}`} />
                      <input
                        type="password"
                        required
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        className={`w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 text-gray-900 dark:text-[#daf1de] placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 ${
                          isRTL ? "pr-9 pl-3" : "pl-9 pr-3"
                        }`}
                      />
                    </div>
                  </div>

                  {/* Sign In Button */}
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={isSubmitting}
                    className="w-full text-xs py-2.5 rounded-xl font-bold bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer mt-2"
                  >
                    {isSubmitting
                      ? locale === "en"
                        ? "Processing..."
                        : "جاري المعالجة..."
                      : locale === "en"
                      ? "Sign In"
                      : "تسجيل الدخول"}
                  </Button>

                  {/* Only when NO Super Admin exists: Show 'Create Super Admin Account' button */}
                  {isBootstrapped === false && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleOpenCreateSuperAdmin}
                      className="w-full text-xs py-2.5 rounded-xl font-semibold border-emerald-500/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10 cursor-pointer mt-1"
                    >
                      <Sparkles className="w-3.5 h-3.5 mr-1 text-emerald-500" />
                      {locale === "en" ? "Create Super Admin Account" : "إنشاء حساب سوبر أدمن"}
                    </Button>
                  )}
                    </>
                  )}
                </>
              )}

              {/* ============================================================ */}
              {/* FORM TYPE 2: SEPARATE BIN SECURITY CHALLENGE */}
              {/* ============================================================ */}
              {uiState === "SUPER_ADMIN_BIN_REQUIRED" && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-700 dark:text-[#daf1de] block">
                      {locale === "en" ? "Security BIN Code (Min 4 digits)" : "رمز الأمان (BIN)"}
                    </label>
                    <div className="relative">
                      <Key className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-[#5e8674] ${isRTL ? "right-3" : "left-3"}`} />
                      <input
                        type="password"
                        required
                        autoFocus
                        disabled={isBinLocked}
                        value={bin}
                        onChange={(e) => setBin(e.target.value)}
                        placeholder="••••••"
                        maxLength={10}
                        className={`w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 text-gray-900 dark:text-[#daf1de] placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 font-mono disabled:opacity-50 disabled:cursor-not-allowed ${
                          isRTL ? "pr-9 pl-3" : "pl-9 pr-3"
                        }`}
                      />
                    </div>
                  </div>

                  <Button
                    type="submit"
                    variant="primary"
                    disabled={isSubmitting || isBinLocked}
                    className="w-full text-xs py-2.5 rounded-xl font-bold bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer mt-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSubmitting
                      ? locale === "en"
                        ? "Verifying..."
                        : "جاري التحقق..."
                      : locale === "en"
                      ? "Verify"
                      : "تحقق"}
                  </Button>

                  <div className="flex flex-col gap-2 pt-2 border-t border-gray-100 dark:border-[#14423b]">
                    {/* Recovery is ONLY visible when account is locked / 3 failed attempts reached on server */}
                    {isBinLocked && (
                      <button
                        type="button"
                        data-testid="bin-recovery-button"
                        onClick={() => {
                          setError("");
                          setSuccessMessage("");
                          setRecoveryCurrentPassword("");
                          setRecoveryNewBin("");
                          setRecoveryConfirmBin("");
                          setUiState("SUPER_ADMIN_BIN_RECOVERY");
                        }}
                        className="text-xs text-center text-rose-600 dark:text-rose-400 hover:underline font-bold py-1.5 px-2 bg-rose-50 dark:bg-rose-950/40 rounded-lg border border-rose-200 dark:border-rose-900/50 cursor-pointer"
                      >
                        {locale === "en"
                          ? "Forgot your BIN or is it locked? Change BIN"
                          : "نسيت الـBIN أو تم تجميده؟ تغيير الـBIN"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleLogout}
                      className="text-xs text-center text-gray-500 dark:text-[#80a89a] hover:underline py-1 cursor-pointer"
                    >
                      {locale === "en" ? "Back to Login" : "العودة لتسجيل الدخول"}
                    </button>
                  </div>
                </>
              )}

              {/* ============================================================ */}
              {/* FORM TYPE 2B: SUPER ADMIN BIN RECOVERY (PASSWORD AUTHENTICATED) */}
              {/* ============================================================ */}
              {uiState === "SUPER_ADMIN_BIN_RECOVERY" && (
                <>
                  <div className="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/40 rounded-xl text-amber-800 dark:text-amber-200 text-xs leading-relaxed">
                    {locale === "en"
                      ? "Enter your current password to verify identity and assign a new Security BIN code."
                      : "يرجى تأكيد هويتك بإدخال كلمة المرور الحالية وتعيين رمز الأمان الجديد."}
                  </div>

                  {/* 1. Current Password */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-700 dark:text-[#daf1de] block">
                      {locale === "en" ? "Current Password" : "كلمة المرور الحالية"}
                    </label>
                    <div className="relative">
                      <Lock className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-[#5e8674] ${isRTL ? "right-3" : "left-3"}`} />
                      <input
                        type="password"
                        required
                        autoFocus
                        autoComplete="current-password"
                        value={recoveryCurrentPassword}
                        onChange={(e) => setRecoveryCurrentPassword(e.target.value)}
                        placeholder="••••••••"
                        className={`w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 text-gray-900 dark:text-[#daf1de] placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 ${
                          isRTL ? "pr-9 pl-3" : "pl-9 pr-3"
                        }`}
                      />
                    </div>
                  </div>

                  {/* 2. New Security BIN */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-700 dark:text-[#daf1de] block">
                      {locale === "en" ? "New Security BIN (Min 4 digits)" : "رمز الأمان الجديد (4 أرقام على الأقل)"}
                    </label>
                    <div className="relative">
                      <Key className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-[#5e8674] ${isRTL ? "right-3" : "left-3"}`} />
                      <input
                        type="password"
                        required
                        value={recoveryNewBin}
                        onChange={(e) => setRecoveryNewBin(e.target.value)}
                        placeholder="••••••"
                        maxLength={10}
                        className={`w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 text-gray-900 dark:text-[#daf1de] placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 font-mono ${
                          isRTL ? "pr-9 pl-3" : "pl-9 pr-3"
                        }`}
                      />
                    </div>
                  </div>

                  {/* 3. Confirm New Security BIN */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-700 dark:text-[#daf1de] block">
                      {locale === "en" ? "Confirm New Security BIN" : "تأكيد رمز الأمان الجديد"}
                    </label>
                    <div className="relative">
                      <Key className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-[#5e8674] ${isRTL ? "right-3" : "left-3"}`} />
                      <input
                        type="password"
                        required
                        value={recoveryConfirmBin}
                        onChange={(e) => setRecoveryConfirmBin(e.target.value)}
                        placeholder="••••••"
                        maxLength={10}
                        className={`w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 text-gray-900 dark:text-[#daf1de] placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 font-mono ${
                          isRTL ? "pr-9 pl-3" : "pl-9 pr-3"
                        }`}
                      />
                    </div>
                  </div>

                  {/* Submit Button */}
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={isSubmitting}
                    className="w-full text-xs py-2.5 rounded-xl font-bold bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer mt-2"
                  >
                    {isSubmitting
                      ? locale === "en"
                        ? "Updating..."
                        : "جاري التحديث..."
                      : locale === "en"
                      ? "Save & Update Security BIN"
                      : "حفظ وتحديث رمز الأمان"}
                  </Button>

                  {/* Cancel / Return Button */}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setError("");
                      setSuccessMessage("");
                      setUiState("SUPER_ADMIN_BIN_REQUIRED");
                    }}
                    className="w-full text-xs py-2.5 rounded-xl font-semibold border-gray-300 dark:border-[#14423b] text-gray-700 dark:text-[#daf1de] hover:bg-gray-100 dark:hover:bg-[#0a2e28] cursor-pointer"
                  >
                    {locale === "en" ? "Cancel" : "إلغاء"}
                  </Button>
                </>
              )}

              {/* ============================================================ */}
              {/* FORM TYPE 3: CREATE FIRST SUPER ADMIN ACCOUNT */}
              {/* Fields in exact requested order: */}
              {/* 1. Email */}
              {/* 2. Username */}
              {/* 3. Password */}
              {/* 4. Confirm Password */}
              {/* 5. BIN */}
              {/* 6. Confirm BIN */}
              {/* ============================================================ */}
              {uiState === "SYSTEM_BOOTSTRAPPED_FALSE_NO_SESSION" && (
                <>
                  {/* 1. Email */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-700 dark:text-[#daf1de] block">
                      {locale === "en" ? "Email Address" : "الإيميل"}
                    </label>
                    <div className="relative">
                      <Mail className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-[#5e8674] ${isRTL ? "right-3" : "left-3"}`} />
                      <input
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="admin@yourcompany.com"
                        className={`w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 text-gray-900 dark:text-[#daf1de] placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 ${
                          isRTL ? "pr-9 pl-3" : "pl-9 pr-3"
                        }`}
                      />
                    </div>
                  </div>

                  {/* 2. Username */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-700 dark:text-[#daf1de] block">
                      {locale === "en" ? "Username" : "يوزر نيم"}
                    </label>
                    <div className="relative">
                      <User className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-[#5e8674] ${isRTL ? "right-3" : "left-3"}`} />
                      <input
                        type="text"
                        required
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="superadmin"
                        className={`w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 text-gray-900 dark:text-[#daf1de] placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 font-mono ${
                          isRTL ? "pr-9 pl-3" : "pl-9 pr-3"
                        }`}
                      />
                    </div>
                  </div>

                  {/* 3. Password */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-700 dark:text-[#daf1de] block">
                      {locale === "en" ? "Password" : "الباسوورد"}
                    </label>
                    <div className="relative">
                      <Lock className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-[#5e8674] ${isRTL ? "right-3" : "left-3"}`} />
                      <input
                        type="password"
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        className={`w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 text-gray-900 dark:text-[#daf1de] placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 ${
                          isRTL ? "pr-9 pl-3" : "pl-9 pr-3"
                        }`}
                      />
                    </div>
                  </div>

                  {/* 4. Confirm Password */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-700 dark:text-[#daf1de] block">
                      {locale === "en" ? "Confirm Password" : "تأكيد الباسوورد"}
                    </label>
                    <div className="relative">
                      <Lock className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-[#5e8674] ${isRTL ? "right-3" : "left-3"}`} />
                      <input
                        type="password"
                        required
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="••••••••"
                        className={`w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 text-gray-900 dark:text-[#daf1de] placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 ${
                          isRTL ? "pr-9 pl-3" : "pl-9 pr-3"
                        }`}
                      />
                    </div>
                  </div>

                  {/* 5. BIN */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-700 dark:text-[#daf1de] block">
                      {locale === "en" ? "Security BIN (Min 4 digits)" : "BIN"}
                    </label>
                    <div className="relative">
                      <Key className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-[#5e8674] ${isRTL ? "right-3" : "left-3"}`} />
                      <input
                        type="password"
                        required
                        value={bin}
                        onChange={(e) => setBin(e.target.value)}
                        placeholder="••••••"
                        maxLength={10}
                        className={`w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 text-gray-900 dark:text-[#daf1de] placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 font-mono ${
                          isRTL ? "pr-9 pl-3" : "pl-9 pr-3"
                        }`}
                      />
                    </div>
                  </div>

                  {/* 6. Confirm BIN */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-700 dark:text-[#daf1de] block">
                      {locale === "en" ? "Confirm Security BIN" : "تأكيد BIN"}
                    </label>
                    <div className="relative">
                      <Key className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-[#5e8674] ${isRTL ? "right-3" : "left-3"}`} />
                      <input
                        type="password"
                        required
                        value={confirmBin}
                        onChange={(e) => setConfirmBin(e.target.value)}
                        placeholder="••••••"
                        maxLength={10}
                        className={`w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 text-gray-900 dark:text-[#daf1de] placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 font-mono ${
                          isRTL ? "pr-9 pl-3" : "pl-9 pr-3"
                        }`}
                      />
                    </div>
                  </div>

                  {/* Create Account Button */}
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={isSubmitting}
                    className="w-full text-xs py-2.5 rounded-xl font-bold bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer mt-2"
                  >
                    {isSubmitting
                      ? locale === "en"
                        ? "Processing..."
                        : "جاري المعالجة..."
                      : locale === "en"
                      ? "Create Account"
                      : "إنشاء حساب"}
                  </Button>
                </>
              )}
            </form>
          )}
        </div>
      </main>

      {pendingRememberIdentifier && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true" aria-labelledby="remember-admin-title" dir={isRTL ? "rtl" : "ltr"}>
          <div className="w-full max-w-sm space-y-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-[#244746] dark:bg-[#0b2924]">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"><User className="h-6 w-6" /></div>
            <div className="text-center"><h2 id="remember-admin-title" className="text-base font-extrabold">{locale === "en" ? "Save this account?" : "حفظ تسجيل الدخول؟"}</h2><p className="mt-2 text-xs leading-6 text-gray-600 dark:text-[#b3d5bd]">{locale === "en" ? "Save the username on this device for quicker sign-in next time. Your password will never be saved." : "احفظ اسم المستخدم على هذا الجهاز لتسهيل الدخول لاحقًا. لن نحفظ كلمة المرور."}</p><p className="mt-2 truncate text-sm font-bold" dir="auto">{pendingRememberIdentifier}</p></div>
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="primary" onClick={() => void finishSuccessfulLogin(pendingRememberIdentifier, true)} className="w-full text-xs py-2.5 rounded-xl font-bold">{locale === "en" ? "Yes, save" : "نعم، احفظ"}</Button>
              <Button type="button" variant="outline" onClick={() => void finishSuccessfulLogin(pendingRememberIdentifier, false)} className="w-full text-xs py-2.5 rounded-xl font-bold">{locale === "en" ? "Not now" : "ليس الآن"}</Button>
            </div>
          </div>
        </div>
      )}
      {/* Footer */}
      <footer className="text-center text-[11px] text-gray-400 dark:text-[#5e8674]">
        {t("copyright")}
      </footer>
    </div>
  );
};
