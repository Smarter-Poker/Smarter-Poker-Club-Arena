# Operation Table Stakes - current state and next actions (2026-09-07 18:15 UTC)

Read this before touching `fn_cash_cluster_tick`, `fn_cash_clusters_tick_all`,
`fn_cash_seat_move_execute`, `fn_cash_seat_change_plan`,
`fn_concurrent_game_load`, `get_club_home`, `fn_cash_game_lobby`,
`server/src/cluster/**`, `HorseFleetManager.ts`, `HorseSessionRotator.ts`,
`HorseGameLoad.ts`, `HorseTournamentCommitment.ts`, `EquityLoadGovernor.ts`,
`StableHand.ts`, `tournamentRecovery.ts` or the stale sweep in `GameServer.ts`.
The plan is `docs/OPORD-1.4-AMENDMENT.md` (section 18 is the lifecycle).

Every number was READ from production on 2026-09-07 between 16:00 and 18:15
UTC. The 2026-09-06 18:32 CDT version of this file is superseded in full.

**Do not trust this document. Run section 0 and report what disagrees.**

## THE STATE OF THE FEEDER, IN ONE PLACE (2026-09-07)

Gate 7 holds: **182 live cash tables, all 182 in a cluster, zero orphans.**
79 games live, 71 dormant. 572 seats occupied, 297 horses at cash.

Nine invariants over every live cluster table are clean: no table over
capacity, no player holding two chairs in one cluster, no roster row without a
chair, no chair without a roster row, no duplicate `main_index`, no gap in the
main sequence, no allowance stamped without a request, no pending move past its
own window, no unaccounted seat exit. 151 cluster law tests pass.

### Four defects found and fixed today, all applied to production

1. **`20260907164541` a seat change nobody got comes back.**
   `fn_cash_seat_change_plan` cancelled a request with note `left_table` when
   the player was no longer in the chair they asked from, and never returned
   `seat_change_used_at`. `fn_cash_seat_change_cancel` had done exactly that
   for the player's own cancel since day one ("-- The button comes back."). The
   usual reason the player is out of that chair is that the CLUSTER moved them.
   Two players were sitting in a game with the allowance spent and no move
   delivered; both restored.

2. **`20260907171507` an expired move says what it was waiting for.**
   Expiry was the only terminal state carrying no reason. It now says which of
   three things happened. **This is what found defect 3 within four minutes.**

3. **`20260907171945` a move waits as long as the table takes.**
   `cash_seat_moves.expires_at` defaulted to a flat `now() + 3 minutes`, and a
   hand was taking **226.7 seconds**. The deadline was shorter than the average
   hand, so every planned promotion expired and was re-planned and expired
   again - the whole explanation for feeders holding players while mains had
   open seats. The window is now four hand-lengths of the table's own cadence,
   floored at 3 and capped at 15 minutes; the column default is dropped so one
   authority owns it.

4. **`20260907173251` a disabled game still tells the truth about itself.**
   Section 7 gated the state write on `g.enabled`, and the selector then admits
   a game only if it is enabled OR holds a table - so a game disabled while
   live could never be corrected, and once its last table closed it stopped
   being ticked at all. Three games sat at `live` with no tables for 38 hours.

Plus `20260907171656`: a bare `WHEN OTHERS` in `fn_cash_seat_move_execute`
cancelled the player's move for `40P01`/`55P03`/`40001`, all of which mean "try
again", and the planner's 60-second back-off then charged the player for a
database hiccup. Those three now leave the move pending.

### What the fixes actually bought, measured honestly

|               | before                 | after                 |
| ------------- | ---------------------- | --------------------- |
| moves expired | 80 of 761 = **10.51%** | 63 of 963 = **6.54%** |
| moves done    | 671 in the hour        | 892 since 17:19 UTC   |

**An earlier reading of "0.00% expired" was wrong** and is corrected here: it
was taken twenty minutes after the change, before any post-fix move had reached
its now-longer deadline. The real improvement is a 38% cut, not an elimination.

**61 of the 63 remaining expiries still say `engine_did_not_execute_before_expiry`.**

## THE ONE THING LEFT, AND IT IS NOT A CLUSTER BUG

A hand takes **145 seconds** across live cluster tables (down from 226.7 earlier
today as other engine work landed; a healthy online table deals one every
40-60). The `EquityLoadGovernor` is pinned at its **0.2 floor** with event-loop
p50 of 350-900 ms and `throttledForS` in the hundreds. It is shedding as hard
as it can and the core is still out of headroom.

That is why 6.5% of moves still miss their boundary, and it is capacity, not
wiring. The wiring was checked: `governedIterations` is applied at the one choke
point, the banded-Omaha floor that used to outrank the governor was fixed today,
the run-out path already uses `EquityWorkerPool`, and the only ungoverned
`monteCarloEquity` call is a last-resort fallback inside two nested catches.

**The remedy is architectural** - move horse Monte Carlo off the main thread, or
run fewer tables per process - and it is the next real piece of work. Do not
look for another wiring bug here; there isn't one.

## 0. The audit board

```sql
with t as (select fn_cash_stake_band(g.bb) band, tb.id,
  (select count(*) from table_seats ts where ts.table_id=tb.id and ts.left_at is null) seated
  from cash_games g join tables tb on tb.cluster_id=g.id and tb.lifecycle<>'closed' and tb.status<>'closed' where g.enabled),
s as (select ts.user_id, count(*) n from table_seats ts join tables tb on tb.id=ts.table_id join profiles p on p.id=ts.user_id
  where ts.left_at is null and tb.cluster_id is not null and coalesce(p.is_horse,false) group by 1)
select (select count(*) from t) tables, (select sum(seated) from t) seated,
 (select json_build_object('opened',count(*) filter (where kind='feeder_opened'),'live',count(*) filter (where kind='feeder_live'),'abandoned',count(*) filter (where kind='feeder_abandoned')) from cash_cluster_events where at > now()-interval '1 hour') feeders_1h,
 (select count(*) from cash_cluster_events where kind='controller_tick_error' and at > now()-interval '1 hour') tick_err_1h,
 (select count(*) from s) horses_at_cash, (select round(avg(n),2) from s) tables_per_horse,
 (select json_object_agg(n,c) from (select n,count(*) c from s group by n) y) by_tables,
 (select count(*) from profiles p where coalesce(is_horse,false) and fn_concurrent_game_load(p.id)>=4) at_cap,
 (select count(*) from tournaments where status='COMPLETING') completing,
 (select engine_version from engine_leader) engine;
```

Then `git fetch origin && git log --oneline -40 origin/main`, and:

```
ENGINE_MONITORING_SSH=root@$HETZNER_SERVER_IP node scripts/ci/check-alert-rules-match.mjs
PGPASSWORD=... SUPABASE_DB_URL='host=... user=postgres dbname=postgres sslmode=require' \
  PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql node scripts/ci/check-realtime-publication.mjs
```

## 1. The four ceilings worked

The morning's measurement, and the same board this evening with #3327 in the
engine (`engine_leader` = `b44f392e`, confirmed by `git merge-base`):

|                                   | 09:29 CDT                          | 18:32 CDT                             |
| --------------------------------- | ---------------------------------- | ------------------------------------- |
| Open cluster tables               | 121                                | **170**                               |
| Seats filled                      | 282                                | **641**                               |
| Horses seated at cash             | 175                                | **348**                               |
| Tables per seated horse           | 1.66                               | **1.84**                              |
| Horses at 4 tables                | 2                                  | **22**                                |
| Feeders, last hour                | 25 opened / 14 live / 11 abandoned | **20 opened / 19 live / 1 abandoned** |
| Controller tick errors, last hour | 683 (a 65-minute outage)           | 2                                     |

Feeder fill went from 56% to 95%. The floor is carrying 2.3x the players it
was this morning on the same hardware.

`at_cap` rose from 13 to 88, and that is the system working: horses now hold
more real seats, so more of them legitimately reach the four-game limit. It is
worth watching only if it climbs while `tables_per_horse` stops climbing.

## 2. What merged today (18:00 CDT window)

| PR        | What                                                                                         |
| --------- | -------------------------------------------------------------------------------------------- |
| #3327     | The four ceilings: booking window, `max_tables` 4, exposure multiple 4, leave-for-tournament |
| #3332     | The monitoring deploy actually deploys                                                       |
| #3333     | A pass commits what it did (tick budget + lock bound)                                        |
| #3334     | A hand torn down mid-deal is not dealt                                                       |
| #3340     | A finish that deadlocks is retried; an overstayed manager cannot hide a row                  |
| #3345     | The suspended heads-up settled by chip-proportional deal                                     |
| #3346     | The 10:45 handoff                                                                            |
| #3360     | The core that limits everything is a number                                                  |
| #3372     | One definition of a game's players and tables                                                |
| #3375     | A subscription that can never fire                                                           |
| **#3350** | **OPEN** - a sweep never makes a row the recovery refuses                                    |
| **#3379** | **OPEN** - the seat guard says what it actually does                                         |
| **#3380** | **OPEN** - a latency budget that measures the code, not the runner                           |

Migrations applied and recorded under their own version today:
`20260906144448`, `20260906150956`, `20260906153943`, `20260906163151`,
`20260906232223`.

## 3. Traps this session paid for

- **`docker logs` holds only the CURRENT container.** The engine is recreated
  every hour at :55 and on every `server/**` merge, so "zero errors in three
  hours" often means "zero since the last cutover". Check `docker ps` uptime
  before concluding anything from an absence.
- **A tree you read is a snapshot with a timestamp.** `main` takes twenty-odd
  merges a day. I based a migration on a `TablePage.tsx` I had read earlier;
  the subscription in it had been deliberately deleted at 10:53 CDT, and the
  migration would have reverted the largest realtime optimisation on the
  project (see `2026-09-06-a-subscription-that-can-never-fire.md`). Re-read
  the file from the current tree before acting on it, not your memory of it.
- **`pg_stat_statements.track = top`.** Statements inside a function are
  invisible, so a slow trigger or a slow RPC body cannot be attributed from
  this view. Time it yourself in a rolled-back `DO` block.
- **A post-restart transient is not a defect.** The cluster pass reads ~27 s
  in the minutes after a cutover and 0.86 s at steady state. I nearly "fixed"
  the transient. Take quantiles over a 5-minute window, not a single
  `/health` sample.
- **`fn_caller_is_engine()` trusts a session with no JWT** - psql, pg*cron, a
  migration. A behavioural probe of a money guard from psql is \_supposed* to
  pass; that is not the guard failing.
- Em dashes in a file you touch fail `check-ui-text` even when they were
  already there. Fix them (fix-first); `--fix` does it.

## 4. What is left, ranked

### 1. `hand_history` inserts: the largest single cost in the database

93 hours of database time across 2.58M inserts, at 110 ms and 160 ms mean for
the two column-shapes. 526,607 inserts in 24 hours. The table is 8.8 GB over
3.46M rows.

**Retention is NOT the problem** - only 1,773 rows are older than seven days
and 82 of those are horse-only, so `sp_prune_hand_history` is keeping up
exactly as configured. The table is big because the floor now deals 526k hands
a day against 221k on 2026-08-27; that growth is the fleet work succeeding.

The cost is structural: **six `FOR EACH ROW` AFTER INSERT triggers** (club
member stats, fold stats, position stats, live stats, daily missions, and the
bomb-pot constraint trigger) plus **eleven indexes**, of which
`idx_hand_history_players_gin` is 304 MB and has served 1,425 scans, and
`uq_hand_history_global_hand_number` is 112 MB with **zero** scans (it is a
UNIQUE constraint, so it is doing work even unread - removing it is a
correctness decision, not a performance one).

**Do not attack this without measurement, and the measurement is not free.**
`track = top` hides the trigger cost, and `ALTER TABLE ... DISABLE TRIGGER`
takes ACCESS EXCLUSIVE on the hottest table on the platform - the same hazard
CLAUDE.md records for `public.tables`. The safe path, in order: enable
`pg_stat_statements.track = all` in a low-traffic window (Dan's call - it is
production config), attribute the 110 ms, then convert the stats triggers to
`FOR EACH STATEMENT` with transition tables. **That pattern already exists in
this database** - `trg_daily_missions_tournament_registered` uses
`REFERENCING OLD TABLE / NEW TABLE ... FOR EACH STATEMENT` - so it is a port,
not an invention.

### 2. The realtime publication: 111 tables, the second largest cost

`realtime.apply_rls` is roughly 62 hours of database time, 833k calls at
270 ms mean. `scripts/ci/check-realtime-publication.mjs` (new, #3375) now
fails on any subscription that can never fire and lists the rest.

Current reading: 49 tables subscribed by this repo, 111 published, 40 on the
baseline as deliberate, **zero that cannot fire**. 73 published tables this
repo does not subscribe to - **that is not a delete list**, the World Hub
subscribes to many of them. The worked example of doing this right is #3032:
move hole cards onto the engine socket first, prove nobody is listening, then
drop the table. That single removal was 44% of all WAL decoding.

### 3. One core, now visible

`poker_event_loop_delay_p50_ms`, `_p99_ms` and `poker_equity_governor_scale`
are on `/metrics` since #3360, with three break-guarded alerts whose
thresholds are the governor's own table (40 ms out of headroom, 300 ms floor).
Watch the p50 across a :55 cutover: a spike while the fleet is adopted and a
return under 40 ms is healthy. If it does not return, the boot itself is the
load.

### 4. Smaller, unowned

- **Migration ledger drift**: the MCP `apply_migration` stamps its own
  timestamp rather than the file's, which is the whole mechanism behind ~130
  "recorded with no file" entries. Everything applied today used psql under
  the file's own version. The durable fix is a rule, not another mirror pass.
- **Zero humans have sat at a cash cluster table in 24 hours.** The floor is
  horses playing horses. Not a defect; it decides what is worth optimising
  next, and it is Dan's call.
- **52 of 170 open cluster tables sit empty** as dormant anchors. Believed by
  design; nobody has confirmed it is the intended shape at this table count.
- `fn_concurrent_game_load` counts a booking from 60 minutes before the start.
  Whether that window is right is a product decision, not a defect.

## 5. Laws that bit today

- **10.11 (fix at the root)** is why the three-day heads-up produced #3350
  rather than only a hand settlement: the sweep that manufactured the
  unrecoverable row is the defect, the settlement was the damage.
- **10.86 (a signal that answers when it does not know)** is the through-line
  of the whole day: a governor sampled only when a horse was thinking, a
  metric declared and never observed, a subscription that joins and receives
  nothing, a latency budget measuring the runner.
- **5.8** twice: `ChipContinuity`'s door count and `theSeatGuardIsArmed`'s
  filename pin both moved with their mechanisms, in the same commit.
- **10.82**: a follow-up commit goes on a NEW branch off current `main`, and a
  merged branch refuses the push.
