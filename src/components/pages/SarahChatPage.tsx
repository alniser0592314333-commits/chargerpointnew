import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Sparkles, AlertCircle, Menu, X, LogOut, MessageSquare } from "lucide-react";
import { sarahChatService, type SarahPendingBinAction } from "../../services/ai/sarahChatService";
import { sendSmsUsingSystemDefaultSim } from "../../services/nativeSms";
import { UserSession } from "../../services/auth/authService";
import { Button } from "../ui/Button";
import { sarahInputQueue, SarahInputRecord } from "../../application/ai/sarahInputQueue";
import { sarahConversationStore } from "../../application/ai/sarahConversationStore";
import { SarahAccountOperationScope } from "../../application/ai/sarahAccountOperationScope";
import { buildSarahHistorySnapshot } from "../../application/ai/sarahHistory";
import { localDb } from "../../infrastructure/localDb/localDb";
import { isBinRequiredOutboxCommand } from "../../infrastructure/sync/binAuthorization";
import { globalSyncBridge } from "../../infrastructure/sync/syncBridge";
import { invokeSupabaseRpc, subscribeToOwnAdminPermissionEpoch } from "../../services/supabase/client";
import type { SarahLocalSyncActionResult, SarahLocalSyncContext } from "../../services/ai/sarahChatService";

type Message = {
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
  status?: "sending" | "sent" | "offline" | "running" | "waiting_confirmation" | "failed";
  queueId?: string;
  statusText?: string;
};
type PendingBinAction = {
  id: string;
  correlationId: string;
  text: string;
  createdAt?: string;
  historySnapshot: { role: "user" | "assistant"; text: string }[];
  baseMessages: Message[];
  pendingAction?: SarahPendingBinAction;
};
const accountScopeIdentity = (accountId?: string | null, authUserId?: string) =>
  accountId ? `${accountId}:${authUserId || "unverified"}` : null;
const gazaDateKey = () => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Gaza", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (name: string) => parts.find((item) => item.type === name)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};
const dailyConversationTitle = (date: string) => new Intl.DateTimeFormat("ar", {
  timeZone: "Asia/Gaza", weekday: "long", day: "2-digit", month: "2-digit",
}).format(new Date(`${date}T12:00:00`));
const messageTime = (value?: string) => value
  ? new Intl.DateTimeFormat("ar", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Gaza" }).format(new Date(value))
  : "";

const describePendingBinAction = (action?: SarahPendingBinAction) => {
  if (!action) return "عملية تتطلب تأكيدًا أمنيًا";
  const args = action.args;
  const amount = typeof args.amount_minor === "number" && Number.isSafeInteger(args.amount_minor)
    ? `₪${(args.amount_minor / 100).toFixed(2)}`
    : "";
  const customer = typeof args.name_hint === "string" && args.name_hint.trim()
    ? args.name_hint.trim()
    : typeof args.customer_code === "string" ? `رمز العميل ${args.customer_code}` : "العميل المحدد";
  if (action.name === "record_and_approve_customer_payment") return `تسجيل واعتماد دفعة نقدية ${amount} لـ${customer}`;
  if (action.name === "approve_payment_submission") return "اعتماد دفعة معلّقة";
  if (action.name === "adjust_customer_finances") return `تسوية مالية (${String(args.action || "غير محددة")}) ${amount} لـ${customer}`;
  if (action.name === "deliver_order_item") return "تسليم عنصر من طلب";
  if (action.name === "cancel_order_item" || action.name === "cancel_order") return "إلغاء طلب أو عنصر";
  if (action.name === "update_customer_protected_settings") return "تعديل إعدادات مالية محمية للعميل";
  if (action.name === "set_customer_active_status") return "تغيير حالة حساب العميل";
  if (action.name === "set_admin_permission") return "تغيير صلاحية أدمن";
  if (action.name === "suspend_admin") return "إيقاف حساب أدمن";
  if (action.name === "activate_admin") return "تفعيل حساب أدمن";
  return "عملية إدارية محمية";
};

export const SarahChatPage: React.FC<{ session: UserSession | null; onExit?: () => void }> = ({ session, onExit }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedDate, setSelectedDate] = useState(gazaDateKey);
  const [hydratedDate, setHydratedDate] = useState<string | null>(null);
  const [dailyConversations, setDailyConversations] = useState<import("../../application/ai/sarahConversationStore").SarahDailyConversation[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showAllConversations, setShowAllConversations] = useState(false);
  const [revealedMessageId, setRevealedMessageId] = useState<string | null>(null);
  const [swipeOffset, setSwipeOffset] = useState<{ id: string; value: number } | null>(null);
  const swipeStartRef = useRef<{ id: string; x: number } | null>(null);
  const swipeOffsetRef = useRef<{ id: string; value: number } | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const lastObservedTodayRef = useRef(gazaDateKey());
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<SarahInputRecord[]>([]);
  const [pendingBinAction, setPendingBinAction] = useState<PendingBinAction | null>(null);
  const [binValue, setBinValue] = useState("");
  const [binError, setBinError] = useState("");
  const [hydratedAccount, setHydratedAccount] = useState<string | null>(null);
  const activeAccountId = session?.authUserId || null;
  const accountScopeRef = useRef(new SarahAccountOperationScope(accountScopeIdentity(session?.userId, session?.authUserId)));
  const conversationGenerationRef = useRef(0);

  // Realtime is only a fast invalidation signal for this signed-in admin.
  // If delivery is missed, the database still checks live permissions on every
  // protected RPC; app focus also refreshes the authoritative profile.
  useEffect(() => {
    const authUserId = session?.authUserId || null;
    if (!authUserId) return;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void subscribeToOwnAdminPermissionEpoch(authUserId, (version) => {
      if (cancelled || !isCurrent(authUserId)) return;
      window.dispatchEvent(new CustomEvent("cp-admin-permissions-invalidated", {
        detail: { authUserId, version },
      }));
    }).then((stop) => {
      if (cancelled) stop();
      else {
        unsubscribe = stop;
        // Refresh once on entry too: permissions may have changed while Sarah
        // was closed, when there was intentionally no Realtime subscription.
        window.dispatchEvent(new CustomEvent("cp-admin-permissions-invalidated", {
          detail: { authUserId },
        }));
      }
    }).catch(() => {
      // Realtime is best-effort only. Do not poll or weaken server-side checks.
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [session?.authUserId, session?.userId]);


  // Immediately invalidate all asynchronous work from a previous account.
  useLayoutEffect(() => {
    accountScopeRef.current.switchTo(accountScopeIdentity(session?.userId, session?.authUserId));
    setMessages([]);
    setText("");
    setBusy(false);
    setError("");
    setPending([]);
    setPendingBinAction(null);
    setBinValue("");
    setBinError("");
    setHydratedAccount(null);
    setHydratedDate(null);
    setDailyConversations([]);
    setDrawerOpen(false);
  }, [session?.userId, session?.authUserId]);

  useEffect(() => {
    const observeNewDay = () => {
      const today = gazaDateKey();
      if (today === lastObservedTodayRef.current) return;
      if (busy || pendingBinAction) return;
      lastObservedTodayRef.current = today;
      setMessages([]);
      setHydratedDate(null);
      setSelectedDate(today);
    };
    window.addEventListener("focus", observeNewDay);
    document.addEventListener("visibilitychange", observeNewDay);
    return () => {
      window.removeEventListener("focus", observeNewDay);
      document.removeEventListener("visibilitychange", observeNewDay);
    };
  }, [busy, pendingBinAction]);

  useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [messages, hydratedDate, selectedDate]);

  const isCurrent = (accountId: string, operation?: number) => {
    if (!accountId || accountId !== session?.authUserId) return false;
    const identity = accountScopeIdentity(session?.userId, session?.authUserId);
    return operation === undefined
      ? accountScopeRef.current.isCurrentAccount(identity)
      : accountScopeRef.current.isCurrent({ accountId: identity || "", generation: operation });
  };

  useEffect(() => {
    const accountId = session?.authUserId || null;
    if (!accountId) return;
    const operation = accountScopeRef.current.generation;
    let cancelled = false;
    void sarahConversationStore.loadDaily(accountId, selectedDate, dailyConversationTitle(selectedDate)).then((snapshot) => {
      if (!cancelled && isCurrent(accountId, operation)) {
        conversationGenerationRef.current = snapshot.generation;
        setMessages(snapshot.messages);
        setHydratedAccount(accountId);
        setHydratedDate(selectedDate);
        void sarahConversationStore.listDaily(accountId).then(setDailyConversations).catch(() => undefined);
      }
    }).catch((err) => {
      if (!cancelled && isCurrent(accountId, operation)) setError(err instanceof Error ? err.message : "CONVERSATION_LOAD_FAILED");
    });
    return () => { cancelled = true; };
  }, [session?.userId, session?.authUserId, selectedDate]);

  useEffect(() => {
    const accountId = session?.authUserId || null;
    if (!accountId || hydratedAccount !== accountId || hydratedDate !== selectedDate) return;
    return sarahConversationStore.subscribeToClear((notice) => {
      if (notice.accountId !== accountId || (notice.date && notice.date !== selectedDate) || !isCurrent(accountId)) return;
      void sarahConversationStore.loadDaily(accountId, selectedDate, dailyConversationTitle(selectedDate)).then((snapshot) => {
        if (isCurrent(accountId) && snapshot.generation >= conversationGenerationRef.current) {
          conversationGenerationRef.current = snapshot.generation;
          setMessages(snapshot.messages);
          setHydratedDate(selectedDate);
        }
      }).catch((err) => {
        if (isCurrent(accountId)) setError(err instanceof Error ? err.message : "CONVERSATION_SYNC_FAILED");
      });
    });
  }, [session?.userId, session?.authUserId, hydratedAccount, hydratedDate, selectedDate]);

  useEffect(() => {
    const accountId = session?.authUserId || null;
    if (!accountId || hydratedAccount !== accountId || hydratedDate !== selectedDate || !isCurrent(accountId) || busy) return;
    void sarahConversationStore.saveDaily(accountId, selectedDate, messages, conversationGenerationRef.current, dailyConversationTitle(selectedDate)).then(() => {
      void sarahConversationStore.listDaily(accountId).then(setDailyConversations).catch(() => undefined);
    }).catch((err) => {
      if (isCurrent(accountId)) setError(err instanceof Error ? err.message : "CONVERSATION_SAVE_FAILED");
    });
  }, [messages, session?.userId, session?.authUserId, hydratedAccount, hydratedDate, selectedDate, busy]);

  const refreshQueue = async (accountId: string, operation?: number) => {
    if (!isCurrent(accountId, operation)) return;
    try {
      try { await sarahInputQueue.pruneCompleted(accountId, 30); } catch { /* Retention failure must not block queue visibility. */ }
      if (!isCurrent(accountId, operation)) return;
      await sarahInputQueue.recoverInterruptedUploads(accountId);
      const rows = await sarahInputQueue.list(accountId);
      if (isCurrent(accountId, operation)) setPending(rows);
    } catch (err) {
      if (isCurrent(accountId, operation)) setError(err instanceof Error ? err.message : "QUEUE_UNAVAILABLE");
    }
  };
  useEffect(() => {
    const accountId = session?.authUserId || null;
    if (!accountId) return;
    const operation = accountScopeRef.current.generation;
    void refreshQueue(accountId, operation);
  }, [session?.userId, session?.authUserId]);

  useEffect(() => {
    if (!activeAccountId || hydratedAccount !== activeAccountId || !pending.length) return;
    const missing = pending.filter((item) =>
      item.actorAccountId === activeAccountId
      && (item.conversationDate || gazaDateKey()) === selectedDate
      && item.state !== "COMPLETED"
      && Boolean(item.text)
      && Array.isArray(item.historySnapshot)
      && !messages.some((message) => message.queueId === item.id)
    );
    if (!missing.length) return;
    const recoveredMessages: Message[] = [
      ...messages,
      ...missing.map((item) => ({
        role: "user" as const,
        text: item.text || "",
        createdAt: item.createdAt,
        queueId: item.id,
        status: item.state === "QUEUED_OFFLINE" ? "offline" as const
          : item.state === "WAITING_FOR_CONFIRMATION" ? "waiting_confirmation" as const
          : item.state === "UPLOADING" || item.state === "SENT_TO_AI" || item.state === "READY_TO_SEND" ? "running" as const
          : "failed" as const,
        statusText: item.state === "QUEUED_OFFLINE" ? "بانتظار عودة الاتصال"
          : item.state === "WAITING_FOR_CONFIRMATION" ? "بانتظار التأكيد الأمني"
          : item.state === "UPLOADING" || item.state === "SENT_TO_AI" || item.state === "READY_TO_SEND" ? "استعادة المهمة من آخر نقطة محفوظة"
          : "توقفت المهمة؛ يمكنك إعادة المحاولة",
      })),
    ];
    setMessages(recoveredMessages);
    void sarahConversationStore.saveDaily(activeAccountId, selectedDate, recoveredMessages, conversationGenerationRef.current, dailyConversationTitle(selectedDate)).catch(() => undefined);
  }, [activeAccountId, hydratedAccount, pending, messages, selectedDate]);

  useEffect(() => {
    if (!activeAccountId || hydratedAccount !== activeAccountId || pendingBinAction) return;
    const record = pending.find((item) =>
      item.actorAccountId === activeAccountId
      && (item.conversationDate || gazaDateKey()) === selectedDate
      && item.state === "WAITING_FOR_CONFIRMATION"
      && Boolean(item.pendingBinAction)
      && Boolean(item.text)
    );
    if (!record?.text || !record.pendingBinAction) return;
    const baseMessages = messages;
    const historySnapshot = record.historySnapshot?.slice(-20) || buildSarahHistorySnapshot(baseMessages);
    if (!record.historySnapshot && historySnapshot.at(-1)?.role === "user" && historySnapshot.at(-1)?.text === record.text) historySnapshot.pop();
    setPendingBinAction({
      id: record.id,
      correlationId: record.correlationId,
      text: record.text,
      createdAt: record.createdAt,
      historySnapshot,
      baseMessages,
      pendingAction: record.pendingBinAction,
    });
    setBinValue("");
    setBinError("");
  }, [activeAccountId, hydratedAccount, pending, pendingBinAction, messages, selectedDate]);

  const canUse = Boolean(session && (session.role === "SUPER_ADMIN" || session.permissions.includes("ai:use")));
  const canManageSync = Boolean(session && (session.role === "SUPER_ADMIN" || session.permissions.includes("sync:manage")));

  const collectLocalSyncContext = async (): Promise<SarahLocalSyncContext | undefined> => {
    if (!canManageSync) return undefined;
    try {
      const [outbox, history, syncState] = await Promise.all([
        localDb.listOutbox(),
        localDb.listHistory(),
        localDb.getSyncState("global"),
      ]);
      const recentErrorClasses = [...history]
        .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime())
        .filter((record) => Boolean(record.errorClass))
        .slice(0, 5)
        .map((record) => String(record.errorClass || "UNKNOWN").toUpperCase().replace(/[^A-Z_]/g, "").slice(0, 32) || "UNKNOWN");
      return {
        online: typeof navigator !== "undefined" ? navigator.onLine : false,
        pendingCount: outbox.filter((record) => record.status === "pending" || record.status === "syncing").length,
        blockedCount: outbox.filter((record) => record.status === "blocked").length,
        failedCount: outbox.filter((record) => record.status === "rejected" || record.status === "conflict").length,
        binRequiredCount: outbox.filter(isBinRequiredOutboxCommand).length,
        lastPulledAt: typeof syncState?.lastPulledAt === "string" ? syncState.lastPulledAt : null,
        recentErrorClasses,
      };
    } catch {
      return undefined;
    }
  };

  const sendWithLocalActions = async (
    message: string,
    accountId: string,
    history: Message[],
    correlationId: string,
    bin?: string,
    confirmationAction?: SarahPendingBinAction,
    resumeTask = false,
    onAccepted?: () => void,
    onProgress?: () => Promise<void>,
  ) => {
    const localSyncContext = await collectLocalSyncContext();
    let continuationContext: { localSyncContext?: SarahLocalSyncContext; localSyncActionResult?: SarahLocalSyncActionResult; localSmsActionResult?: { actionRequestId: string; submitted: boolean; parts?: number; subscriptionId?: number; errorCode?: string } } =
      localSyncContext ? { localSyncContext } : {};
    let response = await sarahChatService.send(
      message,
      accountId,
      history,
      correlationId,
      bin,
      Object.keys(continuationContext).length ? continuationContext : undefined,
      confirmationAction,
      resumeTask,
    );
    if (response.requiresLocalSync && response.localSyncAction === "manual_sync") {
      if (!canManageSync) throw new Error("SYNC_MANAGE_PERMISSION_REQUIRED");
      if (!isCurrent(accountId)) throw new Error("ACCOUNT_CHANGED");
      let localSyncActionResult: SarahLocalSyncActionResult;
      try {
        // Recheck the live database permission immediately before touching the
        // device-local outbox; the cached session permission is only a UI hint.
        const permissionCheck = await invokeSupabaseRpc<Record<string, unknown>>("begin_sync_bootstrap");
        if (permissionCheck.error || typeof permissionCheck.data?.admin_id !== "string") {
          throw new Error("SYNC_MANAGE_PERMISSION_REQUIRED");
        }
        if (!isCurrent(accountId)) throw new Error("ACCOUNT_CHANGED");
        const result = await globalSyncBridge.requestManualSync();
        localSyncActionResult = {
          action: "manual_sync",
          success: true,
          pushed: result.pushed,
          pulled: result.pulled,
        };
      } catch (syncError) {
        const message = syncError instanceof Error ? syncError.message : "";
        localSyncActionResult = {
          action: "manual_sync",
          success: false,
          pushed: 0,
          pulled: 0,
          errorCode: typeof navigator !== "undefined" && !navigator.onLine
            ? "NETWORK_OFFLINE"
            : /already in progress/i.test(message)
            ? "SYNC_ALREADY_IN_PROGRESS"
            : "SYNC_FAILED",
        };
      }
      const refreshedContext = await collectLocalSyncContext();
      continuationContext = { localSyncContext: refreshedContext, localSyncActionResult };
      response = await sarahChatService.send(
        message,
        accountId,
        history,
        correlationId,
        bin,
        continuationContext,
        confirmationAction,
        resumeTask,
      );
      if (response.requiresLocalSync) throw new Error("LOCAL_SYNC_HANDOFF_LOOP");
    }
    if (response.requiresLocalSms && response.localSmsAction) {
      if (!isCurrent(accountId)) throw new Error("ACCOUNT_CHANGED");
      const action = response.localSmsAction;
      const phone = typeof action.args.phone === "string" ? action.args.phone.trim() : "";
      const messageText = typeof action.args.message === "string" ? action.args.message : "";
      if (!phone || !messageText.trim()) throw new Error("SMS_ACTION_ARGUMENTS_INVALID");
      const permission = await invokeSupabaseRpc<Record<string, unknown>>("sarah_ai_get_chat_access_context", {
        p_cached_permissions_version: null,
      });
      const livePermissions = Array.isArray(permission.data?.permissions) ? permission.data.permissions as string[] : [];
      const liveRole = String(permission.data?.role || "").trim().toUpperCase().replace(/\s+/g, "_");
      if (permission.error || (liveRole !== "SUPER_ADMIN" && !livePermissions.includes("customers:send-sms"))) {
        throw new Error("SMS_PERMISSION_REQUIRED");
      }
      if (!isCurrent(accountId)) throw new Error("ACCOUNT_CHANGED");
      const storageKey = `cp-sarah-sms:${action.actionRequestId}`;
      let cached: { state?: string; parts?: number; subscriptionId?: number } | null = null;
      try { cached = JSON.parse(localStorage.getItem(storageKey) || "null"); } catch { cached = null; }
      let localSmsActionResult: { actionRequestId: string; submitted: boolean; parts?: number; subscriptionId?: number; errorCode?: string } = { actionRequestId: action.actionRequestId, submitted: false, errorCode: "SMS_SUBMISSION_FAILED" };
      if (cached?.state === "submitted") {
        localSmsActionResult = { actionRequestId: action.actionRequestId, submitted: true, parts: cached.parts, subscriptionId: cached.subscriptionId };
      } else if (cached?.state === "started") {
        // A crash after invoking Android but before recording its result is uncertain.
        // Never resend automatically: that could duplicate a billable SMS.
        localSmsActionResult = { actionRequestId: action.actionRequestId, submitted: false, errorCode: "SMS_SUBMISSION_UNCERTAIN" };
      } else {
        let claimStored = false;
        try {
          // Persist the in-flight claim before crossing the native boundary. If
          // storage is unavailable, do not send because retries could duplicate.
          localStorage.setItem(storageKey, JSON.stringify({ state: "started", at: new Date().toISOString() }));
          claimStored = true;
        } catch {
          localSmsActionResult = { actionRequestId: action.actionRequestId, submitted: false, errorCode: "SMS_IDEMPOTENCY_STORAGE_UNAVAILABLE" };
        }
        if (claimStored) {
          try {
            const nativeResult = await sendSmsUsingSystemDefaultSim(phone, messageText);
            localSmsActionResult = { actionRequestId: action.actionRequestId, submitted: true, parts: nativeResult.parts, subscriptionId: nativeResult.subscriptionId };
            // If this write fails after Android accepted the SMS, keep the
            // durable "started" marker. A later retry will be uncertain, never resend.
            try {
              localStorage.setItem(storageKey, JSON.stringify({ state: "submitted", parts: nativeResult.parts, subscriptionId: nativeResult.subscriptionId, at: new Date().toISOString() }));
            } catch { /* preserve the started marker to prevent duplicate sends */ }
          } catch (smsError) {
            localSmsActionResult = { actionRequestId: action.actionRequestId, submitted: false, errorCode: smsError instanceof Error ? smsError.message.slice(0, 80) : "SMS_SUBMISSION_FAILED" };
            try { localStorage.setItem(storageKey, JSON.stringify({ state: "failed", at: new Date().toISOString() })); } catch { /* best effort */ }
          }
        }
      }
      continuationContext = { ...continuationContext, localSmsActionResult };
      response = await sarahChatService.send(
        message, accountId, history, correlationId, bin, continuationContext, action, false,
      );
      if (response.requiresLocalSms) throw new Error("LOCAL_SMS_HANDOFF_LOOP");
    }
    if (isCurrent(accountId)) onAccepted?.();
    while (response.taskPending) {
      if (!isCurrent(accountId)) throw new Error("ACCOUNT_CHANGED");
      if (typeof navigator !== "undefined" && !navigator.onLine) throw new Error("AI_SETTINGS_NETWORK_ERROR");
      try { await onProgress?.(); } catch { /* Lease renewal must not discard the durable task. */ }
      await new Promise((resolve) => setTimeout(resolve, response.retryAfterMs || 900));
      response = await sarahChatService.send(
        message,
        accountId,
        history,
        correlationId,
        undefined,
        continuationContext,
        undefined,
        true,
      );
    }
    return response;
  };

  const send = async () => {
    const accountId = session?.authUserId || null;
    const clean = text.trim();
    if (!clean || busy || pendingBinAction || !canUse || !accountId || !isCurrent(accountId) || hydratedAccount !== accountId) return;
    if (/\bBIN\b\s*[:：]?\s*\d{4,32}/i.test(clean)) {
      setText("");
      setError("لا ترسل رمز BIN داخل المحادثة؛ أدخله فقط في خانة التأكيد الأمني.");
      return;
    }
    const operation = accountScopeRef.current.generation;
    const baseMessages = messages;
    const historySnapshot = buildSarahHistorySnapshot(baseMessages.map((message) => {
      const priorTask = message.queueId ? pending.find((row) => row.id === message.queueId) : undefined;
      const taskNeedsAttention = message.status === "failed" || priorTask?.state === "NEEDS_ATTENTION";
      if (!taskNeedsAttention) return { role: message.role, text: message.text };
      const errorCode = priorTask?.lastErrorCode || "AI_REQUEST_INTERRUPTED";
      return {
        role: message.role,
        text: `${message.text}\n\n[سجل مهمة سابقة: توقفت دون رد نهائي. الحالة: NEEDS_ATTENTION. رمز الخطأ: ${errorCode}. هذه معلومة تاريخية فقط؛ لا تستأنف المهمة إلا إذا طلب المستخدم ذلك صراحةً.]`,
      };
    }));
    setError("");
    setBusy(true);
    const id = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const messageCreatedAt = new Date().toISOString();
    try {
      await sarahInputQueue.enqueue({
        id, actorAccountId: accountId, deviceId: "web-client", kind: "text",
        state: navigator.onLine ? "READY_TO_SEND" : "QUEUED_OFFLINE",
        text: clean,
        correlationId,
        conversationDate: selectedDate,
        historySnapshot,
      });
      if (!isCurrent(accountId, operation)) return;
      setText("");
      const optimisticMessages: Message[] = [...baseMessages, {
        role: "user",
        text: clean,
        createdAt: messageCreatedAt,
        status: navigator.onLine ? "sending" : "offline",
        queueId: id,
        statusText: navigator.onLine ? "جارٍ الإرسال" : "بانتظار عودة الاتصال",
      }];
      setMessages(optimisticMessages);
      // Persist the user's message before network work so interrupted uploads
      // remain visible in the conversation after reload.
      await sarahConversationStore.saveDaily(accountId, selectedDate, optimisticMessages, conversationGenerationRef.current, dailyConversationTitle(selectedDate)).catch(() => undefined);
      await refreshQueue(accountId, operation);
      if (!isCurrent(accountId, operation)) return;
      if (!navigator.onLine) {
        const offlineMessages = [...baseMessages, {
          role: "user" as const,
          text: clean,
          createdAt: messageCreatedAt,
          status: "offline" as const,
          queueId: id,
          statusText: "بانتظار عودة الاتصال",
        }];
        setMessages(offlineMessages);
        await sarahConversationStore.saveDaily(accountId, selectedDate, offlineMessages, conversationGenerationRef.current, dailyConversationTitle(selectedDate));
        return;
      }
      await sarahInputQueue.transition(accountId, id, "UPLOADING");
      if (!isCurrent(accountId, operation)) return;
      try {
        const response = await sendWithLocalActions(
          clean,
          accountId,
          historySnapshot,
          correlationId,
          undefined,
          undefined,
          false,
          () => {
            setMessages((prev) => prev.map((item) => item.queueId === id
              ? { ...item, status: "sent", statusText: "تم الإرسال" }
              : item));
            setTimeout(() => {
              if (!isCurrent(accountId, operation)) return;
              setMessages((prev) => prev.map((item) => item.queueId === id && item.status === "sent"
                ? { ...item, status: undefined, statusText: undefined }
                : item));
            }, 1000);
          },
          async () => { await sarahInputQueue.renewUploadLease(accountId, id); },
        );
        if (!isCurrent(accountId, operation)) return;
        if (response.requiresBin) {
          await sarahInputQueue.transition(accountId, id, "WAITING_FOR_CONFIRMATION", {
            lastErrorCode: response.binError || "BIN_REQUIRED",
            pendingBinAction: response.pendingAction,
          });
          setPendingBinAction({ id, correlationId, text: clean, createdAt: messageCreatedAt, historySnapshot, baseMessages, pendingAction: response.pendingAction });
          setMessages((prev) => prev.map((item) => item.queueId === id
            ? { ...item, status: "waiting_confirmation", statusText: "بانتظار التأكيد الأمني" }
            : item));
          setBinValue("");
          setBinError(response.binError ? "رمز BIN غير صحيح. حاول مرة أخرى." : "");
          await refreshQueue(accountId, operation);
          return;
        }
        await sarahInputQueue.transition(accountId, id, "SENT_TO_AI", { resultRef: correlationId });
        const completedMessages = [
          ...baseMessages,
          { role: "user" as const, text: clean, createdAt: messageCreatedAt, queueId: id },
          { role: "assistant" as const, text: response.answer, createdAt: new Date().toISOString() },
        ];
        await sarahConversationStore.saveDaily(accountId, selectedDate, completedMessages, conversationGenerationRef.current, dailyConversationTitle(selectedDate));
        await sarahInputQueue.transition(accountId, id, "COMPLETED");
        if (!isCurrent(accountId, operation)) return;
        setMessages(completedMessages);
        await refreshQueue(accountId, operation);
      } catch (err) {
        if (!isCurrent(accountId, operation)) return;
        const offline = typeof navigator !== "undefined" && !navigator.onLine;
        await sarahInputQueue.transition(accountId, id, offline ? "QUEUED_OFFLINE" : "NEEDS_ATTENTION", {
          lastErrorCode: err instanceof Error ? err.message.slice(0, 80) : "AI_REQUEST_FAILED",
        });
        setMessages((prev) => prev.map((item) => item.queueId === id
          ? { ...item, status: offline ? "offline" : "failed", statusText: offline ? "بانتظار عودة الاتصال" : "فشلت المهمة" }
          : item));
        throw err;
      }
    } catch (err) {
      if (isCurrent(accountId, operation)) {
        setError("");
        const offline = typeof navigator !== "undefined" && !navigator.onLine;
        const failureMessages = [
          ...baseMessages,
          {
            role: "user" as const,
            text: clean,
            createdAt: messageCreatedAt,
            status: offline ? "offline" as const : "failed" as const,
            queueId: id,
            statusText: offline ? "بانتظار عودة الاتصال" : "توقفت قبل وصول الرد النهائي؛ يمكن استكمالها من آخر نقطة محفوظة",
          },
        ];
        setMessages(failureMessages);
        await sarahConversationStore.saveDaily(accountId, selectedDate, failureMessages, conversationGenerationRef.current, dailyConversationTitle(selectedDate)).catch(() => undefined);
        await refreshQueue(accountId, operation);
      }
    } finally {
      if (isCurrent(accountId, operation)) setBusy(false);
    }
  };

  const clearTranscript = async () => {
    const accountId = session?.authUserId || null;
    if (!accountId || busy || hydratedAccount !== accountId || hydratedDate !== selectedDate || !isCurrent(accountId)) return;
    if (!window.confirm("مسح محادثة هذا اليوم فقط؟")) return;
    const operation = accountScopeRef.current.generation;
    try {
      const nextGeneration = await sarahConversationStore.clearDaily(accountId, selectedDate, dailyConversationTitle(selectedDate));
      if (!isCurrent(accountId, operation)) return;
      conversationGenerationRef.current = nextGeneration;
      setMessages([]);
      setHydratedDate(selectedDate);
      setError("");
    } catch (err) {
      if (isCurrent(accountId, operation)) setError(err instanceof Error ? err.message : "CONVERSATION_CLEAR_FAILED");
    }
  };

  const retryQueued = async (record: SarahInputRecord) => {
    const accountId = session?.authUserId || null;
    if (!accountId || busy || !navigator.onLine || !isCurrent(accountId) || record.actorAccountId !== accountId || !record.text || hydratedAccount !== accountId) return;
    const operation = accountScopeRef.current.generation;
    setBusy(true); setError("");
    setMessages((prev) => prev.map((item) => item.queueId === record.id
      ? { ...item, status: "sending", statusText: "جارٍ إعادة الإرسال" }
      : item));
    try {
      if (record.state === "SENT_TO_AI") {
        await sarahInputQueue.transition(accountId, record.id, "NEEDS_ATTENTION", {
          lastErrorCode: "TRANSCRIPT_SAVE_INTERRUPTED",
        });
      }
      if (record.state === "NEEDS_ATTENTION" || record.state === "QUEUED_OFFLINE"
        || record.state === "WAITING_FOR_CONFIRMATION" || record.state === "SENT_TO_AI") {
        await sarahInputQueue.transition(accountId, record.id, "READY_TO_SEND");
      }
      await sarahInputQueue.transition(accountId, record.id, "UPLOADING");
      if (!isCurrent(accountId, operation)) return;
      const baseMessages = messages;
      const retryHistory = record.historySnapshot?.slice(-20) || buildSarahHistorySnapshot(baseMessages);
      if (!record.historySnapshot && retryHistory.at(-1)?.role === "user" && retryHistory.at(-1)?.text === record.text) retryHistory.pop();
      const response = await sendWithLocalActions(
        record.text,
        accountId,
        retryHistory,
        record.correlationId,
        undefined,
        record.pendingBinAction,
        record.state !== "QUEUED_OFFLINE" && !record.pendingBinAction,
        () => setMessages((prev) => prev.map((item) => item.queueId === record.id
          ? { ...item, status: "sent", statusText: "تم الإرسال" }
          : item)),
        async () => { await sarahInputQueue.renewUploadLease(accountId, record.id); },
      );
      if (!isCurrent(accountId, operation)) return;
      if (response.requiresBin) {
        await sarahInputQueue.transition(accountId, record.id, "WAITING_FOR_CONFIRMATION", {
          lastErrorCode: response.binError || "BIN_REQUIRED",
          pendingBinAction: response.pendingAction || record.pendingBinAction,
        });
        setMessages((prev) => prev.map((item) => item.queueId === record.id
          ? { ...item, status: "waiting_confirmation", statusText: "بانتظار التأكيد الأمني" }
          : item));
        setPendingBinAction({
          id: record.id,
          correlationId: record.correlationId,
          text: record.text,
          createdAt: record.createdAt,
          historySnapshot: retryHistory,
          baseMessages,
          pendingAction: response.pendingAction,
        });
        setBinValue("");
        setBinError(response.binError ? "رمز BIN غير صحيح. حاول مرة أخرى." : "");
        return;
      }
      await sarahInputQueue.transition(accountId, record.id, "SENT_TO_AI", { resultRef: record.correlationId });
      const hasUserMessage = baseMessages.some((message) => message.role === "user" && message.text === record.text);
      const retryMessages = (hasUserMessage
        ? baseMessages
        : [...baseMessages, { role: "user" as const, text: record.text, createdAt: record.createdAt, queueId: record.id }])
        .map((item) => item.queueId === record.id
          ? { ...item, status: undefined, statusText: undefined }
          : item);
      const completedMessages = [...retryMessages, { role: "assistant" as const, text: response.answer, createdAt: new Date().toISOString() }];
      await sarahConversationStore.saveDaily(accountId, selectedDate, completedMessages, conversationGenerationRef.current, dailyConversationTitle(selectedDate));
      await sarahInputQueue.transition(accountId, record.id, "COMPLETED");
      if (!isCurrent(accountId, operation)) return;
      setMessages(completedMessages);
    } catch (err) {
      if (isCurrent(accountId, operation)) {
        const offline = typeof navigator !== "undefined" && !navigator.onLine;
        try { await sarahInputQueue.transition(accountId, record.id, offline ? "QUEUED_OFFLINE" : "NEEDS_ATTENTION", { lastErrorCode: err instanceof Error ? err.message.slice(0, 80) : "AI_REQUEST_FAILED" }); } catch {}
        setMessages((prev) => prev.map((item) => item.queueId === record.id
          ? { ...item, status: offline ? "offline" : "failed", statusText: offline ? "بانتظار عودة الاتصال" : "فشلت المهمة" }
          : item));
        setError("");
      }
    } finally {
      if (isCurrent(accountId, operation)) { setBusy(false); await refreshQueue(accountId, operation); }
    }
  };

  useEffect(() => {
    const accountId = session?.authUserId || null;
    if (!accountId || hydratedAccount !== accountId) return;
    const leases = pending
      .filter((row) => row.actorAccountId === accountId && row.state === "UPLOADING" && row.uploadLeaseUntil)
      .map((row) => Date.parse(row.uploadLeaseUntil || ""))
      .filter(Number.isFinite);
    if (!leases.length) return;
    // Active chunk loops renew their lease. A closed tab cannot; recheck just
    // after the nearest lease expires, then recover that task safely.
    const nextExpiry = Math.min(...leases);
    const timer = window.setTimeout(() => {
      void refreshQueue(accountId, accountScopeRef.current.generation);
    }, Math.max(0, nextExpiry - Date.now() + 1000));
    return () => window.clearTimeout(timer);
  }, [session?.authUserId, hydratedAccount, pending, selectedDate]);

  useEffect(() => {
    const accountId = session?.authUserId || null;
    if (!accountId || hydratedAccount !== accountId) return;
    const handleOnline = async () => {
      if (busy || !isCurrent(accountId)) return;
      try {
        const rows = await sarahInputQueue.list(accountId);
        const next = rows.find((row) => row.actorAccountId === accountId
          && Boolean(row.text)
          && (row.state === "QUEUED_OFFLINE"
            || row.state === "READY_TO_SEND"
            || row.state === "SENT_TO_AI"
            || (row.state === "NEEDS_ATTENTION" && row.lastErrorCode === "UPLOAD_INTERRUPTED_REQUIRES_REVIEW")));
        if (next) await retryQueued(next);
      } catch {
        // The message remains visible as pending; the user can retry from it.
      }
    };
    window.addEventListener("online", handleOnline);
    if (typeof navigator !== "undefined" && navigator.onLine) void handleOnline();
    return () => window.removeEventListener("online", handleOnline);
  }, [session?.authUserId, hydratedAccount, busy, messages, pending, selectedDate]);

  const openDailyConversation = (date: string) => {
    if (busy || pendingBinAction) return;
    setDrawerOpen(false);
    setRevealedMessageId(null);
    setSwipeOffset(null);
    swipeOffsetRef.current = null;
    setMessages([]);
    setHydratedDate(null);
    setSelectedDate(date);
  };
  const startTodayConversation = () => openDailyConversation(gazaDateKey());
  const visibleConversations = showAllConversations ? dailyConversations : dailyConversations.slice(0, 7);
  const messageIdentity = (message: Message, index: number) => message.queueId || `${message.role}-${index}-${message.createdAt || message.text.slice(0, 24)}`;

  const cancelBinConfirmation = async () => {
    const current = pendingBinAction;
    const accountId = session?.authUserId || null;
    if (!current || !accountId || busy || !isCurrent(accountId)) return;
    try {
      await sarahInputQueue.transition(accountId, current.id, "NEEDS_ATTENTION", {
        lastErrorCode: "BIN_CONFIRMATION_CANCELLED",
        pendingBinAction: undefined,
      });
      setPendingBinAction(null);
      setBinValue("");
      setBinError("");
      setMessages((prev) => prev.map((item) => item.queueId === current.id
        ? { ...item, status: "failed", statusText: "أُلغي التأكيد الأمني؛ لم تُنفذ هذه العملية" }
        : item));
      await refreshQueue(accountId, accountScopeRef.current.generation);
    } catch {
      setBinError("تعذر إلغاء خطوة التأكيد. لم تُنفذ العملية.");
    }
  };

  const submitBin = async () => {
    const pendingAction = pendingBinAction;
    const accountId = session?.authUserId || null;
    const bin = binValue.trim();
    if (!pendingAction || !accountId || busy || !isCurrent(accountId) || hydratedAccount !== accountId) return;
    if (!/^\d{4,}$/.test(bin) || bin.length > 32) {
      setBinError("أدخل رمز BIN رقميًا صحيحًا.");
      return;
    }

    const operation = accountScopeRef.current.generation;
    setBusy(true);
    setError("");
    setBinError("");
    try {
      const rows = await sarahInputQueue.list(accountId);
      const current = rows.find((row) => row.id === pendingAction.id);
      if (!current || current.actorAccountId !== accountId) throw new Error("PENDING_ACTION_NOT_FOUND");
      if (current.state === "WAITING_FOR_CONFIRMATION" || current.state === "NEEDS_ATTENTION") {
        await sarahInputQueue.transition(accountId, pendingAction.id, "READY_TO_SEND");
      }
      await sarahInputQueue.transition(accountId, pendingAction.id, "UPLOADING");
      if (!isCurrent(accountId, operation)) return;

      const confirmationResponse = await sendWithLocalActions(
        pendingAction.text,
        accountId,
        pendingAction.historySnapshot,
        pendingAction.correlationId,
        bin,
        pendingAction.pendingAction,
      );
      setBinValue("");
      if (!isCurrent(accountId, operation)) return;
      if (confirmationResponse.requiresBin) {
        await sarahInputQueue.transition(accountId, pendingAction.id, "WAITING_FOR_CONFIRMATION", {
          lastErrorCode: confirmationResponse.binError || "BIN_REQUIRED",
          pendingBinAction: confirmationResponse.pendingAction || pendingAction.pendingAction,
        });
        setPendingBinAction({
          ...pendingAction,
          pendingAction: confirmationResponse.pendingAction || pendingAction.pendingAction,
        });
        setBinError(confirmationResponse.binError ? "رمز BIN غير صحيح. حاول مرة أخرى." : "أدخل رمز BIN لإكمال العملية.");
        return;
      }

      // The protected operation has succeeded. Remove the secure prompt now,
      // then resume using the exact original request identity (same text/history).
      await sarahInputQueue.transition(accountId, pendingAction.id, "READY_TO_SEND", {
        pendingBinAction: undefined,
        lastErrorCode: undefined,
      });
      await sarahInputQueue.transition(accountId, pendingAction.id, "UPLOADING");
      setPendingBinAction(null);
      setBinValue("");
      setBinError("");
      setMessages((prev) => prev.map((item) => item.queueId === pendingAction.id
        ? { ...item, status: "running", statusText: "تم التأكيد الأمني؛ سارة تستكمل المهمة" }
        : item));

      const continuationResponse = await sendWithLocalActions(
        pendingAction.text,
        accountId,
        pendingAction.historySnapshot,
        pendingAction.correlationId,
        undefined,
        undefined,
        true,
        undefined,
        async () => { await sarahInputQueue.renewUploadLease(accountId, pendingAction.id); },
      );
      if (!isCurrent(accountId, operation)) return;
      if (continuationResponse.requiresBin) {
        await sarahInputQueue.transition(accountId, pendingAction.id, "WAITING_FOR_CONFIRMATION", {
          lastErrorCode: continuationResponse.binError || "BIN_REQUIRED",
          pendingBinAction: continuationResponse.pendingAction,
        });
        setPendingBinAction({
          ...pendingAction,
          pendingAction: continuationResponse.pendingAction,
        });
        setMessages((prev) => prev.map((item) => item.queueId === pendingAction.id
          ? { ...item, status: "waiting_confirmation", statusText: "بانتظار تأكيد أمني إضافي" }
          : item));
        setBinError(continuationResponse.binError ? "رمز BIN غير صحيح. حاول مرة أخرى." : "توجد عملية أخرى تحتاج إلى تأكيد أمني.");
        return;
      }

      await sarahInputQueue.transition(accountId, pendingAction.id, "SENT_TO_AI", { resultRef: pendingAction.correlationId, pendingBinAction: undefined });
      const alreadyHasUserMessage = pendingAction.baseMessages.some(
        (message) => message.role === "user" && message.text === pendingAction.text
      );
      const transcriptBeforeAnswer = alreadyHasUserMessage
        ? pendingAction.baseMessages
        : [...pendingAction.baseMessages, { role: "user" as const, text: pendingAction.text, createdAt: pendingAction.createdAt || new Date().toISOString() }];
      const completedMessages = [
        ...transcriptBeforeAnswer.map((item) => item.queueId === pendingAction.id
          ? { ...item, status: undefined, statusText: undefined }
          : item),
        { role: "assistant" as const, text: continuationResponse.answer, createdAt: new Date().toISOString() },
      ];
      await sarahConversationStore.saveDaily(accountId, selectedDate, completedMessages, conversationGenerationRef.current, dailyConversationTitle(selectedDate));
      await sarahInputQueue.transition(accountId, pendingAction.id, "COMPLETED");
      if (!isCurrent(accountId, operation)) return;
      setMessages(completedMessages);
      setPendingBinAction(null);
      setBinError("");
    } catch (err) {
      if (isCurrent(accountId, operation)) {
        const offline = typeof navigator !== "undefined" && !navigator.onLine;
        try {
          const rows = await sarahInputQueue.list(accountId);
          const current = rows.find((row) => row.id === pendingAction.id);
          if (current?.state === "UPLOADING" || current?.state === "SENT_TO_AI") {
            await sarahInputQueue.transition(accountId, pendingAction.id, offline ? "QUEUED_OFFLINE" : "NEEDS_ATTENTION", {
              lastErrorCode: err instanceof Error ? err.message.slice(0, 80) : "AI_REQUEST_FAILED",
            });
          }
        } catch {}
        setMessages((prev) => prev.map((item) => item.queueId === pendingAction.id
          ? { ...item, status: offline ? "offline" : "failed", statusText: offline ? "بانتظار عودة الاتصال" : "توقفت بعد التأكيد؛ يمكن استكمالها من آخر نقطة محفوظة" }
          : item));
        setPendingBinAction(null);
        setBinValue("");
        setBinError("");
      }
    } finally {
      setBinValue("");
      if (isCurrent(accountId, operation)) {
        setBusy(false);
        await refreshQueue(accountId, operation);
      }
    }
  };

  if (!canUse) return <div className="p-6 text-center text-sm text-gray-500">لا تملك صلاحية استخدام سارة.</div>;

  return (
    <section dir="rtl" className="relative flex h-[100dvh] max-h-[100dvh] w-full flex-col gap-4 overflow-hidden p-3 sm:p-5">
      <header className="flex items-center justify-between gap-3">
        <button type="button" onClick={() => setDrawerOpen(true)} aria-label="فتح محادثات سارة" className="inline-flex items-center gap-3 rounded-2xl px-2 py-1 text-gray-900 transition hover:bg-gray-100 dark:text-[#daf1de] dark:hover:bg-[#0c312b]">
          <span className="rounded-2xl bg-emerald-100 p-3 text-emerald-700 dark:bg-[#0c312b] dark:text-[#daf1de]"><Sparkles className="h-5 w-5" /></span>
          <span className="font-bold text-lg">سارة</span>
        </button>
        <button type="button" onClick={() => setDrawerOpen(true)} aria-label="قائمة المحادثات" className="rounded-xl p-3 text-gray-600 hover:bg-gray-100 dark:text-[#daf1de] dark:hover:bg-[#0c312b]"><Menu className="h-5 w-5" /></button>
      </header>
      {drawerOpen && <div className="fixed inset-0 z-[100] bg-black/45" onClick={() => setDrawerOpen(false)}>
        <aside dir="rtl" className="absolute inset-y-0 right-0 flex w-[min(88vw,360px)] flex-col border-l border-gray-200 bg-white p-4 shadow-2xl dark:border-[#123832] dark:bg-[#061f1c]" onClick={(event) => event.stopPropagation()}>
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2 font-bold"><Sparkles className="h-5 w-5 text-emerald-600" /> سارة</div>
            <button type="button" onClick={() => setDrawerOpen(false)} aria-label="إغلاق القائمة" className="rounded-lg p-2 hover:bg-gray-100 dark:hover:bg-[#0c312b]"><X className="h-5 w-5" /></button>
          </div>
          <button type="button" disabled={busy || Boolean(pendingBinAction)} onClick={startTodayConversation} className="mb-3 flex w-full items-center gap-2 rounded-xl bg-emerald-700 px-3 py-3 text-sm font-semibold text-white disabled:opacity-50">
            <MessageSquare className="h-4 w-4" /> محادثة اليوم
          </button>
          <div className="mb-2 text-xs font-semibold text-gray-500">المحادثات اليومية</div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
            {visibleConversations.map((conversation) => <button key={conversation.id} type="button" disabled={busy || Boolean(pendingBinAction)} onClick={() => openDailyConversation(conversation.date)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-right text-sm transition hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-[#0c312b] ${selectedDate === conversation.date ? "bg-emerald-50 font-semibold text-emerald-800 dark:bg-[#0c312b] dark:text-[#daf1de]" : "text-gray-700 dark:text-gray-300"}`}>
              <MessageSquare className="h-4 w-4 shrink-0 opacity-70" />
              <span className="min-w-0 flex-1 truncate">{conversation.title || dailyConversationTitle(conversation.date)}</span>
              <span className="text-[10px] text-gray-400">{conversation.date.slice(5).split("-").reverse().join("/")}</span>
            </button>)}
            {!dailyConversations.length && <p className="px-2 py-5 text-center text-xs text-gray-500">لا توجد محادثات سابقة.</p>}
            {dailyConversations.length > 7 && <button type="button" onClick={() => setShowAllConversations((value) => !value)} className="w-full rounded-xl px-3 py-3 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-[#0c312b]">{showAllConversations ? "عرض آخر 7 أيام" : "إظهار المزيد"}</button>}
          </div>
          <div className="mt-4 border-t border-gray-200 pt-3 dark:border-[#123832]">
            <button type="button" onClick={() => { setDrawerOpen(false); onExit?.(); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/20">
              <LogOut className="h-4 w-4" /> خروج من سارة
            </button>
          </div>
        </aside>
      </div>}
      <div ref={messagesContainerRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-1 py-2 scroll-smooth">
        {!messages.length && <p className="py-12 text-center text-sm text-gray-500">احكيلي شو بدك، وبساعدك.</p>}
        {messages.map((message, index) => {
          const identity = messageIdentity(message, index);
          const revealed = revealedMessageId === identity;
          const offset = swipeOffset?.id === identity ? swipeOffset.value : 0;
          const time = messageTime(message.createdAt);
          const bubble = <div
            onTouchStart={(event) => { swipeStartRef.current = { id: identity, x: event.touches[0]?.clientX || 0 }; }}
            onTouchMove={(event) => {
              const start = swipeStartRef.current;
              if (!start || start.id !== identity) return;
              const delta = Math.max(-72, Math.min(72, (event.touches[0]?.clientX || start.x) - start.x));
              swipeOffsetRef.current = { id: identity, value: delta };
              setSwipeOffset({ id: identity, value: delta });
            }}
            onTouchEnd={() => {
              const start = swipeStartRef.current;
              const moved = swipeOffsetRef.current?.id === identity ? swipeOffsetRef.current.value : 0;
              if (start?.id === identity && Math.abs(moved) >= 24) setRevealedMessageId(identity);
              else if (start?.id === identity) setRevealedMessageId(null);
              swipeStartRef.current = null;
              swipeOffsetRef.current = null;
              setSwipeOffset(null);
            }}
            style={{ transform: `translateX(${offset}px)`, transition: offset === 0 ? "transform 180ms ease" : "none", touchAction: "pan-y" }}
            className={`max-w-[90%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-7 ${message.role === "user" ? "ms-auto bg-emerald-600 text-white" : "me-auto bg-gray-100 text-gray-900 dark:bg-[#0c312b] dark:text-[#daf1de]"}`}>
            {message.text}
            {message.statusText && <div className="mt-1 text-[11px] opacity-80">{message.statusText}</div>}
            {message.role === "user" && (message.status === "failed" || message.status === "offline") && message.queueId && pending.find((item) => item.id === message.queueId) && (
              <button type="button" disabled={busy || !navigator.onLine} onClick={() => {
                const row = pending.find((item) => item.id === message.queueId);
                if (row) void retryQueued(row);
              }} className="mt-2 rounded-lg border border-current/30 px-2 py-1 text-xs disabled:opacity-40">إعادة المحاولة</button>
            )}
          </div>;
          const timeNode = revealed && time ? <time className="shrink-0 pb-2 text-[10px] tabular-nums text-gray-400">{time}</time> : null;
          return <div key={identity} className={`flex w-full items-end gap-2 ${message.role === "user" ? "justify-end" : "justify-start"}`}>
            {message.role === "assistant" && timeNode}
            {bubble}
            {message.role === "user" && timeNode}
          </div>;
        })}
        {busy && <div className="text-sm text-gray-500 animate-pulse">سارة بتفكر...</div>}
        {error && <div className="flex items-start gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300"><AlertCircle className="h-4 w-4 shrink-0" /><span>{error}</span></div>}
      </div>
      {pendingBinAction && <div className="rounded-2xl border border-amber-400/60 bg-amber-50 p-4 text-sm dark:bg-amber-950/20">
        <div className="mb-1 font-semibold">تأكيد أمني مطلوب</div>
        <p className="mb-3 text-gray-700 dark:text-gray-300">هذه العملية تتطلب رمز BIN الخاص بحسابك. أدخله هنا فقط؛ لن يُضاف إلى المحادثة أو سجل الرسائل أو يُرسل إلى Gemini.</p>
        <p className="mb-3 rounded-lg bg-white/70 px-3 py-2 text-xs font-semibold text-gray-800 dark:bg-black/20 dark:text-amber-100">العملية التي ستؤكدها: {describePendingBinAction(pendingBinAction.pendingAction)}</p>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={32}
          value={binValue}
          onChange={(event) => { setBinValue(event.target.value.replace(/[^0-9]/g, "").slice(0, 32)); setBinError(""); }}
          placeholder="رمز BIN"
          aria-label="رمز BIN"
          className="mb-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-3 text-left tracking-[0.3em] outline-none focus:border-emerald-500 dark:border-[#31554f] dark:bg-[#061f1c]"
          disabled={busy}
        />
        {binError && <p className="mb-2 text-xs text-red-600 dark:text-red-300">{binError}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy || !binValue.trim()} onClick={() => void submitBin()} className="rounded-xl bg-emerald-700 px-4 py-2 font-semibold text-white disabled:opacity-40">تأكيد وتنفيذ</button>
          <button type="button" disabled={busy} onClick={() => void cancelBinConfirmation()} className="rounded-xl border border-gray-300 px-4 py-2 dark:border-[#31554f]">إلغاء</button>
        </div>
      </div>}

      <form onSubmit={(event) => { event.preventDefault(); void send(); }} className="flex items-end gap-2 rounded-2xl border border-gray-200 bg-white p-2 dark:border-[#123832] dark:bg-[#061f1c]">
        <textarea rows={2} maxLength={20000} value={text} onChange={(event) => setText(event.target.value)} placeholder="اكتب لسارة..." className="max-h-40 min-h-[48px] flex-1 resize-y bg-transparent p-2 text-sm outline-none" disabled={busy || Boolean(pendingBinAction) || hydratedAccount !== session?.authUserId} />
        <Button type="submit" disabled={busy || Boolean(pendingBinAction) || !text.trim() || hydratedAccount !== session?.authUserId} className="h-11 min-w-11"><ArrowUp className="h-4 w-4" /></Button>
      </form>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button type="button" disabled={busy || hydratedAccount !== session?.authUserId || hydratedDate !== selectedDate} onClick={() => void clearTranscript()} className="text-xs text-red-600 underline disabled:opacity-40">مسح محادثة اليوم</button>
      </div>
      <p className="text-center text-[11px] text-gray-500">تُنفّذ سارة العمليات وفق صلاحيات حسابك الحالية.</p>
    </section>
  );
};
