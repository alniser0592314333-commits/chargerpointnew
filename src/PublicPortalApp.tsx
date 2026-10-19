import React from 'react';
import { I18nProvider } from './i18n/i18nContext';
import { ThemeProvider } from './theme/themeContext';
import { CustomerAccountPage } from './components/pages/CustomerAccountPage';
import { PublicOrderPage } from './components/pages/PublicOrderPage';
import { PublicPaymentPage } from './components/pages/PublicPaymentPage';
import { PublicAboutPage } from './components/pages/PublicAboutPage';
import { PublicLandingPage } from './components/pages/PublicLandingPage';
import './public-landing.css';
import { FirstVisitWelcomeIntro } from './components/pages/FirstVisitWelcomeIntro';
import './public-portal.css';

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
  const pathname = window.location.pathname;
  let content: React.ReactNode = <PublicNotFound />;
  let welcomeEnabled = pathname === '/public/about';

  if (pathname === '/') {
    content = <PublicLandingPage />;
  } else if (pathname === '/public/about') {
    content = <PublicLandingPage />;
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

  return <ThemeProvider><I18nProvider><FirstVisitWelcomeIntro enabled={welcomeEnabled} />{content}</I18nProvider></ThemeProvider>;
};

export default PublicPortalApp;
