# 2026-08-30 — the V30 aggregation batch was sitting on the timeout cliff

RULE 1 / RULE 7 follow-through on the V30 turn/river aggregation work
(PRs #1810 / fb89cc9db4 and #1838 / ad842ed491, both already merged).

## What was being checked

The Hetzner engine deploy of `ad842ed491` was still inside the drain gate at
03:54 UTC. The question was whether it landed and whether the new driver
actually went faster.

## Deploy: landed

`auto-deploy-hetzner` run `33290820094` for `ad842ed491` completed **success**,
03:41:06 → **03:55:35 UTC**. Every step green; the two "did not deploy" escape
hatches (`ROLLBACK`, `DID NOT DEPLOY — this run shipped nothing`) were both
**skipped**, so the cutover is real. Verified through the workflow's own step
results, not `/health` — that endpoint is CDN- and fetch-cached and lies about
deploys (CLAUDE.md section 11).

## Driver: running, but at a quarter of its own claim

`gto_agg_progress` was advancing — cursor age 15–46 seconds throughout — but at
**200 rows per 20-second tick, ~10 rows/s**. The driver's header projects
~40 rows/s from "4 calls x 200 rows". Only ONE call per tick was landing.

Probed the way the engine calls it (`POST /rest/v1/rpc` as `service_role`,
never as `postgres` — that shortcut is what hid the 21000 bug the night
before). Three consecutive calls at the deployed batch size:

    call 1  http=500  8.27s  57014 canceling statement due to statement timeout
    call 2  http=200  8.15s  processed=200
    call 3  http=200  7.54s  processed=200

The API roles carry `statement_timeout=8s` (`authenticator`; `service_role`
itself has no `rolconfig`, so it inherits). A 200-row batch costs ~8s. The
batch was **on the cliff edge**: roughly every other call burned eight seconds
of database CPU and then rolled back with the cursor unmoved.

### Why 200 stopped being the right number

It was measured at 3.5s when it was chosen, and that was true then.
`gto_postflop_compact` has since accumulated enough cells that nearly every
batch takes the expensive `ON CONFLICT` weighted-merge path rather than a
plain insert.

Re-measured across batch sizes, same path:

| batch | time       | rows/s  |                                     |
| ----- | ---------- | ------- | ----------------------------------- |
| 100   | 0.89–0.95s | **111** | ~9x headroom under the 8s cap       |
| 125   | 1.15–1.42s | 98      |                                     |
| 150   | 1.56–1.71s | 92      |                                     |
| 200   | 7.54–8.27s | 25      | on the cliff; 1 call in 3 cancelled |

The cost is **super-linear** in batch size. The read side is not the problem —
`EXPLAIN ANALYZE` puts the cursor scan at **2.7ms** for 200 rows and the whole
read/transform CTE at **385ms** for 100. The expense is in the aggregation
CTEs, which the planner estimates at `rows=1` and therefore joins with nested
loops ("Rows Removed by Join Filter: 2812" on a 100-row batch), so the work
grows faster than the row count. Doubling 100 to 200 does not double the cost,
it octuples it.

So the largest batch that fits was also the slowest per row AND the one that
got thrown away.

## Fix (PR #1849, merged 04:12:32 UTC as `423cdb7ed0`)

- `BATCH` 200 → **100**, `MAX_CALLS_PER_TICK` 4 → **8**.
  Same ~40 rows/s the header always claimed, now actually reachable, at a
  **~36% duty cycle** against the old design's 60% — four times the throughput
  at _less_ database load, because none of the work is discarded.
  Projected: turn ~22h, river ~39h.
- Migration `20260830040000_v30_batch_floor_measured_not_guessed.sql`: the SQL
  clamped `p_batch` to `[200, 5000]`, so 200 was simultaneously the smallest
  batch a caller could ask for and the largest that fits — **the only tuning
  knob was pinned against a wall.** Floor lowered to 25. The function body is
  otherwise byte-identical to `20260830033000` (verified by diff: exactly one
  line differs), so the root-only `'open'` cells, the per-hand validation, the
  `check`/`bet_small`/`bet_big` bucket set and the `TRUNCATE` are untouched.
  Applied via the Supabase MCP _before_ the commit, then re-probed through
  PostgREST — the table above is that probe.
  Rollback: re-apply `20260830033000_v30_driver_postgrest_safeupdate_fix.sql`.
- `GtoAggregationDriver.test.ts` pinned 200 and 4 calls; both moved in the same
  commit (CLAUDE.md section 8), with the measurement written into the pin so a
  silent regression back to 200 reads as the ~10 rows/s bug it is.

## Data soundness — clean, checked twice

- `select count(*) from gto_postflop_compact where facing <> 'open'` → **0**
- 3000-value sample of turn/river matrices: min mass **1.000**, max mass
  **1.000**, buckets **`{check, bet_small}`** only. No `fold` / `call` /
  `raise_*` bucket, so the contaminated aggregation has not returned.

## Lesson worth keeping

A measured constant has a shelf life. "200 rows costs 3.5s" was honest when it
was written and silently became false as the target table filled up — and the
failure mode was not an alarm, it was a number in a header that no longer
described reality while the job quietly ran at a quarter speed. When a tuned
constant sits at the edge of a hard limit, the limit will eventually be
crossed by drift alone. Leave the knob room to move in BOTH directions:
the clamp floor of 200 meant nobody could have tuned down even after noticing.
