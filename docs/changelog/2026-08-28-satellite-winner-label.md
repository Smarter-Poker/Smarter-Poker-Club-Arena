# Satellite badge — free-standing dish artwork, and it now says "Satellite Winner"

Dan, 2026-08-28: "replace the existing satellite image with this new one. And
it should say, 'Satellite Winner'"

## What changed

- `public/images/satellite-seat-icon.png` — replaced with the free-standing
  dish: brushed chrome mount, blue reflector, three neon signal arcs, no chip
  or disc behind it. **Not circle-cropped.** The artwork it replaces was a
  round chip, so it got an alpha circle intersected over it to clean the rim;
  doing that to this one would slice the arcs and the base clean off. Trimmed
  to its own bounding box, centred on a square canvas, resampled to 120px
  (Lanczos). 22.4KB, down from 31.7KB.

- `src/components/tournament/details/SatelliteSeatBadge.tsx` — `alt` and
  `title` both read **"Satellite Winner"**, replacing "Satellite Qualifier"
  and "Won Their Seat Via Satellite". Carrying the same phrase in both means
  the tooltip a mouse gets and the string a screen reader announces cannot
  drift apart.

Render size stays 30px — unchanged from the previous pass, where the 50%
increase Dan asked for was applied.

## Where it shows

One component, two surfaces, unchanged:

- `EntriesTab.tsx` — inside `.et-marks`
- `RankingTab.tsx` — inside `.rk-nameline`

No schema change, no RPC. No test pinned the old wording or the old artwork.
