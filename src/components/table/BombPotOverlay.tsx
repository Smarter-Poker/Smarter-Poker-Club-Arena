/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BOMB POT OVERLAY — Cinematic cherry-bomb sequence
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * REBUILT 2026-08-20 against Dan's frame-by-frame capture of the competitor's
 * double-board PLO bomb pot; ART UPGRADE 2026-08-21 (Dan: "improve the graphics
 * and animations... use the bomb image from the throwables", "drop the actual
 * cherry bomb, have the wick burning and then it explodes, with the words BOMB
 * POT! exploding on the screen").
 *
 * The bomb is no longer a hand-drawn SVG — it is the SAME 3D render the
 * throwables catalog uses (`throwables/bomb.jpg` in the Supabase images
 * bucket), pulled through the existing transform helper at the 320px bucket
 * (~9 KB) and radially masked so its black studio backdrop disappears into
 * the felt. If that image fails for any reason the overlay keeps running with
 * a CSS-drawn fallback bomb — the sequence must never be the thing that breaks
 * a hand.
 *
 * Phases (1x animation speed):
 *   1 DROP    (0 - 1.5s)   the cherry bomb falls from above the felt, growing
 *                          as it comes, wick already lit and trailing sparks;
 *                          lands with a squash-and-settle.
 *   2 FUSE    (1.5 - 3.2s) the bomb rocks in place while the wick burns down
 *                          and throws sparks; this is the window where the
 *                          engine's antes post (seat "Bomb" pills + chip
 *                          flights are driven by TablePage).
 *   3 EXPLODE (3.2s)       white flash, expanding fireball, two shockwave
 *                          rings, ember + smoke burst, screen shake.
 *   4 TITLE   (3.2 - 6.4s) "BOMB POT!" letters are thrown OUT of the blast —
 *                          each starts scattered, rotated, blurred and scaled
 *                          up, then snaps into place — hold, then fade.
 *
 * Audio is locked to the phases via SoundService's three-beat methods
 * (playBombDrop = incoming whistle + impact, playBombFuse, playBombExplosion).
 * All timers scale with getAnimationSpeed(), the multiplier every table
 * animation uses.
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { soundService } from '../../services/SoundService';
import { getThrowableImageUrl } from '../../services/ThrowableService';
import { getAnimationSpeed } from '../../utils/animationSpeed';
import { triggerScreenShake } from '../../utils/ScreenShake';
import './BombPotOverlay.css';

interface BombPotOverlayProps {
  tableId: string;
  /**
   * IMPROVEMENT PASS 2026-08-20 (#175 multi-table gate): background tables
   * must stay silent and must not shake the screen. TableModalsLayer passes
   * the table's ambientSoundsAllowed. Defaults true (single-table).
   */
  playSounds?: boolean;
}

type BombPhase = 'idle' | 'drop' | 'fuse' | 'explode' | 'title';

/**
 * Phase boundaries at 1x animation speed (ms from sequence start).
 *
 * ART UPGRADE 2026-08-21: the drop is 1.5s (was 0.45s) so the incoming
 * whistle has room to actually read as incoming — Dan: "it needs to sound
 * like a bomb incoming... like that whistle... followed by the BOOOOOM".
 */
const T_FUSE = 1500;
const T_EXPLODE = 3200;
const T_TITLE = 3200;
const T_HIDE = 6400;

/** The letters thrown out of the blast. */
const TITLE_TEXT = 'BOMB POT!';

export const BombPotOverlay: React.FC<BombPotOverlayProps> = ({ tableId, playSounds = true }) => {
  const [phase, setPhase] = useState<BombPhase>('idle');
  const [anteAmount, setAnteAmount] = useState(0);
  const [doubleBoard, setDoubleBoard] = useState(false);
  /** TRIPLE-BOARD 2026-08-27: boards actually dealt (1-3), for the badge. */
  const [boardCount, setBoardCount] = useState(1);
  /** VARIANT OVERRIDE 2026-08-28: 'PLO4' etc. when the bomb variant differs. */
  const [variantLabel, setVariantLabel] = useState<string | undefined>(undefined);
  const [bbMultiplier, setBBMultiplier] = useState(0);
  const [artFailed, setArtFailed] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  /**
   * The throwables bomb render, sized through the transform endpoint. Resolved
   * once — the helper caches, and this keeps the URL stable across renders so
   * the browser does not re-fetch mid-sequence.
   */
  const bombArtUrl = useMemo(() => {
    try {
      return getThrowableImageUrl('bomb', 320);
    } catch {
      return '';
    }
  }, []);

  /**
   * Warm the image the moment the component mounts, not when the bomb pot
   * fires. A cold fetch during the drop would show an empty square for the
   * first frames of the most dramatic animation on the table.
   */
  useEffect(() => {
    if (!bombArtUrl) {
      setArtFailed(true);
      return;
    }
    const img = new Image();
    img.onerror = () => setArtFailed(true);
    img.src = bombArtUrl;
  }, [bombArtUrl]);

  const clearTimers = () => {
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current = [];
  };

  useMasterBusSubscription('BOMB_POT_TRIGGERED', (payload: any) => {
    if (payload?.tableId !== tableId) return;
    setAnteAmount(payload.anteAmount || 0);
    setDoubleBoard(payload.doubleBoard || false);
    setBoardCount(Number(payload.boardCount) || (payload.doubleBoard ? 2 : 1));
    setVariantLabel(typeof payload.variantLabel === 'string' ? payload.variantLabel : undefined);
    setBBMultiplier(payload.bbMultiplier || 0);

    // Restart the sequence cleanly if a stale one is somehow still running
    clearTimers();
    const s = getAnimationSpeed();
    const at = (ms: number, fn: () => void) => {
      timersRef.current.push(setTimeout(fn, ms * s));
    };

    setPhase('drop');
    // Incoming whistle covers the whole fall, tick + thump on landing.
    if (playSounds) soundService.playBombDrop();

    at(T_FUSE, () => {
      setPhase('fuse');
      if (playSounds) soundService.playBombFuse(((T_EXPLODE - T_FUSE) / 1000) * s);
    });
    at(T_EXPLODE, () => {
      setPhase('explode');
      if (playSounds) soundService.playBombExplosion();
      // ANIMATION AUDIT 2026-08-27: the shake lived INSIDE the sound gate — a
      // muted (or background-tab) player lost the screen shake along with the
      // audio. The shake is motion, not sound; it plays regardless of mute.
      // (reducedMotion.css flattens the keyframe for reduced-motion players.)
      triggerScreenShake('heavy', containerRef.current);
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

  const bombVisible = phase === 'drop' || phase === 'fuse';
  const blastVisible = phase === 'explode' || phase === 'title';

  return (
    <div className="bomb-pot-overlay" ref={containerRef} data-phase={phase} aria-hidden="true">
      {/*
        THE ANTE IS ANNOUNCED IN WORDS, NOT ONLY IN MOTION (2026-08-29).

        The overlay is aria-hidden, and correctly so — a cherry bomb, a wick,
        a blast and a screen shake are decoration, and reading them out would
        be noise. But every WORD of the event lived inside that decoration: the
        BOMB POT title, the DOUBLE BOARD / TRIPLE BOARD badge and the "Everyone
        Antes n" line. So a player using a screen reader was charged a forced
        ante with no announcement of any kind.

        CLAUDE.md §10.6 is the rule this breaks: reduced motion collapses the
        motion but never the meaning. The same applies when the motion is
        hidden rather than reduced. This live region carries the meaning
        alongside the decoration — one sentence, announced once when the title
        lands, in the same words the felt shows. The scoop banner already had
        aria-live; this is the pattern catching up with it.
      */}
      {phase === 'title' && (
        <div className="bpo-sr-only" role="status" aria-live="assertive" aria-hidden={false}>
          {`Bomb Pot. ${
            boardCount >= 3 ? 'Triple Board. ' : doubleBoard ? 'Double Board. ' : ''
          }${variantLabel ? `Played As ${variantLabel}. ` : ''}${
            anteAmount > 0 ? `Everyone Antes ${anteAmount.toLocaleString()}.` : ''
          }`}
        </div>
      )}
      {/* ── Phases 1-2: the cherry bomb, wick lit ───────────────────────── */}
      {bombVisible && (
        <div className={`bpo-bomb bpo-bomb--${phase}`}>
          {/* Ember glow the lit wick casts on the felt underneath */}
          <div className="bpo-bomb-glow" />

          {artFailed || !bombArtUrl ? (
            // Fallback: CSS-drawn bomb. Never let missing art break the hand.
            <div className="bpo-bomb-fallback">
              <span className="bpo-bomb-fallback-cap" />
            </div>
          ) : (
            <img
              className="bpo-bomb-art"
              src={bombArtUrl}
              alt=""
              draggable={false}
              onError={() => setArtFailed(true)}
            />
          )}

          {/* Burning wick: an outer flame body with a hot white core, both
              flickering on their own cadence, plus sparks peeling upward. */}
          <div className="bpo-wick">
            <span className="bpo-wick-flame" />
            <span className="bpo-wick-core" />
            {Array.from({ length: 5 }).map((_, i) => (
              <span
                key={i}
                className="bpo-wick-spark"
                style={
                  {
                    '--spark-x': `${(i - 2) * 7}px`,
                    animationDelay: `${i * 130}ms`,
                  } as React.CSSProperties
                }
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Phase 3: the blast ──────────────────────────────────────────── */}
      {blastVisible && (
        <>
          <div className="bpo-flash" />
          <div className="bpo-explosion">
            <div className="bpo-fireball" />
            <div className="bpo-shock bpo-shock--1" />
            <div className="bpo-shock bpo-shock--2" />
            <div className="bpo-embers">
              {Array.from({ length: 16 }).map((_, i) => (
                <span
                  key={i}
                  className="bpo-ember"
                  style={
                    {
                      '--ember-angle': `${i * 22.5 + (i % 2) * 11}deg`,
                      '--ember-dist': `${90 + (i % 4) * 34}px`,
                      animationDelay: `${(i % 5) * 26}ms`,
                    } as React.CSSProperties
                  }
                />
              ))}
            </div>
            <div className="bpo-smoke">
              {Array.from({ length: 5 }).map((_, i) => (
                <span
                  key={i}
                  className="bpo-smoke-puff"
                  style={
                    {
                      '--smoke-angle': `${i * 72 + 18}deg`,
                      animationDelay: `${i * 45}ms`,
                    } as React.CSSProperties
                  }
                />
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── Phase 4: BOMB POT! thrown out of the blast ──────────────────── */}
      {phase === 'title' && (
        <div className="bpo-title-block">
          <div className="bpo-title">
            {TITLE_TEXT.split('').map((ch, i) => {
              // Deterministic scatter per letter index — same blast every time,
              // no Math.random() re-rolling on re-render.
              const spread = [-118, 96, -64, 132, 0, -140, 74, -92, 122][i % 9];
              const lift = [-58, 46, 72, -38, -80, 54, -66, 40, 62][i % 9];
              const spin = [-58, 44, -72, 66, -34, 78, -50, 38, -68][i % 9];
              return (
                <span
                  key={i}
                  className={`bpo-letter ${ch === ' ' ? 'bpo-letter--space' : ''}`}
                  style={
                    {
                      '--letter-x': `${spread}px`,
                      '--letter-y': `${lift}px`,
                      '--letter-rot': `${spin}deg`,
                      animationDelay: `${60 + i * 34}ms`,
                    } as React.CSSProperties
                  }
                >
                  {ch}
                </span>
              );
            })}
          </div>
          {/* Spec §6.1 step 5: the badge names the board count before the
              first board is shown, and on a variant-override bomb (spec
              §10.1) the game it will be played as.

              IT NO LONGER SAYS DOUBLE BOARD (Dan 2026-09-07, item 7D:
              "because all bomb pots are double board, it doesn't need to say
              double board"). Two boards is the house default, so naming it
              here spent the one line the player reads in the second before
              the cards land on a fact that is true every single time. Three
              boards is a real departure and still announces itself, and the
              variant override still leads, so a PLO4 bomb still reads
              "PLO4 ALL PLAYERS IN" rather than losing its game name. */}
          <div className="bpo-subtitle">
            {`${variantLabel ? `${variantLabel} ` : ''}${
              boardCount >= 3 ? 'TRIPLE BOARD' : 'ALL PLAYERS IN'
            }`}
          </div>
          {anteAmount > 0 && (
            <div className="bpo-ante">
              Everyone Antes {anteAmount.toLocaleString()}
              {bbMultiplier > 0 ? ` (${bbMultiplier}x BB)` : ''}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default BombPotOverlay;
