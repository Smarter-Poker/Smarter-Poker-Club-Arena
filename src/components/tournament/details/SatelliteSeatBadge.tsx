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
 * THE WORDS ARE "Satellite Winner" (Dan, same day), and since 2026-08-28
 * they are ON SCREEN, before the dish, not hidden in a tooltip: "ADD
 * 'SATELLITE WINNER' BEFORE EACH SATELITTE ICON." A tooltip was the wrong
 * home for them anyway - it needs a hover to appear, and hover has just been
 * removed from these surfaces, so on a phone the meaning was unreachable.
 *
 * The visible text is now the label, so the image is marked `alt=""` and
 * `aria-hidden`: it is decoration beside words that already say the thing.
 * Giving both the same string makes a screen reader read "Satellite Winner
 * Satellite Winner", which is why the alt is empty rather than duplicated.
 *
 * RENDER SIZE IS 30px — 50% larger than the 20px this badge first shipped at,
 * because at 20px the arcs and the rim highlights read as noise on a phone.
 * The PNG ships at 4x the render size so it stays sharp on a 3x retina panel.
 *
 * THE FILENAME CARRIES A VERSION, AND THAT IS NOT DECORATION. Files under
 * `public/` are copied through the build verbatim — Vite hashes code chunks,
 * it does NOT hash these — and production serves them
 * `cache-control: public, max-age=2592000`. So on 2026-08-28 the artwork was
 * replaced twice AT THE SAME PATH, the bytes on the CDN changed both times,
 * and every browser that had already loaded the old icon kept painting it
 * from disk for the next thirty days. The deploy was correct and the screen
 * was wrong, which is the worst shape a bug can have. Bumping the filename
 * changes the URL, and a URL that has never been requested cannot be stale.
 * `header-settings-v4.png` and `header-help-v4.png` in this same folder are the
 * same lesson already learned once.
 *
 * `satellite-seat-icon.png` was kept beside it for a day, holding the SAME
 * bytes, so that a browser still running the previous JS chunk rendered the new
 * art rather than a broken-image box. DELETED 2026-08-29: it had no importer
 * left in `src/`, no reference anywhere in the built bundle currently serving
 * from the World Hub, and a build a day old is not still in flight. It was
 * 22,434 bytes of duplicate binary in the repo and in every deploy.
 *
 * IF YOU CHANGE THE SIZE, change `width`/`height` here AND `.sw-badge__icon`
 * in the stylesheet together. The attributes reserve the box before the
 * image loads, so a long entries list does not reflow as icons arrive; the
 * CSS is what actually paints. One without the other is the bug that makes
 * every row jump once.
 */

import { mediaUrl } from '../../../utils/mediaBase';
import './SatelliteSeatBadge.css';

export default function SatelliteSeatBadge() {
  return (
    <span className="sw-badge">
      <span className="sw-badge__text">Satellite Winner</span>
      <img
        className="sw-badge__icon"
        src={mediaUrl('images/satellite-winner-v3.png')}
        alt=""
        aria-hidden="true"
        width={30}
        height={30}
        loading="lazy"
        decoding="async"
      />
    </span>
  );
}
