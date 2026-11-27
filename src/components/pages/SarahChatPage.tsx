import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Sparkles, AlertCircle } from "lucide-react";
import { sarahChatService } from "../../services/ai/sarahChatService";
import { UserSession } from "../../services/auth/authService";
import { Button } from "../ui/Button";
import { sarahInputQueue, SarahInputRecord } from "../../application/ai/sarahInputQueue";
import { sarahConversationStore } from "../../application/ai/sarahConversationStore";
import { SarahAccountOperationScope } from "../../application/ai/sarahAccountOperationScope";
import { buildSarahHistorySnapshot } from "../../application/ai/sarahHistory";
import { localDb } from "../../infrastructure/localDb/localDb";
import { isBinRequiredOutboxCommand } from "../../infrastructure/sync/binAuthorization";
import { globalSyncBridge } from "../../infrastructure/sync/syncBridge";
import type { SarahLocalSyncActionResult, SarahLocalSyncContext } from "../../services/ai/sarahChatService";

type Message = { role: "user" | "assistant"; text: string };
type PendingBinAction = {
  id: string;
  correlationId: string;
  text: string;
  historySnapshot: { role: "user" | "assistant"; text: string }[];
  baseMessages: Message[];
};
const accountScopeIdentity = (accountId?: string | null, authUserId?: string) =>
  accountId ? `${accountId}:${authUserId || "unverified"}` : null;

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
  ) => {
    const localSyncContext = await collectLocalSyncContext();
    let response = await sarahChatService.send(
      message,
      accountId,
      history,
      correlationId,
      bin,
      localSyncContext ? { localSyncContext } : undefined,
    );
    if (response.requiresLocalSync && response.localSyncAction === "manual_sync") {
      if (!canManageSync) throw new Error("SYNC_MANAGE_PERMISSION_REQUIRED");
      let localSyncActionResult: SarahLocalSyncActionResult;
      try {
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
      );
      if (response.requiresLocalSync) throw new Error("LOCAL_SYNC_HANDOFF_LOOP");
    }
    return response;
  };

  const send = async () => {
    const accountId = session?.authUserId || null;
    const clean = text.trim();
    if (!clean || busy || !canUse || !accountId || !isCurrent(accountId) || hydratedAccount !== accountId) return;
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
        state: navigator.onLine ? "READY_TO_SEND" : "QUEUED_OFFLINE", text: clean, correlationId,
      });
      if (!isCurrent(accountId, operation)) return;
      setText("");
      setMessages([...baseMessages, { role: "user", text: clean }]);
      await refreshQueue(accountId, operation);
      if (!isCurrent(accountId, operation)) return;
      if (!navigator.onLine) {
        setMessages((prev) => isCurrent(accountId, operation) ? [...prev, { role: "assistant", text: "حفظت رسالتك محليًا في الطابور؛ لم تُرسل بعد لأن الإنترنت غير متصل." }] : prev);
        return;
      }
      await sarahInputQueue.transition(accountId, id, "UPLOADING");
      if (!isCurrent(accountId, operation)) return;
      try {
        const response = await sendWithLocalActions(clean, accountId, historySnapshot, correlationId);
        if (!isCurrent(accountId, operation)) return;
        if (response.requiresBin) {
          await sarahInputQueue.transition(accountId, id, "WAITING_FOR_CONFIRMATION", {
            lastErrorCode: response.binError || "BIN_REQUIRED",
          });
          setPendingBinAction({ id, correlationId, text: clean, historySnapshot, baseMessages });
          setBinValue("");
          setBinError(response.binError ? "رمز BIN غير صحيح. حاول مرة أخرى." : "");
          await refreshQueue(accountId, operation);
          return;
        }
        await sarahInputQueue.transition(accountId, id, "SENT_TO_AI", { resultRef: correlationId });
        const completedMessages = [...baseMessages, { role: "user" as const, text: clean }, { role: "assistant" as const, text: response.answer }];
        await sarahConversationStore.save(accountId, completedMessages, conversationGenerationRef.current);
        await sarahInputQueue.transition(accountId, id, "COMPLETED");
        if (!isCurrent(accountId, operation)) return;
        setMessages(completedMessages);
        await refreshQueue(accountId, operation);
      } catch (err) {
        if (!isCurrent(accountId, operation)) return;
        await sarahInputQueue.transition(accountId, id, "NEEDS_ATTENTION", {
          lastErrorCode: err instanceof Error ? err.message.slice(0, 80) : "AI_REQUEST_FAILED",
        });
        throw err;
      }
    } catch (err) {
      if (isCurrent(accountId, operation)) {
        setError(err instanceof Error ? err.message : "AI_REQUEST_FAILED");
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
    try {
      if (record.state === "NEEDS_ATTENTION" || record.state === "QUEUED_OFFLINE" || record.state === "WAITING_FOR_CONFIRMATION") {
        await sarahInputQueue.transition(accountId, record.id, "READY_TO_SEND");
      }
      await sarahInputQueue.transition(accountId, record.id, "UPLOADING");
      if (!isCurrent(accountId, operation)) return;
      const baseMessages = messages;
      const retryHistory = buildSarahHistorySnapshot(baseMessages);
      if (retryHistory.at(-1)?.role === "user" && retryHistory.at(-1)?.text === record.text) retryHistory.pop();
      const response = await sendWithLocalActions(record.text, accountId, retryHistory, record.correlationId);
      if (!isCurrent(accountId, operation)) return;
      if (response.requiresBin) {
        await sarahInputQueue.transition(accountId, record.id, "WAITING_FOR_CONFIRMATION", {
          lastErrorCode: response.binError || "BIN_REQUIRED",
        });
        setPendingBinAction({
          id: record.id,
          correlationId: record.correlationId,
          text: record.text,
          historySnapshot: retryHistory,
          baseMessages,
        });
        setBinValue("");
        setBinError(response.binError ? "رمز BIN غير صحيح. حاول مرة أخرى." : "");
        return;
      }
      await sarahInputQueue.transition(accountId, record.id, "SENT_TO_AI", { resultRef: record.correlationId });
      const hasUserMessage = baseMessages.some((message) => message.role === "user" && message.text === record.text);
      const retryMessages = hasUserMessage ? baseMessages : [...baseMessages, { role: "user" as const, text: record.text }];
      const completedMessages = [...retryMessages, { role: "assistant" as const, text: response.answer }];
      await sarahConversationStore.save(accountId, completedMessages, conversationGenerationRef.current);
      await sarahInputQueue.transition(accountId, record.id, "COMPLETED");
      if (!isCurrent(accountId, operation)) return;
      setMessages(completedMessages);
    } catch (err) {
      if (isCurrent(accountId, operation)) {
        try { await sarahInputQueue.transition(accountId, record.id, "NEEDS_ATTENTION", { lastErrorCode: err instanceof Error ? err.message.slice(0, 80) : "AI_REQUEST_FAILED" }); } catch {}
        setError(err instanceof Error ? err.message : "AI_REQUEST_FAILED");
      }
    } finally {
      if (isCurrent(accountId, operation)) { setBusy(false); await refreshQueue(accountId, operation); }
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

      const response = await sendWithLocalActions(
        pendingAction.text,
        accountId,
        pendingAction.historySnapshot,
        pendingAction.correlationId,
        bin
      );
      setBinValue("");
      if (!isCurrent(accountId, operation)) return;
      if (response.requiresBin) {
        await sarahInputQueue.transition(accountId, pendingAction.id, "WAITING_FOR_CONFIRMATION", {
          lastErrorCode: response.binError || "BIN_REQUIRED",
        });
        setBinError(response.binError ? "رمز BIN غير صحيح. حاول مرة أخرى." : "أدخل رمز BIN لإكمال العملية.");
        return;
      }

      await sarahInputQueue.transition(accountId, pendingAction.id, "SENT_TO_AI", { resultRef: pendingAction.correlationId });
      const alreadyHasUserMessage = pendingAction.baseMessages.some(
        (message) => message.role === "user" && message.text === pendingAction.text
      );
      const transcriptBeforeAnswer = alreadyHasUserMessage
        ? pendingAction.baseMessages
        : [...pendingAction.baseMessages, { role: "user" as const, text: pendingAction.text }];
      const completedMessages = [...transcriptBeforeAnswer, { role: "assistant" as const, text: response.answer }];
      await sarahConversationStore.save(accountId, completedMessages, conversationGenerationRef.current);
      await sarahInputQueue.transition(accountId, pendingAction.id, "COMPLETED");
      if (!isCurrent(accountId, operation)) return;
      setMessages(completedMessages);
      setPendingBinAction(null);
      setBinError("");
    } catch (err) {
      if (isCurrent(accountId, operation)) {
        try {
          const rows = await sarahInputQueue.list(accountId);
          const current = rows.find((row) => row.id === pendingAction.id);
          if (current?.state === "UPLOADING" || current?.state === "SENT_TO_AI") {
            await sarahInputQueue.transition(accountId, pendingAction.id, "NEEDS_ATTENTION", {
              lastErrorCode: err instanceof Error ? err.message.slice(0, 80) : "AI_REQUEST_FAILED",
            });
          }
        } catch {}
        setBinError("تعذر إكمال العملية. يمكنك إعادة المحاولة؛ لن يُحفظ رمز BIN.");
        setError(err instanceof Error ? err.message : "AI_REQUEST_FAILED");
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
          </div>
        ))}
        {busy && <div className="text-sm text-gray-500 animate-pulse">سارة بتفكر...</div>}
        {error && <div className="flex items-start gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300"><AlertCircle className="h-4 w-4 shrink-0" /><span>{error}</span></div>}
      </div>
      {pendingBinAction && <div className="rounded-2xl border border-amber-400/60 bg-amber-50 p-4 text-sm dark:bg-amber-950/20">
        <div className="mb-1 font-semibold">تأكيد أمني مطلوب</div>
        <p className="mb-3 text-gray-700 dark:text-gray-300">هذه العملية تتطلب رمز BIN الخاص بحسابك. أدخله هنا فقط؛ لن يُضاف إلى المحادثة أو سجل الرسائل أو يُرسل إلى Gemini.</p>
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
          <button type="button" disabled={busy} onClick={() => { setPendingBinAction(null); setBinValue(""); setBinError(""); }} className="rounded-xl border border-gray-300 px-4 py-2 dark:border-[#31554f]">إلغاء</button>
        </div>
      </div>}
      {pending.filter((item) => item.state !== "COMPLETED").length > 0 && <div className="rounded-xl border border-amber-300/60 bg-amber-50 p-3 text-sm dark:bg-amber-950/20"><div className="mb-2 font-semibold">رسائل محفوظة / تحتاج متابعة</div>{pending.filter((item) => item.state !== "COMPLETED").map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-amber-200 py-2"><span className="min-w-0 flex-1 truncate">{item.text || "رسالة صوتية محفوظة"} <span className="text-xs text-gray-500">({item.state})</span></span>{(item.state === "QUEUED_OFFLINE" || item.state === "NEEDS_ATTENTION" || item.state === "WAITING_FOR_CONFIRMATION") && <button type="button" disabled={busy || !navigator.onLine} onClick={() => void retryQueued(item)} className="rounded-lg bg-amber-700 px-3 py-1 text-white disabled:opacity-40">إعادة إرسال</button>}</div>)}</div>}
      <form onSubmit={(event) => { event.preventDefault(); void send(); }} className="flex items-end gap-2 rounded-2xl border border-gray-200 bg-white p-2 dark:border-[#123832] dark:bg-[#061f1c]">
        <textarea rows={2} maxLength={20000} value={text} onChange={(event) => setText(event.target.value)} placeholder="اكتب لسارة..." className="max-h-40 min-h-[48px] flex-1 resize-y bg-transparent p-2 text-sm outline-none" disabled={busy || hydratedAccount !== session?.authUserId} />
        <Button type="submit" disabled={busy || !text.trim() || hydratedAccount !== session?.authUserId} className="h-11 min-w-11"><ArrowUp className="h-4 w-4" /></Button>
      </form>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button type="button" disabled={busy || hydratedAccount !== session?.authUserId} onClick={() => void clearTranscript()} className="text-xs text-red-600 underline disabled:opacity-40">مسح سجل المحادثة</button>
        <button type="button" onClick={() => activeAccountId && void refreshQueue(activeAccountId, accountScopeRef.current.generation)} className="text-xs text-gray-500 underline">تحديث حالة الرسائل المحفوظة</button>
      </div>
      <p className="text-center text-[11px] text-gray-500">سارة تعمل وفق صلاحيات حسابك الحالية؛ وتتحقق قاعدة البيانات من كل عملية قبل تنفيذها.</p>
    </section>
  );
};
