import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

const root = createRoot(document.getElementById('root')!);
const pathname = window.location.pathname;
const isAdminRoute = pathname === '/admin' || pathname.startsWith('/admin/');
const isPublicPortalRoute =
  pathname === '/' ||
  pathname === '/public' ||
  pathname === '/public/' ||
  pathname === '/public/about' ||
  pathname.startsWith('/c/') ||
  pathname.startsWith('/o/') ||
  pathname.startsWith('/pay/') ||
  pathname.startsWith('/public/order/') ||
  pathname.startsWith('/public/qr/customer/') ||
  pathname.startsWith('/public/qr/order/');

// Public pages are isolated from the admin bootstrap. The admin component is unchanged
// and remains available at /admin.
if (isPublicPortalRoute && !isAdminRoute) {
  document.title = 'نقطة الشحن | بوابة العميل';
  const description = document.querySelector('meta[name="description"]');
  description?.setAttribute('content', 'موقع نقطة الشحن العام وبوابة عرض تفاصيل الطلب والعميل.');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#031817');
  document.querySelector('link[rel="manifest"]')?.remove();
  document.querySelector('link[rel="apple-touch-icon"]')?.remove();
  document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.remove();
  document.querySelector('meta[name="mobile-web-app-capable"]')?.remove();
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.remove();
  document.documentElement.classList.remove('light');
  document.documentElement.classList.add('dark');
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
