# An opening feeder is filled before it is abandoned

2026-09-05, measured on production at 20:45 CDT.

## What was happening

A must-move game that is exactly full opens a feeder (OPORD 1.4 section 18.3).
No horse ever sat on it. The controller abandoned it at three minutes, waited
two, and the game opened another one. All night.

Last hour before the fix, from `cash_cluster_events`:

| event              | count |
| ------------------ | ----- |
| `feeder_opened`    | 22    |
| `feeder_live`      | 4     |
| `feeder_abandoned` | 20    |

Worst two games:

| game                  | abandons         | seats           |
| --------------------- | ---------------- | --------------- |
| NLH 0.05/0.10 Classic | 11 in 90 minutes | 18 seated on 18 |
| PLO4 0.50/1 Classic   | 8                | 6 on 6          |

## What the log said

The diagnostic line added earlier the same day named it exactly:

```
[HorseFleet] opening feeder "NLH 0.05/0.10 Classic Feeder": candidates 14,
  sittable 9, wanted 2, empty seats 2, selected 2, seated 0,
  skipped {aggregate_exposure=5}
[HorseFleet] opening feeder "PLO4 0.50/1 Classic Feeder": candidates 14,
  sittable 7, wanted 6, empty seats 6, selected 2, seated 0,
  skipped {aggregate_exposure=7}
```

`selected N, seated 0` every time. The fleet was choosing horses and the DOOR
was refusing the buy-in, 15 times in 25 minutes:

```
[HorseFleet.atomic_table_buyin_failed_for_horse]
  message: 'TABLE_CLOSING: this table is closed and takes no new players
            - the game will seat you at its next open table'
  code: '23514'
```

`fn_refuse_seat_on_closed_cluster_table` raises that when the table's
`lifecycle` is `breaking` or `closed`, and the message interpolates the
lifecycle: those tables were already CLOSED by the time the fleet reached
them.

## Why

`HorseFleetManager.seedAllTables` reads the whole open-table list ONCE at the
top of a cycle (`HorseFleet.openTables`, via `fetchAllRows`). The cycle then
takes 57 to 118 seconds - its own line:

```
Seeding cycle took 118s and 3 30s tick(s) were dropped while it ran
```

The controller, meanwhile, abandoned an opening feeder that was still empty
after three minutes and refused to open another for two. So the fleet was
routinely committing horses to a snapshot older than the table it was seating
into, and the feeder it was filling had already been closed by the tick that
ran while the cycle was walking.

Both ends of that were wrong, so both were fixed.

## Half 1: the fleet does not seat into a stale row

`server/src/services/HorseStaleTable.ts` (new) is the decision, pure.
`server/src/services/HorseFleetManager.ts` is the wiring.

Immediately before the first `seatHorse` of the cycle - after all the
candidate and sit-verdict work, as late as the loop allows - the fleet issues
ONE batched read of `id, lifecycle, status` for the cluster tables the cycle
is about to seat, and skips any table that is no longer seatable
(`lifecycle` not in `live`/`opening`, or `status` not in
`waiting`/`running`/`active`).

The read is lazy and latched: a cycle that seats nobody asks nothing, and a
cycle that seats asks once. Not one query per table, and never one per horse.

Because the skip is a `continue` BEFORE any seat is committed, the horses that
table had selected are still unspent - their exposure, their table count and
the cycle's seat budget are untouched - so the next table in the same loop can
take them. That is the point: a wasted buy-in refusal becomes a horse that is
still available for a table that IS open.

It FAILS OPEN. If the re-read errors or comes back short, the cycle seats
exactly as it did before, and says so:

```
[HorseFleet] door re-read incomplete - seating this cycle on the top-of-cycle
snapshot (fail open); a closed table may refuse a buy-in.
```

That is the doctrine every other loader in the file follows, and the
disabled-games loader states the reason plainest: failing closed there would
empty the floor on one bad read.

The skips are counted and reported once per cycle, on the log line and on the
beat (`stale_tables_skipped`, `stale_door_read_failed`):

```
[HorseFleet] N table(s) went away between the read and the seat (stale snapshot)
```

## Half 2: the window matches the measured cycle

Migration `20260906015029_an_opening_feeder_is_filled_before_it_is_abandoned.sql`
re-declares `fn_cash_cluster_tick` WHOLE from the live source, in one
transaction, with a `DO $guard$` asserting the live body md5 before
(`5433f92b25cb592c5d9de007b4a94110`) and after
(`992399462c97fcde1a30494691ecdb99`).

The opening-feeder abandon window goes from **3 minutes to 6**. Three minutes
is shorter than one worst-case fleet cycle (118 s) plus a full 30-second tick
interval, which is 148 s, so a feeder could be abandoned before the fleet's
next cycle ever reached it. Six minutes is that with a full cycle of margin.

Deliberately NOT changed:

- the 2-minute rest after an abandon before the game may open another;
- the 60-second opening hold;
- the waitlist notify expiry, which is the OTHER `interval '3 minutes'` in the
  same function and answers a different question.

## The probe

Run rolled back against production before applying (CLAUDE.md 11.5). It builds
two identical fixture must-move games, each with a Main 1 and two empty
opening feeders (one opened 4 minutes ago, one 7), ticks the first with the
function as it stood live, applies the migration, and ticks the second. Same
fixture on both sides, so the window is proved by what changed between them
rather than by an assertion about a constant. Helper in `pg_temp`; no
`table_seats` row created and no chips moved.

Result (`PROBE_EXIT:0`):

```
 phase  | feeder4_lifecycle | feeder7_lifecycle | feeder4_abandoned | feeder7_abandoned
--------+-------------------+-------------------+-------------------+-------------------
 BEFORE | closed            | closed            | t                 | t

 phase | feeder4_lifecycle | feeder7_lifecycle | feeder4_abandoned | feeder7_abandoned
-------+-------------------+-------------------+-------------------+-------------------
 AFTER | opening           | closed            | f                 | t

NOTICE:  PROBE PASSED: live abandons 4m and 7m; new abandons 7m only and
         leaves the 4m feeder opening.
ROLLBACK
```

The BEFORE row is the defect reproduced: the live function closed a feeder
that was four minutes old, which is inside a single fleet cycle.

## Applied

Applied with psql at 2026-09-05 21:03 CDT. Both guards passed - the pre-guard
found `5433f92b25cb592c5d9de007b4a94110` and the post-guard
`992399462c97fcde1a30494691ecdb99`, which is what the live function reads now.
Recorded in `supabase_migrations.schema_migrations` as version
`20260906015029` AFTER the apply returned `COMMIT`, never before: a migration
earlier the same day deadlocked against the tick, rolled back whole, and left
a false stamp that had to be deleted.

## How to verify

**The SQL half is live now.** Over the next hour, the ratio should move:

```sql
select kind, count(*)
  from public.cash_cluster_events
 where at > now() - interval '1 hour'
   and kind in ('feeder_opened','feeder_live','feeder_abandoned')
 group by kind;
```

`feeder_live / feeder_opened` was 4/22 (18%). It should climb, and
`feeder_abandoned` should fall well below `feeder_opened`.

**The TypeScript half needs the next :55 cutover** (CLAUDE.md 13) before it is
running. After it is, the TABLE_CLOSING count in the engine log should go to
zero:

```
grep -c 'TABLE_CLOSING' <engine log>   # was 15 in 25 minutes
```

and any residual staleness becomes one honest line per cycle:

```
[HorseFleet] N table(s) went away between the read and the seat (stale snapshot)
```

A non-zero N there is not a regression - it is the fleet correctly declining to
spend a horse on a door that shut, which is exactly what it used to do wrong.

## Tests

`server/src/services/HorseStaleTable.test.ts` - 18 pins: the decision (live and
opening seat; closed and breaking skip; a status-only close skips; a row absent
from a complete read is gone; an errored or short read fails open), the wiring
(one batched read, latched, placed before the first `seatHorse` so the horses
stay available; the paged read; the fail-open path; the once-per-cycle
reporting), and the window (6 minutes in the feeder block, the 2-minute rest
and 60-second hold untouched, the waitlist's own 3 minutes untouched, both md5
guards present).

`server/src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts` - the
feeder-abandon pin MOVED in the same commit, from migration 20260905050000 (no
longer the live definition of that block) to 20260906015029, and now asserts
six minutes with the measurement written beside it. Every other tick assertion
in that file still reads the old migration, where the text it pins is
unchanged.
