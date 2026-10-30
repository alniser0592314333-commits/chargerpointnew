import React from "react";
import { useActiveLogo, getCanonicalQrLogo } from "../../services/storage/logoStorage";
import { useTheme } from "../../theme/themeContext";

const OFFICIAL_LOGO_PATH = "M 555 1094 L 599 1121 L 667 1155 L 722 1177 L 779 1195 L 819 1205 L 887 1216 L 925 1219 L 998 1217 L 946 1210 L 903 1200 L 855 1185 L 806 1165 L 754 1139 L 697 1105 L 622 1050 Z M 181 609 L 160 639 L 128 699 L 103 759 L 83 824 L 72 876 L 64 935 L 62 964 L 64 1050 L 68 1017 L 80 962 L 114 860 L 165 758 L 194 712 L 226 668 Z M 1183 293 L 1171 366 L 1140 458 L 1117 506 L 1089 555 L 1024 648 L 1072 716 L 1089 689 L 1126 615 L 1146 566 L 1169 494 L 1180 442 L 1187 384 L 1187 325 Z M 1099 158 L 1056 149 L 999 148 L 937 157 L 870 176 L 807 202 L 742 236 L 677 277 L 612 326 L 541 276 L 487 244 L 418 210 L 344 183 L 289 170 L 231 164 L 172 168 L 127 180 L 120 228 L 121 287 L 131 347 L 146 399 L 166 450 L 196 511 L 232 571 L 289 651 L 259 695 L 217 768 L 189 828 L 162 902 L 147 967 L 140 1024 L 141 1084 L 151 1134 L 196 1143 L 255 1144 L 305 1138 L 362 1124 L 430 1099 L 497 1066 L 563 1025 L 626 978 L 693 1026 L 747 1058 L 807 1087 L 888 1115 L 953 1129 L 1015 1135 L 1079 1132 L 1106 1127 L 1122 1121 L 1126 1089 L 1124 1010 L 1114 955 L 1093 885 L 1068 825 L 1041 773 L 1007 718 L 957 650 L 1008 571 L 1044 503 L 1075 430 L 1091 380 L 1105 316 L 1110 266 L 1109 207 Z M 349 720 L 397 774 L 457 834 L 559 921 L 473 979 L 382 1024 L 297 1051 L 265 1057 L 234 1059 L 233 1026 L 239 975 L 260 892 L 281 838 L 307 785 L 331 744 Z M 479 915 L 424 871 L 309 928 L 297 971 L 292 1005 L 339 988 L 392 964 Z M 693 920 L 744 878 L 813 811 L 895 716 L 915 740 L 946 785 L 967 821 L 992 873 L 1012 927 L 1023 967 L 1030 1004 L 1033 1048 L 1012 1050 L 956 1044 L 872 1021 L 783 980 L 741 955 Z M 888 811 L 837 862 L 880 967 L 962 992 L 948 941 L 931 896 Z M 611 424 L 684 484 L 744 543 L 803 609 L 834 649 L 785 709 L 723 774 L 673 821 L 624 862 L 582 830 L 516 771 L 455 710 L 401 649 L 440 596 L 497 531 L 553 475 Z M 614 557 L 593 563 L 580 570 L 556 593 L 546 612 L 542 627 L 541 656 L 551 687 L 573 713 L 605 729 L 639 731 L 667 722 L 683 711 L 696 697 L 705 682 L 711 664 L 712 631 L 703 602 L 691 585 L 679 574 L 649 559 Z M 204 250 L 234 248 L 265 251 L 308 259 L 363 276 L 411 296 L 462 322 L 521 359 L 546 379 L 451 464 L 344 578 L 289 497 L 245 412 L 229 372 L 213 319 L 206 281 Z M 271 313 L 284 362 L 302 412 L 322 460 L 349 514 L 398 458 L 399 451 L 354 343 L 312 325 Z M 1023 223 L 1025 225 L 1024 261 L 1018 302 L 1008 345 L 992 393 L 972 440 L 944 495 L 916 541 L 889 578 L 833 516 L 767 451 L 677 376 L 712 347 L 761 313 L 815 282 L 862 260 L 950 231 L 998 223 Z M 960 302 L 869 334 L 805 363 L 766 385 L 809 425 L 818 430 L 939 376 L 952 342 Z M 252 52 L 305 64 L 357 81 L 451 123 L 531 172 L 577 209 L 610 242 L 682 186 L 641 160 L 583 130 L 522 104 L 473 87 L 410 70 L 352 59 L 295 53 Z";

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
  const [isOnline, setIsOnline] = React.useState(
    () => typeof navigator === 'undefined' || navigator.onLine
  );
  const brandId = React.useId().replace(/:/g, '');

  React.useEffect(() => {
    const handleOnline = () => {
      setImgError(false);
      setIsOnline(true);
    };
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

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

  // QR selection stays unchanged. Other UI instances use the cached image bytes
  // while offline instead of switching to a different built-in mark.
  let logoUrl: string | undefined = isOnline ? customUrl : undefined;
  if (!logoUrl && !activeLogo.isDefault) {
    if (isQrVariant) {
      if (isOnline) logoUrl = getCanonicalQrLogo(activeLogo);
    } else {
      const effectiveVariant = variant === 'auto' ? resolvedTheme : variant;
      const candidate = effectiveVariant === 'dark'
        ? activeLogo.darkDataUrl
        : (activeLogo.whiteDataUrl || activeLogo.lightDataUrl || activeLogo.dataUrl);
      if (candidate && (isOnline || candidate.startsWith('data:image/'))) logoUrl = candidate;
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
      {isQrVariant ? (
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
      ) : (
      <svg viewBox="0 0 1254 1254" width={size} height={size} role="img" aria-label="Charging Point logo" focusable="false" style={{ color: isDark ? "#ffffff" : "#000000" }}>
        <path d={OFFICIAL_LOGO_PATH} fill="currentColor" fillRule="evenodd" clipRule="evenodd" />
      </svg>
      )}
    </div>
  );
};

