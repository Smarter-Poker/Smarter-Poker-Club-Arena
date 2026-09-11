# Cut the white matte off the painted shells

Dan, 2026-09-10, after the arena nav was rebuilt on the club-nav-shell frame:
"you must clean up the white background under the image, the bottom and sides
must look like the top ... that shitty white broken background can not be
there. use python to clean up the image background."

He had said it before. The reason it kept coming back is that it was never in
the CSS at all: it is baked into the artwork, so every surface that draws one
of these shells inherited it.

## What was wrong, measured

`club-nav-shell.png` (1829 x 313) carries a smooth neutral ramp OUTSIDE the
frame at full alpha - lum 95 rising to 220, |B-R| <= 3, no local structure -
with a torn dashed edge where it was clipped. At the centre column the frame
ends in its dark outline at y=266 and rows 267-305 are matte. On the left it
widens toward the corner: 6px of matte at y=156, 34px at y=240, 38px at y=260.
The top is clean only because the plate is cropped flush at y=0, which is
exactly why Dan could say the bottom and sides should look like the top.

It was exported with the glow rendered as WHITE instead of cut out.

## The fix

`scripts/art/clean-shell-matte.py` (numpy + Pillow only, so it runs wherever
the art lives). The frame always begins, from any outside direction, with a
structured pixel - a dark outline, a blue-tinted bevel or LED, or brushed
chrome. The matte never is. So it floods inward from the transparent exterior
through matte-like pixels only, trims whatever still sits past the locally
smooth silhouette, and repeats, because trimming a tooth exposes the matte
behind it.

A flood rather than a per-row scan: one speck of tear left in a row would
shadow the rest of that row and strand a grey wedge against the chamfer, which
is what the first attempt did. The local range is measured over OPAQUE
neighbours only - counting transparent pixels as black invents a hard edge
along the whole alpha boundary and the fill stops on its first step. The trim
uses a median filter, which reproduces a straight ramp exactly, so the
45-degree chamfers survive while an outlier tooth is clipped.

Only alpha is written. Every kept pixel is bit-identical to the master, and
the top rail loses nothing (asserted: 0 pixels removed above y=30).

## What was cleaned, and what was deliberately not

Cleaned, each verified on magenta and re-checked for convergence:

| asset                                        | matte cut |
| -------------------------------------------- | --------- |
| club-nav-shell                               | 12.7%     |
| wallet-row-shell                             | 3.0%      |
| club-utility-shell                           | 2.8%      |
| wallets/square/wallet-agent-wallet-square-v1 | 0.6%      |

The `.webp` beside each is regenerated from the cleaned PNG, since that is what
the CSS loads. Lossless would have been 10x the bytes (320KB against 31KB for
the nav shell), so they stay lossy at q90 - within a few KB of the originals -
with the RGB under fully transparent pixels zeroed first so a lossy encode has
no white left to bleed back along the edge.

NOT cleaned, on purpose:

- `club/club-identity-icon-club-v1` and `-player-v1`. The detector flagged them
  at 7.8% and 2.8%, but those icons ARE a smooth neutral silver temple and
  figure - the artwork matches the matte description. Running it a second time
  reported 12.0% still to remove, which is a detector eating the icon, not a
  matte. Reverted.
- `console/spade-console-v1/mid.png`. It removed 5 of 118 rail pixels per row
  from an 8px repeating strip for no visible gain, and that is approved console
  kit art that tiles.

Convergence is the check that separates the two cases: a real matte goes to
~0% on a second pass; artwork does not.
