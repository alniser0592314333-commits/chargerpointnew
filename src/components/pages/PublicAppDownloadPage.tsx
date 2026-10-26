import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Clock3, Download, Gauge, HardDrive, Home, MoonStar, RefreshCw, ShieldCheck, Wifi, XCircle } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { fetchAppReleasePolicy, type AppReleasePolicy } from '../../services/appReleasePolicy';
import './public-app-download.css';

type DownloadState = 'idle' | 'loading-policy' | 'downloading' | 'complete' | 'error';

const formatBytes = (value: number, locale: string) => {
  if (!Number.isFinite(value) || value < 0) return locale === 'ar' ? 'جارٍ الحساب' : 'Calculating';
  if (value < 1024) return value + ' B';
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return size.toLocaleString(locale === 'ar' ? 'ar' : 'en', { maximumFractionDigits: size >= 100 ? 0 : 1 }) + ' ' + units[unit];
};

const formatTime = (seconds: number, ar: boolean) => {
  if (!Number.isFinite(seconds) || seconds < 0) return ar ? 'جارٍ الحساب' : 'Calculating';
  if (seconds < 1) return ar ? 'أقل من ثانية' : 'Less than a second';
  const s = Math.ceil(seconds);
  if (s < 60) return ar ? `${s} ث` : `${s} sec`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return ar ? `${m} د ${rem} ث` : `${m}m ${rem}s`;
};

export const PublicAppDownloadPage: React.FC = () => {
  const { locale, setLocale } = useI18n();
  const ar = locale === 'ar';
  const [policy, setPolicy] = useState<AppReleasePolicy | null>(null);
  const [state, setState] = useState<DownloadState>('loading-policy');
  const [error, setError] = useState('');
  const [received, setReceived] = useState(0);
  const [total, setTotal] = useState(-1);
  const [speed, setSpeed] = useState(0);
  const [directFallback, setDirectFallback] = useState(false);
  const previousRef = useRef<{ bytes: number; at: number }>({ bytes: 0, at: 0 });
  const abortRef = useRef<AbortController | null>(null);
  const [downloadUrl, setDownloadUrl] = useState('');

  const loadPolicy = useCallback(async () => {
    setState('loading-policy');
    setError('');
    setDirectFallback(false);
    const result = await fetchAppReleasePolicy('customer');
    if (!result.policy) {
      setPolicy(null);
      setState('error');
      setError(ar
        ? 'تعذر جلب رابط النسخة الرسمية. حاول مرة أخرى بعد التأكد من اتصال الإنترنت.'
        : 'Could not load the official release link. Check your internet connection and try again.');
      return;
    }
    setPolicy(result.policy);
    setDownloadUrl(result.policy.download_url?.trim() || '');
    if (!result.policy.download_url?.trim()) {
      setState('error');
      setError(ar ? 'رابط تنزيل التطبيق غير مضاف في إعدادات الإدارة.' : 'The app download URL has not been set in Admin Settings.');
      return;
    }
    try {
      const url = new URL(result.policy.download_url);
      if (url.protocol !== 'https:') throw new Error('HTTPS required');
      setState('idle');
    } catch {
      setState('error');
      setError(ar ? 'رابط التنزيل غير صالح. يجب أن يبدأ بـ HTTPS.' : 'The download URL is invalid. It must use HTTPS.');
    }
  }, [ar]);

  useEffect(() => {
    void loadPolicy();
    return () => { abortRef.current?.abort(); };
  }, [loadPolicy]);

  const startDownload = async () => {
    if (!downloadUrl) { await loadPolicy(); return; }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError('');
    setReceived(0);
    setTotal(-1);
    setSpeed(0);
    previousRef.current = { bytes: 0, at: Date.now() };
    setState('downloading');
    try {
      const response = await fetch(downloadUrl, { method: 'GET', mode: 'cors', signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP_' + response.status);
      const headerLength = Number(response.headers.get('content-length') || 0);
      const expected = Number.isFinite(headerLength) && headerLength > 0 ? headerLength : -1;
      setTotal(expected);
      let blob: Blob;
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let loaded = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          chunks.push(value);
          loaded += value.byteLength;
          setReceived(loaded);
          const now = Date.now();
          const previous = previousRef.current;
          if (now > previous.at) {
            const instant = ((loaded - previous.bytes) * 1000) / (now - previous.at);
            setSpeed(Number.isFinite(instant) && instant > 0 ? instant : 0);
            previousRef.current = { bytes: loaded, at: now };
          }
        }
        blob = new Blob(chunks, { type: response.headers.get('content-type') || 'application/vnd.android.package-archive' });
      } else {
        blob = await response.blob();
        setReceived(blob.size);
      }
      if (!blob.size) throw new Error('EMPTY_FILE');
      setTotal(blob.size);
      setReceived(blob.size);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `ChargerPoint-customer-v${policy?.latest_version || 'latest'}.apk`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      setSpeed(0);
      setState('complete');
    } catch (err) {
      if (controller.signal.aborted) return;
      // Cross-origin APK hosts may deliberately disallow JavaScript streaming. Keep the
      // configured release URL as a working direct-download fallback instead of blocking users.
      setDirectFallback(true);
      setState('error');
      setError(ar
        ? 'تعذر عرض تقدم التنزيل من مصدر الملف. يمكنك متابعة التنزيل مباشرة من الرابط الرسمي أدناه.'
        : 'The file host does not allow in-page progress tracking. You can still download directly from the official link below.');
    }
  };

  const percent = total > 0 ? Math.max(0, Math.min(100, Math.floor(received / total * 100))) : 0;
  const eta = speed > 0 && total > received ? (total - received) / speed : -1;
  const back = ar ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />;

  return (
    <main className="cp-download-page" dir={ar ? 'rtl' : 'ltr'}>
      <div className="cp-download-stars" aria-hidden="true" />
      <div className="cp-download-moon" aria-hidden="true"><span /></div>
      <div className="cp-download-ridge cp-download-ridge-back" aria-hidden="true" />
      <div className="cp-download-ridge cp-download-ridge-front" aria-hidden="true" />
      <header className="cp-download-header">
        <a className="cp-download-brand" href="/" aria-label={ar ? 'العودة للصفحة الرئيسية' : 'Back to home'}>
          <span className="cp-download-brand-mark"><MoonStar className="h-5 w-5" /></span>
          <span><strong>{ar ? 'نقطة الشحن' : 'Charging Point'}</strong><small>CHARGERPOINT.NU</small></span>
        </a>
        <button className="cp-download-language" onClick={() => setLocale(ar ? 'en' : 'ar')} type="button">
          {ar ? 'English' : 'العربية'}
        </button>
      </header>

      <section className="cp-download-content">
        <div className="cp-download-eyebrow"><ShieldCheck className="h-4 w-4" />{ar ? 'الإصدار الرسمي' : 'OFFICIAL RELEASE'}</div>
        <div className="cp-download-app-icon"><Download className="h-8 w-8" /><span /></div>
        <h1>{ar ? 'تطبيقك، جاهز للطريق' : 'Your app. Ready to go.'}</h1>
        <p className="cp-download-subtitle">
          {ar ? 'نزّل تطبيق نقطة الشحن الرسمي بأمان، وتابع كل خطوة حتى يكتمل التنزيل.' : 'Get the official Charging Point app and follow every step until your download is complete.'}
        </p>
        <div className="cp-download-version">
          <span>{ar ? 'نسخة العميل' : 'CUSTOMER APP'}</span>
          <strong>{policy?.latest_version ? `v${policy.latest_version}` : (ar ? 'جارٍ التحقق…' : 'Checking…')}</strong>
          <span className="cp-download-release-dot" />
        </div>

        <div className="cp-download-panel">
          <div className="cp-download-panel-title">
            <div><span className="cp-download-panel-icon"><HardDrive className="h-4 w-4" /></span><strong>{ar ? 'حالة التنزيل' : 'Download status'}</strong></div>
            {state === 'complete' ? <span className="cp-download-status is-complete"><CheckCircle2 className="h-3.5 w-3.5" />{ar ? 'اكتمل' : 'Complete'}</span>
              : state === 'downloading' ? <span className="cp-download-status"><span className="cp-download-pulse" />{ar ? 'جارٍ التنزيل' : 'Downloading'}</span>
              : state === 'loading-policy' ? <span className="cp-download-status">{ar ? 'جارٍ التحقق' : 'Checking'}</span>
              : null}
          </div>

          <div className="cp-download-progress-track" role="progressbar" aria-label={ar ? 'تقدم التنزيل' : 'Download progress'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={state === 'complete' ? 100 : percent}>
            <span className={state === 'complete' ? 'is-complete' : ''} style={{ width: state === 'complete' ? '100%' : `${percent}%` }} />
          </div>
          <div className="cp-download-percent-row">
            <strong>{state === 'complete' ? '100%' : state === 'downloading' && total < 0 ? formatBytes(received, locale) : `${percent}%`}</strong>
            <span>{total > 0 ? `${formatBytes(received, locale)} / ${formatBytes(total, locale)}` : `${formatBytes(received, locale)} / ${ar ? 'الحجم الإجمالي قيد التحديد' : 'total size pending'}`}</span>
          </div>

          <div className="cp-download-stats">
            <div><Gauge className="h-4 w-4" /><span>{ar ? 'سرعة التنزيل' : 'Download speed'}<strong>{state === 'downloading' ? `${formatBytes(speed, locale)}/s` : state === 'complete' ? (ar ? 'مكتمل' : 'Finished') : '—'}</strong></span></div>
            <div><Clock3 className="h-4 w-4" /><span>{ar ? 'الوقت المتبقي' : 'Time remaining'}<strong>{state === 'complete' ? (ar ? 'تمّ بنجاح' : 'Done') : state === 'downloading' ? formatTime(eta, ar) : '—'}</strong></span></div>
            <div><HardDrive className="h-4 w-4" /><span>{ar ? 'حجم الملف' : 'File size'}<strong>{total > 0 ? formatBytes(total, locale) : '—'}</strong></span></div>
          </div>

          {error && <div className="cp-download-error" role="alert"><XCircle className="h-4 w-4 shrink-0" /><p>{error}</p></div>}
          {state === 'complete' ? (
            <div className="cp-download-complete"><CheckCircle2 className="h-5 w-5" /><div><strong>{ar ? 'تم بدء حفظ ملف التطبيق' : 'App file saved to your downloads'}</strong><p>{ar ? 'افتح إشعار التنزيل أو مجلد التنزيلات، ثم اضغط ملف APK واختر تثبيت.' : 'Open the download notification or Downloads folder, tap the APK, then choose Install.'}</p></div></div>
          ) : state === 'downloading' ? (
            <button className="cp-download-primary" type="button" disabled><Download className="h-4 w-4 animate-pulse" />{ar ? 'جارٍ تنزيل التطبيق…' : 'Downloading app…'}</button>
          ) : (
            <button className="cp-download-primary" type="button" onClick={() => void startDownload()} disabled={state === 'loading-policy'}>
              {state === 'error' ? <RefreshCw className="h-4 w-4" /> : <Download className="h-4 w-4" />}
              {state === 'error' ? (ar ? 'إعادة المحاولة' : 'Try again') : (ar ? 'تنزيل التطبيق الآن' : 'Download app now')}
            </button>
          )}
          {directFallback && downloadUrl && <a className="cp-download-direct" href={downloadUrl} target="_blank" rel="noopener noreferrer"><Download className="h-4 w-4" />{ar ? 'التنزيل المباشر من الرابط الرسمي' : 'Download directly from official link'}</a>}
          {policy?.release_notes?.trim() && <p className="cp-download-notes">{policy.release_notes}</p>}
        </div>

        <div className="cp-download-security"><ShieldCheck className="h-4 w-4" /><span>{ar ? 'يُستخدم رابط الإصدار الذي حدده المسؤول، ولا يوجد رابط تنزيل منفصل أو ثابت داخل الصفحة.' : 'This page uses the release URL configured by Admin; no separate hard-coded download link.'}</span></div>
        <a className="cp-download-back" href="/">{back}{ar ? 'العودة إلى الموقع' : 'Back to website'}</a>
      </section>
      <footer className="cp-download-footer"><span>© {new Date().getFullYear()} {ar ? 'نقطة الشحن' : 'Charging Point'}</span><span><Wifi className="h-3.5 w-3.5" />{ar ? 'تنزيل رسمي وآمن' : 'Official secure download'}</span></footer>
    </main>
  );
};
