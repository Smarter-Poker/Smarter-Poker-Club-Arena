/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BOMB POT OVERLAY — Cinematic bomb-drop sequence
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * REBUILT 2026-08-20 against Dan's frame-by-frame capture of the competitor's
 * double-board PLO bomb pot. The reference plays a four-phase sequence over
 * ~4.5s, not a static announcement card:
 *
 *   Phase 1 DROP    (0 - 0.45s)  a black cartoon bomb falls from above the
 *                                felt to table center, growing as it falls,
 *                                and lands with a squash-and-settle bounce.
 *   Phase 2 FUSE    (0.45 - 2.0s) the bomb rocks in place while its fuse
 *                                throws sparks; this is the window where the
 *                                engine's antes post ("Bomb" pill on every
 *                                seat — see SeatSlot's bombPotAnte badge).
 *   Phase 3 EXPLODE (2.0 - 2.4s) comic starburst flash + expanding shockwave
 *                                ring + screen shake.
 *   Phase 4 TITLE   (2.15 - 4.5s) gold "BOMB POT" letters spread out of the
 *                                explosion center and hold while hole cards
 *                                are dealt, then fade.
 *
 * Audio is locked to the phases via the three-beat SoundService methods
 * (playBombDrop / playBombFuse / playBombExplosion) — all synthesized, all
 * original. Every timer scales with getAnimationSpeed(), the same multiplier
 * every table animation uses.
 *
 * All artwork here is original (SVG primitives + CSS) — the reference was
 * used for choreography and timing only.
 */

import React, { useState, useEffect, useRef } from 'react';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { soundService } from '../../services/SoundService';
import { getAnimationSpeed } from '../../utils/animationSpeed';
import { triggerScreenShake } from '../../utils/ScreenShake';
import './BombPotOverlay.css';

interface BombPotOverlayProps {
  tableId: string;
}

type BombPhase = 'idle' | 'drop' | 'fuse' | 'explode' | 'title';

/** Phase boundaries at 1x animation speed (ms from sequence start). */
const T_FUSE = 450;
const T_EXPLODE = 2000;
const T_TITLE = 2150;
const T_HIDE = 4500;

export const BombPotOverlay: React.FC<BombPotOverlayProps> = ({ tableId }) => {
  const [phase, setPhase] = useState<BombPhase>('idle');
  const [anteAmount, setAnteAmount] = useState(0);
  const [doubleBoard, setDoubleBoard] = useState(false);
  const [bbMultiplier, setBBMultiplier] = useState(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  const clearTimers = () => {
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current = [];
  };

  useMasterBusSubscription('BOMB_POT_TRIGGERED', (payload: any) => {
    if (payload?.tableId !== tableId) return;
    setAnteAmount(payload.anteAmount || 0);
    setDoubleBoard(payload.doubleBoard || false);
    setBBMultiplier(payload.bbMultiplier || 0);

    // Restart the sequence cleanly if a stale one is somehow still running
    clearTimers();
    const s = getAnimationSpeed();
    const at = (ms: number, fn: () => void) => {
      timersRef.current.push(setTimeout(fn, ms * s));
    };

    setPhase('drop');
    soundService.playBombDrop(); // whistle covers the fall, tick on landing

    at(T_FUSE, () => {
      setPhase('fuse');
      soundService.playBombFuse(((T_EXPLODE - T_FUSE) / 1000) * s);
    });
    at(T_EXPLODE, () => {
      setPhase('explode');
      soundService.playBombExplosion();
      triggerScreenShake('medium', containerRef.current);
    });
    at(T_TITLE, () => setPhase('title'));
    at(T_HIDE, () => setPhase('idle'));
  });

  // Dismiss immediately when the engine reports the bomb pot resolved
  useMasterBusSubscription('BOMB_POT_COMPLETED', (payload: any) => {
    if (payload?.tableId === tableId) {
      clearTimers();
      setPhase('idle');
    }
  });

  // Clean up all timers on unmount — prevents setState-after-unmount
  useEffect(() => clearTimers, []);

  if (phase === 'idle') return null;

  return (
    <div className="bomb-pot-overlay" ref={containerRef} data-phase={phase} aria-hidden="true">
      {/* ── The bomb: drawn from SVG primitives, animated per phase ── */}
      {(phase === 'drop' || phase === 'fuse') && (
        <div className={`bpo-bomb bpo-bomb--${phase}`}>
          <svg viewBox="0 0 100 120" className="bpo-bomb-svg">
            {/* fuse cord */}
            <path
              d="M 62 30 Q 74 18 70 8"
              fill="none"
              stroke="#8a6d3b"
              strokeWidth="4"
              strokeLinecap="round"
            />
            {/* body */}
            <circle cx="50" cy="70" r="42" fill="#15161c" />
            <circle cx="50" cy="70" r="42" fill="none" stroke="#2e3038" strokeWidth="2" />
            {/* cap */}
            <rect x="52" y="24" width="18" height="14" rx="3" fill="#3a3d47" transform="rotate(38 61 31)" />
            {/* glossy highlight */}
            <ellipse cx="36" cy="56" rx="12" ry="8" fill="#ffffff" opacity="0.18" transform="rotate(-30 36 56)" />
          </svg>
          {/* fuse spark — jittering glow at the fuse tip */}
          <div className="bpo-spark">
            <span className="bpo-spark-ray" />
            <span className="bpo-spark-ray" />
            <span className="bpo-spark-ray" />
            <span className="bpo-spark-core" />
          </div>
        </div>
      )}

      {/* ── Explosion: comic starburst + shockwave ring ── */}
      {(phase === 'explode' || phase === 'title') && (
        <div className="bpo-explosion">
          <svg viewBox="0 0 200 200" className="bpo-burst-svg">
            <polygon
              points="100,4 118,62 178,42 136,92 196,100 136,108 178,158 118,138 100,196 82,138 22,158 64,108 4,100 64,92 22,42 82,62"
              fill="url(#bpoBurstFill)"
              stroke="#ff9d1c"
              strokeWidth="3"
            />
            <defs>
              <radialGradient id="bpoBurstFill">
                <stop offset="0%" stopColor="#fff7c4" />
                <stop offset="45%" stopColor="#ffd23e" />
                <stop offset="100%" stopColor="#ff7a00" />
              </radialGradient>
            </defs>
          </svg>
          <div className="bpo-shockwave" />
          <div className="bpo-embers">
            {Array.from({ length: 10 }).map((_, i) => (
              <span
                key={i}
                className="bpo-ember"
                style={
                  {
                    '--ember-angle': `${i * 36 + (i % 2) * 14}deg`,
                    '--ember-dist': `${70 + (i % 3) * 28}px`,
                    animationDelay: `${(i % 4) * 40}ms`,
                  } as React.CSSProperties
                }
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Title: gold letters spreading out of the blast ── */}
      {phase === 'title' && (
        <div className="bpo-title-block">
          <div className="bpo-title">
            {'BOMB POT'.split('').map((ch, i) => (
              <span
                key={i}
                className={`bpo-letter ${ch === ' ' ? 'bpo-letter--space' : ''}`}
                style={{ animationDelay: `${i * 28}ms` }}
              >
                {ch}
              </span>
            ))}
          </div>
          <div className="bpo-subtitle">{doubleBoard ? 'DOUBLE BOARD' : 'ALL PLAYERS IN'}</div>
          {anteAmount > 0 && (
            <div className="bpo-ante">
              Everyone antes {anteAmount.toLocaleString()}
              {bbMultiplier > 0 ? ` (${bbMultiplier}x BB)` : ''}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default BombPotOverlay;
