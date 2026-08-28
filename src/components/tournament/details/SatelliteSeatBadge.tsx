/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SATELLITE SEAT BADGE — the dish icon on players who won their seat
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28: "THERE NEEDS TO BE A SATELLITE ICON NEXT TO ALL THE PLAYERS
 * THAT WON THEIR SEATS. THE SAT PILL NEEDS TO BE REPLACED WITH THIS."
 *
 * One component, used by BOTH surfaces that mark a satellite qualifier
 * (EntriesTab and RankingTab), so the mark can never drift between tabs the
 * way the two inline copies it replaces already had.
 *
 * WHY mediaUrl AND NOT `/images/...`: this SPA is served from
 * `smarter.poker/hub/club-arena/`, so a root-absolute `/images/...` src asks
 * the World Hub for the file and 404s in production — which is exactly what
 * the first version of this badge shipped doing. Every static media reference
 * goes through `mediaUrl()` (Phase U5.3) so the base, and any future CDN
 * flip, is decided in one place.
 *
 * The artwork is the supplied dish icon, circle-cropped to TRANSPARENCY at
 * 96px (19KB PNG) so it stays crisp on retina at its 20px render size and
 * needs no border-radius fakery over a black JPG square.
 */

import { mediaUrl } from '../../../utils/mediaBase';

export default function SatelliteSeatBadge() {
  return (
    <img
      src={mediaUrl('images/satellite-seat-icon.png')}
      alt="Satellite Qualifier"
      title="Won Their Seat Via Satellite"
      width={20}
      height={20}
      style={{ width: 20, height: 20, flex: '0 0 auto', verticalAlign: 'middle' }}
      loading="lazy"
      decoding="async"
    />
  );
}
