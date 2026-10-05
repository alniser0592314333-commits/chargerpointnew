import React, { useState, useEffect } from 'react';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Plus, ChevronLeft, ChevronRight, AlertCircle } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { getDaysList, createNewBusinessDay, UIDaySummary, useStoreSubscription } from './dayOrdersStore';

export interface DaysOrdersPageProps {
  onSelectDay?: (dayId: string) => void;
}

export const DaysOrdersPage: React.FC<DaysOrdersPageProps> = ({ onSelectDay }) => {
  const { isRTL, t, formatDate, formatWeekday, formatCurrency } = useI18n();
  const storeVersion = useStoreSubscription(['businessDays', 'orders']);
  const [days, setDays] = useState<UIDaySummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [createMode, setCreateMode] = useState<'today' | 'custom' | null>(null);
  const [customDate, setCustomDate] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const loadDays = async () => {
    setIsLoading(true);
    try {
      const list = await getDaysList();
      setDays(list);
    } catch (err: any) {
      console.error('Failed to load days list:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadDays();
  }, [storeVersion]);

  const sortedDays = [...days].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  // Helper to get today's YYYY-MM-DD
  const getTodayDateString = () => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  const handleCreateDaySubmit = async (targetDate: string) => {
    setErrorMessage('');
    if (!targetDate) return;

    const res = await createNewBusinessDay(targetDate);
    if (!res.success) {
      setErrorMessage(res.error || t('dayAlreadyExists'));
      return;
    }

    setIsCreateModalOpen(false);
    setCreateMode(null);
    setCustomDate('');
    setErrorMessage('');

    await loadDays();

    if (onSelectDay && res.dayId) {
      onSelectDay(res.dayId);
    }
  };

  return (
    <div className="max-w-3xl mx-auto py-6 px-4 sm:px-6 space-y-6 text-gray-900 dark:text-[#daf1de]">
      {/* Page Header */}
      <div className="flex items-center justify-between pb-4 border-b border-gray-200 dark:border-[#14423b]">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-[#daf1de]">
          {t('daysTitle')}
        </h1>
        <Button
          variant="primary"
          size="md"
          onClick={() => {
            setErrorMessage('');
            setIsCreateModalOpen(true);
          }}
          className="gap-2"
        >
          <Plus className="w-4 h-4" />
          <span>{t('createDay')}</span>
        </Button>
      </div>

      {/* Days List */}
      {sortedDays.length === 0 ? (
        <div className="py-16 text-center space-y-4 bg-gray-50 dark:bg-[#082622] rounded-xl border border-gray-200 dark:border-[#14423b] p-8">
          <p className="text-base text-gray-600 dark:text-[#8eb698] font-medium">
            {t('noDaysYet')}
          </p>
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              setErrorMessage('');
              setIsCreateModalOpen(true);
            }}
          >
            {t('createDay')}
          </Button>
        </div>
      ) : (
        <div className="divide-y divide-gray-200 dark:divide-[#14423b] border-t border-b border-gray-200 dark:border-[#14423b]">
          {sortedDays.map((day) => {
            const weekday = formatWeekday(day.date);
            const formattedDate = formatDate(day.date);

            return (
              <button
                key={day.id}
                type="button"
                onClick={() => onSelectDay && onSelectDay(day.id)}
                className="w-full text-start py-4 px-2 hover:bg-gray-50 dark:hover:bg-[#0a2f29]/70 transition-colors cursor-pointer flex items-center justify-between gap-4 group border-0 bg-transparent focus:outline-none focus:bg-gray-50 dark:focus:bg-[#0a2f29]/70"
              >
                {/* Left Side: Date Info */}
                <div className="space-y-0.5 pointer-events-none">
                  <p className="text-base font-bold text-gray-900 dark:text-[#daf1de]">
                    {weekday}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-[#8eb698]">
                    {formattedDate}
                  </p>
                </div>

                {/* Right Side: Order Count, Total Amount & Arrow */}
                <div className="flex items-center gap-6 text-end pointer-events-none">
                  <div className="text-end">
                    <p className="text-sm font-semibold text-gray-900 dark:text-[#daf1de]">
                      {formatCurrency(day.totalOrderValueMinor)}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-[#8eb698]">
                      {day.orderCount === 1 ? t('orderSingleCount') : t('ordersCount', { count: day.orderCount })}
                    </p>
                  </div>

                  <div className="text-gray-400 dark:text-[#5e8674] group-hover:text-gray-700 dark:group-hover:text-[#daf1de] transition-colors">
                    {isRTL ? (
                      <ChevronLeft className="w-5 h-5" />
                    ) : (
                      <ChevronRight className="w-5 h-5" />
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Create Day Modal */}
      <Modal
        isOpen={isCreateModalOpen}
        onClose={() => {
          setIsCreateModalOpen(false);
          setCreateMode(null);
          setErrorMessage('');
        }}
        title={t('createNewDay')}
      >
        <div className="space-y-5">
          {errorMessage && (
            <div className="p-3 rounded-lg bg-red-50 dark:bg-[#360d13] border border-red-200 dark:border-[#421419] text-red-700 dark:text-[#e07a7a] text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {!createMode ? (
            <div className="space-y-3 pt-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  onClick={() => handleCreateDaySubmit(getTodayDateString())}
                  className="p-4 rounded-xl bg-gray-50 dark:bg-[#072420] border border-gray-200 dark:border-[#14423b] hover:border-emerald-500 dark:hover:border-[#8eb698] text-start space-y-1 transition-all cursor-pointer"
                >
                  <p className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">{t('dayToday')}</p>
                  <p className="text-xs text-gray-500 dark:text-[#8eb698]">
                    {t('todayAutoDesc', { date: getTodayDateString() })}
                  </p>
                </button>

                <button
                  onClick={() => setCreateMode('custom')}
                  className="p-4 rounded-xl bg-gray-50 dark:bg-[#072420] border border-gray-200 dark:border-[#14423b] hover:border-emerald-500 dark:hover:border-[#8eb698] text-start space-y-1 transition-all cursor-pointer"
                >
                  <p className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">{t('customDate')}</p>
                  <p className="text-xs text-gray-500 dark:text-[#8eb698]">
                    {t('customDateDesc')}
                  </p>
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4 pt-2">
              <Input
                type="date"
                label={t('businessDayDate')}
                value={customDate}
                onChange={(e) => {
                  setCustomDate(e.target.value);
                  setErrorMessage('');
                }}
              />

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-200 dark:border-gray-800">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setCreateMode(null);
                    setErrorMessage('');
                  }}
                >
                  {t('cancel')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!customDate}
                  onClick={() => handleCreateDaySubmit(customDate)}
                >
                  {t('confirmAndCreate')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
};
