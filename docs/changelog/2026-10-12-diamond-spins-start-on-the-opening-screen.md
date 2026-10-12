# Diamond Spins: Start is on the opening screen, and Crash books the win from the same spot

Dan, 2026-10-12, verbatim:

> "THE Start game BUTTON for any of the bonus games INSIDE OF DIAMOND SPINS
> needs to be clickable on the opening screen. Not scroll down to just click
> start."
>
> "CRASH ... THE 'STOP BUTTON' NEEDS TO BE VISUALLY ON THE SAME PAGE AS THE
> START BUTTON, YOU CAN'T SCROLL DOWN TO START THEN UP TO STOP. AND THE STOP
> BUTTON SHOULD BE FLASHING TO LET THE PLAYER KNOW THIS IS THE BUTTON TO CLICK
> TO STOP AND BOOK THE WIN."

## What was wrong, measured

All four bonus games (Diamond Crash, Diamond Plinko, Donkey Cross, Diamond
Mines) share one console, `src/components/games/GameConsole.tsx`. On a phone
it is one column: header, the scene, the setup panel, the bays, and only then
the two plates. Measured on the shipping pages inside AppLayout, window at the
top, nothing scrolled:

| Game         | 375 x 667 | 393 x 852 | 1280 x 800 |
| ------------ | --------- | --------- | ---------- |
| Crash Start  | 1,038px   | 1,024px   | 754px      |
| Plinko Drop  | 1,455px   | 1,461px   | 899px      |
| Donkey Cross | 810px     | 885px     | 654px      |
| Mines        | 926px     | 1,040px   | 654px      |

Every phone figure is below the bottom of the screen, and on desktop Crash and
Plinko were below the fold too: the controls column was `sticky; top: 0` with a
screen of height, so its plates were a screen below wherever it started.

## What changed

- **The plates ride in a bar pinned to the foot of the game frame.** It is a
  direct grid child of the console section (`[data-game-actions]`,
  `position: sticky; bottom: 0`), under the controls in their column on
  desktop and the last row on a phone. A sticky box can only travel inside its
  parent, so the bar is never inside the controls column, which starts below
  the fold on a phone. Layout only: nothing scrolls the window.
- **On a phone the console is at least one screen tall** (`min-height: 100dvh`,
  the controls row taking the slack), so the bar's own place is never above the
  bottom of the glass and it is pinned there on every first paint. That is what
  makes Start and Book The Win land on the same pixels: through a live round
  the setup leaves the page, and without the floor the bar rose with it.
- **Crash: Book The Win pulses while the round is live and cashable.** A new
  optional `flash` on a console plate (`GamePlate`); GameConsole lights it only
  while the plate is pressable, so the pulse starts when the cash-out opens and
  stops the moment it is pressed. It is light on the plate's edge, never
  movement: `plate-book-pulse`, period `calc(1.1s * var(--animation-speed, 1))`,
  and the plate carries `data-motion="keep"` so reduced motion keeps the meaning
  (CLAUDE.md 10.6). Odds, floors, payouts and every result line are untouched.
- **Plinko: the drop value is docked beside Drop Diamonds.** Nothing is
  pre-selected (R6), so Drop Diamonds is dead until the player picks a value.
  The picker is now `PlinkoDropSelector` in `BonusSetup.tsx`, printed through
  GameConsole's new `dock` slot in the pinned bar, wrapped onto whole rows so no
  value is cut off, every plate at the 44px floor. The setup panel no longer
  prints a second copy (`dropsDocked`).
- **Sideways phones keep their layout**: the bar is the foot of the controls
  column, as the plates already were there.

## How it is proved

`tests/e2e/css/diamond-games-playfield.spec.ts`, run by the required Diamond
playfield job, with a new fixture `tests/e2e/helpers/diamond-game-pages-fixture.mjs`
that mounts the four real pages in AppLayout with every wallet and server
boundary local (a start or a cash-out throws before anything is sent):

- `Every bonus game opens with Start on the screen at W x H` for 375 x 667,
  393 x 852, 390 x 844 and 1280 x 800: after the Double Your Diamonds answer,
  each game's Start is enabled, at least 44px, wholly inside the viewport with
  `scrollY === 0`, and is what a tap at its centre hits. Plinko's drop value
  must be on the same first screen.
- `Crash books the win from Start's own spot, lit, at W x H`: Start's box, then
  a live round four seconds into its climb, where Book The Win must be enabled,
  occupy Start's box to within 1px, carry `data-flash="live"` and
  `data-motion="keep"`, and be running `plate-book-pulse` with a box-shadow
  that changes between frames.

Both specs were run against the pre-change source and fail with the defect
("sits 1038..1100 of a 667px screen"). The two existing Donkey Cross / Mines
selectors that located the plates under `aside` now read `button[data-plate]`,
and the keyboard spec's axe scan covers the bar as well as the aside, in the
same commit.
