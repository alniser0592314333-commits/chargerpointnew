import React, { FormEvent, useEffect, useState } from 'react';

type Props = { children: React.ReactNode };

/**
 * Fail-closed development access gate for the public assistance-services area.
 * Authorization is verified by the server-signed HttpOnly cookie; client state
 * is only a rendering convenience and never grants access by itself.
 */
export const PublicServicesAccessGate: React.FC<Props> = ({ children }) => {
  const [authorized, setAuthorized] = useState(false);
  const [checking, setChecking] = useState(true);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    fetch('/api/dev-access', { method: 'GET', credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('gate-unavailable');
        const result = await response.json();
        if (active) setAuthorized(result?.ok === true);
      })
      .catch(() => {
        if (active) setError('تعذر التحقق من صلاحية الدخول. حاول مرة ثانية لاحقاً.');
      })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim() || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/dev-access', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result?.ok !== true) {
        setError(response.status === 401 ? 'كود التطوير غير صحيح.' : 'تعذر التحقق من الكود. حاول لاحقاً.');
        return;
      }
      setAuthorized(true);
      setCode('');
    } catch {
      setError('تعذر الاتصال بخدمة التحقق. تأكد من الإنترنت وحاول مرة ثانية.');
    } finally {
      setSubmitting(false);
    }
  };

  if (authorized) return <>{children}</>;

  return (
    <main dir="rtl" className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 text-slate-800 dark:bg-slate-950 dark:text-slate-100">
      <section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900 sm:p-8">
        <div className="mb-5 grid h-12 w-12 place-items-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M10.3 3.9 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3l-7.5-13.1a2 2 0 0 0-3.4 0Z" /></svg>
        </div>
        <p className="mb-2 text-xs font-bold tracking-widest text-slate-500">CHARGING POINT</p>
        <h1 className="mb-2 text-2xl font-extrabold">خدمات مساعدة — قيد التطوير</h1>
        <p className="mb-6 text-sm leading-7 text-slate-600 dark:text-slate-300">هذا القسم غير متاح حالياً للعملاء. أدخل كود التطوير المصرّح به للمتابعة.</p>
        <form onSubmit={submit} className="space-y-3">
          <label htmlFor="public-services-dev-code" className="block text-sm font-bold">كود التطوير</label>
          <input
            id="public-services-dev-code"
            type="password"
            autoComplete="current-password"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={checking || submitting}
            className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-left outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950"
            placeholder="أدخل الكود"
          />
          {error && <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">{error}</p>}
          <button type="submit" disabled={checking || submitting || !code.trim()} className="w-full rounded-xl bg-blue-600 px-4 py-3 font-bold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
            {checking ? 'جارٍ التحقق...' : submitting ? 'جارٍ التحقق من الكود...' : 'دخول'}
          </button>
        </form>
      </section>
    </main>
  );
};

export default PublicServicesAccessGate;
