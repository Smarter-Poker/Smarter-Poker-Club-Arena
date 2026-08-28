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
 * THE ARTWORK, third pass. Dan supplied a free-standing dish — brushed chrome
 * mount, blue reflector, three neon signal arcs — with no chip or disc behind
 * it. It is therefore NOT circle-cropped: the previous artwork was a round
 * chip and got an alpha circle intersected over it to clean the rim, and
 * doing that here would slice the arcs and the base clean off. It is trimmed
 * to its own bounding box, centred on a square canvas, and resampled to
 * 120px. Its silhouette is the mark; do not add a background plate.
 *
 * THE WORDS ARE "Satellite Winner" (Dan, same day). Both `alt` and `title`
 * carry it, so the tooltip a mouse gets and the string a screen reader
 * announces are the same phrase, and neither can drift from the other.
 *
 * RENDER SIZE IS 30px — 50% larger than the 20px this badge first shipped at,
 * because at 20px the arcs and the rim highlights read as noise on a phone.
 * The PNG ships at 4x the render size so it stays sharp on a 3x retina panel.
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
      alt="Satellite Winner"
      title="Satellite Winner"
      width={30}
      height={30}
      style={{ width: 30, height: 30, flex: '0 0 auto', verticalAlign: 'middle' }}
      loading="lazy"
      decoding="async"
    />
  );
}
