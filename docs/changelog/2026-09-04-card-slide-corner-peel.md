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

**The corner shows its rank.** Dan, after the first cut: "THINK ABOUT HOW IT
WOULD LOOK IF YOU WERE REALLY AT THE TABLE AND THE CARDS WERE FACE DOWN, THE
QJ ARE ON THE BOTTOM LEFT HAND CORNER WHEN YOU ARE PEELING THEM BACK." The
deck art carries one index, top-left, so the bottom-left peel was uncovering
artwork. `.seat__peel-index` now draws the rank and suit, upright, on one
line, tucked into the bottom-left corner of the face under the back (black /
red for the 2-colour deck, CardImage's palette for 4-colour; ten spelled 10),
so the corner reads the moment it lifts.

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

## 2026-09-05 follow-up (Dan picked 1, 3, 4, 5, 6; explicitly not 2)

**A card you have not turned over does not tell you what it is.** The live
hand-strength label under the hero's seat reads straight from the hole cards
and was not gated on the slide, so with Card Slide on it printed "Pair Of
Kings" under two face-down cards. The peel was decorative. Withheld until the
peel commits.

**Friction (1).** SoundService gains a sustained voice - looped noise through
a bandpass whose centre rises with the bend, gain driven by DRAG SPEED so it
falls silent the moment the finger stops, which is what makes it read as paper
rather than a loop. Opened silent on touch-down (so the first millimetre has
something to modulate), ramped never stepped, and closed on pointerup, on
pointercancel AND on unmount. Plus `playPeelLift`: one soft tick and a light
haptic as the corner leaves the felt.

**PLO (3).** Verified on PLO6, the tightest case: six cards peel together,
each turned-up corner sits in its own visible slice, and the ranks read left
to right. `/sim?slide=1&cards=4|5|6` is the dev knob.

**Tutorial (4).** The first face-down hand a browser ever sees peels ITSELF -
twice, a third of the way, then settles - under one line: "Slide The Corner To
Look". The demonstration is the instruction. A real touch cancels it and takes
over mid-frame. Two failure modes found and fixed by measuring rather than
reasoning: React StrictMode's double-invoke made a `hasStarted` ref guarantee
the demo NEVER played (cleanup cancelled the loop, the second run returned
early), so the effect is idempotent and "once ever" lives in localStorage
where it belongs; and a background tab delivers no animation frames, so the
demo would paint nothing, never end, never mark itself seen, and leave the
caption welded to the row - it now waits for the tab to be looked at, and
carries a timer backstop for a tab hidden mid-demo.

**Telemetry + admin (5).** `card_slide_usage` is a DAILY PER-USER ROLLUP, not
an event log: a peel happens on most hands and this platform deals ~221k hands
a day, so an event row each would out-write hand_history for a number only ever
read as a ratio. The client counts in memory and flushes at most once a minute
(and on pagehide), fire-and-forget, every failure swallowed - a metric that can
break a poker table is a defect. RLS on with no policy; the only ways in are
`fn_record_card_slide_usage` (clamped, can only touch auth.uid()'s own row) and
`fn_card_slide_adoption` (AGGREGATES ONLY - it can say whether the feature
works and can never say what one player did with their cards). Surfaced in the
admin Analytics tab: adoption, players peeling, peels started, completed share
(amber under 50%, which would mean the commit threshold is too far) and
keyboard opens.

**Desktop (6).** On hover - `(hover: hover) and (pointer: fine)` only, so a tap
can never leave it stuck - the bottom-left corner turns up a few pixels. A
dog-ear that says: this corner lifts, grab it here. Suppressed while peeling,
still shown under reduced motion because it is meaning, not motion.

**Not done, by instruction:** peeling one card at a time (Dan: "2, DO NOT DO
THIS").

## Not shipped

An opt-in river "squeeze" presentation was built first from the same brief
and parked when Dan clarified that Card Slide is the hole-card peel. It is
not on this branch.
