import React from 'react';
import { I18nProvider } from './i18n/i18nContext';
import { PublicCustomerQrPage } from './components/pages/PublicCustomerQrPage';
import { PublicOrderPage } from './components/pages/PublicOrderPage';
import { PublicPaymentPage } from './components/pages/PublicPaymentPage';
import { PublicAboutPage } from './components/pages/PublicAboutPage';
import LegacyPublicDesigns from './components/public/LegacyPublicDesigns';
import './public-portal.css';

const publicRoutes = [
  { prefix: '/public/qr/customer/', render: (token: string) => <PublicCustomerQrPage token={token} /> },
  { prefix: '/public/qr/order/', render: (token: string) => <PublicOrderPage token={token} /> },
  { prefix: '/public/order/', render: (token: string) => <PublicOrderPage token={token} /> },
  { prefix: '/c/', render: (token: string) => <PublicCustomerQrPage token={token} /> },
  { prefix: '/o/', render: (token: string) => <PublicOrderPage token={token} /> },
  { prefix: '/pay/', render: (token: string) => <PublicPaymentPage token={token} /> },
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
  const pathname = window.location.pathname;
  let content: React.ReactNode = <PublicNotFound />;

  // These routes are static design previews only. They intentionally use
  // local sample content and do not read/write app state or the database.
  if (pathname === '/design/home') {
    content = <LegacyPublicDesigns page="home" />;
  } else if (pathname === '/design/customer') {
    content = <LegacyPublicDesigns page="customer" />;
  } else if (pathname === '/design/order') {
    content = <LegacyPublicDesigns page="order" />;
  } else if (pathname === '/public/about') {
    content = <PublicAboutPage />;
  } else {
    const route = publicRoutes.find((item) => pathname.startsWith(item.prefix));
    if (route) {
      const rawToken = pathname.slice(route.prefix.length).split('/')[0];
      try {
        const token = decodeURIComponent(rawToken);
        content = token && !token.includes('..') ? route.render(token) : <PublicNotFound />;
      } catch {
        content = <PublicNotFound />;
      }
    }
  }

  return <I18nProvider>{content}</I18nProvider>;
};

export default PublicPortalApp;
