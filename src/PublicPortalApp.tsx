import React from 'react';
import { I18nProvider } from './i18n/i18nContext';
import { PublicPaymentPage } from './components/pages/PublicPaymentPage';
import { PublicAboutPage } from './components/pages/PublicAboutPage';
import {
  PublicLandingDesign,
  PublicCustomerDesign,
  PublicOrderDesign,
} from './components/public/PublicVisualPages';
import './public-portal.css';

const PublicNotFound: React.FC = () => (
  <main className="public-not-found">
    <div className="public-not-found__mark" aria-hidden="true">✦</div>
    <p className="public-eyebrow">CUSTOMER PORTAL</p>
    <h1>الرابط غير صالح</h1>
    <p>تأكد من فتح رابط رمز QR الصحيح أو اطلب رابطًا جديدًا.</p>
  </main>
);

/**
 * Public-only entry point. Visual pages use static presentation placeholders and
 * do not fetch customer/order data or call payment, database, or sync services.
 */
const PublicPortalApp: React.FC = () => {
  const pathname = window.location.pathname;
  let content: React.ReactNode = <PublicNotFound />;

  if (pathname === '/' || pathname === '/public' || pathname === '/public/') {
    content = <PublicLandingDesign />;
  } else if (pathname === '/public/about') {
    content = <PublicAboutPage />;
  } else if (
    pathname.startsWith('/public/qr/customer/') ||
    pathname.startsWith('/c/')
  ) {
    content = <PublicCustomerDesign />;
  } else if (
    pathname.startsWith('/public/qr/order/') ||
    pathname.startsWith('/public/order/') ||
    pathname.startsWith('/o/')
  ) {
    content = <PublicOrderDesign />;
  } else if (pathname.startsWith('/pay/')) {
    // The separate payment page is intentionally left untouched in this design-only task.
    const token = pathname.slice('/pay/'.length).split('/')[0];
    content = token ? <PublicPaymentPage token={decodeURIComponent(token)} /> : <PublicNotFound />;
  }

  return <I18nProvider>{content}</I18nProvider>;
};

export default PublicPortalApp;
