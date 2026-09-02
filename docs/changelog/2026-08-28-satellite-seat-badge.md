# 2026-08-28 — Satellite seat badge: fix the 404, one component, transparent art

Dan 2026-08-28: the SAT pill on tournament Entries (and Ranking) must be
replaced with the supplied satellite dish icon next to every player who won
their seat.

An earlier commit already swapped the pill for an `<img>` — but it shipped
`src="/images/satellite-icon.jpg"`, a root-absolute path. This SPA serves
from `smarter.poker/hub/club-arena/`, so that URL asks the World Hub for the
file and 404s in production (verified: `/images/satellite-icon.jpg` → 404,
`/hub/club-arena/images/satellite-icon.jpg` → 200). Every satellite qualifier
row was rendering a broken image.

Changes:

- `SatelliteSeatBadge.tsx` — one shared component for both surfaces, so the
  mark cannot drift between tabs again. Resolves its art through
  `mediaUrl()` (Phase U5.3), the house rule for all static media.
- `EntriesTab.tsx` / `RankingTab.tsx` — the two inline `<img>` copies replaced
  with the component.
- `public/images/satellite-seat-icon.png` — the supplied dish artwork,
  circle-cropped to transparency at 96px (19KB), replacing the 362KB black
  JPG square that needed border-radius to fake a circle. The dead
  `satellite-icon.jpg` is removed; nothing references it and its only path
  never resolved.

The "Levels — N Min" row on the detail Overview tab (the other half of Dan's
2026-08-28 ask) is already on main from the same earlier commit and is
unchanged here.
