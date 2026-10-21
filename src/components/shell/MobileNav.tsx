import React from 'react';
import { usePendingNotificationCount } from '../../hooks/usePendingNotificationCount';
import { useI18n } from '../../i18n/i18nContext';
import { UserSession } from '../../services/auth/authService';

export interface MobileNavProps {
  isOpen: boolean;
  onClose: () => void;
  currentPath: string;
  userSession: UserSession | null;
  onNavigate: (path: string) => void;
}

export const MobileNav: React.FC<MobileNavProps> = ({ isOpen, onClose, currentPath, userSession, onNavigate }) => {
  const { t } = useI18n();
  const pendingNotificationCount = usePendingNotificationCount(isOpen && Boolean(userSession));

  if (!isOpen) return null;

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
    <div className="fixed inset-0 z-50 flex md:hidden">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-50 flex flex-col w-72 max-w-full bg-white dark:bg-[#06201c] h-full border-e border-gray-200 dark:border-[#123d37] transition-colors">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-[#123d37]">
          <h2 className="font-bold text-gray-900 dark:text-[#daf1de]">{t('menu')}</h2>
          <button onClick={onClose} className="text-gray-500 dark:text-[#8eb698] hover:text-gray-700 dark:hover:text-[#daf1de] p-1 cursor-pointer">
            ✕
          </button>
        </div>
        <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const isActive =
              currentPath === item.id ||
              (item.id === '/app/days' && currentPath.startsWith('/app/days/'));
            return (
              <button
                key={item.id}
                onClick={() => {
                  onNavigate(item.id);
                  onClose();
                }}
                className={`w-full text-start px-3 py-2 rounded-md text-sm transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-gray-100 dark:bg-[#0c312b] font-semibold text-gray-900 dark:text-[#daf1de] border-s-2 border-transparent dark:border-[#8eb698]'
                    : 'text-gray-600 dark:text-[#8eb698] hover:bg-gray-50 dark:hover:bg-[#092722] hover:text-gray-900 dark:hover:text-[#daf1de]'
                }`}
              >
                <span className="flex min-w-0 flex-1 items-center justify-between gap-2"><span className="truncate">{item.label}</span>{item.id === '/app/notifications' && pendingNotificationCount > 0 && <span aria-label={`${pendingNotificationCount} pending notifications`} title={t('navNotificationsRequests')} className="inline-flex min-w-5 h-5 items-center justify-center rounded-full bg-rose-600 px-1.5 text-[10px] font-extrabold leading-none text-white">{pendingNotificationCount > 99 ? '99+' : pendingNotificationCount}</span>}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
};
