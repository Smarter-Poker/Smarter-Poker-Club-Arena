# The gold line was missing, and so was a third of the table's alignment

2026-09-08. Dan, with a screenshot of MADNESS NLH 2/5 and a crop of the right-hand
seat: _"DO A DEEP DIVE INTO ALL THE TABLES, SKINS AND BACKGROUNDS, AS WELL AS
EVERY SINGLE AVATAR. AND FIX ANYTHING AND EVERYTHING THATS DISTORTED OR BROKEN."_

The crop showed the gold racetrack line down the right side of the felt chopped
into dashes. It reads like a rendering artefact — a hairline losing the fight
with a downscale — and that is what it was assumed to be for as long as it has
been shipping. It is not. It is painted that way.

## 1. `skin_classic_green.png` has a hole in it

Scanning the line row by row down each straight, and taking each side against
its own median brightness:

| side  | median | rows below 88% |
| ----- | ------ | -------------- |
| left  | 235    | 3              |
| right | 249    | 66             |

The 66 are not scattered. **y=371 to y=406 has no line at all** — 36 consecutive
rows of bare felt where the stripe should be — with a scatter of nicks either
side of the hole. One side of one skin. The left side, 400px away, is perfect.

Repaired by rebuilding each dead row from the nearest sound row above and below.
Exact here, because through that stretch the line is a dead-vertical constant
x=503 and the felt gradient over 36 rows is linear.

**Not** mirrored from the left, which was the first idea. The felt carries a
left-to-right light gradient; mirroring lands a mean error of 20 luminance levels
(p90 63) on rows that are currently correct.

The first attempt did produce a visible grey smear, and it is worth saying why:
it used one threshold for "is this row broken" and "may I copy from this row".
The rows either side of the hole are its shoulder — dimmed to ~240 where the
sound line blows out to 255 — and they cleared an 88% bar comfortably.
Interpolating between two shoulders reproduces the shoulder for 36 rows. Donors
now have to clear 97%.

## 2. Five skins paint the table somewhere else

Measuring all fourteen for the first time turned up the larger fault. `TablePage.css`
gives every skin one geometry:

```
.table-surface { left: 13.3%; top: 8.9%; width: 73.2%; height: 80.3% }
.table-art     { object-fit: fill }
```

There is no per-skin offset, so the painted table has to sit in the same box on
every 605x1000 canvas. Seven of them agree to the pixel — the signature of one
master render with only the material changed. Five do not:

| skin           | opaque box (before) | drift from canonical    |
| -------------- | ------------------- | ----------------------- |
| `arctic_white` | 60,14 582,982       | 40px right, 42px narrow |
| `ice_cavern`   | 30,56 562,956       | 46px low, 79px short    |
| `ocean_blue`   | 49,25 574,980       | 29px right, 39px narrow |
| `neon_city`    | 42,21 581,985       | 22px right, 24px narrow |
| `crimson`      | 35,12 579,979       | 15px right, 20px narrow |

Canonical is `20,10 584,989` — 565x980.

On the ~460 CSS px a phone renders the table at, arctic_white's 40px is a visible
30px shove: the seat ring over the rail down one side and off it down the other,
the pot nearer one edge than the other. And it moved when the player changed
skins, which is the shape of a complaint that arrives as "the table looks weird
sometimes" and never gets reproduced.

Each of the five is resampled by the affine that maps its own opaque box onto the
canonical one. Lanczos, at most 8% scale, on art already displayed below 1:1.

`final_table` is left alone on purpose: it paints gold wings outside the rail, so
its alpha silhouette is not its table body. Its body measures 551x983 centred
within 2px.

## 3. What was deliberately not touched

`carbon_ion`'s cyan tube stops, caps off and starts again at the table's
midpoint — **symmetrically, both sides, the same rows**. Symmetric is what design
looks like; damage lands on one side, as classic_green's did. Its specular core
is ragged too, and reads as an uneven highlight at display size rather than a
hole. A detector that is allowed to decide on its own what counts as broken art
will eventually repaint something its author drew on purpose, so the repair takes
a declared list and discovers nothing.

Backgrounds (31, all 720x1280) and avatars (100 table avatars in three variants
each, plus 24 free and 76 VIP sources at 1024x1024) were measured in the same
pass and are sound: no missing variants, no baked-in backgrounds, no blanks, no
aspect distortion. The one loose end is `public/avatars/table/SAMPLE_viking.webp`
in the World Hub, a 78x125 development leftover backed by no source avatar.

## 4. What stops it happening again

`tests/table-skin-art-is-sound.law.test.ts` asserts, for all fourteen:

- a 605x1000 canvas
- an opaque box within 8px per edge of canonical
- no run longer than 6 rows where the racetrack line drops below 55% of its own
  median

Both thresholds are loose on purpose. 8px (~1.3%) leaves the four skins sitting a
pixel or two out alone rather than resampling them for nothing. 55% is a hole,
not a highlight — tighter and carbon_ion goes red for its design, and the next
agent "fixes" it.

The row scan runs 300..700 rather than the full 255..730 the table is straight
over: at the ends of the wider range the stripe has begun to bend, the scan
follows it out of its window, and electric_purple was reported as having a 7-row
hole in a stripe that is intact. Two sides are exempt by name and reason, in
`LINE_EXEMPT` — carbon_ion (segmented by design) and ice_cavern's left, which has
no stripe at all, only a broad uneven ice glow.

Verified the law fails on the art as it was: `skin_arctic_white` on geometry
(40 > 8) and `skin_classic_green` on a 30-row hole at y=374..403.

`scripts/repair-table-skins.mjs` is idempotent — it runs the line pass to a fixed
point, because repairing raises the median and can pull a marginal row under the
cut — so the committed bytes are the ones the committed script reproduces.
