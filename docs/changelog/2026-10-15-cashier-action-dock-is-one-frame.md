# The Cashier Action Dock Is One Frame

Dan, 2026-10-15, with two screenshots: both frames had "weird broken top
lines", and the selection box sat in a generic box behind the premium action
frame, "like one premium frame behind one generic frame".

## The Broken Top Lines

The footer master `club-arena-footer-v2.webp` carries the tips of its emblems
above the top rail: short grey fragments in rows 14-17 between the corner
caps. `cashier-action-bar-v1.png` was derived from that master and inherited
them. Both now have those rows cleared between x 100 and 1815; the corner caps
are untouched.

- `public/images/club-footer/club-arena-footer-v3.webp` (lossless WebP with
  alpha, 1916 x 256). The v2 file stays in place for tabs that still hold it.
- Every reference to v2 moved to v3 in the same commit.

## One Frame

The selection line ("N Selected · X Held", Clear) now prints into the top of
the same painted frame as Claim Back, Send Ticket and Send Out. With nothing
selected it reads "Tap A Player To Select". The dock behind it is transparent
and as wide as the frame, so no generic box remains.

The frame is the cleaned master's quilt extended by whole vertical periods
(78 px, measured), so rails, corners and quilt are the master's own:

- `cashier-action-dock-v1.png` 1916 x 334 (one extra period), desktop.
- `cashier-action-dock-tall-v1.png` 1916 x 412 (two), at 640px and below.

Padding is set as a share of the width, which is a fixed share of the frame's
height because the frame's aspect is fixed.
