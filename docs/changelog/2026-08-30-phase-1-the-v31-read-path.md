# 2026-08-30 — Phase 1 of 7: the V31 read path, and the audit that ordered the phases

Dan asked for a deep audit of everything left in the horse brain, broken into
phases, built in an order I choose. This is the audit, the plan, and Phase 1.

## The audit finding that set the order

Everything about the solver stack is bounded by one number nobody had
measured: **how much of the fleet's decision volume it can reach.**

Seven days of `horse_brain_telemetry`:

| layer                   | fires/7d  | % of all decisions |
| ----------------------- | --------- | ------------------ |
| `decide` (total)        | 4,522,162 | 100%               |
| `decide_nlh`            | 2,243,413 | 49.6%              |
| `decide_omaha`          | 2,056,781 | 45.5%              |
| `decide_short_deck`     | 221,968   | 4.9%               |
| `v27_gto_open_jam`      | 34,039    | 0.75%              |
| `v29_gto_flop_open`     | 9,918     | 0.22%              |
| `v27_gto_bb_defend`     | 7,048     | 0.16%              |
| **`v30_gto_turn_open`** | **3,666** | **0.081%**         |

**The entire GTO stack serves about 1.2% of decisions. V30's turn layer
serves 0.081%.**

And there is a hard ceiling above it. The warehouse holds `cash`, `hu_cash`,
`6max_cash`, `9max_cash`, `mtt_*`, `sng_*`, `spin_*` — **all hold'em, zero
Omaha, zero short deck.** So 50.4% of the fleet's decisions can never be
served by this data at all. That is a property of the export, not a gap to
close.

Within the reachable half, the binding constraint is the consult GATE, not
the data: it requires two hole cards, no Omaha, no short deck,
`oppCount === 1`, `initiative === 'hero'`, no second board, and a cell that
exists. Each is individually defensible — the warehouse is heads-up open
nodes — but together they cut 49.6% down to 0.3%.

**That reordered the plan.** Finishing the V31 build faster is not the
highest-value work; being able to see where the volume goes, and then
widening what the layer can answer, is.

## The phase plan

1. **The V31 read path and solver observability** — this document.
2. **Facing-a-bet defence from the solver's own betting range.** The single
   biggest coverage win available: today only "hero has the lead" is served,
   and facing a bet is at least as common. Buildable from open-node data —
   a cell's bet frequency per holding IS the opponent's betting range at a
   known size.
3. **Coverage and hit rate**, driven by the miss telemetry Phase 1 adds
   rather than by guesswork.
4. **The unswept axes**: plo8 hi-lo scoop/quarter, straddle pots, push-fold
   short stacks, 9-max preflop position mapping, and `Math.min(oppCount, 4)`
   behaviour at five or more opponents.
5. **Bomb pots** — convict or clear the raise-facing-a-bet signal that falls
   11% → 6% → 2% across one, two and three boards.
6. **Schedule and throughput** — the V30-river vs V31 priority question, and
   the duty cycle, with fresh measurement.
7. **Hygiene** — the open-PR backlog, hand-history retention, and the
   deliberately-unbuilt `(street, id)` index.

## Phase 1, built

### The size, which turned out to be the load-bearing part

V31's `bet_big` bucket means ">=110% of pot". The measured turn mean is
**246.8%** (117-263, sd 36.6). A reader taking the bucket midpoint would
have sized the solver's overbet at roughly a third of what it is — and
playing that overbet is the ONE thing the v1 layer cannot do at all, because
every v1 tree offers exactly one bet size, `b16`, on every street at every
stack depth from 8bb to 150bb.

So the cell now carries the size. `gto_postflop_v31.size_pct` holds the mean
per bucket, cell-level because the solver offers one size per action to the
whole range. Sizes are near-deterministic per tree, so a mean is faithful:
flop `bet_small` is exactly 33 and `bet_mid` exactly 75, both sd 0.0.

The table was truncated and the cursor reset so no cell is left without one —
1,350 of ~1.89M rows had been folded, so redoing them costs minutes, and a
table where some cells know their size and others do not is worse than an
empty one.

Verified live: turn cells now read `{"bet_big": 262}` and flop cells
`{"bet_mid": 75, "bet_small": 33}`.

**One defect on the way.** The first aggregator carried the size through with
`max(z.size_map)`, and there is no `max(jsonb)` in Postgres. The DDL applied
cleanly and the function failed on its FIRST CALL — a migration succeeding is
not the same as the code in it working. The fix was not a cast: `size_map` is
functionally dependent on the group key and simply belongs in the `GROUP BY`;
Postgres just cannot infer that across a join.

### The read path

- **`GtoPostflopV31.ts`** — the store, `boardFlushSuit`, `v31HandKey`, and
  `gtoStreetAdviceV31`. It imports `textureClass` and `snapDepthBucket` from
  GtoPostflop.ts rather than reimplementing them: one classifier, one
  behaviour, no drift.
- **`GtoPostflopV31Loader.ts`** — paged at 500, collect-then-swap, refreshed
  every 6 hours. That refresh matters more here than for V30: this table is
  built from empty over days, so nearly every refresh delivers cells that did
  not exist before.
- **`HorseLogic`** — V31 is consulted BEFORE V30 and falls through to it, then
  to the heuristics. Not because V31 is a better answer to the same question:
  the two exports are disjoint (0 of 9,584 sampled turn rows carry both), so
  V31 is the 59% of the turn V30 never sees. When it can answer it answers
  strictly better — it knows the suit bucket and it knows the size.
- **`opts.v31GtoSuitAware`** — the ablation flag, matching `v29GtoFlop` and
  `v30GtoTurnRiver`.

### The mirroring obligation, and how it is held

`boardFlushSuit` must agree with `fn_gto_board_flush_suit` EXACTLY, because
the cell is keyed by the SQL function at build time and read by the TS one at
decision time. Disagreement does not throw — it silently returns another
holding's strategy, and a wrong answer looks exactly like a right one.

Fifteen board/answer pairs classified by the production function are pinned,
including the tie cases, where the SQL's `order by n desc, suit asc` means the
LOWEST suit index wins.

**Three mutations were run to prove the pins are not theatre:**

- tie-break `>` loosened to `>=` — caught by the five rainbow cases;
- suit iteration reversed high-to-low — caught by `3h4h5c6c` and the explicit
  tie test;
- sizing replaced by a 0.7 midpoint — caught by the overbet test.

Each failed only its own pin, and green was restored after each.

### Observability, which is the part Phase 3 depends on

The layer's silence was previously unattributable. Now, when the gate is
passed and NEITHER layer answers, exactly one literal counter fires:
`gto_miss_no_cell`, `gto_miss_hand_not_in_cell`, `gto_miss_no_texture`,
`gto_miss_no_hand` or `gto_miss_empty_store` — literal, so the dead-layer
grep audit can still see them. `v31_gto_open` records answers, and
`v31_gto_no_size` records the one case where a bucket has no recorded size
and the consult falls through rather than inventing a number.

That turns "the solver layer fires on 0.081% of decisions" from a mystery
into a measurement with a cause, which is what Phase 3 is for.

## Verification

- `npx tsc --noEmit` clean in both roots.
- `src/engine`: **122 files, 1,363 tests** pass (31 of them new).
- `src/services`: **49 files, 524 tests** pass.
- Three mutation tests confirmed the new guards fail for the right reason.

## What Phase 1 deliberately does NOT claim

`gto_postflop_v31` is rebuilding from empty after the reset, so the consult
will miss almost always for now and V30 answers exactly as it did before.
That is the designed behaviour, not a caveat: the read path is correct and
inert, and it starts paying off as the table fills. Nothing about horse
behaviour changes today beyond the new counters.
