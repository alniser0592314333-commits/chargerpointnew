import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

const root = createRoot(document.getElementById('root')!);
const pathname = window.location.pathname;
const isPublicPortalRoute =
  pathname === '/' ||
  pathname === '/public/about' ||
  pathname.startsWith('/c/') ||
  pathname.startsWith('/o/') ||
  pathname.startsWith('/pay/') ||
  pathname.startsWith('/public/order/') ||
  pathname.startsWith('/public/qr/customer/') ||
  pathname.startsWith('/public/qr/order/');

// Public QR links use a separate entry module. Do not initialize the admin app,
// its auth/session bootstrap, PWA capture, or authenticated shell on customer pages.
if (isPublicPortalRoute) {
  // Replace the admin application's browser identity with a customer-facing one.
  document.title = pathname === '/' ? 'نقطة الشحن | Charging Point' : 'نقطة الشحن | بوابة العميل';
  const description = document.querySelector('meta[name="description"]');
  description?.setAttribute('content', pathname === '/' ? 'نقطة الشحن — خدمة شحن منظّمة، أسعار واضحة، ومتابعة طلبات عبر QR.' : 'بوابة آمنة لعرض تفاصيل الطلب وإرسال إشعار الدفع.');
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
