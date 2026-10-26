import React, { useCallback, useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { AlertCircle, CheckCircle2, Clock3, Download, Gauge, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';
import { fetchAppReleasePolicy, parseAppVersion, type AppReleaseChannel, type AppReleasePolicy } from '../../services/appReleasePolicy';

const CURRENT_VERSION = import.meta.env.VITE_APP_VERSION || '1.0.0';

type ApkDownloadProgress = { status: string; bytesDownloaded?: number; totalBytes?: number; done: boolean; failed: boolean; reason?: string };
type ApkUpdaterPlugin = {
  startDownload(options: { url: string; version: string }): Promise<{ downloadId: string }>;
  getProgress(options: { downloadId: string }): Promise<ApkDownloadProgress>;
  install(options: { downloadId: string }): Promise<void>;
};
const ApkUpdater = registerPlugin<ApkUpdaterPlugin>('ApkUpdater');

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return value + ' B';
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return size.toFixed(size >= 100 ? 0 : 1) + ' ' + units[unit];
}

type GateState = 'ready' | 'update' | 'blocked';

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

function initialState(channel: AppReleaseChannel, cacheKey: string, dismissPrefix: string): { state: GateState; policy: AppReleasePolicy | null } {
  const policy = readCachedPolicy(channel, cacheKey);
  if (!policy || currentVersionCode() >= Number(policy.version_code)) return { state: 'ready', policy };
  const deadline = Date.parse(policy.grace_until);
  if (Date.now() >= deadline) return { state: 'blocked', policy };
  try {
    if (Number(localStorage.getItem(dismissPrefix + policy.latest_version) || 0) > Date.now()) {
      return { state: 'ready', policy };
    }
  } catch {}
  return { state: 'update', policy };
}

export const AppVersionGate: React.FC<React.PropsWithChildren<{ channel: AppReleaseChannel }>> = ({ children, channel }) => {
  const policyCacheKey = 'cp_app_release_policy_v1_' + channel;
  const dismissKeyPrefix = 'cp_app_release_dismissed_v1_' + channel + '_';
  const activeVariant = import.meta.env.MODE === 'admin' ? 'admin' : 'customer';
  const initial = initialState(channel, policyCacheKey, dismissKeyPrefix);
  const [state, setState] = useState<GateState>(initial.state);
  const [policy, setPolicy] = useState<AppReleasePolicy | null>(initial.policy);
  const [isOnline, setIsOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const currentPath = typeof window === 'undefined' ? '' : window.location.pathname;
  const landingRoute = currentPath === '/public/about';
  const [noticeReady, setNoticeReady] = useState(false);
  const [downloadId, setDownloadId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<ApkDownloadProgress | null>(null);
  const [downloadError, setDownloadError] = useState('');
  const [downloadSpeed, setDownloadSpeed] = useState(0);
  const progressSample = useRef<{ at: number; bytes: number } | null>(null);
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
    if (!Capacitor.isNativePlatform() || activeVariant !== channel) return;
    setIsOnline(typeof navigator === 'undefined' ? true : navigator.onLine);
    // Re-evaluate a cached policy immediately on launch/resume before any network wait.
    const cachedBeforeNetwork = readCachedPolicy(channel, policyCacheKey);
    if (cachedBeforeNetwork) evaluatePolicy(cachedBeforeNetwork);
    const resultPromise = fetchAppReleasePolicy(channel);
    const timeoutPromise = new Promise<{ policy: null; error: string }>((resolve) => {
      setTimeout(() => resolve({ policy: null, error: 'APP_RELEASE_CHECK_TIMEOUT' }), 5000);
    });
    const result = await Promise.race([resultPromise, timeoutPromise]);
    if (!mounted.current) return;
    if (result.policy) {
      try { localStorage.setItem(policyCacheKey, JSON.stringify(result.policy)); } catch {}
      evaluatePolicy(result.policy);
      return;
    }
    // A missing connection or unavailable policy must not prevent a previously
    // installed app from opening its locally cached experience. If a policy was
    // cached before, evaluate it locally so an expired build remains blocked.
    const cached = readCachedPolicy(channel, policyCacheKey);
    if (cached) evaluatePolicy(cached);
    else setState('ready');
  }, [activeVariant, channel, evaluatePolicy, policyCacheKey]);

  useEffect(() => {
    const shouldShow = state === 'update' && (channel === 'admin' || landingRoute);
    if (!shouldShow) {
      setNoticeReady(false);
      return;
    }
    // Let the actual screen paint first. In the customer APK, wait for the
    // welcome intro to leave the screen before presenting a version reminder.
    let introListener: EventListener | null = null;
    const timer = setTimeout(() => {
      const introVisible = channel === 'customer' && landingRoute && Boolean(document.querySelector('.cp-welcome-intro'));
      if (!introVisible) {
        setNoticeReady(true);
        return;
      }
      introListener = () => { window.setTimeout(() => setNoticeReady(true), 80); };
      window.addEventListener('cp:customer-intro-complete', introListener, { once: true });
      // Close the tiny race where the intro completed between the visibility
      // check and listener registration.
      if (!document.querySelector('.cp-welcome-intro')) {
        window.removeEventListener('cp:customer-intro-complete', introListener);
        setNoticeReady(true);
      }
    }, 850);
    return () => {
      clearTimeout(timer);
      if (introListener) window.removeEventListener('cp:customer-intro-complete', introListener);
    };
  }, [state, channel, landingRoute]);

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
  // Customer update notices belong on the public landing page, never in the
  // customer QR/login flow. Admin notices appear after the admin UI has painted.
  const showUpdateNotice = state === 'update' && noticeReady && (channel === 'admin' || landingRoute);
  const hardBlock = state === 'blocked';
  const startUpdateDownload = async () => {
    const url = policy?.download_url?.trim();
    if (!url) { setDownloadError('رابط تنزيل التحديث غير متوفر في إعدادات الإدارة.'); return; }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') { setDownloadError('رابط التحديث غير صالح؛ يجب أن يبدأ بـ HTTPS.'); return; }
      setDownloadError('');
      setDownloadProgress({ status: 'starting', bytesDownloaded: 0, totalBytes: -1, done: false, failed: false });
      setDownloadSpeed(0);
      progressSample.current = null;
      const result = await ApkUpdater.startDownload({ url: parsed.toString(), version: policy?.latest_version || 'latest' });
      setDownloadId(result.downloadId);
    } catch (error) {
      setDownloadProgress(null);
      setDownloadError(error instanceof Error ? error.message : 'تعذر بدء التنزيل. تحقق من الاتصال ورابط الإصدار.');
    }
  };

  const installDownloadedUpdate = async () => {
    if (!downloadId || !downloadProgress?.done) return;
    setDownloadError('');
    try {
      await ApkUpdater.install({ downloadId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('INSTALL_PERMISSION_REQUIRED')) {
        setDownloadError('فعّل السماح بتثبيت التطبيقات من هذا المصدر في إعدادات أندرويد، ثم ارجع واضغط «تثبيت الآن» مرة أخرى.');
      } else {
        setDownloadError(message || 'تعذر فتح شاشة تثبيت أندرويد.');
      }
    }
  };

  useEffect(() => {
    if (!downloadId || downloadProgress?.done || downloadProgress?.failed) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const progress = await ApkUpdater.getProgress({ downloadId });
        if (cancelled) return;
        const bytes = Number(progress.bytesDownloaded || 0);
        const now = Date.now();
        const previous = progressSample.current;
        if (previous && now > previous.at && bytes >= previous.bytes) {
          setDownloadSpeed((bytes - previous.bytes) * 1000 / (now - previous.at));
        }
        progressSample.current = { at: now, bytes };
        setDownloadProgress(progress);
        if (progress.failed) setDownloadError('فشل تنزيل ملف التحديث. تحقق من الرابط والإنترنت ثم أعد المحاولة.');
      } catch (error) {
        if (!cancelled) setDownloadError(error instanceof Error ? error.message : 'تعذر قراءة تقدم التنزيل.');
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 800);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [downloadId, downloadProgress?.done, downloadProgress?.failed]);
  const dismiss = () => {
    if (!policy) return;
    const deadline = Date.parse(policy.grace_until);
    if (Date.now() >= deadline) { setState('blocked'); return; }
    try { localStorage.setItem(dismissKeyPrefix + policy.latest_version, String(deadline)); } catch {}
    setState('ready');
  };

  return (
    <>
      {children}
      {(showUpdateNotice || hardBlock) && (
        <div dir="rtl" className="fixed inset-0 z-[2147483000] flex min-h-[100dvh] items-center justify-center overflow-y-auto bg-[#071b1a] px-5 py-8 text-right text-white">
          <div role="dialog" aria-modal="true" className="flex min-h-[calc(100dvh-4rem)] w-full max-w-2xl flex-col justify-center overflow-hidden rounded-none border-0 bg-transparent shadow-none">
            <div className="relative overflow-hidden bg-transparent px-2 pb-6 pt-7">
              <div className="relative flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/10">
                  {hardBlock ? <ShieldAlert className="h-6 w-6 text-amber-200" /> : <Download className="h-6 w-6 text-emerald-200" />}
                </div>
                <div><p className="text-xs font-semibold tracking-wide text-emerald-200">{channel === 'customer' ? 'نقطة الشحن' : 'نقطة الشحن - الإدارة'}</p><h1 className="mt-1 text-xl font-extrabold">{hardBlock ? 'انتهت صلاحية الإصدار' : 'يتوفر تحديث جديد'}</h1></div>
              </div>
            </div>
            <div className="space-y-6 px-2 py-6">
              {hardBlock ? (
                <div className="space-y-3">
                  <div className="flex gap-3 rounded-xl border border-red-300/20 bg-red-300/5 p-4 text-sm leading-7 text-red-50"><AlertCircle className="mt-1 h-5 w-5 shrink-0" /><p>لم يعد الإصدار {CURRENT_VERSION} مسموحًا به. ثبّت الإصدار {policy?.latest_version || 'الأحدث'} للمتابعة. تم حفظ سياسة الإلزام محليًا، لذلك يبقى هذا الإصدار مقفلًا دون إنترنت إذا سبق تنزيل السياسة على الجهاز.</p></div>
                  {!isOnline && <p className="text-xs text-amber-100/80">يلزم الاتصال لتنزيل ملف التحديث.</p>}
                </div>
              ) : (
                <>
                  <div className="flex items-start gap-3 rounded-xl border border-emerald-300/15 bg-emerald-300/5 p-4"><CheckCircle2 className="mt-1 h-5 w-5 shrink-0 text-emerald-200" /><div className="min-w-0 flex-1"><p className="text-sm font-bold">الإصدار الحالي: {CURRENT_VERSION} · الإصدار الجديد: {policy?.latest_version}</p>{policy?.release_notes && <p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-emerald-50/80">{policy.release_notes}</p>}</div></div>
                  <div className="flex gap-2 text-xs leading-5 text-emerald-50/70"><Clock3 className="mt-0.5 h-4 w-4 shrink-0" /><p>آخر موعد لاستخدام الإصدار السابق: {policy ? new Date(policy.grace_until).toLocaleString('ar', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</p></div>
                </>
              )}
              {policy?.download_url && (
                <div className="space-y-3">
                  {downloadProgress && (
                    <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4" aria-live="polite">
                      <div className="flex items-center justify-between gap-3 text-sm font-bold">
                        <span>{downloadProgress.done ? 'اكتمل تنزيل التحديث' : downloadProgress.failed ? 'تعذر إكمال التنزيل' : 'جارٍ تنزيل التحديث…'}</span>
                        <span className="font-mono">{downloadProgress.done ? '100%' : (downloadProgress.totalBytes && downloadProgress.totalBytes > 0 ? Math.min(99, Math.floor((Number(downloadProgress.bytesDownloaded || 0) / downloadProgress.totalBytes) * 100)) + '%' : '…')}</span>
                      </div>
                      <div className="h-2.5 overflow-hidden rounded-full bg-white/10">
                        <div className={`h-full rounded-full transition-all duration-300 ${downloadProgress.failed ? 'bg-red-400' : 'bg-emerald-300'}`} style={{ width: downloadProgress.done ? '100%' : (downloadProgress.totalBytes && downloadProgress.totalBytes > 0 ? Math.min(99, (Number(downloadProgress.bytesDownloaded || 0) / downloadProgress.totalBytes) * 100) + '%' : '35%') }} />
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-white/70">
                        <span>{formatBytes(Number(downloadProgress.bytesDownloaded || 0))} / {formatBytes(Number(downloadProgress.totalBytes ?? -1))}</span>
                        {!downloadProgress.done && !downloadProgress.failed && <span className="flex items-center gap-1"><Gauge className="h-3.5 w-3.5" />{formatBytes(downloadSpeed)}/ث</span>}
                      </div>
                    </div>
                  )}
                  {downloadError && <div role="alert" className="flex gap-2 rounded-xl border border-red-300/20 bg-red-300/5 p-3 text-sm leading-6 text-red-50"><XCircle className="mt-1 h-4 w-4 shrink-0" /><p>{downloadError}</p></div>}
                  {downloadProgress?.done ? (
                    <button type="button" onClick={() => void installDownloadedUpdate()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-400 px-4 py-4 text-sm font-extrabold text-[#06231d] transition hover:bg-emerald-300 active:scale-[.99]"><CheckCircle2 className="h-4 w-4" />تثبيت الآن</button>
                  ) : downloadProgress && !downloadProgress.failed ? (
                    <button type="button" disabled className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-400/60 px-4 py-4 text-sm font-extrabold text-[#06231d]"><Download className="h-4 w-4 animate-pulse" />جارٍ تنزيل التحديث…</button>
                  ) : (
                    <button type="button" onClick={() => void startUpdateDownload()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-400 px-4 py-4 text-sm font-extrabold text-[#06231d] transition hover:bg-emerald-300 active:scale-[.99]"><Download className="h-4 w-4" />{downloadProgress?.failed ? 'إعادة محاولة التنزيل' : `تحديث التطبيق إلى ${policy.latest_version}`}</button>
                  )}
                </div>
              )}
              {showUpdateNotice && <button type="button" onClick={dismiss} className="w-full rounded-xl border border-white/15 px-4 py-3.5 text-sm font-semibold text-white/80 transition hover:bg-white/5">إخفاء حتى موعد الإلزام</button>}
              {hardBlock && <button type="button" onClick={() => void checkVersion()} className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 px-4 py-3.5 text-sm font-semibold text-white/85 transition hover:bg-white/5"><RefreshCw className="h-4 w-4" />إعادة التحقق</button>}
              {hardBlock && !policy?.download_url && <p className="text-center text-xs text-white/55">يجب توفير رابط تنزيل HTTPS للإصدار المنشور من إعدادات الإدارة.</p>}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
