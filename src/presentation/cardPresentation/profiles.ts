/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CARD PRESENTATION PROFILES — the only place a duration is written down
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * RIVER SQUEEZE 2026-09-04 (spec 8, 113, 118). Every number the river squeeze
 * uses lives here. The stylesheet reads them through custom properties the
 * component sets inline (--rs-prepare / --rs-hold / --rs-flip / --rs-overshoot),
 * so there is no second copy of any of these in CSS - only the desktop-cash
 * DEFAULTS, which tests/unit/cardPresentation/profiles.test.ts pins to this
 * table so they cannot drift.
 *
 * All values are BASE milliseconds at --animation-speed 1. The player's speed
 * setting scales them at use time (CSS calc + getAnimationSpeed()); it is the
 * one sanctioned control (CLAUDE.md 10.6) and it is applied identically to
 * every profile.
 */

import { HAND_COMPLETION } from '../../config/handCompletionSpec';
import type { CardAnimationProfile } from './types';

type ProfileSpec = Omit<CardAnimationProfile, 'durationMs'>;

function profile(spec: ProfileSpec): CardAnimationProfile {
  const durationMs = spec.prepareMs + spec.holdMs + spec.squeezeMs + spec.revealMs + spec.settleMs;
  return Object.freeze({ ...spec, durationMs });
}

/**
 * The all-in runout. The video IS an all-in river: the card sits face down for
 * a beat and then snaps over. The server already paces run-out streets by
 * HAND_COMPLETION.ALL_IN_STREET_REVEAL_MS (mirrored byte-for-byte into the
 * engine and pinned by tests/unit/handCompletionLaw.test.ts), so the hold is
 * derived from that gate rather than written twice: the card is face up the
 * instant the server's reveal gate opens, never before, never after.
 */
const ALL_IN_PREPARE_MS = 120;
const ALL_IN_SQUEEZE_MS = 200;
const ALL_IN_REVEAL_MS = 200;
const ALL_IN_SETTLE_MS = 100;
const ALL_IN_HOLD_MS =
  HAND_COMPLETION.ALL_IN_STREET_REVEAL_MS -
  (ALL_IN_PREPARE_MS + ALL_IN_SQUEEZE_MS + ALL_IN_REVEAL_MS + ALL_IN_SETTLE_MS);

export const CARD_PRESENTATION_PROFILES = Object.freeze({
  /** Standard cash, desktop. Elegant. ~560ms. */
  cashDesktop: profile({
    id: 'cash-desktop',
    mode: 'cash',
    platform: 'desktop',
    intensity: 'full',
    prepareMs: 80,
    holdMs: 0,
    squeezeMs: 180,
    revealMs: 180,
    settleMs: 120,
    overshoot: 1.03,
    staggerMs: 60,
    audioEnabled: true,
    lightSweepEnabled: true,
    threeD: true,
  }),
  /** Tournament, desktop. Cinematic but restrained. ~640ms. */
  tournamentDesktop: profile({
    id: 'tournament-desktop',
    mode: 'tournament',
    platform: 'desktop',
    intensity: 'full',
    prepareMs: 100,
    holdMs: 0,
    squeezeMs: 200,
    revealMs: 200,
    settleMs: 140,
    overshoot: 1.03,
    staggerMs: 60,
    audioEnabled: true,
    lightSweepEnabled: true,
    threeD: true,
  }),
  /** Lightning (fast-fold) desktop. Instant and satisfying. ~420ms. */
  lightningDesktop: profile({
    id: 'lightning-desktop',
    mode: 'lightning',
    platform: 'desktop',
    intensity: 'compact',
    prepareMs: 50,
    holdMs: 0,
    squeezeMs: 140,
    revealMs: 140,
    settleMs: 90,
    overshoot: 1.02,
    staggerMs: 35,
    audioEnabled: true,
    lightSweepEnabled: false,
    threeD: true,
  }),
  /** Replay. Detailed and cinematic. ~960ms. */
  replayDesktop: profile({
    id: 'replay-desktop',
    mode: 'replay',
    platform: 'desktop',
    intensity: 'full',
    prepareMs: 120,
    holdMs: 200,
    squeezeMs: 240,
    revealMs: 240,
    settleMs: 160,
    overshoot: 1.03,
    staggerMs: 80,
    audioEnabled: true,
    lightSweepEnabled: true,
    threeD: true,
  }),
  /** Any mode on a phone. Fast and clean. ~360ms. */
  mobile: profile({
    id: 'mobile',
    mode: 'cash',
    platform: 'mobile',
    intensity: 'full',
    prepareMs: 40,
    holdMs: 0,
    squeezeMs: 120,
    revealMs: 130,
    settleMs: 70,
    overshoot: 1.02,
    staggerMs: 40,
    audioEnabled: true,
    lightSweepEnabled: false,
    threeD: true,
  }),
  /**
   * All-in runout, every mode and platform. The hold makes up the difference
   * to the server's reveal gate, so durationMs === ALL_IN_STREET_REVEAL_MS.
   */
  allIn: profile({
    id: 'all-in',
    mode: 'cash',
    platform: 'desktop',
    intensity: 'full',
    prepareMs: ALL_IN_PREPARE_MS,
    holdMs: ALL_IN_HOLD_MS,
    squeezeMs: ALL_IN_SQUEEZE_MS,
    revealMs: ALL_IN_REVEAL_MS,
    settleMs: ALL_IN_SETTLE_MS,
    overshoot: 1.03,
    staggerMs: 60,
    audioEnabled: true,
    lightSweepEnabled: true,
    threeD: true,
  }),
  /** A visible but unfocused multi-table slot. Compact. ~280ms. */
  background: profile({
    id: 'background',
    mode: 'cash',
    platform: 'desktop',
    intensity: 'compact',
    prepareMs: 30,
    holdMs: 0,
    squeezeMs: 100,
    revealMs: 100,
    settleMs: 50,
    overshoot: 1,
    staggerMs: 0,
    audioEnabled: false,
    lightSweepEnabled: false,
    threeD: true,
  }),
  /**
   * prefers-reduced-motion. The stylesheet's global rule (src/styles/
   * reducedMotion.css) collapses every duration to 1ms and the flip's resting
   * state is FACE UP, so the board is simply correct; this profile only sizes
   * the JS window and the telemetry honestly.
   */
  reduced: profile({
    id: 'reduced',
    mode: 'cash',
    platform: 'desktop',
    intensity: 'reduced',
    prepareMs: 0,
    holdMs: 0,
    squeezeMs: 80,
    revealMs: 40,
    settleMs: 0,
    overshoot: 1,
    staggerMs: 0,
    audioEnabled: true,
    lightSweepEnabled: false,
    threeD: false,
  }),
  /** A hidden table (display:none multi-table slot). Nothing to draw. */
  off: profile({
    id: 'off',
    mode: 'cash',
    platform: 'desktop',
    intensity: 'off',
    prepareMs: 0,
    holdMs: 0,
    squeezeMs: 0,
    revealMs: 0,
    settleMs: 0,
    overshoot: 1,
    staggerMs: 0,
    audioEnabled: false,
    lightSweepEnabled: false,
    threeD: false,
  }),
});

export type CardPresentationProfileId = keyof typeof CARD_PRESENTATION_PROFILES;

/**
 * The stylesheet's keyframe percentages are fixed; the profile's three flip
 * beats are pinned to this split so the numbers above and the CSS agree.
 *   0    -> SQUEEZE_END   rotateY 0 -> 90   (back compresses to the edge)
 *   ...  -> REVEAL_END    rotateY 90 -> 180 (face expands)
 *   ...  -> OVERSHOOT     scale 1 -> overshoot
 *   ...  -> 100           scale -> 1
 */
export const SQUEEZE_KEYFRAME_SPLIT = Object.freeze({
  SQUEEZE_END: 0.375,
  REVEAL_END: 0.75,
  OVERSHOOT_PEAK: 0.9,
});

/**
 * The margin the JS mount window adds past the CSS total so the flip markup is
 * never torn out mid-animation (the defect the 1.4s flop window fixed).
 */
export const MOUNT_WINDOW_MARGIN_MS = 100;

/** The flip (squeeze + reveal + settle) is one CSS animation. */
export function flipMs(p: CardAnimationProfile): number {
  return p.squeezeMs + p.revealMs + p.settleMs;
}
