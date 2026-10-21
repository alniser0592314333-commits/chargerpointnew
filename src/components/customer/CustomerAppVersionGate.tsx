import React, { useCallback, useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { AlertCircle, CheckCircle2, Clock3, Download, LoaderCircle, RefreshCw, ShieldAlert, WifiOff } from 'lucide-react';
import { fetchAppReleasePolicy, parseAppVersion, type AppReleaseChannel, type AppReleasePolicy } from '../../services/appReleasePolicy';

const CURRENT_VERSION = import.meta.env.VITE_APP_VERSION || '1.0.0';
type GateState = 'checking' | 'ready' | 'update' | 'blocked' | 'offline-unknown';

function readCachedPolicy(channel: AppReleaseChannel, cacheKey: string): AppReleasePolicy | null {
  try {
    const raw = localStorage.getItem(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AppReleasePolicy;
    if (parsed.channel !== channel || !parseAppVersion(parsed.latest_version)
      || !Number.isFinite(Number(parsed.version_code)) || !Number.isFinite(Date.parse(parsed.grace_until))) return null;
    return parsed;
  } catch { return null; }
}

function currentVersionCode(): number {
  return parseAppVersion(CURRENT_VERSION)?.code ?? 1_000_000;
}

export const AppVersionGate: React.FC<React.PropsWithChildren<{ channel: AppReleaseChannel }>> = ({ children, channel }) => {
  const policyCacheKey = 'cp_app_release_policy_v1_' + channel;
  const dismissKeyPrefix = 'cp_app_release_dismissed_v1_' + channel + '_';
  const activeVariant = import.meta.env.MODE === 'admin' ? 'admin' : 'customer';
  // Never hold the first frame behind a network request. Version enforcement runs in the background.
  const [state, setState] = useState<GateState>('ready');
  const [policy, setPolicy] = useState<AppReleasePolicy | null>(null);
  const [isOnline, setIsOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const deadlineTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const evaluatePolicy = useCallback((nextPolicy: AppReleasePolicy) => {
    if (!mounted.current) return;
    setPolicy(nextPolicy);
    if (currentVersionCode() >= Number(nextPolicy.version_code)) {
      setState('ready');
      if (deadlineTimer.current) clearTimeout(deadlineTimer.current);
      return;
    }
    const deadline = Date.parse(nextPolicy.grace_until);
    const now = Date.now();
    if (now >= deadline) {
      setState('blocked');
      if (deadlineTimer.current) clearTimeout(deadlineTimer.current);
      return;
    }
    let dismissedUntil = 0;
    try { dismissedUntil = Number(localStorage.getItem(dismissKeyPrefix + nextPolicy.latest_version) || 0); } catch {}
    setState(dismissedUntil > now ? 'ready' : 'update');
    if (deadlineTimer.current) clearTimeout(deadlineTimer.current);
    deadlineTimer.current = setTimeout(() => {
      if (mounted.current && currentVersionCode() < Number(nextPolicy.version_code)) setState('blocked');
    }, Math.min(Math.max(deadline - now, 0), 2_147_000_000));
  }, [dismissKeyPrefix]);

  const checkVersion = useCallback(async () => {
    if (!Capacitor.isNativePlatform() || activeVariant !== channel) {
      setState('ready');
      return;
    }
    setIsOnline(typeof navigator === 'undefined' ? true : navigator.onLine);
    // Enforce the last trusted policy immediately on resume/startup, before any
    // network wait. This prevents an expired build from gaining an offline bypass.
    const cachedAtStart = readCachedPolicy(channel, policyCacheKey);
    if (cachedAtStart) evaluatePolicy(cachedAtStart);
    const resultPromise = fetchAppReleasePolicy(channel);
    const timeoutPromise = new Promise<{ policy: null; error: string }>((resolve) => {
      setTimeout(() => resolve({ policy: null, error: 'APP_RELEASE_CHECK_TIMEOUT' }), 8000);
    });
    const result = await Promise.race([resultPromise, timeoutPromise]);
    if (!mounted.current) return;
    if (result.policy) {
      try { localStorage.setItem(policyCacheKey, JSON.stringify(result.policy)); } catch {}
      evaluatePolicy(result.policy);
      return;
    }
    const cached = readCachedPolicy(channel, policyCacheKey);
    if (cached) { evaluatePolicy(cached); return; }
    // A first launch without a cached policy must remain usable offline. A previously
    // cached policy is still enforced above, including its local expiry deadline.
    setState('ready');
  }, [activeVariant, channel, evaluatePolicy, policyCacheKey]);

  useEffect(() => {
    mounted.current = true;
    void checkVersion();
    const onOnline = () => { setIsOnline(true); void checkVersion(); };
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const appStateListener = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void checkVersion();
    });
    return () => {
      mounted.current = false;
      if (deadlineTimer.current) clearTimeout(deadlineTimer.current);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      void appStateListener.then((listener) => listener.remove()).catch(() => undefined);
    };
  }, [checkVersion]);

  if (!Capacitor.isNativePlatform() || activeVariant !== channel) return <>{children}</>;
  const hardBlock = state === 'blocked';
  const openUpdate = () => {
    const url = policy?.download_url?.trim();
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
    } catch {}
  };
  const dismiss = () => {
    if (!policy) return;
    const deadline = Date.parse(policy.grace_until);
    if (Date.now() >= deadline) { setState('blocked'); return; }
    try { localStorage.setItem(dismissKeyPrefix + policy.latest_version, String(deadline)); } catch {}
    setState('ready');
  };

  if (state === 'ready' || state === 'checking' || state === 'offline-unknown') return <>{children}</>;
  return (
    <>
      {children}
      <div dir="rtl" className="fixed inset-0 z-[2147483000] flex min-h-[100dvh] items-center justify-center overflow-y-auto bg-[#061c1a] px-4 py-8 text-right text-white">
      <div className="w-full max-w-md overflow-hidden rounded-[28px] border border-white/10 bg-[#0b2925] shadow-2xl">
        <div className="relative overflow-hidden bg-gradient-to-br from-[#124c40] via-[#0d332d] to-[#071f1c] px-6 pb-6 pt-7">
          <div className="absolute -left-10 -top-10 h-36 w-36 rounded-full bg-emerald-400/10 blur-2xl" />
          <div className="relative flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/10">
              {state === 'checking' ? <LoaderCircle className="h-6 w-6 animate-spin text-emerald-200" /> : hardBlock ? <ShieldAlert className="h-6 w-6 text-amber-200" /> : <Download className="h-6 w-6 text-emerald-200" />}
            </div>
            <div><p className="text-xs font-semibold tracking-wide text-emerald-200">{channel === 'customer' ? 'نقطة الشحن' : 'نقطة الشحن - الإدارة'}</p><h1 className="mt-1 text-xl font-extrabold">{state === 'checking' ? 'جارٍ التحقق من الإصدار' : state === 'offline-unknown' ? 'يلزم الاتصال بالإنترنت' : state === 'blocked' ? 'انتهت صلاحية الإصدار' : 'يتوفر تحديث جديد'}</h1></div>
          </div>
        </div>
        <div className="space-y-5 p-6">
          {state === 'checking' ? <p className="text-sm leading-7 text-emerald-50/80">نتحقق من سياسة الإصدارات قبل فتح التطبيق.</p> : state === 'offline-unknown' ? (
            <div className="flex gap-3 rounded-2xl border border-amber-300/20 bg-amber-300/5 p-4 text-sm leading-7 text-amber-50"><WifiOff className="mt-1 h-5 w-5 shrink-0" /><p>لم يتم التحقق من الإصدار على هذا الجهاز بعد. اتصل بالإنترنت ثم أعد المحاولة.</p></div>
          ) : state === 'blocked' ? (
            <div className="space-y-3"><div className="flex gap-3 rounded-2xl border border-red-300/20 bg-red-300/5 p-4 text-sm leading-7 text-red-50"><AlertCircle className="mt-1 h-5 w-5 shrink-0" /><p>لم يعد الإصدار {CURRENT_VERSION} مسموحًا به. ثبّت الإصدار {policy?.latest_version || 'الأحدث'} للمتابعة. تم حفظ سياسة الإلزام، وسيبقى التطبيق مقفلًا دون إنترنت أيضًا.</p></div>{!isOnline && <p className="text-xs text-amber-100/80">قد تحتاج للاتصال بالإنترنت لتنزيل ملف التحديث.</p>}</div>
          ) : (
            <>
              <div className="flex items-start gap-3 rounded-2xl border border-emerald-300/15 bg-emerald-300/5 p-4"><CheckCircle2 className="mt-1 h-5 w-5 shrink-0 text-emerald-200" /><div className="min-w-0 flex-1"><p className="text-sm font-bold">الإصدار الحالي: {CURRENT_VERSION} · الإصدار الجديد: {policy?.latest_version}</p>{policy?.release_notes && <p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-emerald-50/80">{policy.release_notes}</p>}</div></div>
              <div className="flex gap-2 text-xs leading-5 text-emerald-50/70"><Clock3 className="mt-0.5 h-4 w-4 shrink-0" /><p>آخر موعد لاستخدام الإصدار السابق: {policy ? new Date(policy.grace_until).toLocaleString('ar', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</p></div>
            </>
          )}
          {state !== 'checking' && policy?.download_url && <button type="button" onClick={openUpdate} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-400 px-4 py-3.5 text-sm font-extrabold text-[#06231d] transition hover:bg-emerald-300 active:scale-[.99]"><Download className="h-4 w-4" />تحديث التطبيق إلى {policy.latest_version}</button>}
          {state === 'update' && !policy?.download_url && <p className="text-xs text-amber-100">رابط التحديث غير متوفر حاليًا. يرجى التواصل مع الإدارة.</p>}
          {state === 'update' && <button type="button" onClick={dismiss} className="w-full rounded-2xl border border-white/15 px-4 py-3 text-sm font-semibold text-white/80 transition hover:bg-white/5">إخفاء حتى موعد الإلزام</button>}
          {(state === 'offline-unknown' || state === 'blocked') && <button type="button" onClick={() => void checkVersion()} className="flex w-full items-center justify-center gap-2 rounded-2xl border border-white/15 px-4 py-3 text-sm font-semibold text-white/85 transition hover:bg-white/5"><RefreshCw className="h-4 w-4" />إعادة التحقق</button>}
          {hardBlock && !policy?.download_url && <p className="text-center text-xs text-white/55">يجب توفير رابط تنزيل HTTPS للإصدار المنشور من إعدادات الإدارة.</p>}
        </div>
      </div>
      </div>
    </>
  );
};
