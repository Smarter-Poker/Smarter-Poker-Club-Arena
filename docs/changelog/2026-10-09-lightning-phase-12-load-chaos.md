# Lightning Phase 12: Load, Stress and Chaos (Database)

Specification Phase 20 (LOAD / STRESS / CHAOS) and the database half of SURGE PROTECTION, built as Lightning build Phase 12 of 14. The harness `scripts/dev/test-lightning-phase12-load-chaos.sh` drives many real concurrent PostgreSQL 17 backends against the real Lightning chain and injects real faults; it found three defects in production bodies, closed by `supabase/migrations/20261009151825_lightning_phase_12_load_chaos_the_pass_forms_under_surge.sql`. Not applied to production by this change. Lightning stays dark: `lightning_enabled` is false on all 166 Clusters.

## What the Harness Is

- The real chain: every Lightning migration from 20260920172736 through Phase 11 (20261008161509), built on the Phase 11 harness's own ground (read from it at run time, so the two never drift): production's default function privileges and its live `trg_autorevoke_privileged_anon` event trigger, the reload door stand-in `atomic_table_rebuy`, the real physical settlement path. This phase's file is applied twice; every predecessor `@live-proof` is evaluated before and after it (363 true before, none falsified) and its own ten proofs all hold.
- Real concurrency: every worker is its own `psql` backend (`application_name` `lcw-<kind>`). Two matchers race `fn_lightning_match_and_form` on the same Cluster (paced at `pass_interval_ms`, jittered, as two engine nodes), a second worker calls the barrier `fn_lightning_form_hand` directly without the matcher lock, dealers call `fn_lightning_instance_begin_dealing` and `fn_lightning_bind_hand_number`, fold bars call `fn_lightning_fast_fold` (LIGHTNING FOLD, normal fold, FOLD & WATCH), settlers race the same hands through `fn_lightning_settle_hand` with the engine's deterministic request id or a fresh one, reloads go through `fn_lightning_auto_rebuy`, presence through `fn_lightning_presence_report`, Stop Playing through `fn_lightning_stop_playing`, and the cron through `fn_cash_clusters_tick_all` and `fn_cash_cluster_lightning_drive`.
- Duplicated and reordered calls: passes, barrier formations, binds, folds and settlements are replayed with their request ids (each must answer the recorded result and change nothing); a second settlement request for a settled hand must answer `already_settled`; a fold of another type `already_folded`; a second hand number `hand_number_already_bound`.
- Real chaos: `pg_cancel_backend` and `pg_terminate_backend` of random workers mid transaction, `statement_timeout` 40 ms and `lock_timeout` 15 ms on a share of the workers, and fault triggers armed per session by a GUC that sleep inside the barrier (after its first reservation row) and the settlement (after its anchors are marked, before its commit), or raise and sleep inside a conversion.
- Horses sit beside humans at every table and every second arrival is a horse; nothing reads `is_horse` or `horse_id` (Law 10.5).
- Fixture boundaries only: arrivals and departures at the seat, the engine's lease and its halt acknowledgement, the engine's reload delivery between hands, backdated stamps (time travel). Every economic action goes through the production door.

## Scenarios

- L01 → L07, LOAD: one six-max Cluster each at 10, 50, 100, 500, 1,000, 5,000 and 10,000 eligible players (the CI profile runs 10, 50, 100 and 500), the whole engine loop on 14 → 42 concurrent backends.
- S1, STRESS mass joins, mass leaves and duplicate Stop Playing against a playing nine-max Cluster.
- S2, STRESS reconnect storm: four reporters flapping the same players, self-healing folds, twelve players gone for good backdated past the timeout and expired by the reaper mid-storm (and nobody else).
- S3, STRESS conversion storm: ten Clusters (six-max and nine-max, four stakes, NLH, PLO and short deck) pushed back and forth across ON and OFF by wave workers while four drives and two ticks race them and the engine plays every Cluster that is LIGHTNING.
- C1, CHAOS DB timeout and connection loss: timeouts, cancels and terminations on the whole loop with faults armed in the barrier and the settlement.
- C2, CHAOS killed formation and dead engines: barrier transactions terminated mid flight; formations left undealt (form window 5 s) and dealt hands whose host died (deadline backdated) are recovered by the tick's reaper alone.
- C3, CHAOS settlement retry after a terminated connection: every settlement sleeps inside its transaction and settlers are terminated there; retries settle every hand exactly once.
- C4, CHAOS conversion failure mid-drive and a server restart: faults raise inside half the conversion writes and sleep inside the rest, drives and ticks are cancelled and terminated, every backend is terminated at once, then the stuck-conversion reaper runs and the Clusters are driven back to rest.

## Invariants Asserted After Every Scenario

After every storm the engine drains through the same doors and the production reapers run; then `lc.check` asserts, one row each:

| Invariant                                  | What it asserts                                                                                                                                                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chip_conservation`                        | Seats + club wallets + unresolved reloads, less what arrivals brought, equals the books taken before the storm                                                                                                                            |
| `no_lost_or_duplicate_money_per_seat`      | Every seat's stack is its stack before plus exactly the nets of the hands it settled since plus exactly the reloads delivered to it (no lost money, no duplicate money, per seat)                                                         |
| `every_hand_conserves`                     | Every settled hand: stack before = stack after + rake + jackpot drop                                                                                                                                                                      |
| `no_duplicate_money_settled_once`          | One physical commit, one history row, one `hand_settled` event and one receipt per settled hand; no trace of a settlement on a hand that did not settle                                                                                   |
| `idempotent_replays_and_no_door_violation` | Every replayed pass, barrier formation, bind, fold and settlement answered its recorded result; second requests were refused; no door froze a Cluster; no pass starved on its budget                                                      |
| `no_duplicate_player`                      | One open pool session and one open slot per player per Cluster, one active reservation, one open session per anchor seat, one live seat per player, no player held by two live hands beyond what a LIGHTNING FOLD or normal fold released |
| `no_ghost_and_nobody_left_behind`          | No open pool session on a departed or reassigned anchor seat; no eligible seated player a LIGHTNING Cluster never entered into its current epoch's pool                                                                                   |
| `no_duplicate_hand`                        | Unique hand numbers, request ids, instance bindings and history numbers; participant rows agree with every locked count                                                                                                                   |
| `no_duplicate_blind`                       | Exactly one big blind and one small blind per hand; the blind ledger equals the blinds of the formations that were kept (a formation voided before it dealt is reversed)                                                                  |
| `no_orphan_reservation`                    | After the drain and the reapers nothing is live, no reservation is active or owned by a terminal instance, no open session carries exposure                                                                                               |
| `no_ambiguous_settlement`                  | Every instance is complete (settled, receipt, history, every stack_after) or abandoned with no settlement trace (stacks stand where they were)                                                                                            |
| `no_unwarranted_freeze`                    | No Cluster frozen without a planted fault                                                                                                                                                                                                 |
| `cluster_modes_consistent`                 | One open epoch per Cluster and it is the Cluster's epoch; at most one open conversion; MUST MOVE holds no pool; LIGHTNING's pool is all in its epoch                                                                                      |
| `no_money_moved_by_a_mode_change`          | No conversion, reversion, unfreeze or formation money guard (`LIGHTNING_*_MOVED_MONEY`) ever fired, even where the drive recorded it as an error                                                                                          |
| `no_unexpected_error`                      | No production door raised anything but a retryable class (deadlock, lock timeout, serialization), which are counted and reported                                                                                                          |

Scenario checks on top: `mode_matches_population` (S3) and `failed_conversions_leave_no_trace` (C4): every Cluster at rest in a mode its live population allows, no open conversion; `the_gone_expire_the_present_do_not` (S2); `the_reaper_alone_recovers` (C2).

Every scenario, full profile run (PASS in every cell; empty where a scenario-specific check does not apply):

| Scenario |  1   |  2   |  3   |  4   |  5   |  6   |  7   |  8   |  9   |  10  |  11  |  12  |  13  |  14  |  15  |  16  |  17  |  18  |  19  |
| -------- | :--: | :--: | :--: | :--: | :--: | :--: | :--: | :--: | :--: | :--: | :--: | :--: | :--: | :--: | :--: | :--: | :--: | :--: | :--: |
| L01      | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |      |      |      |      |
| L02      | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |      |      |      |      |
| L03      | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |      |      |      |      |
| L04      | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |      |      |      |      |
| L05      | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |      |      |      |      |
| L06      | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |      |      |      |      |
| L07      | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |      |      |      |      |
| S1       | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |      |      |      |      |
| S2       | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |      |      |      |
| S3       | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |      | PASS |      |      |
| C1       | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |      |      |      |      |
| C2       | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |      |      | PASS |      |
| C3       | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |      |      |      |      |
| C4       | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |      |      |      | PASS |

1. `chip_conservation`
2. `no_lost_or_duplicate_money_per_seat`
3. `every_hand_conserves`
4. `no_duplicate_money_settled_once`
5. `idempotent_replays_and_no_door_violation`
6. `no_duplicate_player`
7. `no_ghost_and_nobody_left_behind`
8. `no_duplicate_hand`
9. `no_duplicate_blind`
10. `no_orphan_reservation`
11. `no_ambiguous_settlement`
12. `no_unwarranted_freeze`
13. `cluster_modes_consistent`
14. `no_money_moved_by_a_mode_change`
15. `no_unexpected_error`
16. `the_gone_expire_the_present_do_not`
17. `mode_matches_population`
18. `the_reaper_alone_recovers`
19. `failed_conversions_leave_no_trace`

Harness verdict: PASS (Lightning Phase 12 (DB) load, stress and chaos, profile full: 14 scenarios, 214 invariant checks, all PASS, over the real chain through Phase 11 under production's default function ACLs and its live a ...)

## Measured Scoreboard

Milliseconds, measured inside the database around each production call, real concurrent backends, PostgreSQL 17 on the Mac Studio (shared with other work, so absolute numbers carry machine load), full profile:

| Players | Operation                 | Calls |      P50 |      P95 |      P99 |      Max |
| ------: | ------------------------- | ----: | -------: | -------: | -------: | -------: |
|      10 | `match_and_form`          |    31 |    11.78 |    25.12 |    38.53 |    43.17 |
|      10 | `match_pass_inside`       |    30 |    11.70 |    24.83 |    38.19 |    42.80 |
|      10 | `match_and_form_per_hand` |    29 |     8.69 |    19.98 |    22.33 |    22.59 |
|      10 | `form_hand`               |   101 |     1.42 |    10.98 |    26.29 |    28.01 |
|      10 | `begin_dealing`           |    45 |     4.39 |     5.29 |     5.52 |     5.54 |
|      10 | `bind_hand_number`        |    45 |     1.16 |     1.55 |     1.63 |     1.66 |
|      10 | `fast_fold`               |   112 |     1.39 |     3.49 |     5.19 |     5.55 |
|      10 | `settle_hand`             |    84 |    17.82 |    27.20 |    32.47 |    33.55 |
|      10 | `presence_report`         |   234 |     0.36 |     1.11 |     2.24 |    10.23 |
|      10 | `auto_rebuy`              |    42 |     0.88 |     4.29 |    11.94 |    16.95 |
|      50 | `match_and_form`          |    30 |    54.00 |   596.96 |   849.12 |   853.05 |
|      50 | `match_pass_inside`       |    23 |    63.10 |   785.30 |   849.73 |   852.70 |
|      50 | `match_and_form_per_hand` |    23 |     8.10 |   116.83 |   135.96 |   139.94 |
|      50 | `form_hand`               |    89 |     3.48 |   159.85 |   535.10 |   814.22 |
|      50 | `begin_dealing`           |   183 |     1.10 |     5.09 |    11.33 |   223.76 |
|      50 | `bind_hand_number`        |   183 |     0.36 |     1.19 |     1.25 |     1.39 |
|      50 | `fast_fold`               |   566 |     0.49 |     6.44 |    18.10 |   417.95 |
|      50 | `settle_hand`             |   278 |     6.43 |    22.10 |   370.03 |   827.33 |
|      50 | `presence_report`         |   181 |     0.38 |     2.45 |   108.10 |   744.75 |
|      50 | `auto_rebuy`              |   173 |     0.82 |   200.06 |   449.02 |   758.67 |
|     100 | `match_and_form`          |    27 |    94.60 |   329.59 |   389.30 |   409.80 |
|     100 | `match_pass_inside`       |    20 |   139.35 |   334.44 |   394.33 |   409.30 |
|     100 | `match_and_form_per_hand` |    20 |     9.72 |    25.90 |    27.05 |    27.33 |
|     100 | `form_hand`               |    90 |     3.61 |   231.83 |   296.93 |   304.53 |
|     100 | `begin_dealing`           |   309 |     1.11 |     6.10 |    23.33 |   412.49 |
|     100 | `bind_hand_number`        |   309 |     0.35 |     1.13 |     1.39 |     2.46 |
|     100 | `fast_fold`               |   784 |     0.45 |     5.45 |    16.92 |    24.17 |
|     100 | `settle_hand`             |   393 |     6.79 |    22.71 |   203.29 |   215.05 |
|     100 | `presence_report`         |   181 |     0.39 |     3.87 |    61.96 |   197.17 |
|     100 | `auto_rebuy`              |   207 |     0.82 |    57.89 |   185.50 |   202.42 |
|     500 | `match_and_form`          |    24 |    91.69 |   543.83 |   983.25 |  1113.83 |
|     500 | `match_pass_inside`       |    12 |   401.70 |   800.77 |  1050.55 |  1113.00 |
|     500 | `match_and_form_per_hand` |    12 |    12.58 |    27.96 |    38.60 |    41.26 |
|     500 | `form_hand`               |    55 |     6.23 |   423.02 |   748.59 |  1093.76 |
|     500 | `begin_dealing`           |   381 |     1.39 |     9.01 |    13.03 |    14.53 |
|     500 | `bind_hand_number`        |   381 |     0.43 |     1.89 |     2.13 |     2.29 |
|     500 | `fast_fold`               |  1916 |     0.65 |    44.57 |    75.38 |   255.75 |
|     500 | `settle_hand`             |   804 |    24.46 |    79.02 |   105.94 |   282.95 |
|     500 | `presence_report`         |   153 |     0.40 |    10.28 |   258.37 |   902.17 |
|     500 | `auto_rebuy`              |   198 |     0.98 |     5.04 |   215.13 |   623.52 |
|    1000 | `match_and_form`          |    22 |     3.20 |  1185.80 |  1388.39 |  1441.84 |
|    1000 | `match_pass_inside`       |    10 |   755.75 |  1326.54 |  1418.27 |  1441.20 |
|    1000 | `match_and_form_per_hand` |    10 |    23.66 |    73.36 |    97.08 |   103.01 |
|    1000 | `form_hand`               |    35 |     9.35 |  1101.71 |  1314.12 |  1406.99 |
|    1000 | `begin_dealing`           |   330 |     1.61 |    18.12 |    27.68 |   747.92 |
|    1000 | `bind_hand_number`        |   330 |     0.48 |     2.44 |     2.94 |     4.13 |
|    1000 | `fast_fold`               |  1635 |     0.79 |    66.64 |   104.19 |   148.08 |
|    1000 | `settle_hand`             |   763 |    31.46 |   115.53 |   367.44 |   400.95 |
|    1000 | `presence_report`         |   174 |     0.49 |    26.69 |   408.87 |   574.55 |
|    1000 | `auto_rebuy`              |   188 |     1.38 |     5.61 |    35.32 |   213.52 |
|    5000 | `match_and_form`          |    29 |     0.78 |  5878.82 |  8304.21 |  8806.45 |
|    5000 | `match_pass_inside`       |     3 |  7011.20 |  8626.61 |  8770.20 |  8806.10 |
|    5000 | `match_and_form_per_hand` |     3 |   219.16 |  7947.80 |  8634.79 |  8806.54 |
|    5000 | `form_hand`               |    12 |    12.62 |  7811.48 |  8570.85 |  8760.69 |
|    5000 | `begin_dealing`           |    75 |     1.56 |    30.50 |  1850.00 |  7021.51 |
|    5000 | `bind_hand_number`        |    75 |     0.48 |     2.63 |     2.91 |     3.28 |
|    5000 | `fast_fold`               |   367 |     0.66 |    86.37 |   165.12 |   208.11 |
|    5000 | `settle_hand`             |   166 |    70.57 |   172.64 |   195.74 |   227.10 |
|    5000 | `presence_report`         |   360 |     0.57 |     0.96 |    36.12 |   201.62 |
|    5000 | `auto_rebuy`              |   244 |     4.53 |    13.63 |    36.21 |    69.51 |
|   10000 | `match_and_form`          |    29 |     0.86 |   854.54 | 14071.79 | 18991.53 |
|   10000 | `match_pass_inside`       |     2 | 10204.55 | 18111.10 | 18813.90 | 18989.60 |
|   10000 | `match_and_form_per_hand` |     2 |   318.96 |   566.05 |   588.02 |   593.51 |
|   10000 | `form_hand`               |     2 | 10205.62 | 18117.23 | 18820.49 | 18996.30 |
|   10000 | `begin_dealing`           |    33 |     1.57 |    24.17 |    25.74 |    25.85 |
|   10000 | `bind_hand_number`        |    33 |     0.52 |     2.20 |     2.27 |     2.28 |
|   10000 | `fast_fold`               |   161 |     0.67 |    60.17 |    91.05 |    98.25 |
|   10000 | `settle_hand`             |    72 |    23.57 |   103.73 |   112.91 |   113.44 |
|   10000 | `presence_report`         |   337 |     0.62 |     1.08 |     1.92 |    32.71 |
|   10000 | `auto_rebuy`              |    16 |     2.58 |     7.79 |     7.84 |     7.85 |

`match_and_form` is every call (a call that finds the other worker's pass running answers `pass_in_progress` at once); `match_pass_inside` is the pass's own `duration_ms` for passes that ran; `match_and_form_per_hand` is a forming pass's time divided by the hands it formed.

Throughput per population (the same run):

- 10 47 hands formed, 47 settled (3.7 per second); 31 passes, 0 stopped at the time budget; 74 LIGHTNING FOLDs
- 50 192 hands formed, 192 settled (15.2 per second); 30 passes, 0 stopped at the time budget; 347 LIGHTNING FOLDs
- 100 323 hands formed, 323 settled (25.6 per second); 27 passes, 0 stopped at the time budget; 453 LIGHTNING FOLDs
- 500 415 hands formed, 415 settled (31.4 per second); 24 passes, 1 stopped at the time budget; 1001 LIGHTNING FOLDs
- 1000 330 hands formed, 330 settled (27.1 per second); 22 passes, 1 stopped at the time budget; 794 LIGHTNING FOLDs
- 5000 77 hands formed, 77 settled (3.7 per second); 29 passes, 1 stopped at the time budget; 185 LIGHTNING FOLDs
- 10000 66 hands formed, 66 settled (1.6 per second); 29 passes, 0 stopped at the time budget; 73 LIGHTNING FOLDs

The full profile ran in 248 s (exit 0); the CI profile (10, 50, 100, 500) in 103 s (exit 0).

One pass alone (the harness's Cluster after its storm, no other backend, `fn_lightning_match_and_form` forming its full admission batch of 32 hands): 1,000 players 0.32 s and 5,000 players 1.62 s (both measured before the exposure change), 10,000 players 1.06 s on a fresh Cluster and 1.71 s after its storm (after it). Inside the storms, at 5,000 and 10,000 players the pass is CPU bound (sampled: the matcher backend on CPU, never waiting on a lock) and shares the machine with 42 workers and other work, which is where the multi-second P95 and P99 come from. Before 20261009151825 those two populations formed nothing at all through the matcher.

## Defects Found and Fixed (20261009151825)

### The Pass Forms Under Surge (P1)

`fn_lightning_match_and_form` measured `pass_time_budget_ms` (750) from the start of the pass, and the plan alone (legality for every open player under the Cluster lock) outlasted it from roughly 3,000 eligible players: every pass then stopped at its first group with `stopped_reason` `time_budget` and formed nothing. Measured before the fix: 0 hands formed by the matcher at 5,000 and at 10,000 players (14 and 7 starved passes). The budget now runs from the end of the first plan, so it bounds the forming it was meant to bound; matching, order and blinds are unchanged. The harness fails any pass that ends on its budget having formed nothing.

### The Exposure Reader Keeps Its Plan

`fn_lightning_pool_exposure` is called once per open player by legality on every pass. As a SQL function with a pinned search_path it could not be inlined and was planned again on every call (0.73 ms planning for 0.11 ms execution). It is now the same query in PL/pgSQL (same answer, STABLE, same search_path and grants), whose plan the session caches: legality over 5,000 players 787 ms → 424 ms.

### A Conversion Locks the Seats It Enters (P1)

`fn_cash_cluster_commit_lightning` and `fn_cash_cluster_abort_pending_off` read the live seats without locking them, so a player standing up at the same moment (the seat trigger deferred to that transaction's commit) was entered into the pool on the departing seat after the departure's own trigger had run. The ghost session (active, anchored on a seat that had left 2 → 6 ms earlier) can never be dealt and made every later reversion refuse at `LIGHTNING_REVERSION_STRANDED_A_PLAYER` (113 refusals in one storm, 14 ghosts across seven Clusters, one Cluster stuck in PENDING_OFF). Both writers now take the live seats FOR SHARE in seat-id order, the order `fn_cash_cluster_commit_must_move` already takes. The conversion's chip check covers exactly the seats it locked.

### The Reversion's Money Guard Compares the Rows It Locked (P2)

`fn_cash_cluster_commit_must_move` digests the live seats, open cash sessions and blind ledger before and after the reversion under FOR SHARE locks, but a row lock cannot stop an INSERT: an arrival committing between the digests raised `LIGHTNING_REVERSION_MOVED_MONEY` although nothing had moved (seven seats inserted at 10:49:14.871 committed during the reversion at 10:49:15.108), a false financial alarm. Both digests now cover exactly the rows it locked, by id, plus any row its own transaction wrote, so a write by the reversion is still caught.

## Residual Findings (Recorded, Not Changed Here)

- `fn_lightning_presence_report` deadlocks under concurrent reporters (24 → 30 per 15 s storm with four reporters), with its own two unordered multi-row UPDATEs and with settlement's unordered pool-session counter UPDATE. Retryable, money-safe, and the engine's reporter retries reconnects; ordering the session locks in both `fn_lightning_presence_report` and `fn_lightning_settle_hand` would close it. Measured: ordering presence alone does not reduce it, so no change ships without the settlement half.
- Settlement and formation take anchors in different orders (player id against seat id): a handful of retryable deadlocks per storm (40P01, retried with one request id, never a double settlement).
- `fn_lightning_instance_begin_dealing` takes the Cluster row FOR SHARE (pinned by a live proof of 20260926072615), so dealing an already formed hand waits behind a running matcher pass; with one paced worker per Cluster this is bounded by the pass, and it grows with the plan's cost at very large pools.
- The plan's cost is linear in the open pool (`fn_lightning_player_legality`, owned by another Phase 12 agent): about 0.1 ms per player after the exposure fix, so a pass at 10,000 eligible players still spends over a second planning under the Cluster lock.
- On macOS, a killer signal can interrupt a backend's file open ("Interrupted system call"); the harness reports these apart from door errors.

## CI

`Lightning Phase 12 keeps money and identity exact under load, stress and chaos` runs on `accounting_postgres` shard 1 after the Phase 11 step with `LIGHTNING_CHAOS_PROFILE: ci` (populations 10, 50, 100 and 500, short storms). The static contract is `tests/lightning-phase-12-load-chaos.test.ts`; the schema manifest fragment `scripts/ci/schema-manifest.d/lightning-phase12-load-chaos.json` promises nothing new; the ci.yml pin in `scripts/qualification/cash-native-hosted.manifest.json` is recomputed.
