import React, { useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { I18nProvider } from './i18n/i18nContext';
import { ThemeProvider } from './theme/themeContext';
import { CustomerAccountPage } from './components/pages/CustomerAccountPage';
import { PublicOrderPage } from './components/pages/PublicOrderPage';
import { PublicPaymentPage } from './components/pages/PublicPaymentPage';
import { PublicAboutPage } from './components/pages/PublicAboutPage';
import { WalletManagementPage } from './components/pages/WalletManagementPage';
import { PublicServicesPage } from './components/pages/PublicServicesPage';
import { FirstVisitWelcomeIntro } from './components/pages/FirstVisitWelcomeIntro';
import './public-portal.css';
import { AppVersionGate } from './components/customer/CustomerAppVersionGate';


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

const isCustomerAccountPath = (path: string) => path.startsWith('/c/') || path.startsWith('/public/qr/customer/');
const NATIVE_LAST_ROUTE_KEY = 'cp_customer_native_last_route_v1';
const NATIVE_SESSION_KEY = 'cp_customer_native_session_active_v1';

function getNativeInitialIntroEnabled(path: string): boolean {
  if (!Capacitor.isNativePlatform()) return false;
  // A notification deep link should land immediately on its requested section,
  // not place the welcome intro in front of the destination.
  try { if (new URLSearchParams(window.location.search).has('tab')) return false; } catch {}
  try {
    const sessionActive = window.sessionStorage.getItem(NATIVE_SESSION_KEY) === '1';
    const previousPath = window.sessionStorage.getItem(NATIVE_LAST_ROUTE_KEY) || '';
    const isAccount = isCustomerAccountPath(path);
    const previousWasPayment = previousPath.startsWith('/pay/');
    const previousWasAccount = isCustomerAccountPath(previousPath);
    const shouldShow = !sessionActive || (
      isAccount && !previousWasPayment && !previousWasAccount
    );
    window.sessionStorage.setItem(NATIVE_SESSION_KEY, '1');
    window.sessionStorage.setItem(NATIVE_LAST_ROUTE_KEY, path);
    return shouldShow;
  } catch {
    // If session storage is unavailable, preserve the safe launch intro fallback.
    return true;
  }
}

function customerAccountReturnPathForPayment(path: string): string | null {
  if (!path.startsWith('/pay/')) return null;
  const token = path.slice('/pay/'.length).split('/')[0];
  if (!token) return null;
  try {
    const rememberedToken = window.localStorage.getItem('last_customer_token')?.trim() || '';
    if (rememberedToken && decodeURIComponent(token) === rememberedToken) {
      return '/c/' + encodeURIComponent(rememberedToken);
    }
  } catch {}
  return null;
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
  const initialPath = useRef(window.location.pathname);
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname);
  const pathname = currentPath.split(/[?#]/, 1)[0];
  const nativeInitialIntro = useRef<boolean | null>(null);
  if (nativeInitialIntro.current === null) nativeInitialIntro.current = getNativeInitialIntroEnabled(pathname);
  const [introKey, setIntroKey] = useState(0);
  const previousPath = useRef(pathname);
  // A payment page opened from the customer account is part of the same account
  // flow. Returning from payment must not replay the intro; leaving for the public
  // home page resets the flow so the next account entry gets a fresh 4-second intro.
  const customerFlowActive = useRef(isCustomerAccountPath(pathname) || customerAccountReturnPathForPayment(pathname) !== null);

  // The native APK should reopen the last signed-in customer's portal after a full
  // process restart. Keep the website's public landing-page behavior unchanged.
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || pathname !== '/public/about') return;
    let savedToken = '';
    try { savedToken = window.localStorage.getItem('last_customer_token')?.trim() || ''; } catch {}
    if (!savedToken || savedToken.length > 512) return;
    const nextPath = '/c/' + encodeURIComponent(savedToken);
    // This is restoration of the current app session, not a user navigating into
    // the account; the launch intro already covers this transition.
    customerFlowActive.current = true;
    window.history.replaceState({ path: nextPath }, '', nextPath);
    setCurrentPath(nextPath);
  // Run only for the initial native landing route.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const previous = previousPath.current;
    previousPath.current = pathname;
    if (previous === pathname) return;

    if (isCustomerAccountPath(pathname)) {
      if (Capacitor.isNativePlatform() && !customerFlowActive.current) {
        setIntroKey((key) => key + 1);
      }
      customerFlowActive.current = true;
      return;
    }

    if (pathname.startsWith('/pay/')) {
      // Keep the account flow active only when payment was opened from it.
      if (!isCustomerAccountPath(previous) && !customerFlowActive.current) {
        customerFlowActive.current = false;
      }
      return;
    }

    // Only returning to the public home page ends the account flow. Other
    // routes opened from the account (payment/order details) remain part of it.
    if (pathname === '/public/about') customerFlowActive.current = false;
  }, [pathname]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    try {
      window.sessionStorage.setItem(NATIVE_SESSION_KEY, '1');
      window.sessionStorage.setItem(NATIVE_LAST_ROUTE_KEY, pathname);
    } catch {}
  }, [pathname]);

  useEffect(() => {
    const exitWalletToServices = () => {
      window.history.replaceState({ path: '/public/services' }, '', '/public/services');
      setCurrentPath('/public/services');
    };
    const confirmWalletExit = () => {
      const isAr = document.documentElement.lang !== 'en';
      const message = isAr ? 'هل تريد الخروج من صفحة المحفظة والعودة إلى خدمات المساعدة؟' : 'Leave the wallet page and return to Assistance Services?';
      if (window.confirm(message)) exitWalletToServices();
    };
    const handleBack = () => {
      if (pathname === '/public/services/wallet') { confirmWalletExit(); return; }
      if (scrollPublicViewToTop()) return;
      // The public portal has one landing page. Detail QR/payment routes return
      // to that landing page; at the landing page Back never exits the app.
      if (pathname !== '/public/about') {
        const backTarget = customerAccountReturnPathForPayment(pathname) || '/public/about';
        window.history.replaceState({ path: backTarget }, '', backTarget);
        setCurrentPath(backTarget);
      }
    };

    let startX = 0;
    let startY = 0;
    let startedAtEdge = false;
    const nativeBackListener = CapacitorApp.addListener('backButton', handleBack);
    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) { startedAtEdge = false; return; }
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      startedAtEdge = startX <= 32 || startX >= window.innerWidth - 32;
    };
    const handleTouchEnd = (event: TouchEvent) => {
      if (!startedAtEdge || event.changedTouches.length !== 1) { startedAtEdge = false; return; }
      startedAtEdge = false;
      const dx = event.changedTouches[0].clientX - startX;
      const dy = Math.abs(event.changedTouches[0].clientY - startY);
      if (Math.abs(dx) >= 60 && dy <= 80) handleBack();
    };
    const handlePopState = () => {
      if (pathname === '/public/services/wallet') {
        const isAr = document.documentElement.lang !== 'en';
        const message = isAr ? 'هل تريد الخروج من صفحة المحفظة والعودة إلى خدمات المساعدة؟' : 'Leave the wallet page and return to Assistance Services?';
        if (window.confirm(message)) {
          window.history.replaceState({ path: '/public/services' }, '', '/public/services');
          setCurrentPath('/public/services');
        } else {
          window.history.pushState({ path: pathname }, '', pathname);
          setCurrentPath(pathname);
        }
        return;
      }
      if (scrollPublicViewToTop()) {
        window.history.replaceState({ path: pathname }, '', pathname);
        return;
      }
      if (pathname !== '/public/about') {
        const backTarget = customerAccountReturnPathForPayment(pathname) || '/public/about';
        window.history.replaceState({ path: backTarget }, '', backTarget);
        setCurrentPath(backTarget);
        return;
      }
      window.history.replaceState({ path: pathname }, '', pathname);
      setCurrentPath(pathname);
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
  // Preserve the website's existing one-time intro behavior. In the native customer APK,
  // show the intro on every app entry, including QR deep links.
  let welcomeEnabled = Capacitor.isNativePlatform() ? nativeInitialIntro.current === true : (initialPath.current === '/public/about' && pathname === '/public/about');

  if (pathname === '/public/about') {
    content = <ThemeProvider><PublicAboutPage /></ThemeProvider>;
  } else if (pathname === '/public/services') {
    content = <ThemeProvider><PublicServicesPage onBack={() => { window.history.replaceState({ path: '/public/about' }, '', '/public/about'); setCurrentPath('/public/about'); }} onOpenWallet={() => { window.history.replaceState({ path: '/public/services/wallet' }, '', '/public/services/wallet'); setCurrentPath('/public/services/wallet'); }} /></ThemeProvider>;
  } else if (pathname === '/public/services/wallet') {
    content = <ThemeProvider><WalletManagementPage onBack={() => { window.history.replaceState({ path: '/public/services' }, '', '/public/services'); setCurrentPath('/public/services'); }} /></ThemeProvider>;
  } else {
    const route = publicRoutes.find((item) => pathname.startsWith(item.prefix));
    if (route) {
      const rawToken = pathname.slice(route.prefix.length).split('/')[0];
      try {
        const token = decodeURIComponent(rawToken);
        if (token && !token.includes('..')) {
          content = route.render(token);
        } else {
          content = <PublicNotFound />;
        }
      } catch {
        content = <PublicNotFound />;
      }
    }
  }

  return <I18nProvider><AppVersionGate channel="customer"><FirstVisitWelcomeIntro key={introKey} enabled={welcomeEnabled} />{content}</AppVersionGate></I18nProvider>;
};

export default PublicPortalApp;
