import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

const root = createRoot(document.getElementById('root')!);
const pathname = window.location.pathname;
const appVariant = import.meta.env.VITE_APP_VARIANT;
const isPublicPortalRoute =
  pathname === '/public/about' ||
  pathname === '/public/services' ||
  pathname.startsWith('/public/services/') ||
  pathname.startsWith('/c/') ||
  pathname.startsWith('/o/') ||
  pathname.startsWith('/pay/') ||
  pathname.startsWith('/public/order/') ||
  pathname.startsWith('/public/qr/customer/') ||
  pathname.startsWith('/public/qr/order/');

const prepareCustomerIdentity = (preserveWebPwa = false) => {
  document.title = 'نقطة الشحن';
  const description = document.querySelector('meta[name="description"]');
  description?.setAttribute('content', 'بوابة آمنة لعرض تفاصيل الطلب وإرسال إشعار الدفع.');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#082622');
  // Native APK shells manage their own installation identity. The public web
  // customer portal must keep its manifest and web-app metadata so browsers can
  // install it as a real standalone PWA rather than only offering a home shortcut.
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

// Customer APK: its only application entry is the customer portal. Opening the
// installed app starts at the public landing page, never the administrator login.
if (appVariant === 'customer') {
  if (pathname === '/' || pathname === '/app' || pathname === '/login') {
    window.history.replaceState({ path: '/public/about' }, '', '/public/about');
  }
  prepareCustomerIdentity();
  // Native push setup is deliberately non-blocking: permission prompts, Firebase
  // registration, or a transient native-plugin failure must never leave the app on
  // a blank screen. Render the customer portal independently, then initialize push.
  void import('./PublicPortalApp')
    .then(({ default: PublicPortalApp }) => {
      root.render(<StrictMode><PublicPortalApp /></StrictMode>);
    })
    .catch((error) => console.error('Customer portal failed to load.', error));
  void import('./services/nativePushNotifications')
    .then(({ initializeNativePushNotificationListeners }) =>
      initializeNativePushNotificationListeners('customer', document.documentElement.lang))
    .catch((error) => console.warn('Customer push initialization failed; portal remains available.', error));
} else if (appVariant !== 'admin' && isPublicPortalRoute) {
  // Public customer routes are a first-class installable PWA entry. Keep the
  // manifest metadata and capture the browser's native install prompt here too;
  // this branch previously removed the manifest and skipped PWA prompt capture.
  prepareCustomerIdentity(true);
  void import('./services/pwaInstallService').then(({ initializePWAInstallCapture }) => {
    initializePWAInstallCapture();
  });
  void import('./PublicPortalApp').then(({ default: PublicPortalApp }) => {
    root.render(<StrictMode><PublicPortalApp /></StrictMode>);
  }).catch((error) => console.error('Public customer portal failed to load.', error));
} else {
  // The admin APK intentionally does not route into the public customer portal.
  if (appVariant === 'admin' && isPublicPortalRoute) {
    window.history.replaceState({ path: '/app' }, '', '/app');
  }
  void import('./services/pwaInstallService').then(({ initializePWAInstallCapture }) => {
    initializePWAInstallCapture();
  });
  if (appVariant === 'admin') {
    // Do not gate first paint on native push registration. A rejected permission
    // request or FCM/native bridge failure must not suppress the entire admin UI.
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
