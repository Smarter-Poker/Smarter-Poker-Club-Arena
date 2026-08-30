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

---

# Part three: closing out the open items

## The boot-strand bug is now conditional, instrumented, and quiet

Two controlled restarts settled what code-reading could not:

| restart   | database state                        | live-tournament closes            |
| --------- | ------------------------------------- | --------------------------------- |
| 20:00 UTC | still recovering, PostgREST saturated | **50** (28 at 20:02, 22 at 20:03) |
| 20:20 UTC | healthy                               | **0**                             |

So a boot is not destructive by itself — it is destructive when a boot-time read
fails. That is why every candidate path reads as correctly guarded:

- `GameServer.ts:1698/1711` — cash only (`.is('tournament_id', null)`)
- `GameServer.ts:1984` — orphan sweep, COMPLETED/CANCELLED only, and its
  swallowed errors fail CLOSED (an empty set closes nothing)
- `GameServer.ts:1908-1966` — stale sweep: >12h only, assumes active on error,
  and settles through COMPLETING rather than cancelling (Dan 2026-08-19,
  "TOURNAMENTS RUN. THEY DO NOT CANCEL.")
- `TournamentManager.ts:204` — table break, closes only after ALL players moved
- `fn_table_lifecycle_pass` — excludes tournament tables throughout

Rather than guess, `20260830202000` makes the alarm record **who**:
`application_name`, `db_role`, `session_role`, `client_addr` and `txid`.
`ca_seat_stack_exits` already does this for seat exits; the table-close alarm now
matches it. The next occurrence names its own culprit:

```sql
SELECT detail::jsonb->>'application_name', detail::jsonb->>'db_role',
       detail::jsonb->>'client_addr', count(DISTINCT detail::jsonb->>'txid')
  FROM engine_recovery_events
 WHERE event = 'table_closed_under_live_tournament'
 GROUP BY 1,2,3;
```

`txid` is the useful one: it separates "one statement hit 50 rows" from "50
statements in a loop", i.e. bulk SQL versus an application for-loop.

**Residual ghosts are benign.** Of the 5 that remain, only one maps to a roster
row at all — and that player is the tournament WINNER, whose seat was simply
never released. No live player is stranded.

## The BBJ "unlinkable rake" alarm is mostly a false alarm

`FeeReconciler` warns that `rake_records` rows with no `hand_id` mean
`logHandHistory` is failing. Measured over 10 hours, the overwhelming majority
of those rows are **legitimately hand-less**: `fn_register_horse_for_tournament`,
`process_tournament_rebuy`, `fn_spin_settle_game`, `fn_award_satellite_seat` —
tournament entry and settlement fees, which have no hand by definition. The
alarm counts them and misreports the cause.

The genuine subset is small and precisely one source:

```
atomic_distribute_rake | cash | 150 rows | 70.00 BBJ chips | hand_id NULL
```

Mechanism: `ServerTableEngineSettlement` passes `p_hand_id: v_handHistoryId`,
which is null when the inline `hand_history` insert failed. That is already
designed for — the row goes to `enqueueHandHistory()` and `relinkRakeRecord()`
repairs the link when the queue drains, and `GameServer.ts:646` drains the queue
on shutdown. But `pendingHands` is an **in-memory array**, so the repair only
survives if the drain can reach the database. During a total outage neither the
inline insert nor the shutdown drain can, and the link is lost for good.

So the design is sound and the residue is bounded by outages, not by a routine
defect. **Not changed.** Making the queue durable means writing it somewhere
during the exact incident where the database is unreachable — a real design
decision, and 70 chips does not justify making it unilaterally. Recorded here so
the next person starts from the measurement rather than the misleading alarm
text. Worth fixing the alarm's wording so it stops blaming `logHandHistory` for
tournament entry fees.

## Fixed: the pre-push gate blocked valid JSX

`scripts/hooks/pre-push-js-safety.sh` CHECK 5 falls back to `node -c` when
`@babel/parser` does not resolve — which is every `git worktree` and every fresh
clone, because a worktree shares `.git` but not `node_modules`. `node -c` is
JSX-blind: it does not merely miss broken JSX, it REJECTS VALID JSX. It blocked a
push here on `vendor/commander-shared/src/components/seo/SEOHead.js`, a valid
file unrelated to the change.

That matters more than it looks: the documented escape is `--no-verify`, which
skips every OTHER check in the file, including the `.single()`, auth-pattern and
conflict-marker guards. A gate that blocks correct code trains people to disable
all the gates.

World Hub PR #1036: in the no-Babel branch only, JSX-shaped files are SKIPPED and
reported as unverified instead of failed, with a message saying coverage is
reduced and how to restore it. Verified both ways, and the PR itself was pushed
from a worktree with no `node_modules` — the exact condition that used to fail.

## The money alarms, measured (NOT touched — Dan's call, RULE 0 / CLAUDE.md 11.5)

These are **not** caused by today's outage. They predate it and are trending.

**1. A club treasury is going more negative every day.** From
`ledger_reconcile_log`, `entity_type = 'negative_balance'`, severity critical:

| run_date   | drift    |
| ---------- | -------- |
| 2026-08-27 | 1,202.80 |
| 2026-08-28 | 4,846.10 |
| 2026-08-29 | 7,161.10 |

Club "Midway Union" currently holds `chip_treasury = -7,161.10`. A club treasury
cannot legitimately go negative — something is paying out of it without a
balance check, and it is compounding at roughly 2,300-3,600 a day. **This is the
one I would look at first.**

**2. BBJ pool conservation is off by 74k.** `fn_bbj_conservation_check()`:

```
inflow  376,901.78
outflow 184,979.01
balances 117,628.43
gap      74,294.34   (tolerance 1)
baseline_gap 2,572.59  ->  drift_from_baseline 71,721.75
```

**3. `club_treasury` drift is critical and wildly unstable** across runs:
-110,377.78 (27th), 5,159,494.35 (28th), 12,425,392.32 (29th). Either the check
or the accumulator is wrong; a real economy does not move like that.

**4. The rakeback settler is behind but CATCHING UP** — not stuck.
`fn_settler_lag_check()`: cursor `2026-08-30T05:09:37Z`, lag 15.32h, backlog
21,583 rows, last save 6 minutes ago. The backlog fell 22,445 -> 21,583 in about
ten minutes, so it is draining at roughly 860 rows/10min (~4h to clear). Most of
the lag was built during the outage. No action needed unless it stops falling.

**5. `fn_union_weekly_rakeback_close_all` is failing** with
`EMERGENCY_PROFIT_DRIFT_LOCK` — a deliberate guard refusing to settle while the
drift above is unresolved. It is doing its job; it unblocks when 1-3 do.

## Also observed, not changed

- **Sentry has been blind since 2026-08-23**: 46,362 events accepted that day,
  then zero — 34,228 rate-limited, 722,617 discarded by the SDK. This is a quota
  matter (billing), which is why it is not fixed here. Every "nothing in Sentry"
  conclusion for the past week has been a broken pipe, not evidence.
- **Two SECURITY DEFINER views are readable by `anon`**:
  `v_shell_staleness_rate`, `v_shell_reload_lateness`. Both expose ONLY aggregate
  telemetry (day, counts, percentages, worst page age) — no user data, no
  balances. Deliberately left alone: revoking anon SELECT is a one-line change
  but would break any unauthenticated status page reading them, and the exposure
  does not justify that risk without knowing the consumer.
- Supabase security advisors: 855 lints, of which 3 are ERROR — the two views
  above, plus `spatial_ref_sys` (a PostGIS-owned table that cannot take RLS and
  is flagged on every PostGIS project). The 642 WARN
  `authenticated_security_definer_function_executable` are this platform's RPC
  design, not defects.
