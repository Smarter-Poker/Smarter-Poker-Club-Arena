# The terminal settlement lane is per tournament - implementation plan

Date: 2026-09-17. Status: plan, measured on production, not yet implemented.
Owner instruction: build the next implementation plan; implementation starts
on the owner's word. Predecessor: `docs/changelog/2026-09-10-the-settlement-lane-is-per-tournament-for-authorities.md`,
which made the lane per tournament for rolling authorities and left terminal
authorities on the platform-wide lane.

## The one-line finding

Every tournament finish (`fn_complete_tournament_terminal`) takes the whole
platform's settlement lane exclusively (G and B), so while one Spin is being
paid out, every hand settlement, blind publication, horse seating and
elimination on the platform waits behind it, and the PostgREST pool (71
connections) fills with waiters. Finishes come in bursts, so the platform
stalls in bursts, and the 8 s statement timeout cancels the hands at the back
of the queue.

## Evidence (production, 2026-09-17, 200 ms `pg_locks` samples over psql)

G is `hashtextextended('ca:tournament-terminal-settlement:v1',0)`, B is
`'ca:hand-settlement-barrier:v1'`, T(id) is the per-tournament key.

| window                                                            | G held exclusively by             | episodes      | held, avg / max                       | waiters, max |
| ----------------------------------------------------------------- | --------------------------------- | ------------- | ------------------------------------- | ------------ |
| 07:35-07:55 (engine a0d001e2)                                     | `fn_complete_tournament_terminal` | 264 in 20 min | 79 ms / 808 ms                        | 69           |
| 08:02-08:08 (engine 4a2bff6f, finishing the decided-Spin backlog) | `fn_complete_tournament_terminal` | ~85 a minute  | 179 ms / 2,402 ms; one hold of 16.2 s | 68           |

Who waited on G (shared) during those windows, and for how long:

| window      | waiter                                                | waits seen | p50      | p90      | max      |
| ----------- | ----------------------------------------------------- | ---------- | -------- | -------- | -------- |
| 07:35-07:55 | `fn_publish_tournament_blind_level`                   | 4,468      | 249 ms   | 489 ms   | 1,166 ms |
| 07:35-07:55 | `fn_ca_commit_hand_settlement`                        | 153        | 195 ms   | 474 ms   | 1,176 ms |
| 08:02-08:08 | `fn_ca_commit_hand_settlement`                        | 1,589      | 1,979 ms | 4,490 ms | 8,004 ms |
| 08:02-08:08 | `fn_publish_tournament_blind_level`                   | 458        | 2,040 ms | 4,280 ms | 7,957 ms |
| 08:02-08:08 | `fn_seat_horse_in_seat_first_game`                    | 221        | 1,250 ms | 4,264 ms | 8,002 ms |
| 08:02-08:08 | `fn_complete_tournament_terminal` (behind each other) | 353        | 999 ms   | 3,160 ms | 7,810 ms |

Consequences in the same window, from the Postgres log: 71 statement
timeouts in 08:05-08:10, 52 of them `fn_ca_commit_hand_settlement` and 5
`fn_publish_tournament_blind_level`; a hand whose settlement is cancelled
stalls its table until the engine retries it, and a horse whose seating is
cancelled is not playing. `pg_stat_activity` at 08:12: 71 PostgREST
backends, 46 active, 44 of them waiting on an advisory lock.

Scale since the `pg_stat_statements` reset on 2026-09-10: 34,542 calls of
`fn_complete_tournament_terminal`, mean 797 ms (lock waits included), max
19.9 s, 27,527 s of platform-wide exclusive hold in total; 3,259 calls of
`fn_resolve_tournament_terminal_outcome`, a read-only resolver, mean 217 ms,
max 15.5 s, also on the global lane.

Why 69: the PostgREST pool has 71 connections. A convoy is the whole pool.
While a convoy stands, every RPC on the platform, cash tables and horse
decisions included, waits for a connection. That is how one Spin's payout
reaches every table.

The same samples showed a second, separate storm that the 4a2bff6f release
already removed (see "What the 07:55 release changed" below): 424 finished
Spins whose in-memory managers kept publishing blind levels every 2 s.

## What the lane looks like today

| path                                                            | G (platform) | B (hands) | T(id)     |
| --------------------------------------------------------------- | ------------ | --------- | --------- |
| rolling authority (`fn_ca_lock_settlement_lane_for_tournament`) | shared       | -         | exclusive |
| hand settlement (`fn_ca_share_settlement_lane_for_table`)       | shared       | shared    | shared    |
| terminal / rare (`fn_ca_lock_settlement_lane_global`)           | exclusive    | exclusive | -         |

`fn_ca_lock_settlement_lane_global` has 31 callers in the live catalog; the
ones that run are `fn_complete_tournament_terminal` (34,542 calls),
`fn_resolve_tournament_terminal_outcome` (3,259),
`fn_resolve_satellite_settlement_outcome` (2,292) and
`fn_spin_expire_unfilled` (1,190). The other 27 have not been called since
the reset.

The proof-of-authority guards already accept T: since 2026-09-10,
`fn_tournament_live_seat_acquisition_requires_authority`,
`fn_tournament_payouts_are_append_only` and
`fn_satellite_target_player_provenance_is_immutable` accept G held
exclusively OR T(the row's tournament) held exclusively, and
`smarter_private.f06_source_guard` / `f06_try_lane` try G shared plus T.
Inside `fn_complete_tournament_terminal`, `fn_ca_open_tournament_seat_exit_authority`
already takes T(id) exclusive, so a finish holds T(id) exclusively today; the
outer G exclusive adds only the platform-wide exclusion.

## The change

One migration, in the shape of `20260910173147_the_settlement_lane_is_per_tournament_for_rolling_authorities.sql`:

1. `fn_complete_tournament_terminal(p_tournament_id, p_observed_winner_id, p_settlement_mode)`:
   read the tournament's `variant`, `tournament_type`, `satellite_target_id`
   and `satellite_target` (no lock; these never change after creation), and
   take the lane accordingly:
   - satellite: `fn_ca_lock_settlement_lane_global()` as today (a satellite
     finish writes the target tournament's rows, and a transaction never
     holds two tournaments' lanes);
   - anything else: `fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)`,
     that is G shared and T(id) exclusive, the rolling-authority shape.
     Nothing else in the body changes.
2. `fn_resolve_tournament_terminal_outcome`: it refuses satellites itself, so
   it takes `fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)`
   unconditionally. It is a read-only resolver; the per-tournament lane is
   exactly what it needs (it waits for a finish of the same tournament that is
   still in flight, and nothing else).
3. `fn_spin_expire_unfilled`: Spins are never satellites; per-tournament lane.

Stays on the global lane: `fn_resolve_satellite_settlement_outcome`, every
satellite finish, cancellation, deal review, managed-game close, rake sweep
and the other rare callers. They are rare, and they are the ones that can
write across tournaments.

B is not taken by a per-tournament finish. Hands of the same tournament
hold T(id) shared and are excluded by T(id) exclusive; hands of other
tournaments and cash hands were never in conflict with this tournament's
payout, they were only queued by it. Balance, ledger and Spin reserve rows
are row-locked in the same order by every writer, as they are today under
the global lane; the advisory lane never protected them.

## Why it is safe

- Every guard that reads the lane as proof of authority accepts T(row's
  tournament) held exclusively, and the finish holds it (proved on the live
  catalog above; the migration re-proves it).
- The finish's writes are all rows of its own tournament: `tournaments`,
  `tables`, `table_seats`, `tournament_players`, `tournament_escrow`,
  `tournament_terminal_settlements`, `tournament_bounty_completion_receipts`,
  plus the payout, rake, bounty and diamond receipts of that tournament.
  Cross-tournament writes exist only on the satellite path, which keeps the
  global lane.
- Lock order is unchanged: lane first, then `tournaments FOR UPDATE`, then
  the field. The rolling authorities already run in this exact shape beside
  hand settlements, since 2026-09-10, with `pg_stat_database.deadlocks`
  unchanged across that change.
- The migration refuses to run unless each replaced body is byte-identical
  (md5) to the reviewed one, and after the change proves on the live catalog
  that only the lane helpers and the listed global callers still take G
  exclusively. Rollback is a byte-for-byte file beside it.

## Verification on production, before the change is called done

Same sampler, same windows, ideally across one finish burst (a restart
drains decided Spins at 85 finishes a minute, which is the worst case seen):

- G held exclusively only by satellite / rare callers; `fn_complete_tournament_terminal`
  never appears as a G-exclusive holder.
- Waits on G by `fn_ca_commit_hand_settlement` and `fn_seat_horse_in_seat_first_game`:
  p90 under 100 ms, none above 1 s.
- Zero `canceling statement due to statement timeout` for
  `fn_ca_commit_hand_settlement` and `fn_publish_tournament_blind_level`
  during the burst (52 and 5 in 08:05-08:10 today).
- `fn_eliminate_tournament_player_atomic` mean (3.4 s over 83,163 calls)
  falls: it takes no lane itself but waits on the `tournaments` row behind a
  blind publication that is waiting on G.
- PostgREST pool: no sample with more than a handful of backends on
  `wait_event = advisory`.
- No guard refusal (`TOURNAMENT_SEAT_ACQUISITION_REQUIRES_TERMINAL_AUTHORITY`,
  provenance, append-only payout, `F06_*`) from any caller after the change.
- `pg_stat_database.deadlocks` unchanged.

## What the 07:55 release changed, for the record

Engine 4a2bff6f (contains #4731, the re-land of #4713, and #4701's re-land
of #4626) went live at 07:55:34 UTC; measured at 08:09, seven minutes after
the 08:02 resume of 1,746 tables, against the same numbers at 07:33 on
a0d001e2:

| number                                             | a0d001e2, 07:33                                | 4a2bff6f, 08:09                   |
| -------------------------------------------------- | ---------------------------------------------- | --------------------------------- |
| wait-loop log lines a minute                       | 12,995                                         | 1,319, every one with its backoff |
| `blind_transition_failed` a minute                 | 12,947 (424 finished Spins retrying every 2 s) | 0                                 |
| `fn_publish_tournament_blind_level` calls a second | 217                                            | 4                                 |
| managers alive vs tournaments running              | 1,053 vs 562                                   | 293 vs 287                        |
| elimination sweep, mean                            | 10.6 s                                         | 1.5 s                             |
| elimination queue depth / oldest wait              | 1,022 / 26 min                                 | 258 / 7 min                       |
| tournament lease heartbeat errors                  | 17                                             | 0                                 |
| engine RSS                                         | 2.4 GB                                         | 1.3 GB                            |

The blind storm was 424 in-memory managers of Spins already COMPLETED in the
database, each retrying its refused level every 2 s for hours: 6.2 million
calls and 39.5 hours of database time since 2026-09-10. #4626 (retire the
blind clock after a verified terminal receipt) stops it forming again; the
restart dropped the existing ones.

## Engine follow-ups, separate small PRs, each with a law test

1. The refused blind clock asks why. When `fn_publish_tournament_blind_level`
   answers `tournament_not_running`, the manager confirms the tournament's
   status and retires its clock (and itself) instead of retrying every second;
   any other refusal backs off from 1 s to a bounded ceiling. #4626 covers the
   finish this manager committed; this covers a finish it did not see.
2. The HorseFleet load phase still runs 19 to 35 s against its 18 s budget
   (a 30 s tick is dropped in most cycles); the seat-first seating budget now
   starts after it (#4731), so seating is no longer starved, but the phase
   itself is next.

## Not in this plan

- No repair job, backfill, watcher or cron. Decided Spins finish through the
  engine's sweeps, which is the path being unblocked.
- No change to `fn_eliminate_tournament_player_atomic` or
  `fn_sync_seat_first_player_count` lock scope (still on the list; measure
  again after this change, most of their time is the queue above).
- No change to the maintenance barrier `530090`.
