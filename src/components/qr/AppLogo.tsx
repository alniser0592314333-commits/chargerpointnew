import React from "react";
import { useActiveLogo, getCanonicalQrLogo } from "../../services/storage/logoStorage";
import { useTheme } from "../../theme/themeContext";

const OFFICIAL_LOGO_PATH = "M 556 1093 556 1095 561 1097 569 1103 572 1104 589 1115 594 1117 601 1122 661 1152 668 1154 677 1159 679 1159 682 1161 684 1161 689 1164 704 1169 707 1171 712 1172 715 1174 726 1177 729 1179 744 1184 747 1184 760 1189 763 1189 781 1195 784 1195 785 1196 788 1196 789 1197 792 1197 796 1199 800 1199 809 1202 813 1202 822 1205 842 1208 843 1209 848 1209 849 1210 854 1210 855 1211 860 1211 861 1212 867 1212 868 1213 875 1213 876 1214 884 1214 885 1215 893 1215 894 1216 904 1216 909 1218 910 1217 919 1217 920 1218 929 1219 930 1218 974 1218 975 1217 992 1217 990 1216 983 1216 982 1215 967 1214 962 1212 961 1213 960 1212 956 1212 955 1211 936 1208 931 1206 927 1206 926 1205 903 1200 899 1198 889 1196 876 1191 873 1191 855 1185 847 1181 839 1179 832 1175 822 1172 810 1166 808 1166 759 1142 757 1140 750 1137 748 1135 741 1132 739 1130 722 1121 706 1110 698 1106 681 1094 678 1093 674 1090 672 1087 670 1087 669 1085 668 1086 661 1080 654 1076 642 1067 640 1064 637 1063 622 1051 Z M 181 609 170 624 162 638 160 639 159 643 157 645 155 650 152 653 152 655 150 657 148 663 140 675 139 679 137 681 132 691 132 693 125 706 125 708 121 715 119 722 116 727 116 729 106 752 102 766 100 769 97 778 96 784 93 790 93 793 87 811 87 814 86 815 86 818 85 819 85 822 84 823 84 826 83 827 83 830 80 839 80 843 78 848 78 852 77 853 74 872 73 873 73 878 72 879 72 884 71 885 71 890 70 891 70 897 69 898 69 904 68 905 67 920 66 921 65 939 64 940 64 950 63 951 63 972 62 973 62 1015 63 1016 63 1035 64 1036 64 1045 65 1043 65 1036 66 1035 66 1030 67 1029 68 1017 69 1016 69 1011 70 1010 70 1006 71 1005 74 986 75 985 75 982 76 981 76 978 77 977 82 954 84 950 85 943 89 933 91 923 102 890 104 887 110 869 113 864 113 862 118 852 120 845 145 793 147 791 152 780 154 778 161 764 169 752 171 747 177 739 178 736 186 724 188 723 187 722 190 720 189 719 197 707 200 705 200 703 202 700 205 698 204 697 220 675 223 673 224 670 226 668 225 664 219 658 212 648 208 644 208 642 204 639 205 638 201 635 201 633 198 631 198 629 194 626 Z M 1183 296 1182 296 1182 306 1181 307 1181 314 1180 315 1180 320 1179 321 1179 327 1178 328 1178 333 1176 339 1176 344 1174 349 1174 353 1172 358 1172 362 1171 363 1168 378 1166 382 1164 392 1161 399 1161 402 1153 426 1151 429 1151 431 1149 434 1148 439 1146 442 1142 454 1139 459 1139 461 1131 477 1131 479 1110 520 1108 522 1098 541 1091 551 1079 572 1069 587 1066 589 1066 591 1064 592 1064 594 1059 601 1057 602 1057 604 1055 605 1055 607 1053 608 1052 611 1049 613 1050 614 1047 616 1048 617 1045 619 1045 621 1042 624 1040 628 1037 630 1037 632 1034 634 1035 635 1032 637 1032 639 1024 648 1028 655 1041 671 1043 675 1049 682 1072 715 1077 708 1082 698 1086 693 1086 691 1088 689 1091 682 1095 677 1096 673 1100 667 1107 652 1109 650 1111 644 1123 621 1125 614 1135 593 1140 578 1142 575 1143 570 1145 567 1146 562 1148 559 1161 520 1161 517 1164 510 1165 503 1167 499 1167 496 1168 495 1168 492 1169 491 1169 488 1172 479 1173 470 1175 465 1179 440 1180 439 1180 433 1181 432 1181 426 1182 425 1183 412 1184 411 1185 390 1186 389 1187 340 1186 339 1186 321 1185 320 1185 309 1184 308 1184 300 1183 299 Z M 1098 158 1054 149 1002 148 933 158 868 177 825 194 738 239 662 288 613 326 548 281 484 243 429 215 347 184 288 170 248 165 188 166 128 180 120 232 121 285 130 342 147 401 176 471 204 524 250 597 290 651 241 726 202 799 179 853 161 906 147 968 140 1028 142 1091 152 1134 199 1143 250 1144 303 1138 365 1123 418 1104 491 1069 565 1023 626 977 676 1014 749 1059 810 1088 889 1115 948 1128 1024 1135 1077 1132 1105 1127 1121 1121 1126 1087 1126 1035 1123 1004 1109 936 1090 877 1071 832 1035 764 1001 710 956 650 999 585 1043 505 1068 448 1090 383 1106 308 1110 261 1108 200 Z M 348 719 443 820 496 869 560 921 475 978 393 1020 308 1049 269 1057 233 1060 232 1033 240 968 263 883 301 796 326 751 Z M 478 915 424 872 310 927 299 964 292 1004 325 993 383 968 434 942 Z M 691 920 750 872 819 804 895 715 945 783 975 836 993 875 1011 923 1023 966 1032 1015 1034 1049 1001 1050 953 1044 904 1032 863 1018 827 1003 779 978 730 948 Z M 888 812 838 862 843 878 880 967 961 991 949 945 930 894 Z M 611 423 661 463 736 534 790 593 835 650 755 742 688 808 624 863 573 823 506 762 445 700 400 649 441 594 487 541 568 460 Z M 615 557 582 569 557 592 544 619 541 655 553 690 572 712 599 727 617 731 638 731 670 720 695 698 709 671 713 646 712 632 701 599 689 583 665 565 644 558 Z M 204 250 206 248 260 250 300 257 358 274 407 294 457 319 499 344 547 378 460 456 387 531 345 580 315 539 280 482 238 397 212 317 205 278 Z M 271 314 286 367 303 414 329 475 349 514 397 459 398 450 354 344 314 326 Z M 1024 222 1025 249 1018 306 1005 357 991 396 952 481 916 542 890 579 840 524 776 460 676 376 714 345 759 314 841 269 887 250 937 234 988 224 Z M 960 303 910 318 822 355 766 385 817 430 940 375 952 341 Z M 259 53 289 59 363 83 463 129 510 157 545 182 584 215 609 241 681 186 637 158 585 131 484 91 412 71 361 61 300 54";

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

