/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ANIMATION PROFILE RESOLVER (spec 46, 47, 117)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Priority, highest first:
 *
 *   reduced motion   -> `reduced`      (system preference; the law says motion
 *                                       collapses, meaning never)
 *   hidden table     -> `off`          (a display:none multi-table slot; there
 *                                       is nothing on screen to animate)
 *   all-in + squeeze -> `allIn`        (THIS viewer is all-in, VIP, has the
 *                                       perk on and is not on a re-run: the
 *                                       card holds face down for THEM to
 *                                       squeeze open. An all-in runout with
 *                                       no squeeze right is an ordinary
 *                                       street to this resolver - the board
 *                                       looks the same as it does to every
 *                                       seat that is not squeezing)
 *   unfocused table  -> `background`   (visible beside the focused one)
 *   phone            -> `mobile`
 *   game mode        -> cash / tournament / lightning / replay
 *
 * The user's animation-speed preference is NOT resolved here. It is a
 * multiplier applied identically to every profile by the stylesheet
 * (var(--animation-speed)) and the JS windows (getAnimationSpeed()), and it
 * is the only user control the law permits (CLAUDE.md 10.6). There is no
 * "off" preference and this resolver never reads one.
 *
 * Table focus is an INPUT. The multi-table manager owns focus; this module
 * only asks (spec 48).
 */

import { CARD_PRESENTATION_PROFILES } from './profiles';
import type { CardAnimationProfile, CardPresentationPlatform, ResolveProfileInput } from './types';

export function resolveCardAnimationProfile(input: ResolveProfileInput): CardAnimationProfile {
  const P = CARD_PRESENTATION_PROFILES;
  /* AUDIT FIX 2026-09-05: HIDDEN OUTRANKS REDUCED MOTION. A table nobody can
     see should cost nothing at all, and `reduced` still schedules a 120ms
     presentation with markup to mount and tear down. Both answers put the
     correct card on the board; `off` is simply the cheaper way to say it. */
  if (input.focus === 'hidden') return P.off;
  /* REDUCED MOTION DOES NOT TAKE THE PERK AWAY (2026-09-05). A viewer who is
     owed the squeeze still gets the hold and the interaction; only the 3D
     turn collapses. See allInReduced in profiles.ts - measured on an emulated
     iPhone, this branch used to hand them `reduced`, which has no hold at
     all, so there was nothing on the felt to squeeze. */
  if (input.reducedMotion) {
    return input.allIn && input.squeeze === true ? P.allInReduced : P.reduced;
  }
  /* VIP ALL-IN SQUEEZE 2026-09-05: BOTH, never one. `allIn` alone used to
     hold the card face down for everyone at the table; Dan's rule is that
     the squeeze is presented only to a player who is all-in AND holds the
     perk, and that the run-out "should appear NORMAL and no different for any
     other users at the table". So a runout without the squeeze right falls
     through to the same profile the seat would get on any other hand. */
  if (input.allIn && input.squeeze === true) return P.allIn;
  if (input.focus === 'visible') return P.background;
  if (input.platform === 'mobile') return P.mobile;
  switch (input.mode) {
    case 'tournament':
      return P.tournamentDesktop;
    case 'lightning':
      return P.lightningDesktop;
    case 'replay':
      return P.replayDesktop;
    case 'spectator':
      return P.spectatorDesktop;
    case 'cash':
    default:
      return P.cashDesktop;
  }
}

/**
 * The phone breakpoint the board stylesheet already uses (CommunityCards.css
 * retargets --cc-card-w at 768px). One source for "is this a phone".
 */
export const MOBILE_MAX_WIDTH_PX = 768;
export const TABLET_MAX_WIDTH_PX = 1024;

export function detectPlatform(width?: number): CardPresentationPlatform {
  const w =
    typeof width === 'number' ? width : typeof window !== 'undefined' ? window.innerWidth : NaN;
  if (!Number.isFinite(w)) return 'desktop';
  if (w <= MOBILE_MAX_WIDTH_PX) return 'mobile';
  if (w <= TABLET_MAX_WIDTH_PX) return 'tablet';
  return 'desktop';
}
