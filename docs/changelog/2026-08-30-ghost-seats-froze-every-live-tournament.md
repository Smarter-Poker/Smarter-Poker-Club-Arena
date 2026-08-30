# Ghost seats froze every live tournament (and took the lobby with them)

**Date:** 2026-08-30
**Severity:** platform-wide outage
**Symptoms reported:** (1) MTTs not displaying at all, (2) "Enter Table" in the
club lobby opened nothing, (3) lobby error, clubs would not load.

All three were one fault.

## What happened

The retired World Hub legacy engine (`GameController._cleanupStaleTables`)
closed every claimed tournament table on a timer. Commit `15297cf95f` stopped
the writer earlier the same day, but **nothing undid the damage it had already
done**.

Left behind: **71 tables belonging to 19 RUNNING tournaments, status='closed',
with their fields still seated** -- 411 open seats holding ~4.6M tournament
chips. The field survived only because `fn_on_table_status_change` had just
been given a live-tournament guard ("the close is somebody else's mistake and
the field plays on").

The Hetzner engine discovers tables with `status IN ('waiting','running')`.
With every tournament table closed it discovered **zero**:

| signal | before repair | after repair |
| --- | --- | --- |
| `activeTables` (engine `/health`) | 0 | 70 |
| `activeTournaments` | 1 | 23 |
| `tablesExpectedDealing` | 0 | 20-22 |
| `discoveryStaleMs` | 43,181 (stalled) | ~4,000 (healthy) |
| hands/minute | ~0.2 | 27 and climbing |

Hands had decayed 7,455/hr (11:00) -> 847/hr (18:00) -> ~1 per 15 minutes.

### Why each symptom followed

- **MTTs not displaying** -- there were no open tournament tables to list.
- **"Enter Table" dead** -- the seat you hold points at a closed table.
- **Clubs would not load** -- every player and horse stayed pinned at the
  four-table limit by a dead seat, so the seating loop retried forever:
  **10,738 `FOUR TABLE LIMIT` rejections in two hours**. That storm, on top of
  the legacy engine's own write flood (204,345 `UPDATE tables SET settings,
  status` calls, 6.5M ms of DB time), saturated PostgREST. Reads timed out and
  the database intermittently answered `FATAL 57P03: the database system is not
  accepting connections`, which is the exact error the lobby's catch block
  reports as "Could Not Load Your Clubs".

## The repair

`20260830191130_reopen_live_tournament_tables_closed_by_legacy_engine.sql`

Moves `closed -> running` for tables whose tournament is still RUNNING and
which still hold an open seat, and resyncs `current_players` from the real
seat count. It touches **no seats, no chips, no wallet** -- reopening is safe
because `fn_on_table_status_change` releases seats only on transitions *into*
a terminal status, and `trg_tables_auto_cashout_on_close` fires only on the way
to closed. Every changed row is recorded in `zz_reopen_20260830_backup` for
rollback, with pre-flight and post-apply assertions.

Deliberately **not** done: unseating the field or refunding buy-ins. These are
live tournaments mid-flight; `fn_leave_seat_and_refund` would have paid out
buy-ins and destroyed 12 running events.

## The second bug: the alarm was silent

`20260830191330_fix_silent_table_closed_under_live_tournament_alarm.sql`

The guard above logs `table_closed_under_live_tournament` so a close landing on
a live table is impossible to miss. It had **three** defects and could never
write a row:

1. inserted into `event_type`; the column is `event`
2. inserted into `details`; the column is `detail`
3. `engine_recovery_events_event_check` permitted only four watchdog values,
   so even correct column names would have been rejected

All three raised inside the function's own "the log is a courtesy" EXCEPTION
handler and were swallowed. 71 live tables were closed today and the alarm
recorded nothing -- the incident had to be found by reading
`pg_stat_statements`. Fixed, and the migration self-tests the alarm by firing
it on a real table inside the migration and reverting the probe.

## Still open for Dan

- **Sentry has been blind since 2026-08-23.** Ingestion shows 46,362 events
  accepted that day, then zero: 34,228 rate-limited, 722,617 discarded. The
  quota blew a week ago, so "nothing in Sentry" has not been evidence of
  anything since. Worth raising the quota before the next incident.
- **`tables` holds 101,165 closed rows (72 MB)** and every status write fires
  eight triggers against it. A retention policy for closed tables would make
  the whole class of incident cheaper. Not changed here -- that is a data
  retention decision, and this repo's convention is that Dan sets those.
- 5 ghost seats remain on REGISTERING/COMPLETING tournaments. Harmless (no
  running event depends on them) and left alone rather than guessed at.

## Verified

- Engine stable, uptime climbing, no crash loop; 89 live MTT tables across 23
  tournaments.
- `smarter.poker/api/health` 200 in 0.22-0.54s.
- Dan's clubs query: 3 rows, 1.678 ms execution.
- Ghost seats on closed tables: 416 -> 5.
