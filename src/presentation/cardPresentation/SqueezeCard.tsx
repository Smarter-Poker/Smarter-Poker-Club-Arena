/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SQUEEZE CARD — the one piece of markup that performs a squeeze
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ROUND 2 2026-09-05 (spec 6, 130). The felt board and the hand replay both
 * reveal a card the same way, so they render the same component. Two surfaces
 * on a preserve-3d box (a one-sided element shows a MIRRORED face mid-turn,
 * which is the bug the flop's two-phase flip was written to fix), plus the
 * edge spine and the shadow layer.
 *
 * It renders the INSIDE of an existing card slot; it never owns the slot. The
 * host keeps whatever it already is - the felt's `.community-cards__card`
 * with its highlight, dim, gloss and sheen, or the replay's `.card.small` -
 * and only gains `card-squeeze-host` plus the profile's timing variables,
 * which `squeezeHostProps()` supplies. That is what stops this component from
 * needing to know anything about either page's layout (spec 9, 10: geometry
 * comes from the host, never from here).
 */

import React from 'react';
import type { CardAnimationProfile } from './types';
import { flipMs } from './profiles';
import './cardSqueeze.css';

/**
 * The profile as inline custom properties. THE ONLY bridge between the
 * profile table and the stylesheet: the keyframes read these, and the :root
 * values in cardSqueeze.css are only the desktop-cash defaults.
 */
export function squeezeVars(p: CardAnimationProfile, boardIndex = 0): React.CSSProperties {
  return {
    '--rs-prepare': `${p.prepareMs}ms`,
    '--rs-hold': `${p.holdMs}ms`,
    '--rs-flip': `${flipMs(p)}ms`,
    '--rs-overshoot': String(p.overshoot),
    '--rs-stagger': `${boardIndex * p.staggerMs}ms`,
    /* THE PIXELS ARE CLAMPED WHERE THE JS WINDOW IS (2026-09-05 audit).
       CardPresentationEngine caps a server-paced reveal at speed <= 1 because
       the engine's equity gate is a fixed wall-clock hold. The CSS multiplies
       by the same --animation-speed, so without this the markup would be torn
       out at 1750ms while the card was still turning at 2344ms on Slow. One
       clamp on each side, or neither is a clamp. */
    ...(p.serverPaced ? { '--animation-speed': 'min(1, var(--animation-speed, 1))' } : null),
  } as React.CSSProperties;
}

/** Spread onto the host slot element to make it a squeeze host. */
export function squeezeHostProps(
  p: CardAnimationProfile,
  boardIndex = 0,
  /**
   * MOBILE PASS 2026-09-05: false once the engine says this presentation is
   * over. It drives `data-rs-animating`, which is the ONLY thing that
   * promotes the rotating box to its own compositor layer - see the
   * will-change note in cardSqueeze.css. MDN: "switch will-change on and off
   * using script code before and after the change occurs."
   */
  animating = true,
  /**
   * VIP ALL-IN SQUEEZE 2026-09-05: the player's hold. `drag` while the card
   * is theirs to open, `released` once they have (or the ceiling has), and
   * undefined for every ordinary reveal. See the matching block in
   * cardSqueeze.css; the board writes --rs-drag on the host from the pointer.
   */
  hold?: SqueezeHoldState
): {
  className: string;
  style: React.CSSProperties;
  'data-rs-profile': string;
  'data-rs-sweep': 'on' | 'off';
  'data-rs-3d': 'on' | 'off';
  'data-rs-animating': 'on' | 'off';
  'data-rs-hold': SqueezeHoldState | undefined;
  'data-motion': 'keep';
} {
  return {
    className: 'card-squeeze-host',
    style: squeezeVars(p, boardIndex),
    'data-rs-hold': p.interactive ? hold : undefined,
    /* AUDIT FIX 2026-09-05. Reduced motion swaps the turn for a cross-fade
       (cardSqueeze.css) that is supposed to last the reduced profile's 150ms,
       because the ENGINE holds the markup mounted for exactly that long. But
       the global rule in src/styles/reducedMotion.css crushes every duration
       to 1ms with !important at a HIGHER specificity, so the fade finished
       instantly and the slot then sat there for the rest of the window.
       `data-motion="keep"` is the exemption that file publishes, and CLAUDE.md
       10.6 names it for exactly this case: "reduced-motion collapses motion
       but never meaning (data-motion='keep' for duration-carrying animation)".
       This animation carries duration by definition - the engine is counting
       it. The MOTION is still collapsed: it cross-fades, it does not turn. */
    'data-motion': 'keep',
    'data-rs-animating': animating ? 'on' : 'off',
    'data-rs-profile': p.id,
    'data-rs-sweep': p.lightSweepEnabled ? 'on' : 'off',
    /* AUDIT FIX 2026-09-05: `threeD` was declared on every profile and read
       by NOTHING, so `reduced.threeD: false` documented "a flat crossfade"
       that did not exist. It is real now: a reveal that is not a 3D turn has
       no edge to show, so the spine is suppressed for it (see cardSqueeze.css).
       A profile field nothing reads is a claim about behaviour that no code
       has to honour, which is worse than no field at all. */
    'data-rs-3d': p.threeD ? 'on' : 'off',
  };
}

/** The player's hold on an interactive squeeze. */
export type SqueezeHoldState = 'drag' | 'released';

export interface SqueezeCardProps {
  /** The card back, rendered by the caller's own renderer. */
  back: React.ReactNode;
  /** The card face, rendered by the caller's own renderer (spec 5, 52). */
  face: React.ReactNode;
}

export function SqueezeCard({ back, face }: SqueezeCardProps) {
  return (
    <>
      {/* The shadow sits BEHIND the rotating card and only dips its opacity,
          so no blur radius ever changes mid-flight (spec 72). */}
      <div className="card-squeeze__shadow" aria-hidden="true" />
      <div className="card-squeeze">
        <div className="card-squeeze__face card-squeeze__face--back">{back}</div>
        <div className="card-squeeze__face card-squeeze__face--front">{face}</div>
      </div>
      {/* At exactly 90deg both backface-hidden surfaces vanish; the recording
          shows a dark card EDGE there, not nothing (spec 73). */}
      <div className="card-squeeze__spine" aria-hidden="true" />
    </>
  );
}

export default SqueezeCard;
