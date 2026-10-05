import React from 'react';
import { useI18n } from '../../i18n/i18nContext';

export const NotificationsRequestsPage: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="p-6 bg-white dark:bg-[#082622] rounded-xl border border-gray-200 dark:border-[#14423b] space-y-2 transition-colors">
      <h1 className="text-xl font-bold text-gray-900 dark:text-[#daf1de]">{t('navNotificationsRequests')}</h1>
      <p className="text-sm text-gray-500 dark:text-[#8eb698]">{t('notificationsSubtitle')}</p>
    </div>
  );
};
