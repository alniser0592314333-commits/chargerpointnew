import React, { useEffect, useRef } from 'react';

export type BackgroundState = 'charging' | 'charged' | 'delivered-paid' | 'delivered-unpaid';

export interface EnergyCanvasBackgroundProps {
  state: BackgroundState;
  theme: 'light' | 'dark';
  className?: string;
}

interface Particle {
  x: number;
  y: number;
  radius: number;
  speedY: number;
  driftAmp: number;
  driftSpeed: number;
  driftPhase: number;
  baseAlpha: number;
  alpha: number;
  pulsePhase: number;
  pulseSpeed: number;
}

interface EnergyStream {
  x: number;
  y: number;
  width: number;
  height: number;
  speedY: number;
  alpha: number;
  maxAlpha: number;
  phase: number;
}

interface GlowingOrb {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  radius: number;
  alpha: number;
  pulsePhase: number;
  colorIdx: number;
}

interface ColorRGB {
  r: number;
  g: number;
  b: number;
}

interface StateColorPalette {
  primary: ColorRGB;
  secondary: ColorRGB;
  accent: ColorRGB;
  beam: ColorRGB;
  speedMultiplier: number;
  particleDensity: number;
  glowIntensity: number;
}

// State color schemes for Dark and Light themes
const PALETTES: Record<'dark' | 'light', Record<BackgroundState, StateColorPalette>> = {
  dark: {
    charging: {
      // Dynamic electric cyan and teal
      primary: { r: 14, g: 165, b: 233 },    // Electric sky cyan
      secondary: { r: 16, g: 185, b: 129 },  // Radiant emerald
      accent: { r: 56, g: 189, b: 248 },     // Vibrant neon cyan
      beam: { r: 45, g: 212, b: 191 },       // Bright teal
      speedMultiplier: 1.4,
      particleDensity: 48,
      glowIntensity: 0.65,
    },
    charged: {
      // Serene, steady luminous emerald & jade
      primary: { r: 16, g: 185, b: 129 },    // Pure emerald
      secondary: { r: 52, g: 211, b: 153 },  // Mint jade
      accent: { r: 110, g: 231, b: 183 },    // Soft neon mint
      beam: { r: 16, g: 185, b: 129 },       // Steady emerald beam
      speedMultiplier: 0.85,
      particleDensity: 38,
      glowIntensity: 0.68,
    },
    'delivered-paid': {
      // Grounded luxury forest emerald with champagne gold specks
      primary: { r: 13, g: 148, b: 136 },    // Deep teal
      secondary: { r: 16, g: 185, b: 129 },  // Emerald
      accent: { r: 245, g: 158, b: 11 },     // Champagne amber highlight
      beam: { r: 20, g: 184, b: 166 },       // Subtle teal
      speedMultiplier: 0.65,
      particleDensity: 32,
      glowIntensity: 0.58,
    },
    'delivered-unpaid': {
      // Refined coral amber & warm apricot warning (sophisticated, non-jarring)
      primary: { r: 245, g: 158, b: 11 },    // Amber
      secondary: { r: 244, g: 63, b: 94 },   // Soft rose coral
      accent: { r: 251, g: 146, b: 60 },     // Apricot
      beam: { r: 234, g: 88, b: 12 },        // Warm burnt orange
      speedMultiplier: 1.05,
      particleDensity: 42,
      glowIntensity: 0.62,
    },
  },
  light: {
    charging: {
      primary: { r: 13, g: 148, b: 136 },    // Rich teal
      secondary: { r: 14, g: 165, b: 233 },  // Sky cyan
      accent: { r: 16, g: 185, b: 129 },     // Fresh emerald
      beam: { r: 20, g: 184, b: 166 },
      speedMultiplier: 1.25,
      particleDensity: 40,
      glowIntensity: 0.45,
    },
    charged: {
      primary: { r: 5, g: 150, b: 105 },     // Emerald green
      secondary: { r: 16, g: 185, b: 129 },
      accent: { r: 52, g: 211, b: 153 },
      beam: { r: 16, g: 185, b: 129 },
      speedMultiplier: 0.75,
      particleDensity: 32,
      glowIntensity: 0.48,
    },
    'delivered-paid': {
      primary: { r: 15, g: 118, b: 110 },    // Deep teal
      secondary: { r: 180, g: 130, b: 70 },  // Champagne gold
      accent: { r: 16, g: 185, b: 129 },
      beam: { r: 45, g: 212, b: 191 },
      speedMultiplier: 0.60,
      particleDensity: 28,
      glowIntensity: 0.40,
    },
    'delivered-unpaid': {
      primary: { r: 217, g: 119, b: 6 },     // Warm amber
      secondary: { r: 225, g: 29, b: 72 },   // Muted crimson
      accent: { r: 249, g: 115, b: 22 },    // Tangerine
      beam: { r: 234, g: 88, b: 12 },
      speedMultiplier: 0.95,
      particleDensity: 36,
      glowIntensity: 0.44,
    },
  },
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const lerpColor = (c1: ColorRGB, c2: ColorRGB, t: number): ColorRGB => ({
  r: lerp(c1.r, c2.r, t),
  g: lerp(c1.g, c2.g, t),
  b: lerp(c1.b, c2.b, t),
});

export const EnergyCanvasBackground: React.FC<EnergyCanvasBackgroundProps> = ({
  state,
  theme,
  className = '',
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Maintain active interpolated palette for silky smooth transitions
  const activePaletteRef = useRef<{
    primary: ColorRGB;
    secondary: ColorRGB;
    accent: ColorRGB;
    beam: ColorRGB;
    speedMultiplier: number;
    glowIntensity: number;
  }>({ ...PALETTES[theme][state] });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    let animationFrameId: number;
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    const checkReducedMotion = () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let isReducedMotion = checkReducedMotion();

    const resize = () => {
      if (!canvas) return;
      width = window.innerWidth;
      height = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    window.addEventListener('resize', resize);

    // Initialize particles with richer density & luminous alpha
    const particleCount = 65;
    const particles: Particle[] = Array.from({ length: particleCount }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      radius: Math.random() * 2.8 + 1.4,
      speedY: Math.random() * 1.5 + 0.6,
      driftAmp: Math.random() * 24 + 8,
      driftSpeed: Math.random() * 0.025 + 0.01,
      driftPhase: Math.random() * Math.PI * 2,
      baseAlpha: Math.random() * 0.4 + 0.45,
      alpha: Math.random() * 0.4 + 0.45,
      pulsePhase: Math.random() * Math.PI * 2,
      pulseSpeed: Math.random() * 0.045 + 0.02,
    }));

    // Initialize energy stream lines (ascending vertical light beams)
    const streamCount = 14;
    const streams: EnergyStream[] = Array.from({ length: streamCount }, (_, i) => ({
      x: (width / (streamCount + 1)) * (i + 1) + (Math.random() - 0.5) * 60,
      y: height + Math.random() * 250,
      width: Math.random() * 2.2 + 1.2,
      height: Math.random() * (height * 0.4) + height * 0.25,
      speedY: Math.random() * 2.6 + 1.4,
      alpha: 0,
      maxAlpha: Math.random() * 0.35 + 0.45,
      phase: Math.random() * Math.PI * 2,
    }));

    // Ambient glowing orbs directly covering the screen center (behind the crystal card)
    const orbs: GlowingOrb[] = [
      {
        x: width * 0.5,
        y: height * 0.32,
        targetX: width * 0.52,
        targetY: height * 0.38,
        radius: Math.min(width, height) * 0.46,
        alpha: 0.65,
        pulsePhase: 0,
        colorIdx: 0,
      },
      {
        x: width * 0.28,
        y: height * 0.62,
        targetX: width * 0.32,
        targetY: height * 0.58,
        radius: Math.min(width, height) * 0.48,
        alpha: 0.58,
        pulsePhase: 2.1,
        colorIdx: 1,
      },
      {
        x: width * 0.72,
        y: height * 0.52,
        targetX: width * 0.68,
        targetY: height * 0.48,
        radius: Math.min(width, height) * 0.44,
        alpha: 0.58,
        pulsePhase: 4.2,
        colorIdx: 2,
      },
      {
        x: width * 0.5,
        y: height * 0.82,
        targetX: width * 0.5,
        targetY: height * 0.76,
        radius: Math.min(width, height) * 0.52,
        alpha: 0.62,
        pulsePhase: 1.4,
        colorIdx: 0,
      },
    ];

    let lastTime = performance.now();

    const render = (time: number) => {
      const delta = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;

      // Target palette
      const targetPalette = PALETTES[theme][state];
      const lerpSpeed = 0.045; // Smooth transitions between order states

      const current = activePaletteRef.current;
      current.primary = lerpColor(current.primary, targetPalette.primary, lerpSpeed);
      current.secondary = lerpColor(current.secondary, targetPalette.secondary, lerpSpeed);
      current.accent = lerpColor(current.accent, targetPalette.accent, lerpSpeed);
      current.beam = lerpColor(current.beam, targetPalette.beam, lerpSpeed);
      current.speedMultiplier = lerp(current.speedMultiplier, targetPalette.speedMultiplier, lerpSpeed);
      current.glowIntensity = lerp(current.glowIntensity, targetPalette.glowIntensity, lerpSpeed);

      const speedFactor = isReducedMotion ? 0.15 : current.speedMultiplier;

      ctx.clearRect(0, 0, width, height);

      // 1. Draw large ambient background glow orbs
      orbs.forEach((orb) => {
        orb.pulsePhase += (isReducedMotion ? 0.005 : 0.018) * speedFactor;
        const currentRadius = orb.radius * (1 + Math.sin(orb.pulsePhase) * 0.08);
        const currentAlpha = orb.alpha * current.glowIntensity * (1 + Math.sin(orb.pulsePhase) * 0.15);

        const orbColor =
          orb.colorIdx === 0
            ? current.primary
            : orb.colorIdx === 1
            ? current.secondary
            : current.accent;

        const grad = ctx.createRadialGradient(
          orb.x,
          orb.y,
          0,
          orb.x,
          orb.y,
          currentRadius
        );

        grad.addColorStop(0, `rgba(${orbColor.r}, ${orbColor.g}, ${orbColor.b}, ${currentAlpha})`);
        grad.addColorStop(0.5, `rgba(${orbColor.r}, ${orbColor.g}, ${orbColor.b}, ${currentAlpha * 0.4})`);
        grad.addColorStop(1, `rgba(${orbColor.r}, ${orbColor.g}, ${orbColor.b}, 0)`);

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(orb.x, orb.y, currentRadius, 0, Math.PI * 2);
        ctx.fill();
      });

      // 2. Draw rising energy stream lines
      streams.forEach((stream) => {
        stream.phase += 0.02 * speedFactor;
        stream.y -= stream.speedY * 50 * delta * speedFactor;

        // Reset when stream fully flows out top
        if (stream.y + stream.height < 0) {
          stream.y = height + Math.random() * 150;
          stream.x = Math.random() * width;
          stream.speedY = Math.random() * 2.2 + 1.2;
          stream.height = Math.random() * (height * 0.35) + height * 0.2;
        }

        // Calculate fade based on position (fades in near bottom, peaks in middle, fades at top)
        const progress = Math.max(0, Math.min(1, 1 - stream.y / height));
        const fade = Math.sin(progress * Math.PI);
        const streamAlpha = stream.maxAlpha * fade * (0.8 + Math.sin(stream.phase) * 0.2);

        const streamColor = current.beam;
        const grad = ctx.createLinearGradient(
          stream.x,
          stream.y + stream.height,
          stream.x,
          stream.y
        );

        grad.addColorStop(0, `rgba(${streamColor.r}, ${streamColor.g}, ${streamColor.b}, 0)`);
        grad.addColorStop(0.3, `rgba(${streamColor.r}, ${streamColor.g}, ${streamColor.b}, ${streamAlpha * 0.5})`);
        grad.addColorStop(0.7, `rgba(${current.accent.r}, ${current.accent.g}, ${current.accent.b}, ${streamAlpha})`);
        grad.addColorStop(1, `rgba(${current.accent.r}, ${current.accent.g}, ${current.accent.b}, 0)`);

        ctx.strokeStyle = grad;
        ctx.lineWidth = stream.width;
        ctx.beginPath();
        ctx.moveTo(stream.x, stream.y + stream.height);
        ctx.lineTo(stream.x, stream.y);
        ctx.stroke();

        // Optional tiny energetic spark at the tip of the stream
        if (fade > 0.4) {
          ctx.fillStyle = `rgba(${current.accent.r}, ${current.accent.g}, ${current.accent.b}, ${streamAlpha * 1.2})`;
          ctx.shadowColor = `rgba(${current.accent.r}, ${current.accent.g}, ${current.accent.b}, 0.8)`;
          ctx.shadowBlur = 8;
          ctx.beginPath();
          ctx.arc(stream.x, stream.y, stream.width * 1.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0; // Reset
        }
      });

      // 3. Draw ascending floating particles / sparks
      particles.forEach((p, idx) => {
        p.driftPhase += p.driftSpeed * speedFactor;
        p.pulsePhase += p.pulseSpeed * speedFactor;

        p.y -= p.speedY * 40 * delta * speedFactor;
        const currentX = p.x + Math.sin(p.driftPhase) * p.driftAmp;

        // Reset particle to bottom when it reaches top
        if (p.y < -20) {
          p.y = height + Math.random() * 40;
          p.x = Math.random() * width;
        }

        // Pulse opacity
        const pulse = 0.7 + Math.sin(p.pulsePhase) * 0.3;
        const pAlpha = p.baseAlpha * pulse * (theme === 'dark' ? 0.9 : 0.65);

        // Select color variant
        const pColor = idx % 3 === 0 ? current.accent : idx % 3 === 1 ? current.primary : current.secondary;

        ctx.fillStyle = `rgba(${pColor.r}, ${pColor.g}, ${pColor.b}, ${pAlpha})`;
        ctx.shadowColor = `rgba(${pColor.r}, ${pColor.g}, ${pColor.b}, ${pAlpha * 0.8})`;
        ctx.shadowBlur = theme === 'dark' ? 10 : 4;

        ctx.beginPath();
        ctx.arc(currentX, p.y, p.radius, 0, Math.PI * 2);
        ctx.fill();
      });

      ctx.shadowBlur = 0; // Reset shadow

      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', resize);
    };
  }, [state, theme]);

  return (
    <canvas
      ref={canvasRef}
      className={`fixed inset-0 pointer-events-none select-none transition-opacity duration-700 ${className}`}
      style={{ zIndex: 1 }}
      aria-hidden="true"
    />
  );
};
