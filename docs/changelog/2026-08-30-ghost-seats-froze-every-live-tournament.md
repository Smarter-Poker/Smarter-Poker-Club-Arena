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

| signal                            | before repair    | after repair     |
| --------------------------------- | ---------------- | ---------------- |
| `activeTables` (engine `/health`) | 0                | 70               |
| `activeTournaments`               | 1                | 23               |
| `tablesExpectedDealing`           | 0                | 20-22            |
| `discoveryStaleMs`                | 43,181 (stalled) | ~4,000 (healthy) |
| hands/minute                      | ~0.2             | 27 and climbing  |

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
because `fn_on_table_status_change` releases seats only on transitions _into_
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

## Follow-up, same session: the new alarm was crying wolf

Within four minutes of going live the repaired alarm logged five events, every
one with `seats_protected = 0`. Those are not incidents -- a tournament
consolidates as players bust, and an empty table closing under a RUNNING
tournament is table balancing working correctly.

An alarm that fires on routine consolidation is one nobody reads, which is
exactly how the original became worthless. `20260830193500` tightens it to fire
only when the close strands a SEATED field (`seats_protected > 0`), which is the
2026-08-30 shape. The seat-protection logic is untouched and still runs on every
close; only the logging is conditional. The five consolidation rows were
deleted, and the migration self-tests both directions.

## A note on hand rate after recovery

Hands recovered to a 38/min peak and then eased back. That is the tournaments
consolidating, not a relapse: 33 distinct tables dealt 176 hands in the ten
minutes after the repair, none of the 71 reopened tables were re-closed
(`reopened_then_reclosed = 0`), and 89 MTT tables remain live across 25 running
tournaments. The engine reports `stalledTableCount: 0` and a stable uptime,
so it is no longer restarting.

---

# Part two: it came back, and the real amplifier was a 300-loop

Within half an hour the platform went down again, harder. Ghost seats climbed
5 -> 176 -> 350, MTT tables fell 89 -> 13, and hands went to **zero**.

## What was actually driving it

`GameController._runHorsePipeline` — a **third** legacy background writer,
missed when `_snapshotInterval` and `_staleCheckInterval` were retired because
it reads like a read loop. Armed in the constructor with
`setInterval(..., 60000)`, it walks every table and every tournament calling
`fillTableWithHorses` / `autoRegisterHorses`. Both selected from `club_members`
embedding `profiles!inner (...)`.

That embed is **ambiguous**, verified against production:

```
club_members_profiles_fkey   FOREIGN KEY (user_id)  REFERENCES profiles(id)
club_members_agent_id_fkey   FOREIGN KEY (agent_id) REFERENCES profiles(id)
```

Two foreign keys to the same table, so PostgREST answers **HTTP 300
(PGRST203)** and returns nothing. Neither call site destructured `error`, so
the 300 became `data = null`, became "no horses with sufficient funds", left
`occupied < target` true forever, and the next tick retried. Because the class
is constructed by fifteen deployed API routes, every serverless invocation
armed another heartbeat.

Measured: **9,000-14,000 requests per minute to `/rest/v1/club_members`, every
one a 300**, for over ten minutes.

### The cascade, in the engine's own words

That saturated PostgREST until Cloudflare returned 520/521/522/525 for the
Supabase origin. The engine's leadership claims then went unanswerable:

> `[leadership] 3 claims unanswerable and no holder known — promoting ...`
> `promoted (claims unanswerable) but booted as a standby, so it has no
discovery loop or fleet — exiting so the supervisor restarts it as a real
leader.`

Clean `exit(0)`, Docker restarts it, **and every boot closed live tournament
tables underneath their seated fields**. Roughly every ten minutes. That is why
`hands` hit zero while 23 tournaments were still RUNNING.

**This pipeline never seated a single horse.** The query has been answering 300
for as long as the second foreign key has existed. Retiring it took away
nothing that was working — horse seeding is the Hetzner engine's job.

Fixed in World Hub PR #1033: timer set to `null` (the same treatment the other
two writers got), and both queries split into two unambiguous reads **with
their `error` restored**, so a broken embed can never again present as an empty
result.

## Recovery

|                      | during                 | after               |
| -------------------- | ---------------------- | ------------------- |
| club_members req/min | 9,000-14,000 (all 300) | ~0                  |
| origin 5xx/min       | up to 9,236            | 0                   |
| engine activeTables  | 0                      | 102                 |
| hands/min            | 0                      | 73 across 73 tables |
| ghost seats          | 350                    | 5                   |

Repairs: `20260830195830` (47 tables, 266 seats) and `20260830201200`
(12 tables).

## Also fixed

**`auto-close-tables` was closing live tournament tables.** It selected every
table in `('active','running','waiting')` with no `tournament_id` filter, so
anything older than `game_length_hours` (default 12h) was closed even
mid-tournament with seats occupied — and it closes with a bare status write
that never releases `table_seats`. The guard migration
`20260830180000` names this route by name as a close path it has to defend
against; World Hub PR #1035 fixes the caller so the guard is not load-bearing.

## STILL OPEN FOR DAN

1. **An engine BOOT strands live fields — every deploy costs players.**
   Isolated cleanly: a controlled restart at 20:00 reproduced it exactly, 50
   closes at 20:02-20:03 and nothing either side. All resulting ghosts were
   truly stranded (no other live seat in the same tournament), so players are
   LOST, not moved. The engine does not log these closes, so the exact
   statement was not identified inside the incident window. This repo deploys
   the engine on every push touching `server/**`, and today that was ~12 times.
   **This is the highest-value remaining fix.**

2. **Money-integrity alarms are firing in production** (from engine logs):
   - `SETTLEMENT CONSERVATION CRITICAL negative_balance` — club "Midway Union"
     holds `chip_treasury = -7,161.10`
   - `UNION TREASURY CONSERVATION BREACH` — `bbj_pool_conservation_drift`
     71,721.75; `rakeback_settler_lagging` 15.46 hours with 22,445 backlog rows;
     `lapsed_week_unclosed`
   - `fn_union_weekly_rakeback_close_all` failing with
     `EMERGENCY_PROFIT_DRIFT_LOCK`
     Left untouched deliberately: money paths are Dan's call (RULE 0) and
     CLAUDE.md 11.5 forbids casual probing of them.

3. **Sentry has been blind since 2026-08-23** — 46,362 events accepted that
   day, then zero (34,228 rate-limited, 722,617 discarded). "Nothing in Sentry"
   has not been evidence of anything for a week.

4. **`FeeReconciler` reports 68.2 chips of BBJ contribution on 146
   `rake_records` rows with NO `hand_id`**, reconcilable by neither the audit
   nor `fn_bbj_repair_unbanked`. Its own message says rising numbers mean
   `logHandHistory` is failing and returning a null id.

5. **The pre-push syntax gate degrades silently.** `scripts/hooks/
pre-push-js-safety.sh` CHECK 5 uses Babel when `@babel/parser` resolves and
   falls back to `node -c` when it does not — but `node -c` is JSX-blind, so in
   any checkout without `node_modules` (a fresh clone, a git worktree) it
   FALSE-POSITIVES on every JSX-bearing `.js` file and blocks the push. It cost
   a push here on `vendor/commander-shared/src/components/seo/SEOHead.js`,
   which is perfectly valid. The fallback should skip, not fail.

6. **Two SECURITY DEFINER views are readable by `anon`** —
   `v_shell_staleness_rate` and `v_shell_reload_lateness`. They expose only
   aggregate telemetry (day, counts, percentages, page age), no user data, so
   this is low risk and was left alone rather than breaking a status page that
   may read them anonymously.
