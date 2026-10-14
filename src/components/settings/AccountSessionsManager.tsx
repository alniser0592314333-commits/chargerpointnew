import React, { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n/i18nContext";
import { authService } from "../../services/auth/authService";
import {
  AccountSession,
  describeSessionUserAgent,
  getAccountSessions,
  registerCurrentAccountSession,
  revokeAccountSession,
  revokeAllAccountSessions,
  revokeOtherAccountSessions,
} from "../../services/auth/accountSessionService";
import { Button } from "../ui/Button";
import { Monitor, Smartphone, Tablet, Globe, RefreshCw, LogOut, ShieldCheck, AlertCircle } from "lucide-react";

interface AccountSessionsManagerProps {
  onLogout?: () => void | Promise<void>;
}

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(locale === "ar" ? "ar" : "en", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

export const AccountSessionsManager: React.FC<AccountSessionsManagerProps> = ({ onLogout }) => {
  const { locale } = useI18n();
  const isArabic = locale === "ar";
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"selected" | "others" | "all" | null>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await registerCurrentAccountSession();
      const result = await getAccountSessions();
      setSessions(result);
      setSelected((previous) => previous.filter((id) => result.some((session) => session.session_id === id)));
    } catch (err: any) {
      setError(err?.message || (isArabic ? "تعذّر تحميل جلسات الحساب." : "Could not load account sessions."));
    } finally {
      setLoading(false);
    }
  }, [isArabic]);

  useEffect(() => { void loadSessions(); }, [loadSessions]);

  const handleRevokeSelected = async () => {
    if (!selected.length || busy) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      let revokedCurrent = false;
      // Revoke other sessions first. If this browser session is selected, revoke
      // it last so its token cannot prevent the remaining RPCs from completing.
      const currentSessionId = sessions.find((session) => session.is_current)?.session_id;
      const orderedSelected = [
        ...selected.filter((id) => id !== currentSessionId),
        ...selected.filter((id) => id === currentSessionId),
      ];
      for (const id of orderedSelected) {
        const result = await revokeAccountSession(id);
        revokedCurrent = revokedCurrent || result.revoked_current;
      }
      if (revokedCurrent) {
        await authService.logout();
        await onLogout?.();
        return;
      }
      setSuccess(isArabic ? "تم إنهاء الجلسات المحددة." : "Selected sessions were signed out.");
      await loadSessions();
    } catch (err: any) {
      setError(err?.message || (isArabic ? "تعذّر إنهاء الجلسات المحددة." : "Could not sign out selected sessions."));
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeOthers = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const count = await revokeOtherAccountSessions();
      setSuccess(isArabic ? `تم إنهاء ${count} جلسة أخرى.` : `${count} other session(s) signed out.`);
      await loadSessions();
    } catch (err: any) {
      setError(err?.message || (isArabic ? "تعذّر إخراج الأجهزة الأخرى." : "Could not sign out other devices."));
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeAll = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await revokeAllAccountSessions();
      await authService.logout();
      await onLogout?.();
    } catch (err: any) {
      setError(err?.message || (isArabic ? "تعذّر تسجيل الخروج من جميع الأجهزة." : "Could not sign out all devices."));
      setBusy(false);
    }
  };

  const confirmPendingAction = async () => {
    const action = pendingAction;
    if (!action || busy) return;
    setPendingAction(null);
    if (action === "selected") await handleRevokeSelected();
    else if (action === "others") await handleRevokeOthers();
    else await handleRevokeAll();
  };

  const toggleSelected = (id: string) => {
    setSelected((previous) => previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]);
  };

  return (
    <div className="mt-5 space-y-3 border-t border-gray-200/80 pt-4 dark:border-[#123832]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-emerald-700 dark:text-[#8eb698]" />
          <h3 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">{isArabic ? "الأجهزة والجلسات المسجّلة" : "Devices & signed-in sessions"}</h3>
          <span className="text-xs tabular-nums text-gray-500 dark:text-[#8eb698]">({sessions.length})</span>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={loading || busy} onClick={() => void loadSessions()} className="h-8 gap-1.5 text-xs">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {isArabic ? "تحديث" : "Refresh"}
        </Button>
      </div>
      <p className="text-xs leading-5 text-gray-500 dark:text-[#8eb698]">
        {isArabic ? "تعرض القائمة الجلسات التي يستطيع النظام التعرّف عليها. معلومات الجهاز والمتصفح للتعرّف فقط وقد لا تحدد هوية الشخص." : "This list shows sessions the system can identify. Device and browser details are informational and do not identify the person using them."}
      </p>

      {error && <div role="alert" className="flex items-start gap-2 border-b border-red-200 py-2 text-xs text-red-700 dark:border-red-900 dark:text-red-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="break-words">{error}</span></div>}
      {success && <p role="status" className="border-b border-emerald-200 py-2 text-xs text-emerald-700 dark:border-emerald-900 dark:text-emerald-300">{success}</p>}

      {pendingAction && (
        <div role="group" aria-label={isArabic ? "تأكيد إخراج الجلسات" : "Confirm session sign-out"} className="rounded-xl border border-amber-300 bg-amber-50/80 p-3 dark:border-amber-800 dark:bg-amber-950/20">
          <p className="text-sm font-semibold text-gray-900 dark:text-[#daf1de]">
            {pendingAction === "selected"
              ? (isArabic ? `تأكيد إخراج ${selected.length} جلسة محددة؟` : `Confirm sign-out of ${selected.length} selected session(s)?`)
              : pendingAction === "others"
                ? (isArabic ? "تأكيد إخراج كل الأجهزة الأخرى مع إبقاء هذا الجهاز مسجّل الدخول؟" : "Sign out all other devices and keep this device signed in?")
                : (isArabic ? "تحذير: سيتم إخراج الحساب من جميع الأجهزة، بما فيها هذا الجهاز." : "Warning: this signs the account out on every device, including this one.")}
          </p>
          <p className="mt-1 text-xs leading-5 text-gray-600 dark:text-[#8eb698]">
            {isArabic ? "لن يتم تنفيذ العملية إلا بعد ضغط زر التأكيد أدناه." : "Nothing changes until you press the confirmation button below."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setPendingAction(null)}>
              {isArabic ? "إلغاء" : "Cancel"}
            </Button>
            <Button type="button" variant="danger" size="sm" disabled={busy} onClick={() => void confirmPendingAction()}>
              <LogOut className="h-3.5 w-3.5" />
              {isArabic ? "تأكيد الإخراج" : "Confirm sign-out"}
            </Button>
          </div>
        </div>
      )}

      <div className="divide-y divide-gray-100 dark:divide-[#0f302b]">
        {loading ? (
          <p className="py-4 text-xs text-gray-500 dark:text-[#8eb698]">{isArabic ? "جارٍ تحميل الجلسات..." : "Loading sessions..."}</p>
        ) : sessions.length === 0 ? (
          <p className="py-4 text-xs text-gray-500 dark:text-[#8eb698]">{isArabic ? "لم يتم العثور على جلسات نشطة." : "No active sessions were found."}</p>
        ) : sessions.map((session) => {
          const details = describeSessionUserAgent(session.user_agent);
          const DeviceIcon = details.device === "Mobile" ? Smartphone : details.device === "Tablet" ? Tablet : Monitor;
          return (
            <div key={session.session_id} className="flex items-start gap-3 py-3">
              <input
                type="checkbox"
                aria-label={isArabic ? `تحديد جلسة ${details.device}` : `Select ${details.device} session`}
                checked={selected.includes(session.session_id)}
                disabled={busy}
                onChange={() => toggleSelected(session.session_id)}
                className="mt-1 h-4 w-4 rounded border-gray-300 accent-emerald-700"
              />
              <DeviceIcon className="mt-0.5 h-5 w-5 shrink-0 text-gray-500 dark:text-[#8eb698]" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-gray-900 dark:text-[#daf1de]">{isArabic
                    ? (details.device === "Mobile" ? "هاتف" : details.device === "Tablet" ? "جهاز لوحي" : details.device === "Computer" ? "كمبيوتر" : "جهاز غير معروف")
                    : details.device}</span>
                  {session.is_current && <span className="rounded border border-emerald-200 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-900 dark:text-emerald-300">{isArabic ? "هذا الجهاز" : "This device"}</span>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-600 dark:text-[#8eb698]">
                  <span>{details.browser}</span><span aria-hidden="true">·</span><span>{details.operatingSystem}</span>
                </div>
                <div className="mt-1.5 space-y-0.5 text-[11px] text-gray-500 dark:text-[#709784]">
                  <p>{isArabic ? "تسجيل الدخول:" : "Signed in:"} {formatDate(session.created_at, locale)}</p>
                  <p>{isArabic ? "آخر نشاط مسجّل:" : "Last recorded activity:"} {formatDate(session.last_seen_at, locale)}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-gray-200/80 pt-3 dark:border-[#123832]">
        <Button type="button" variant="outline" size="sm" disabled={busy || loading || selected.length === 0} onClick={() => setPendingAction("selected")} className="h-9 gap-1.5 text-xs">
          <LogOut className="h-3.5 w-3.5" />{isArabic ? `إخراج المحدد (${selected.length})` : `Sign out selected (${selected.length})`}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={busy || loading || sessions.length <= 1} onClick={() => setPendingAction("others")} className="h-9 gap-1.5 text-xs">
          <Globe className="h-3.5 w-3.5" />{isArabic ? "إخراج الأجهزة الأخرى" : "Sign out other devices"}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={busy || loading || sessions.length === 0} onClick={() => setPendingAction("all")} className="h-9 gap-1.5 text-xs border-red-200 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/30">
          <LogOut className="h-3.5 w-3.5" />{isArabic ? "إخراج الجميع" : "Sign out all"}
        </Button>
      </div>
      <p className="text-[11px] leading-5 text-gray-500 dark:text-[#709784]">
        {isArabic ? "قد تستغرق الجلسة المفتوحة على جهاز آخر حتى دورة التحقق التالية قبل أن يعود التطبيق إلى شاشة الدخول. لا يمكن إجبار جهاز غير متصل على استقبال الأمر فورًا." : "Another open app may return to the login screen at its next session check. A disconnected device cannot receive a command instantly."}
      </p>
    </div>
  );
};
