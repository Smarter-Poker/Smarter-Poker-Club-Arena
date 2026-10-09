# Lightning Phase 11: Integrity Telemetry and the Shadow Matcher Ledger

Migration `20261008161509_lightning_phase_11_integrity_telemetry_and_the_shadow_matche.sql` (specification Phases 18 and 19, the database side). One transaction with `SET LOCAL lock_timeout`; two new tables, two new indexes on the empty `lightning_hand` and `lightning_pool_session`, and one asserted substitution into `fn_lightning_config` read from PokerIQ-Production with `pg_get_functiondef` on 2026-10-08 after `20261008142857`, each anchor counted or the file refuses. Not applied to production by this change.

## The Existing Integrity System Is Reused

- `ca_collusion_signals` is club-arena's own pair store (user_a the net receiver, hands_together, gross_flow, net_flow, direction_ratio), written by `fn_ca_collusion_scan` and `fn_ca_duel_pairing_scan` and read by the operator review queue and the case evidence door. A Lightning `CHIP_FLOW` finding has exactly that meaning, so the scan writes it there too, once per finding, in the duel scan's convention (`detail.signal` = `lightning_chip_flow`). It reaches the operator queue and can be attached to a case with no new reader.
- `collusion_tracking` is not written: the detector health reader treats its newest row as the external worker's heartbeat, so Lightning rows there would hide a dead worker. The queue and health readers belong to the Hub migrations and are not rewritten. `anti_cheat_flags` is club-operator facing and carries no evidence object, so it is not written either.
- Everything else lands in one new store, `lightning_integrity_signal`, shaped on `collusion_tracking` (player_a / player_b, pattern_type, suspicion_score 0 → 100, evidence, window, status open / reviewed / cleared / actioned) plus the Cluster, the source and a severity. One row per Cluster, pattern, window and subject (`NULLS NOT DISTINCT` for a single-player subject); a rescan with the same numbers changes nothing and never touches a status an operator set.

## Signals From Persisted Lightning Data

`fn_lightning_integrity_scan(p_cluster_id, p_from, p_to)` (service_role only). Default window: the 24 hours before the current hour, never past now, at most seven days. Bounded at 20000 settled hands and 5000 pool sessions per Cluster and 50 Clusters per call.

- `PAIRING_CONCENTRATION`: hands together at least 30 and at least twice the `hands_a * hands_b / hands` expected from each player's own hand count, so a pool that always plays together is not flagged.
- `CHIP_FLOW`: at least 10 shared hands with opposite results, net at least 80% of gross, one side winning at least 80% of them.
- `COORDINATED_JOIN_LEAVE`: at least three sessions of each player entered and exited within ten seconds of the other's.
- `SESSION_LENGTH`: a pool session of twelve hours or more.
- `DEVICE_OVERLAP`: a pair with at least five shared hands and a shared `user_sessions` IP address (existing data; only the count enters the evidence).
- `ACCOUNT_RELATIONSHIP`: a pair with at least five shared hands where one referred the other (`profiles.referred_by`).

Not wired into `fn_cash_clusters_tick_all`: the tick runs every few seconds and a day of pair aggregation is bounded but not sub-second at volume, so the scan is an on-demand service door.

## Signals the Engine Measures

The database does not persist per-action timing for Lightning. `fn_lightning_integrity_report(p_cluster_id, p_signals, p_now)` (service_role only) takes the engine's window object (`window_from`, `window_to`, `hands`, `decisions`, `fast_ms`, `dropped_players`, `dropped_pairs`, up to 500 `players` and 200 `pairs`), validates and clamps every entry, refuses any card, hole, deck or seed key, and writes only what the database judges abnormal: `DECISION_LATENCY` (at least 50 decisions with cv at most 0.15 or fast_share at least 0.6) and `TIMING_CORRELATION` (at least 20 hands together and 30 sequential actions with latency_corr at least 0.7 or fast follows on at least half).

## The Shadow Matcher Ledger

- `lightning_matcher_shadow_comparison`: one row per Cluster, window, `live_matcher_version` and `shadow_matcher_version`, both sides' window objects as the engine measured them, their quality components, both quality scores and the weights that scored them.
- `fn_lightning_quality_components` and `fn_lightning_quality_score`: the internal Lightning Quality Score, 0 → 100, the weighted mean of next_hand_speed (wait p50 and p95), formation_success, bb_fairness (BB order violations), opponent_diversity (repeat pair rate), instance_utilization and reliability (1 - failure_rate). Never exposed to players.
- `fn_lightning_shadow_record` validates both sides, falls back to the side's own `matcher_version` and then the configured one for a NULL live version, refuses the same version on both sides, and is idempotent per key (different numbers answer `IDEMPOTENCY_CONFLICT`).
- `fn_lightning_shadow_report` answers, per version pair, the count, Clusters, both mean scores, the delta mean / min / max, the share of windows the shadow won, every component and raw signal per side, and a verdict that needs thirty comparisons before it says anything but `insufficient_evidence`.
- `fn_lightning_config` gains `lightning_shadow_matcher` (false), `shadow_matcher_version` ('m2'), `shadow_window_ms` (300000), `shadow_max_players` (500), `shadow_pass_budget_ms` (50), `integrity_telemetry` (false) and `quality_weights` (0.25 / 0.20 / 0.15 / 0.15 / 0.10 / 0.15), clamped and reported like every other key, in a second object joined onto the first (which stands at 88 of its 100 arguments).

## No Matchmaking Manipulation

Nothing in the seating path reads a signal, the chip-flow mirror, the ledger or the score: a live proof pins every `fn_lightning_` and `fn_cash_cluster` body outside the Phase 11 doors, and the harness sets every signal of a Cluster to 100 and shows `fn_lightning_player_legality` answering exactly as before while the flagged pair still forms a hand. No product or security policy requires an integrity-based seating rule.

## Access, Law 10.5 and Lightning Off

Both tables have RLS on, no policy and no table privilege for any role; the four doors that touch them are SECURITY DEFINER and executable by service_role alone, so the Phase 2 census of exactly seven Lightning tables granted to service_role stays true. Nothing reads `is_horse` or `horse_id`: the harness plants a human-horse pair and a robotic horse and both are found exactly as any player. Lightning is off everywhere and both engine switches default to false.

## Proof

- `scripts/dev/test-lightning-phase11-integrity-shadow.sh`: 13 sections on PostgreSQL 17 over the real chain through `20261008142857`, under production's default function ACLs and autorevoke trigger, re-applied twice.
- `tests/lightning-phase-11-integrity-shadow.test.ts`: the static contract.
- CI step after the Phase 9 remediation step on shard 1, the schema manifest fragment `lightning-phase11-integrity-shadow.json`, and the `cash-native-hosted.manifest.json` ci.yml pin.
