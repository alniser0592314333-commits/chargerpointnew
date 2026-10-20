import React, { useState, useEffect, useRef } from 'react';
import { Clock, CheckCircle2, AlertCircle, Save, Sparkles, Power } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import {
  getBusinessHoursConfig,
  saveBusinessHoursConfigAndSync,
  refreshBusinessHoursConfigFromServer,
  computeOperationalStatus,
  BusinessHoursConfig,
} from '../../services/businessHoursService';

export const BusinessHoursSettingsCard: React.FC = () => {
  const { locale, isRTL } = useI18n();
  const isAr = locale === 'ar';

  const [config, setConfig] = useState<BusinessHoursConfig>(getBusinessHoursConfig);
  const [isActive, setIsActive] = useState<boolean>(config.isActive);
  const [todayOpenTime, setTodayOpenTime] = useState<string>(config.todayOpenTime || '08:00');
  const [todayCloseTime, setTodayCloseTime] = useState<string>(config.todayCloseTime || '22:00');
  const [tomorrowOpenTime, setTomorrowOpenTime] = useState<string>(config.tomorrowOpenTime || '08:00');
  const [tomorrowCloseTime, setTomorrowCloseTime] = useState<string>(config.tomorrowCloseTime || '22:00');

  const [savedSuccess, setSavedSuccess] = useState(false);
  const [savedError, setSavedError] = useState<string | null>(null);

  // Serialize toggle autosaves and form saves so older requests cannot overwrite newer settings.
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const hasUserEditedRef = useRef(false);

  const persistConfig = (updates: Partial<BusinessHoursConfig>) => {
    const task = saveQueueRef.current.then(async () => {
      const result = await saveBusinessHoursConfigAndSync(updates);
      setConfig(result.config);
      if (result.synced) {
        setSavedSuccess(true);
        setSavedError(null);
        window.setTimeout(() => setSavedSuccess(false), 3500);
      } else {
        setSavedSuccess(false);
        setSavedError(result.syncError || 'SYNC_FAILED');
      }
      return result;
    });
    saveQueueRef.current = task.then(() => undefined, () => undefined);
    return task;
  };

  const handleActiveToggle = (nextActive: boolean) => {
    hasUserEditedRef.current = true;
    setIsActive(nextActive);
    setSavedSuccess(false);
    setSavedError(null);
    // The public status toggle is an immediate shared setting, not a draft waiting for Save.
    void persistConfig({
      isActive: nextActive,
      todayOpenTime,
      todayCloseTime,
      tomorrowOpenTime,
      tomorrowCloseTime,
    }).catch(() => setSavedError('SYNC_FAILED'));
  };

  type HoursField = 'todayOpenTime' | 'todayCloseTime' | 'tomorrowOpenTime' | 'tomorrowCloseTime';

  const handleTimeChange = (field: HoursField, value: string) => {
    hasUserEditedRef.current = true;
    if (field === 'todayOpenTime') setTodayOpenTime(value);
    if (field === 'todayCloseTime') setTodayCloseTime(value);
    if (field === 'tomorrowOpenTime') setTomorrowOpenTime(value);
    if (field === 'tomorrowCloseTime') setTomorrowCloseTime(value);
    setSavedSuccess(false);
    setSavedError(null);
    // Every committed time-field change is shared immediately; the form button remains
    // available to explicitly re-save the complete configuration.
    void persistConfig({
      isActive,
      todayOpenTime: field === 'todayOpenTime' ? value : todayOpenTime,
      todayCloseTime: field === 'todayCloseTime' ? value : todayCloseTime,
      tomorrowOpenTime: field === 'tomorrowOpenTime' ? value : tomorrowOpenTime,
      tomorrowCloseTime: field === 'tomorrowCloseTime' ? value : tomorrowCloseTime,
    }).catch(() => setSavedError('SYNC_FAILED'));
  };

  useEffect(() => {
    let mounted = true;
    const applyConfig = (current: BusinessHoursConfig) => {
      if (!mounted || hasUserEditedRef.current) return;
      setConfig(current);
      setIsActive(current.isActive);
      setTodayOpenTime(current.todayOpenTime || '08:00');
      setTodayCloseTime(current.todayCloseTime || '22:00');
      setTomorrowOpenTime(current.tomorrowOpenTime || '08:00');
      setTomorrowCloseTime(current.tomorrowCloseTime || '22:00');
    };
    applyConfig(getBusinessHoursConfig());
    refreshBusinessHoursConfigFromServer().then(applyConfig).catch(() => {});
    return () => { mounted = false; };
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavedSuccess(false);
    setSavedError(null);
    try {
      await persistConfig({
        isActive,
        todayOpenTime,
        todayCloseTime,
        tomorrowOpenTime,
        tomorrowCloseTime,
      });
    } catch {
      setSavedError('SYNC_FAILED');
    }
  };

  const previewStatus = computeOperationalStatus({
    ...config,
    isActive,
    todayOpenTime,
    todayCloseTime,
    tomorrowOpenTime,
    tomorrowCloseTime,
  });

  return (
    <section className="pb-6 border-b border-gray-200/80 dark:border-[#123832] space-y-4">
      <div className="flex items-center justify-between">
        <div className="px-0.5 text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-[#8eb698]">
          {isAr ? 'حالة العمل وأوقات الدوام (الصفحة العامة)' : 'Operational Status & Working Hours'}
        </div>
        {/* Live indicator preview */}
        <div className="inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-semibold bg-gray-100 dark:bg-[#0c312b] border border-gray-200 dark:border-[#14423b]">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              previewStatus.isOpen
                ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]'
                : 'bg-rose-500 shadow-[0_0_8px_#f43f5e]'
            }`}
          />
          <span className="text-gray-700 dark:text-[#c4ded7]">
            {isAr ? previewStatus.headlineAr : previewStatus.headlineEn}
          </span>
        </div>
      </div>

      <form onSubmit={handleSave} className="rounded-2xl border border-gray-200/90 dark:border-[#1c4140] bg-white dark:bg-[#0a2423] p-5 shadow-2xs space-y-5">
        {/* Active Toggle */}
        <div className="flex items-center justify-between gap-4 p-3.5 rounded-xl bg-gray-50 dark:bg-[#071d1c] border border-gray-100 dark:border-[#143a38]">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${isActive ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300' : 'bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}>
              <Power className="w-5 h-5" />
            </div>
            <div>
              <span className="text-sm font-bold text-gray-900 dark:text-[#daf1de] block">
                {isAr ? 'تفعيل نشاط نقطة الشحن' : 'Charging Point Active Status'}
              </span>
              <span className="text-xs text-gray-500 dark:text-[#8eb698]">
                {isAr
                  ? 'عند التعطيل، تظهر النقطة باللون الأحمر (مغلق) بغض النظر عن ساعات العمل'
                  : 'When disabled, status displays red (closed) regardless of hours'}
              </span>
            </div>
          </div>

          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => handleActiveToggle(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-gray-300 peer-focus:outline-hidden rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-emerald-600"></div>
          </label>
        </div>

        {/* Today and Tomorrow Time Grids */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Today Hours */}
          <div className="p-4 rounded-xl border border-gray-200/80 dark:border-[#163f3c] bg-white dark:bg-[#0b2827] space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold text-emerald-700 dark:text-emerald-400">
              <Clock className="w-4 h-4" />
              <span>{isAr ? 'دوام اليوم الحالي' : "Today's Operating Hours"}</span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-gray-600 dark:text-[#8eb698] mb-1">
                  {isAr ? 'وقت الفتح' : 'Opening Time'}
                </label>
                <input
                  type="time"
                  value={todayOpenTime}
                  onChange={(e) => handleTimeChange('todayOpenTime', e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-gray-300 dark:border-[#1c4b48] bg-gray-50 dark:bg-[#081f1e] text-gray-900 dark:text-white focus:ring-2 focus:ring-emerald-500"
                  required
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-gray-600 dark:text-[#8eb698] mb-1">
                  {isAr ? 'وقت الإغلاق' : 'Closing Time'}
                </label>
                <input
                  type="time"
                  value={todayCloseTime}
                  onChange={(e) => handleTimeChange('todayCloseTime', e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-gray-300 dark:border-[#1c4b48] bg-gray-50 dark:bg-[#081f1e] text-gray-900 dark:text-white focus:ring-2 focus:ring-emerald-500"
                  required
                />
              </div>
            </div>
          </div>

          {/* Tomorrow Hours */}
          <div className="p-4 rounded-xl border border-gray-200/80 dark:border-[#163f3c] bg-white dark:bg-[#0b2827] space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold text-teal-700 dark:text-teal-400">
              <Sparkles className="w-4 h-4" />
              <span>{isAr ? 'دوام اليوم التالي (الغد)' : "Tomorrow's Operating Hours"}</span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-gray-600 dark:text-[#8eb698] mb-1">
                  {isAr ? 'وقت الفتح' : 'Opening Time'}
                </label>
                <input
                  type="time"
                  value={tomorrowOpenTime}
                  onChange={(e) => handleTimeChange('tomorrowOpenTime', e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-gray-300 dark:border-[#1c4b48] bg-gray-50 dark:bg-[#081f1e] text-gray-900 dark:text-white focus:ring-2 focus:ring-emerald-500"
                  required
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-gray-600 dark:text-[#8eb698] mb-1">
                  {isAr ? 'وقت الإغلاق' : 'Closing Time'}
                </label>
                <input
                  type="time"
                  value={tomorrowCloseTime}
                  onChange={(e) => handleTimeChange('tomorrowCloseTime', e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-gray-300 dark:border-[#1c4b48] bg-gray-50 dark:bg-[#081f1e] text-gray-900 dark:text-white focus:ring-2 focus:ring-emerald-500"
                  required
                />
              </div>
            </div>
          </div>
        </div>

        {/* Rollover notice */}
        <div className="text-[11px] text-gray-500 dark:text-[#8eb698] leading-relaxed bg-gray-50 dark:bg-[#071f1e] p-3 rounded-xl border border-gray-200/60 dark:border-[#123835]">
          {isAr
            ? 'ملاحظة: عند حلول منتصف الليل وبداية اليوم التالي، تنتقل أوقات "دوام الغد" تلقائياً لتصبح دوام "اليوم" بدون الحاجة لإعادة إدخالها يدوياً.'
            : 'Note: When the calendar day changes at midnight, tomorrow’s hours automatically roll over to become today’s operating hours.'}
        </div>

        {/* Submit & Feedback */}
        <div className="flex items-center justify-between pt-1">
          {savedSuccess ? (
            <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-semibold animate-fade-in">
              <CheckCircle2 className="w-4 h-4" />
              <span>{isAr ? 'تم حفظ الإعدادات ومزامنتها مع الصفحة العامة.' : 'Settings saved and synced to the public page.'}</span>
            </div>
          ) : savedError ? (
            <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300 font-semibold" role="status">
              <AlertCircle className="w-4 h-4" />
              <span>{isAr
                ? `حُفظت محليًا فقط؛ فشلت المزامنة (${savedError}). ${savedError === 'NO_TOKEN' || savedError === 'TOKEN_EXPIRED_NO_REFRESH' || savedError === 'AUTH_REFRESH_FAILED' ? 'أعد تسجيل الدخول ثم حاول مجددًا.' : savedError === 'HTTP_401' ? 'انتهت صلاحية الجلسة؛ أعد تسجيل الدخول.' : savedError === 'HTTP_403' ? 'الحساب لا يملك صلاحية تعديل الإعدادات.' : savedError === 'OFFLINE' ? 'تحقق من اتصال الإنترنت.' : savedError === 'NO_ENDPOINT' ? 'إعدادات اتصال الخادم غير متوفرة في هذه النسخة.' : savedError === 'NETWORK_ERROR' ? 'تعذر الاتصال بالخادم.' : 'تحقق من الاتصال والإعدادات ثم أعد الحفظ.'}`
                : `Saved locally only; sync failed (${savedError}). ${savedError === 'NO_TOKEN' || savedError === 'TOKEN_EXPIRED_NO_REFRESH' || savedError === 'AUTH_REFRESH_FAILED' ? 'Sign in again and retry.' : savedError === 'HTTP_401' ? 'Session expired; sign in again.' : savedError === 'HTTP_403' ? 'This account cannot manage settings.' : savedError === 'OFFLINE' ? 'Check your internet connection.' : savedError === 'NO_ENDPOINT' ? 'Server configuration is missing in this build.' : savedError === 'NETWORK_ERROR' ? 'Could not reach the server.' : 'Check the connection and retry.'}`}</span>
            </div>
          ) : <div />}

          <button
            type="submit"
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition-all hover:bg-emerald-700 cursor-pointer"
          >
            <Save className="w-4 h-4" />
            <span>{isAr ? 'حفظ إعدادات الدوام' : 'Save Hours Settings'}</span>
          </button>
        </div>
      </form>
    </section>
  );
};
