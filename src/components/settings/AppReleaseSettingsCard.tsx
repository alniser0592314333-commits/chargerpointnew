import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CloudUpload, Download, LoaderCircle, ShieldCheck } from 'lucide-react';
import { authService } from '../../services/auth/authService';
import {
  defaultGraceDeadline,
  fetchAppReleasePolicy,
  formatLocalDateTimeInput,
  parseAppVersion,
  publishAppReleasePolicy,
  type AppReleaseChannel,
  type AppReleasePolicy,
} from '../../services/appReleasePolicy';

const inputClass = 'w-full min-w-0 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15 dark:border-[#16433b] dark:bg-[#061f1c] dark:text-[#daf1de]';

export const AppReleaseSettingsCard: React.FC<{ locale: 'ar' | 'en' }> = ({ locale }) => {
  const ar = locale === 'ar';
  const [channel, setChannel] = useState<AppReleaseChannel>('customer');
  const [policy, setPolicy] = useState<AppReleasePolicy | null>(null);
  const [version, setVersion] = useState('1.0.0');
  const [notes, setNotes] = useState('');
  const [url, setUrl] = useState('');
  const [graceUntil, setGraceUntil] = useState(defaultGraceDeadline());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = async (selected: AppReleaseChannel) => {
    setLoading(true);
    setError('');
    const result = await fetchAppReleasePolicy(selected);
    if (result.policy) {
      setPolicy(result.policy);
      setVersion(result.policy.latest_version);
      setNotes(result.policy.release_notes || '');
      setUrl(result.policy.download_url || '');
      setGraceUntil(formatLocalDateTimeInput(result.policy.grace_until));
    } else {
      setPolicy(null);
      setError(ar ? 'تعذر قراءة سياسة الإصدارات من الخادم.' : 'Could not load the release policy from the server.');
    }
    setLoading(false);
  };

  useEffect(() => { void load(channel); }, [channel]);

  const handleVersionChange = (next: string) => {
    if (next !== version && next !== policy?.latest_version) setGraceUntil(defaultGraceDeadline());
    setVersion(next);
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage('');
    setError('');
    const parsed = parseAppVersion(version);
    if (!parsed) {
      setError(ar ? 'استخدم صيغة الإصدار مثل 1.0.1.' : 'Use a version such as 1.0.1.');
      return;
    }
    if (policy && version !== policy.latest_version && parsed.code <= Number(policy.version_code)) {
      setError(ar ? 'الإصدار الجديد يجب أن يكون أعلى من الإصدار المنشور حاليًا.' : 'A new release must be higher than the currently published version.');
      return;
    }
    if (!url.trim()) {
      setError(ar ? 'أضف رابط تنزيل APK HTTPS قبل نشر الإصدار.' : 'Add an HTTPS APK download URL before publishing.');
      return;
    }
    if (Date.parse(graceUntil) <= Date.now()) {
      setError(ar ? 'موعد السماح يجب أن يكون في المستقبل.' : 'The grace deadline must be in the future.');
      return;
    }
    setSaving(true);
    try {
      const session = await authService.getCurrentSession(true);
      if (session?.role !== 'SUPER_ADMIN') {
        setError(ar ? 'نشر الإصدارات متاح للمشرف الأعلى فقط.' : 'Only the Super Admin can publish app releases.');
        return;
      }
      const result = await publishAppReleasePolicy({
        channel,
        latest_version: version.trim(),
        version_code: parsed.code,
        release_notes: notes.trim(),
        download_url: url.trim(),
        grace_until: new Date(graceUntil).toISOString(),
      });
      if (!result.success) {
        setError(result.error || (ar ? 'فشل نشر الإصدار.' : 'Failed to publish the release.'));
        return;
      }
      setMessage(ar ? 'تم نشر سياسة الإصدار على الخادم بنجاح.' : 'Release policy published to the server.');
      await load(channel);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4 rounded-2xl border border-emerald-200 bg-white p-4 shadow-sm dark:border-[#16433b] dark:bg-[#071f1b] sm:p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 dark:bg-[#0d352d] dark:text-[#a5d6b4]"><ShieldCheck className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">{ar ? 'إدارة إصدارات APK' : 'APK Release Management'}</h3>
          <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-[#8eb698]">{ar ? 'لا يتغير الإصدار المنشور تلقائيًا مع تعديلات الكود. انشره هنا فقط بعد تجهيز APK ورفع رابط تنزيله.' : 'Code changes do not automatically change the published version. Publish here only after the APK is built and uploaded.'}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {([{ value: 'customer', label: ar ? 'تطبيق نقطة الشحن' : 'Customer app' }, { value: 'admin', label: ar ? 'تطبيق الإدارة' : 'Admin app' }] as const).map((item) => (
          <button key={item.value} type="button" onClick={() => setChannel(item.value)} className={`rounded-xl border px-3 py-2.5 text-xs font-semibold transition-colors ${channel === item.value ? 'border-emerald-600 bg-emerald-50 text-emerald-800 dark:border-emerald-500 dark:bg-[#0d352d] dark:text-[#daf1de]' : 'border-gray-200 text-gray-600 dark:border-[#16433b] dark:text-[#8eb698]'}`}>{item.label}</button>
        ))}
      </div>

      {loading ? <div className="flex items-center gap-2 py-5 text-sm text-gray-500"><LoaderCircle className="h-4 w-4 animate-spin" />{ar ? 'جارٍ تحميل الإصدار من الخادم…' : 'Loading release policy…'}</div> : (
        <form onSubmit={handleSave} className="space-y-4">
          {policy && <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-gray-50 px-3 py-2.5 dark:bg-[#041714]">
            <span className="text-xs text-gray-600 dark:text-[#8eb698]">{ar ? 'الإصدار المنشور حاليًا' : 'Currently published version'}</span>
            <span className="font-mono text-sm font-bold text-gray-900 dark:text-[#daf1de]">{policy.latest_version}</span>
          </div>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1.5"><span className="block text-xs font-semibold text-gray-700 dark:text-[#b3d5bd]">{ar ? 'الإصدار الجديد (X.Y.Z)' : 'New version (X.Y.Z)'}</span><input className={inputClass} value={version} onChange={(e) => handleVersionChange(e.target.value)} placeholder="1.0.1" inputMode="decimal" required /></label>
            <label className="space-y-1.5"><span className="block text-xs font-semibold text-gray-700 dark:text-[#b3d5bd]">{ar ? 'آخر موعد للسماح بالإصدار السابق' : 'Old-version deadline'}</span><input className={inputClass} type="datetime-local" value={graceUntil} onChange={(e) => setGraceUntil(e.target.value)} required /></label>
          </div>
          <label className="block space-y-1.5"><span className="block text-xs font-semibold text-gray-700 dark:text-[#b3d5bd]">{ar ? 'رابط تنزيل APK (HTTPS)' : 'APK download URL (HTTPS)'}</span><input className={inputClass} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" required /></label>
          <label className="block space-y-1.5"><span className="block text-xs font-semibold text-gray-700 dark:text-[#b3d5bd]">{ar ? 'ملاحظات الإصدار التي تظهر للعميل' : 'Release notes shown to customers'}</span><textarea className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={1500} placeholder={ar ? 'أهم التحسينات والإصلاحات…' : 'Main improvements and fixes…'} /></label>
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{ar ? 'بعد انتهاء الموعد، ستُمنع النسخة الأقدم من الدخول عند اتصالها بالخادم، وتبقى مقفلة دون إنترنت إذا كانت قد حفظت هذه السياسة سابقًا.' : 'After the deadline, older builds are blocked when they reach the server; a previously cached policy also keeps them blocked offline.'}</span></div>
          {error && <p role="alert" className="break-words rounded-xl bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">{error}</p>}
          {message && <p role="status" className="flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-xs text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"><CheckCircle2 className="h-4 w-4 shrink-0" />{message}</p>}
          <button type="submit" disabled={saving || loading} className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-3 text-sm font-bold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"><CloudUpload className="h-4 w-4" />{saving ? (ar ? 'جارٍ النشر…' : 'Publishing…') : (ar ? 'نشر الإصدار على الخادم' : 'Publish release to server')}</button>
          {policy?.download_url && <a href={policy.download_url} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 text-xs font-semibold text-emerald-700 underline dark:text-[#a5d6b4]"><Download className="h-3.5 w-3.5" />{ar ? 'فتح رابط APK المنشور' : 'Open published APK URL'}</a>}
        </form>
      )}
    </section>
  );
};
