import React, { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, CheckCircle2, CloudUpload, FileArchive, History, LoaderCircle, RotateCcw, ShieldCheck, Smartphone, Users } from 'lucide-react';
import { getFreshSupabaseAuthToken } from '../../services/supabase/client';
import { defaultGraceDeadline, fetchAppReleasePolicy, formatLocalDateTimeInput, getAppDownloadEndpoint, parseAppVersion, type AppReleaseChannel, type AppReleasePolicy } from '../../services/appReleasePolicy';

type ReleaseFile = { url: string; pathname: string; version: string; size: number; uploadedAt: string };
const inputClass = 'w-full min-w-0 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15 dark:border-[#16433b] dark:bg-[#061f1c] dark:text-[#daf1de]';
const formatSize = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const formatDate = (value: string, locale: 'ar' | 'en') => new Intl.DateTimeFormat(locale === 'ar' ? 'ar-PS' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export const AppReleaseSettingsCard: React.FC<{ locale: 'ar' | 'en' }> = ({ locale }) => {
  const ar = locale === 'ar';
  const [channel, setChannel] = useState<AppReleaseChannel | null>(null);
  const [policy, setPolicy] = useState<AppReleasePolicy | null>(null);
  const [history, setHistory] = useState<ReleaseFile[]>([]);
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [graceUntil, setGraceUntil] = useState(defaultGraceDeadline());
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const authHeaders = useCallback(async () => {
    const result = await getFreshSupabaseAuthToken();
    if (!result.token) throw new Error(ar ? 'انتهت جلسة الدخول. سجّل الدخول مجددًا.' : 'Your session expired. Please sign in again.');
    return { Authorization: 'Bearer ' + result.token };
  }, [ar]);

  const load = useCallback(async (selected: AppReleaseChannel) => {
    setLoading(true); setError('');
    try {
      const [policyResult, headers] = await Promise.all([fetchAppReleasePolicy(selected), authHeaders()]);
      if (!policyResult.policy) throw new Error(policyResult.error || 'RELEASE_POLICY_UNAVAILABLE');
      setPolicy(policyResult.policy);
      setVersion(policyResult.policy.latest_version);
      setNotes(policyResult.policy.release_notes || '');
      setGraceUntil(formatLocalDateTimeInput(policyResult.policy.grace_until) || defaultGraceDeadline());
      const response = await fetch('/api/app-releases/history?channel=' + selected, { headers, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'RELEASE_HISTORY_UNAVAILABLE');
      setHistory(Array.isArray(data.releases) ? data.releases : []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [authHeaders]);

  useEffect(() => { if (channel) void load(channel); }, [channel, load]);

  const upload = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!channel || !file) return;
    setError(''); setMessage('');
    const parsed = parseAppVersion(version);
    if (!parsed) { setError(ar ? 'اكتب الإصدار بصيغة مثل 1.3.0.' : 'Enter a version such as 1.3.0.'); return; }
    if (file.size > 4 * 1024 * 1024 || !file.name.toLowerCase().endsWith('.apk')) { setError(ar ? 'اختر ملف APK لا يتجاوز 4 MB.' : 'Choose an APK file no larger than 4 MB.'); return; }
    if (Date.parse(graceUntil) <= Date.now()) { setError(ar ? 'موعد السماح يجب أن يكون في المستقبل.' : 'The grace deadline must be in the future.'); return; }
    if (policy && parsed.code <= Number(policy.version_code)) { setError(ar ? 'رقم الإصدار الجديد لازم يكون أعلى من المنشور حاليًا.' : 'The new version must be higher than the active version.'); return; }
    setSaving(true);
    try {
      const headers = await authHeaders();
      const response = await fetch('/api/app-releases/upload', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/vnd.android.package-archive',
          'X-Release-Channel': channel, 'X-Release-Version': version.trim(),
          'X-Release-Notes': encodeURIComponent(notes.slice(0, 1500)),
          'X-Release-Grace-Until': new Date(graceUntil).toISOString() },
        body: file,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'RELEASE_UPLOAD_FAILED');
      setFile(null);
      setMessage(ar ? 'تم رفع APK وتفعيل الإصدار بنجاح. رابط التنزيل الثابت صار يشير للنسخة الجديدة.' : 'APK uploaded and activated. The stable download URL now points to this release.');
      await load(channel);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  const restore = async (release: ReleaseFile) => {
    if (!channel) return;
    const prompt = ar ? `هل تريد استعادة الإصدار ${release.version} كتطبيق فعّال؟ لن نحذف أي إصدار آخر.` : `Restore version ${release.version} as active? No other release will be deleted.`;
    if (!window.confirm(prompt)) return;
    setError(''); setMessage(''); setSaving(true);
    try {
      const headers = await authHeaders();
      const response = await fetch('/api/app-releases/restore', {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, url: release.url }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'RELEASE_RESTORE_FAILED');
      setMessage(ar ? `تمت استعادة الإصدار ${release.version} بنجاح.` : `Version ${release.version} restored successfully.`);
      await load(channel);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  const title = channel === 'customer' ? (ar ? 'تطبيق العميل' : 'Customer App') : (ar ? 'تطبيق الأدمن' : 'Admin App');
  const currentRelease = history.find((item) => item.version === policy?.latest_version);

  return <section className="space-y-4">
    {!channel ? <>
      <div className="flex items-start gap-3 border-b border-gray-200/80 pb-4 dark:border-[#123832]">
        <ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-700 dark:text-[#a5d6b4]" />
        <div><h3 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">{ar ? 'إدارة إصدارات التطبيقات' : 'App Release Management'}</h3>
          <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-[#8eb698]">{ar ? 'ارفع ملفات APK الموقّعة، راجع سجل كل تطبيق، واستعد أي إصدار سابق دون حذف الملفات.' : 'Upload signed APKs, review each app history, and restore older releases without deleting files.'}</p></div>
      </div>
      <div className="divide-y divide-gray-200/80 dark:divide-[#123832]">
        <button type="button" onClick={() => setChannel('customer')} className="flex w-full items-center gap-3 py-4 text-start group">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 dark:bg-[#0d352d] dark:text-[#a5d6b4]"><Users className="h-5 w-5" /></span>
          <span className="min-w-0 flex-1"><span className="block text-sm font-bold text-gray-900 dark:text-[#daf1de]">{ar ? 'تطبيق العميل' : 'Customer App'}</span><span className="mt-1 block text-xs text-gray-500 dark:text-[#8eb698]">{ar ? 'إصدارات التطبيق العام وروابط تنزيل العملاء' : 'Public customer app releases and download links'}</span></span><ArrowLeft className="h-4 w-4 text-gray-400 group-hover:text-emerald-600" />
        </button>
        <button type="button" onClick={() => setChannel('admin')} className="flex w-full items-center gap-3 py-4 text-start group">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 dark:bg-[#0d352d] dark:text-[#a5d6b4]"><Smartphone className="h-5 w-5" /></span>
          <span className="min-w-0 flex-1"><span className="block text-sm font-bold text-gray-900 dark:text-[#daf1de]">{ar ? 'تطبيق الأدمن' : 'Admin App'}</span><span className="mt-1 block text-xs text-gray-500 dark:text-[#8eb698]">{ar ? 'إصدارات لوحة الإدارة وروابط تنزيل المشرفين' : 'Admin app releases and administrator download links'}</span></span><ArrowLeft className="h-4 w-4 text-gray-400 group-hover:text-emerald-600" />
        </button>
      </div>
    </> : <>
      <button type="button" onClick={() => { setChannel(null); setError(''); setMessage(''); }} className="inline-flex items-center gap-2 text-xs font-semibold text-emerald-700 dark:text-[#a5d6b4]"><ArrowLeft className="h-4 w-4" />{ar ? 'العودة إلى التطبيقات' : 'Back to apps'}</button>
      <div className="flex items-center gap-3 border-b border-gray-200/80 pb-4 dark:border-[#123832]">
        <FileArchive className="h-5 w-5 text-emerald-700 dark:text-[#a5d6b4]" />
        <div><h3 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">{title}</h3><p className="mt-1 text-xs text-gray-500 dark:text-[#8eb698]">{ar ? 'الإصدار الحالي وسجل النسخ السابقة' : 'Active release and previous versions'}</p></div>
      </div>
      {loading ? <div className="flex items-center gap-2 py-6 text-sm text-gray-500"><LoaderCircle className="h-4 w-4 animate-spin" />{ar ? 'جارٍ تحميل سجل الإصدارات…' : 'Loading release history…'}</div> : <>
        <div className="rounded-xl bg-gray-50 p-3 dark:bg-[#041714]">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-gray-500 dark:text-[#8eb698]">{ar ? 'الإصدار الفعّال حاليًا' : 'Currently active version'}</span><span className="font-mono text-sm font-bold text-gray-900 dark:text-[#daf1de]">{policy?.latest_version || '—'}</span></div>
          {currentRelease && <p className="mt-2 text-[11px] text-gray-500 dark:text-[#8eb698]">{formatSize(currentRelease.size)} · {formatDate(currentRelease.uploadedAt, locale)}</p>}
          <a href={getAppDownloadEndpoint(channel)} className="mt-3 inline-flex items-center gap-2 text-xs font-semibold text-emerald-700 underline dark:text-[#a5d6b4]" target="_blank" rel="noreferrer"><ArrowDownToLine className="h-3.5 w-3.5" />{ar ? 'اختبار رابط التنزيل الثابت' : 'Test stable download URL'}</a>
        </div>
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] leading-5 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">{ar ? 'سجل الإصدارات والتنزيل يعملان من GitHub. لرفع APK جديد، يلزم إعداد مفتاح GitHub آمن مرة واحدة في Vercel باسم GITHUB_RELEASES_TOKEN؛ المفتاح لا يظهر داخل التطبيق.' : 'Release history and downloads use GitHub. Uploading a new APK requires a one-time server-side GitHub token in Vercel named GITHUB_RELEASES_TOKEN; it is never exposed in the app.'}</p>
        <form onSubmit={upload} className="space-y-3 border-b border-gray-200/80 pb-5 dark:border-[#123832]">
          <div className="flex items-center gap-2"><CloudUpload className="h-4 w-4 text-emerald-700 dark:text-[#a5d6b4]" /><h4 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">{ar ? 'رفع إصدار جديد' : 'Upload new release'}</h4></div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1"><span className="block text-xs font-semibold text-gray-700 dark:text-[#b3d5bd]">{ar ? 'رقم الإصدار' : 'Version'}</span><input className={inputClass} value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.3.0" required /></label>
            <label className="space-y-1"><span className="block text-xs font-semibold text-gray-700 dark:text-[#b3d5bd]">{ar ? 'موعد انتهاء السماح للإصدار السابق' : 'Old-version grace deadline'}</span><input className={inputClass} type="datetime-local" value={graceUntil} onChange={(e) => setGraceUntil(e.target.value)} required /></label>
          </div>
          <label className="block space-y-1"><span className="block text-xs font-semibold text-gray-700 dark:text-[#b3d5bd]">{ar ? 'ملف APK الموقّع' : 'Signed APK file'}</span><input className={inputClass} type="file" accept=".apk,application/vnd.android.package-archive" onChange={(e) => setFile(e.target.files?.[0] || null)} required /><span className="block text-[11px] text-gray-500 dark:text-[#8eb698]">{file ? `${file.name} · ${formatSize(file.size)}` : (ar ? 'الحد الأقصى 4 MB. ارفع النسخة الموقعة الجاهزة من GitHub Actions.' : 'Maximum 4 MB. Upload the signed APK built by GitHub Actions.')}</span></label>
          <label className="block space-y-1"><span className="block text-xs font-semibold text-gray-700 dark:text-[#b3d5bd]">{ar ? 'ملاحظات الإصدار' : 'Release notes'}</span><textarea className={inputClass} rows={3} maxLength={1500} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          <button type="submit" disabled={saving || !file} className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-3 text-sm font-bold text-white hover:bg-emerald-800 disabled:opacity-50"><CloudUpload className="h-4 w-4" />{saving ? (ar ? 'جارٍ الرفع والتفعيل…' : 'Uploading and activating…') : (ar ? 'رفع وتفعيل الإصدار' : 'Upload and activate release')}</button>
        </form>
        <div className="space-y-3">
          <div className="flex items-center gap-2"><History className="h-4 w-4 text-gray-500" /><h4 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">{ar ? 'سجل الإصدارات' : 'Release history'}</h4><span className="text-[11px] text-gray-500">({history.length})</span></div>
          {history.length === 0 ? <p className="rounded-xl bg-gray-50 p-4 text-xs leading-5 text-gray-500 dark:bg-[#041714] dark:text-[#8eb698]">{ar ? 'لا توجد إصدارات لهذا التطبيق في GitHub Releases حتى الآن.' : 'No releases found for this app channel yet. Existing GitHub releases are shown here when they contain a matching APK asset.'}</p> : history.map((release) => {
            const active = release.version === policy?.latest_version;
            return <div key={release.url} className="flex flex-wrap items-center gap-3 border-b border-gray-100 py-3 last:border-0 dark:border-[#0f302b]">
              <FileArchive className="h-4 w-4 text-gray-500" />
              <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-sm font-bold text-gray-900 dark:text-[#daf1de]">{release.version}</span>{active && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">{ar ? 'فعّال' : 'Active'}</span>}</div><p className="mt-1 text-[11px] text-gray-500 dark:text-[#8eb698]">{formatSize(release.size)} · {formatDate(release.uploadedAt, locale)}</p></div>
              <a href={release.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 underline dark:text-[#a5d6b4]"><ArrowDownToLine className="h-3.5 w-3.5" />{ar ? 'تنزيل' : 'Download'}</a>
              {!active && <button type="button" disabled={saving} onClick={() => void restore(release)} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-2 text-xs font-semibold text-gray-700 disabled:opacity-50 dark:border-[#16433b] dark:text-[#daf1de]"><RotateCcw className="h-3.5 w-3.5" />{ar ? 'استعادة' : 'Restore'}</button>}
            </div>;
          })}
        </div>
      </>}
    </>}
    {error && <p role="alert" className="break-words rounded-xl bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">{error}</p>}
    {message && <p role="status" className="flex items-start gap-2 rounded-xl bg-emerald-50 p-3 text-xs leading-5 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{message}</p>}
  </section>;
};
