# 2026-08-29 — How long does a horse take to think? Nothing had ever measured it

Dan asked how long a horse takes to identify its hand, read the board, read who
it is playing against, pull the table dynamics together and choose its next
play — in real time.

**The question could not be answered from production.** The decision carried a
documented budget in two places — _"budgeted to stay under ~15ms even for
6-card PLO"_ in `HorseLogic.ts`, _"SYNCHRONOUS (budgeted <15ms incl. Monte
Carlo equity)"_ at the call site — and nothing measured it. `performance.now()`
appeared four times in the entire server tree, all four inside an offline unit
test. No timer, no deadline, no duration telemetry, nothing on `/health`.

The only cost control that existed is a fixed Monte Carlo iteration count per
variant (450 for NLH down to 120 for 6-card PLO). That is an _iteration_
budget, not a time budget: it never reads a clock, so a slower box simply takes
longer and nobody finds out. **A budget nobody measures is a comment.**

## What is being measured

The horse's whole read is one synchronous call. Inside `HorseLogic.decide()`:
hand strength, board texture, the opponent model, blockers, ICM, the Monte
Carlo equity run, every version layer from V7 to V26, and the final sizing.
There is no I/O in it at all — every learned stat is a preloaded in-process
Map. So one clock around that call is the complete answer, not a sample of one
stage.

The clock sits at `scheduleHorseAction`, the one call site that is a real horse
at a real table. The nightly league and the self-tuner run millions of
self-play decisions on an idle box; folding those in would produce a flattering
number describing nothing a player ever experienced.

A histogram, not a mean. Every decision is fast until the one that is not, and
the tail is what a player would feel. Fixed buckets are O(1) with no allocation
and no sorting, so the measurement cannot become the cost it measures.
`percentileMs` returns the bucket's **upper** edge — an over-estimate by
construction, so it never flatters the engine — and `null` rather than `0` when
there are no samples, because a fabricated zero reads as "very fast".

## The answer, measured

`npx tsx server/scripts/measure-horse-decision-latency.ts` — 400 live-shaped
decisions per variant/street against the real `HorseLogic.decide`, on an
M-series Mac:

| variant  | street    | p50        | p99        | max        |
| -------- | --------- | ---------- | ---------- | ---------- |
| nlh      | preflop   | 0.007      | 0.021      | 0.024      |
| nlh      | flop      | 0.496      | 0.677      | 0.786      |
| nlh      | river     | 0.267      | 0.641      | 0.893      |
| plo4     | flop      | 6.457      | 9.677      | 9.852      |
| plo5     | flop      | 8.745      | 12.660     | 12.822     |
| **plo6** | **flop**  | **11.039** | **15.051** | **15.384** |
| **plo6** | **river** | 3.770      | **16.768** | **16.883** |
| plo8     | flop      | 7.195      | 7.901      | 8.589      |

Mean across every variant and street: **2.961ms over 11,200 decisions.**

So: a hold'em horse thinks in well under a millisecond. A 6-card PLO horse
takes **10-11ms typically and 15-17ms at the tail** — and **plo6 breaches its
own documented 15ms budget at the p99 on hardware that is almost certainly
faster than the Hetzner box.** That is not an outage; against a multi-second
turn timer it is invisible to players. But it is the first time anyone has
known it, and the production table will now say what it actually costs on the
real machine.

## A trap worth recording

`HorseLogic.decide` wraps everything in a try/catch and degrades to check/fold.
A malformed test case is therefore **invisible in the return value** — you get
a perfectly well-formed decision back — and shows up only as a timing two
orders of magnitude too fast.

The first run of this script reported a mean of **0.026ms** and looked like
excellent news. Every postflop cell was throwing: the script built cards as
strings (`'Ah'`) when the evaluator's `cardKey()` reads `c.rank` and
`c.suit[0]`. It was timing the catch. The script now watches the error channel
and prints `SKIPPED` for any cell that threw rather than reporting the number.

## What ships

- `BrainTelemetry` gains `noteDecisionMs` / `drainDecisionLatency` /
  `percentileMs` beside the existing fire counters — same enable gate, same
  drain-and-restore discipline, drained **separately** so an outage on one
  cannot silently eat the other.
- One clock at `ServerTableEngineTurns`, scoped by variant family so a 6-card
  PLO decision is never averaged into a heads-up NLH one.
- `horse_decision_latency (day, scope)` with `fn_horse_decision_latency_add` —
  additive so a retry after a failed flush is safe, and `max_ms` is a max
  rather than a sum, because summing two peaks invents a decision that never
  happened.
- `server/scripts/measure-horse-decision-latency.ts` for the offline answer
  when you have just changed the brain and do not want to wait a day.

## Verification

`npx tsc --noEmit` exit 0. 11 new tests, **2,346 passing** across the server
suite. Migration applied to production, with in-migration assertions that the
fold accumulates, that `max_ms` is a max and not a sum, and that the histogram
folds element-wise.
