# Phase 2 of 8: three diamond figures and the arena door

**Date:** 2026-09-14
**Branch:** `agent/cw-wallet2/feat/phase-2-three-diamond-figures-and-the-arena-door`
(stacked on phase 1, PR #4576)
**Companion:** World Hub `agent/cw-hubwallet2/fix/the-earn-pane-knows-what-it-cannot-tell` (PR #1754)

**The Diamond Arena is diamonds only. No chips, ever.** (Dan, 2026-09-13.)

## What the player sees now

**The Diamonds plate prints three figures.** On Hand stays in the bay the
artwork was drawn around. The footer carries Sendable and In The Arena as the
same label/value rows the chip plates use for Available and Locked. Three
outcomes, three renderings: reading prints "...", a failed read prints
"Unavailable" (never a zero that means unknown), a known read prints the
figures - and when refund-window collateral holds part of the balance, the
plate says how much and why, before a send is refused.

**The plate opens the arena, truthfully.** Next to Buy Diamonds: "Sit Down In
The Diamond Arena" when the arena is open, "Return To The Diamond Arena" when
the player already has diamonds at a seat (even while the arena is closed to
new seats), and, when it is closed, the sentence "Diamond Arena Opens Soon"
with no control behind it - a dead button teaches a player the page is
broken. The door goes to `/clubs/diamond-arena`, the same way the Home
carousel enters it. Today the arena is closed (`cash_games_enabled` and
`tournaments_enabled` both false), so today's render is the sentence.

**The hero console** adds "In The Arena: N Diamonds At Your Diamond Arena
Seat" beside In Escrow when the player holds custody.

**World Hub parity.** `/api/store/diamond-transactions` returns the same
summary on its first page (`fn_diamond_wallet_summary` as service role);
the Send panel prints "Sendable: N" with the collateral explanation and checks
the amount against it before the round trip. Its "In Play" figure already
read custody (`fn_poker_diamond_custody_balance`); verified the arithmetic is
identical to the summary's `in_arena` (released rows are constrained to 0).

## Why not a fifth plate

"NOTHING CAN BE COPY PASTED OR OVERLAPPED" (console law): the page already
carries the approved Diamonds plate, and the arena's figures ARE diamonds. A
second copy of the plate for them would be the duplication the law forbids,
and there is no approved arena wallet master to print into. The figures live
where their currency lives.

## Verified

- `tests/components/DiamondPlate.test.tsx` renders every state: reading,
  failed, known with collateral, closed (sentence, no button), open (door
  fires), seated (way back), and asserts no chip appears anywhere on it.
- 497 tests across the wallet's covering suites; `tsc`, eslint, and the four
  copy gates (ui-text, title-case, painted-text-case, nav-title-case) clean.
- World Hub: the new pin in `the-earn-pane-knows-what-it-cannot-tell` passes;
  the modal's pinned suites pass.
