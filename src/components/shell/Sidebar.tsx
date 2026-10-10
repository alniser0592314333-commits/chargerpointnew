import React from 'react';
import { useI18n } from '../../i18n/i18nContext';
import { UserSession } from '../../services/auth/authService';

export interface SidebarProps {
  currentPath: string;
  userSession: UserSession | null;
  onNavigate: (path: string) => void;
  className?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({ currentPath, userSession, onNavigate, className = '' }) => {
  const { t } = useI18n();

  const isSuperAdmin = Boolean(userSession && String(userSession.role || '').toUpperCase().replace(/\s+/g, '_') === 'SUPER_ADMIN');
  const hasAdminManage = isSuperAdmin || Boolean(userSession?.permissions?.includes('admin:manage'));

  const navItems = [
    { id: '/app', label: t('navHome') },
    { id: '/app/days', label: t('navDaysOrders') },
    { id: '/app/customers', label: t('navCustomers') },
    { id: '/app/financials', label: t('navFinancials') },
    ...(isSuperAdmin || Boolean(userSession?.permissions?.some((permission) => ['goals:view', 'goals:requests:view', 'goals:manage', 'goals:approve'].includes(permission))) ? [{ id: '/app/goals', label: t('navGoals') }] : []),
    { id: '/app/notifications', label: t('navNotificationsRequests') },
    { id: '/app/settings/qr', label: t('navQrDesign') },
    ...(hasAdminManage ? [{ id: '/app/settings/admins', label: t('navAdminMgmt') }] : []),
    { id: '/app/settings', label: t('navSettings') },
  ];

  return (
    <aside className={`hidden md:flex flex-col w-64 bg-white dark:bg-[#06201c] border-e border-gray-200 dark:border-[#123d37] shrink-0 transition-colors ${className}`}>
      <div className="p-4 border-b border-gray-200 dark:border-[#123d37]">
        <h1 className="text-base font-bold text-gray-900 dark:text-[#daf1de]">
          {t('systemManagementTitle')}
        </h1>
        <p className="text-xs text-gray-500 dark:text-[#527361]">Reset Shell</p>
      </div>
      <nav className="flex-1 p-2 space-y-1">
        {navItems.map((item) => {
          const isActive =
            currentPath === item.id ||
            (item.id === '/app/days' && currentPath.startsWith('/app/days/'));
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`w-full text-start px-3 py-2 rounded-md text-sm transition-colors cursor-pointer ${
                isActive
                  ? 'bg-gray-100 dark:bg-[#0c312b] font-semibold text-gray-900 dark:text-[#daf1de] border-s-2 border-transparent dark:border-[#8eb698]'
                  : 'text-gray-600 dark:text-[#8eb698] hover:bg-gray-50 dark:hover:bg-[#092722] hover:text-gray-900 dark:hover:text-[#daf1de]'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
    </aside>
  );
};
