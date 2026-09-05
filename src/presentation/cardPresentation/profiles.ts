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
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHERE THESE NUMBERS COME FROM (rewritten 2026-09-05 from research)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: "DO A DEEP DIVE ONLINE HOW THE OTHER ONLINE POKER ROOMS RUN AND PROGRAM
 * THIS ANIMATION SO WE HAVE THE INDUSTRY STANDARD AND AREN'T JUST GUESSING."
 *
 * The first version of this table was the spec's own suggested defaults, and
 * that spec said of them, in its own words, "These are initial defaults only.
 * Instrument them and tune after testing." They were guesses. These are not.
 * The full evidence, with sources and confidence levels, is in
 * docs/research/2026-09-05-card-reveal-industry-standards.md. The short of it:
 *
 * 1. NOBODY IN POKER PUBLISHES THEIR TIMINGS. Across eight clients the total
 *    documented evidence is a single 2011 PokerStars forum post from a staff
 *    account. So the timings below come from the cross-platform motion
 *    standard instead, which does publish, and which the reference recording
 *    agrees with.
 *
 * 2. MOBILE IS NOT THE SHORT ONE. Material Design: mobile transitions
 *    typically 300ms, entering elements 225ms, and "desktop animations should
 *    be faster and simpler than their mobile counterparts ... 150ms to 200ms".
 *    The old table had mobile at a 320ms flip and desktop at 480ms - backwards,
 *    and desktop was over the ceiling.
 *
 * 3. THERE IS A CEILING. "Transitions that exceed 400ms may feel too slow."
 *    Every flip below is at or under it. The old cash flip (480ms), tournament
 *    (540ms) and replay (640ms) were all over it.
 *
 * 4. THE REFERENCE RECORDING AGREES. Frame-by-frame, the video Dan supplied
 *    turns the card over in about 130ms - far faster than anything the old
 *    table produced. Shortening moves us toward the reference, not away.
 *
 * Durations are taken from the Material 3 duration ladder rather than invented:
 * short1 50, short3 150, short4 200, medium1 250, medium2 300, medium4 400.
 *
 * `flipMs` (squeeze + reveal + settle) is the number the ceiling applies to;
 * `prepareMs` is a materialise, not a transition, and `holdMs` is a deliberate
 * pause the server owns (see below).
 */

/**
 * The all-in runout. The video IS an all-in river: the card sits face down for
 * a beat and then snaps over. The server already paces run-out streets by
 * HAND_COMPLETION.ALL_IN_STREET_REVEAL_MS (mirrored byte-for-byte into the
 * engine and pinned by tests/unit/handCompletionLaw.test.ts), so the hold is
 * derived from that gate rather than written twice: the card is face up the
 * instant the server's reveal gate opens, never before, never after.
 */
const ALL_IN_PREPARE_MS = 100;
const ALL_IN_SQUEEZE_MS = 113;
const ALL_IN_REVEAL_MS = 112;
const ALL_IN_SETTLE_MS = 75;
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
    prepareMs: 50,
    holdMs: 0,
    squeezeMs: 94,
    revealMs: 94,
    settleMs: 62,
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
    prepareMs: 50,
    holdMs: 0,
    squeezeMs: 113,
    revealMs: 112,
    settleMs: 75,
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
    squeezeMs: 75,
    revealMs: 75,
    settleMs: 50,
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
    prepareMs: 100,
    holdMs: 200,
    squeezeMs: 150,
    revealMs: 150,
    settleMs: 100,
    overshoot: 1.03,
    staggerMs: 80,
    audioEnabled: true,
    lightSweepEnabled: true,
    threeD: true,
  }),
  /**
   * A spectator (spec 36, 94, 118). Same shape as cash and deliberately not
   * faster: somebody watching is doing nothing BUT watching, so there is no
   * action cadence to keep out of the way of. Its own id so telemetry can
   * separate watched hands from played ones - the two populations have very
   * different device mixes and averaging them hides both.
   */
  spectatorDesktop: profile({
    id: 'spectator-desktop',
    mode: 'spectator',
    platform: 'desktop',
    intensity: 'full',
    prepareMs: 50,
    holdMs: 0,
    squeezeMs: 94,
    revealMs: 94,
    settleMs: 62,
    overshoot: 1.03,
    staggerMs: 60,
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
    prepareMs: 50,
    holdMs: 0,
    squeezeMs: 113,
    revealMs: 112,
    settleMs: 75,
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
    squeezeMs: 56,
    revealMs: 56,
    settleMs: 38,
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
    squeezeMs: 56,
    revealMs: 56,
    settleMs: 38,
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

/**
 * THE FLOP IS NOT PROFILE-DRIVEN, AND ITS TELEMETRY HAS TO SAY SO.
 *
 * AUDIT FIX 2026-09-05. The flop presents through the engine (so it is
 * deduped, profiled for focus, and reported) but it does NOT run the squeeze:
 * it runs its own two-phase fan, whose timings live in CommunityCards.css and
 * are the same for every profile. The engine was recording the resolved
 * profile's `durationMs` for it - 560ms for a desktop cash flop - against an
 * animation that takes 1220ms, and measuring `durationActual` on its own
 * timer, so the two agreed with each other and both were wrong by half. An
 * operator reading that data would conclude flops were the fastest thing on
 * the felt.
 *
 * These four numbers ARE the stylesheet, and
 * tests/unit/cardPresentation/profiles.test.ts reads them back out of it, so
 * they cannot drift apart:
 *
 *   ccFlopLand      0.30s   each card slides in face down
 *   deal stagger    0.10s   per card, inline animation-delay
 *   fan delay       0.52s   before the first card turns (past the last land)
 *   fan stagger     0.14s   per card
 *   ccFlopFanOpen   0.42s   the turn itself
 *
 * Card 2 finishes at 0.52 + 2*0.14 + 0.42 = 1.22s.
 */
export const FLOP_FAN = Object.freeze({
  LAND_MS: 300,
  DEAL_STAGGER_MS: 100,
  OPEN_DELAY_MS: 520,
  OPEN_STAGGER_MS: 140,
  OPEN_MS: 420,
});

/** What a three-card flop actually takes, end to end, at speed 1. */
export const FLOP_FAN_TOTAL_MS =
  FLOP_FAN.OPEN_DELAY_MS + 2 * FLOP_FAN.OPEN_STAGGER_MS + FLOP_FAN.OPEN_MS;

/** The flip (squeeze + reveal + settle) is one CSS animation. */
export function flipMs(p: CardAnimationProfile): number {
  return p.squeezeMs + p.revealMs + p.settleMs;
}

/**
 * "Transitions that exceed 400ms may feel too slow" - Material Design, the
 * only published cross-platform duration guidance anyone in this space has.
 * Every profile's flip is at or under it, and a test asserts that so the
 * table cannot drift back over. See the research doc for the citation.
 */
export const FLIP_CEILING_MS = 400;

/**
 * "Transitions on mobile typically occur over 300ms ... Desktop animations
 * should be faster and simpler than their mobile counterparts ... 150ms to
 * 200ms." The old table had this backwards - mobile was the SHORT one -
 * because "mobile means cut it down" is the intuition everybody has and the
 * standard disagrees with.
 */
export const MOBILE_FLIP_MS = 300;
