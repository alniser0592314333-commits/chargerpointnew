import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  ArrowDown, ArrowUp, Bell, Camera, ImagePlus, LoaderCircle, Pencil, Plus, Save, Send, Trash2, Type, X,
} from "lucide-react";
import { useI18n } from "../../i18n/i18nContext";
import { config } from "../../config/env";
import { getFreshSupabaseAuthToken } from "../../services/supabase/client";

type TextBlock = { type: "text"; text_ar: string; text_en: string };
type ImageBlock = { type: "image"; path: string; url?: string | null; alt_ar?: string; alt_en?: string; localPreview?: string };
type EventBlock = TextBlock | ImageBlock;
type PortalEvent = {
  id: string;
  title_ar: string | null;
  title_en: string | null;
  content_blocks: EventBlock[];
  sort_order: number;
  is_published: boolean;
  published_at: string | null;
  notifications_sent_at: string | null;
  web_push_sent_at: string | null;
  created_at: string;
};

const storageClient = createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const CustomerPortalEventsAdminPage: React.FC = () => {
  const { locale } = useI18n();
  const isAr = locale === "ar";
  const [events, setEvents] = useState<PortalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [titleAr, setTitleAr] = useState("");
  const [titleEn, setTitleEn] = useState("");
  const [blocks, setBlocks] = useState<EventBlock[]>([]);
  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const callApi = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    const { token, reason } = await getFreshSupabaseAuthToken();
    if (!token) throw new Error(reason || "AUTH_REQUIRED");
    const response = await fetch(config.supabaseUrl.replace(/\/+$/, "") + "/functions/v1/customer-portal-events", {
      method: "POST",
      cache: "no-store",
      headers: { apikey: config.supabaseAnonKey, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok !== true) throw new Error(typeof result?.error === "string" ? result.error : "EVENT_REQUEST_FAILED");
    return result;
  }, []);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await callApi("admin-list");
      setEvents(Array.isArray(result.events) ? result.events : []);
    } catch {
      setError(isAr ? "تعذّر تحميل الأحداث. تأكد من صلاحيتك واتصالك." : "Could not load events. Check your permissions and connection.");
    } finally {
      setLoading(false);
    }
  }, [callApi, isAr]);

  useEffect(() => { void loadEvents(); }, [loadEvents]);

  const resetEditor = () => {
    setEditingId(null);
    setTitleAr("");
    setTitleEn("");
    setBlocks([]);
    setMessage("");
    setError("");
  };

  const startEdit = (event: PortalEvent) => {
    setEditingId(event.id);
    setTitleAr(event.title_ar || "");
    setTitleEn(event.title_en || "");
    setBlocks(event.content_blocks.map((block) => ({ ...block })));
    setMessage("");
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const uploadImage = async (file?: File) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) {
      setError(isAr ? "الصورة لازم تكون JPG أو PNG أو WEBP وحجمها أقل من 8MB." : "Image must be JPG, PNG or WEBP and under 8 MB.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const signed = await callApi("upload-url", { fileName: file.name, contentType: file.type, size: file.size });
      const { error: uploadError } = await storageClient.storage.from("customer-portal-events")
        .uploadToSignedUrl(String(signed.path), String(signed.token), file, { contentType: file.type, upsert: false });
      if (uploadError) throw uploadError;
      setBlocks((current) => [...current, {
        type: "image", path: String(signed.path), localPreview: URL.createObjectURL(file),
        alt_ar: "", alt_en: "",
      }]);
      setMessage(isAr ? "تم رفع الصورة. احفظ الحدث لتثبيتها." : "Image uploaded. Save the event to keep it.");
    } catch {
      setError(isAr ? "فشل رفع الصورة. حاول مرة ثانية." : "Image upload failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const updateText = (index: number, field: "text_ar" | "text_en", value: string) => {
    setBlocks((current) => current.map((block, i) => i === index && block.type === "text" ? { ...block, [field]: value } : block));
  };

  const moveBlock = (index: number, direction: -1 | 1) => {
    setBlocks((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const saveEvent = async (publish: boolean) => {
    if (busy) return;
    if (!blocks.length) {
      setError(isAr ? "أضف نص أو صورة واحدة على الأقل." : "Add at least one text or image block.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await callApi("save", {
        ...(editingId ? { id: editingId } : {}),
        title_ar: titleAr,
        title_en: titleEn,
        content_blocks: blocks.map((block) => block.type === "text"
          ? { type: "text", text_ar: block.text_ar, text_en: block.text_en }
          : { type: "image", path: block.path, alt_ar: block.alt_ar || "", alt_en: block.alt_en || "" }),
        is_published: publish,
      });
      resetEditor();
      await loadEvents();
      setMessage(publish
        ? (isAr ? "تم حفظ الحدث ونشره. الإشعار يُرسل مرة واحدة عند أول نشر فقط." : "Event saved and published. Notifications are sent only on first publication.")
        : (isAr ? "تم حفظ الحدث كمسودة." : "Event saved as a draft."));
      if (result.web_push?.unavailable || Number(result.web_push?.failed || 0) > 0) {
        setMessage(isAr ? "تم نشر الحدث، لكن بعض إشعارات المتصفح لم تصل. استخدم زر إعادة إشعار الويب بجانب الحدث للمحاولة مجددًا." : "Event published, but some browser notifications failed. Use Retry web push beside the event to try again.");
      }
    } catch (saveError) {
      const reason = saveError instanceof Error ? saveError.message : "";
      setError(reason === "EVENT_SAVED_NOTIFICATION_PENDING"
        ? (isAr ? "تم حفظ الحدث، لكن تعذّر إكمال إشعارات النشر. راجع الحدث وحاول مجددًا." : "Event saved, but notification fanout is pending. Review the event and retry.")
        : (isAr ? "تعذّر حفظ الحدث. تأكد من البيانات والاتصال." : "Could not save the event. Check the content and connection."));
    } finally {
      setBusy(false);
    }
  };

  const retryWebPush = async (event: PortalEvent) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await callApi("retry-web-push", { id: event.id });
      setMessage(isAr
        ? `تمت محاولة إرسال إشعارات المتصفح. عدد الأجهزة التي استلمت الإرسال: ${Number(result.web_push?.sent || 0)}.`
        : `Browser push dispatch attempted. Devices accepted: ${Number(result.web_push?.sent || 0)}.`);
      await loadEvents();
    } catch {
      setError(isAr ? "تعذّرت إعادة محاولة إشعارات المتصفح." : "Could not retry browser push notifications.");
    } finally {
      setBusy(false);
    }
  };

  const archiveEvent = async (event: PortalEvent) => {
    if (busy || !window.confirm(isAr ? "إزالة هذا الحدث من صفحة العملاء؟ سيُؤرشف ولن يظهر لهم." : "Remove this event from the customer page? It will be archived and hidden.")) return;
    setBusy(true);
    setError("");
    try {
      await callApi("archive", { id: event.id });
      if (editingId === event.id) resetEditor();
      setMessage(isAr ? "تمت إزالة الحدث من صفحة العملاء." : "Event removed from the customer page.");
      await loadEvents();
    } catch {
      setError(isAr ? "تعذّرت إزالة الحدث." : "Could not remove the event.");
    } finally {
      setBusy(false);
    }
  };

  const reorder = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (busy || target < 0 || target >= events.length) return;
    const next = [...events];
    [next[index], next[target]] = [next[target], next[index]];
    setEvents(next);
    setBusy(true);
    try {
      await callApi("reorder", { ids: next.map((event) => event.id) });
      setMessage(isAr ? "تم تحديث ترتيب الأحداث." : "Event order updated.");
    } catch {
      setError(isAr ? "تغيّر ترتيب الأحداث على الخادم. أعد تحميل القائمة." : "The event order changed on the server. Reload the list.");
      await loadEvents();
    } finally {
      setBusy(false);
    }
  };

  const previewBlocks = useMemo(() => blocks.map((block, index) => ({ block, index })), [blocks]);

  return (
    <div dir={isAr ? "rtl" : "ltr"} className="mx-auto w-full max-w-6xl space-y-6 p-3 sm:p-6 text-slate-900 dark:text-slate-100">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold tracking-wider text-sky-600 dark:text-sky-300">{isAr ? "بوابة العملاء" : "CUSTOMER PORTAL"}</p>
          <h1 className="mt-1 text-2xl font-extrabold">{isAr ? "إدارة الأحداث" : "Events management"}</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{isAr ? "أنشئ إعلانًا من نص أو صورة أو الاثنين، وشاهد شكله قبل النشر." : "Create announcements with text, images, or both, and preview before publishing."}</p>
        </div>
        <button type="button" onClick={() => { resetEditor(); window.scrollTo({ top: 0, behavior: "smooth" }); }} className="inline-flex items-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-sky-700">
          <Plus size={17}/>{isAr ? "حدث جديد" : "New event"}
        </button>
      </header>

      {error && <p role="alert" className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200">{error}</p>}
      {message && <p role="status" className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-200">{message}</p>}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(300px,.8fr)]">
        <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-[#08251f]">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-bold">{editingId ? (isAr ? "تعديل الحدث" : "Edit event") : (isAr ? "إنشاء حدث" : "Create event")}</h2>
            {editingId && <button type="button" onClick={resetEditor} className="text-sm text-slate-500 hover:text-slate-900 dark:hover:text-white"><X size={17}/></button>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm"><span className="mb-1 block font-semibold">{isAr ? "عنوان الإشعار (عربي)" : "Notification title (Arabic)"}</span><input value={titleAr} onChange={(e) => setTitleAr(e.target.value)} maxLength={180} placeholder={isAr ? "مثلاً: إعلان جديد" : "Optional Arabic title"} className="w-full rounded-xl border border-slate-300 bg-transparent px-3 py-2.5 outline-none focus:border-sky-500 dark:border-white/15"/></label>
            <label className="block text-sm"><span className="mb-1 block font-semibold">{isAr ? "عنوان الإشعار (إنجليزي)" : "Notification title (English)"}</span><input value={titleEn} onChange={(e) => setTitleEn(e.target.value)} maxLength={180} placeholder="Optional English title" className="w-full rounded-xl border border-slate-300 bg-transparent px-3 py-2.5 outline-none focus:border-sky-500 dark:border-white/15"/></label>
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setBlocks((current) => [...current, { type: "text", text_ar: "", text_en: "" }])} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold dark:border-white/15"><Type size={16}/>{isAr ? "إضافة نص" : "Add text"}</button>
            <button type="button" onClick={() => galleryRef.current?.click()} disabled={busy} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold dark:border-white/15"><ImagePlus size={16}/>{isAr ? "رفع صورة" : "Upload image"}</button>
            <button type="button" onClick={() => cameraRef.current?.click()} disabled={busy} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold dark:border-white/15"><Camera size={16}/>{isAr ? "تصوير" : "Take photo"}</button>
            <input ref={galleryRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { void uploadImage(e.target.files?.[0]); e.currentTarget.value = ""; }}/>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { void uploadImage(e.target.files?.[0]); e.currentTarget.value = ""; }}/>
          </div>

          <div className="space-y-3">
            {blocks.map((block, index) => (
              <div key={index} className="rounded-xl border border-slate-200 p-3 dark:border-white/10">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-500">{block.type === "text" ? (isAr ? "محتوى نصي" : "Text block") : (isAr ? "صورة" : "Image block")} · {index + 1}</span>
                  <div className="flex items-center gap-1">
                    <button type="button" disabled={index === 0} onClick={() => moveBlock(index, -1)} className="rounded-lg p-1.5 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-white/10" aria-label={isAr ? "تحريك لأعلى" : "Move up"}><ArrowUp size={16}/></button>
                    <button type="button" disabled={index === blocks.length - 1} onClick={() => moveBlock(index, 1)} className="rounded-lg p-1.5 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-white/10" aria-label={isAr ? "تحريك لأسفل" : "Move down"}><ArrowDown size={16}/></button>
                    <button type="button" onClick={() => setBlocks((current) => current.filter((_, i) => i !== index))} className="rounded-lg p-1.5 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30" aria-label={isAr ? "إزالة المحتوى" : "Remove block"}><Trash2 size={16}/></button>
                  </div>
                </div>
                {block.type === "text" ? <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-sm"><span className="mb-1 block font-semibold">النص بالعربي</span><textarea rows={4} value={block.text_ar} onChange={(e) => updateText(index, "text_ar", e.target.value)} className="w-full resize-y rounded-xl border border-slate-300 bg-transparent p-3 outline-none focus:border-sky-500 dark:border-white/15" placeholder="اكتب النص الذي سيظهر للعميل..."/></label>
                  <label className="block text-sm"><span className="mb-1 block font-semibold">Text in English</span><textarea rows={4} value={block.text_en} onChange={(e) => updateText(index, "text_en", e.target.value)} className="w-full resize-y rounded-xl border border-slate-300 bg-transparent p-3 outline-none focus:border-sky-500 dark:border-white/15" placeholder="Optional English text..."/></label>
                </div> : <div className="space-y-2">
                  <img src={block.localPreview || block.url || ""} alt="" className="max-h-64 w-full rounded-xl bg-slate-100 object-contain dark:bg-white/5"/>
                  <p className="break-all text-xs text-slate-500">{block.path}</p>
                </div>}
              </div>
            ))}
            {!blocks.length && <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-white/15">{isAr ? "ابدأ بإضافة نص أو صورة. تقدر تجمع أكثر من عنصر وبأي ترتيب." : "Add text or an image. You can combine multiple blocks in any order."}</div>}
          </div>
          <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4 dark:border-white/10">
            <button type="button" disabled={busy || !blocks.length} onClick={() => void saveEvent(false)} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-bold disabled:opacity-50 dark:border-white/15"><Save size={16}/>{isAr ? "حفظ كمسودة" : "Save draft"}</button>
            <button type="button" disabled={busy || !blocks.length} onClick={() => void saveEvent(true)} className="inline-flex items-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-sky-700 disabled:opacity-50">{busy ? <LoaderCircle size={16} className="animate-spin"/> : <Send size={16} />}{isAr ? "حفظ ونشر" : "Save & publish"}</button>
          </div>
        </section>

        <section className="space-y-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-[#08251f]">
            <div className="mb-3 flex items-center gap-2"><Bell size={17}/><h2 className="font-bold">{isAr ? "معاينة شكل العميل" : "Customer preview"}</h2></div>
            <article className="overflow-hidden rounded-2xl border border-slate-200 dark:border-white/10">
              {(titleAr || titleEn) && <h3 className="px-4 pt-4 font-bold">{isAr ? (titleAr || titleEn) : (titleEn || titleAr)}</h3>}
              <div className="space-y-3 p-4">
                {previewBlocks.map(({ block, index }) => block.type === "image"
                  ? <img key={index} src={block.localPreview || block.url || ""} alt="" className="max-h-72 w-full rounded-xl bg-slate-100 object-contain dark:bg-white/5"/>
                  : <p key={index} className="whitespace-pre-wrap leading-7">{isAr ? (block.text_ar || block.text_en) : (block.text_en || block.text_ar)}</p>)}
                {!blocks.length && <p className="text-sm text-slate-400">{isAr ? "المعاينة رح تظهر هون أثناء الكتابة." : "Your preview will appear here as you edit."}</p>}
              </div>
            </article>
          </div>
        </section>
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between"><h2 className="text-lg font-extrabold">{isAr ? "الأحداث الحالية" : "Current events"}</h2><span className="text-xs text-slate-500">{events.length} {isAr ? "حدث" : "events"}</span></div>
        {loading ? <div className="flex items-center gap-2 p-5 text-sm text-slate-500"><LoaderCircle className="animate-spin" size={18}/>{isAr ? "جارٍ التحميل..." : "Loading..."}</div>
          : events.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-white/15">{isAr ? "لسه ما أضفت أحداث." : "No events have been added yet."}</div>
          : <div className="space-y-2">
            {events.map((event, index) => (
              <div key={event.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-[#08251f]">
                <div className="flex flex-col gap-1">
                  <button type="button" disabled={busy || index === 0} onClick={() => void reorder(index, -1)} className="rounded-lg p-1 hover:bg-slate-100 disabled:opacity-25 dark:hover:bg-white/10" aria-label={isAr ? "تقديم الحدث" : "Move event up"}><ArrowUp size={16}/></button>
                  <button type="button" disabled={busy || index === events.length - 1} onClick={() => void reorder(index, 1)} className="rounded-lg p-1 hover:bg-slate-100 disabled:opacity-25 dark:hover:bg-white/10" aria-label={isAr ? "تأخير الحدث" : "Move event down"}><ArrowDown size={16}/></button>
                </div>
                {event.content_blocks.find((block) => block.type === "image" && block.url) && <img src={(event.content_blocks.find((block) => block.type === "image") as ImageBlock).url || ""} alt="" className="h-16 w-20 rounded-xl bg-slate-100 object-cover dark:bg-white/5"/>}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold">{event.title_ar || event.title_en || (isAr ? "حدث بدون عنوان" : "Untitled event")}</p>
                  <p className="mt-1 text-xs text-slate-500">{event.is_published ? (isAr ? "منشور" : "Published") : (isAr ? "مسودة" : "Draft")} · {event.content_blocks.length} {isAr ? "عنصر" : "blocks"}</p>
                  {event.notifications_sent_at && <p className="mt-1 text-[11px] text-emerald-700 dark:text-emerald-300">{isAr ? "تم إرسال إشعار أول نشر" : "First-publish notification sent"}</p>}
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" disabled={busy} onClick={() => startEdit(event)} className="inline-flex items-center gap-1 rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold dark:border-white/15"><Pencil size={14}/>{isAr ? "تعديل" : "Edit"}</button>
                  {event.is_published && !event.web_push_sent_at && <button type="button" disabled={busy} onClick={() => void retryWebPush(event)} className="rounded-xl border border-amber-400 px-3 py-2 text-xs font-bold text-amber-700 dark:text-amber-300">{isAr ? "إعادة إشعار الويب" : "Retry web push"}</button>}
                  <button type="button" disabled={busy} onClick={() => void archiveEvent(event)} className="rounded-xl p-2 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30" aria-label={isAr ? "إزالة الحدث" : "Remove event"}><Trash2 size={16}/></button>
                </div>
              </div>
            ))}
          </div>}
      </section>
    </div>
  );
};
