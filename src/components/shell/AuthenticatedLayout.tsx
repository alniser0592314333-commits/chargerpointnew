import React, { useState } from 'react';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';
import { Header } from './Header';
import { UserSession } from '../../services/auth/authService';
import { useAdminNotificationCount } from '../../hooks/useAdminNotificationCount';

export interface AuthenticatedLayoutProps {
  currentPath: string;
  userSession: UserSession | null;
  onNavigate: (path: string) => void;
  children: React.ReactNode;
}

export const AuthenticatedLayout: React.FC<AuthenticatedLayoutProps> = ({
  currentPath,
  userSession,
  onNavigate,
  children,
}) => {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const notificationCount = useAdminNotificationCount(Boolean(userSession));
  const isPurchaseWorkspace = currentPath === '/app/purchases' || currentPath.startsWith('/app/purchases/');

  if (isPurchaseWorkspace) {
    return <div className="min-h-screen bg-gray-50 dark:bg-[#061f1c] text-gray-900 dark:text-gray-100" dir="rtl">
      <main className="min-h-screen w-full">{children}</main>
    </div>;
  }

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-gray-50 dark:bg-transparent text-gray-900 dark:text-gray-100">
      <Sidebar currentPath={currentPath} userSession={userSession} onNavigate={onNavigate} notificationCount={notificationCount} />
      <MobileNav
        isOpen={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        currentPath={currentPath}
        userSession={userSession}
        notificationCount={notificationCount}
        onNavigate={onNavigate}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <Header
          onOpenMobileNav={() => setMobileNavOpen(true)}
          currentPath={currentPath}
          notificationCount={notificationCount}
        />
        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">{children}</main>
      </div>
    </div>
  );
};
