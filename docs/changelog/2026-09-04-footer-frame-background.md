# The footer frame stops carrying a black box around it

**Date:** 2026-09-04
**Branch:** `fix/footer-frame-background`
**Reported by:** Dan, with screenshots — "YOU NEED TO CLIP THE BACKGROUND
AROUND THE EDGES OF THE FOOTER FRAME (SEE ATTACHED IMAGES WITH THE BLACK
BEHIND THE FRAMES)", then "almost every footer on every page across
smarter.poker, club arena, and club commander have this same background
issue."

## What was wrong

`club-arena-footer.webp` is a rounded metal frame drawn on a rectangular
1916x256 canvas, and that canvas was **opaque**. Two consequences, both
visible:

1. **The corners.** Outside the frame's curve, the canvas is solid black. With
   no alpha channel, those four corner wedges are painted onto the page as
   black squares. Nothing in CSS can clip a colour that is inside the image.
2. **The band above the frame.** The canvas carries a built-in gutter around
   the artwork — 25px each side, 14 above, 12 below. `.artworkImage` already
   overscanned horizontally (`width: 102.68%`) to push the side gutters off
   screen, but vertically it was `height: 100%`, so the 14 gutter rows stayed
   inside the box and drew a black strip along the top edge of the footer.

`.bottomNav` and `.artwork` also both declared `background: #000`, which would
have kept the corners black even after the asset gained transparency.

## What changed

- **`public/images/club-footer/club-arena-footer.webp`** — re-encoded with an
  alpha channel. The frame is isolated by finding, per row and per column, the
  first and last run of four consecutive non-black pixels (a run, not a single
  pixel: the canvas margin carries isolated specks a few units above black,
  and taking the first lit pixel would drag the edge out into the background
  and paint a streak), intersecting the two sweeps, flood-filling any interior
  hole, and feathering the boundary by one pixel so the curve stays
  anti-aliased. Saved lossless: **RGB is byte-identical to the approved
  artwork wherever alpha is non-zero** (verified: MSE 0.0 over every visible
  pixel), and the file is _smaller_ than before — 345,322 bytes against
  369,146. `scripts/optimize-dist-media.mjs` already skips
  `images/club-footer/` (`maxDim: 0`), so the build ships these bytes.

- **`ClubBottomNav.module.css`** — `background: transparent` on `.bottomNav`
  and `.artwork`, and the vertical half of the overscan the horizontal half
  has always had:

  ```
  width  = 1916 / 1866 = 102.6795%    left = -25 / 1866 = -1.3398%
  height =  256 /  230 = 111.3043%    top  = -14 /  230 = -6.0870%
  ```

  The frame's measured rect (x=25 y=14 1866x230) now covers the footer box
  exactly on both axes. **The footer's own size does not change** — the box is
  still `var(--bottom-nav-height)`, `clamp(44px, 13.72vw, 132px)`. What
  changes is that the frame fills it instead of sitting inside it with black
  above and below.

  `max-width: none; max-height: none;` was added defensively. This repo has no
  global image reset today, but the World Hub does, and its
  `img, video { max-width: 100% }` clamped exactly this kind of overscan and
  letterboxed all fourteen of its footers before anyone traced it.

## Enforcement

`tests/footer-clearance.test.ts` now pins all four overscan percentages, the
`max-width: none` immunisation, both transparent backgrounds, and reads the
asset's own WebP header to assert the alpha bit is set (VP8L, 1916x256,
`alpha_is_used = 1`). A future "optimisation" that flattens the asset back to
RGB fails there rather than in Dan's screenshot.

## Not affected

**Club Commander has no footer.** Its routes appear in neither
`world-footer-navigation.json`'s `routePrefixes` nor
`bottom-nav-routes.json`, and nothing under `pages/commander`,
`pages/hub/commander` or `src/components/commander` renders a bottom bar of
its own. There was nothing to fix there.

The World Hub's fourteen world footers had the identical defect and are fixed
in that repo on `fix/social-footer-scroll-and-frame`.
