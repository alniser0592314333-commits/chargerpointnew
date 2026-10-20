import React from "react";
import { useActiveLogo, getCanonicalQrLogo } from "../../services/storage/logoStorage";
import { useTheme } from "../../theme/themeContext";

/**
 * App Logo Primitive & Configuration
 * Provides raw, pristine brand logo rendering across QR codes, system headers, and settings.
 * Enforces strict zero-decoration rules:
 * - NO artificial circle wrapper
 * - NO added border or frame
 * - NO added background or tint
 * - NO circular mask or clipping
 * - NO shadow
 * - Full preservation of PNG transparency and native aspect ratio
 *
 * Rules:
 * 1. QR Codes: ALWAYS use the canonical WHITE LOGO from Logo Manager, strictly independent of theme.
 * 2. UI Elements (outside QR): DYNAMIC based on Theme (Light Logo for light theme, Dark Logo for dark theme).
 */
export interface AppLogoProps {
  className?: string;
  size?: number;
  customUrl?: string;
  variant?: 'light' | 'dark' | 'auto' | 'qr' | 'white';
  isQr?: boolean;
}

export const AppLogo: React.FC<AppLogoProps> = ({
  className = "",
  size = 28,
  customUrl,
  variant = 'auto',
  isQr = false,
}) => {
  const activeLogo = useActiveLogo();
  const [imgError, setImgError] = React.useState(false);
  const brandId = React.useId().replace(/:/g, '');

  // Determine current active theme (light or dark)
  let resolvedTheme: 'light' | 'dark' = 'light';
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const themeContext = useTheme();
    resolvedTheme = themeContext.resolvedTheme;
  } catch {
    // Fallback if rendered outside ThemeProvider
    if (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')) {
      resolvedTheme = 'dark';
    }
  }

  // Canonical QR Logo rule: If isQr is true or variant is 'qr' or 'white',
  // ALWAYS use the canonical White Logo from Logo Manager, strictly ignoring current UI theme.
  const isQrVariant = isQr || variant === 'qr' || variant === 'white';

  let logoUrl: string | undefined = customUrl;
  if (!logoUrl && !activeLogo.isDefault) {
    if (isQrVariant) {
      logoUrl = getCanonicalQrLogo(activeLogo);
    } else {
      const effectiveVariant = variant === 'auto' ? resolvedTheme : variant;
      if (effectiveVariant === 'dark') {
        logoUrl = activeLogo.darkDataUrl;
      } else {
        // Light Theme UI strictly uses the canonical White Logo
        logoUrl = activeLogo.whiteDataUrl || activeLogo.lightDataUrl || activeLogo.dataUrl;
      }
    }
  }

  // If custom logo URL is available and hasn't errored, render raw image
  if (logoUrl && !imgError) {
    return (
      <div
        style={{ width: size, height: size }}
        className={`flex items-center justify-center select-none shrink-0 overflow-visible ${className}`}
        aria-label="App Logo"
        data-testid="app-logo-image-container"
        data-logo-variant={isQrVariant ? 'qr-canonical-white' : (variant === 'auto' ? resolvedTheme : variant)}
      >
        <img
          src={logoUrl}
          alt={activeLogo.name || "Brand Logo"}
          onError={() => setImgError(true)}
          className="w-full h-full object-contain"
        />
      </div>
    );
  }

  // Built-in official brand mark. It is rendered inline (not fetched from the
  // network), so the mountain-and-moon identity is always available offline.
  // A configured custom logo still takes precedence whenever it is available.
  const isDark = resolvedTheme === 'dark' || isQrVariant;
  const sky = isDark ? '#082b32' : '#e8f6f3';
  const distant = isDark ? '#126071' : '#5c9f9a';
  const mountain = isDark ? '#0b3f4a' : '#236c72';
  const warm = '#e88745';
  const snow = isDark ? '#e6fbf5' : '#ffffff';

  return (
    <div
      style={{ width: size, height: size }}
      className={`flex items-center justify-center select-none shrink-0 ${className}`}
      aria-label="Charging Point"
      data-testid="app-logo-default-container"
    >
      <svg
        viewBox="0 0 128 128"
        width={size}
        height={size}
        role="img"
        aria-label="Charging Point mountain and moon logo"
        focusable="false"
      >
        <defs>
          <linearGradient id={`${brandId}-sky`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={sky} />
            <stop offset="1" stopColor={isDark ? '#124d55' : '#bfe8df'} />
          </linearGradient>
          <linearGradient id={`${brandId}-warm`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f5b567" />
            <stop offset="1" stopColor={warm} />
          </linearGradient>
        </defs>
        <rect width="128" height="128" rx="28" fill={`url(#${brandId}-sky)`} />
        <circle cx="84" cy="34" r="17" fill="#f6bd68" />
        <circle cx="89" cy="29" r="16" fill={sky} opacity=".72" />
        <g fill={distant} opacity=".85">
          <path d="M0 76 24 53 39 68 62 42 88 72 105 55 128 74V128H0Z" />
        </g>
        <path d="M8 110 44 52 61 73 79 40 122 110Z" fill={mountain} />
        <path d="M79 40 122 110H95L82 77 75 59Z" fill={`url(#${brandId}-warm)`} />
        <path d="M79 40 68 56 76 57 72 68 84 60 88 72 93 55Z" fill={snow} />
        <path d="M44 52 34 68 42 66 39 78 49 66 61 73Z" fill={snow} />
        <path d="M0 105Q28 91 55 103T128 100V128H0Z" fill={isDark ? '#082d34' : '#23646a'} />
        <g fill={isDark ? '#082d34' : '#16494e'}>
          <path d="M17 110 23 96 29 110Z M22 115 29 98 36 115Z" />
          <path d="M99 112 105 97 111 112Z M106 116 113 99 120 116Z" />
        </g>
      </svg>
    </div>
  );
};

