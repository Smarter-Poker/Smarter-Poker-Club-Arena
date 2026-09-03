# 2026-09-03 — horse brain audit, phase 5: the EV engine, the next card, the review pass (V38, V39)

Dan, in order: review everything from phases 2-4 for bugs, gaps, stubs and
wiring and make sure it shipped; verify all 1,000 horses are wired to the
brain and decide in real time against the GTO logic; build the GTO-math
engine for the games the hold'em warehouse cannot cover; make the river call
line solver-based instead of a flat line; and have a horse think about the
next street the moment it acts.

## 1. The review pass

Read the full diff of V35/V36/V37 hunk by hunk. Three defects, fixed:

- `satelliteRead` read a MISSING stack list (rank 0, the context still
  warming) as "urgent" and widened every jam. Rank 0 is now neither locked
  nor urgent; the flat-curve ICM premium alone carries the spot.
- `HorseMind.bandFor` in a bomb pot narrowed a bettor's range but left a
  CALLER as a random deal (only checks and bets marked the player as having
  acted). Any postflop action now does.
- A triple-board PLO6 bomb pot sampled six opponents per board — the most
  expensive evaluation on the platform, three times per decision. 5/6-card
  Omaha bombs sample five.

Shipping: PR #2732 had been opened by the GITHUB_TOKEN fallback and was in
conflict with main after the phase 1 squash, so no pull_request event ever
fired — three pushes, zero checks, exactly the "quiet killer" the playbook
names. Merged main into the branch (hunk by hunk; every conflict was the
phase 2 extension of a line the squash had rewritten), closed #2732, opened
#2739 with a user token.

## 2. The fleet, verified against production

1,000 horses (`profiles.is_horse`), 698 seated on 336 active tables at the
time of the check. Every one decides through the single
`scheduleHorseAction` path (the only `HorseLogic.decide` call site outside
tests and the league). `horse_decision_latency`, 2026-09-02: 1,387,626
decisions; mean compute per decision 0.8 ms (short deck) to 7.6 ms (PLO8);
max 315 ms (one GC pause). The think time a player sees is the deliberate
human tempo on top of that, never the compute. The solver stores are
hydrated and firing (v27/v29/v30/v31/v32 telemetry today); phase 1 is live
(`v34_defend_draw_passthrough` firing, `post_aggr` persisted on 721 of 996
profiles).

## 3. The EV engine (V38) — `HorseEvEngine.ts`

The hold'em warehouse is hold'em. For Omaha (4/5/6), PLO8, short deck,
pineapple and fixed limit there is no solver export, and there was no
arithmetic either: percentile bars and margins. The EV engine is the
arithmetic a solver does at one node, reduced to what a synchronous decision
can afford:

    EV(fold)  = 0
    EV(check) = r.eq.P                    (x0.85 with the lead: a check is not free)
    EV(call)  = r.eq.(P + c) - c
    EV(bet s) = f(s).P + (1 - f(s)).[ r.eq'(s).(P + c + 2s) - (c + s) ]

with `eq` the Monte Carlo equity against the read ranges (the V15/V20/V21
nut-discipline caps applied first), `r` the realization for street and seat,
`f(s)` the minimum-defence fold frequency s/(P+s) per opponent scaled by that
opponent's fold read (all must fold multiway), and `eq'` the equity against
the range that CONTINUES (the folds come out of the hands hero was beating).
Rake and the survival premium (charged by the share of stack at risk) enter
the same numbers. The best action wins; candidates within 8% of the pot of
it are mixed by their gap, so indifference plays the solver's mix rather
than a tell.

Wired:

- solverless games, facing a bet on the flop/turn: fold or call by EV
  (the raise gates above it still roll first, with their nut discipline);
- solverless games, checked to, below the value bars: bet (size by EV) or
  check by EV, with the barrel plan registered like every heuristic bluff;
- solverless games, preflop, facing a jam or a wager of >= 40% of stack:
  equity against the JAMMER'S read range (and whoever matched the price) on
  an empty board vs the pot odds + survival premium + an Omaha domination
  margin (the percentile band cannot see domination: six napkins keep 44%
  against the sampled PLO6 3-bet range, ~35% against the real one);
- EVERY river fold/call the V32 solver range did not answer, in every game:
  `riverCallVerdict` — equity vs the betting range against the raked pot odds
  plus the survival premium, mixed inside 1.5 points of indifference. The
  `0.03 x respect + sizing penalty + position edge` margins are gone from the
  river; the reads now shift the equity instead.

Hold'em before the river keeps the calibrated heuristic line where V32 has
no cell (A/B-measured; the solver layers own the heads-up spots).

## 4. The next card (V39)

The V23 raise-response plan (commit / call once / fold to a raise) already
made every bet decide its answer to a raise at bet time. Now every bluff or
semi-bluff bet also records `nextCardOutlook`: each unseen card classified
GOOD (improves hero's made hand), SCARE (a third of a suit hero does not hold,
a board pair under hero's straight or flush) or blank. The next street reads
the card that came against that record: a good card fires the planned barrel
x1.4, a scare card hero blocks fires it x1.2 as the bluff it was born for, an
unblocked scare card halves it (on top of the give-up gate).

## Tests

`HorseEvEngine.test.ts` (16: closed-form arithmetic + wiring for PLO flop,
PLO checked-to, hold'em river, ablation, PLO preflop jam), `HorseV39Outlook`
(7). One pin moved: `HorseRaiseFoldPrice` "junk folds every time" no longer
covers the all-in price spot (35 to win 95 with ~44% equity is a call by the
math; the two range spots still fold every time).
