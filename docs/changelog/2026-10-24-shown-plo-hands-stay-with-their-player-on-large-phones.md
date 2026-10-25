# Shown PLO hands stay with their player on large phones

## The defect

On portrait viewports wider than 480px (481-768px: large phones, foldables, an
upright iPad mini or 768px tablet), tabled PLO5 and PLO6 hands sometimes stood
at the wrong seat. At 600x960 6-max, YoungDan's and draw888's shown hands were
parked at the bottom of the table under the hero and the action bar. At
540x900, 600x960 and 768x1024 9-max, several hands, wagers and once the dealer
button read as another player's: they were nearer someone else's avatar.

## The cause

`useProtectedCardLayout` placed tabled hands, wagers and the dealer button by
the phone regime only when `innerWidth <= 480`. There, the hands are placed
FIRST, at their own players, inside reserved uniform PLO5/PLO6 lanes (#7776),
and the wagers and the button are then placed round them on owned felt.

Above 480px the desktop order ran instead: wagers and the button first, then
the hands. Rows of five or six cards are excluded from the close-up path
(SeatSlot.css: the placement owner must never shrink or close these lanes), so
a board-size row that could not stand at its owner fell through to the
unowned fallback `placeProtectedCardRow(candidate, others, bounds)` and landed
on the first free patch of felt. The dense-ring card lane in
`tabledCardWidthPx` was also keyed on `<= 480`, so 9-max rows above 480 were
full board width and could not fit beside their owners at all.

## The fix

- `PORTRAIT_CARD_LANE_MAX_VIEWPORT_PX = 768` in `tableGeometry.ts`, matching
  the hook's existing `<= 768` mobile top-pod rule.
- `useProtectedCardLayout`: the phone placement regime (hands first, then
  owned wagers, then the button) runs on every portrait viewport up to that
  bound. Above 480 the marker grid uses the flat felt (the chassis taper is
  phone-only), wagers get the exact obstacle-edge slots (kept on the table's
  canvas, never in the page margin), and the fallback pool keeps a wager at
  its own player.
- `tabledCardWidthPx` takes the viewport orientation, so 8-9 max portrait
  tables up to 768px share the same readable PLO5/PLO6 lane as a phone. The
  card spacing and size are never closed or shrunk mid-runout, as SeatSlot.css
  requires.
- `SeatSlot.css`: the puck/chips split and the top-pod action tag below the
  plate (the phone rule, because the jackpot plate is above a top player's
  head) apply on portrait viewports to 768px. Seat pod sizes, avatars and the
  felt's perspective keep their 480px phone breakpoints unchanged.

## Measured (portraitRailScene, opponents shown, not spectator)

Before, at 540x900, 600x960 and 768x1024, PLO5/PLO6 all-shown, all-in and
shown scenes:

- 6-max: hands at the wrong seat at 540 (Big Blind, draw888) and 600
  (YoungDan); every scene had wagers printed over their own player's plate or
  avatar.
- 9-max: one to three hands at the wrong seat per scene, tabled hands
  overlapping, wagers over other players' cards, and the dealer button nearer
  another player at 540.

After: zero hands, wagers or dealer buttons that read as another player's,
zero tabled-hand overlaps and no movement after a runout, at every one of
those widths, in both rings and in every PLO5/PLO6 and Hold'em scene. 393px
and 480px phones (and 320, 375, 430) are unchanged and still certify.

## Pinned

`tests/e2e/table-proportions.spec.ts` occupied-ring certification now runs at
600x960 and 768x1024, 6 and 9 seats, on its PLO5/PLO6 scenes. All four new
cases fail against the old placement and pass with this change. Above 480px
the phone-only seat-pod assertions (compact 7-9 max top pod, outboard pods off
the painted felt, pods clear of the board) are not applied, because those
pods keep their tablet ring; every ownership, overlap, readability and
fixed-placement assertion for hands, wagers and the button still is.

## Not changed

The 481-768 seat pods themselves (tablet ring sizes and positions). At 9-max
some side pods touch the board's box and the outboard pods stand on the
painted rail. That is pre-existing on main and is a separate seat-geometry
task.
