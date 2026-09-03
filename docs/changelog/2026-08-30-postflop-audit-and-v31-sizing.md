# 2026-08-30 — Postflop audit, dead-layer sweep, and the measurement that sizes V31

Next phase after the variant scale-parity fixes. Three audits, two clean
bills of health, and one measurement that changes how V31 should be built.

## 1. Postflop was NOT vulnerable to the scale bug — verified, not assumed

When the preflop scale bug was fixed I wrote "postflop is untouched: it
already uses real Monte Carlo equity". That was an assumption, and PLO
equities famously run compressed toward 50%, so it deserved a measurement.

Flop equity distribution and action mix, per variant, through the real
`decide()`:

| variant    | flop equity p10 / med / p90 | c-bet OOP | facing a pot bet (agg/call/fold) |
| ---------- | --------------------------- | --------- | -------------------------------- |
| nlh        | 0.24 / 0.46 / 0.79          | 65%       | 5% / 24% / 72%                   |
| plo4       | 0.29 / 0.49 / 0.74          | 70%       | 9% / 63% / 28%                   |
| plo5       | 0.26 / 0.48 / 0.74          | 71%       | 10% / 60% / 31%                  |
| plo6       | 0.30 / 0.50 / 0.76          | 69%       | 8% / 64% / 28%                   |
| plo8       | 0.32 / 0.50 / 0.73          | 67%       | 7% / 69% / 25%                   |
| short_deck | 0.30 / 0.49 / 0.74          | 66%       | 3% / 36% / 62%                   |
| pineapple  | 0.27 / 0.47 / 0.73          | 73%       | 9% / 36% / 56%                   |

**The assumption holds.** PLO equity is mildly compressed exactly as
predicted (p10 0.29 vs 0.24, p90 0.74 vs 0.79), but equity is a genuine
PROBABILITY, so a threshold on it means the same thing in every game — the
opposite of a preflop score, which is an arbitrary index. PLO defending far
wider (folding 28% where hold'em folds 72%) is the equity arithmetic being
right, not a leak: facing a pot-sized bet you need 33% to call, and PLO's
median flop equity is 0.49. C-betting sits at 65-73% everywhere, with no
stuck valve.

## 2. No dead strategy layers

Diffed every `noteFire()` label in the engine against every feature
`horse_brain_telemetry` has ever recorded. **Every literal label has fired in
production.** The only "never fired" entries were artifacts of my own grep
catching template prefixes (`decide_`, `icm_`). Past incidents in this repo
involved features sitting at zero fires across 700,000 decisions; there are
none now.

Two counters are low but explained rather than broken: `icm_warming` (14 in
7 days — a transient cache-warm state) and `v26_prize_read` (52). Worth a
look someday; not a defect on this evidence.

## 3. TWO HARNESS BUGS OF MY OWN — the methodology lesson

Both audits today produced a false alarm before producing a finding:

- The PLO repro first used `gameVariant: 'plo'`, which is not in
  `OMAHA_VARIANTS`, and showed the best hand in the game refusing to raise.
  Production uses `plo4`/`plo5`/`plo6`/`plo8`; no live table uses `'plo'`.
- The postflop sweep first reported **0% c-bet for every variant including
  hold'em**. The cause was that my synthetic `actionHistory` carried
  `userId: 'h'` while the seat player was `'h' + i`, so `readInitiative`
  could not match them and returned `'opp'` — which correctly triggers the
  V11 anti-donk gate. With matched ids: c-bet OOP 68%, IP 80%, donk lead 0%.
  All correct.

Both were caught by checking the MECHANISM before believing the number. A
synthetic harness that does not satisfy the engine's own invariants
(matching user ids, real seat/dealer relationships) will manufacture
alarming results all day. **The comparison between variants in an identical
state is the trustworthy signal; the absolute frequency is not.**

## 4. The measurement that sizes V31

V31 is the plan to aggregate `strategy_matrix_v2` (1,891,817 rows nothing
reads) at **combo level** instead of 169 hand classes. Two numbers decide
how it should be built.

**The fidelity gain is real, and now quantified.** On one solved flop
(`2s4hQh`, big-bet action `b412`), grouping the solver's 1,326 combo
frequencies into the 169 classes V29/V30 use:

    average spread WITHIN a single 169-class : 0.353
    maximum spread                           : 1.000
    classes whose internal spread exceeds .25: 105 of 169  (62%)

So in nearly two thirds of hand classes, the solver plays one combo very
differently from another in the SAME class — one betting 100% while another
checks. The current class-mean averages that away. That is not noise, it is
blockers and suit-specific holdings, and it is the single largest fidelity
loss in the shipped design.

**The storage cost is also real.** Measured `pg_column_size` of the v2
`frequencies` object: **~33 KB per solved row** (2-3 actions x 1,326 combos).
A combo-level compact table lands around **110 MB**, roughly 9x today's ~12
MB, all of which the loader pulls into the engine's resident memory and
pages at 500 rows (~16 MB per page response).

### The design decision this implies

Do NOT copy the V30 shape at 8x the size. The suit information that carries
the value is low-dimensional — what matters is a combo's relationship to the
BOARD (how many cards of the flush suit it holds, whether it blocks the nut
flush or straight), not its raw identity. A cell keyed by
`169-class x small board-relative suit bucket` should recover most of the
0.35 spread at roughly a third of the combo-level cost.

That hypothesis is testable with the data already in hand, and the test
should be run BEFORE any aggregation is built: decode the combo index
(`card = rank*4 + suit`, `combo = b*(b-1)/2 + a`), group by
`(169-class, board-suit-count)`, and compare the residual spread against the
0.353 baseline above. If the residual collapses, the cheap encoding wins on
every axis. If it does not, the 110 MB is the honest price of the fidelity
and should be paid deliberately, with a memory budget agreed first.

Either way the decision is now a measurement rather than a preference, which
is the whole point of writing this down before building.
