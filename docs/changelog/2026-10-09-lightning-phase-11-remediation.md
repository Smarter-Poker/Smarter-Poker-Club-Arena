# Lightning Phase 11 Remediation: Integrity Signals Are Fair and the Shadow Is Like for Like

Migration `supabase/migrations/20261009181945_lightning_phase_11_remediation_integrity_signals_are_fair_an.sql`, the database half of the verified Phase 11 adversarial review (2026-10-09). Not applied to production by this change. Every body it changes was read from PokerIQ-Production with `pg_get_functiondef` after 20261009143757, 20261009144343 and 20261009151825, and is changed by an asserted substitution into exactly that text. Lightning stays dark: no seating, settlement, legality or tick body moves, and no `fn_lightning_config` key is added.

## What Was Wrong and What Changed

### Finding 1: COORDINATED_JOIN_LEAVE Flagged Every Pair of an On and Off Cluster

The conversion opens every pool session in one statement and the reversion (`lightning_off`) and the unfreeze (`cluster_unfrozen`) close them all at once, so three cycles flagged every pair that stayed. `fn_lightning_integrity_scan` now compares only player-initiated moves: an entry within ten seconds of any epoch start of the Cluster (`cash_cluster_epoch.started_at`) is the system's, and only `stop_playing` and `anchor_seat_left` are the player's own exits. `lightning_off`, `cluster_unfrozen`, `rg_limit`, `disconnect_expired` and any later reason are decided by the system (an outage expiring every disconnected player at once is exactly such a correlated exit). Evidence gains `player_initiated_only`.

### Finding 2: PAIRING_CONCENTRATION Ignored Co-Presence

The expectation was `hands_a * hands_b / hands` over the whole window, so in a pool where players come and go nearly every pair that shared a session was concentrated. It is now the co-presence expectation: for every hand of A formed while B was in the pool, the chance a random seating puts B in it, `(players in the hand - 1) / (players in the pool - 1)`, summed and averaged with the same sum from B's side. The pool's size at each hand comes from one ordered sweep over the pool sessions. Evidence gains `expectation` (`co_presence`, or `whole_window` when presence is not on record), `hands_a_while_b_present` and `hands_b_while_a_present`. Thresholds are unchanged (30 together, twice the expectation).

### Finding 5: CHIP_FLOW Flagged No-Edge Pairs

At least 30 opposed hands (was 10), a binomial test on the receiver's wins (`z = (wins - n/2) / sqrt(n/4) >= 4.0`), and a gross flow of at least 50 big blinds of the Cluster, on top of direction and win share at least 0.8. Evidence gains `win_z`, `gross_bb`, `min_z` and `min_gross_bb`.

### Finding 6: Findings Were Keyed to the Exact Window

One finding per (Cluster, pattern, subject) now extends: a candidate whose window meets the newest finding of the same subject widens that row's window, keeps its peak score, takes the latest evidence (plus `latest_score`, `latest_window_start`, `latest_window_end`) and never touches `status`, `reviewed_by`, `reviewed_at` or `notes`, so an operator's `cleared` carries forward. The CHIP_FLOW mirror into `ca_collusion_signals` is once per finding (`detail.lightning_signal_id`), guarded by the new partial unique index `ca_collusion_signals_one_per_lightning_finding` and `ON CONFLICT DO NOTHING`; `detail.lightning_key` is now `<cluster>:<a>:<b>:<signal id>`. Every scan of a Cluster and every engine report for it first takes `pg_advisory_xact_lock(hashtext('lightning-integrity:' || cluster))`, so overlapping runs cannot double-insert. SESSION_LENGTH reads at most 5,000 qualifying sessions. `fn_lightning_alert_sweep` passes a tumbling window: the previous full UTC day, once per UTC day per Cluster. `fn_lightning_operator_cluster` lists a finding whose window reaches into the view.

### Finding 7: Engine Signals Never Fired at the Five-Minute Window

`fn_lightning_integrity_report` keeps every window's per-player and per-pair evidence in the new table `lightning_integrity_engine_window` (RLS on, no privilege for any role, kept 48 hours) and decides DECISION_LATENCY and TIMING_CORRELATION over the rolling 24 hours of it: counts are summed, `fast_share`, `p50_ms` and `p95_ms` are decision-weighted, `cv` is the pooled cv from `mean_ms` and `stddev_ms`, `latency_corr` is weighted by sequential actions. The thresholds are the ones a single window used.

### Finding 12: SESSION_LENGTH Drove High-Severity Counts

SESSION_LENGTH is capped at 69 (medium), so the Phase 12 integrity-spike alert is never driven by long sessions, which horses run and are never excluded from. `fn_ca_integrity_detector_health` is left alone: it belongs to the Smarter-Poker-World-Hub migrations, its state never reads `ca_collusion_signals`, its `chip_flow_rows` already excludes every row with a `detail.signal`, and with one mirror row per finding the Lightning rows can no longer swell its `total`.

### Finding 3: The Shadow Was Scored Over Different Components

`fn_lightning_shadow_record` makes a component null on both sides when it is null on either, then scores both with `fn_lightning_quality_score`'s own arithmetic over the shared set; the stored components are the aligned ones. A/A calibration is recorded: live `m1` against shadow `m1-port` is two versions; identical versions still answer `SAME_VERSION`.

### Finding 10: Unscored Windows Counted Toward Comparisons

`fn_lightning_shadow_report` counts as `comparisons` only windows where both scores are non-null (also its means and shadow win share); the new key `windows` counts every row.

## Payload Contracts

No input changes: `fn_lightning_integrity_report(uuid, jsonb, timestamptz)` and `fn_lightning_shadow_record(uuid, text, text, timestamptz, timestamptz, jsonb, jsonb)` take exactly what they took. Answers are additive:

| Door                                       | New Keys                                                                                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fn_lightning_integrity_report`            | `evidence_stored`, `aggregation_hours` (24), `evidence_pruned`; `flagged`, `inserted`, `updated`, `unchanged` count the 24 hour decision                 |
| `fn_lightning_shadow_report` version pairs | `windows`, `aa_calibration`; an A/A pair with 30 or more comparisons has verdict `calibrated` or `calibration_bias` and sorts after every real candidate |
| `fn_lightning_integrity_scan` thresholds   | `flow_min_z`, `flow_min_gross_bb`, `long_session_max_score`, `pairing_expectation`, `join_leave_counts`, `findings`                                      |

## Proof

`scripts/dev/test-lightning-phase11-remediation.sh` (PostgreSQL 17, port 55562, the real chain through 20261009151825 under production's default ACLs and live autorevoke trigger, humans and horses in every pool, the file applied twice) first reproduces every finding on the production bodies inside a rolled-back subtransaction, then proves it gone, 20 sections:

| Finding | Reproduced Before the File                                                                                                                | After the File                                                                                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | A Cluster flipped ON and OFF three times by the real drive: COORDINATED_JOIN_LEAVE for every pair that stayed, horses among them          | None; a human and a horse who stopped and returned together three times are still found                                                                                     |
| 2       | Random-seating pools of 18, 25 and 50 (1 h → 3 h sessions, a hand every 15 s): PAIRING_CONCENTRATION for pairs that only shared a session | None at 18 and 50; at 25 the planted human-horse pair is the one finding                                                                                                    |
| 5       | 300 no-edge pairs at 10 → 15 opposed hands: CHIP_FLOW and mirrors                                                                         | None; the dumping pair is the one CHIP_FLOW, mirrored once                                                                                                                  |
| 6       | Six hourly rolling rescans: six rows per pair and six mirrors                                                                             | One row per pair, the operator's cleared carried, one mirror; two concurrent overlapping scans leave one row and one mirror; the sweep scans the previous full UTC day once |
| 7       | Twelve five-minute engine windows: no signal                                                                                              | TIMING_CORRELATION and DECISION_LATENCY (human and horse alike) from the tenth window, one finding each spanning the hour                                                   |
| 3, 10   | 31 unscored windows counted toward 36 comparisons; a one-sided component scored 97 against 100                                            | 5 comparisons of 36 windows, insufficient evidence; 100 against 100; `m1` against `m1-port` recorded                                                                        |
| 12      | A thirty-hour human and horse: SESSION_LENGTH 90 high                                                                                     | 69 medium, alike                                                                                                                                                            |

No predecessor live proof is falsified (the anti-manipulation proofs 6 and 7 of 20261009144343 among them), all twelve own proofs hold, and the second application changes nothing. Measured on the planted pools, the scan takes about 0.2 s, 0.4 s and 1.1 s for 4,700, 6,200 and 12,400 hands. Static contract: `tests/lightning-phase-11-remediation.test.ts`. CI: a step on accounting_postgres shard 1 after the Phase 12 load and chaos step. Schema manifest fragment: `scripts/ci/schema-manifest.d/lightning-phase11-remediation.json`.

## Rollback

Re-apply the earlier bodies from 20261008161509 and 20261009144343 by `pg_get_functiondef` from a backup; the new table, its index and the mirror index are inert without Lightning traffic and can stay.
