import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { isCustomerPortalPath } from './services/publicPortalOrigin';

const root = createRoot(document.getElementById('root')!);
const appVariant = import.meta.env.VITE_APP_VARIANT;
let pathname = window.location.pathname;

// On the shared web origin the root is the public landing page. The admin PWA
// has an explicit /app start URL; native admin builds also default to /app.
if (pathname === '/') {
  const startPath = appVariant === 'admin' ? '/app' : '/public/about';
  window.history.replaceState({ path: startPath }, '', startPath + window.location.search + window.location.hash);
  pathname = startPath;
}
const isCustomerPortalRoute = isCustomerPortalPath(pathname);
const isPublicPortalRoute = appVariant !== 'admin' && isCustomerPortalRoute;

const prepareCustomerIdentity = (preserveWebPwa = false) => {
  document.title = 'نقطة الشحن';
  const description = document.querySelector('meta[name="description"]');
  description?.setAttribute('content', 'بوابة آمنة لعرض تفاصيل الطلب وإرسال إشعار الدفع.');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#082622');
  // Native APK shells manage their own installation identity. The public web
  // customer portal keeps its manifest so it remains independently installable.
  if (!preserveWebPwa) {
    document.querySelector('link[rel="manifest"]')?.remove();
    document.querySelector('link[rel="apple-touch-icon"]')?.remove();
    document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.remove();
    document.querySelector('meta[name="mobile-web-app-capable"]')?.remove();
    document.querySelector('meta[name="apple-mobile-web-app-title"]')?.remove();
  }
  document.documentElement.classList.remove('dark');
  document.documentElement.classList.add('light');
  document.documentElement.lang = 'ar';
  document.documentElement.dir = 'rtl';
};

// Customer APK: its only application entry is the customer portal.
if (appVariant === 'customer') {
  if (pathname === '/app' || pathname === '/login') {
    window.history.replaceState({ path: '/public/about' }, '', '/public/about');
  }
  prepareCustomerIdentity();
  void import('./PublicPortalApp')
    .then(({ default: PublicPortalApp }) => {
      root.render(<StrictMode><PublicPortalApp /></StrictMode>);
    })
    .catch((error) => console.error('Customer portal failed to load.', error));
  void import('./services/nativePushNotifications')
    .then(({ initializeNativePushNotificationListeners }) =>
      initializeNativePushNotificationListeners('customer', document.documentElement.lang))
    .catch((error) => console.warn('Customer push initialization failed; portal remains available.', error));
} else if (isPublicPortalRoute) {
  // Public customer routes are a first-class installable PWA on the shared origin.
  prepareCustomerIdentity(true);
  void import('./services/pwaInstallService').then(({ initializePWAInstallCapture }) => {
    initializePWAInstallCapture();
  });
  void import('./PublicPortalApp').then(({ default: PublicPortalApp }) => {
    root.render(<StrictMode><PublicPortalApp /></StrictMode>);
  }).catch((error) => console.error('Public customer portal failed to load.', error));
} else {
  // The admin PWA starts at /app and shares the same origin without redirecting
  // customer routes to a separate hostname.
  void import('./services/pwaInstallService').then(({ initializePWAInstallCapture }) => {
    initializePWAInstallCapture();
  });
  if (appVariant === 'admin') {
    void import('./App.tsx')
      .then(async ({ default: App }) => {
        const { AppVersionGate } = await import('./components/customer/CustomerAppVersionGate');
        root.render(<StrictMode><AppVersionGate channel="admin"><App /></AppVersionGate></StrictMode>);
      })
      .catch((error) => console.error('Admin app failed to load.', error));
    void import('./services/nativePushNotifications')
      .then(({ initializeNativePushNotificationListeners }) =>
        initializeNativePushNotificationListeners('admin', document.documentElement.lang))
      .catch((error) => console.warn('Admin push initialization failed; app remains available.', error));
  } else {
    void import('./App.tsx')
      .then(({ default: App }) => {
        root.render(<StrictMode><App /></StrictMode>);
      })
      .catch((error) => console.error('App failed to load.', error));
  }
}
