import React, { useState } from 'react';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';
import { Header } from './Header';
import { UserSession } from '../../services/auth/authService';

export interface AuthenticatedLayoutProps {
  currentPath: string;
  userSession: UserSession | null;
  onNavigate: (path: string) => void;
  onLogout: () => void;
  children: React.ReactNode;
}

export const AuthenticatedLayout: React.FC<AuthenticatedLayoutProps> = ({
  currentPath,
  userSession,
  onNavigate,
  onLogout,
  children,
}) => {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-gray-50 dark:bg-transparent text-gray-900 dark:text-gray-100">
      <Sidebar currentPath={currentPath} userSession={userSession} onNavigate={onNavigate} />
      <MobileNav
        isOpen={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        currentPath={currentPath}
        userSession={userSession}
        onNavigate={onNavigate}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <Header
          onOpenMobileNav={() => setMobileNavOpen(true)}
          onLogout={onLogout}
          currentPath={currentPath}
        />
        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">{children}</main>
      </div>
    </div>
  );
};
