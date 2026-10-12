# The board stops paging for refusals the next pass clears (2026-10-01)

Scope: the 56 open `ca_drift_incidents` rows that are mirrored refusal alerts
with 0.00 drift (the 6 rows carrying real chip drift and the balance-write
atomicity work are another lane's). Every number below was read from
production rows, `pg_stat_activity`, the engine's `/metrics`, Prometheus on
engine-01 or the engine's container log between 15:25 and 16:20 UTC.

Engine PR: this branch (`fix/mirrored-refusal-alerts-root-fix`).
Migration: `20261001160953_the_board_stops_paging_for_refusals_the_next_pass_clears`.
Law: `server/src/tournament/aTransientRefusalIsNewsWhenItStopsBeingTransient.law.test.ts`
(`docs/laws.d/a-transient-refusal-is-news-when-it-stops-being-transient.md`).

## The board, class by class

### 1. `financial_alerts:Tournament.atomic_finish_refused` - 23 incidents, 347 open criticals

**What it was.** 22 per-tournament rows plus the detector-storm row (309
further findings counted against it). Every one carried
`refusal_reason: timeout` (or `deadlock`) and `proven_refusal: true`.

**What was true.** All 22 tournaments are `COMPLETED` with a row in
`tournament_terminal_settlements`. Platform-wide, 342 of the 348 tournaments
with an open `atomic_finish_refused` alert are COMPLETED with a receipt (333
timeout, 7 deadlock, 2 other); the other 6 were refused in the last ten minutes
and were RUNNING toward the same outcome. One alert per tournament, so #5248's
dedupe key IS reaching this call site (`poker_tournament_finish_refusal_alerts_
suppressed_total` = 0 since the 13:53 restart, 7 refusals, 7 alerts).

**What the rows said happened.** The finish lane is one platform-wide
exclusive advisory lock (`fn_ca_lock_settlement_lane_for_finish`, "F
EXCLUSIVE: one finish on the platform at a time") taken under the
authenticator's 8 s `lock_timeout`. `fn_complete_tournament_terminal` averages
2,982 ms over 63,504 calls (max 44.6 s). Between 14:34 and 14:40 UTC the engine
log shows a finish completing every 4-10 s, each taking 5-20 s wall-clock. A
tournament whose five attempts and resolver (`terminalSettlementRpc.ts`) each
waited the full 8 s behind other finishes got `55P03` six times, ~48 s, and
`TerminalSettlementRefusedError` - which the engine classifies as the transient
`timeout`, retries at the base 5 s delay, and ALSO raises as a critical money
alert saying the finish "was definitively refused before commit and remains
eligible for a corrected retry". Nothing needed correcting; it needed the next
pass.

**Why the next pass took 17-44 minutes.** Tournament `028268d1` (PLO4 Heads-Up
100 Turbo, prize 190.00): decided 14:36:09, `FINALIZING` 14:36:09.98, refusal
alert 14:36:56, no further `FINALIZING` until 15:04:16, `COMPLETE - winner`
15:04:23. Meanwhile `GameServer` logged "is decided (1 playing) - recovering
the winner" 40 times and woke the manager each time. Two causes, both read from
code and metrics:

- The refused finish spends its admission's work budget, so `completedStage(3)`
  advances the sweep cursor PAST the finish stage. The re-armed admission runs
  stages 3..8, resets the cursor, and the finish is asked again only on the
  admission after that. Two trips through the queue.
- `poker_tournament_elimination_scheduler_oldest_wait_ms` on engine-01 read
  589 s at 14:30, 1,121 s at 14:52 (queue depth 336 to 520 against 4 slots),
  and dropped to 42 s only when the :55 break parked the fleet. The seven
  `finish deferred: the platform is frozen` lines between 14:56 and 15:02 are
  the finish stage finally being reached, every ~50 s, during the break.

**Producer fix (engine, this PR).**

- `TournamentManagerBase.noteFinishRefusal`: a transient reason is news only
  when the same tournament reports it `TRANSIENT_FINISH_REFUSAL_ALERT_STREAK`
  (3) times running - a wedged lane, not a busy one. A rule refusal is still
  news on the first report. The alert carries `refusal_streak`. Every refusal
  is still counted on `poker_tournament_finish_refusals_total{reason}`.
- `TournamentManagerEliminations.rearmIfTheFinishWasRefused`: rewinds the sweep
  cursor to `FINISH_STAGE` so the retry is one admission away, not two. The
  cursor's own fairness rule (one rewind, then the interrupted stage gets its
  admission) is unchanged.

**What this does NOT fix, said plainly.** The finish lane is saturated at peak
(one finish at a time, 3-20 s each, arrivals every 4-10 s) and the elimination
scheduler queues 300-500 managers against four slots. Both are structural and
measured here for whoever owns them; neither is touched by this PR. A finish
the lane refuses three passes running still opens a critical, which is the
condition that would actually mean a wedged lane.

**Resolved.** 22 + storm row, `verified_remeasured`, on the receipt. 342 + 34
(`atomic_finish_outcome_unknown`, 2026-09-27, all 34 COMPLETED with receipt)
alerts resolved on the same test. The migration's predicates are generic
(COMPLETED + receipt), so refusals filed between writing and applying resolve
on the same evidence or stay open. Alerts on RUNNING tournaments are left open.

### 2. `financial_alerts:postHandTasks.leave_pending_failed` - 14 incidents (24 by 16:10)

**What it was.** `Post-hand step leave_pending threw`; `supabase_timeout`
(engine's flat 15 s client deadline) or `canceling statement due to lock
timeout`, every one on the departures enumeration read (`table_seats_query`)
or the seat-move read (`move_enumeration_rpc`), with `move_execution:
not_started`. The 10 that arrived between 15:51 and 16:10 are the live
database-contention event below.

**What was true.** `fn_unaccounted_seat_exits(interval '4 days', interval '10
minutes')` returned 0 rows platform-wide; no live seat on any of the 14 tables
carries `leave_pending`; platform-wide exactly one live seat carries
`leave_pending` (joined 13:03 today, i.e. a player who just asked). Nothing was
owed.

**Why the alert measured the wrong thing.** Read the step: the only things that
can throw out of `leave_pending` are the enumeration read (before any write),
the seat-move read and the seat-move execution (a move carries no money). The
cash-out itself, `fn_cashout_seat_occupancy`, is one transaction per seat and
`processLeavePending` swallows its failure per seat (`atomicCashout`'s
`onFailed`), so a refused cash-out never throws here: the seat keeps
`leave_pending = true` and the next boundary re-reads it. The step is
`moneyCritical` because it returns a whole stack to a wallet; that is why its
FAILURE cannot lose one. Fourteen criticals, fourteen deferred boundaries.

**Producer fix (engine, this PR).**

- `ServerTableEngineBase.isTransientDbError`: `55P03` / "canceling statement due
  to lock timeout" is transient, like the deadlock already listed. A lock
  timeout aborts before commit; 8 of the 14 were this and got no retry because
  the list carried the deadlock and not its twin.
- `ServerTableEngineSettlement.runStep`: `leave_pending`'s failure is raised as
  `warning` with `moves_chips: false` and a message that says what it is.
  `fn_ca_financial_alert_to_incident` already reads `moves_chips:false` as "no
  critical incident" and ignores non-critical rows. Every other money-critical
  step still pages critical; the law pins the map to exactly one entry.

**Resolved.** 14 (and any filed before apply whose table holds no live
`leave_pending` seat), `verified_remeasured`.

**Open finding, not built here.** A cash-out the database refuses every boundary
has no alert of its own: `atomicCashout` logs it and the seat stays put with
its stack. Visible on the table, not lost; noted for the seat-lifecycle owner.

### 3. `fn_ca_journal_append_only` - 1 incident, 148 occurrences, firing every certification run

`retireProductionCreateClubFixtures` (scripts/ci/production-e2e-account.mjs)
deletes a certification club's `chip_transactions` under
`app.ledger_maintenance = 'ui-cert-cleanup:<club>'`. The kind was never
registered in `ca_ledger_maintenance_kinds`, so the trigger defaulted it to
warning and opened a board item per run - the shape 20260910132833 fixed for
`certification-cleanup`. 148 reasons = 148 cert clubs, all PostgREST/postgres,
every row in `ca_ledger_mutation_log`. **Fix:** registered as `info` (recorded,
not raised). Resolved `verified_remeasured`.

### 4. `fn_ca_cron_failure_watch` / `ca-stats-witness-audit-15m` - 1 incident

`ca_stats_witness_audit` hit its 120 s `statement_timeout` in 21 of 23 runs
over six hours (42-118 s when it finished). Section 2f reads `hand_history` by
primary key and unnests the action log twice for EVERY distinct all-in showdown
hand of the trailing week - written for "~400 all-in hands a week"; the
covering index now returns 611,169 candidate seat rows. A seat carrying
`all_in_equity` is owed and counted whatever the betting did, so the action-log
read is needed only for hands with a seat still owed a figure. **Fix:** the
`hands` CTE is narrowed to those hands and LEFT-joined back - result-identical
by the counting rule (owed = equity present OR no betting after the all-in;
missing = equity absent AND no betting after). Asserted md5-pinned substitution
(before `3b3b9610`, mid `ca398f0a`, after `a7738fa9`, measured in a rolled-back
probe). Resolved with basis `operator`: the proof is the next successful runs,
and the watch keys by job and day so a failure tomorrow is a fresh row.

### 5. Verified from rows and resolved (`verified_remeasured`)

| source                                             | n                      | evidence                                                                                                                            |
| -------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ServerTableEngine.authoritative_hand_unreachable` | 2 incidents, 27 alerts | `hand_history` row exists for 27 of 27 (table, hand) pairs: the successor generation committed the hand                             |
| `Tournament.satellite_qualifiers_outcome_unknown`  | 1 incident, 3 alerts   | satellite 0e1d340e settled 2026-09-28 21:22:12: 6 awards x 50.00 with payout ids, remainder 24.00, pool 324.00                      |
| `fn_ca_settlement_correctness_check:settler_lag`   | 2                      | `daemon_state.rakeback_settler` watermark 2026-10-01 15:06:05 at 15:26:24, past the week named, inside the 30 min interval          |
| `ca_diamond_incidents` DR0:health_critical         | 1 (+7 diamond rows)    | `fn_ca_diamond_health_watch()` = 0 at 16:02; `ca-horse-claim-due-minute` 180/180 successes in 3 h                                   |
| `fn_ca_guard_defs_watch`                           | 1                      | `fn_ca_settlement_correctness_check` redefined by 20260927134527..20260927220353 (all on main); live md5 `331dfe59` = capture 27781 |
| `fn_ca_tournament_finished_but_not_completed`      | 1 (new 15:55)          | tournament 8bc45c76 COMPLETED 16:05:10 with receipt - section 1 seen from the other side                                            |

### 6. Left open, each still true at 16:05 UTC

| source                                                | n                   | why it stays                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fn_union_enforce_stop_loss`, `fn_union_age_invoices` | 2 + 2               | `settlement_invoices` MIDWAY-2026-000005 (Club JAQK, 33,222.29) and -000006 (SHARK CLUB, 11,244.03) are still `overdue`; the suspension is the stop-loss working. Owner decision.                                                                                                                                                                                                                                                   |
| `fn_union_law_selftest`                               | 1                   | cron job 272 `union-weekly-rakeback-close` is `active=false`, stood down by the weekly-close rework (changelog 2026-09-30). The self-test is right until that lane reactivates it or amends the required list. Note: the self-test itself times out on `fn_union_distribution_check`'s rake sum under today's load (8 s) - a "could not tell" that is not yet distinguished from "breached" (10.86 rule 1); owner of the union law. |
| `fn_ca_conservation_sweep:*`                          | 3                   | `union_eco_not_recorded` and `union_rake_wallet_stale` (stalled weekly cascade / rakeback settler, other lanes); `fn_ca_hand_commit_refusals` = 206 hands refused for `lease proof expired` today (below)                                                                                                                                                                                                                           |
| `postHandTasks.hand_history_failed`                   | 1 (46+ occurrences) | the lease-loss storm below                                                                                                                                                                                                                                                                                                                                                                                                          |
| trial balance, ledger replay, negative balance        | 6                   | the sibling's lane                                                                                                                                                                                                                                                                                                                                                                                                                  |

## The live event this ran inside (not mine, reported)

From 15:23 UTC, `[Tournament.lease_proof_expired]` fired in bursts every 2-4
minutes: 387 at 15:25, 395 at 15:27, 214, 282, 266, 305, 325, 213, 173 at
15:43. Each burst stopped a few hundred table engines ("Stopped. Dealt N
hands") and refused their in-flight hand commits (`atomic hand commit refused
(lease_proof_expired)`), the `hand_history_failed` row. The engine log shows
`[tournament-lease] heartbeat failed (canceling statement due to statement
timeout)`. `pg_stat_activity` at 15:44 and 15:46 showed 11-17 backends waiting
on `MultiXactOffsetSLRU` / `MultiXactMemberSLRU` / `MultiXactOffsetBuffer`
LWLocks - PostgREST's `fn_smarter_data_api_pre_request`, `tournament_players`
and `tournaments` reads, and all four shards of `CALL
public.sp_drain_daily_challenge_event_outbox(5000, N, 4)` (pg_cron 176, 317,
318, 319, every minute, 11-15 s average, 45 s max). #5686 (applied today)
measured the same drainer and the `fn_ca_horse_claim_due` lock span; that lane
owns it. Everything in sections 1, 2 and the new rows since 15:50 is downstream
of this: lock timeouts on the finish lane, 15 s client timeouts on seat reads,
heartbeat statements past their deadline.

## Counts

|                               | before (15:25)                   | after migration (probe, 16:1x)  |
| ----------------------------- | -------------------------------- | ------------------------------- |
| `ca_drift_incidents` open     | 62 (73 by 16:10 under the storm) | 16 (6 sibling + 10 named above) |
| `financial_alerts` unresolved | 876 (1,220 by 16:10)             | 727                             |

The after figures are from the rolled-back probe of the migration at 16:1x UTC
and will differ at apply time by whatever the storm adds; every predicate is
evidence-based, so a row that still names an unfinished tournament or a live
`leave_pending` seat stays open.
