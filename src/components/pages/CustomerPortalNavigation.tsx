import React, { useState } from 'react';
import { Bell, CalendarDays, House, Menu, Package, ReceiptText, Settings, Target, UserRound, X } from 'lucide-react';
import './customer-portal-navigation.css';

export type CustomerPortalTab = 'home' | 'orders' | 'finance' | 'goals' | 'more';
export type CustomerPortalMoreView = 'profile' | 'events' | 'notifications' | 'settings';

type Props = {
  activeTab: CustomerPortalTab;
  onTabChange: (tab: CustomerPortalTab) => void;
  moreView: CustomerPortalMoreView;
  onMoreViewChange: (view: CustomerPortalMoreView) => void;
  notificationCount?: number;
};

const items = [
  { id: 'orders' as const, labelAr: 'الطلبات', labelEn: 'Orders', Icon: Package },
  { id: 'finance' as const, labelAr: 'الحساب', labelEn: 'Account', Icon: ReceiptText },
  { id: 'home' as const, labelAr: 'الرئيسية', labelEn: 'Home', Icon: House },
  { id: 'goals' as const, labelAr: 'الأهداف', labelEn: 'Goals', Icon: Target },
  { id: 'more' as const, labelAr: 'المزيد', labelEn: 'More', Icon: Menu },
];

const moreItems = [
  { id: 'profile' as const, labelAr: 'حسابي', labelEn: 'My account', Icon: UserRound },
  { id: 'events' as const, labelAr: 'الأحداث', labelEn: 'Events', Icon: CalendarDays },
  { id: 'notifications' as const, labelAr: 'الإشعارات', labelEn: 'Notifications', Icon: Bell },
  { id: 'settings' as const, labelAr: 'الإعدادات', labelEn: 'Settings', Icon: Settings },
];

export const CustomerPortalNavigation: React.FC<Props & { isAr: boolean }> = ({
  activeTab, onTabChange, moreView, onMoreViewChange, notificationCount = 0, isAr,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <>
      {activeTab === 'more' && menuOpen && (
        <div className="cp-portal-more-scrim" onClick={() => setMenuOpen(false)}>
          <div className="cp-portal-more-menu" role="menu" dir={isAr ? 'rtl' : 'ltr'} onClick={(event) => event.stopPropagation()}>
            <div className="cp-portal-more-menu__heading">
              <span>{isAr ? 'مساحتك الشخصية' : 'Your space'}</span>
              <button type="button" aria-label={isAr ? 'إغلاق القائمة' : 'Close menu'} onClick={() => setMenuOpen(false)}><X size={17} /></button>
            </div>
            {moreItems.map(({ id, labelAr, labelEn, Icon }) => (
              <button key={id} type="button" role="menuitem" className={`cp-portal-more-menu__item ${moreView === id ? 'is-active' : ''}`}
                onClick={() => { onMoreViewChange(id); setMenuOpen(false); }}>
                <span className="cp-portal-more-menu__icon"><Icon size={18} /></span>
                <span>{isAr ? labelAr : labelEn}</span>
                {id === 'notifications' && notificationCount > 0 && <span className="cp-portal-more-menu__count">{Math.min(notificationCount, 99)}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      <nav className="cp-portal-dock" aria-label={isAr ? 'التنقل في حساب العميل' : 'Customer account navigation'} dir={isAr ? 'rtl' : 'ltr'}>
        <div className="cp-portal-dock__track">
          {items.map(({ id, labelAr, labelEn, Icon }) => {
            const selected = activeTab === id;
            return (
              <button key={id} type="button" className={`cp-portal-dock__item ${selected ? 'is-active' : ''}`}
                aria-current={selected ? 'page' : undefined}
                aria-label={isAr ? labelAr : labelEn}
                onClick={() => {
                  onTabChange(id);
                  if (id === 'more') setMenuOpen((open) => !open);
                  else setMenuOpen(false);
                }}>
                <span className="cp-portal-dock__orb"><Icon size={20} strokeWidth={selected ? 2 : 1.8} /></span>
                <span className="cp-portal-dock__label">{isAr ? labelAr : labelEn}</span>
                {id === 'more' && notificationCount > 0 && <span className="cp-portal-dock__dot" aria-label={isAr ? 'إشعارات جديدة' : 'New notifications'} />}
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
};
