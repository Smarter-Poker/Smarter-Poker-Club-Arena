/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BBJ CELEBRATION — Bad Beat Jackpot Explosion Effect
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Full-screen celebration overlay triggered when a Bad Beat Jackpot hits.
 * Features:
 *   - Canvas particle explosion with gold/diamond chips
 *   - Fireworks burst effect (multi-stage)
 *   - Screen shake + flash
 *   - Animated jackpot amount counter (rolls up from 0)
 *   - Winner/loser/table share breakdown
 *   - "BAD BEAT JACKPOT!" title with glow pulse
 *   - Confetti rain for 8 seconds, then fades out
 *   - Audio pulse (optional, via Web Audio API)
 *
 * Dan: "EPIC AND EXCITING HIGH QUALITY CONTENT"
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import './BBJCelebration.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BBJCelebrationProps {
  visible: boolean;
  totalPayout: number;
  loser: { userId: string; username: string; share: number; handName: string };
  winner: { userId: string; username: string; share: number; handName: string };
  tableShare: number;
  perPlayerShare: number;
  tablePlayerCount: number;
  onComplete?: () => void;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  opacity: number;
  life: number;
  maxLife: number;
  type: 'chip' | 'spark' | 'confetti' | 'firework';
  rotation: number;
  rotationSpeed: number;
  gravity: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const CELEBRATION_DURATION = 10000; // 10 seconds total
const FADE_START = 8000; // Start fading at 8s
const PARTICLE_COUNT = 300;
const FIREWORK_ROUNDS = 5;

const GOLD_COLORS = ['#FFD700', '#FFA500', '#FFEC8B', '#DAA520', '#F5DEB3', '#FFE4B5'];
const DIAMOND_COLORS = ['#B9F2FF', '#E0FFFF', '#87CEEB', '#ADD8E6', '#F0F8FF', '#FFFFFF'];
const CONFETTI_COLORS = [
  '#FF6B6B',
  '#4ECDC4',
  '#45B7D1',
  '#96CEB4',
  '#FFEAA7',
  '#DDA0DD',
  '#98D8C8',
  '#F7DC6F',
];

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function BBJCelebration({
  visible,
  totalPayout,
  loser,
  winner,
  tableShare,
  perPlayerShare,
  tablePlayerCount,
  onComplete,
}: BBJCelebrationProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const animFrameRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const [displayAmount, setDisplayAmount] = useState(0);
  const [phase, setPhase] = useState<'explode' | 'reveal' | 'breakdown' | 'fadeout'>('explode');
  const [opacity, setOpacity] = useState(0);

  // ── Animated counter: roll up from 0 to totalPayout ──
  useEffect(() => {
    if (!visible) {
      setDisplayAmount(0);
      setPhase('explode');
      setOpacity(0);
      return;
    }

    // Fade in
    setOpacity(1);
    startTimeRef.current = Date.now();

    // Phase transitions
    const t1 = setTimeout(() => setPhase('reveal'), 1500);
    const t2 = setTimeout(() => setPhase('breakdown'), 3500);
    const t3 = setTimeout(() => setPhase('fadeout'), FADE_START);
    const t4 = setTimeout(() => {
      setOpacity(0);
      setTimeout(() => onComplete?.(), 500);
    }, CELEBRATION_DURATION);

    // Rolling counter animation
    const counterStart = Date.now();
    const counterDuration = 2500;
    const counterInterval = setInterval(() => {
      const elapsed = Date.now() - counterStart;
      const progress = Math.min(1, elapsed / counterDuration);
      // Ease out cubic for satisfying deceleration
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayAmount(Math.round(totalPayout * eased * 100) / 100);
      if (progress >= 1) clearInterval(counterInterval);
    }, 16);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      clearInterval(counterInterval);
    };
  }, [visible, totalPayout, onComplete]);

  // ── Spawn particles ──
  const spawnExplosion = useCallback(
    (cx: number, cy: number, count: number, type: Particle['type']) => {
      const newParticles: Particle[] = [];
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = type === 'firework' ? 3 + Math.random() * 6 : 1 + Math.random() * 4;
        const colors =
          type === 'chip' ? GOLD_COLORS : type === 'spark' ? DIAMOND_COLORS : CONFETTI_COLORS;
        newParticles.push({
          x: cx + (Math.random() - 0.5) * 40,
          y: cy + (Math.random() - 0.5) * 40,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - (type === 'firework' ? 3 : 0),
          size:
            type === 'confetti'
              ? 4 + Math.random() * 6
              : type === 'chip'
                ? 6 + Math.random() * 8
                : 2 + Math.random() * 4,
          color: colors[Math.floor(Math.random() * colors.length)],
          opacity: 1,
          life: 0,
          maxLife: type === 'firework' ? 60 + Math.random() * 40 : 80 + Math.random() * 120,
          type,
          rotation: Math.random() * Math.PI * 2,
          rotationSpeed: (Math.random() - 0.5) * 0.2,
          gravity: type === 'confetti' ? 0.03 : type === 'firework' ? 0.08 : 0.02,
        });
      }
      particlesRef.current.push(...newParticles);
    },
    []
  );

  // ── Canvas animation loop ──
  useEffect(() => {
    if (!visible || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas to full screen
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    // Initial explosion
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    spawnExplosion(cx, cy, PARTICLE_COUNT, 'chip');
    spawnExplosion(cx, cy, 100, 'spark');

    // Delayed firework rounds
    const fireworkTimers: ReturnType<typeof setTimeout>[] = [];
    for (let r = 0; r < FIREWORK_ROUNDS; r++) {
      fireworkTimers.push(
        setTimeout(
          () => {
            const fx = 100 + Math.random() * (canvas.width - 200);
            const fy = 100 + Math.random() * (canvas.height * 0.5);
            spawnExplosion(fx, fy, 60, 'firework');
          },
          1000 + r * 1200
        )
      );
    }

    // Continuous confetti rain
    const confettiInterval = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      if (elapsed > FADE_START) return;
      for (let i = 0; i < 5; i++) {
        spawnExplosion(Math.random() * canvas.width, -20, 1, 'confetti');
      }
    }, 100);

    // Render loop
    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const particles = particlesRef.current;
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life++;
        p.x += p.vx;
        p.y += p.vy;
        p.vy += p.gravity;
        p.vx *= 0.99;
        p.rotation += p.rotationSpeed;
        p.opacity = Math.max(0, 1 - p.life / p.maxLife);

        if (p.life >= p.maxLife) {
          particles.splice(i, 1);
          continue;
        }

        ctx.save();
        ctx.globalAlpha = p.opacity;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);

        if (p.type === 'chip') {
          // Gold chip with dollar sign
          ctx.beginPath();
          ctx.arc(0, 0, p.size, 0, Math.PI * 2);
          ctx.fillStyle = p.color;
          ctx.fill();
          ctx.strokeStyle = '#B8860B';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          // Dollar sign
          ctx.fillStyle = '#8B6914';
          ctx.font = `bold ${p.size}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('$', 0, 0);
        } else if (p.type === 'spark') {
          // Glowing spark
          ctx.shadowColor = p.color;
          ctx.shadowBlur = 12;
          ctx.beginPath();
          ctx.arc(0, 0, p.size, 0, Math.PI * 2);
          ctx.fillStyle = p.color;
          ctx.fill();
        } else if (p.type === 'confetti') {
          // Rectangular confetti
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        } else if (p.type === 'firework') {
          // Firework trail with glow
          ctx.shadowColor = p.color;
          ctx.shadowBlur = 20;
          ctx.beginPath();
          ctx.arc(0, 0, p.size * 0.8, 0, Math.PI * 2);
          ctx.fillStyle = p.color;
          ctx.fill();
          // Trail
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(-p.vx * 3, -p.vy * 3);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = p.size * 0.4;
          ctx.globalAlpha = p.opacity * 0.5;
          ctx.stroke();
        }

        ctx.restore();
      }

      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      window.removeEventListener('resize', resize);
      fireworkTimers.forEach(clearTimeout);
      clearInterval(confettiInterval);
      particlesRef.current = [];
    };
  }, [visible, spawnExplosion]);

  if (!visible) return null;

  return (
    <div className="bbj-celebration-overlay" style={{ opacity, transition: 'opacity 0.5s ease' }}>
      {/* Canvas layer for particles */}
      <canvas ref={canvasRef} className="bbj-canvas" />

      {/* Screen flash */}
      <div className={`bbj-screen-flash ${phase === 'explode' ? 'bbj-flash-active' : ''}`} />

      {/* Content layer */}
      <div className="bbj-content">
        {/* Title */}
        <div className={`bbj-title ${phase !== 'explode' ? 'bbj-title-visible' : ''}`}>
          <div className="bbj-title-crown">&#x1F451;</div>
          <h1 className="bbj-title-text">BAD BEAT JACKPOT!</h1>
          <div className="bbj-title-subtitle">JACKPOT HIT!</div>
        </div>

        {/* Total Amount */}
        <div
          className={`bbj-amount ${phase === 'reveal' || phase === 'breakdown' ? 'bbj-amount-visible' : ''}`}
        >
          <span className="bbj-amount-label">TOTAL PAYOUT</span>
          <span className="bbj-amount-value">
            $
            {displayAmount.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
        </div>

        {/* Payout Breakdown */}
        <div className={`bbj-breakdown ${phase === 'breakdown' ? 'bbj-breakdown-visible' : ''}`}>
          <div className="bbj-breakdown-card bbj-breakdown-loser">
            <div className="bbj-breakdown-emoji">&#x1F4B0;</div>
            <div className="bbj-breakdown-label">BAD BEAT HOLDER</div>
            <div className="bbj-breakdown-name">{loser.username}</div>
            <div className="bbj-breakdown-hand">{loser.handName}</div>
            <div className="bbj-breakdown-amount">
              +${loser.share.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </div>
            <div className="bbj-breakdown-percent">50%</div>
          </div>

          <div className="bbj-breakdown-card bbj-breakdown-winner">
            <div className="bbj-breakdown-emoji">&#x1F3C6;</div>
            <div className="bbj-breakdown-label">HAND WINNER</div>
            <div className="bbj-breakdown-name">{winner.username}</div>
            <div className="bbj-breakdown-hand">{winner.handName}</div>
            <div className="bbj-breakdown-amount">
              +${winner.share.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </div>
            <div className="bbj-breakdown-percent">25%</div>
          </div>

          <div className="bbj-breakdown-card bbj-breakdown-table">
            <div className="bbj-breakdown-emoji">&#x1F3B0;</div>
            <div className="bbj-breakdown-label">TABLE SHARE</div>
            <div className="bbj-breakdown-name">{tablePlayerCount} players</div>
            <div className="bbj-breakdown-hand">
              ${perPlayerShare.toLocaleString(undefined, { minimumFractionDigits: 2 })} each
            </div>
            <div className="bbj-breakdown-amount">
              +${tableShare.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </div>
            <div className="bbj-breakdown-percent">25%</div>
          </div>
        </div>

        {/* Chips added to balance message */}
        <div className={`bbj-chips-message ${phase === 'breakdown' ? 'bbj-chips-visible' : ''}`}>
          Chips added directly to your table balance!
        </div>
      </div>
    </div>
  );
}

export default BBJCelebration;
