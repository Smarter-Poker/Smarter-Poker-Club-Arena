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
 *   all-in runout    -> `allIn`        (the server paces the street; the card
 *                                       holds face down for that exact beat)
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
  if (input.reducedMotion) return P.reduced;
  if (input.focus === 'hidden') return P.off;
  if (input.allIn) return P.allIn;
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
