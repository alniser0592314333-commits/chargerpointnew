import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Sparkles, AlertCircle } from "lucide-react";
import { sarahChatService } from "../../services/ai/sarahChatService";
import { UserSession } from "../../services/auth/authService";
import { Button } from "../ui/Button";
import { sarahInputQueue, SarahInputRecord } from "../../application/ai/sarahInputQueue";
import { sarahConversationStore } from "../../application/ai/sarahConversationStore";
import { SarahAccountOperationScope } from "../../application/ai/sarahAccountOperationScope";

type Message = { role: "user" | "assistant"; text: string };
const accountScopeIdentity = (accountId?: string | null, authUserId?: string) =>
  accountId ? `${accountId}:${authUserId || "unverified"}` : null;

export const SarahChatPage: React.FC<{ session: UserSession | null; onBack?: () => void }> = ({ session }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<SarahInputRecord[]>([]);
  const [hydratedAccount, setHydratedAccount] = useState<string | null>(null);
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
    const accountId = session?.userId;
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
    const accountId = session?.userId;
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
    const accountId = session?.userId;
    if (!accountId || hydratedAccount !== accountId || !isCurrent(accountId)) return;
    // Save only the transcript explicitly hydrated for this identity.
    void sarahConversationStore.save(accountId, messages, conversationGenerationRef.current).catch((err) => {
      if (isCurrent(accountId)) setError(err instanceof Error ? err.message : "CONVERSATION_SAVE_FAILED");
    });
  }, [messages, session?.userId, session?.authUserId, hydratedAccount]);

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
    const accountId = session?.userId;
    if (!accountId) return;
    const operation = accountScopeRef.current.generation;
    void refreshQueue(accountId, operation);
  }, [session?.userId, session?.authUserId]);

  const canUse = Boolean(session && (session.role === "SUPER_ADMIN" || session.permissions.includes("ai:use")));

  const send = async () => {
    const accountId = session?.userId;
    const clean = text.trim();
    if (!clean || busy || !canUse || !accountId || !isCurrent(accountId) || hydratedAccount !== accountId) return;
    const operation = accountScopeRef.current.generation;
    const historySnapshot = messages.slice(-20);
    setText("");
    setError("");
    setMessages((prev) => isCurrent(accountId, operation) ? [...prev, { role: "user", text: clean }] : prev);
    setBusy(true);
    const id = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    try {
      await sarahInputQueue.enqueue({
        id, actorAccountId: accountId, deviceId: "web-client", kind: "text",
        state: navigator.onLine ? "READY_TO_SEND" : "QUEUED_OFFLINE", text: clean, correlationId,
      });
      await refreshQueue(accountId, operation);
      if (!isCurrent(accountId, operation)) return;
      if (!navigator.onLine) {
        setMessages((prev) => isCurrent(accountId, operation) ? [...prev, { role: "assistant", text: "حفظت رسالتك محليًا في الطابور؛ لم تُرسل بعد لأن الإنترنت غير متصل." }] : prev);
        return;
      }
      await sarahInputQueue.transition(accountId, id, "UPLOADING");
      if (!isCurrent(accountId, operation)) return;
      try {
        const response = await sarahChatService.send(clean, session?.authUserId || '', historySnapshot);
        if (!isCurrent(accountId, operation)) return;
        await sarahInputQueue.transition(accountId, id, "SENT_TO_AI", { resultRef: correlationId });
        await sarahInputQueue.transition(accountId, id, "COMPLETED");
        if (isCurrent(accountId, operation)) setMessages((prev) => [...prev, { role: "assistant", text: response.answer }]);
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
    const accountId = session?.userId;
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
    const accountId = session?.userId;
    if (!accountId || busy || !navigator.onLine || !isCurrent(accountId) || record.actorAccountId !== accountId || !record.text || hydratedAccount !== accountId) return;
    const operation = accountScopeRef.current.generation;
    setBusy(true); setError("");
    try {
      if (record.state === "NEEDS_ATTENTION" || record.state === "QUEUED_OFFLINE") await sarahInputQueue.transition(accountId, record.id, "READY_TO_SEND");
      await sarahInputQueue.transition(accountId, record.id, "UPLOADING");
      if (!isCurrent(accountId, operation)) return;
      const retryHistory = messages.slice(-20);
      if (retryHistory.at(-1)?.role === "user" && retryHistory.at(-1)?.text === record.text) retryHistory.pop();
      const response = await sarahChatService.send(record.text, session?.authUserId || '', retryHistory);
      if (!isCurrent(accountId, operation)) return;
      await sarahInputQueue.transition(accountId, record.id, "SENT_TO_AI", { resultRef: record.correlationId });
      await sarahInputQueue.transition(accountId, record.id, "COMPLETED");
      if (isCurrent(accountId, operation)) setMessages((prev) => [...prev, { role: "assistant", text: response.answer }]);
    } catch (err) {
      if (isCurrent(accountId, operation)) {
        try { await sarahInputQueue.transition(accountId, record.id, "NEEDS_ATTENTION", { lastErrorCode: err instanceof Error ? err.message.slice(0, 80) : "AI_REQUEST_FAILED" }); } catch {}
        setError(err instanceof Error ? err.message : "AI_REQUEST_FAILED");
      }
    } finally {
      if (isCurrent(accountId, operation)) { setBusy(false); await refreshQueue(accountId, operation); }
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
      {pending.filter((item) => item.state !== "COMPLETED").length > 0 && <div className="rounded-xl border border-amber-300/60 bg-amber-50 p-3 text-sm dark:bg-amber-950/20"><div className="mb-2 font-semibold">رسائل محفوظة / تحتاج متابعة</div>{pending.filter((item) => item.state !== "COMPLETED").map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-amber-200 py-2"><span className="min-w-0 flex-1 truncate">{item.text || "رسالة صوتية محفوظة"} <span className="text-xs text-gray-500">({item.state})</span></span>{(item.state === "QUEUED_OFFLINE" || item.state === "NEEDS_ATTENTION") && <button type="button" disabled={busy || !navigator.onLine} onClick={() => void retryQueued(item)} className="rounded-lg bg-amber-700 px-3 py-1 text-white disabled:opacity-40">إعادة إرسال</button>}</div>)}</div>}
      <form onSubmit={(event) => { event.preventDefault(); void send(); }} className="flex items-end gap-2 rounded-2xl border border-gray-200 bg-white p-2 dark:border-[#123832] dark:bg-[#061f1c]">
        <textarea rows={2} maxLength={20000} value={text} onChange={(event) => setText(event.target.value)} placeholder="اكتب لسارة..." className="max-h-40 min-h-[48px] flex-1 resize-y bg-transparent p-2 text-sm outline-none" disabled={busy || hydratedAccount !== session?.userId} />
        <Button type="submit" disabled={busy || !text.trim() || hydratedAccount !== session?.userId} className="h-11 min-w-11"><ArrowUp className="h-4 w-4" /></Button>
      </form>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button type="button" disabled={busy || hydratedAccount !== session?.userId} onClick={() => void clearTranscript()} className="text-xs text-red-600 underline disabled:opacity-40">مسح سجل المحادثة</button>
        <button type="button" onClick={() => session?.userId && void refreshQueue(session.userId, accountScopeRef.current.generation)} className="text-xs text-gray-500 underline">تحديث حالة الرسائل المحفوظة</button>
      </div>
      <p className="text-center text-[11px] text-gray-500">النسخة الحالية محادثة نصية فقط؛ تنفيذ أدوات التطبيق والصوت لم يُفعّل بعد.</p>
    </section>
  );
};
