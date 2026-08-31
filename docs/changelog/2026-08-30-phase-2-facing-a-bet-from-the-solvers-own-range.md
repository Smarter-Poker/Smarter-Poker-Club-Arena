# 2026-08-30 — Phase 2 of 7: facing a bet, from the solver's own betting range

Since #1810 purged V30's contaminated facing cells, the entire facing-a-bet
side of postflop — at least as common as holding the lead — has played on
heuristics alone. Phase 2 rebuilds it WITHOUT facing data, from the open-node
cells that are already trusted.

## The idea

A cell's per-holding action mix, read from the BETTOR'S seat, is not advice —
it is a range. `hand_matrix['AKs'] = { check: 0.4, bet_mid: 0.6 }` says the
bettor holds AKs betting mid 60% of the time. Bayes does the rest:

    P(hand | bet of size s)  ∝  P(bet of size s | hand) × combos(hand)

with card removal falling out of the combo count instead of being bolted on
(hero's kings and the board's king shrink KK from six combos to one, at zero
extra machinery). Sampling villain holdings from that posterior and running
the board out gives hero's equity against THE RANGE THAT ACTUALLY BET, and
`equity vs toCall/(pot+toCall)` is the fold/call line. The solver's bluffs
are in the range at their solved frequencies, so they are already priced.

The observed bet is bucketed by `fn_aggregate_gto_v31_next`'s OWN edges
(<60% small, <110% mid, else big) — the range consulted is the range the
solver bet at that size, and the edges cannot drift apart because the test
pins them to the aggregator's values.

V31 cells are consulted first: on a two-spade board, `AKs:2` expands ONLY to
As Ks. The suit dimension does real work on the defence side — the betting
range on a flush board is mostly the combos that interact with it.

## What the layer refuses to do

- **Raise.** Above 0.70 equity it returns `pass_strong` and the aggression
  layers (V12 overbet, V15/V21 nut discipline) keep owning the hand.
  Duplicating raise sizing here would fork it.
- **Answer a donk.** A bet made INTO hero's own lead has no open-node cell;
  pretending the opening range covers it would price a donk range as an
  opening range. Gate: `initiative !== 'hero'` — which deliberately INCLUDES
  'none', because `readInitiative` reads earlier streets only, and a villain
  betting when checked to IS the open node.
- **Guess.** No cell, no size mass, or fewer than 8 live combos -> null, and
  the heuristics play on unchanged. A null is "no opinion", never check-fold.

## The test that caught its own author, twice

The wiring suite's first version asserted "air folds" — and the mutation that
UNWIRES THE CONSULT ENTIRELY passed it, because air folds under the
heuristics too. A decision that agrees with the solver proves nothing about
who made it. The suite now asserts on the telemetry counters, which fire only
inside the consult; the unwiring mutation fails it by exactly those tests.

Fixing that exposed a second slip in the same test: `opts` is `decide()`'s
FIFTH argument and the test passed it fourth, silently discarding every flag
including `telemetry`. Both are recorded in the test file so they cannot be
reintroduced quietly.

## Verification

- tsc clean, engine **1,470 tests / 125 files**, services **538 / 50** green.
- 22 new tests across the module and the wiring.
- **Seven mutations, each caught, green restored after each**: bucket edge
  drift (60->50), blockers ignored, suit bucket ignored, dealt-range-instead-
  of-betting-range, consult unwired, pass_strong removed, pot odds ignored.
- Cost measured at ~5.5ms per consult — the same envelope as the banded MC
  it short-circuits (120-220 iterations, ~1.1M fires/day), so net decision
  cost is roughly neutral.

## Telemetry

`v32_defend_fold` / `v32_defend_call` / `v32_defend_pass_strong` /
`v32_defend_no_range` — the no_range counter is the coverage instrument:
it says how often the facing side reaches for a range that is not there yet,
which is exactly what Phase 3 tunes against. Ablation: `v32FacingDefense`.

## Honest limits

Implied odds are not modelled: fold/call is priced as if the call closes the
action, which is exact on the river and an approximation earlier — kept on
the tight side by pass_strong (draws strong enough to continue aggressively
route past the layer). Multiway is out of scope by the same gate the open
consult uses. And until the V31/V30 aggregations fill (V31 gated ~81h behind
V30), `v32_defend_no_range` will dominate the counters — the layer wakes up
with the same tables the open consult does.
