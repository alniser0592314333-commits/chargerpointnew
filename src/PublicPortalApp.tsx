import React, { useEffect, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { I18nProvider } from './i18n/i18nContext';
import { ThemeProvider } from './theme/themeContext';
import { CustomerAccountPage } from './components/pages/CustomerAccountPage';
import { PublicOrderPage } from './components/pages/PublicOrderPage';
import { PublicPaymentPage } from './components/pages/PublicPaymentPage';
import { PublicAboutPage } from './components/pages/PublicAboutPage';
import { FirstVisitWelcomeIntro } from './components/pages/FirstVisitWelcomeIntro';
import './public-portal.css';


function scrollPublicViewToTop(): boolean {
  const root = document.scrollingElement as HTMLElement | null;
  if (window.scrollY > 1 || (root?.scrollTop ?? 0) > 1) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return true;
  }
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('*')).filter((element) => {
    if (element.scrollTop <= 1 || element.scrollHeight <= element.clientHeight + 8) return false;
    if (!['auto', 'scroll', 'overlay'].includes(window.getComputedStyle(element).overflowY)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  });
  if (!candidates.length) return false;
  const depth = (element: HTMLElement) => {
    let value = 0;
    let parent: HTMLElement | null = element;
    while (parent) { value += 1; parent = parent.parentElement; }
    return value;
  };
  const deepest = candidates.reduce((best, element) => depth(element) > depth(best) ? element : best);
  deepest.scrollTo({ top: 0, behavior: 'smooth' });
  return true;
}

const publicRoutes = [
  { prefix: '/public/qr/customer/', render: (token: string) => <ThemeProvider defaultTheme="dark"><CustomerAccountPage token={token} /></ThemeProvider> },
  { prefix: '/public/qr/order/', render: (token: string) => <ThemeProvider><PublicOrderPage token={token} /></ThemeProvider> },
  { prefix: '/public/order/', render: (token: string) => <ThemeProvider><PublicOrderPage token={token} /></ThemeProvider> },
  { prefix: '/c/', render: (token: string) => <ThemeProvider defaultTheme="dark"><CustomerAccountPage token={token} /></ThemeProvider> },
  { prefix: '/o/', render: (token: string) => <ThemeProvider><PublicOrderPage token={token} /></ThemeProvider> },
  { prefix: '/pay/', render: (token: string) => <ThemeProvider><PublicPaymentPage token={token} /></ThemeProvider> },
];

const PublicNotFound: React.FC = () => (
  <main className="public-not-found">
    <div className="public-not-found__mark" aria-hidden="true">✦</div>
    <p className="public-eyebrow">CUSTOMER PORTAL</p>
    <h1>الرابط غير صالح</h1>
    <p>تأكد من فتح رابط رمز QR الصحيح أو اطلب رابطًا جديدًا.</p>
  </main>
);

/**
 * Customer-only entry point. Intentionally has no auth provider, admin app,
 * application router, authenticated layout, sidebar, or admin navigation.
 */
const PublicPortalApp: React.FC = () => {
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname);
  const pathname = currentPath.split(/[?#]/, 1)[0];

  useEffect(() => {
    const handleBack = () => {
      if (scrollPublicViewToTop()) return;
      // The public portal has one landing page. Detail QR/payment routes return
      // to that landing page; at the landing page Back never exits the app.
      if (pathname !== '/public/about') {
        window.history.replaceState({ path: '/public/about' }, '', '/public/about');
        setCurrentPath('/public/about');
      }
    };

    const nativeBackListener = CapacitorApp.addListener('backButton', handleBack);
    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const x = event.touches[0].clientX;
      (window as any).__cpPublicBackStart = { x, y: event.touches[0].clientY, edge: x <= 32 || x >= window.innerWidth - 32 };
    };
    const handleTouchEnd = (event: TouchEvent) => {
      const start = (window as any).__cpPublicBackStart as { x: number; y: number; edge: boolean } | undefined;
      (window as any).__cpPublicBackStart = undefined;
      if (!start?.edge || event.changedTouches.length !== 1) return;
      const dx = event.changedTouches[0].clientX - start.x;
      const dy = Math.abs(event.changedTouches[0].clientY - start.y);
      if (Math.abs(dx) >= 60 && dy <= 80) handleBack();
    };
    const handlePopState = () => {
      handleBack();
      window.history.replaceState({ path: pathname }, '', pathname);
    };
    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchend', handleTouchEnd);
      window.removeEventListener('popstate', handlePopState);
      void nativeBackListener.then((listener) => listener.remove()).catch(() => undefined);
    };
  }, [pathname]);
  let content: React.ReactNode = <PublicNotFound />;
  let welcomeEnabled = pathname === '/public/about';

  if (pathname === '/public/about') {
    content = <ThemeProvider><PublicAboutPage /></ThemeProvider>;
  } else {
    const route = publicRoutes.find((item) => pathname.startsWith(item.prefix));
    if (route) {
      const rawToken = pathname.slice(route.prefix.length).split('/')[0];
      try {
        const token = decodeURIComponent(rawToken);
        if (token && !token.includes('..')) {
          content = route.render(token);
          welcomeEnabled = true;
        } else {
          content = <PublicNotFound />;
        }
      } catch {
        content = <PublicNotFound />;
      }
    }
  }

  return <I18nProvider><FirstVisitWelcomeIntro enabled={welcomeEnabled} />{content}</I18nProvider>;
};

export default PublicPortalApp;
