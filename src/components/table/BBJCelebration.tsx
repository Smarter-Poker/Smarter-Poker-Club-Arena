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
import { soundService } from '../../services/SoundService';
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
  /** Per-variant qualifying rule from the server bbj_hit event (2026-08-18). */
  qualifyingLabel?: string;
  /** The viewing player's own share — personalizes the celebration (2026-08-18). */
  heroShare?: number;
  /**
   * Audit 2026-08-25 (multi-table): false on a table the player is not looking
   * at. Up to four TablePages are mounted at once and the inactive ones are
   * hidden with `display: none`, which stops the overlay painting and does
   * absolutely nothing to the Web Audio API — so a jackpot three tables away
   * played a 10-second fanfare and a reveal sting over the table in front of
   * them. Defaults true so a single-table mount is unchanged.
   */
  soundsAllowed?: boolean;
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

// PERF 2026-08-18: 300 shadow-blurred particles at 1x resolution looked soft on
// retina and chugged on low-end phones. Particle budget now scales with the
// viewport (a 375px phone gets ~40% of the desktop budget) and the canvas
// renders at devicePixelRatio (capped at 2 — 3x retina buys nothing visible
// and triples the pixel work).
function particleScale(): number {
  if (typeof window === 'undefined') return 1;
  const area = window.innerWidth * window.innerHeight;
  return Math.max(0.35, Math.min(1, area / (1280 * 800)));
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

const SILVER_COLORS = ['#d5dae2', '#b9c0ca', '#eef1f5', '#9aa2ae', '#e2e6ec', '#e2e7ee'];
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

/**
 * Money, guarded.
 *
 * This overlay is full-screen and celebratory, so anything that throws inside
 * it takes the whole screen with it at the worst possible moment — and its
 * inputs come straight off a `bbj_hit` bus event, not from a typed query. A
 * partial event threw on `loser.username`; a `tableShare / 0` upstream would
 * have rendered the INFINITY GLYPH into a payout figure.
 */
function chips(n: number | null | undefined): string {
  const v = Number(n);
  return (Number.isFinite(v) ? v : 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
}

export function BBJCelebration({
  visible,
  totalPayout,
  loser,
  winner,
  tableShare,
  perPlayerShare,
  tablePlayerCount,
  qualifyingLabel,
  heroShare = 0,
  soundsAllowed = true,
  onComplete,
}: BBJCelebrationProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const animFrameRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const [displayAmount, setDisplayAmount] = useState(0);
  // FIX: Stabilize onComplete ref to prevent useEffect re-triggering on every parent render
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  /* Read through a ref, for the same reason as onComplete: the phase timers are
     scheduled once, and putting `soundsAllowed` in the effect's deps would
     restart the whole 10-second sequence (and the rolling counter) the instant
     the player switched tabs. The ref means a table that goes to the background
     mid-celebration falls silent for its remaining stings. */
  const soundsAllowedRef = useRef(soundsAllowed);
  soundsAllowedRef.current = soundsAllowed;
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

    // Epic ascending BBJ fanfare on the explosion
    if (soundsAllowedRef.current) soundService.playBadBeatJackpot();

    // Phase transitions
    const t1 = setTimeout(() => {
      setPhase('reveal');
      // Second-stage reveal sting — stacks on the ongoing fanfare
      if (soundsAllowedRef.current) soundService.playSpinResult();
    }, 1500);
    const t2 = setTimeout(() => setPhase('breakdown'), 3500);
    const t3 = setTimeout(() => setPhase('fadeout'), FADE_START);
    const t4 = setTimeout(() => {
      setOpacity(0);
      setTimeout(() => onCompleteRef.current?.(), 500);
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
    // `soundsAllowed` is deliberately NOT a dependency: it can flip when the
    // player switches tabs mid-celebration, and re-running this effect would
    // restart the whole phase sequence and the counter from zero.
  }, [visible, totalPayout]);
  // ↑ onComplete accessed via onCompleteRef to prevent timer reset on parent re-render

  /** Fade out and hand back to the parent, from the button or from Escape. */
  const dismiss = useCallback(() => {
    setOpacity(0);
    setTimeout(() => onCompleteRef.current?.(), 300);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, dismiss]);

  // ── Spawn particles ──
  const spawnExplosion = useCallback(
    (cx: number, cy: number, count: number, type: Particle['type']) => {
      const newParticles: Particle[] = [];
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = type === 'firework' ? 3 + Math.random() * 6 : 1 + Math.random() * 4;
        const colors =
          type === 'chip' ? SILVER_COLORS : type === 'spark' ? DIAMOND_COLORS : CONFETTI_COLORS;
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
    // ACCESSIBILITY 2026-08-18: honor prefers-reduced-motion — skip the
    // particle storm entirely; the static overlay still shows every number.
    if (prefersReducedMotion()) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Retina-sharp canvas: render at devicePixelRatio, lay out at CSS pixels.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let viewW = window.innerWidth;
    let viewH = window.innerHeight;
    const resize = () => {
      viewW = window.innerWidth;
      viewH = window.innerHeight;
      canvas.width = Math.round(viewW * dpr);
      canvas.height = Math.round(viewH * dpr);
      canvas.style.width = viewW + 'px';
      canvas.style.height = viewH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const scale = particleScale();

    // Initial explosion
    const cx = viewW / 2;
    const cy = viewH / 2;
    spawnExplosion(cx, cy, Math.round(PARTICLE_COUNT * scale), 'chip');
    spawnExplosion(cx, cy, Math.round(100 * scale), 'spark');

    // Delayed firework rounds
    const fireworkTimers: ReturnType<typeof setTimeout>[] = [];
    for (let r = 0; r < FIREWORK_ROUNDS; r++) {
      fireworkTimers.push(
        setTimeout(
          () => {
            const fx = 60 + Math.random() * Math.max(60, viewW - 120);
            const fy = 80 + Math.random() * (viewH * 0.5);
            spawnExplosion(fx, fy, Math.round(60 * scale), 'firework');
          },
          1000 + r * 1200
        )
      );
    }

    // Continuous confetti rain
    const confettiRate = Math.max(2, Math.round(5 * scale));
    const confettiInterval = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      if (elapsed > FADE_START) return;
      for (let i = 0; i < confettiRate; i++) {
        spawnExplosion(Math.random() * viewW, -20, 1, 'confetti');
      }
    }, 100);

    // Render loop
    const render = () => {
      ctx.clearRect(0, 0, viewW, viewH);

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
    <div
      className="bbj-celebration-overlay"
      style={{ opacity, transition: 'opacity 0.5s ease' }}
      role="dialog"
      aria-live="assertive"
      aria-label={`Bad Beat Jackpot Hit. Total Payout ${Math.trunc(totalPayout).toLocaleString('en-US')}.`}
    >
      {/* Canvas layer for particles */}
      <canvas ref={canvasRef} className="bbj-canvas" />

      {/* Screen flash */}
      <div className={`bbj-screen-flash ${phase === 'explode' ? 'bbj-flash-active' : ''}`} />

      {/* Content layer */}
      <div className="bbj-content">
        {/* Title */}
        <div className={`bbj-title ${phase !== 'explode' ? 'bbj-title-visible' : ''}`}>
          {/* HOUSE RULE (CLAUDE.md s.10.5, WH rule 7): no emoji in any
              user-facing string. These four marks were emoji (crown, money bag,
              trophy, slot machine), then HTML entities - which dodges the SWC
              compiler problem the rule was written around but still renders an
              emoji to the player, and still reads to check-title-case as page
              copy that is not Title Cased.

              They are DECORATION, so they now live in BBJCelebration.css as
              `content:` on these elements, and the elements are aria-hidden.
              That satisfies both rules honestly rather than muting one: the
              copy checker only sees copy, a screen reader is not read a spade
              where a heading belongs, and nothing user-facing carries an
              emoji. */}
          <div className="bbj-title-crown" aria-hidden="true" />
          <h1 className="bbj-title-text">BAD BEAT JACKPOT!</h1>
          <div className="bbj-title-subtitle">JACKPOT HIT!</div>
          {qualifyingLabel && <div className="bbj-title-qualifier">{qualifyingLabel}</div>}
        </div>

        {/* Total Amount */}
        <div
          className={`bbjcelebration__bbj-amount ${phase === 'reveal' || phase === 'breakdown' ? 'bbj-amount-visible' : ''}`}
        >
          <span className="bbj-amount-label">TOTAL PAYOUT</span>
          <span className="bbj-amount-value">
            $
            {displayAmount.toLocaleString('en-US', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
        </div>

        {/* Payout Breakdown */}
        <div className={`bbj-breakdown ${phase === 'breakdown' ? 'bbj-breakdown-visible' : ''}`}>
          <div className="bbj-breakdown-card bbj-breakdown-loser">
            <div className="bbj-breakdown-emoji" aria-hidden="true" />
            <div className="bbj-breakdown-label">BAD BEAT HOLDER</div>
            <div className="bbj-breakdown-name">{loser?.username || 'Player'}</div>
            <div className="bbj-breakdown-hand">{loser?.handName || ''}</div>
            <div className="bbj-breakdown-amount">+${chips(loser?.share)}</div>
            <div className="bbj-breakdown-percent">50%</div>
          </div>

          <div className="bbj-breakdown-card bbj-breakdown-winner">
            <div className="bbj-breakdown-emoji" aria-hidden="true" />
            <div className="bbj-breakdown-label">HAND WINNER</div>
            <div className="bbj-breakdown-name">{winner?.username || 'Player'}</div>
            <div className="bbj-breakdown-hand">{winner?.handName || ''}</div>
            <div className="bbj-breakdown-amount">+${chips(winner?.share)}</div>
            <div className="bbj-breakdown-percent">25%</div>
          </div>

          <div className="bbj-breakdown-card bbj-breakdown-table">
            <div className="bbj-breakdown-emoji" aria-hidden="true" />
            <div className="bbj-breakdown-label">TABLE SHARE</div>
            <div className="bbj-breakdown-name">{tablePlayerCount} Players</div>
            <div className="bbj-breakdown-hand">${chips(perPlayerShare)} Each</div>
            <div className="bbj-breakdown-amount">
              +${tableShare.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </div>
            <div className="bbj-breakdown-percent">25%</div>
          </div>
        </div>

        {/* Chips added to balance message — personalized when the viewer got a share */}
        <div className={`bbj-chips-message ${phase === 'breakdown' ? 'bbj-chips-visible' : ''}`}>
          {heroShare > 0 ? (
            <>
              <span className="bbj-hero-share">
                YOU WON +$
                {heroShare.toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
              <br />
              Chips Added Directly To Your Table Balance!
            </>
          ) : (
            'Chips Added Directly To The Players\u2019 Table Balances!'
          )}
        </div>

        {/* \u2500\u2500\u2500 AN ACTUAL WAY OUT (audit 2026-08-25) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
            The overlay carried `onClick` + `cursor: pointer` for early
            dismissal and `.bbj-celebration-overlay` is `pointer-events: none`,
            so that click NEVER fired: the celebration was a ten-second
            unskippable blackout over the felt, and every click during it fell
            straight through onto the table underneath \u2014 at a multi-table
            session, onto whichever table needed action.

            The pass-through is right (four tables are mounted; this must not
            swallow a fold at another one), so the DISMISS is what gets
            pointer-events back, on a real, focusable button. Escape also
            closes it \u2014 see the effect below. */}
        <button
          type="button"
          className="bbj-dismiss"
          onClick={dismiss}
          aria-label="Dismiss The Jackpot Celebration"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

export default BBJCelebration;
