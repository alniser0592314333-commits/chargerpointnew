import React, { useCallback, useEffect, useState } from "react";
import { Bell, BellRing, CalendarDays, Image as ImageIcon, LoaderCircle, RefreshCw } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { useI18n } from "../../i18n/i18nContext";
import { customerAuth } from "../../services/customer/customerAuth";
import { config } from "../../config/env";

type EventBlock = {
  type: "text" | "image";
  text_ar?: string;
  text_en?: string;
  path?: string;
  url?: string | null;
  alt_ar?: string;
  alt_en?: string;
};
type PortalEvent = {
  id: string;
  title_ar?: string | null;
  title_en?: string | null;
  content_blocks: EventBlock[];
  published_at: string;
  created_at: string;
};

export const CustomerPortalEventsSection: React.FC<{
  token: string;
  online: boolean;
  serverAvailable: boolean;
}> = ({ token, online, serverAvailable }) => {
  const { locale } = useI18n();
  const isAr = locale === "ar";
  const [events, setEvents] = useState<PortalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pushBusy, setPushBusy] = useState(false);
  const [pushState, setPushState] = useState<"unsupported" | "install-required" | "disabled" | "enabled" | "denied" | "unknown">("unknown");
  const [pushMessage, setPushMessage] = useState("");

  const callEvents = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    const { data } = await customerAuth.auth.getSession();
    const accessToken = data.session?.access_token;
    if (!accessToken) throw new Error("AUTH_REQUIRED");
    const response = await fetch(config.supabaseUrl.replace(/\/+$/, "") + "/functions/v1/customer-portal-events", {
      method: "POST",
      cache: "no-store",
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, ...payload }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok !== true) throw new Error(typeof result?.error === "string" ? result.error : "EVENTS_REQUEST_FAILED");
    return result;
  }, []);

  const loadEvents = useCallback(async () => {
    if (!online || !serverAvailable) { setLoading(false); return; }
    setLoading(true);
    setError("");
    try {
      const result = await callEvents("customer-list");
      setEvents(Array.isArray(result.events) ? result.events : []);
    } catch {
      setError(isAr ? "تعذّر تحميل الأحداث. حدّث الصفحة وحاول مرة ثانية." : "Could not load events. Refresh and try again.");
    } finally {
      setLoading(false);
    }
  }, [callEvents, isAr, online, serverAvailable]);

  useEffect(() => { void loadEvents(); }, [loadEvents]);

  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      setPushState("unsupported");
      return;
    }
    const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isInstalled = window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    if (isAppleMobile && !isInstalled) {
      setPushState("install-required");
      return;
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setPushState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setPushState("denied");
      return;
    }
    void navigator.serviceWorker.ready.then(async (registration) => {
      const existing = await registration.pushManager.getSubscription();
      setPushState(existing ? "enabled" : "disabled");
    }).catch(() => setPushState("unsupported"));
  }, []);

  const enablePush = async () => {
    if (pushBusy || !online || !serverAvailable) return;
    setPushBusy(true);
    setPushMessage("");
    try {
      if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
        setPushState("unsupported");
        throw new Error("PUSH_UNSUPPORTED");
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushState(permission === "denied" ? "denied" : "disabled");
        throw new Error("PUSH_PERMISSION_NOT_GRANTED");
      }
      const configResult = await callEvents("public-config");
      const publicKey = typeof configResult.vapid_public_key === "string" ? configResult.vapid_public_key : "";
      if (!publicKey) throw new Error("WEB_PUSH_NOT_CONFIGURED");
      const applicationServerKey = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - publicKey.length % 4) % 4)), (char) => char.charCodeAt(0));
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription() ||
        await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      await callEvents("subscribe", { subscription: subscription.toJSON(), portalToken: token, locale });
      setPushState("enabled");
      setPushMessage(isAr ? "تم تفعيل الإشعارات على هذا الجهاز." : "Notifications are enabled on this device.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      setPushMessage(reason === "PUSH_PERMISSION_NOT_GRANTED"
        ? (isAr ? "لم يتم منح إذن الإشعارات. يمكنك تفعيله من إعدادات المتصفح." : "Notification permission was not granted. You can enable it in browser settings.")
        : reason === "WEB_PUSH_NOT_CONFIGURED"
          ? (isAr ? "إشعارات المتصفح غير مهيأة حاليًا." : "Browser notifications are not configured yet.")
          : (isAr ? "تعذّر تفعيل الإشعارات. تأكد من إذن المتصفح والاتصال." : "Could not enable notifications. Check browser permission and connection."));
    } finally {
      setPushBusy(false);
    }
  };

  const disablePush = async () => {
    if (pushBusy) return;
    setPushBusy(true);
    setPushMessage("");
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await callEvents("unsubscribe", { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      setPushState("disabled");
      setPushMessage(isAr ? "تم إيقاف إشعارات هذا المتصفح." : "Browser notifications have been disabled.");
    } catch {
      setPushMessage(isAr ? "تعذّر إيقاف الإشعارات من هذا الجهاز." : "Could not disable notifications on this device.");
    } finally {
      setPushBusy(false);
    }
  };

  return (
    <section className="cp-portal-section space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="cp-portal-eyebrow">{isAr ? "آخر المستجدات" : "LATEST UPDATES"}</p>
          <h1 className="cp-portal-heading">{isAr ? "الأحداث" : "Events"}</h1>
          <p className="mt-1 text-sm cp-portal-muted">{isAr ? "إعلانات وتحديثات نقطة الشحن." : "Announcements and updates from Charging Point."}</p>
        </div>
        <button type="button" className="cp-portal-secondary-button" disabled={!online || !serverAvailable || loading} onClick={() => void loadEvents()}>
          {loading ? <LoaderCircle size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          {isAr ? "تحديث" : "Refresh"}
        </button>
      </div>

      {!Capacitor.isNativePlatform() && pushState !== "unsupported" && pushState !== "install-required" && (
        <div className="rounded-2xl border border-slate-200/80 dark:border-white/10 bg-white/75 dark:bg-white/[0.04] p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-300">
              {pushState === "enabled" ? <BellRing size={19} /> : <Bell size={19} />}
            </span>
            <div>
              <p className="font-semibold">{isAr ? "إشعارات الأحداث على جهازك" : "Event notifications on this device"}</p>
              <p className="mt-1 text-xs cp-portal-muted">{isAr ? "بتوصلك رسالة حتى لو كنت فاتح تطبيق ثاني، بعد ما تسمح للمتصفح بالإشعارات." : "Receive notifications while using another app after allowing browser notifications."}</p>
            </div>
          </div>
          {pushState === "enabled"
            ? <button type="button" className="cp-portal-secondary-button" disabled={pushBusy || !online} onClick={() => void disablePush()}>{isAr ? "إيقاف الإشعارات" : "Turn off"}</button>
            : <button type="button" className="cp-portal-primary-button" disabled={pushBusy || !online || !serverAvailable || pushState === "denied"} onClick={() => void enablePush()}>
                {pushBusy ? <LoaderCircle size={16} className="animate-spin" /> : <Bell size={16} />}
                {isAr ? "تفعيل الإشعارات" : "Enable notifications"}
              </button>}
        </div>
      )}
      {pushState === "denied" && <p className="text-xs cp-portal-muted">{isAr ? "إذن الإشعارات مرفوض من المتصفح. غيّره من إعدادات الموقع." : "Notifications are blocked by the browser. Change this in site settings."}</p>}
      {pushMessage && <p role="status" className="text-sm cp-portal-muted">{pushMessage}</p>}

      {loading ? <div className="cp-portal-notice"><LoaderCircle size={18} className="animate-spin" /><p>{isAr ? "جارٍ تحميل الأحداث..." : "Loading events..."}</p></div>
        : error ? <div className="cp-portal-notice"><CalendarDays size={18} /><p>{error}</p></div>
        : events.length === 0 ? <div className="cp-portal-notice"><CalendarDays size={18} /><div><p className="font-bold">{isAr ? "ما في أحداث حاليًا" : "No events yet"}</p><p className="mt-1 text-sm cp-portal-muted">{isAr ? "أي إعلان أو تحديث جديد رح يظهر هون." : "New announcements and updates will appear here."}</p></div></div>
        : <div className="space-y-4">
          {events.map((event) => (
            <article key={event.id} className="overflow-hidden rounded-3xl border border-slate-200/80 dark:border-white/10 bg-white/80 dark:bg-white/[0.035] shadow-sm">
              {(event.title_ar || event.title_en) && <div className="px-5 pt-5 pb-2"><h2 className="text-lg font-bold">{isAr ? (event.title_ar || event.title_en) : (event.title_en || event.title_ar)}</h2></div>}
              <div className="space-y-3 p-4 sm:p-5">
                {event.content_blocks.map((block, index) => block.type === "image"
                  ? <figure key={event.id + "-image-" + index} className="overflow-hidden rounded-2xl bg-slate-100 dark:bg-white/5">
                      {block.url ? <img src={block.url} alt={isAr ? (block.alt_ar || "") : (block.alt_en || block.alt_ar || "")} loading="lazy" className="w-full max-h-[560px] object-contain" /> : <div className="flex items-center justify-center gap-2 p-8 cp-portal-muted"><ImageIcon size={18}/>{isAr ? "الصورة غير متاحة مؤقتًا" : "Image temporarily unavailable"}</div>}
                    </figure>
                  : <p key={event.id + "-text-" + index} className="whitespace-pre-wrap break-words leading-8 text-[15px]">{isAr ? (block.text_ar || block.text_en) : (block.text_en || block.text_ar)}</p>)}
                <p className="pt-1 text-[11px] cp-portal-muted">{new Intl.DateTimeFormat(isAr ? "ar-PS" : "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(event.published_at || event.created_at))}</p>
              </div>
            </article>
          ))}
        </div>}
    </section>
  );
};
