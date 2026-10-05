import React from "react";
import { Zap } from "lucide-react";
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

  // Fallback: Default Iconic System Zap Logo (Pristine, no circular frame)
  return (
    <div
      style={{ width: size, height: size }}
      className={`flex items-center justify-center select-none shrink-0 ${className}`}
      aria-label="App Logo"
      data-testid="app-logo-default-container"
    >
      <Zap className="w-full h-full text-emerald-600 dark:text-emerald-400 fill-emerald-600/20 dark:fill-emerald-400/20" />
    </div>
  );
};

