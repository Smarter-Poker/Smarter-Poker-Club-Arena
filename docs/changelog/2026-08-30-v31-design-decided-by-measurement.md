# 2026-08-30 — V31's design is now decided, by measurement rather than preference

The previous doc said the suit-bucket hypothesis "is testable with the data
already in hand, and the test should be run BEFORE any aggregation is
built." This is that test, and its answer.

## The question

V29/V30 aggregate the solver into **169 hand classes**. `strategy_matrix_v2`
carries **1,326 exact combos**. Combo level is strictly more faithful but
costs ~110 MB resident (9x today's ~12 MB), all of it paged into the engine.

Is there a cheap encoding that recovers most of the fidelity? The
hypothesis: what makes two combos in the SAME class play differently is
their relationship to the BOARD — chiefly how many cards of the board's
flush suit they hold — not their raw identity.

## The measurement

Decode the combo index (`card = rank*4 + suit`, `combo = b*(b-1)/2 + a`),
then compare the within-group spread of the solver's bet frequency under
two groupings: by 169-class alone, and by (169-class x count of one suit).
The suit convention was not documented, so all four suit indices were tested
and the best taken — which also identifies the convention.

Single flop first (`2s4hQh`, two hearts), big-bet action:

    grouping                       residual spread
    169-class only (the baseline)        0.353
    + count of suit 2                    0.127   <- 64% explained
    + count of suit 3                    0.217   <- the other board suit
    + count of suit 0 or 1               0.261   <- suits not on the board

Suit index 2 is hearts, the flush suit. The method found the encoding on its
own, which is a good sign it is measuring the real thing.

Generalised over an unbiased `TABLESAMPLE`, restricted to rows where the
class-mean actually loses something (baseline spread > 0.10) — **83
informative rows**:

    avg baseline within-class spread : 0.2384
    avg residual after one suit dim  : 0.0811
    avg fraction explained           : 0.673
    worst row                        : 0.387
    best row                         : 0.893

## The decision

**One extra dimension recovers two thirds of the fidelity for a quarter of
the cost.**

| design                                     | fidelity recovered | resident size |
| ------------------------------------------ | ------------------ | ------------- |
| 169 classes (today)                        | baseline           | ~12 MB        |
| **169 classes x flush-suit count (0/1/2)** | **~67%**           | **~31 MB**    |
| 1,326 combos                               | 100%               | ~110 MB       |

So V31 builds `169 x 3` cells, not `1,326`. Never below 39% explained on any
sampled row, so this is not an average hiding bad cases.

Two further notes for whoever builds it:

- The **second** board suit still carried a measurable effect (0.217 vs a
  0.353 baseline on the sample flop). A second bucket dimension is available
  if the first proves insufficient in play — but it should be justified the
  same way, by measurement, not added speculatively.
- The remaining third of the spread is rank-blocker structure (which
  straight or boat a hand blocks). That is genuinely combo-level and is the
  honest price of the cheap encoding. If it is ever wanted, it should be
  bought deliberately with a memory budget agreed first, not by quietly
  switching to 1,326.

## Why this was worth doing before writing any aggregation

The V30 aggregator was rewritten twice in one day — once for an
optimization that was faster in `EXPLAIN` and slower in production, once
because a full-body replace clobbered another agent's tuning. Both cost real
production time. Building a 110 MB table on the assumption that combo level
was necessary, and discovering afterwards that 31 MB bought two thirds of
it, would have been the same mistake at a much larger scale.

## Status of everything else

- **V30 aggregation**: turn at 1,232,150 / 3,184,083 rows (**38.7%**),
  cursor 5s fresh, 3,202 cells, zero facing cells. River follows
  automatically. The 8-hourly watcher carries it and retires itself.
- **Variant scale parity**: shipped for all seven live variants and guarded
  by `HorseVariantScaleParity.test.ts` (35 tests, proven to fail for the
  right reason).
- **Postflop scale**: audited, sound, no change needed.
- **Dead strategy layers**: none — every `noteFire` label has fired in
  production.
