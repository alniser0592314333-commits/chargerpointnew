import React, { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "../ui/Button";
import {
  aiSettingsService,
  type SarahAIProviderConfig,
  type SarahAIGenerationConfig,
} from "../../services/ai/aiSettingsService";
import { createSarahIntegrationPackage, SARAH_INTEGRATION_PACKAGE_FORMAT, SARAH_INTEGRATION_PACKAGE_VERSION } from "../../application/ai/sarahIntegrationPackage";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

const errorMessage = (code: string, locale: "ar" | "en") => {
  const messages: Record<string, [string, string]> = {
    AUTH_SESSION_REQUIRED: ["الجلسة غير صالحة. سجّل الدخول من جديد.", "Your session is unavailable. Sign in again."],
    AI_MANAGE_PERMISSION_REQUIRED: ["ما عندك صلاحية إدارة إعدادات الذكاء الاصطناعي.", "You do not have permission to manage AI settings."],
    PROVIDER_CONFIGURATION_REJECTED: ["الخادم رفض إعدادات المزود. راجع القيم المدخلة.", "The server rejected the provider settings. Review the supplied values."],
    INVALID_INTEGRATION_PACKAGE: ["ملف التكامل غير صالح أو غير مدعوم.", "The integration package is invalid or unsupported."],
    IMPORT_PROVIDER_NOT_IMPLEMENTED: ["الحزمة لمزود غير مفعّل في هذا الإصدار. أضف Adapter للمزود أولًا.", "The package uses a provider that is not installed in this version. Add its adapter first."],
    ADMIN_SESSION_UNAVAILABLE: ["تعذر التحقق من جلسة الأدمن الحالية.", "The current administrator session could not be verified."],
    PROVIDER_NOT_CONFIGURED: ["احفظ إعدادات Gemini ومفتاح API أولًا.", "Save the Gemini settings and API key first."],
    API_KEY_REQUIRED: ["أدخل Gemini API Key لأول مرة.", "Enter a Gemini API key to configure the provider."],
    INVALID_API_KEY_FORMAT: ["صيغة مفتاح API غير صحيحة.", "The API key format is invalid."],
    INVALID_PROVIDER_CONFIGURATION: ["راجع اسم الموديل وإعدادات التوليد.", "Check the model ID and generation settings."],
    PROVIDER_NOT_IMPLEMENTED: ["هذا المزود غير مفعّل في التطبيق حتى الآن.", "This provider adapter is not implemented yet."],
    GEMINI_API_KEY_REJECTED: ["Google رفض مفتاح API. تأكد من المفتاح وصلاحياته.", "Google rejected the API key. Check the key and its access."],
    GEMINI_MODEL_NOT_FOUND: ["الموديل غير موجود أو غير متاح لهذا المفتاح.", "The model was not found or is unavailable to this key."],
    GEMINI_QUOTA_OR_RATE_LIMIT: ["وصلت إلى حد الاستخدام أو معدل الطلبات لدى Gemini.", "Gemini quota or rate limit was reached."],
    GEMINI_CONNECTION_TIMEOUT: ["انتهت مهلة الاتصال بـ Gemini.", "The Gemini connection timed out."],
    GEMINI_PROVIDER_UNAVAILABLE: ["خدمة Gemini غير متاحة حاليًا.", "Gemini is temporarily unavailable."],
    GEMINI_CONNECTION_FAILED: ["تعذر الاتصال بـ Gemini.", "Could not connect to Gemini."],
    AI_SETTINGS_NETWORK_ERROR: ["تعذر الاتصال بخادم إعدادات سارة.", "Could not reach the Sarah settings service."],
    AI_SETTINGS_INVALID_RESPONSE: ["وصل رد غير مفهوم من خادم الإعدادات.", "The settings service returned an invalid response."],
    SUPABASE_NOT_CONFIGURED: ["إعدادات الاتصال بالخادم غير مكتملة.", "The server connection is not configured."],
  };
  const match = messages[code];
  return match ? match[locale === "ar" ? 0 : 1] : (locale === "ar" ? "حدث خطأ غير متوقع أثناء حفظ الإعدادات." : "An unexpected error occurred while saving settings.");
};

export const AISettingsSection: React.FC<{ locale: "ar" | "en" }> = ({ locale }) => {
  const [config, setConfig] = useState<SarahAIProviderConfig | null>(null);
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [temperature, setTemperature] = useState("0.2");
  const [maxOutputTokens, setMaxOutputTokens] = useState("2048");
  const [timeoutMs, setTimeoutMs] = useState("30000");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connection, setConnection] = useState<"connected" | "failed" | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const isArabic = locale === "ar";

  const loadConfig = async () => {
    setLoading(true);
    setError("");
    try {
      const saved = await aiSettingsService.read();
      setConfig(saved);
      if (saved) {
        setModelId(saved.modelId);
        setTemperature(String(saved.generationConfig.temperature ?? 0.2));
        setMaxOutputTokens(String(saved.generationConfig.maxOutputTokens ?? 2048));
        setTimeoutMs(String(saved.generationConfig.timeoutMs ?? 30000));
      }
    } catch (cause) {
      setError(errorMessage(cause instanceof Error ? cause.message : "", locale));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadConfig();
  }, []);

  const buildGenerationConfig = (): SarahAIGenerationConfig | null => {
    const t = Number(temperature);
    const tokens = Number(maxOutputTokens);
    const timeout = Number(timeoutMs);
    if (!Number.isFinite(t) || t < 0 || t > 2 ||
      !Number.isInteger(tokens) || tokens < 1 || tokens > 65536 ||
      !Number.isInteger(timeout) || timeout < 5000 || timeout > 120000) return null;
    return { temperature: t, maxOutputTokens: tokens, timeoutMs: timeout };
  };

  const save = async () => {
    const cleanModel = modelId.trim();
    const generationConfig = buildGenerationConfig();
    if (!cleanModel || !generationConfig) {
      setError(isArabic
        ? "أدخل اسم الموديل، وتأكد أن درجة الحرارة بين 0 و2، والرموز والمهلة ضمن الحدود."
        : "Enter a model ID and keep temperature, output tokens, and timeout within the allowed ranges.");
      return;
    }
    if (!config?.hasApiKey && !apiKey.trim()) {
      setError(errorMessage("API_KEY_REQUIRED", locale));
      return;
    }

    setSaving(true);
    setError("");
    setNotice("");
    setConnection(null);
    try {
      await aiSettingsService.save({
        providerId: "gemini",
        modelId: cleanModel,
        generationConfig,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setApiKey("");
      await loadConfig();
      setNotice(isArabic ? "تم حفظ إعدادات Gemini بأمان على الخادم." : "Gemini settings were saved securely on the server.");
    } catch (cause) {
      setError(errorMessage(cause instanceof Error ? cause.message : "", locale));
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setError("");
    setNotice("");
    setConnection(null);
    try {
      const result = await aiSettingsService.test();
      if (result.connected) {
        setConnection("connected");
        setNotice(isArabic ? "الاتصال بـ Gemini ناجح والموديل متاح." : "Gemini connection succeeded and the model is available.");
      } else {
        setConnection("failed");
        setError(errorMessage(result.error || "", locale));
      }
    } catch (cause) {
      setConnection("failed");
      setError(errorMessage(cause instanceof Error ? cause.message : "", locale));
    } finally {
      setTesting(false);
    }
  };

  const clearConfig = async () => {
    const confirmed = window.confirm(isArabic
      ? "سيتم حذف مفتاح Gemini وإعداداته المحفوظة من الخادم. هل تريد المتابعة؟"
      : "This removes the saved Gemini key and provider settings from the server. Continue?");
    if (!confirmed) return;

    setClearing(true);
    setError("");
    setNotice("");
    try {
      await aiSettingsService.clear();
      setConfig(null);
      setModelId("");
      setApiKey("");
      setConnection(null);
      setNotice(isArabic ? "تم حذف إعدادات المزود ومفتاحه من الخادم." : "The provider settings and key were removed from the server.");
    } catch (cause) {
      setError(errorMessage(cause instanceof Error ? cause.message : "", locale));
    } finally {
      setClearing(false);
    }
  };

  const exportPackage = () => {
    if (!config) return;
    const integrationPackage = createSarahIntegrationPackage(config);
    const blob = new Blob([JSON.stringify(integrationPackage, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "chargerpointnew-sarah-integration.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const importPackage = async (file?: File) => {
    if (!file) return;
    setError("");
    setNotice("");
    try {
      if (file.size > 256 * 1024) throw new Error("INVALID_INTEGRATION_PACKAGE");
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
      if (parsed.format !== SARAH_INTEGRATION_PACKAGE_FORMAT ||
        parsed.schemaVersion !== SARAH_INTEGRATION_PACKAGE_VERSION ||
        !parsed.provider || typeof parsed.provider !== "object" || Array.isArray(parsed.provider)) {
        throw new Error("INVALID_INTEGRATION_PACKAGE");
      }
      const importedProvider = parsed.provider as Record<string, unknown>;
      if (importedProvider.providerId !== "gemini") {
        throw new Error("IMPORT_PROVIDER_NOT_IMPLEMENTED");
      }
      const importedModel = typeof importedProvider.modelId === "string"
        ? importedProvider.modelId.trim()
        : "";
      const rawGenerationConfig = importedProvider.generationConfig;
      const importedConfig = rawGenerationConfig && typeof rawGenerationConfig === "object" && !Array.isArray(rawGenerationConfig)
        ? rawGenerationConfig as Record<string, unknown>
        : {};
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(importedModel) ||
        typeof importedConfig !== "object" || Array.isArray(importedConfig)) {
        throw new Error("INVALID_INTEGRATION_PACKAGE");
      }
      const nextTemperature = Number(importedConfig.temperature ?? 0.2);
      const nextTokens = Number(importedConfig.maxOutputTokens ?? 2048);
      const nextTimeout = Number(importedConfig.timeoutMs ?? 30000);
      if (!Number.isFinite(nextTemperature) || nextTemperature < 0 || nextTemperature > 2 ||
        !Number.isInteger(nextTokens) || nextTokens < 1 || nextTokens > 65536 ||
        !Number.isInteger(nextTimeout) || nextTimeout < 5000 || nextTimeout > 120000) {
        throw new Error("INVALID_INTEGRATION_PACKAGE");
      }
      setModelId(importedModel);
      setTemperature(String(nextTemperature));
      setMaxOutputTokens(String(nextTokens));
      setTimeoutMs(String(nextTimeout));
      setApiKey("");
      setNotice(isArabic
        ? "تم تحميل إعدادات الحزمة. راجعها ثم احفظها؛ مفتاح API غير موجود في ملف التصدير ويجب إدخاله بشكل منفصل."
        : "Package settings loaded. Review and save them; the API key is intentionally excluded and must be entered separately.");
    } catch (cause) {
      setError(errorMessage(cause instanceof Error ? cause.message : "INVALID_INTEGRATION_PACKAGE", locale));
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  return (
    <section className="space-y-5 pb-8" dir={isArabic ? "rtl" : "ltr"}>
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-[#0c312b] flex items-center justify-center text-emerald-700 dark:text-[#8eb698] shrink-0">
          <Sparkles className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-bold text-gray-900 dark:text-[#daf1de]">
            {isArabic ? "إعدادات الذكاء الاصطناعي" : "Artificial Intelligence Settings"}
          </h2>
          <p className="text-xs leading-6 text-gray-500 dark:text-[#8eb698] mt-1">
            {isArabic
              ? "إدارة مزود سارة والموديل ومفتاح الاتصال، بشكل مستقل عن منطق سارة وأدوات التطبيق."
              : "Configure Sarah's provider, model, and connection key independently from Sarah's tools and application logic."}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="py-8 text-center text-sm text-gray-500 dark:text-[#8eb698]">
          {isArabic ? "جاري تحميل إعدادات المزود..." : "Loading provider settings..."}
        </div>
      ) : (
        <>
          <div className="space-y-4">
            <div className="rounded-xl border border-gray-200 dark:border-[#17443c] p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="w-8 h-8 rounded-lg bg-gray-100 dark:bg-[#0c312b] flex items-center justify-center">
                    <span className="text-sm font-bold text-gray-800 dark:text-[#daf1de]">G</span>
                  </span>
                  <div>
                    <div className="text-sm font-semibold text-gray-900 dark:text-[#daf1de]">Google Gemini</div>
                    <div className="text-xs text-gray-500 dark:text-[#8eb698]">
                      {isArabic ? "المزود الحالي" : "Current provider"}
                    </div>
                  </div>
                </div>
                <span className="text-xs text-gray-500 dark:text-[#8eb698]">
                  {config?.enabled && config.hasApiKey
                    ? (isArabic ? "الإعداد محفوظ" : "Configured")
                    : (isArabic ? "غير مكتمل" : "Not configured")}
                </span>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 dark:text-[#daf1de] mb-1">
                  {isArabic ? "عنوان API" : "API Endpoint"}
                </label>
                <input
                  readOnly
                  value={GEMINI_ENDPOINT}
                  className="w-full rounded-lg border border-gray-200 dark:border-[#17443c] bg-gray-50 dark:bg-[#071f1b] px-3 py-2 text-xs text-gray-600 dark:text-[#8eb698]"
                  dir="ltr"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 dark:text-[#daf1de] mb-1">
                  {isArabic ? "اسم الموديل (Model ID)" : "Model ID"}
                </label>
                <input
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                  placeholder="gemini-model-id"
                  autoComplete="off"
                  spellCheck={false}
                  dir="ltr"
                  className="w-full rounded-lg border border-gray-200 dark:border-[#17443c] bg-white dark:bg-[#071f1b] px-3 py-2.5 text-sm text-gray-900 dark:text-[#daf1de] outline-none focus:ring-2 focus:ring-emerald-600/30"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 dark:text-[#daf1de] mb-1">
                  {isArabic ? "Gemini API Key" : "Gemini API Key"}
                </label>
                <div className="flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-gray-400 shrink-0" />
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={config?.hasApiKey
                      ? (isArabic ? "مفتاح جديد اختياري لتغيير المفتاح الحالي" : "Optional new key to rotate the saved key")
                      : (isArabic ? "أدخل مفتاح Gemini API" : "Enter Gemini API key")}
                    autoComplete="new-password"
                    spellCheck={false}
                    dir="ltr"
                    className="min-w-0 flex-1 rounded-lg border border-gray-200 dark:border-[#17443c] bg-white dark:bg-[#071f1b] px-3 py-2.5 text-sm text-gray-900 dark:text-[#daf1de] outline-none focus:ring-2 focus:ring-emerald-600/30"
                  />
                </div>
                <p className="text-[11px] leading-5 text-gray-500 dark:text-[#8eb698] mt-1">
                  {config?.hasApiKey
                    ? (isArabic ? "المفتاح الحالي لا يمكن عرضه أو استرجاعه. اترك الحقل فارغًا للاحتفاظ به." : "The saved key cannot be viewed or retrieved. Leave this blank to keep it.")
                    : (isArabic ? "المفتاح يُرسل للخادم مباشرة ولا يُحفظ في المتصفح أو ملف APK." : "The key is sent to the server and is never stored in the browser or APK.")}
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 dark:border-[#17443c] p-4 space-y-3">
              <h3 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">
                {isArabic ? "إعدادات الاستجابة" : "Generation Settings"}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 dark:text-[#8eb698] mb-1">Temperature (0–2)</label>
                  <input type="number" min="0" max="2" step="0.1" value={temperature} onChange={(e) => setTemperature(e.target.value)} dir="ltr" className="w-full rounded-lg border border-gray-200 dark:border-[#17443c] bg-white dark:bg-[#071f1b] px-3 py-2 text-sm text-gray-900 dark:text-[#daf1de]" />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 dark:text-[#8eb698] mb-1">Max Output Tokens</label>
                  <input type="number" min="1" max="65536" step="1" value={maxOutputTokens} onChange={(e) => setMaxOutputTokens(e.target.value)} dir="ltr" className="w-full rounded-lg border border-gray-200 dark:border-[#17443c] bg-white dark:bg-[#071f1b] px-3 py-2 text-sm text-gray-900 dark:text-[#daf1de]" />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 dark:text-[#8eb698] mb-1">Timeout (ms)</label>
                  <input type="number" min="5000" max="120000" step="1000" value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} dir="ltr" className="w-full rounded-lg border border-gray-200 dark:border-[#17443c] bg-white dark:bg-[#071f1b] px-3 py-2 text-sm text-gray-900 dark:text-[#daf1de]" />
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-xl bg-gray-50 dark:bg-[#071f1b] p-4 flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 text-emerald-700 dark:text-[#8eb698] shrink-0 mt-0.5" />
            <div className="text-xs leading-6 text-gray-600 dark:text-[#8eb698]">
              {isArabic
                ? "الحماية: مفتاح Gemini محفوظ داخل Supabase Vault، ولا يرجع للواجهة بعد الحفظ. الاتصال بالموديل يتم من الخادم، وليس من APK أو المتصفح. ملف التصدير لا يحتوي المفتاح."
                : "Security: the Gemini key is stored in Supabase Vault and is never returned to the UI. Model requests run server-side, not from the APK or browser. Export files never contain the key."}
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-300">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          {notice && (
            <div className="flex items-start gap-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/20 p-3 text-sm text-emerald-800 dark:text-emerald-200">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{notice}</span>
            </div>
          )}
          {connection === "connected" && (
            <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">
              {isArabic ? "حالة الاتصال: متصل" : "Connection status: Connected"}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void save()} isLoading={saving} disabled={loading || testing || clearing}>
              {isArabic ? "حفظ الإعدادات" : "Save Settings"}
            </Button>
            <Button type="button" variant="outline" onClick={() => void testConnection()} isLoading={testing} disabled={!config?.hasApiKey || saving || clearing}>
              <RefreshCw className="w-4 h-4" />
              {isArabic ? "اختبار الاتصال" : "Test Connection"}
            </Button>
            {config && (
              <Button type="button" variant="outline" onClick={exportPackage} disabled={saving || clearing}>
                <Download className="w-4 h-4" />
                {isArabic ? "تصدير حزمة التكامل" : "Export Integration Package"}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => importInputRef.current?.click()} disabled={saving || clearing}>
              <Upload className="w-4 h-4" />
              {isArabic ? "استيراد حزمة التكامل" : "Import Integration Package"}
            </Button>
            <input
              ref={importInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(event) => void importPackage(event.target.files?.[0])}
            />
            {config && (
              <Button type="button" variant="danger" onClick={() => void clearConfig()} isLoading={clearing} disabled={saving || testing}>
                <Trash2 className="w-4 h-4" />
                {isArabic ? "حذف إعدادات المزود" : "Remove Provider"}
              </Button>
            )}
          </div>

          <p className="text-[11px] leading-5 text-gray-500 dark:text-[#8eb698]">
            {isArabic
              ? "حزمة التكامل الحالية تصدّر تعريف سارة وقواعد الربط وإعدادات الموديل غير السرية. مخططات أدوات التشغيل ستُضاف للحزمة بعد تنفيذ كل مجموعة أدوات واختبارها؛ لذلك لا تعتبر هذه النسخة تصديرًا نهائيًا لكل وظائف سارة."
              : "The current package exports Sarah's integration contract and non-secret model profile. Operational tool schemas will be added as each tool group is implemented and tested, so this foundation package is not yet a complete export of every Sarah capability."}
          </p>
        </>
      )}
    </section>
  );
};
