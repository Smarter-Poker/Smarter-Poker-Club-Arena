/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CONFETTI CANVAS — GPU-Accelerated Particle Celebration
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Canvas-based confetti particle system for big wins.
 * - 40 particles with gravity simulation
 * - 8 premium colors (gold, silver, red, blue, green, white, pink, purple)
 * - Rotation and horizontal drift
 * - Auto-cleans up after 3 seconds
 */

import { useRef, useEffect, useCallback } from 'react';

// Stable ref for onComplete to avoid including it in useEffect deps
// (inline arrows from parent would restart animation on every re-render)

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  width: number;
  height: number;
  rotation: number;
  rotationSpeed: number;
  color: string;
  opacity: number;
  gravity: number;
}

interface ConfettiCanvasProps {
  /** Whether to show confetti */
  active: boolean;
  /** Duration in ms before auto-hide */
  duration?: number;
  /** Number of particles */
  count?: number;
  /** Called when animation completes */
  onComplete?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const COLORS = [
  '#FFD700', // Gold
  '#C0C0C0', // Silver
  '#EF4444', // Red
  '#3B82F6', // Blue
  '#22C55E', // Green
  '#FFFFFF', // White
  '#EC4899', // Pink
  '#8B5CF6', // Purple
];

const DEFAULT_PARTICLE_COUNT = 45;
const DEFAULT_DURATION = 3000;

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function ConfettiCanvas({
  active,
  duration = DEFAULT_DURATION,
  count = DEFAULT_PARTICLE_COUNT,
  onComplete,
}: ConfettiCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const particlesRef = useRef<Particle[]>([]);
  const startTimeRef = useRef<number>(0);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete; // Always point to latest callback

  const createParticles = useCallback(
    (width: number, height: number): Particle[] => {
      const particles: Particle[] = [];
      for (let i = 0; i < count; i++) {
        particles.push({
          x: width * 0.3 + Math.random() * width * 0.4, // Cluster in center
          y: height * 0.2 + Math.random() * height * 0.1, // Start near top-center
          vx: (Math.random() - 0.5) * 8,
          vy: -(Math.random() * 4 + 2), // Initial upward burst
          width: Math.random() * 8 + 4,
          height: Math.random() * 6 + 3,
          rotation: Math.random() * 360,
          rotationSpeed: (Math.random() - 0.5) * 12,
          color: COLORS[Math.floor(Math.random() * COLORS.length)],
          opacity: 1,
          gravity: 0.12 + Math.random() * 0.06,
        });
      }
      return particles;
    },
    [count]
  );

  useEffect(() => {
    if (!active) {
      // Clean up
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = 0;
      }
      particlesRef.current = [];
      return;
    }

    // IMPROVEMENT PASS 2026-08-19: honor prefers-reduced-motion in the rAF
    // loop (CSS media queries cannot). Completion still fires.
    if (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      const t = setTimeout(() => onCompleteRef.current?.(), 0);
      return () => clearTimeout(t);
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size to viewport
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    ctx.scale(dpr, dpr);

    // Initialize particles
    particlesRef.current = createParticles(window.innerWidth, window.innerHeight);
    startTimeRef.current = performance.now();

    // Single completion path shared by the rAF loop and the hidden-tab
    // backstop below — whichever fires first wins, the other is a no-op.
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = 0;
      }
      try {
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      } catch {
        /* canvas may be gone */
      }
      particlesRef.current = [];
      onCompleteRef.current?.();
    };

    const animate = (now: number) => {
      if (completed) return;
      const elapsed = now - startTimeRef.current;
      const fadeProgress = Math.max(0, (elapsed - duration * 0.6) / (duration * 0.4));

      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

      particlesRef.current.forEach((p) => {
        // Physics
        p.vy += p.gravity;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.rotationSpeed;
        p.vx *= 0.99; // Air resistance
        p.opacity = Math.max(0, 1 - fadeProgress);

        // Draw
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.globalAlpha = p.opacity;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.width / 2, -p.height / 2, p.width, p.height);
        ctx.restore();
      });

      if (elapsed < duration) {
        animFrameRef.current = requestAnimationFrame(animate);
      } else {
        finish();
      }
    };

    // ANIMATION AUDIT 2026-08-27 (multi-table): a background table is
    // display:none, not unmounted — its canvas can paint nothing, yet the
    // rAF loop still burned frames for the whole burst on every hidden
    // table. If the canvas has no client rects (hidden ancestor), skip the
    // draw loop entirely; the wall-clock backstop below still completes the
    // burst on schedule so the parent's gating state clears.
    const hiddenTable = canvas.getClientRects().length === 0;
    if (!hiddenTable) {
      animFrameRef.current = requestAnimationFrame(animate);
    }

    // ANIMATION AUDIT 2026-08-27: browsers stop delivering rAF in a hidden
    // tab, so `onComplete` never fired there and the parent's gating state
    // (showConfetti) stayed latched until the tab was foregrounded — which
    // then swallowed the NEXT win's burst. This wall-clock backstop completes
    // the burst on schedule whether or not frames were delivered.
    const safety = setTimeout(finish, duration + 500);

    return () => {
      clearTimeout(safety);
      completed = true;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
    // onComplete intentionally omitted — stored in ref to prevent animation restart
  }, [active, duration, createParticles]);

  if (!active) return null;

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        pointerEvents: 'none',
      }}
    />
  );
}

export default ConfettiCanvas;
