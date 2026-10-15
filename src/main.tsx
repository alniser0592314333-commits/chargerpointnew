import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

const root = createRoot(document.getElementById('root')!);
const pathname = window.location.pathname;
const isPublicPortalRoute =
  pathname.startsWith('/design/') ||
  pathname === '/public/about' ||
  pathname.startsWith('/c/') ||
  pathname.startsWith('/o/') ||
  pathname.startsWith('/pay/') ||
  pathname.startsWith('/public/order/') ||
  pathname.startsWith('/public/qr/customer/') ||
  pathname.startsWith('/public/qr/order/');

// Public QR links and isolated public-page design previews do not initialize
// the admin app, auth/session bootstrap, PWA capture, or authenticated shell.
if (isPublicPortalRoute) {
  document.title = pathname.startsWith('/design/')
    ? 'نقطة الشحن | معاينة تصميم الصفحات العامة'
    : 'نقطة الشحن | بوابة العميل';
  const description = document.querySelector('meta[name="description"]');
  description?.setAttribute(
    'content',
    pathname.startsWith('/design/')
      ? 'معاينة تصميم الصفحات العامة للزبائن.'
      : 'بوابة آمنة لعرض تفاصيل الطلب وإرسال إشعار الدفع.'
  );
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#0b1412');
  document.querySelector('link[rel="manifest"]')?.remove();
  document.querySelector('link[rel="apple-touch-icon"]')?.remove();
  document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.remove();
  document.querySelector('meta[name="mobile-web-app-capable"]')?.remove();
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.remove();
  document.documentElement.classList.remove('dark');
  document.documentElement.classList.add('light');
  document.documentElement.lang = 'ar';
  document.documentElement.dir = 'rtl';
  void import('./PublicPortalApp').then(({ default: PublicPortalApp }) => {
    root.render(<StrictMode><PublicPortalApp /></StrictMode>);
  });
} else {
  void import('./services/pwaInstallService').then(({ initializePWAInstallCapture }) => {
    initializePWAInstallCapture();
  });
  void import('./App.tsx').then(({ default: App }) => {
    root.render(<StrictMode><App /></StrictMode>);
  });
}
