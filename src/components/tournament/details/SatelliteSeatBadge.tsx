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
 * Dan 2026-08-28, second pass: the artwork is now the DYNAMIC dish chip he
 * supplied — a chrome-rimmed black chip with a blue neon dish and signal arcs,
 * already circular with a transparent surround, so nothing here crops or
 * rounds it. RENDER SIZE IS 30px, exactly 50% larger than the 20px this badge
 * first shipped at, because at 20px the arcs and the rim highlights read as
 * noise on a phone. The PNG ships at 120px — 4x the render size — so it stays
 * sharp on a 3x retina panel with room to grow again without a re-export.
 *
 * IF YOU CHANGE THE SIZE, change `width`/`height` AND the inline style
 * together. The attributes reserve the box before the image loads (no layout
 * shift in a long entries list); the style is what actually paints. One
 * without the other is the bug that makes the row jump.
 */

import { mediaUrl } from '../../../utils/mediaBase';

export default function SatelliteSeatBadge() {
  return (
    <img
      src={mediaUrl('images/satellite-seat-icon.png')}
      alt="Satellite Qualifier"
      title="Won Their Seat Via Satellite"
      width={30}
      height={30}
      style={{ width: 30, height: 30, flex: '0 0 auto', verticalAlign: 'middle' }}
      loading="lazy"
      decoding="async"
    />
  );
}
