import React from 'react';
import { useI18n } from '../../i18n/i18nContext';
import { Shield, Lock } from 'lucide-react';

export const Footer: React.FC = () => {
  const { t } = useI18n();

  return (
    <footer className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 py-6 mt-12 transition-colors">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-gray-500 dark:text-gray-400">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <span>{t('systemTitle')} — Strict Architectural Foundation</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1">
            <Lock className="w-3.5 h-3.5 text-emerald-500" />
            <span>Zero Business Data / No Demo Tables</span>
          </span>
          <span>TypeScript Strict Mode</span>
        </div>
      </div>
    </footer>
  );
};
