import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

const root = createRoot(document.getElementById('root')!);
const pathname = window.location.pathname;
const isPublicPortalRoute =
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
