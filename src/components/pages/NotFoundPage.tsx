import React from 'react';
import { Button } from '../ui/Button';
import { useI18n } from '../../i18n/i18nContext';

export const NotFoundPage: React.FC<{ onGoHome?: () => void }> = ({ onGoHome }) => {
  const { t } = useI18n();
  return (
    <div className="p-6 bg-white dark:bg-[#082622] rounded-xl border border-gray-200 dark:border-[#14423b] space-y-4 transition-colors">
      <h1 className="text-xl font-bold text-gray-900 dark:text-[#daf1de]">{t('pageNotFound')}</h1>
      <p className="text-sm text-gray-500 dark:text-[#8eb698]">{t('pageNotFoundDesc')}</p>
      {onGoHome && (
        <Button variant="outline" size="sm" onClick={onGoHome}>
          {t('backToHome')}
        </Button>
      )}
    </div>
  );
};
