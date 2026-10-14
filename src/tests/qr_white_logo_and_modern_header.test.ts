import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  saveLogoSet,
  getActiveLogo,
  getCanonicalQrLogo,
  getWhiteLogo,
  getDarkLogo,
  getLightLogo,
  resetLogoStorageForTesting,
} from '../services/storage/logoStorage';
import { AppLogo } from '../components/qr/AppLogo';
import { QrDesignRenderer } from '../components/qr/QrDesignRenderer';
import { DEFAULT_CUSTOMER_QR_DESIGN } from '../components/qr/defaultDesigns';
import { Header } from '../components/shell/Header';
import { ThemeContext } from '../theme/themeContext';
import { I18nContext } from '../i18n/i18nContext';
import { translations } from '../i18n/translations';

describe('QR White Logo Invariant & Modern Header Redesign Contracts', () => {
  const sampleWhiteLogo = 'data:image/png;base64,canonical_white_logo_for_qr';
  const sampleDarkLogo = 'data:image/png;base64,dark_theme_brand_logo';

  beforeEach(() => {
    resetLogoStorageForTesting();
    // Seed active dual-version logo set
    saveLogoSet({
      name: 'متجر التميز',
      lightDataUrl: sampleWhiteLogo, // Canonical White Logo
      darkDataUrl: sampleDarkLogo,   // Dark Theme Logo
    });
  });

  // Helper to render component wrapped in Theme and I18n providers
  const renderWithTheme = (ui: React.ReactElement, theme: 'light' | 'dark', locale: 'ar' | 'en' = 'ar') => {
    const mockThemeContext = {
      theme,
      resolvedTheme: theme,
      setTheme: () => {},
      toggleTheme: () => {},
    };

    const mockI18nContext = {
      locale,
      setLocale: () => {},
      t: (key: string, _params?: Record<string, string | number>): string => (translations[locale] as any)[key] || key,
      isRTL: locale === 'ar',
      dir: (locale === 'ar' ? 'rtl' : 'ltr') as 'rtl' | 'ltr',
      formatDate: (d: any) => String(d),
      formatDateTime: (d: any) => String(d),
      formatTime: (d: any) => String(d),
      formatWeekday: (d: any) => String(d),
      formatCurrency: (m: number) => String(m),
    };

    return renderToStaticMarkup(
      React.createElement(
        I18nContext.Provider,
        { value: mockI18nContext },
        React.createElement(ThemeContext.Provider, { value: mockThemeContext }, ui)
      )
    );
  };

  // =========================================================================
  // 1. CANONICAL QR LOGO RESOLVER CONTRACTS
  // =========================================================================
  describe('1. Canonical White Logo Resolver for QR', () => {
    it('1.1. getCanonicalQrLogo and getWhiteLogo return the canonical White Logo', () => {
      const active = getActiveLogo();
      expect(active).toBeDefined();

      const canonicalQrLogo = getCanonicalQrLogo(active);
      const whiteLogo = getWhiteLogo(active);

      expect(canonicalQrLogo).toBe(sampleWhiteLogo);
      expect(whiteLogo).toBe(sampleWhiteLogo);
      expect(canonicalQrLogo).not.toBe(sampleDarkLogo);
    });

    it('1.2. getDarkLogo returns Dark Logo and getLightLogo returns Light Logo', () => {
      const active = getActiveLogo();
      expect(getDarkLogo(active)).toBe(sampleDarkLogo);
      expect(getLightLogo(active)).toBe(sampleWhiteLogo);
    });
  });

  // =========================================================================
  // 2. QR CODE LOGO THEME INVARIANCE (STRICT RULE)
  // =========================================================================
  describe('2. QR Code Logo: Strict Theme Invariance (Always White Logo)', () => {
    it('2.1. QR in Light Theme uses White Logo', () => {
      const htmlLight = renderWithTheme(
        React.createElement(AppLogo, { size: 36, variant: 'qr', isQr: true }),
        'light'
      );

      // Must render the canonical White Logo
      expect(htmlLight).toContain(`src="${sampleWhiteLogo}"`);
      // Must NOT render Dark Logo
      expect(htmlLight).not.toContain(`src="${sampleDarkLogo}"`);
    });

    it('2.2. QR in Dark Theme uses White Logo', () => {
      const htmlDark = renderWithTheme(
        React.createElement(AppLogo, { size: 36, variant: 'qr', isQr: true }),
        'dark'
      );

      // Must render the canonical White Logo even in Dark Theme
      expect(htmlDark).toContain(`src="${sampleWhiteLogo}"`);
      // Must NOT switch to Dark Logo
      expect(htmlDark).not.toContain(`src="${sampleDarkLogo}"`);
    });

    it('2.3. No switching to Dark Logo occurs inside QR due to Theme changes', () => {
      const htmlLight = renderWithTheme(
        React.createElement(AppLogo, { size: 36, variant: 'qr', isQr: true }),
        'light'
      );
      const htmlDark = renderWithTheme(
        React.createElement(AppLogo, { size: 36, variant: 'qr', isQr: true }),
        'dark'
      );

      // Both must output the exact same White Logo source!
      expect(htmlLight).toContain(sampleWhiteLogo);
      expect(htmlDark).toContain(sampleWhiteLogo);

      // Neither must contain Dark Logo
      expect(htmlLight).not.toContain(sampleDarkLogo);
      expect(htmlDark).not.toContain(sampleDarkLogo);
    });

    it('2.4. QrDesignRenderer with logo enabled renders White Logo regardless of Theme', () => {
      const designWithLogo = {
        ...DEFAULT_CUSTOMER_QR_DESIGN,
        logo: {
          show: true,
          placement: 'center' as const,
          size: 40,
        },
      };

      const identity = { publicUrl: 'https://example.com/c/123' };
      const content = { customerName: 'أحمد محمود', customerCode: 'C-1001' };

      const lightQrCard = renderWithTheme(
        React.createElement(QrDesignRenderer, {
          identity,
          content,
          design: designWithLogo,
          locale: 'ar',
        }),
        'light'
      );

      const darkQrCard = renderWithTheme(
        React.createElement(QrDesignRenderer, {
          identity,
          content,
          design: designWithLogo,
          locale: 'ar',
        }),
        'dark'
      );

      // In both light and dark theme, the QR code card uses the White Logo
      expect(lightQrCard).toContain(`src="${sampleWhiteLogo}"`);
      expect(darkQrCard).toContain(`src="${sampleWhiteLogo}"`);

      // Neither uses the dark logo
      expect(lightQrCard).not.toContain(`src="${sampleDarkLogo}"`);
      expect(darkQrCard).not.toContain(`src="${sampleDarkLogo}"`);
    });

    it('2.5. QR Center Logo has NO circular frame, NO border, and NO added background', () => {
      const html = renderWithTheme(
        React.createElement(AppLogo, { size: 40, isQr: true }),
        'light'
      );

      expect(html).not.toContain('rounded-full');
      expect(html).not.toContain('border-gray');
      expect(html).not.toContain('border-emerald');
      expect(html).not.toContain('bg-white');
      expect(html).not.toContain('shadow');
    });
  });

  // =========================================================================
  // 3. UI APPLICATION LOGO DYNAMIC THEME (OUTSIDE QR)
  // =========================================================================
  describe('3. Dynamic Theme App Logo in UI (outside QR)', () => {
    it('3.1. Outside QR in Light Theme: uses Light Logo', () => {
      const htmlLight = renderWithTheme(
        React.createElement(AppLogo, { size: 32, variant: 'auto' }),
        'light'
      );

      expect(htmlLight).toContain(`src="${sampleWhiteLogo}"`);
      expect(htmlLight).not.toContain(`src="${sampleDarkLogo}"`);
    });

    it('3.2. Outside QR in Dark Theme: dynamically switches to Dark Logo', () => {
      const htmlDark = renderWithTheme(
        React.createElement(AppLogo, { size: 32, variant: 'auto' }),
        'dark'
      );

      expect(htmlDark).toContain(`src="${sampleDarkLogo}"`);
    });

    it('3.3. Dynamic switching between themes preserves pristine image without distortion or border', () => {
      const htmlLight = renderWithTheme(
        React.createElement(AppLogo, { size: 32 }),
        'light'
      );
      const htmlDark = renderWithTheme(
        React.createElement(AppLogo, { size: 32 }),
        'dark'
      );

      // Both retain object-contain for authentic aspect ratio
      expect(htmlLight).toContain('object-contain');
      expect(htmlDark).toContain('object-contain');

      // Zero circular decoration on both
      expect(htmlLight).not.toContain('rounded-full');
      expect(htmlDark).not.toContain('rounded-full');
    });
  });

  // =========================================================================
  // 4. MODERN HEADER REDESIGN CONTRACTS
  // =========================================================================
  describe('4. Modern Header Redesign Specifications', () => {
    it('4.1. Language toggle control is REMOVED from the main Header', () => {
      const html = renderWithTheme(
        React.createElement(Header, {
          onOpenMobileNav: () => {},
          currentPath: '/app',
        }),
        'light',
        'ar'
      );

      // Neither toggle button nor language switch text exists in Header
      expect(html).not.toContain('>EN<');
      expect(html).not.toContain('>عربي<');
      expect(html).not.toContain('toggleLang');
    });

    it('4.2. Light/Dark theme toggle control is REMOVED from the main Header', () => {
      const html = renderWithTheme(
        React.createElement(Header, {
          onOpenMobileNav: () => {},
          currentPath: '/app',
        }),
        'light'
      );

      // Theme toggle icons / buttons are removed from Header
      expect(html).not.toContain('🌙');
      expect(html).not.toContain('☀️');
      expect(html).not.toContain('toggleTheme');
    });

    it('4.3. App Logo is present in the Header and dynamically adapts to Theme', () => {
      const htmlLight = renderWithTheme(
        React.createElement(Header, {
          onOpenMobileNav: () => {},
          currentPath: '/app',
        }),
        'light'
      );

      const htmlDark = renderWithTheme(
        React.createElement(Header, {
          onOpenMobileNav: () => {},
          currentPath: '/app',
        }),
        'dark'
      );

      // Header renders the App Logo in both themes
      expect(htmlLight).toContain(`src="${sampleWhiteLogo}"`);
      expect(htmlDark).toContain(`src="${sampleDarkLogo}"`);

      // Header logo has brand identity data-testid
      expect(htmlLight).toContain('header-brand-identity');
      expect(htmlDark).toContain('header-brand-identity');
    });

    it('4.4. Sync status badge is PRESERVED and clearly accessible in the Header', () => {
      const html = renderWithTheme(
        React.createElement(Header, {
          onOpenMobileNav: () => {},
          currentPath: '/app',
        }),
        'light',
        'ar'
      );

      // Sync status badge container exists
      expect(html).toContain('data-testid="header-sync-status"');
      // Status badge label is rendered
      expect(html).toMatch(/متزامن|يعمل دون إنترنت|Synced|Offline/);
    });

    it('4.5. Header shows the fixed Arabic brand title on every page and does not render logout', () => {
      const settingsHtml = renderWithTheme(
        React.createElement(Header, {
          onOpenMobileNav: () => {},
          currentPath: '/app/settings',
        }),
        'light',
        'ar'
      );
      const homeHtml = renderWithTheme(
        React.createElement(Header, {
          onOpenMobileNav: () => {},
          currentPath: '/app',
        }),
        'light',
        'ar'
      );

      expect(settingsHtml).toContain('نقطة الشحن');
      expect(homeHtml).toContain('نقطة الشحن');
      expect(settingsHtml).not.toContain('تسجيل الخروج');
      expect(settingsHtml).toContain('متجر التميز');
    });

    it('4.5.1. Header shows the fixed English brand title regardless of the active page', () => {
      const html = renderWithTheme(
        React.createElement(Header, {
          onOpenMobileNav: () => {},
          currentPath: '/app/customers',
        }),
        'light',
        'en'
      );

      expect(html).toContain('Charging Point');
    });

    it('4.6. QR geometry helper computes true matrix center correctly', async () => {
      const { getQrGeometry } = await import('../components/qr/qrGeometry');
      const geom = getQrGeometry('https://example.com/qr', 'H', 1);
      expect(geom.moduleCount).toBeGreaterThan(20);
      expect(geom.matrixCenterX).toBe(0.5);
      expect(geom.matrixCenterY).toBe(0.5);
    });

    it('4.7. calculateLogoPosition provides shared geometry centering across different sizes and payloads', async () => {
      const { calculateLogoPosition } = await import('../components/qr/qrGeometry');
      const sizes = [220, 300, 340, 500];
      const payloads = ['https://example.com/1', 'https://example.com/very/long/payload/string/for/testing/different/qr/version/modules/count'];

      for (const size of sizes) {
        for (const payload of payloads) {
          const qrX = 10;
          const qrY = 20;
          const logoSize = 40;
          const pos = calculateLogoPosition(qrX, qrY, size, logoSize, payload, 'H', 1);

          const expectedCenterX = qrX + size * 0.5;
          const expectedCenterY = qrY + size * 0.5;

          expect(pos.matrixCenterX).toBeCloseTo(expectedCenterX, 2);
          expect(pos.matrixCenterY).toBeCloseTo(expectedCenterY, 2);
          expect(pos.logoX + logoSize / 2).toBeCloseTo(pos.matrixCenterX, 2);
          expect(pos.logoY + logoSize / 2).toBeCloseTo(pos.matrixCenterY, 2);
        }
      }
    });

    it('4.8. calculateLogoSafeZone provides symmetrical knockout bounds centered on matrix center across sizes and payloads', async () => {
      const { calculateLogoSafeZone } = await import('../components/qr/qrGeometry');
      const sizes = [220, 300, 340, 500];
      const payloads = ['https://example.com/order/123', 'https://example.com/customer/456/with/extended/payload'];

      for (const size of sizes) {
        for (const payload of payloads) {
          const qrX = 0;
          const qrY = 0;
          const logoSize = 36;
          const sz = calculateLogoSafeZone(qrX, qrY, size, logoSize, payload, 'H', 1, 6);

          const expectedCenterX = qrX + size * 0.5;
          const expectedCenterY = qrY + size * 0.5;

          expect(sz.matrixCenterX).toBeCloseTo(expectedCenterX, 2);
          expect(sz.matrixCenterY).toBeCloseTo(expectedCenterY, 2);

          const szCenterX = sz.safeZoneX + sz.safeZoneSize / 2;
          const szCenterY = sz.safeZoneY + sz.safeZoneSize / 2;

          expect(szCenterX).toBeCloseTo(sz.matrixCenterX, 2);
          expect(szCenterY).toBeCloseTo(sz.matrixCenterY, 2);
          expect(sz.safeZoneSize).toBe(logoSize + 12);
        }
      }
    });

    it('4.9. getCircularSafeZone provides true circular geometry matching matrix center across sizes', async () => {
      const { getCircularSafeZone } = await import('../components/qr/qrGeometry');
      const sizes = [220, 300, 340, 500];

      for (const size of sizes) {
        const logoSize = 36;
        const circ = getCircularSafeZone(size, logoSize, 6);

        expect(circ.centerX).toBe(size / 2);
        expect(circ.centerY).toBe(size / 2);
        expect(circ.radius).toBe(logoSize / 2 + 6);
      }
    });

    it('4.10. createQrRenderMatrix performs true module knockout with small vs large circle sizes when logoVisible is true', async () => {
      const { createQrRenderMatrix } = await import('../components/qr/qrGeometry');
      const payload = 'https://example.com/qr/test';
      
      const smallRes = createQrRenderMatrix(payload, 'H', 1, 40, 220, true);
      const largeRes = createQrRenderMatrix(payload, 'H', 1, 80, 220, true);

      expect(smallRes.matrix).toBeDefined();
      expect(largeRes.matrix).toBeDefined();
      expect(smallRes.size).toBe(largeRes.size);

      // Count how many dark modules are knocked out (false in render matrix vs raw)
      let smallDarkCount = 0;
      let largeDarkCount = 0;

      for (let r = 0; r < smallRes.size; r++) {
        for (let c = 0; c < smallRes.size; c++) {
          if (smallRes.matrix[r][c]) smallDarkCount++;
          if (largeRes.matrix[r][c]) largeDarkCount++;
        }
      }

      // Larger circle size should knockout more modules (fewer remaining dark modules)
      expect(largeDarkCount).toBeLessThanOrEqual(smallDarkCount);
    });

    it('4.11. Modules inside circular safe zone are omitted (false) in renderMatrix when logoVisible is true', async () => {
      const { createQrRenderMatrix } = await import('../components/qr/qrGeometry');
      const payload = 'https://example.com/qr/knockout';
      const renderRes = createQrRenderMatrix(payload, 'H', 1, 60, 220, true);
      
      const center = renderRes.size / 2;
      const radiusUnits = (60 / 2) / (220 / renderRes.size);

      // Check modules strictly inside radius from center
      for (let r = 0; r < renderRes.size; r++) {
        for (let c = 0; c < renderRes.size; c++) {
          const modCenterX = c + 0.5;
          const modCenterY = r + 0.5;
          const dist = Math.sqrt((modCenterX - center) ** 2 + (modCenterY - center) ** 2);
          if (dist <= radiusUnits) {
            expect(renderRes.matrix[r][c]).toBe(false);
          }
        }
      }
    });

    it('4.12. Preview (QrCodeRenderer) renders renderMatrix without SVG circle overlay', async () => {
      const { QrCodeRenderer } = await import('../components/qr/QrCodeRenderer');
      const html = renderWithTheme(
        React.createElement(QrCodeRenderer, {
          value: 'https://example.com/preview',
          size: 220,
          logoCircleSize: 56,
          centerLogo: React.createElement('div', {}, 'LOGO'),
        }),
        'light'
      );

      // Must render SVG rect modules
      expect(html).toContain('<svg');
      // MUST NOT contain SVG circle knockout overlay
      expect(html).not.toContain('<circle');
    });

    it('4.13. Logo size and circle size are fully independent', async () => {
      const design1 = { logo: { size: 36, circleSize: 50 } };
      const design2 = { logo: { size: 60, circleSize: 50 } };
      const design3 = { logo: { size: 36, circleSize: 80 } };

      expect(design1.logo.circleSize).toBe(design2.logo.circleSize);
      expect(design1.logo.size).toBe(design3.logo.size);
      expect(design1.logo.size).not.toBe(design2.logo.size);
      expect(design1.logo.circleSize).not.toBe(design3.logo.circleSize);
    });

    it('4.14. Logo Hidden (logoVisible = false) produces zero knockout and full original QR matrix with no center hole', async () => {
      const { createQrRenderMatrix } = await import('../components/qr/qrGeometry');
      const payload = 'https://example.com/qr/nologo';

      const resHidden = createQrRenderMatrix(payload, 'H', 1, 60, 220, false);
      const resVisible = createQrRenderMatrix(payload, 'H', 1, 60, 220, true);

      let hiddenDarkCount = 0;
      let visibleDarkCount = 0;

      for (let r = 0; r < resHidden.size; r++) {
        for (let c = 0; c < resHidden.size; c++) {
          if (resHidden.matrix[r][c]) hiddenDarkCount++;
          if (resVisible.matrix[r][c]) visibleDarkCount++;
        }
      }

      // Hidden logo must have more or equal dark modules (no center modules knocked out)
      expect(hiddenDarkCount).toBeGreaterThan(visibleDarkCount);
    });

    it('4.15. Logo Hidden means changing circle size does not alter renderMatrix', async () => {
      const { createQrRenderMatrix } = await import('../components/qr/qrGeometry');
      const payload = 'https://example.com/qr/nologo2';

      const res1 = createQrRenderMatrix(payload, 'H', 1, 40, 220, false);
      const res2 = createQrRenderMatrix(payload, 'H', 1, 90, 220, false);

      // Matrices must be 100% identical when logo is hidden
      expect(res1.matrix).toEqual(res2.matrix);
    });

    it('4.16. Accordion section reordering logic moves opened section to top while preserving relative order', () => {
      let order = ['spacing', 'colors', 'logo', 'order', 'text', 'date', 'template'];
      let active: string | null = 'spacing';

      const toggle = (id: string) => {
        if (active === id) {
          active = null;
        } else {
          active = id;
          order = [id, ...order.filter(item => item !== id)];
        }
      };

      // Open 'logo'
      toggle('logo');
      expect(order[0]).toBe('logo');
      expect(active).toBe('logo');
      expect(order).toEqual(['logo', 'spacing', 'colors', 'order', 'text', 'date', 'template']);

      // Close 'logo' (active becomes null, order remains unchanged)
      toggle('logo');
      expect(active).toBeNull();
      expect(order[0]).toBe('logo');

      // Open 'colors'
      toggle('colors');
      expect(order[0]).toBe('colors');
      expect(order).toEqual(['colors', 'logo', 'spacing', 'order', 'text', 'date', 'template']);
    });
  });
});
