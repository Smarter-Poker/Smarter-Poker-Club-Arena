# Buy-in, on the four-bay deck

2026-09-14. Branch `feat/felt-buy-in`. Fourth surface of the felt sweep, and
the first on the fourth frame family.

`BuyInModal` - the sheet every cash seat opens through - was the generic
metallic chassis: a bevelled amount box, four bevelled quick buttons, a
rounded confirm bar, a countdown in the corner. It now wears the four-bay
deck, the approved master with four printed bays across its foot and two
plates under them, cut into a stretchable chassis for the first time here.

## The four-bay family

`public/assets/club-buttons/console/fourbay-console-v1/{top,mid,bottom}.png`,
900px wide: a 205px head with the shark crest and the pill slot, an 8px rail
band that repeats for the well, a 568px foot carrying the four bays and both
plates. `SpadeConsole` learns `family="fourbay"` and a `bays` prop: four
`{ label, value, ink }` printed over the bay wells in the foot, label in lit
blue, value in the master's ink at a 0.4 floor so a wide figure shrinks
before it clips. The head zones were re-measured against the kit's own type
after the first render cut the feet off the eyebrow: a 2.6cqw face in a 1.6
line box needs 3.4% of the canvas, the same share the spade gives it.

Two things about this deck's plates. They are the narrowest in the kit - a
third of the console each and 32px tall at 375px - and a buy-in's labels are
long and honest. So:

- The label that prints is the label the tests read. "Buy In With Diamonds",
  "Insufficient Balance", "Balance Unavailable", "Retry Original Buy-In" are
  pinned by `diamondCashBuyIn`, `buyInModalUnknownBalance`,
  `buyInModalConfirmationFailure` and the run-it-multiple-times law; none
  was shortened. On one line they hit the half-size floor and still lost
  their last letters to the rim. `useFitText` gains `wrapBelow`: when the
  one-line fit lands under it the hook marks the span `data-fit-wrap` and
  measures again as a two-line block, keeping the wrapped result only when
  it renders larger. The four-bay family opts in at 0.72; nothing else does,
  so no plate on the spade, shark or riveted frames changes.
- The button over each plate bleeds 14 canvas px above and below the painted
  face, the label still centred on the paint: 44px tall at 375px, the height
  a thumb needs, where the face alone gave 32. Nothing else prints within the
  bleed.
- The plate's side padding is 1cqw of the console, not the kit's 4%. A
  percentage pads an absolutely positioned button by its containing block -
  the foot - which took 30px off a 123px plate. The well is 92% of what is
  left; the zone already sits 15px inside the face.

## What prints where

- Eyebrow the table name (Diamond Seat or Cash Game when there is none),
  title Buy-In (`buy-in-modal-title` kept, visually hidden as the accessible
  name and printed on the glass), the countdown as the pill: Closes 47s, red
  from ten seconds.
- The amount in big silver numerals over Buy In For, or Original Buy-In in a
  recovery; the quick amounts (min, a third, two thirds, MAX - same dedupe as
  before) as lit words, the chosen one in white; the vertical slider beside
  them with its caps, the one drawn control because the art paints none.
- Account Balance or Available Diamonds in the balance line, red when short,
  Unavailable with a lit Retry word when unknown; Top Up Account as a lit
  word when short and a top-up is offered.
- Min, Max, Buy-In and In Blinds in the four bays. The buy-in bay is green
  when the balance covers it, red when it does not, muted when unknown,
  silver in a recovery, where the modal makes no claim about it.
- Close (`aria-label="Close Buy-In"`, blocked while a confirm is in flight)
  and the confirm on the two plates: Buy Chips, Buy In With Diamonds,
  Insufficient Balance, Balance Unavailable, Retry Original Buy-In,
  Joining... - the pulse on a guarded confirm now brightens the label.
- The recovery notice and the confirm error as copy on the glass, `role`
  `status` and `alert` as before.

## Re-rendered, not rewritten

Everything above the render is untouched: the default to max, the cent-exact
clamp, the whole-Diamond rule, the reachable-max slider grid, the count-up,
the confirm guard and its error copy, the recovery path, the Escape handler.
`theFeltStaysReachable` read the close button's name as a JSX attribute; it
now accepts the plate's prop spelling too, which is the same accessible name.

## Verification

Rendered at 393px in five states - cash, a Diamond seat, short with eight
seconds left, balance unknown, a recovery - and at a 1000px viewport where
the dialog sits at its 560px cap. Every plate label sits inside its face:
Close on one line, the four long labels on two at the full wrapped size,
zero overflow measured on the widest line. The eyebrow's feet are whole.
Copy gates and no-emoji OK; the covering suites pass.
