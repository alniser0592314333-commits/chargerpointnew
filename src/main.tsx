import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

const root = createRoot(document.getElementById('root')!);
const pathname = window.location.pathname;
const appVariant = import.meta.env.VITE_APP_VARIANT;
const isPublicPortalRoute =
  pathname === '/public/about' ||
  pathname.startsWith('/c/') ||
  pathname.startsWith('/o/') ||
  pathname.startsWith('/pay/') ||
  pathname.startsWith('/public/order/') ||
  pathname.startsWith('/public/qr/customer/') ||
  pathname.startsWith('/public/qr/order/');

const prepareCustomerIdentity = () => {
  document.title = 'نقطة الشحن';
  const description = document.querySelector('meta[name="description"]');
  description?.setAttribute('content', 'بوابة آمنة لعرض تفاصيل الطلب وإرسال إشعار الدفع.');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#f8f6f1');
  document.querySelector('link[rel="manifest"]')?.remove();
  document.querySelector('link[rel="apple-touch-icon"]')?.remove();
  document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.remove();
  document.querySelector('meta[name="mobile-web-app-capable"]')?.remove();
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.remove();
  document.documentElement.classList.remove('dark');
  document.documentElement.classList.add('light');
  document.documentElement.lang = 'ar';
  document.documentElement.dir = 'rtl';
};

// Customer APK: its only application entry is the customer portal. Opening the
// installed app starts at the public landing page, never the administrator login.
if (appVariant === 'customer') {
  if (pathname === '/' || pathname === '/app' || pathname === '/login') {
    window.history.replaceState({ path: '/public/about' }, '', '/public/about');
  }
  prepareCustomerIdentity();
  void import('./services/nativePushNotifications').then(async ({ initializeNativePushNotificationListeners }) => {
    await initializeNativePushNotificationListeners('customer', document.documentElement.lang);
    const { default: PublicPortalApp } = await import('./PublicPortalApp');
    root.render(<StrictMode><PublicPortalApp /></StrictMode>);
  });
} else if (appVariant !== 'admin' && isPublicPortalRoute) {
  // Preserve the existing web/PWA behavior: public QR links open the isolated
  // customer entry without initializing the admin app or its local business store.
  prepareCustomerIdentity();
  void import('./PublicPortalApp').then(({ default: PublicPortalApp }) => {
    root.render(<StrictMode><PublicPortalApp /></StrictMode>);
  });
} else {
  // The admin APK intentionally does not route into the public customer portal.
  if (appVariant === 'admin' && isPublicPortalRoute) {
    window.history.replaceState({ path: '/app' }, '', '/app');
  }
  void import('./services/pwaInstallService').then(({ initializePWAInstallCapture }) => {
    initializePWAInstallCapture();
  });
  if (appVariant === 'admin') {
    void import('./services/nativePushNotifications').then(async ({ initializeNativePushNotificationListeners }) => {
      await initializeNativePushNotificationListeners('admin', document.documentElement.lang);
      const { default: App } = await import('./App.tsx');
      const { AppVersionGate } = await import('./components/customer/CustomerAppVersionGate');
      root.render(<StrictMode><AppVersionGate channel="admin"><App /></AppVersionGate></StrictMode>);
    });
  } else {
    void import('./App.tsx').then(({ default: App }) => {
      root.render(<StrictMode><App /></StrictMode>);
    });
  }
}
