# Stats Page Programme, Phase 1: the witness audit and the health readout

Branch `fix/stats-phase-1-positions`. Programme:
`docs/STATS-PAGE-PROGRAMME-2026-09-03.md` (section 8, phase 1). Database
changes applied to production 2026-09-04 08:56 UTC after a rolled-back probe
of the whole migration (CLAUDE.md 11.5); engine changes deploy with the merge.

## The record was wrong, and this corrects it

The 2026-09-03 changelog left one data defect open: "~3% of hands carry a
`button_seat` that disagrees with the action order", with the Positions tab
and the positional radar listed as wrong on those hands.

Measured properly on 2026-09-04 against 48,362 hands from the previous 90
minutes: 47,871 carry blind-post rows, and on every one of them the stored
`button_seat` is the seat before the small-blind poster in seat order (the
poster itself heads-up). Zero disagreements. The "3%" was the measuring
stick, not the engine: a first-to-act heuristic that did not know about
straddles (533 of the 551 hands it flagged in an hour had one) or about a
small blind who is all-in from the post and never gets a turn (the other 18).

The derived `showdown` flag was checked the same way against the engine's
own `hand_history.showdown` roster: 27,418 player-hands, 3,445 showdowns,
zero disagreements either way.

So there is no position fix. Programme item 1.1 is closed as measured, and
what ships instead is the thing that would have caught a real one.

## What shipped

### 1. The facts function is 10x faster on a range, byte-identical

`ca_hand_player_facts(p_from, p_to, p_user, p_hand_id)` grew its fourth
argument on 2026-09-03 so the live trigger could ask for one hand, with the
access path chosen by an OR on that parameter. The planner cannot see past a
parameter inside an OR: four minutes of hands (4,400 player-hands) took 14 to
27 s through the function and 0.27 s as a standalone statement. The forward
roll and the money repair both use the range form, which is why
`ca_roll_hand_stats_forward` averaged 54 s per call.

Now one body, written once in the migration and instantiated twice by a DO
block: `ca_hand_player_facts_range(p_from, p_to, p_user)` and
`ca_hand_player_facts_one(p_hand_id, p_user)`. The four-argument function is
a plpgsql dispatcher so every caller keeps working. The trigger calls `_one`
directly (1.1 to 1.4 ms per hand warm; 9 ms through the dispatcher's RETURN
QUERY). Two further rewrites inside the body: the stored-pot arbitration
summed three CTEs with a correlated subquery per hand (quadratic in the
window) and now groups once and joins; the never-acted blind seat used NOT
EXISTS against a CTE and now anti-joins.

Proved before apply, in a rolled-back transaction: 2,704 range rows and 756
single-hand rows compared with EXCEPT in both directions against the live
function, zero differences; the range form 0.68 s for four minutes of hands.

### 2. `ca_stats_witness_audit(p_minutes, p_grace_seconds)`

Every 15 minutes (`ca-stats-witness-audit-15m`, at :09 :24 :39 :54, advisory
locked, 120 s statement timeout) over the previous ten minutes less a 90 s
write grace: `button_disagree` (stored button vs the small-blind poster),
`showdown_disagree` (derived flag vs the engine roster), `hands_without_stat`
(the live trigger missed a hand), `human_without_facts` (the engine's
settlement writer missed a human seat, so the money fell back to
reconstruction). One row per run in `ca_stats_witness_audit_log`, 30 days
kept. Zero is the only healthy number. The probe run: 5,963 hands, 17,537
player-hands, 0 / 0 / 0 / 0, 10.4 s.

The anti-join it needs, `idx_ca_hand_player_stat_hand_id`, ships first in its
own file (CREATE INDEX CONCURRENTLY cannot run in a transaction; the stat
table is written inside every hand insert and must not be locked). Built in
5 s on 1.0M rows.

### 3. `ca_stats_health()` and the engine's `StatsHealthMonitor`

A 150 ms read: index lag, hands from the last 3.5 minutes with no stat row,
the repair cursor, the last audit. The engine polls it every minute
(`server/src/observability/StatsHealthMonitor.ts`), publishes it on
`/health` as `stats` and on `/metrics` as `poker_stats_index_lag_seconds`,
`poker_stats_recent_hands_without_stat`, `poker_stats_witness_disagreements`,
`poker_stats_human_hands_without_facts`, `poker_stats_money_repair_done`,
`poker_stats_health_age_seconds`, and raises through the same path as clock
skew: `ClubArenaStatsIndexLag` at 30 minutes (suppressed while a maintenance
break is on, CLAUDE.md 13.6), `ClubArenaStatsTriggerGap` on any recent hand
without a stat row, `ClubArenaStatsWitnessDisagree` on any non-zero audit
count. Each resolves itself on the next healthy read. A failed read keeps the
last snapshot, marks it `stale`, and never throws.

The hand index fell 17 hours behind on 2026-09-03 and nothing said so. The
roller lives in pg_cron and the Open Claw route
(`/api/cron/club-stats-maintenance`, every 15 minutes), neither of which has
an alert path; the engine does, so the engine now looks.

Four Prometheus rules in `infra/monitoring/engine-freeze-rules.yml`
(`stats-pipeline` group) are the second, independent path: a broken alert
receiver cannot hide a lagging index. The clock-driven two carry the break
guard. Monitoring config reaches cron-01 through `infra/monitoring/deploy.sh`
(re-run on the host, idempotent; `infra/monitoring/README.md`), not through
a workflow, so these rules load at the next deploy.sh run; the engine-side
alerts above deploy with the engine and need nothing.

### 4. Every seat is indexed (found in the verification pass)

Verifying the audit against production turned up a horses-are-players
defect that predates this phase (CLAUDE.md 10.5). In two hours, 57 players
played 9,750 hands that the trigger wrote to `ca_hand_player_stat` and
received zero rows in `ca_hand_player_idx`. All 57 are horses with synthetic
ids (`00000000-0000-0000-0000-000000000003`, `face0000-...`): valid uuid
shapes, present in `profiles`, but without the RFC 4122 version nibble and
variant bits the index writers' regex demanded. The stat writer used the
plain shape and counted them; the index writers did not. For those players
"Hands Played" read 0, the notable-hands list was empty, and the live
subscription never fired. About 0.35% of hands carried at least one such
seat.

`20260904092705_stats_phase_1_every_seat_is_indexed.sql`, applied 09:31 UTC
after a rolled-back probe: both index writers (`trg_ca_stats_live_from_hand`
part (a), `ca_refresh_hand_player_index`) accept the same uuid shape the stat
writer accepts; `ca_index_every_seat()` walks retained `hand_history` forward
from a cursor and inserts the missing rows for exactly those ids, one minute
at a time under a 50 s deadline, and unschedules its own cron when it reaches
the present; the witness audit gains `player_hands_without_idx` (every
uuid-shaped seat must have an index row) and the engine treats it as a
witness disagreement with its own gauge, `poker_stats_player_hands_without_idx`.

Measured after apply, per minute: 09:28 99 synthetic seats / 99 without an
index row, 09:29 109 / 109, 09:30 99 / 84 (the apply landed mid-minute),
09:31 99 / 0, 09:32 91 / 0. The probe of the audit before the fix reported
`player_hands_without_idx: 1050` for a ten-minute window, which is the
tripwire proving it would have caught this on its own.

### 5. The retention law

`tests/the-stats-a-player-reads-survive-the-hand-prune.law.test.ts`
(registered in `docs/LAWS.md`): the newest `sp_prune_hand_history` never
names `ca_hand_player_stat`, `ca_hand_facts` or `ca_hand_transfers` (it may
prune the `ca_hand_player_idx` pointer table); `ca_prune_hand_player_stat`
keeps at least the page's 750-hand window per player; the forward roll
prunes by per-player count, never by hand age. The programme document called
the stat table "durable per player per hand" without saying what bounded it;
it is the most recent 1,000 hands per player, and this pins that nobody
tightens it below the page's window or ages it out.

## Verified live after apply

- 947 hands written in the seven minutes after apply, 0 without a stat row
  (the re-pointed trigger).
- `ca_stats_health()` from production: `indexLagSeconds` 600.5 (one
  maintenance break, as designed), `recentHandsWithoutStat` 0, repair cursor
  advancing.
- Money repair: cursor at 2026-08-30 02:54, 584,000 hands seen, 263 rows
  changed, not done. Its pg_cron runs took 85 to 150 s each before the facts
  split and 4 to 17 s after it (09:00 to 09:15 UTC, same 4,000-hand batch),
  so the throttle that protected the hand write is no longer needed: moved
  to every 2 minutes, 6,000 hands, 100 s timeout (`cron.alter_job` on job
  260). It reaches its ceiling of 2026-09-03 19:28 in about six hours.
- The three stats migrations applied by psql (20260903190000 and both phase 1
  files) are now recorded in `supabase_migrations.schema_migrations` with
  their statements, the same way an MCP apply records them, so the
  every-applied-migration-has-a-file check can see them.
- Verified 24 hours of human hands (18, `has_human` populated): every human
  seat has its `ca_hand_facts` row and its stat row, so the audit's
  `human_without_facts` is zero for a reason and not for want of humans.

## Tests

- `server/src/observability/StatsHealthMonitor.test.ts` (15): parser pinned
  to the live jsonb shape, every alert edge, the break suppression, the stale
  read, the gauges, timers, overlap, the missing-index disagreement.
- `tests/stats-phase-1-witness-audit.test.ts` (21): the migrations, the
  trigger, the grants, the cron, the engine wiring, the rules, the manifest
  fragment.
- `tests/the-stats-a-player-reads-survive-the-hand-prune.law.test.ts` (7).

## Still open (phase 2 onward, per the programme)

Programme 1.2 (re-measure the hand write once the repair is done), 1.4 (EV
coverage; `human_without_facts` in the audit is the first half of it), 1.5
(tournament finishes live), 1.6 (session rule), 1.7 (field percentiles).
