
import React, { useEffect, useRef, useState } from "react";
import { CalendarClock, ImagePlus, Megaphone, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import { PublicAnnouncement, managePublicAnnouncement } from "../../services/publicAnnouncements";

const localDateTime = (value: string) => {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const errorText = (e: unknown) => e instanceof Error ? e.message : "حدث خطأ غير متوقع";

export const PublicAnnouncementsSettings: React.FC<{ locale: string }> = ({ locale }) => {
  const ar = locale === "ar";
  const [items, setItems] = useState<PublicAnnouncement[]>([]);
  const [editing, setEditing] = useState<PublicAnnouncement | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [imageData, setImageData] = useState("");
  const [imageName, setImageName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const auth = await import("../../services/supabase/client");
    const token = await auth.getFreshSupabaseAuthToken();
    const { config } = await import("../../config/env");
    const url = `${config.supabaseUrl.replace(/\/+$/, "")}/functions/v1/public-announcements?admin=1`;
    const response = await fetch(url, { headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${token.token || ""}` }, cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "ANNOUNCEMENTS_READ_FAILED");
    setItems(Array.isArray(result.announcements) ? result.announcements : []);
  };

  useEffect(() => { void load().catch(e => setError(errorText(e))); }, []);

  const reset = () => {
    setEditing(null); setTitle(""); setBody(""); setStartsAt(""); setEndsAt("");
    setEnabled(true); setImageData(""); setImageName(""); setError("");
    if (fileRef.current) fileRef.current.value = "";
  };
  const beginEdit = (item: PublicAnnouncement) => {
    setEditing(item); setTitle(item.title || ""); setBody(item.body || "");
    setStartsAt(localDateTime(item.starts_at)); setEndsAt(localDateTime(item.ends_at));
    setEnabled(item.is_enabled !== false); setImageData(""); setImageName(""); setError("");
  };
  const pickImage = (file?: File) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { setError(ar ? "اختر صورة JPG أو PNG أو WebP." : "Choose a JPG, PNG or WebP image."); return; }
    if (file.size > 5 * 1024 * 1024) { setError(ar ? "حجم الصورة يجب ألا يتجاوز 5 ميجابايت." : "Image must be 5 MB or smaller."); return; }
    const reader = new FileReader();
    reader.onload = () => { setImageData(String(reader.result || "")); setImageName(file.name); setError(""); };
    reader.onerror = () => setError(ar ? "تعذرت قراءة الصورة." : "Could not read image.");
    reader.readAsDataURL(file);
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError("");
    try {
      if (!startsAt || !endsAt || new Date(endsAt) <= new Date(startsAt)) throw new Error(ar ? "تاريخ النهاية يجب أن يكون بعد تاريخ البداية." : "End date must be after start date.");
      await managePublicAnnouncement({ action: "save", ...(editing ? { id: editing.id } : {}), title, body, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(), enabled, imageBase64: imageData || undefined, existingImageUrl: editing?.image_url || undefined });
      await load(); reset();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    if (!window.confirm(ar ? "هل تريد حذف هذا الإعلان نهائياً؟" : "Delete this announcement permanently?")) return;
    setBusy(true); setError("");
    try { await managePublicAnnouncement({ action: "delete", id }); await load(); if (editing?.id === id) reset(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const status = (item: PublicAnnouncement) => {
    const now = Date.now();
    if (item.is_enabled === false) return ar ? "متوقف" : "Disabled";
    if (now < new Date(item.starts_at).getTime()) return ar ? "مجدول" : "Scheduled";
    if (now < new Date(item.ends_at).getTime()) return ar ? "منشور" : "Published";
    return ar ? "منتهي" : "Expired";
  };

  return <section className="space-y-4 pb-6 border-b border-gray-200/80 dark:border-[#123832]">
    <div className="flex items-center justify-between gap-3">
      <div><div className="text-sm font-bold text-gray-900 dark:text-[#daf1de] flex items-center gap-2"><Megaphone className="w-4 h-4 text-emerald-600" />{ar ? "إدارة الإعلانات" : "Announcement management"}</div><p className="text-xs text-gray-500 dark:text-[#8eb698] mt-1">{ar ? "جدولة عدة إعلانات لتظهر تلقائياً في الصفحة العامة." : "Schedule multiple announcements to appear automatically on the public page."}</p></div>
      <button type="button" onClick={() => { reset(); setStartsAt(localDateTime(new Date().toISOString())); const end = new Date(Date.now()+86400000); setEndsAt(localDateTime(end.toISOString())); }} className="shrink-0 inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white"><Plus className="w-4 h-4"/>{ar ? "إعلان جديد" : "New ad"}</button>
    </div>
    {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/30 dark:border-red-900 dark:text-red-300">{error}</div>}
    {editing !== null || startsAt ? <form onSubmit={save} className="space-y-3 rounded-2xl border border-gray-200 dark:border-[#123832] p-3">
      <div className="flex justify-between items-center"><strong className="text-sm">{editing ? (ar ? "تعديل الإعلان" : "Edit announcement") : (ar ? "إضافة إعلان" : "Create announcement")}</strong><button type="button" onClick={reset} aria-label="Close"><X className="w-4 h-4"/></button></div>
      <input value={title} onChange={e=>setTitle(e.target.value)} maxLength={160} placeholder={ar ? "عنوان الإعلان (اختياري)" : "Announcement title (optional)"} className="w-full rounded-xl border border-gray-200 dark:border-[#24443e] bg-transparent px-3 py-2 text-sm"/>
      <textarea value={body} onChange={e=>setBody(e.target.value)} maxLength={3000} rows={4} placeholder={ar ? "اكتب محتوى الإعلان..." : "Write the announcement..."} className="w-full rounded-xl border border-gray-200 dark:border-[#24443e] bg-transparent px-3 py-2 text-sm"/>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-xs space-y-1"><span>{ar ? "تاريخ ووقت البداية" : "Start date & time"}</span><input required type="datetime-local" value={startsAt} onChange={e=>setStartsAt(e.target.value)} className="w-full rounded-xl border border-gray-200 dark:border-[#24443e] bg-transparent px-2 py-2"/></label>
        <label className="text-xs space-y-1"><span>{ar ? "تاريخ ووقت النهاية" : "End date & time"}</span><input required type="datetime-local" value={endsAt} onChange={e=>setEndsAt(e.target.value)} className="w-full rounded-xl border border-gray-200 dark:border-[#24443e] bg-transparent px-2 py-2"/></label>
      </div>
      <div className="flex items-center gap-2 text-xs"><input id="announcement-enabled" type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/><label htmlFor="announcement-enabled">{ar ? "تفعيل الإعلان ضمن موعده" : "Enable within schedule"}</label></div>
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={e=>pickImage(e.target.files?.[0])}/>
      <button type="button" onClick={()=>fileRef.current?.click()} className="w-full rounded-xl border border-dashed border-emerald-400 p-3 text-xs flex items-center justify-center gap-2"><ImagePlus className="w-4 h-4"/>{imageName || (ar ? "إضافة صورة للإعلان (اختياري، حتى 5MB)" : "Add an image (optional, up to 5MB)")}</button>
      {(imageData || editing?.image_url) && <img src={imageData || editing?.image_url || ""} alt="" className="max-h-48 w-full rounded-xl object-contain bg-gray-50 dark:bg-[#041714]"/>}
      <button disabled={busy} type="submit" className="w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-bold text-white disabled:opacity-50">{busy ? (ar ? "جارٍ الحفظ..." : "Saving...") : (ar ? "حفظ الإعلان" : "Save announcement")}</button>
    </form> : null}
    <div className="space-y-2">
      {items.length === 0 ? <p className="text-xs text-gray-500 py-4 text-center">{ar ? "لا توجد إعلانات بعد." : "No announcements yet."}</p> : items.map(item=><div key={item.id} className="flex gap-3 items-center border-b border-gray-100 dark:border-[#123832] py-3">
        {item.image_url ? <img src={item.image_url} alt="" className="w-16 h-16 rounded-xl object-cover"/> : <div className="w-16 h-16 rounded-xl bg-gray-100 dark:bg-[#0c312b] flex items-center justify-center"><Megaphone className="w-5 h-5"/></div>}
        <div className="min-w-0 flex-1"><div className="text-sm font-semibold truncate">{item.title || (ar ? "إعلان بدون عنوان" : "Untitled announcement")}</div><div className="text-[11px] text-gray-500 mt-1">{status(item)} · {new Date(item.starts_at).toLocaleString(ar ? "ar" : "en")} – {new Date(item.ends_at).toLocaleString(ar ? "ar" : "en")}</div></div>
        <button type="button" onClick={()=>beginEdit(item)} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-[#123832]" aria-label="Edit"><Pencil className="w-4 h-4"/></button>
        <button type="button" onClick={()=>void remove(item.id)} disabled={busy} className="p-2 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30" aria-label="Delete"><Trash2 className="w-4 h-4"/></button>
      </div>)}
    </div>
    <div className="text-[11px] text-gray-500 flex gap-2 items-start"><CalendarClock className="w-4 h-4 shrink-0"/>{ar ? "الإعلانات المجدولة لا تظهر قبل تاريخ البداية، وتختفي تلقائياً بعد تاريخ النهاية." : "Scheduled ads stay hidden until their start time and disappear automatically after the end time."}</div>
  </section>;
};
