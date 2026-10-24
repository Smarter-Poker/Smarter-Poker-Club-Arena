# 2026-10-24 - The spade console frame is solid all the way through

Dan, on the Tournament Break card: "TOURNAMNET BREAK CARD IS BROKEN... YOU
SHOULDN'T SEE ANYTHING INSIDE THE FRAME OR IN THE CARD, IT SHOULD BE 100% SOLID
ALL THE WAY THROUGH THE FRAME AND INSIDE OF THE CARD."

## Cause

The Tournament Break card is a `SpadeConsole`. The spade master's slices
(`console/spade-console-v1/*`) were cut with transparent windows inside the
frame. The 2026-09-23 fix ("THE GLASS IS SOLID") laid the glass tone under the
rectangle between the rails, but these windows stayed open, measured on the
slices:

- `top.png`: the gap between the outer frame and the header well (rows 86-98),
  the band under the head's chrome rule (rows 318-347), the gaps around the
  pill slot and the crest housing;
- `mid.png`: the channels between the right rail's strands (x 945-958 and
  967-970);
- `bottom-foot.png` / `bottom-plates.png`: the chamfered corners and the band
  inside the closing rail, plus a break in the plates foot's outer left strand.

Over a live table the felt, the seats and their chips showed through all of
them. Rendered at 393px over a striped background, the old card leaked under the
title, around the Share pill and down both rails.

## Fix

`scripts/art/solidify-spade-console.py` derives `console/spade-console-v2/`
from v1: every pixel inside the outer silhouette is composited over the
master's glass tone `#0a0b0d` and made fully opaque. Nothing outside the frame
changes, and the art on top is unchanged. v1 is untouched because a pooled asset
URL never changes bytes.

`SpadeConsole.css` (every spade console, every crest) and the break screen's
minimized badge now use v2. The fix is in the kit, so every surface on this
master inherits it, not only the break card.

## Pinned

`tests/unit/theConsoleGlassIsSolid.test.ts` now stacks every head the kit uses
over the rails and each foot, floods the outside in from the border, and
requires every pixel the flood cannot reach to be opaque. Pointed at v1 it fails
on every combination (84,200 to 139,808 see-through pixels); on v2 it reads 0.

`docs/art/matte-baseline.json` records `spade-console-v2/mid.png` at 0.5%: the
same five brushed rail columns as v1, over a larger opaque area.
