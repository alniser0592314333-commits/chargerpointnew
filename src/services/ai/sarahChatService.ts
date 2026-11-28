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
  };
  const groups: Record<SarahPartialProgressStep["status"], string[]> = {
    succeeded: [], failed: [], not_executed: [], pending: [],
  };
  for (const item of rawSteps) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const step = item as Record<string, unknown>;
    const capability = typeof step.capability === "string" ? step.capability : "";
    const status = step.status;
    if (!capability || typeof status !== "string" || !(status in groups)) continue;
    groups[status as SarahPartialProgressStep["status"]].push(labels[capability] || "عملية أخرى");
  }
  if (!groups.succeeded.length && !groups.failed.length) return null;
  const lines = ["ملخص التنفيذ قبل التوقف:"];
  if (groups.succeeded.length) lines.push(`نجح: ${groups.succeeded.join("، ")}.`);
  if (groups.failed.length) lines.push(`فشل: ${groups.failed.join("، ")}.`);
  if (groups.not_executed.length) lines.push(`لم يُنفّذ بعد: ${groups.not_executed.join("، ")}.`);
  if (groups.pending.length) lines.push(`بانتظار التنفيذ: ${groups.pending.join("، ")}.`);
  lines.push("حُفظ تقدم المهمة. عند طلب «أعد المحاولة» سأستكمل الخطوات غير المكتملة فقط، ولن أعيد الخطوات الناجحة.");
  return lines.join("\\n");
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
      const partialSummary = formatPartialProgress(data.partialProgress);
      if (partialSummary) throw new SarahPartialTaskError(code, partialSummary);
      const friendly: Record<string, string> = {
        AI_TOOL_CALL_BATCH_NOT_SAFE: "تعذر ترتيب بعض خطوات الطلب بأمان. لم تُنفذ الخطوات غير المؤكدة؛ أعد المحاولة وسيُعاد فحص المتطلبات قبل التنفيذ.",
        AI_CAPABILITY_PERMISSION_REQUIRED: "صلاحيات حسابك الحالية لا تسمح بهذا الإجراء.",
        AI_TOOL_UNKNOWN: "تعذر التعرّف على الإجراء المطلوب. لم يتم تنفيذ أي تغيير.",
        AI_TOOL_CALL_NOT_ALLOWED: "الأداة المطلوبة غير متاحة لهذا الحساب. لم يتم تنفيذ أي تغيير.",
        AI_TOOL_CALL_LIMIT_REACHED: "توقفت دورة التنفيذ قبل اكتمال جميع الخطوات. أعد متابعة الطلب نفسه؛ ستُراجع النتائج السابقة قبل إعادة أي عملية.",
        AI_CUSTOMER_NEEDS_DISAMBIGUATION: "وجدت أكثر من عميل مطابق. حدّد العميل المقصود قبل المتابعة.",
        AI_CAPABILITY_CONFLICT: "لم يتم تنفيذ العملية بسبب تعارض أو نقص في البيانات. لم يتم تأكيد أي تغيير.",
        BIN_CONFIRMATION_INVALID: "تعذر استعادة العملية الأمنية. أعد طلب العملية من جديد.",
        BIN_CONFIRMATION_EXPIRED: "انتهت صلاحية التأكيد الأمني. أعد طلب العملية من جديد.",
        AI_TASK_CHECKPOINT_UNAVAILABLE: "تعذر استعادة المهمة السابقة ضمن جلسة الدخول الحالية. لم أعد تنفيذ العمليات تلقائيًا؛ راجع حالة المهمة قبل إرسال طلب جديد.",
        AI_TASK_CHECKPOINT_INVALID: "تعذر التحقق من سجل متابعة المهمة. لم يتم اعتماد أي نتيجة غير مؤكدة.",
        AI_TASK_CHECKPOINT_WRITE_FAILED: "تعذر حفظ تقدم المهمة بأمان. يمكنك إعادة المحاولة؛ ستُراجع النتائج المحفوظة قبل تنفيذ أي خطوة مرة أخرى.",

        BIN_MUST_USE_SECURE_PROMPT: "لا ترسل رمز BIN داخل المحادثة. أدخله فقط في خانة التأكيد الأمني التي تظهر داخل سارة.",
        SMS_PERMISSION_REQUIRED: "صلاحية إرسال الرسائل غير ممنوحة لهذا الحساب، أو تم سحبها قبل الإرسال.",
        SMS_CUSTOMER_LOOKUP_PERMISSION_REQUIRED: "لإرسال رسالة باسم العميل، يحتاج الحساب إلى صلاحية عرض العملاء بالإضافة إلى صلاحية إرسال SMS.",
        SMS_CUSTOMER_LOOKUP_FAILED: "تعذر التحقق من رقم العميل بأمان. لم يتم إرسال الرسالة.",
        SMS_CUSTOMER_AMBIGUOUS: "وجدت أكثر من عميل بهذا الاسم. حدّد الاسم بشكل أدق قبل الإرسال.",
        SMS_CUSTOMER_PHONE_MISSING: "العميل المحدد لا يحتوي على رقم هاتف مسجل.",
        SMS_CUSTOMER_NOT_FOUND: "لم أجد عميلاً نشطًا بهذا الاسم.",
        SMS_IDEMPOTENCY_STORAGE_UNAVAILABLE: "لم أرسل الرسالة لأن التطبيق لم يستطع حفظ حماية منع التكرار.",
        SMS_SUBMISSION_UNCERTAIN: "حالة إرسال الرسالة غير محسومة بسبب انقطاع سابق. لم أعد إرسالها حتى لا تصل مكررة؛ تحقق من الرسائل الصادرة في الهاتف.",
        SMS_PERMISSION_DENIED: "لم يمنح Android إذن إرسال الرسائل النصية. لم يتم الإرسال.",
        NO_DEFAULT_SMS_SIM: "لا توجد شريحة افتراضية محددة لإرسال الرسائل.",
        SMS_PHONE_INVALID: "رقم الهاتف غير صالح. لم يتم الإرسال.",
        SMS_MESSAGE_INVALID: "نص الرسالة فارغ أو أطول من الحد المسموح.",
        SMS_AVAILABLE_IN_ADMIN_ANDROID_APK_ONLY: "إرسال SMS متاح من تطبيق الأدمن على Android فقط.",

      };
      throw new Error(friendly[code] || code);
    }
    if (typeof data.answer !== "string" || typeof data.modelId !== "string") {
      throw new Error("AI_SETTINGS_INVALID_RESPONSE");
    }
    return { answer: data.answer, modelId: data.modelId };
  },
};
