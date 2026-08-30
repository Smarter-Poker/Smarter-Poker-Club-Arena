# 2026-08-30 — The bottom strip, and a way out of the sizing panel

Dan, with three screenshots: "table sizing is off because you are leaving too
much room at the bottom for the action bar (the one that clicks to expand with
the slider). That can overlap the hero and block them when clicked ... you can
slide the table down to leave more room at the top for the top villain and
increase the length of the actual table." And: "you should be able to click the
back button or anywhere on the top of the screen to close the action bar and go
back to the 3 hot keys."

## 1. The strip below the felt IS one number, and it was a flat one

The gap between the felt's bottom edge and the action bar's top edge is
`--sp-hero-clear` exactly, on every device, insets or not:

    gap = --sp-table-bottom - (--sp-bottom-row-h + safe-area-inset)
        = (action-reserve + hero-clear) - action-reserve
        = --sp-hero-clear

What it has to hold is the part of the hero seat hanging below the felt, because
the hero's avatar CENTRE sits on the scaler's bottom edge. It was a flat 68px.

**A flat number cannot be tight on two phones at once**, and the first attempt
(68 -> 62) proved it: the new guard failed, correctly, saying 62px still carried
14.7px of nothing on an iPhone SE while leaving only 2.7px on a Pro Max. The
hero block has been PROPORTIONAL since #1650 — the avatar is 15.8% of the felt,
the hero's is 1.3333x that — so the thing this reserve holds scales while the
reserve did not. Measured, the overhang is a flat 13.4-14.3% of felt width on
every device in the harness.

So the reserve rides the same curve: `clamp(50px, 14.6vw, 68px)`. NOT off
`--table-w`, which would be circular (the felt's height is derived from this
reserve), which is the same trap ActionPanel.css names for the bar. `vw` is free
of the loop and is the right proxy on a phone precisely because the felt has
been edge-to-edge since 2026-08-29.

    375 (SE)          54.8px reserve against a 47.3px block
    390 (Dan's)       56.9px  against 55.3px
    430 (Pro Max)     62.8px  against 59.3px

**And the first 6px is spent on the top, not on length** — the half of the
instruction that is easy to miss. `--sp-table-top` goes 8px -> 14px, so the oval
slides 6px down and the top villain gets the room. Net on Dan's phone: the felt
is 5px longer AND sits 6px lower.

    iPhone SE          331.8 x 474    ->  336.8 x 481.2
    iPhone 12/13/14    390 x 650.5    ->  390 x 655.5
    Dan's, real insets 390 x 569.5    ->  390 x 574.5
    iPads              lose ~5px of length, gain the 6px slide

That is all there is down there, and it is worth saying plainly: the felt
already consumes about 75% of the vertical budget, the bar's own height is the
rest, and the "empty" band in the screenshot is mostly the hero's own strip
(avatar bottom half, name plate, hand-strength pill, HUD tiles). To make the
table meaningfully longer than this, the pixels have to come out of the action
bar's height or the hero strip's contents — both Dan's to spend, not an agent's
to assume.

**The guard is new and pins BOTH sides.** `the bottom reserve holds the hero
block on every phone, with nothing spare` fails if the reserve stops covering
the block (the 2026-08-23 bug, a plate under the bar) OR if it carries more than
8px of slack (this report). Tablets are excused with the reason written down:
they legitimately overhang past the reserve and clear on the bar's own height.

## 2. A tap above the sizing panel puts the three hot keys back

The overlay is tall and `position: fixed`, so on a phone it stands over the
bottom of the felt — including, at some stack sizes, the hero's own cards. The
ways out were the Back button at the top of the overlay and the Raise button
behind it: both small, both at the bottom, and neither is where a thumb goes
when the reflex is "get this out of my way".

A `pointerdown` outside the panel now closes it. Three details, each
load-bearing:

- **capture phase, and the event is stopped.** The dismissing tap must not ALSO
  reach the felt — dismissing over an open seat would try to seat the player,
  which is the class of surprise that costs money. First tap closes, second acts.
- **scoped to this table's root**, not the document. Tile view paints four
  tables at once; a document listener would let a tap on table two dismiss table
  one's slider — the same defect the `ca-raising` flag had to be moved off
  `document.body` to fix.
- **`pointerdown`, not `click`.** A click fires after the gesture completes, so a
  slider drag ending outside the panel would close it on release.

Escape does the same on a desktop. Five beats in
`tests/unit/raisePanelDismiss.test.tsx` render the real component and dispatch
real events, including the three failure modes above.

One harness note worth keeping: the first version of that test appended the felt
to the container BEFORE rendering, and React clears the container it is given —
so every beat was tapping a detached node. Escape passed while a tap did not,
which is what exposed it. The felt is appended after render now, with the reason
written beside it.
