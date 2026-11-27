import { config } from "../../config/env";
import { getFreshSupabaseAuthToken, getStoredSupabaseAuthSession } from "../supabase/client";

export interface SarahPendingBinAction {
  name: string;
  args: Record<string, unknown>;
  actionRequestId: string;
}

export interface SarahChatResponse {
  answer: string;
  modelId: string;
  requiresBin?: boolean;
  pendingAction?: SarahPendingBinAction;
  binError?: "BIN_INVALID";
  requiresLocalSync?: boolean;
  localSyncAction?: "manual_sync";
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
    if (confirmationAction) requestBody.confirmationAction = confirmationAction;

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
    if (response.status === 428 && data.error === "LOCAL_SYNC_REQUIRED" && data.action === "manual_sync") {
      return { answer: "", modelId: "", requiresLocalSync: true, localSyncAction: "manual_sync" };
    }
    if (response.status === 428 && data.error === "BIN_REQUIRED") {
      const pending = data.pendingAction && typeof data.pendingAction === "object" && !Array.isArray(data.pendingAction)
        ? data.pendingAction as Record<string, unknown>
        : null;
      const pendingAction = pending
        && typeof pending.name === "string"
        && pending.args && typeof pending.args === "object" && !Array.isArray(pending.args)
        && typeof pending.actionRequestId === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pending.actionRequestId)
        ? {
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
      const friendly: Record<string, string> = {
        AI_TOOL_CALL_BATCH_NOT_SAFE: "سارة حاولت طلب أكثر من إجراء في نفس اللحظة. لم يتم تنفيذ أي تعديل؛ أعد الطلب وستنفذ الخطوات بالتتابع.",
        AI_CAPABILITY_PERMISSION_REQUIRED: "صلاحيات حسابك الحالية لا تسمح بهذا الإجراء.",
        AI_TOOL_UNKNOWN: "تعذر التعرّف على الإجراء المطلوب. لم يتم تنفيذ أي تغيير.",
        AI_TOOL_CALL_NOT_ALLOWED: "الأداة المطلوبة غير متاحة لهذا الحساب. لم يتم تنفيذ أي تغيير.",
        AI_TOOL_CALL_LIMIT_REACHED: "الطلب يحتاج خطوات أكثر من الحد المسموح. قسّم الطلب إلى خطوات أصغر.",
        AI_CUSTOMER_NEEDS_DISAMBIGUATION: "وجدت أكثر من عميل مطابق. حدّد العميل المقصود قبل المتابعة.",
        AI_CAPABILITY_CONFLICT: "لم يتم تنفيذ العملية بسبب تعارض أو نقص في البيانات. لم يتم تأكيد أي تغيير.",
        BIN_CONFIRMATION_INVALID: "تعذر استعادة العملية الأمنية. أعد طلب العملية من جديد.",
        BIN_MUST_USE_SECURE_PROMPT: "لا ترسل رمز BIN داخل المحادثة. أدخله فقط في خانة التأكيد الأمني التي تظهر داخل سارة.",
      };
      throw new Error(friendly[code] || code);
    }
    if (typeof data.answer !== "string" || typeof data.modelId !== "string") {
      throw new Error("AI_SETTINGS_INVALID_RESPONSE");
    }
    return { answer: data.answer, modelId: data.modelId };
  },
};
