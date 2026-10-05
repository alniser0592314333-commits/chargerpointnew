import React from 'react';
import { useTheme } from '../../theme/themeContext';
import { useI18n } from '../../i18n/i18nContext';
import { Button } from '../ui/Button';

export interface PublicLayoutProps {
  onLogin: () => void;
  onCheckOrders: () => void;
}

export const PublicLayout: React.FC<PublicLayoutProps> = ({ onLogin, onCheckOrders }) => {
  const { theme, toggleTheme } = useTheme();
  const { locale, setLocale, t } = useI18n();

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-transparent text-gray-900 dark:text-[#daf1de] transition-colors">
      <header className="px-6 py-4 flex items-center justify-between border-b border-gray-200 dark:border-[#123d37] bg-white dark:bg-[#072420] transition-colors">
        <span className="font-bold text-base text-gray-900 dark:text-[#daf1de]">
          {t('systemManagementTitle')}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={toggleTheme}>
            {theme === 'dark' ? '🌙' : '☀️'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}>
            {locale === 'ar' ? 'EN' : 'عربي'}
          </Button>
          <Button variant="primary" size="sm" onClick={onLogin}>
            {t('login')}
          </Button>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-6 bg-white dark:bg-[#082622] p-8 rounded-xl border border-gray-200 dark:border-[#14423b] shadow-sm transition-colors">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-[#daf1de]">
            {t('operationsSystem')}
          </h1>
          <p className="text-sm text-gray-500 dark:text-[#8eb698]">
            Phase 6 UI Reset — Public Layout
          </p>
          <div className="flex justify-center gap-3">
            <Button size="md" onClick={onLogin}>
              {t('login')}
            </Button>
            <Button size="md" variant="outline" onClick={onCheckOrders}>
              {t('checkOrders')}
            </Button>
          </div>
        </div>
      </main>

      <footer className="py-4 text-center text-xs text-gray-500 dark:text-[#8eb698] border-t border-gray-200 dark:border-[#123d37] bg-white dark:bg-[#072420] transition-colors">
        {t('copyright')}
      </footer>
    </div>
  );
};
