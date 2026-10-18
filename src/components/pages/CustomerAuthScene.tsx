import React from 'react';

/**
 * Decorative illustration used by the customer sign-in / password pages:
 * a night sky with a moon, layered mountains and a pine forest in teal and
 * orange. Purely visual — it carries no data and no behaviour.
 *
 * `uid` keeps gradient ids unique when the scene is rendered more than once.
 */
export const CustomerAuthScene: React.FC<{ uid: string; className?: string }> = ({ uid, className }) => {
  const id = (name: string) => `${uid}-${name}`;
  const pines = [
    [40, 640, 1.0], [86, 660, 0.8], [130, 630, 1.15], [176, 655, 0.85], [222, 640, 1.0],
    [560, 640, 1.05], [604, 625, 1.2], [650, 650, 0.85], [696, 635, 1.0], [740, 655, 0.8],
  ] as const;
  return (
    <svg
      viewBox="0 0 800 700"
      preserveAspectRatio="xMidYMid slice"
      className={className}
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={id('sky')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0c4b5b" />
          <stop offset="0.55" stopColor="#12687a" />
          <stop offset="1" stopColor="#1a8a94" />
        </linearGradient>
        <radialGradient id={id('moon')} cx="0.4" cy="0.38" r="0.7">
          <stop offset="0" stopColor="#ffe3b0" />
          <stop offset="0.6" stopColor="#f6b25f" />
          <stop offset="1" stopColor="#e9893f" />
        </radialGradient>
        <radialGradient id={id('glow')} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffd9a0" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ffd9a0" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id('peak-dark')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1b7f8c" />
          <stop offset="1" stopColor="#0d4656" />
        </linearGradient>
        <linearGradient id={id('peak-light')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f7fbfa" />
          <stop offset="1" stopColor="#8fdcd9" />
        </linearGradient>
        <linearGradient id={id('peak-warm')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ef8a4b" />
          <stop offset="1" stopColor="#b8481f" />
        </linearGradient>
        <linearGradient id={id('hill')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f2a65a" />
          <stop offset="1" stopColor="#c8582a" />
        </linearGradient>
        <linearGradient id={id('mist')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd39a" stopOpacity="0" />
          <stop offset="1" stopColor="#ffd39a" stopOpacity="0.55" />
        </linearGradient>
      </defs>

      <rect width="800" height="700" fill={`url(#${id('sky')})`} />

      {/* soft swirling clouds */}
      <g fill="none" strokeLinecap="round">
        <path d="M-20 130C120 70 210 190 340 120S560 40 830 130" stroke="#3aa6ad" strokeOpacity=".28" strokeWidth="34" />
        <path d="M-30 250C90 200 190 300 310 240S560 170 830 250" stroke="#e8884a" strokeOpacity=".22" strokeWidth="22" />
        <path d="M-10 60C140 10 260 90 420 40S690 20 820 70" stroke="#7fd3d0" strokeOpacity=".16" strokeWidth="18" />
      </g>

      {/* stars */}
      <g fill="#e9fbf7">
        {[[90, 80, 2.2], [210, 150, 1.6], [330, 60, 2], [470, 110, 1.4], [610, 70, 2.2], [720, 160, 1.6], [150, 230, 1.4], [680, 260, 1.8], [540, 200, 1.2], [40, 170, 1.4]].map(([x, y, r], i) => (
          <circle key={i} cx={x} cy={y} r={r} opacity={0.5 + (i % 3) * 0.2} />
        ))}
      </g>
      <path d="M640 130l2.5 7 7 2.5-7 2.5-2.5 7-2.5-7-7-2.5 7-2.5z" fill="#e9fbf7" opacity=".7" />

      {/* moon */}
      <circle cx="400" cy="290" r="190" fill={`url(#${id('glow')})`} />
      <circle cx="400" cy="290" r="100" fill={`url(#${id('moon')})`} />
      <g fill="#c96f2d" opacity=".28">
        <circle cx="370" cy="262" r="14" />
        <circle cx="430" cy="318" r="19" />
        <circle cx="388" cy="333" r="9" />
        <circle cx="432" cy="254" r="8" />
      </g>

      {/* distant dark ridges */}
      <path d="M-20 470L90 380L170 450L260 350L360 470L470 400L560 470L660 370L760 450L840 400V700H-20Z" fill={`url(#${id('peak-dark')})`} opacity=".85" />

      {/* main peak with snow and warm side */}
      <path d="M150 640L360 330L430 410L520 290L760 640Z" fill={`url(#${id('peak-dark')})`} />
      <path d="M520 290L760 640H610L560 470L520 400Z" fill={`url(#${id('peak-warm')})`} />
      <path d="M520 290L470 360L500 380L478 440L540 400L560 470L585 390Z" fill={`url(#${id('peak-light')})`} />
      <path d="M360 330L300 420L335 410L318 480L380 410L430 410Z" fill={`url(#${id('peak-light')})`} opacity=".95" />
      <path d="M300 420L150 640H300L318 480Z" fill={`url(#${id('peak-warm')})`} opacity=".9" />

      {/* warm foothills + glow */}
      <path d="M-20 600C120 540 230 580 340 560S600 520 840 590V700H-20Z" fill={`url(#${id('hill')})`} />
      <rect x="-20" y="520" width="860" height="180" fill={`url(#${id('mist')})`} />
      <path d="M-20 650C140 610 260 650 400 630S660 600 840 650V700H-20Z" fill="#0b3b43" />

      {/* pines */}
      <g fill="#082d34">
        {pines.map(([x, y, s], i) => (
          <path
            key={i}
            transform={`translate(${x} ${y}) scale(${s})`}
            d="M0 -70L16 -38H8L22 -10H10L26 18H-26L-10 -10H-22L-8 -38H-16Z"
          />
        ))}
      </g>
      <rect x="-20" y="676" width="860" height="40" fill="#082d34" />
    </svg>
  );
};

/**
 * Hidden SVG that defines the organic panel edges used by `.cp-auth-art`.
 * Coordinates are in objectBoundingBox units so the shape scales with the panel.
 */
export const CustomerAuthClipDefs: React.FC = () => (
  <svg width="0" height="0" aria-hidden="true" focusable="false" className="absolute">
    <defs>
      {/* desktop: panel on the left, wavy edge on its right side */}
      <clipPath id="cp-auth-clip-desktop" clipPathUnits="objectBoundingBox">
        <path d="M0 0H0.84C0.9 0.07 0.82 0.15 0.86 0.24C0.9 0.33 1 0.34 0.99 0.46C0.98 0.58 0.86 0.6 0.88 0.72C0.9 0.84 1 0.86 0.96 0.94C0.95 0.97 0.93 0.99 0.9 1H0Z" />
      </clipPath>
      {/* mobile: banner on top, wavy bottom edge */}
      <clipPath id="cp-auth-clip-mobile" clipPathUnits="objectBoundingBox">
        <path d="M0 0H1V0.78C0.9 0.9 0.82 0.74 0.7 0.84C0.58 0.94 0.5 0.76 0.38 0.86C0.26 0.96 0.14 0.8 0 0.92Z" />
      </clipPath>
    </defs>
  </svg>
);
