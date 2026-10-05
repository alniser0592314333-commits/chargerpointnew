import React from 'react';
import { useI18n } from '../../i18n/i18nContext';
import { AppLogo } from '../qr/AppLogo';
import { Wifi } from 'lucide-react';

export const Header: React.FC = () => {
  const { t } = useI18n();

  return (
    <header className="sticky top-0 z-40 bg-white/80 dark:bg-[#072420]/85 backdrop-blur-md border-b border-gray-200 dark:border-[#123d37]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <AppLogo size={36} variant="auto" />
          <div>
            <h1 className="text-base font-bold text-gray-900 dark:text-[#daf1de]">
              {t('systemTitle')}
            </h1>
            <span className="text-xs text-blue-600 dark:text-[#8eb698] font-medium flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              {t('statusReady')}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-[#0c312b] rounded-lg text-xs text-gray-600 dark:text-[#daf1de]">
            <Wifi className="w-3.5 h-3.5 text-emerald-500" />
            <span>Offline Ready</span>
          </div>
        </div>
      </div>
    </header>
  );
};
