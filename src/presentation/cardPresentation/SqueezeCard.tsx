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
  } as React.CSSProperties;
}

/** Spread onto the host slot element to make it a squeeze host. */
export function squeezeHostProps(
  p: CardAnimationProfile,
  boardIndex = 0
): {
  className: string;
  style: React.CSSProperties;
  'data-rs-profile': string;
  'data-rs-sweep': 'on' | 'off';
} {
  return {
    className: 'card-squeeze-host',
    style: squeezeVars(p, boardIndex),
    'data-rs-profile': p.id,
    'data-rs-sweep': p.lightSweepEnabled ? 'on' : 'off',
  };
}

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
