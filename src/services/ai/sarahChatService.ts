import { config } from "../../config/env";
import { getFreshSupabaseAuthToken, getStoredSupabaseAuthSession } from "../supabase/client";

export interface SarahPendingBinAction {
  token: string;
  name: string;
  args: Record<string, unknown>;
  actionRequestId: string;
}

export interface SarahPartialProgressStep {
  capability: string;
  status: "succeeded" | "failed" | "not_executed" | "pending";
  reasonCode?: string;
}

export class SarahPartialTaskError extends Error {
  readonly partialSummary: string;
  readonly errorCode: string;
  constructor(errorCode: string, partialSummary: string) {
    super(errorCode);
    this.name = "SarahPartialTaskError";
    this.errorCode = errorCode;
    this.partialSummary = partialSummary;
  }
}

const formatPartialProgress = (value: unknown): string | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawSteps = (value as Record<string, unknown>).steps;
  if (!Array.isArray(rawSteps)) return null;
  const labels: Record<string, string> = {
    lookup_customers: "البحث عن العملاء",
    get_customer_orders: "قراءة الطلبات",
    create_order_for_customer: "إنشاء الطلب",
    add_items_to_order: "إضافة عناصر للطلب",
    deliver_order_item: "تسليم العنصر",
    record_customer_payment: "تسجيل الدفعة",
    record_and_approve_customer_payment: "تسجيل واعتماد الدفعة",
    approve_payment_submission: "اعتماد الدفعة المعلّقة",
    reject_payment_submission: "رفض الدفعة المعلّقة",
    adjust_customer_finances: "التعديل المالي",
    create_customer_goal: "إنشاء الهدف",
    update_customer_goal: "تعديل الهدف",
    approve_customer_goal_request: "اعتماد طلب الهدف",
    send_sms: "إرسال الرسالة النصية",
    update_business_hours: "تعديل ساعات العمل",
    update_jawwal_pay_recipient: "تعديل رقم جوال باي",
    get_customer_profile: "قراءة ملف العميل",
    lookup_customer_accounts: "البحث عن حساب العميل",
    set_customer_active_status: "تغيير حالة العميل",
    update_customer_profile: "تعديل بيانات العميل",
    update_customer_protected_settings: "تعديل إعدادات العميل المحمية",
    create_device_type: "إضافة نوع جهاز",
    update_device_type: "تعديل نوع جهاز",
    retire_device_type: "إيقاف نوع جهاز",
    create_customer: "إضافة عميل",
    get_device_catalog: "قراءة قائمة الأجهزة",
    get_financial_summary: "قراءة الملخص المالي",
    list_pending_payments: "قراءة الدفعات المعلّقة",
    list_customers_above_debt_threshold: "قراءة العملاء المتجاوزين حد الدين",
    get_customer_financial_summary: "قراءة ملخص العميل المالي",
    get_customer_financial_history: "قراءة السجل المالي للعميل",
    get_business_day_orders: "قراءة طلبات اليوم",
    renumber_day_orders: "إعادة ترتيب أرقام الطلبات",
    create_order_with_items: "إنشاء طلب بعناصره",
    add_item_to_existing_order: "إضافة عنصر إلى طلب قائم",
    cancel_order_item: "إلغاء عنصر من الطلب",
    cancel_order: "إلغاء الطلب",
    list_customer_history_requests: "قراءة طلبات سجل العملاء",
    review_customer_history_request: "مراجعة طلب سجل عميل",
    get_customer_goal_proposal: "قراءة مقترح الهدف",
    approve_goal_request: "اعتماد طلب هدف",
    reject_goal_request: "رفض طلب هدف",
    cancel_customer_goal: "إلغاء هدف العميل",
    review_goal_cancellation: "مراجعة إلغاء الهدف",
    list_subordinate_admins: "قراءة حسابات الإداريين",
    get_admin_custom_permissions: "قراءة صلاحيات الإداري",
    get_admin_audit_logs: "قراءة سجل التدقيق",
    set_admin_permission: "تعديل صلاحية إداري",
    suspend_admin: "إيقاف حساب إداري",
    activate_admin: "تفعيل حساب إداري",
    get_business_hours_settings: "قراءة ساعات العمل",
    get_local_sync_status: "قراءة حالة المزامنة",
    request_manual_sync: "تنفيذ المزامنة اليدوية",
    get_sarah_ai_provider_settings: "قراءة إعدادات سارة",
    update_sarah_ai_provider_settings: "تعديل إعدادات سارة",
    test_sarah_ai_provider_connection: "فحص اتصال سارة",
    clear_sarah_ai_provider_settings: "تعطيل إعدادات سارة",
    get_goals_overview: "قراءة الأهداف وطلباتها",
  };
  const groups: Record<SarahPartialProgressStep["status"], string[]> = {
    succeeded: [], failed: [], not_executed: [], pending: [],
  };
  const failureReasons: Record<string, string> = {
    AI_CAPABILITY_PERMISSION_REQUIRED: "الصلاحية المطلوبة غير متاحة",
    AI_CAPABILITY_PERMISSION_REVOKED: "تم رفض العملية بسبب الصلاحيات",
    AI_CAPABILITY_TARGET_NOT_FOUND: "العميل أو الطلب أو العنصر غير موجود",
    AI_CAPABILITY_STALE_DATA: "البيانات تغيرت منذ قراءتها",
    AI_CAPABILITY_DATABASE_RULE_REJECTED: "قاعدة عمل في قاعدة البيانات منعت التنفيذ",
    AI_CAPABILITY_CONFLICT: "يوجد تعارض في حالة السجل",
    AI_CAPABILITY_INPUT_INVALID: "البيانات المدخلة غير صحيحة",
    BIN_REQUIRED: "تحتاج إلى تأكيد أمني",
    BIN_INVALID: "رمز التأكيد غير صحيح",
    ACTION_FAILED: "تعذر تنفيذ العملية لسبب غير محدد",
  };
  for (const item of rawSteps) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const step = item as Record<string, unknown>;
    const capability = typeof step.capability === "string" ? step.capability : "";
    const status = step.status;
    if (!capability || typeof status !== "string" || !(status in groups)) continue;
    const label = labels[capability] || "عملية أخرى";
    if (status === "failed") {
      const reasonCode = typeof step.reasonCode === "string" ? step.reasonCode : "";
      groups.failed.push(`${label}${failureReasons[reasonCode] ? `: ${failureReasons[reasonCode]}` : ""}`);
    } else {
      groups[status as SarahPartialProgressStep["status"]].push(label);
    }
  }
  if (!groups.succeeded.length && !groups.failed.length) return null;
  const lines = ["ملخص التنفيذ قبل التوقف:"];
  if (groups.succeeded.length) lines.push(`نجح: ${groups.succeeded.join("، ")}.`);
  if (groups.failed.length) lines.push(`فشل: ${groups.failed.join("، ")}.`);
  if (groups.not_executed.length) lines.push(`لم يُنفّذ بعد: ${groups.not_executed.join("، ")}.`);
  if (groups.pending.length) lines.push(`بانتظار التنفيذ: ${groups.pending.join("، ")}.`);
  lines.push("حُفظ تقدم المهمة. عند طلب «أعد المحاولة» سأستكمل الخطوات غير المكتملة فقط، ولن أعيد الخطوات الناجحة.");
  return lines.join("\n");
};

export interface SarahChatResponse {
  answer: string;
  modelId: string;
  requiresBin?: boolean;
  pendingAction?: SarahPendingBinAction;
  binError?: "BIN_INVALID";
  requiresLocalSms?: boolean;
  localSmsAction?: SarahPendingBinAction;
  requiresLocalSync?: boolean;
  localSyncAction?: "manual_sync";
  taskPending?: boolean;
  confirmationApplied?: boolean;
  retryAfterMs?: number;
}

export interface SarahLocalSyncContext {
  online: boolean;
  pendingCount: number;
  blockedCount: number;
  failedCount: number;
  binRequiredCount: number;
  lastPulledAt: string | null;
  recentErrorClasses: string[];
}

export interface SarahLocalSyncActionResult {
  action: "manual_sync";
  success: boolean;
  pushed?: number;
  pulled?: number;
  errorCode?: "NETWORK_OFFLINE" | "SYNC_ALREADY_IN_PROGRESS" | "SYNC_FAILED";
}

export interface SarahChatClientContext {
  localSyncContext?: SarahLocalSyncContext;
  localSyncActionResult?: SarahLocalSyncActionResult;
  localSmsActionResult?: { actionRequestId: string; submitted: boolean; parts?: number; subscriptionId?: number; errorCode?: string };
}

const endpoint = () => {
  if (!config.supabaseUrl || !config.supabaseAnonKey) throw new Error("SUPABASE_NOT_CONFIGURED");
  return `${config.supabaseUrl.replace(/\/+$/, "")}/functions/v1/sarah-ai-chat`;
};

const tokenSubject = (token: string): string => {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return "";
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
    return typeof payload.sub === "string" ? payload.sub : "";
  } catch {
    return "";
  }
};

export const sarahChatService = {
  async send(
    text: string,
    expectedAuthUserId: string,
    history: { role: "user" | "assistant"; text: string }[] = [],
    requestId?: string,
    bin?: string,
    clientContext?: SarahChatClientContext,
    confirmationAction?: SarahPendingBinAction,
    resumeTask = false,
  ): Promise<SarahChatResponse> {
    const clean = text.trim();
    if (!clean) throw new Error("TEXT_REQUIRED");
    if (clean.length > 20000) throw new Error("TEXT_TOO_LARGE");
    if (!expectedAuthUserId) throw new Error("AUTH_IDENTITY_REQUIRED");

    // Capture and re-check the selected Auth identity around token refresh.
    // Account switches can occur while getFreshSupabaseAuthToken awaits a refresh.
    const before = getStoredSupabaseAuthSession();
    if (before?.user?.id !== expectedAuthUserId) throw new Error("ACCOUNT_CHANGED");

    const session = await getFreshSupabaseAuthToken();
    if (!session.token) throw new Error(session.reason || "AUTH_SESSION_REQUIRED");

    const after = getStoredSupabaseAuthSession();
    if (tokenSubject(session.token) !== expectedAuthUserId || after?.user?.id !== expectedAuthUserId) {
      throw new Error("ACCOUNT_CHANGED");
    }

    const stableRequestId = requestId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)
      ? requestId
      : crypto.randomUUID();

    if (bin !== undefined && (!/^\d{4,}$/.test(bin) || bin.length > 32)) throw new Error("BIN_FORMAT_INVALID");

    const requestBody: Record<string, unknown> = {
      text: clean,
      history: history.slice(-20),
      requestId: stableRequestId,
    };
    // BIN is sent only as a separate transport field; never added to chat text/history.
    if (bin) requestBody.bin = bin;
    if (clientContext?.localSyncContext) requestBody.localSyncContext = clientContext.localSyncContext;
    if (clientContext?.localSyncActionResult) requestBody.localSyncActionResult = clientContext.localSyncActionResult;
    if (clientContext?.localSmsActionResult) requestBody.localSmsActionResult = clientContext.localSmsActionResult;
    if (confirmationAction) requestBody.confirmationAction = { token: confirmationAction.token };
    if (resumeTask) requestBody.resumeTask = true;

    let response: Response;
    try {
      response = await fetch(endpoint(), {
        method: "POST",
        headers: {
          apikey: config.supabaseAnonKey,
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json",
        },
        // Stable across retries of the same queued message; used only for server-side
        // action idempotency and never included in the Gemini prompt/history.
        body: JSON.stringify(requestBody),
        cache: "no-store",
      });
    } catch {
      throw new Error("AI_SETTINGS_NETWORK_ERROR");
    }

    let data: Record<string, unknown>;
    try {
      data = await response.json();
    } catch {
      throw new Error("AI_SETTINGS_INVALID_RESPONSE");
    }
    if (response.status === 202 && data.ok === true && data.pending === true) {
      return {
        answer: "",
        modelId: "",
        taskPending: true,
        retryAfterMs: typeof data.retryAfterMs === "number"
          ? Math.max(250, Math.min(data.retryAfterMs, 5000))
          : 900,
      };
    }
    if (response.status === 428 && data.error === "LOCAL_SYNC_REQUIRED" && data.action === "manual_sync") {
      return { answer: "", modelId: "", requiresLocalSync: true, localSyncAction: "manual_sync" };
    }
    if (response.status === 428 && data.error === "LOCAL_SMS_REQUIRED") {
      const pending = data.pendingAction && typeof data.pendingAction === "object" && !Array.isArray(data.pendingAction)
        ? data.pendingAction as Record<string, unknown> : null;
      const pendingAction = pending && typeof pending.token === "string" && pending.token.length <= 12000
        && pending.name === "send_sms" && pending.args && typeof pending.args === "object" && !Array.isArray(pending.args)
        && typeof pending.actionRequestId === "string"
        ? { token: pending.token, name: pending.name, args: pending.args as Record<string, unknown>, actionRequestId: pending.actionRequestId }
        : undefined;
      return { answer: "", modelId: "", requiresLocalSms: true, localSmsAction: pendingAction };
    }
    if (response.status === 428 && data.error === "BIN_REQUIRED") {
      const pending = data.pendingAction && typeof data.pendingAction === "object" && !Array.isArray(data.pendingAction)
        ? data.pendingAction as Record<string, unknown>
        : null;
      const pendingAction = pending
        && typeof pending.token === "string"
        && pending.token.length <= 12000
        && typeof pending.name === "string"
        && pending.args && typeof pending.args === "object" && !Array.isArray(pending.args)
        && typeof pending.actionRequestId === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pending.actionRequestId)
        ? {
            token: pending.token,
            name: pending.name,
            args: pending.args as Record<string, unknown>,
            actionRequestId: pending.actionRequestId,
          }
        : undefined;
      return { answer: "", modelId: "", requiresBin: true, pendingAction };
    }
    if (response.status === 403 && data.error === "BIN_INVALID") {
      return { answer: "", modelId: "", requiresBin: true, binError: "BIN_INVALID" };
    }
    if (!response.ok || data.ok !== true) {
      const code = typeof data.error === "string" ? data.error : "AI_REQUEST_FAILED";
      const reasonCode = typeof data.reasonCode === "string" ? data.reasonCode : "";
      const partialSummary = formatPartialProgress(data.partialProgress);
      if (partialSummary) throw new SarahPartialTaskError(code, partialSummary);
      const friendly: Record<string, string> = {
        METHOD_NOT_ALLOWED: "طريقة إرسال الطلب غير مدعومة.",
        SERVICE_UNAVAILABLE: "خدمة سارة غير متاحة مؤقتًا. لم يتم تأكيد تنفيذ العملية.",
        ADMIN_SESSION_UNAVAILABLE: "انتهت جلسة الأدمن أو لم تعد صالحة. سجّل الدخول مجددًا ثم تحقق من حالة العملية قبل تكرارها.",
        ADMIN_PERMISSION_CONTEXT_UNAVAILABLE: "تعذر التحقق من صلاحيات حسابك من قاعدة البيانات؛ أوقفت سارة التنفيذ احترازيًا.",
        AI_USE_PERMISSION_REQUIRED: "صلاحية استخدام سارة غير ممنوحة لهذا الحساب.",
        AI_PROVIDER_NOT_CONFIGURED: "إعدادات مزود الذكاء الاصطناعي غير مكتملة أو معطلة.",
        PROVIDER_CREDENTIAL_UNAVAILABLE: "تعذر الوصول إلى مفتاح مزود الذكاء الاصطناعي من التخزين الآمن.",
        AI_PROVIDER_CONFIGURATION_INVALID: "إعدادات النموذج تحتوي قيمة غير صالحة.",
        AI_REQUEST_TIMEOUT: "انتهت مهلة استجابة مزود الذكاء الاصطناعي. تم حفظ التقدم المؤكد.",
        AI_TASK_INTERRUPTED: "انقطع تنفيذ المهمة. تحقّق التقدم المحفوظ قبل استكمال الخطوات غير المنفذة.",
        AI_TASK_HISTORY_UNAVAILABLE: "تعذر قراءة سجل المهام السابقة؛ لم يتم تنفيذ أي إجراء بناءً على سجل غير متاح.",
        AI_CAPABILITY_INPUT_INVALID: "بيانات العملية غير مكتملة أو بصيغة غير صحيحة. راجع الحقول المطلوبة والقيمة المدخلة.",
        AI_CAPABILITY_NOT_FOUND: "لم يتم العثور على السجل أو العنصر المطلوب، أو أن مرجعه لم يعد صالحًا.",
        AI_CAPABILITY_UNAVAILABLE: "تعذر على قاعدة البيانات إكمال العملية بسبب خطأ داخلي. لم تعتبر سارة العملية ناجحة.",
        AI_DEVICE_DEFAULT_UNAVAILABLE: "تعذر العثور على نوع الهاتف الافتراضي (شاومي) في قائمة الأجهزة النشطة.",
        AI_TOOL_RATE_LIMITED: "رفض النظام تنفيذ المزيد من استدعاءات الأدوات ضمن هذه العملية.",
        AI_RATE_LIMITED: "وصل الطلب إلى حد الاستخدام المؤقت. حاول لاحقًا.",
        AI_DAILY_LIMIT_REACHED: "وصل الطلب إلى حد الاستخدام اليومي.",
        GEMINI_QUOTA_OR_RATE_LIMIT: "مزود Gemini رفض الطلب بسبب حد الاستخدام أو معدل الطلبات.",
        GEMINI_PROVIDER_UNAVAILABLE: "مزود Gemini غير متاح حاليًا.",
        GEMINI_REQUEST_REJECTED: "رفض مزود Gemini الطلب؛ راجع إعدادات النموذج أو صيغة الطلب.",
        AI_INVALID_PROVIDER_RESPONSE: "وصل رد غير مفهوم من مزود الذكاء الاصطناعي.",
        AI_EMPTY_RESPONSE: "لم يُرجع النموذج ردًا. لم تعتبر سارة أي خطوة غير مؤكدة ناجحة.",
        AI_PROVIDER_RESPONSE_TOO_LARGE: "رد مزود الذكاء الاصطناعي تجاوز الحجم المسموح.",
        AI_TOOL_UNKNOWN: "طلب النموذج أداة غير مسجلة؛ تم رفضها ولم تُنفذ.",
        AI_CAPABILITY_CONFLICT: "رفضت قاعدة البيانات العملية بسبب تعارض في حالة السجل أو شرط عمل. راجع الحالة الحالية قبل إعادة المحاولة.",
        AI_CAPABILITY_TARGET_NOT_FOUND: "لم يتم العثور على الهدف المطلوب. تأكد من العميل أو الطلب أو العنصر المحدد.",
        AI_CAPABILITY_STALE_DATA: "تغيرت البيانات منذ قراءتها؛ أعد تحميلها ثم أعد تحديد الإجراء المطلوب.",
        AI_CAPABILITY_DATABASE_RULE_REJECTED: "قاعدة البيانات رفضت العملية بسبب قاعدة عمل أو حالة غير مسموح بها.",
        AI_CAPABILITY_PERMISSION_REVOKED: "الصلاحية المطلوبة غير متاحة لهذا الحساب أو تم سحبها قبل التنفيذ.",
        BIN_REQUIRED: "تتطلب هذه الخطوة تأكيدًا أمنيًا عبر نافذة BIN.",
        BIN_INVALID: "رمز BIN غير صحيح. لم تُعتمد العملية بهذا الرمز.",
        BIN_CONFIRMATION_EXPIRED: "انتهت صلاحية طلب التأكيد الأمني؛ ابدأ العملية من جديد بعد التحقق من حالتها.",
        BIN_CONFIRMATION_INVALID: "تعذر التحقق من رمز التأكيد المرتبط بهذه العملية أو أنه لا يخص الجلسة الحالية.",
        LOCAL_SYNC_REQUIRED: "تتطلب هذه الخطوة تنفيذ مزامنة محلية على الجهاز.",
        SMS_CUSTOMER_NOT_FOUND: "لم يتم العثور على العميل المطلوب لإرسال الرسالة.",
        SMS_CUSTOMER_PHONE_MISSING: "لا يوجد رقم هاتف مسجل للعميل المحدد.",
        SMS_PHONE_INVALID: "رقم الهاتف غير صالح.",
        SMS_MESSAGE_INVALID: "نص الرسالة فارغ أو يتجاوز الحد المسموح.",
        REQUEST_TOO_LARGE: "حجم الطلب أكبر من الحد المسموح.",
        INVALID_REQUEST: "صيغة الطلب المرسل غير صحيحة.",
        INVALID_HISTORY: "تعذر قراءة سجل المحادثة بسبب بيانات غير صالحة.",
        HISTORY_TOO_LARGE: "سجل المحادثة أطول من الحد المسموح.",
        AI_TOOL_CALL_BATCH_NOT_SAFE: "تعذر ترتيب بعض خطوات الطلب بأمان. لم تُنفذ الخطوات غير المؤكدة؛ أعد المحاولة وسيُعاد فحص المتطلبات قبل التنفيذ.",
        AI_CAPABILITY_PERMISSION_REQUIRED: "صلاحيات حسابك الحالية لا تسمح بهذا الإجراء.",
        AI_TOOL_CALL_NOT_ALLOWED: "الأداة المطلوبة غير متاحة لهذا الحساب. لم يتم تنفيذ أي تغيير.",
        AI_TOOL_CALL_LIMIT_REACHED: "توقفت دورة التنفيذ قبل اكتمال جميع الخطوات. أعد متابعة الطلب نفسه؛ ستُراجع النتائج السابقة قبل إعادة أي عملية.",
        AI_CUSTOMER_NEEDS_DISAMBIGUATION: "وجدت أكثر من عميل مطابق. حدّد العميل المقصود قبل المتابعة.",
        AI_TASK_CHECKPOINT_UNAVAILABLE: "تعذر استعادة المهمة السابقة ضمن جلسة الدخول الحالية. لم أعد تنفيذ العمليات تلقائيًا؛ راجع حالة المهمة قبل إرسال طلب جديد.",
        AI_TASK_CHECKPOINT_INVALID: "تعذر التحقق من سجل متابعة المهمة. لم يتم اعتماد أي نتيجة غير مؤكدة.",
        AI_TASK_CHECKPOINT_WRITE_FAILED: "تعذر حفظ تقدم المهمة بأمان. يمكنك إعادة المحاولة؛ ستُراجع النتائج المحفوظة قبل تنفيذ أي خطوة مرة أخرى.",

        BIN_MUST_USE_SECURE_PROMPT: "لا ترسل رمز BIN داخل المحادثة. أدخله فقط في خانة التأكيد الأمني التي تظهر داخل سارة.",
        SMS_PERMISSION_REQUIRED: "صلاحية إرسال الرسائل غير ممنوحة لهذا الحساب، أو تم سحبها قبل الإرسال.",
        SMS_CUSTOMER_LOOKUP_PERMISSION_REQUIRED: "لإرسال رسالة باسم العميل، يحتاج الحساب إلى صلاحية عرض العملاء بالإضافة إلى صلاحية إرسال SMS.",
        SMS_CUSTOMER_LOOKUP_FAILED: "تعذر التحقق من رقم العميل بأمان. لم يتم إرسال الرسالة.",
        SMS_CUSTOMER_AMBIGUOUS: "وجدت أكثر من عميل بهذا الاسم. حدّد الاسم بشكل أدق قبل الإرسال.",
        SMS_IDEMPOTENCY_STORAGE_UNAVAILABLE: "لم أرسل الرسالة لأن التطبيق لم يستطع حفظ حماية منع التكرار.",
        SMS_SUBMISSION_UNCERTAIN: "حالة إرسال الرسالة غير محسومة بسبب انقطاع سابق. لم أعد إرسالها حتى لا تصل مكررة؛ تحقق من الرسائل الصادرة في الهاتف.",
        SMS_PERMISSION_DENIED: "لم يمنح Android إذن إرسال الرسائل النصية. لم يتم الإرسال.",
        NO_DEFAULT_SMS_SIM: "لا توجد شريحة افتراضية محددة لإرسال الرسائل.",
        SMS_AVAILABLE_IN_ADMIN_ANDROID_APK_ONLY: "إرسال SMS متاح من تطبيق الأدمن على Android فقط.",

      };
      throw new Error(friendly[reasonCode] || friendly[code] || code);
    }
    if (typeof data.answer !== "string" || typeof data.modelId !== "string") {
      throw new Error("AI_SETTINGS_INVALID_RESPONSE");
    }
    return { answer: data.answer, modelId: data.modelId, confirmationApplied: confirmationAction ? data.confirmationApplied === true : false };
  },
};
