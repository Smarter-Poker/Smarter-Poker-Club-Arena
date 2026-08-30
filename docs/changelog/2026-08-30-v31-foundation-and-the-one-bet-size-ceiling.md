# 2026-08-30 — V31's foundation, and the ceiling nobody had measured

Picked up the horse-brain handoff to build V31. Before writing the
aggregation I measured the data it would read, and three of those
measurements changed the design. One of them changes what V31 is FOR.

## 0. First, the cursor

The handoff flagged the V30 turn cursor as possibly stalled at 1,292,050
rows. It was not — it was the spin-round-18 deploy restart, and it
recovered on its own. Read 19:02 UTC: **1,307,050 rows, cursor 101s
fresh**. The batch clamp still reads `greatest(25, ...)` (the regression
that bit twice has not returned), and `facing <> 'open'` is still **0**
cells. Flop 2,992 / turn 3,221 / river 0, as documented.

## 1. v1 and v2 are DISJOINT. There is nothing to compare.

The plan said to build V31 beside V30 and "prove equivalence-or-better
with `EXCEPT` in both directions before switching the consult". That test
cannot be run, because the two formats never describe the same row.

Sampled 9,584 turn rows:

    have v1 tree_lines (what V30 aggregates)    3,936   41%
    have v2 actions    (what V31 would read)    5,648   59%
    have BOTH                                       0    0%

This also corrects a note carried in the handoff as "measured waste": that
only ~88 of every 200 v1 turn rows carry anything, the rest being "older
exports with nothing to aggregate". They are not older exports with
nothing in them. **They are the v2 generation**, and V30 walks past all of
them because it requires `tree_lines`. The 79 GB table holds two export
generations side by side, and each aggregator is blind to the other's.

So V31 does not replace V30's turn cells or compete with them. It covers
**the other 59%**. It is additive, and the switch-over question the plan
worried about does not arise.

## 2. Exactly how much v2 there is

Derived from the two partial indexes rather than a scan of the 79 GB table
(`idx_ssg_v2_pending` is `(street, game_type) WHERE strategy_matrix_v2 IS
NULL`, so the complement is an index-only count):

| street | total     | v2 pending | **v2 present** |
| ------ | --------- | ---------- | -------------- |
| flop   | 72,340    | 29,916     | **42,424**     |
| turn   | 3,184,083 | 1,334,690  | **1,849,393**  |
| river  | 5,636,040 | 5,636,032  | **8**          |

**River has no v2 data at all.** V31 is a turn build with a useful flop
slice; the river is V30's alone and always will be on this warehouse.
That is a structural fact about the deliverable, not a phase to schedule.

There is also a better cursor available than V30's. `solved_v2_at` carries
a partial index over exactly the v2 rows, so the V31 aggregator can walk
that index instead of scanning the id order and discarding two rows in
five. The throughput waste V30 lives with is not inherited.

## 3. The finding that changes what V31 is for

V31 was justified on combo-level granularity — suit awareness worth 67% of
a 0.238 within-class spread. That gain is real and still worth having. But
it is not the biggest thing wrong with the v1 layer.

**Every solved tree in the v1 warehouse offers exactly ONE bet size at the
root, and it is the same code everywhere.** 4,000 rows sampled across all
three streets and stack depths 8bb to 150bb:

    street   root actions   n       stack depths
    turn     b16,c          3,432   8 - 150
    river    b16,c            519   10 - 100
    flop     b16,c             49   8 - 150

One code, unchanged across a nineteen-fold range of stack depth. A size
that does not move with the stack cannot be an absolute amount; `b16` is
16% of pot, which is also how the shipped consumer reads it.

Two consequences, and the second is the point:

**(a) V30's `bet_big` branch is unreachable on turn and river.** Its
mapper says a lone root bet is big when the code is >= 100. The only code
is 16. So every bet becomes `bet_small` — by construction, for every row,
forever. Confirmed against the shipped table: `bet_big` appears in **0 of
444,020** turn hand entries, against 205,366 of 205,366 on the flop (those
cells were built by V29, a different function). This is dead code rather
than a live bug, and the consumer already sizes turn `bet_small` as a
block bet, so nothing is mispriced today. But a branch that cannot fire
should be named as such.

**(b) The v1-derived brain can express exactly two turn actions: check, or
bet 16% of pot.** It has no large bet available from the solver at all —
not because the aggregation drops it, but because the solve was never run
with one. v2 does have them:

    v2 bet sizes (size_pct of pot)   min   p10   p50   p90   max
    flop                              33    33    54    75    75
    turn                              64   145   262   263   263

The turn's single offered size is a **262%-pot overbet at the median**, and
908 of 909 sampled turn bets are at least pot-sized.

So the headline reason to build V31 is not suit granularity. It is that
the solver layer currently cannot learn a large turn bet, and V31 is the
only data on the platform that contains one.

## 4. The alarm I did not ship

Read (a) and the 262% together and the obvious conclusion is that the
horse is catastrophically under-betting the turn — sizing at 24-32% of pot
where the solver fires 262%, roughly 3,300 times a day. I had that written
down as a live defect.

It is wrong, and the mechanism is why. The 262% belongs to the **v2**
population; `b16` belongs to **v1**; and per section 1 no row has both, so
the two numbers describe different solves of different trees. Inside v1,
`b16` is 16% of pot, and the shipped comment — "the turn/river root
vocabulary is the 16%-pot block/probe, so those streets size it as a
genuine block bet" — is correct about its own data. The code is sound.

That is the fourth time in two days that an alarming measurement here has
turned out to be an artifact of the harness rather than a defect, and the
fourth time the mechanism check caught it before it became a commit. The
cost of the check is minutes. The cost of skipping it, on this evidence,
is a confident regression.

## 5. Facing solves exist after all — and the earlier claim was too broad

Twice this warehouse has been declared to hold no facing-a-bet solves "in
either format". That was measured honestly and is still nearly true, but
it is not exactly true, and the reason it was missed is worth recording.

`strategy_matrix_v2` has **two shapes**:

- **A**, singular `node` + `actions` + `frequencies` — one solved node per
  row. 5,879 of 5,884 sampled v2 rows (99.9%).
- **B**, a plural `nodes` ARRAY, with no top-level `node` key at all. 5 of
  5,884 (0.085%), and every one of them `sng_hu`.

Both prior surveys keyed on the singular `node`, so shape B was invisible
to them by construction. Opening one:

    nodes[0]  actions: ["bet_105", "check"]
    nodes[1]  actions: ["bet_167", "check", "fold"]

A node with a **fold**. Hero facing a bet, solved.

This does not unblock a facing lookup — roughly 1,600 rows in a single
game type at one stack depth is far too thin to aggregate into cells, and
the correct plan remains the one already specified: compute equity against
the opponent's actual betting range, which the open-node vector already
gives us. But the claim should now be stated precisely: **facing solves
exist only in a 0.085% multi-node subpopulation confined to `sng_hu`, too
thin to aggregate** — not "there are none". The difference matters,
because "there are none" is the kind of claim that stops anyone looking
again.

## 6. One planned V31 feature is not worth building

`exploitability_pct` was to be a quality filter, excluding poor solves
instead of averaging them into a class mean. Measured across 1,006 rows:

    min 0.108   median 0.376   max 0.499

A single narrow band with no bad tail — the max looks capped at 0.5. A
filter over this distribution either excludes nothing or excludes
arbitrarily. **Dropped**, on measurement rather than preference. Three of
the four claimed V31 wins survive: exact sizing (now the headline),
`eff_stack_bb` bucketing (6-197.5bb, genuinely wider than `stack_depth`),
and combo granularity.

## 7. What shipped

Migration `20260830c_v31_combo_decode_foundation`, applied to production
and recorded as `20260830192115`. Two new objects, nothing reads them yet:

- **`gto_combo_map`** — 1,326 rows, 152 kB, decoding the solver's combo
  index into ranks, suits and the 169 hand classes, so the aggregator
  decodes with a join instead of repeating arithmetic per row, and so the
  decode is asserted once rather than trusted everywhere.
- **`fn_gto_board_flush_suit(text)`** — the board's most-present suit, or
  -1 when no suit appears twice.

The encoding is confirmed twice over. Arithmetically: the payload
documents `2c2d=0 .. AhAs=1325`, and Ah=12*4+2=50, As=12*4+3=51,
51\*50/2+50 = 1325 exactly. Empirically: yesterday's spread measurement
identified suit index 2 as the flush suit on a two-heart board without
being told the convention. Both agree on c,d,h,s = 0,1,2,3.

The migration asserts its own decode and aborts on any violation — 1,326
rows, 169 classes, the 78/312/936 pair/suited/offsuit partition, both
documented endpoints, contiguity, and card ordering.

**One assertion fired, and it was the useful kind.** `fn_gto_board_flush_suit`
was not `STRICT`, so a NULL board fell through the empty tally to the -1
default and returned a confident "rainbow" for a board that did not exist.
The aggregator must be able to SKIP such a row — exactly as V30 skips a
row whose texture class is null — so the function is now `STRICT` and the
assertion that caught it is pinned in the migration. The failed attempt
rolled back atomically; verified afterwards that neither object existed
before re-applying.

## 8. The aggregator, built and proven

Migration `20260830d_v31_aggregator`, applied. `gto_postflop_v31`,
`gto_agg_progress_v31`, and `fn_aggregate_gto_v31_next(p_batch)` — walking
the `solved_v2_at` partial index, so no row is read and discarded; street
comes from the data, so one cursor covers everything; depth from
`eff_stack_bb`; hand keys `CLASS:flushSuitCount`; size buckets from the
real `size_pct` (`bet_small` < 60, `bet_mid` 60-110, `bet_big` >= 110).

There is deliberately **no `facing` column**. V30 needs a `facing = 'open'`
guard in three places because its table can hold a facing cell. This one
cannot, so the guard is unnecessary rather than merely satisfied, and a
future contaminated import has nowhere to land. A post-apply assertion
fails the migration if the column ever appears.

**Two performance facts, both measured rather than reasoned.**

`fn_gto_texture_class_any` is PL/pgSQL and cannot be inlined, so with
ordinary CTEs the planner re-evaluated it once per expanded combo row —
~2,652 times per solve instead of once — and a 25-row batch **timed out**.
With `materialized` it is 657ms. The keyword is load-bearing; removing it
does not slow the function down, it stops it working.

The one-pass window form (`sum/min/max OVER (partition by id, combo_idx)`)
replaced a two-pass `GROUP BY ... HAVING` plus join-back: **2,615ms to
657ms, 4x**. Per the standing rule that an optimisation is proven by
throughput and not by a plan node, the two were also proven to produce the
same answer — `EXCEPT` in both directions over all 2,030 output rows,
zero difference either way.

**The output is right, and it is the thing that was missing.** 225 rows
folded into 24 cells (20 turn, 4 flop), 186 distinct hand keys, zero
malformed, 168 kB:

    street  hand entries  freq sum        check  bet_small  bet_mid  bet_big
    turn           3,456  1.0000-1.0001   3,456          0        0    3,456
    flop             526  0.9999-1.0001     526        526      526        0

Every mix normalises to 1. And the turn now carries **`bet_big` on every
entry** — the 262%-pot overbet that section 3 showed the v1 layer
structurally cannot represent — while the flop carries small and mid,
matching its measured 33-75% sizes. The action vocabulary finally differs
by street because the underlying solves do.

**The suit bucket earns its cost, measured on the built cells rather than
on a sample.** Within one cell and one 169-class, comparing bet frequency
across suit buckets:

    street   classes w/ >1 suit bucket   avg spread   max     over 0.10
    turn                          1,596        0.334   1.000   1,065 (67%)
    flop                            154        0.042   0.422      24 (16%)

A turn class whose two suit buckets bet 100% and 0% is one cell in the old
design, averaged to 50% and wrong for both holdings. The predicted spread
was 0.238 from sampling; the built cells show 0.334.

## 9. The RPC-path measurement — and why it changed the build

The rule here is to call the RPC the way the ENGINE calls it, because a
privileged SQL session hides what PostgREST does. That measurement was
initially blocked (`PGRST202` until the schema cache was reloaded, then
transient `PGRST303` and a gateway 520), and this doc first shipped saying
so. The transient failures cleared. The measurement was then taken, and it
overturned the number I had:

    batch 25, privileged SQL session      0.657 s
    batch 25, POST /rest/v1/rpc          20.5   s      31x worse

`authenticator` carries `statement_timeout=8s`. So the batch that looked
comfortable could never have completed on the engine's path at all — the
driver's first tick would have returned 57014 forever, and the cursor
would never have moved. Had the driver shipped beside the aggregator, that
is exactly what would have happened, silently, because every SQL test
would still have passed.

Three optimisations followed, each proven before being combined:

1. **One whole-array cast instead of 1,326 element casts.**
   `translate(arr::text,'[]','{}')::numeric[]` then `unnest ... with
ordinality`, in place of `jsonb_array_elements` plus a per-slot
   `::text::numeric`. 1,089/5,564ms became 692/1,252ms over 267,852
   values, with an identical checksum (21743.0000) on both runs. The
   variance matters as much as the mean: an 8s ceiling is broken by tails.
2. **Aggregate before keying.** The old form built the `CLASS:suitcount`
   text key for all ~69,000 expanded rows, sorted them wide through a
   window function, then discarded ~85% at the validity filter. Now
   filtered aggregates produce the per-combo distribution in one GROUP BY
   and only the survivors are decoded and keyed. The old form swung
   3,190ms → 42,281ms on identical input; the new one held 5,453/5,756ms.
3. **A vocabulary guard**, so a non-numeric slot skips its action rather
   than failing the whole-array cast and stalling the cursor.

Equality was proven by `EXCEPT` in both directions on two independent
windows — 5,377 and 5,736 output rows, zero difference either way.

Re-measured on the engine's path afterwards:

    batch    time     verdict
      5      1.18 s   comfortable
     10      6.67 s   fits, and is the largest that reliably does
     15      4.90 s   fits, but the spread against 10 says that is luck
     25      9.06 s   57014 — cancelled, over the ceiling

**Batch 10.** Note 15 measured faster than 10 on a single sample: the
run-to-run variance exceeds the difference between those two sizes, which
is precisely why the number is chosen with headroom rather than by taking
the fastest sample.

### A latent bug the rewrite removed

The old shape grouped by `(id, handkey, bucket)` and took `avg(f)`. Across
COMBOS sharing a hand key that is right — it is what a class cell means.
Across two ACTIONS landing in the same size bucket it is wrong: two bets
both under 60% of pot are two ways to do one thing, and their frequencies
must be SUMMED. Averaging would yield a mix that does not sum to 1 —
quietly breaking the invariant this table is verified by. V30's aggregator
sums here; V31's did not.

It has never fired — 4,000 sampled rows have exactly one action per bucket
(turn 2/2, flop 3/3), so no shipped cell is affected — but the bucket
boundaries are arbitrary and a future export could collide without anyone
noticing. `sum(f) FILTER (WHERE bucket = ...)` makes it structurally
impossible.

## 10. The driver, gated

`GtoAggregationDriverV31` is wired into boot beside V30's, and **waits**:
every tick first asks whether `gto_agg_progress` reports every V30 street
done, and does nothing until it does. Both walk the same 79 GB relation
behind the 2026-08-15 liveness incident, and V30 is the one with a consult
already reading its output. The gate **fails closed** — an error, an empty
table, or any shape it does not recognise all answer "not yet", because a
driver that cannot tell whether it is safe to start must not start.

Four calls of 10 rows per 20s tick is ~2 rows/s, deliberately gentler than
V30's eight: nothing is waiting on this build. That is roughly five days
of wall clock for ~1.89M rows, unattended, with the cursor making every
restart free.

Nine tests. Two of them were verified to fail for the right reason before
being trusted — `BATCH` mutated to 25 failed only the batch pin, and the
gate mutated to fail open failed only the fails-closed pin — then restored
green. A guard nobody has watched fail is theatre.

## 11. What remains, honestly

The engine-side **consult is not wired, and should not be yet**:
`gto_postflop_v31` holds 34 cells from 475 folded rows, 0.03% of the
build. A lookup against that would return null almost always and prove
nothing. It becomes worth building when the table is substantially full,
and it needs one new piece — the hero's flush-suit count computed against
the live board to form `CLASS:n`, a mirror of `fn_gto_board_flush_suit`
carrying the same obligation `textureClass()` already has: mirrored
classifiers must agree or lookups land in the wrong cell.

Also still true and worth not re-deriving: V30's `bet_big` branch remains
unreachable on turn and river (section 3a). It is dead rather than wrong,
and it stays because V31 will populate that bucket for real.
