# 2026-09-02 — horse brain audit, phase 3: bomb pots, one board and three (V36)

Dan: "FULLY AUDIT AND FILL IN, ENHANCE, IMPROVE, OPTIMIZE AND UPGRADE ALL THE
LOGIC, MATH AND DECISION MAKING FOR BOMB POTS ... AND THE DIFFERENCE BETWEEN
SINGLE BOARD, DOUBLE BOARD AND TRIPLE BOARD BOMB POTS! THERE IS PROBABLY ZERO
SOLVER, OR LOGIC OR MATH BEHIND ANY OF IT."

## What a bomb pot is to the engine

Every dealt-in player posts the bomb ante (a BB multiple or a fixed amount),
there is no preflop street, the flop is dealt at once, and with two or three
boards every pot layer is split in integer cents across the boards and each
share awarded independently on its own board (HandController, spec §8/§9/§18).
The scheduler and the money side were already audited on 2026-08-27/29.

## What the brain knew before this change

One thing, and it was right: the average of the per-board Monte Carlo
equities, which is exactly the expected pot share. Everything else was
missing or wrong:

- **It could not see a single-board bomb pot at all.** Multi-board was
  inferred from `communityCards2`; single-board looked like an ordinary
  flop with an empty history. So it consulted the hold'em solver cells —
  solved for single-raised-pot ranges — against hands that were random deals.
- **A bettor stayed a random deal forever.** `HorseMind.bandFor` keys the
  read on the preflop line; with no preflop street it returned null, so a
  player who bet the flop, barrelled the turn and bombed the river of a bomb
  pot was still sampled from all 1,326 combos on the river.
- **Every style read was board one.** Category, scare cards, nut status
  (which flush, whose boat), texture, blockers, the domination penalties: all
  on `communityCards`. The nut flush on board two read as ace-high on board
  one.
- **A lock on one board was a medium hand.** Nut flush on board one, nothing
  on board two: average equity ~0.55, so it thin-value bet 65% of the time
  and check-called a raise. But with N boards a board hero cannot lose is a
  guaranteed 1/N of every chip that goes in: facing B into P0 on two boards,
  calling returns at least P0/2 + B >= B. Folding is never right and raising
  costs nothing that does not come back. It is a freeroll, and the fleet
  played it like a coin flip.
- **Bluffs were priced as heads-up hold'em bluffs.** With random ranges and
  two or three boards, somebody has connected somewhere on almost every deal.
- **Six-way flops were priced against four hands.** Bomb pots are multiway
  by construction; the MC capped sampled opponents at four.

## What it knows now

`gs.bombPot` and `gs.boardCount` travel from the engine (`currentHandBombPot`).
In `decidePostflop`:

- per-board equities are kept; a board at MC >= 0.93 is a **locked share**;
  the **style board** — for category, scare, nut status, texture, blockers,
  domination — is the board hero is strongest on;
- **freeroll bet**: one locked board and at least one unlocked, checked to
  hero: bet 75%+ pot (90% of the time; there is no raise that can hurt it);
- **freeroll raise**: one locked board facing a bet: never fold; raise
  pot-sized 85% of the time when the unlocked boards carry >= 20% equity
  (scoop chance, or fold out what beats hero there), call otherwise. On
  three boards a single lock covers bets up to the pot; overbets fall through
  to the equity-priced call, which already carries the locked third;
- **bluff trim**: x0.5 on two boards, x0.35 on three;
- **six sampled opponents** in a bomb pot instead of four;
- **no solver cells** in a bomb pot, single- or multi-board;
- `HorseMind.bandFor`: a hand with no preflop street starts as a random deal
  and is narrowed by every postflop bet and raise, with the board-contact
  read for the sampler, exactly like a normal hand.

Per variant this is inherited: PLO boards go through the Omaha evaluator and
nut discipline on the style board, PLO8 averages hi/lo per board (a lock is a
scoop lock), short deck keeps its rankings, pineapple its two-of-three.

Cash antes (Dan, same session): the ante already reaches the brain on cash
tables and widens opens/steals/defence and sizes opens smaller; the pot the
engine reports includes it, so every pot-odds number does. Closed one gap:
the push/fold charts were picked by cash-vs-tournament only, so a cash ante
table read the no-ante chart; an ante table now reads the ante chart.

## Tests

`HorseV36BombPots.test.ts` (9 pins): the band read for an ante-only hand,
the freeroll on board one and on board two, three boards, PLO, the bluff trim
on a double board, and the solver gate on a single-board bomb pot.
