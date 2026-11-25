import React, { useState } from "react";
import { ArrowUp, Sparkles, AlertCircle } from "lucide-react";
import { sarahChatService } from "../../services/ai/sarahChatService";
import { UserSession } from "../../services/auth/authService";
import { Button } from "../ui/Button";
import { sarahInputQueue } from "../../application/ai/sarahInputQueue";

type Message = { role: "user" | "assistant"; text: string };

export const SarahChatPage: React.FC<{ session: UserSession | null; onBack?: () => void }> = ({ session }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canUse = Boolean(session && (session.role === "SUPER_ADMIN" || session.permissions.includes("ai:use")));

  const send = async () => {
    const clean = text.trim();
    if (!clean || busy || !canUse || !session) return;
    setText("");
    setError("");
    setMessages((prev) => [...prev, { role: "user", text: clean }]);
    setBusy(true);
    const id = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    try {
      await sarahInputQueue.enqueue({
        id, actorAccountId: session.userId, deviceId: "web-client", kind: "text",
        state: navigator.onLine ? "READY_TO_SEND" : "QUEUED_OFFLINE", text: clean, correlationId,
      });
      if (!navigator.onLine) {
        setMessages((prev) => [...prev, { role: "assistant", text: "حفظت رسالتك محليًا في الطابور؛ لم تُرسل بعد لأن الإنترنت غير متصل." }]);
        return;
      }
      await sarahInputQueue.transition(session.userId, id, "UPLOADING");
      try {
        const response = await sarahChatService.send(clean, messages);
        await sarahInputQueue.transition(session.userId, id, "SENT_TO_AI", { resultRef: correlationId });
        await sarahInputQueue.transition(session.userId, id, "COMPLETED");
        setMessages((prev) => [...prev, { role: "assistant", text: response.answer }]);
      } catch (err) {
        await sarahInputQueue.transition(session.userId, id, "NEEDS_ATTENTION", {
          lastErrorCode: err instanceof Error ? err.message.slice(0, 80) : "AI_REQUEST_FAILED",
        });
        throw err;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI_REQUEST_FAILED");
    } finally {
      setBusy(false);
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
      <form onSubmit={(event) => { event.preventDefault(); void send(); }} className="flex items-end gap-2 rounded-2xl border border-gray-200 bg-white p-2 dark:border-[#123832] dark:bg-[#061f1c]">
        <textarea rows={2} maxLength={20000} value={text} onChange={(event) => setText(event.target.value)} placeholder="اكتب لسارة..." className="max-h-40 min-h-[48px] flex-1 resize-y bg-transparent p-2 text-sm outline-none" disabled={busy} />
        <Button type="submit" disabled={busy || !text.trim()} className="h-11 min-w-11"><ArrowUp className="h-4 w-4" /></Button>
      </form>
      <p className="text-center text-[11px] text-gray-500">النسخة الحالية محادثة نصية فقط؛ تنفيذ أدوات التطبيق والصوت لم يُفعّل بعد.</p>
    </section>
  );
};
