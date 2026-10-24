# 2026-10-24 - The six-handed top seat is full size

Dan, with a screenshot of a 6-max PLO5 table: "IN 6 HANDED GAMES, THE AVATAR OR
VILLIAN IN THE 'DONKQUEEN' POSITION CAN BE FULL SCREEN NOW THAT THE BBJ IS
REMOVED FROM ABOVE THEM... MAKE THAT CHANGE GLOBALLY".

## What was there

Rings of 2-6 seats have one top seat, centred at y 5 on the 960-unit canvas.
Since 2026-09-05 it was capped at 56px with its bust art at 1.05x (every other
villain: the full proportional slot at 1.45x), and below 480px portrait it was
a 36px compact pod. Both existed only to keep the crown out of the BBJ banner
that sat directly above that seat. #7832 and #7843 (2026-10-23) moved the
jackpot plates into the left corner under the menu, so the space above the top
seat is open page and the cap had nothing left to protect.

## What changed

- `SeatSlot.css`: the short-ring rule now restores the full slot
  (`--seat-avatar-base: var(--seat-avatar-full)`) and the 1.45x bust for the
  top seat of every 2-6 ring. The phone compact-pod block is scoped to 7-9 max
  with `:not(:where(...))`, which adds no specificity.
- On a portrait phone (<=480px) the slot is full but the bust overhang is
  1.3x rather than 1.45x (1.05x on the <=620px-tall first-generation SE, where
  every villain is already a 40px pod). Measured: with six PLO6 hands tabled,
  a 1.45x top bust made the protected card layout push both neighbouring
  shown hands off their players at 375 and 480 wide and park the top
  player's bet beside the next chair; 1.3x passes every occupied state of
  `table-proportions.spec.ts` at 375, 393, 430 and 480, and 1.05x at 320.
- `table-proportions.spec.ts`: "Top Avatar/Plate Is Not Compact" now applies
  to 7-9 max only; a 2-6 ring instead asserts the top avatar is the same width
  as the other villains.
- The celebration hop stays at the top row's -5px: on a phone the corner
  jackpot plate still reaches over the top seat's left shoulder (the layout
  hook parks the art 8px under it), and a full 10px hop would touch it.
- 7-9 max keep their two top-cap seats at 76px / 1.05x; this ruling is the
  six-handed seat.

## Measured (real portrait table scene, real stylesheets, Chromium)

| Viewport | Top seat before | Top seat after | Other villains |
| -------- | --------------- | -------------- | -------------- |
| 1075x1240 | 56 | 93 | 93 |
| 1440x900 | 56 | 60 | 60 |
| 768x1024 | 56 | 85 | 85 |
| 430x932 | 36 | 68 | 68 |
| 393x852 | 36 | 63 | 63 |
| 375x667 | 36 | 60 | 60 |

The art rises above the canvas into the space the banner used to occupy and
stays below the tab bar at every width (29px or more at every width measured). The
nameplate still straddles the rail band. 9-max output is unchanged.

## Tests

- `tests/e2e/top-rail-seat.spec.ts`: the small ring is measured full size with
  the 1.45x bust; every 2-6 ring is full size and 7-9 keep 76px; both rings
  still put the box on the rail.
- `tests/unit/topRailCapCascade.test.ts`: the cascade arithmetic now proves the
  short-ring rules beat the 76px cap and the 1.05x bust, and that no 56px cap
  survives.
- `tests/unit/spinsSitSoundPrizeAndFelt.test.ts`: the text pin follows.
