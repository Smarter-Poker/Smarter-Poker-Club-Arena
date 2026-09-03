# Satellite seat badge — new artwork, 50% larger

Dan, 2026-08-28: "REPLACE THE CURRENT SATELLITE IMAGE ON THE TOURNAMENT PAGE
THAT WE USE TO IDENTIFY PLAYERS WHO 'WON THEIR SEAT' WITH THIS NEW DYNAMIC
ONE. MAKE IT 50% LARGER THAN THE CURRENT SIZE PUBLISHED NOW."

## What changed

- `public/images/satellite-seat-icon.png` — replaced with the supplied chip
  artwork: chrome-rimmed black chip, blue neon dish and signal arcs. The
  source was already circular on a transparent surround, so it is trimmed to
  its bounding box, squared, and resampled to **120px** (Lanczos) with the
  alpha edge intersected against a clean circle so the rim antialiases rather
  than stair-steps. 31.7KB.

- `src/components/tournament/details/SatelliteSeatBadge.tsx` — render size
  **20px -> 30px**, which is the 50% Dan asked for, applied in BOTH the
  `width`/`height` attributes (box reserved before load, so a long entries
  list does not shift) and the inline style (what actually paints). The PNG
  ships at 4x the render size so it stays sharp on a 3x retina panel.

## Where it shows

One component, two surfaces, unchanged:

- `EntriesTab.tsx:368` — inside `.et-marks`
- `RankingTab.tsx:234` — inside `.rk-nameline`

Both containers are `display: flex; align-items: center` with no fixed height,
and `.tl-row` sets `min-height: 52px` rather than `height`, so the taller mark
grows the row instead of being clipped. `.et-marks` already wraps below 420px.

No schema change, no RPC, no test pinned the old size.
