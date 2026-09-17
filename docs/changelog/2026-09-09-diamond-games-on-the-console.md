# Diamond Games, rebuilt on the painted chassis

**2026-09-09. Dan, on the pages shipped the day before: "UPGRADE THESE USING
#ClubArenaConsole THESE PAGES ARE STILL GENERIC." And, on the renders:
"THOSE IMAGES (THAT ARE CURRENTLY BUILT) DO NOT FOLLOW: #ClubArenaConsole -
The Painted-Chassis Standard." And: "SHOW ME WHAT YOU HAVE DESIGNED INSIDE
THIS CHAT BEFORE YOU PUSH OR PUBLISH FOR ME TO APPROVE ... AND THESE SHOULD
ALL BE FULL SCREEN PAGES, NOT POP UP SCREENS FOR ANY AND ALL GAMES."**

Continues `docs/changelog/2026-09-08-diamond-plinko-and-crash.md`. No money
path, no migration, no RPC changes: this is entirely the picture.

## What was wrong

The five surfaces shipped on 2026-09-08 (the lobby, the wheel, Plinko, Crash
and the two operator consoles) were built from a hand-written chassis:
`components/diamond-games/CasinoChassis` drew its own frames, bays, buttons,
notes and readouts in CSS, with borders, gradients and box shadows tuned to
look like the master. That is exactly what the standard forbids. "Paint what
never changes. Print what does." A frame drawn in CSS is a frame that drifts
from the art the moment either one is touched, and it reads as generic
because it is generic: it is a box with a gradient on it.

## What replaced it

Everything is now the approved master, with the DOM laid into measured zones.

- **`components/console/DeckConsole`** is new: the chassis for "four figures
  and two actions" that the games needed, built on the same master the buy-in
  deck uses (`popups/buy-in-v1/deck.png`), so a game page never imports a
  table modal to get the deck. Its zones were measured off `deck.png` itself,
  not copied from a note: the four bay modules centre on x 183 / 391 / 599 /
  807 (208 apart), each a label strip at y 62-123 over a window at y 134-297,
  and the plates are x 111-474 and x 530-885 at y 401-529. The first pass used
  the numbers as written down and printed the bay values 8px right of their
  painted windows, which clipped "100" against the bevel.
- **A bay can be a control.** Board, Bet and Auto are the painted bays
  themselves: tapping one cycles it and the bay's ink is its state (white for
  a live choice, red for a bet the bank cannot cover, gold for an armed auto
  cash-out, muted for off). Nothing is drawn over the master to say so. The
  face is fitted to a well inside the window exactly as `PlateButton` fits a
  plate label, so a long board name shrinks instead of running under the frame.
- **The plates are the actions.** `Odds` on the steel, the wager on the blue
  glass; on Crash the primary plate becomes `Cash Out 2.34x` in green while a
  round is open, so the button that takes the money and the button that gives
  it back are never two different controls in two different places.
- **Odds, fairness and history** are each their own `SpadeConsole`, printed as
  engraved rows on the glass between the rails: a label in the master's lit
  blue, a value in silver, a 1px black rule with a white inset between rows.
- **The operator consoles** are the same: readings as rows, the windows table
  as rows, the fields as printed labels over a single engraved line, and
  `Close Plinko` / `Save Settings` on the two plates. The Plinko / Crash
  switch is the plates of the readings console. The checkboxes are gone: a
  switch is now a row whose value is its state, printed `On` in green or
  `Off` in muted silver.
- **Nothing else is drawn.** Only what the art does not paint: the wheel, the
  Plinko board, the Crash curve, and the engraved line under a text field.
  No `:hover` anywhere; every `:active` collapses under reduced motion.

`components/diamond-games` is deleted, along with the now-unreferenced
`ClubWheelOperationsPage.module.css`.

## Three things the renders caught

The pages were rendered at 393x852 at dpr 2 against the live database before
any of this was shown, which is the only reason these were found:

1. **Bay values clipped.** The measured zones above; and the pressable bays
   were fitting their text to the button including its own padding, so a
   value could overflow the window on one side. They now fit a well, like the
   plates do.
2. **The Plinko slot labels collided.** Seventeen slots across 300px with a
   per-label font heuristic printed `40x9.95x4.1x` as one run of digits. One
   size now serves all seventeen, measured from the widest label, and the `x`
   comes off every chip together (never off some) when that is what stands
   between the row and a legible size. The odds console under the board
   carries the same figures at full size either way.
3. **The Crash glass was blank at rest.** It now draws the climb the round
   would take, dimmed, and the axis makes room for the player's own auto
   target so the gold line they set is on the glass before they bet.

## Decimals

`compactChips` prints every balance, total and reading outside the felt, so
the operator console reads `39.6K`, not `39,696.34`. Three figures stay exact
because the figure IS the prize and rounding it would either over-promise or
under-pay: sub-chip wheel prizes (`0.20 Chips`), the boards' own multipliers
(`9.95x`), and a multiplier the pool has trimmed (`594.51x`). Raised with Dan
rather than decided here.

## Gates

`check-ui-text`, `check-title-case`, `check-painted-text-case`,
`check-nav-title-case`, `tsc`, and the full vitest suite (17,625 tests) pass
in the worktree. No asset 404s in any render.
