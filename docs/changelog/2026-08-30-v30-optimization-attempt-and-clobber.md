# 2026-08-30 — V30: an optimization that made it slower, and the concurrent-agent clobber that followed

Three things happened in twenty minutes. Two of them were my mistakes. All
three are written down because the second one is a trap any agent in this
estate can fall into, and the third is the correct way out of it.

## 1. The optimization that was faster on paper and slower in production

`EXPLAIN (ANALYZE)` on a live 200-row turn batch showed the `roots` CTE
being **recomputed eighty times** — `Group ... rows=176 loops=80` — because
a CTE Scan reports an estimate of one row, so the planner chose a nested
loop with a join filter for `src JOIN roots ON r.id = s.id` and discarded
13,920 rows through it. About 860ms of a ~3.5s call, spent re-deriving data
the outer row already held.

I rewrote it with a LATERAL against the row itself: no self-join, no
repeated Group, no dependence on a CTE estimate. I proved equivalence
before applying — both formulations run over the same 200-row window,
cell sets compared with `EXCEPT` in both directions: **6,883 cells each,
only_in_old = 0, only_in_new = 0.**

It was still slower. Pushing the `pos`/`tex` predicates into `src` made the
planner evaluate `fn_gto_texture_class_any` — a plpgsql function — inside
the filter for all 200 rows before anything could be discarded. Re-measured
end to end: **977ms → 1252ms**. Live, every driver call then blew the ~8s
API budget and the cursor sat at 167,950 rows for 93 seconds without
moving. Reverted (`v30_revert_lateral_optimization_it_was_slower`).

**The rule this cost me: an optimization is not proven by a plan node. It
is proven by the throughput of the thing it was supposed to speed up.**

## 2. The clobber — I reverted over another agent's fix

While I was measuring, a scheduled verification pass shipped **#1849**,
which found the batch was sitting on a timeout cliff and lowered the SQL
floor from `greatest(200, ...)` to `greatest(25, ...)` so the driver could
pass 100 (measured: 100 rows ≈ 0.9s and 111 rows/s; 200 rows ≈ 8s with one
call in three cancelled — the cost is **super-linear** because a populated
`gto_postflop_compact` sends nearly every batch down the `ON CONFLICT`
merge path).

My revert was a full `CREATE OR REPLACE` built from a copy of the body I
had fetched _before_ #1849 landed. It restored the working CTE structure —
and silently put the floor back to 200. The deployed driver sends 100, my
body clamped it up to 200, and the aggregation went straight back onto the
cliff it had just been rescued from.

**Nothing caught this.** The function is not covered by a schema assertion,
the migration check only verifies that declared objects _exist_, and both
migrations were legitimately "applied". The only reason it was found is
that the throughput number was checked again afterwards.

## 3. The recovery, and the pattern that should have been used first

Fixed by reading `prosrc` from the live catalog and patching **only** the
clamp — a `DO` block that aborts if the expected text is not found, rather
than guessing:

```
if position('greatest(200, least(5000' in v_src) = 0 then
  raise exception 'clamp not found as expected - aborting rather than guessing';
end if;
```

Recovery verified by rate, not by the absence of an error:
170,750 rows at 05:40:37 → 173,550 at 05:41:43 = **2,800 rows in 66s ≈ 42
rows/s**, cursor 2 seconds old.

The function's `COMMENT` now carries the warning, because that is what the
next agent will actually read:

> DO NOT CREATE OR REPLACE THIS FUNCTION FROM A COPY YOU FETCHED EARLIER.
> Read prosrc first and patch surgically, or re-derive from the newest
> migration on main.

## Where V30 stands

- turn: 173,550 / 3,184,083 rows, 1,500+ cells and climbing, ~20h remaining
  at 42 rows/s; river (5.59M) follows, ~37h.
- `facing <> 'open'` cells: **0**. Stored mixes still sum to 1.000 with only
  `check` / `bet_small` / `bet_big` buckets.
- Not attempted, deliberately: a composite `(street, id)` index would
  reclaim the ~530ms the batch fetch wastes discarding 341 of 541 rows read,
  but building one on a 79 GB / 8.8M-row table is the class of operation
  that caused the 2026-08-15 liveness incident. Not while the fleet deals.

## Known follow-up, not a regression

The consult passes `stackBB = player.stack / bigBlind` — the stack
_remaining_ at the moment of the decision. The warehouse's `stack_depth` is
the depth the spot was solved at. On a river after heavy action those differ,
so the lookup can snap to a shallower bucket than the solve intended. This
is inherited from V29's flop consult and is bounded by the neighbouring-
bucket fallback; correcting it means reconstructing street-start effective
stack, which is a change worth measuring on its own rather than folding into
this one.
