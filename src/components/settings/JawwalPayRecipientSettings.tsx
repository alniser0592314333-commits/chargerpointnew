import React, { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Phone, Save, ShieldCheck } from "lucide-react";
import { rpcGetJawwalPayRecipient, rpcSetJawwalPayRecipient } from "../../services/supabase/client";

type Props = { locale: string };

export const JawwalPayRecipientSettings: React.FC<Props> = ({ locale }) => {
  const isAr = locale === "ar";
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    let active = true;
    rpcGetJawwalPayRecipient().then(({ data, error: fetchError }) => {
      if (!active) return;
      if (fetchError || !data?.recipient_phone) {
        setError(isAr ? "تعذّر تحميل رقم التحويل من الخادم." : "Could not load the recipient number from the server.");
      } else {
        setPhone(data.recipient_phone);
      }
    }).catch(() => {
      if (active) setError(isAr ? "تعذّر الاتصال بإعدادات جوال باي." : "Could not load Jawwal Pay settings.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [isAr]);

  const save = async () => {
    setError("");
    setSuccess("");
    const clean = phone.replace(/[\\s()-]/g, "");
    if (!/^05\\d{8}$/.test(clean)) {
      setError(isAr ? "أدخل رقم جوال فلسطيني صحيحًا بصيغة 05xxxxxxxx." : "Enter a valid Palestinian mobile number in 05xxxxxxxx format.");
      return;
    }
    if (!navigator.onLine) {
      setError(isAr ? "يلزم الاتصال بالإنترنت لحفظ الرقم ومزامنته مع العملاء." : "Internet is required to save and sync the number to customers.");
      return;
    }
    setSaving(true);
    try {
      const result = await rpcSetJawwalPayRecipient(clean);
      if (!result.success) throw new Error(result.error || "SAVE_FAILED");
      setPhone(clean);
      setSuccess(isAr ? "تم حفظ رقم التحويل ومزامنته على الخادم. سيستخدمه العملاء عند اتصالهم بالإنترنت." : "Recipient number saved centrally. Customers will use it when online.");
    } catch {
      setError(isAr ? "فشل حفظ الرقم على الخادم. لم يتم اعتماد أي تغيير." : "Saving failed. No change was applied.");
    } finally { setSaving(false); }
  };

  return (
    <section className="rounded-2xl border border-sky-200/80 bg-sky-50/70 p-4 text-slate-900 shadow-sm dark:border-white/10 dark:bg-[#082a25] dark:text-[#daf1de] space-y-4">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-100 text-sky-700 dark:bg-white/10 dark:text-sky-200"><Phone className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold">{isAr ? "رقم التحويل — جوال باي" : "Jawwal Pay recipient number"}</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-[#a9c8bd]">{isAr ? "الرقم المركزي الذي يستقبل التحويلات. تغييره هنا يحدّث إعدادات جميع العملاء المتصلين دون تحديث التطبيق." : "The central number receiving transfers. Changes apply to connected customers without an app update."}</p>
        </div>
      </div>
      <label className="block space-y-1.5">
        <span className="text-xs font-semibold">{isAr ? "رقم المستلم" : "Recipient phone"}</span>
        <input value={phone} onChange={e => { setPhone(e.target.value); setSuccess(""); }} disabled={loading || saving} inputMode="tel" autoComplete="tel" placeholder="0592369875" className="w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-base font-semibold tracking-wide text-slate-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-200 disabled:opacity-60 dark:border-white/15 dark:bg-[#041714] dark:text-white" />
      </label>
      <div className="flex items-start gap-2 text-xs text-slate-600 dark:text-[#a9c8bd]"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /><span>{isAr ? "الحفظ يتطلب صلاحية إدارة الإعدادات واتصالًا بالخادم." : "Saving requires settings-management permission and a server connection."}</span></div>
      {error && <p role="alert" className="rounded-lg bg-red-100 px-3 py-2 text-sm font-medium text-red-800 dark:bg-red-950/50 dark:text-red-200">{error}</p>}
      {success && <p role="status" className="flex items-start gap-2 rounded-lg bg-emerald-100 px-3 py-2 text-sm font-medium text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{success}</p>}
      <button type="button" onClick={save} disabled={loading || saving} className="flex w-full items-center justify-center gap-2 rounded-xl bg-sky-700 px-4 py-3 text-sm font-bold text-white transition hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-60">
        {saving || loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {loading ? (isAr ? "جارٍ تحميل الرقم..." : "Loading number...") : saving ? (isAr ? "جارٍ الحفظ..." : "Saving...") : (isAr ? "حفظ رقم التحويل" : "Save recipient number")}
      </button>
    </section>
  );
};
