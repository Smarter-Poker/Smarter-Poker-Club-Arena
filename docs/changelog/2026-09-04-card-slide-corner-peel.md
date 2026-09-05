# 2026-09-04 - Card Slide: peel a corner of your hole cards, like a live table

**Branch:** `feat/card-slide-corner-peel`
**Dan, verbatim:** "THE CORNERS OF THE CARDS SHOULD BE 'PEELED BACK' LIKE YOUR
LOOKING AT THEM AT A REAL POKER TABLE... NOT JUST CLICK TO REVEAL, IT NEEDS TO
FEEL AND ACT LIKE THE USER IS ACTUALLY TOUCHING THE SCREEN AND LIFTING THE
CARDS OFF THE FELT." Then: "they should be peeled left to right, not right to
left." And the switch "SHOULD ALWAYS BE TURNED OFF BY DEFAULT."

## What it does now

With **Card Slide** on, the hero's hole cards are dealt face down. Touch them
and the hand is picked up (a small rise and a spreading shadow, one light
haptic). Slide a finger to the right and the LEFT corner of the back - top or
bottom, whichever half the finger landed in - peels up and follows the finger
exactly: the back folds along the perpendicular bisector of the drag with the
pinched corner always under the fingertip, the face shows through where the
back was lifted, the folded-over card stock carries a crease highlight falling
into shadow at the fold, and a drop shadow deepens as the corner rises. Both
cards peel together, as a squeezed pair does. Let go early and the corner
settles back flat. Slide past 45% of the diagonal (a firmer haptic marks the
line) and the corner flies the rest of the way, the hand opens with the
existing `squeezeOpenPop`, and stays open for the rest of the hand.

A tap is a hint (the hand lifts and settles), never a reveal. The double-tap
shortcut is gone: there is no click to reveal. Enter / Space still opens the
hand, because a peel is not something a screen reader can do.

## What it replaced

COMPETITOR-PARITY 2026-08-19's `card_squeeze`: a hinge. The whole back rotated
up from its top edge by a drag-UP distance (`rotateX(progress * -150deg)`),
with a React state write on every pointer move. It did not peel, did not follow
the finger in two dimensions, did not lift, and opened on a double-tap.

## How it is built

- `src/components/table/cardPeel.ts` - the geometry, pure and unit tested
  (`tests/unit/cardPeel.test.ts`, 17 tests): fold line, the clip polygon for
  the flat part of the back, the clip polygon for the lifted part, the CSS
  reflection matrix that lands the pinched corner under the finger, shading
  angle, fold position. `leftCorner()` is the Dan rule. A fold can lift at
  most half the card (at progress 1 the fold runs through the centre); the
  commit finishes the reveal.
- `SeatSlot.tsx` - pointer handlers write one `PeelFrame` per move as CSS
  custom properties on the cards row (`--peel-progress`, `--peel-cover-clip`,
  `--peel-flap-clip`, `--peel-flap-transform`, `--peel-fold-*`,
  `--peel-depth`). Synchronous, no `requestAnimationFrame` (a frame behind a
  finger at best, starved in a throttled tab at worst), and no React render
  while the finger is down. Release and commit tween with rAF and a timer
  backstop, because the commit ends in a STATE change and a hand that opens
  only if frames arrive is a hand that can stay face down. Pointer capture is
  guarded: a `setPointerCapture` throw must never strand a peel.
- `SeatSlot.css` - layers inside `.seat__squeeze-flip`: the face plus a
  fold-aligned shade band (shadow under the curl), the back clipped to the
  flat part, and `.seat__peel-flap` (reflection + drop shadow) around
  `.seat__peel-flap-inner` (clip + card stock + crease band) - filters run
  before clips, so the shadow lives on the unclipped parent. The lift sits on
  the flip box, not `.seat__card`, because the hero cluster pins
  `.seat__cards--hero .seat__card { transform: none }`. Reduced motion keeps
  the finger-paced peel (it IS the interaction) and drops the lift, the
  flap's shadow, the eases and the hint bounce.
- Tests: `tests/components/CardSlidePeel.test.tsx` (13) drives the real
  SeatSlot with a fake card rectangle: grip, left corner, geometry-to-DOM
  equality, both cards, haptic beats, early release, commit, cancel, tap is
  not a reveal, second tap is not a reveal, Enter opens, markup, aria label.

## The switch

ONE switch: `user_table_settings.card_slide`, labelled **Card Slide** ("Deal
Your Cards Face Down And Peel A Corner Back To Look, Like A Live Game"),
quick-settings, **default OFF**.

- `20260905001550_card_slide_is_the_river_squeeze_default_off.sql` (applied to
  production 2026-09-04): `card_slide` defaulted TRUE and had had no consumer
  since 2026-08-23 - a switch that lied both ways. Default flipped to false;
  untouched rows still holding the old default reset.
- `20260905040622_card_slide_absorbs_card_squeeze.sql` (applied 2026-09-04):
  `card_squeeze` was the same feature under a second name in the same panel.
  Every `card_squeeze = true` is carried into `card_slide` (and marked
  touched), the `card_squeeze` entry is removed from the settings list, and
  `TablePage` reads `card_slide`. The column stays (dropping it is a 28s
  PostgREST reload for no player benefit and would break a client still on
  the old bundle); nothing reads it.
- `tests/user-table-settings-defaults.test.ts` pins `card_slide: false`.

## Verified

Vite dev server, built-in browser, `/sim?slide=1` (dev knob that deals the
hero face down; the live table reads the setting). Synthetic touch pointer on
the hero's bottom-right, slid right and up:

- corner pinned `bl`; cover clip grew from the bottom-left with every move
  (`polygon(... 7.76% 100%, 0% 93.07%)` -> `31.05% 100%, 0% 72.27%`);
  flap transform a reflection matrix; lift `scale(1.0087) translateY(-1.15px)`
  at progress 0.29 and `scale(1.03) translateY(-4px)` at 1.0;
- release at 0.29: progress back to 0, hand still face down;
- release at 1.0: `seat__cards--squeeze-open`, squeeze box gone;
- screenshot at progress 0.45, row scaled 3.2x: both cards' bottom-left
  corners folded over, cream stock with crease highlight, face visible under.
- `npx tsc --noEmit` clean; 787 tests across every suite mentioning SeatSlot /
  squeeze / card_slide green, plus the animation law, reduced-motion coverage,
  law registry and migration uniqueness.

## Not shipped

An opt-in river "squeeze" presentation was built first from the same brief
and parked when Dan clarified that Card Slide is the hole-card peel. It is
not on this branch.
