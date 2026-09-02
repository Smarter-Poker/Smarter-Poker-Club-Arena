# 2026-08-30 — Sweep: an anon-callable evictor, a 3% audit hole, and a build blocked for days

A hunt across production for bugs, gaps, stubs, regressions and wiring issues,
after the ante and all-in-or-fold fixes shipped. Four leads were chased to a
conclusion and closed as NOT bugs; three are real. Recording both, because a
lead that was chased and cleared is worth as much to the next agent as a fix.

## FIXED — an unauthenticated browser could evict cash players

`fn_evict_sitting_out_cash_players()` is SECURITY DEFINER, takes no arguments,
and was EXECUTE-able by `anon`. It walks every cash table and calls
`player_leave_table` on anyone sitting out, which unseats them and moves their
stack back to their wallet. A stranger with no account could POST to
`/rest/v1/rpc/` and force that platform-wide, as often as they liked.

Not theft — the chips go to their own owner — but it is a stranger operating
other people's seats, and repeated at will it is a denial of the cash game.

Same class as `reconcilers_are_not_public_api` (2026-08-24): PostgREST exposes
every public function, and Postgres grants EXECUTE to PUBLIC by default, so a
maintenance sweep that only the scheduler ever needed sat on the browser's
surface. Closed, with `fn_snapshot_player_stats_if_missing()` and
`fn_next_player_number()` found in the same pass.

**It cannot break the sweep**: pg_cron runs it every minute as `postgres`,
which OWNS the function, and an owner keeps EXECUTE regardless of grants.
Verified before applying — and the 23:45:00 run afterwards reported
`succeeded`.

### How it was found, which matters more than the bug

The Supabase advisor emits **722 SECURITY DEFINER grant warnings** — far too
many to read, so nobody does. Filtering `pg_proc` to functions that are
SECURITY DEFINER **and** VOLATILE (can write) **and** not a trigger **and**
genuinely EXECUTE-able by `anon` reduces 722 to **nine**, six of which are
public reads the signup and lobby pages need. That query is the reusable part.

## OPEN — the bomb pot award ledger loses ~3% of its rows

`fn_bomb_pot_ledger_gaps()` returns 16 right now; 1,418 chips today.

The write is deliberately fire-and-forget with three retries — _"the ledger
narrates money that logHandHistory has already recorded; it must never be able
to fail a hand"_. **So no player is short a chip.** What is lost is the audit
row, and `v_bomb_pot_outcomes` cannot reconstruct those hands.

Measured over 24h: 2-board 9/355 lost (2.5%), 3-board 7/143 (4.9%). Not
structural — the losses spread evenly across fold counts (2.3% / 3.8% / 5.3% /
10.5%) and evenly through the day rather than clustering at deploys, and 0% of
them were uncontested wins while 8.1% of the successes were. That is the
signature of a transient upsert failure surviving all three attempts, not a
code path that never runs.

Left open deliberately: the fix is a durability change (write inside the hand's
own transaction, or a queue), which is a design decision about whether an audit
row may ever cost a hand — not something to pick unilaterally at midnight.

## OPEN — V31 cannot start for about three and a half days

Phase 1 shipped the V31 read path and said it would "start paying off as the
table fills". It will not fill for days, and nothing said so.

`gto_agg_progress` is keyed by street. `turn` is at 1,677,950 of ~2,276,903
rows and advancing at ~900/min; `river` (~3,779,362 rows) has not started. The
V31 driver is gated on `v30IsComplete()`, which requires **both**. So:

    turn remaining   599k rows   ~11 hours
    river          3,779k rows   ~70 hours
    ------------------------------------------
    before V31 may begin its own ~1.89M-row build:  ~81 hours

The gate is defensible — it exists so two heavy aggregations never contend on
the 79 GB warehouse, and there was a liveness incident there on 2026-08-15. But
the honest statement is "V31 is inert until roughly 3 September", not "it fills
up". Releasing the gate after TURN completes (river is the least valuable
street) would recover most of that; it is Dan's call, because it means two
aggregations running at once against the table the fleet deals from.

Positive: the read path itself is proven. `v31_gto_open` has fired 4 times off
the 7 cells that exist, and `gto_miss_no_cell` 397 times. It works — there is
simply nothing to read yet.

## CHASED AND CLEARED — four that looked like bugs and were not

- **`v29_gto_flop_defend` stopped dead**: 1,366 fires on 08-29, zero on 08-30,
  while `v29_gto_flop_open` doubled. It was **deliberately removed** in #1810,
  "contaminated facing cells purged, facing consult removed". Yesterday's fires
  were the old build; the removal simply landed on restart. This is exactly
  what Phase 2 rebuilds.
- **The `player_wallet` reconciliation vanished** after 08-26, having logged
  exactly 584 rows nightly. Retired **on purpose** (2026-08-27): it reconciled
  against `public.wallets`, the pool frozen on 08-21 with 732,591,994.33
  stranded. 575 wallets re-flagged nightly and, in that migration's own words,
  _"the one REAL alert (seat-stack exit, 55 chips) drowned"_. Replaced by a
  single frozen-pool baseline check, which reads `ok` with zero drift.
- **1,033 critical `seat_stack_exit` rows today vs `fn_unaccounted_seat_exits()`
  returning 0.** Both call the same function, so the contradiction was real.
  Resolved: 1,036 correction credits were issued at 21:36 today returning
  **432,100.90 chips**, matching the flagged drift. The monitor fired, someone
  remediated, the function now correctly reads 0. The system worked.
- **`gto_agg_progress` having two rows** — not a duplicate, one row per street.

## Also swept, clean

- **Zero TODO / FIXME / stub markers** in `server/src` (the one hit is `+XXX`
  inside an animation spec comment).
- The advisor's single ERROR is `spatial_ref_sys` RLS — a PostGIS table owned
  by `supabase_admin`, already documented as unalterable.
- `fn_unaccounted_seat_exits()` returns 0. Chips on the felt reconcile.
