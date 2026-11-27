import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Sparkles, AlertCircle } from "lucide-react";
import { sarahChatService, type SarahPendingBinAction } from "../../services/ai/sarahChatService";
import { UserSession } from "../../services/auth/authService";
import { Button } from "../ui/Button";
import { sarahInputQueue, SarahInputRecord } from "../../application/ai/sarahInputQueue";
import { sarahConversationStore } from "../../application/ai/sarahConversationStore";
import { SarahAccountOperationScope } from "../../application/ai/sarahAccountOperationScope";
import { buildSarahHistorySnapshot } from "../../application/ai/sarahHistory";
import { localDb } from "../../infrastructure/localDb/localDb";
import { isBinRequiredOutboxCommand } from "../../infrastructure/sync/binAuthorization";
import { globalSyncBridge } from "../../infrastructure/sync/syncBridge";
import { invokeSupabaseRpc } from "../../services/supabase/client";
import type { SarahLocalSyncActionResult, SarahLocalSyncContext } from "../../services/ai/sarahChatService";

type Message = {
  role: "user" | "assistant";
  text: string;
  status?: "sending" | "sent" | "offline" | "running" | "waiting_confirmation" | "failed";
  queueId?: string;
  statusText?: string;
};
type PendingBinAction = {
  id: string;
  correlationId: string;
  text: string;
  historySnapshot: { role: "user" | "assistant"; text: string }[];
  baseMessages: Message[];
  pendingAction?: SarahPendingBinAction;
};
const accountScopeIdentity = (accountId?: string | null, authUserId?: string) =>
  accountId ? `${accountId}:${authUserId || "unverified"}` : null;

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

export const SarahChatPage: React.FC<{ session: UserSession | null; onBack?: () => void }> = ({ session }) => {
  const [messages, setMessages] = useState<Message[]>([]);
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
  }, [session?.userId, session?.authUserId]);

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
    void sarahConversationStore.load(accountId).then((snapshot) => {
      if (!cancelled && isCurrent(accountId, operation)) {
        conversationGenerationRef.current = snapshot.generation;
        setMessages(snapshot.messages);
        setHydratedAccount(accountId);
      }
    }).catch((err) => {
      if (!cancelled && isCurrent(accountId, operation)) setError(err instanceof Error ? err.message : "CONVERSATION_LOAD_FAILED");
    });
    return () => { cancelled = true; };
  }, [session?.userId, session?.authUserId]);

  useEffect(() => {
    const accountId = session?.authUserId || null;
    if (!accountId || hydratedAccount !== accountId) return;
    return sarahConversationStore.subscribeToClear((notice) => {
      if (notice.accountId !== accountId || !isCurrent(accountId)) return;
      void sarahConversationStore.load(accountId).then((snapshot) => {
        if (isCurrent(accountId) && snapshot.generation >= conversationGenerationRef.current) {
          conversationGenerationRef.current = snapshot.generation;
          setMessages(snapshot.messages);
        }
      }).catch((err) => {
        if (isCurrent(accountId)) setError(err instanceof Error ? err.message : "CONVERSATION_SYNC_FAILED");
      });
    });
  }, [session?.userId, session?.authUserId, hydratedAccount]);

  useEffect(() => {
    const accountId = session?.authUserId || null;
    if (!accountId || hydratedAccount !== accountId || !isCurrent(accountId) || busy) return;
    // Save only the transcript explicitly hydrated for this identity.
    void sarahConversationStore.save(accountId, messages, conversationGenerationRef.current).catch((err) => {
      if (isCurrent(accountId)) setError(err instanceof Error ? err.message : "CONVERSATION_SAVE_FAILED");
    });
  }, [messages, session?.userId, session?.authUserId, hydratedAccount, busy]);

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
    if (!activeAccountId || hydratedAccount !== activeAccountId || pendingBinAction) return;
    const record = pending.find((item) =>
      item.actorAccountId === activeAccountId
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
      historySnapshot,
      baseMessages,
      pendingAction: record.pendingBinAction,
    });
    setBinValue("");
    setBinError("");
  }, [activeAccountId, hydratedAccount, pending, pendingBinAction, messages]);

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
  ) => {
    const localSyncContext = await collectLocalSyncContext();
    let response = await sarahChatService.send(
      message,
      accountId,
      history,
      correlationId,
      bin,
      localSyncContext ? { localSyncContext } : undefined,
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
      response = await sarahChatService.send(
        message,
        accountId,
        history,
        correlationId,
        bin,
        { localSyncContext: refreshedContext, localSyncActionResult },
        confirmationAction,
        resumeTask,
      );
      if (response.requiresLocalSync) throw new Error("LOCAL_SYNC_HANDOFF_LOOP");
    }
    onAccepted?.();
    while (response.taskPending) {
      if (!isCurrent(accountId)) throw new Error("ACCOUNT_CHANGED");
      if (typeof navigator !== "undefined" && !navigator.onLine) throw new Error("AI_SETTINGS_NETWORK_ERROR");
      await new Promise((resolve) => setTimeout(resolve, response.retryAfterMs || 900));
      response = await sarahChatService.send(
        message,
        accountId,
        history,
        correlationId,
        undefined,
        undefined,
        undefined,
        true,
      );
    }
    return response;
  };

  const send = async () => {
    const accountId = session?.authUserId || null;
    const clean = text.trim();
    if (!clean || busy || !canUse || !accountId || !isCurrent(accountId) || hydratedAccount !== accountId) return;
    if (/\bBIN\b\s*[:：]?\s*\d{4,32}/i.test(clean)) {
      setText("");
      setError("لا ترسل رمز BIN داخل المحادثة؛ أدخله فقط في خانة التأكيد الأمني.");
      return;
    }
    const operation = accountScopeRef.current.generation;
    const baseMessages = messages;
    const historySnapshot = buildSarahHistorySnapshot(baseMessages);
    setError("");
    setBusy(true);
    const id = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    try {
      await sarahInputQueue.enqueue({
        id, actorAccountId: accountId, deviceId: "web-client", kind: "text",
        state: navigator.onLine ? "READY_TO_SEND" : "QUEUED_OFFLINE",
        text: clean,
        correlationId,
        historySnapshot,
      });
      if (!isCurrent(accountId, operation)) return;
      setText("");
      setMessages([...baseMessages, {
        role: "user",
        text: clean,
        status: navigator.onLine ? "sending" : "offline",
        queueId: id,
      }]);
      await refreshQueue(accountId, operation);
      if (!isCurrent(accountId, operation)) return;
      if (!navigator.onLine) {
        const offlineMessages = [...baseMessages, {
          role: "user" as const,
          text: clean,
          status: "offline" as const,
          queueId: id,
          statusText: "بانتظار عودة الاتصال",
        }];
        setMessages(offlineMessages);
        await sarahConversationStore.save(accountId, offlineMessages, conversationGenerationRef.current);
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
            setTimeout(() => setMessages((prev) => prev.map((item) => item.queueId === id && item.status === "sent"
              ? { ...item, status: undefined, statusText: undefined }
              : item)), 1000);
          },
        );
        if (!isCurrent(accountId, operation)) return;
        if (response.requiresBin) {
          await sarahInputQueue.transition(accountId, id, "WAITING_FOR_CONFIRMATION", {
            lastErrorCode: response.binError || "BIN_REQUIRED",
            pendingBinAction: response.pendingAction,
          });
          setPendingBinAction({ id, correlationId, text: clean, historySnapshot, baseMessages, pendingAction: response.pendingAction });
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
          { role: "user" as const, text: clean, queueId: id },
          { role: "assistant" as const, text: response.answer },
        ];
        await sarahConversationStore.save(accountId, completedMessages, conversationGenerationRef.current);
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
            status: offline ? "offline" as const : "failed" as const,
            queueId: id,
            statusText: offline ? "بانتظار عودة الاتصال" : "فشلت المهمة",
          },
        ];
        setMessages(failureMessages);
        await sarahConversationStore.save(accountId, failureMessages, conversationGenerationRef.current).catch(() => undefined);
        await refreshQueue(accountId, operation);
      }
    } finally {
      if (isCurrent(accountId, operation)) setBusy(false);
    }
  };

  const clearTranscript = async () => {
    const accountId = session?.authUserId || null;
    if (!accountId || busy || hydratedAccount !== accountId || !isCurrent(accountId)) return;
    if (!window.confirm("مسح سجل المحادثة لهذا الحساب فقط؟")) return;
    const operation = accountScopeRef.current.generation;
    try {
      const nextGeneration = await sarahConversationStore.clear(accountId);
      if (!isCurrent(accountId, operation)) return;
      conversationGenerationRef.current = nextGeneration;
      setMessages([]);
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
      if (record.state === "NEEDS_ATTENTION" || record.state === "QUEUED_OFFLINE" || record.state === "WAITING_FOR_CONFIRMATION") {
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
        : [...baseMessages, { role: "user" as const, text: record.text, queueId: record.id }])
        .map((item) => item.queueId === record.id
          ? { ...item, status: undefined, statusText: undefined }
          : item);
      const completedMessages = [...retryMessages, { role: "assistant" as const, text: response.answer }];
      await sarahConversationStore.save(accountId, completedMessages, conversationGenerationRef.current);
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
    const handleOnline = async () => {
      if (busy || !isCurrent(accountId)) return;
      try {
        const rows = await sarahInputQueue.list(accountId);
        const next = rows.find((row) => row.actorAccountId === accountId
          && row.state === "QUEUED_OFFLINE" && Boolean(row.text));
        if (next) await retryQueued(next);
      } catch {
        // The message remains visible as pending; the user can retry from it.
      }
    };
    window.addEventListener("online", handleOnline);
    if (typeof navigator !== "undefined" && navigator.onLine) void handleOnline();
    return () => window.removeEventListener("online", handleOnline);
  }, [session?.authUserId, hydratedAccount, busy, messages, pending]);

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
        : [...pendingAction.baseMessages, { role: "user" as const, text: pendingAction.text }];
      const completedMessages = [
        ...transcriptBeforeAnswer.map((item) => item.queueId === pendingAction.id
          ? { ...item, status: undefined, statusText: undefined }
          : item),
        { role: "assistant" as const, text: continuationResponse.answer },
      ];
      await sarahConversationStore.save(accountId, completedMessages, conversationGenerationRef.current);
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
          ? { ...item, status: offline ? "offline" : "failed", statusText: offline ? "بانتظار عودة الاتصال" : "فشلت المهمة بعد التأكيد الأمني" }
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
    <section dir="rtl" className="mx-auto flex min-h-[65vh] max-w-3xl flex-col gap-4 p-3 sm:p-5">
      <header className="flex items-center gap-3">
        <div className="rounded-2xl bg-emerald-100 p-3 text-emerald-700 dark:bg-[#0c312b] dark:text-[#daf1de]"><Sparkles className="h-5 w-5" /></div>
        <div><h1 className="font-bold text-lg">سارة</h1><p className="text-xs text-gray-500">مساعد نقطة الشحن — Gemini</p></div>
      </header>
      <div className="flex-1 space-y-3 rounded-2xl border border-gray-200 bg-white p-3 dark:border-[#123832] dark:bg-[#061f1c]">
        {!messages.length && <p className="py-12 text-center text-sm text-gray-500">احكيلي شو بدك، وبساعدك.</p>}
        {messages.map((message, index) => (
          <div key={index} className={`max-w-[90%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-7 ${message.role === "user" ? "ms-auto bg-emerald-600 text-white" : "me-auto bg-gray-100 text-gray-900 dark:bg-[#0c312b] dark:text-[#daf1de]"}`}>
            {message.text}
            {message.statusText && <div className="mt-1 text-[11px] opacity-80">{message.statusText}</div>}
            {message.role === "user" && (message.status === "failed" || message.status === "offline") && message.queueId && pending.find((item) => item.id === message.queueId) && (
              <button type="button" disabled={busy || !navigator.onLine} onClick={() => {
                const row = pending.find((item) => item.id === message.queueId);
                if (row) void retryQueued(row);
              }} className="mt-2 rounded-lg border border-current/30 px-2 py-1 text-xs disabled:opacity-40">إعادة المحاولة</button>
            )}
          </div>
        ))}
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
        <textarea rows={2} maxLength={20000} value={text} onChange={(event) => setText(event.target.value)} placeholder="اكتب لسارة..." className="max-h-40 min-h-[48px] flex-1 resize-y bg-transparent p-2 text-sm outline-none" disabled={busy || hydratedAccount !== session?.authUserId} />
        <Button type="submit" disabled={busy || !text.trim() || hydratedAccount !== session?.authUserId} className="h-11 min-w-11"><ArrowUp className="h-4 w-4" /></Button>
      </form>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button type="button" disabled={busy || hydratedAccount !== session?.authUserId} onClick={() => void clearTranscript()} className="text-xs text-red-600 underline disabled:opacity-40">مسح سجل المحادثة</button>

      </div>
      <p className="text-center text-[11px] text-gray-500">سارة تعمل وفق صلاحيات حسابك الحالية؛ وتتحقق قاعدة البيانات من كل عملية قبل تنفيذها.</p>
    </section>
  );
};
