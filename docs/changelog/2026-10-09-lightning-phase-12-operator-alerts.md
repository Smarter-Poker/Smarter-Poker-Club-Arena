# Lightning Phase 12: The Operator Dashboard, Its Alerts and the Latency Ledger

Migration `20261009144343_lightning_phase_12_operator_dashboard_and_alerting.sql` (specification Phase 21, the database side, plus the Phase 11 carry-forward items "integrity scan has no caller" and "latency telemetry is not persisted"). One transaction (repeatable read, the managed cron API's own isolation, and `SET LOCAL lock_timeout = '2s'`); two new tables, two indexes on the empty `lightning_integrity_signal`, thirteen new functions, one cron job and one asserted substitution into `fn_lightning_config` read from PokerIQ-Production with `pg_get_functiondef` on 2026-10-09. Not applied to production by this change.

## What It Reuses

- The gate is the Hub's own integrity-review gate: `fn_ca_can_review_integrity(club)` (the club owner, a co_owner or admin not banned or suspended, or a platform admin through `fn_is_platform_admin()`), plus service_role. Anyone else is answered `{ok:false, code:'NOT_AUTHORIZED', reason:'NOT_AUTHORIZED'}` and learns nothing, not even whether a Cluster exists. anon has no EXECUTE on any door.
- The page is `fn_raise_server_financial_alert`, which keeps one open `financial_alerts` row per source and `context.dedupe_key`; its triggers carry a row to an incident and a resolution back. The freezes already page through it (`lightning_formation`, `lightning_settlement`, `LIGHTNING_CLUSTER_FROZEN`).
- The ledger is `cash_cluster_events` on its `(game_id, at)` index: `lightning_drive_error`, `lightning_pending_on_reap_failed`, `lightning_pending_off_reap_failed`, `cluster_frozen`. Mode transitions are `cash_cluster_epoch` and `cash_cluster_conversion`. The reconcile view is `fn_lightning_pool_stack` = anchor seat stack minus `fn_lightning_pool_exposure`.
- `fn_lightning_cluster_forensics` and `fn_lightning_hand_replay_check` are wrapped, never rewritten.

## The Operator Doors

All SECURITY DEFINER with a pinned search_path, executable by authenticated and service_role, every answer passed through `fn_lightning_operator_redact` (every key at any depth naming a card, hole, deck, seed or shuffle is dropped). None reads a hole card.

- `fn_lightning_operator_overview(p_club_id uuid)`: `{ok, club_id, as_of, truncated, clusters:[row]}`, at most 200 Clusters, counts only. A row is `{cluster_id, name, variant, sb, bb, handedness, lightning_enabled, cluster_mode, cluster_epoch, mode_since, on_threshold, off_threshold, live_eligible, worker_mode, flags:{shadow_matcher, integrity_telemetry, auto_rebuy, latency_telemetry}, pool:{joining, eligibility_check, active, sit_out, disconnected, leaving}, reservations:{pending, committed}, instances:{forming, reserved, dealing, settling}, orphan_reservations, blind_obligations_open, stuck_conversion, frozen, open_alerts, integrity_open_signals, shadow, latency}`.
- `fn_lightning_operator_cluster(p_cluster_id uuid, p_from timestamptz, p_to timestamptz)`: the row plus the latest 50 transitions (epochs, conversions, the freeze), open reservations, open blind obligations, the reconcile stack of every open pool session, `fn_lightning_shadow_report`, the latest 100 integrity signals, open alerts, the latest 60 latency windows, the latest quality score and the latest 20 matcher passes. Window default the last 24 hours, at most 90 days.
- `fn_lightning_operator_hand_replay(p_cluster_id uuid, p_hand_id uuid)`: replay hand, the replay check, the hand's public record, its players' arithmetic and its events.
- `fn_lightning_operator_session_trail(p_cluster_id uuid, p_pool_session_id uuid)`: replay player session and replay mode transition, an oldest-first trail of events, slots, reservations and hands, and the epochs and conversions it overlapped.
- `fn_lightning_operator_forensics(p_cluster_id uuid, p_from timestamptz, p_to timestamptz, p_limit integer)`: the forensic reader, gated and redacted.
- `fn_lightning_operator_signal_review(p_signal_id bigint, p_status text, p_note text)`: the one writing door. `lightning_integrity_signal.id` is a bigint, so the contract's name is kept and its type is bigint. Status reviewed, cleared or actioned, reviewer `auth.uid()`, one `integrity_signal_reviewed` event; idempotent; a rescan never overwrites it.

## The Latency Ledger

`fn_lightning_latency_report(p_cluster_id uuid, p_window_from timestamptz, p_window_to timestamptz, p_legs jsonb)`, service_role only, writes `lightning_latency_window`. Legs: `fold_ack`, `ack_to_idle`, `idle_to_match`, `match_to_hand`, `hand_to_first_render`, `fast_fold_to_next_hand`, `normal_fold_to_next_hand`, `fold_watch_to_next_hand`, each `{n, p50, p95, p99}`, all optional. Unknown legs, unknown members and any card, hole, deck or seed key are refused. Idempotent per Cluster and `window_from`; a different body answers `IDEMPOTENCY_CONFLICT`. Refused with `TELEMETRY_OFF` when the Cluster's `latency_telemetry` is false.

## The Alert Sweep

`fn_lightning_alert_sweep(p_now timestamptz)`, service_role only, runs every minute as cron job `lightning-alert-sweep-1m`, installed through `cron.schedule` and kept with `cron.alter_job` exactly as `20261009045421` uses the managed cron API. It is not in `fn_cash_clusters_tick_all`. Every check of every Cluster runs in its own exception block and a failure is a line in the answer, never a failed job; one pass runs at a time. It pages through source `lightning_alerts`:

- frozen (critical, `lightning_cluster_frozen:<cluster>`), when no freeze page is open from any freeze source;
- stuck_conversion (critical, `lightning_stuck_conversion:<conversion>`), a pending conversion older than `alert_stuck_conversion_ms`;
- drive_error (warning, `lightning_drive_error:<cluster>`), at least `alert_drive_errors` in the window;
- reaper_failure (critical, `lightning_reaper_failure:<cluster>`), a recorded reap failure or a live instance past its deadline by more than the window;
- integrity_spike (warning, `lightning_integrity_spike:<cluster>`), at least `alert_integrity_high_signals` new high-severity signals;
- latency_regression (warning, `lightning_latency_regression:<cluster>:<leg>`), the latest `alert_latency_windows` consecutive windows above `alert_latency_p95_ms.<leg>` with enough samples.

State pages (frozen, stuck_conversion, latency_regression) resolve themselves when a re-measure finds them gone; event pages stay for a person, and come back only for new events. The sweep also runs `fn_lightning_integrity_scan` once per clock hour for each Cluster whose config turns `integrity_telemetry` on and that is not frozen (at most five a pass, cadence in `lightning_alert_sweep_state`), and keeps 30 days of latency windows. It writes no Cluster state, so a frozen Cluster stays exactly as it froze.

## Configuration

A third `jsonb_build_object` in `fn_lightning_config` (the first is at 88 of 100 arguments; the Phase 11 second object is untouched), each key clamped and reported in `invalid`: `latency_telemetry` true, `latency_window_ms` 60000 (10000 → 600000), `alert_window_ms` 600000 (60000 → 86400000), `alert_stuck_conversion_ms` 1200000 (60000 → 86400000), `alert_drive_errors` 3, `alert_reaper_failures` 1, `alert_integrity_high_signals` 5 (each 1 → 100000), `alert_latency_windows` 3 (2 → 60), `alert_latency_min_samples` 20 (1 → 1000000), `alert_latency_p95_ms` per leg (fold_ack 500, ack_to_idle 500, idle_to_match 5000, match_to_hand 2000, hand_to_first_render 2000, fast_fold_to_next_hand 5000, normal_fold_to_next_hand 60000, fold_watch_to_next_hand 90000; each 10 → 3600000).

## Tables and Proofs

`lightning_latency_window` and `lightning_alert_sweep_state` have RLS on, no policy and no table or sequence privilege for any role, so the Phase 2 census of exactly seven Lightning tables granted to service*role stays true. Fourteen live proofs: both tables closed, the census, grants and pinned search_path on all thirteen functions, the anti-manipulation pin (matcher, legality, form_hand, match, match_plan, match_and_form and tick_all name no integrity, shadow, quality, latency, alert or operator term), the restated Phase 11 census of readers, Law 10.5, redaction on every door, the cron job, the config defaults, the indexes, the sweep's isolation and hands-off writes, and that the tick never calls the sweep. Phase 11's tenth proof (no `fn_lightning*` body outside its own doors names the signal store, the ledger or the score) is superseded by design and restated here with the Phase 12 doors excluded.

## Law 10.5

Nothing here reads is_horse or horse_id. A horse is counted, reconciled, replayed, timed and alerted on exactly as a human; the harness seats humans and horses at every table.

## Tests

- `scripts/dev/test-lightning-phase12-operator-alerts.sh`: 18 sections on PostgreSQL 17, port 55560, the real chain through `20261008161509`, production's default ACLs and autorevoke trigger, applied twice. Gate refusals (anon, a stranger, a plain member, a banned admin, another club's owner), every documented key, the exact reconcile stack, planted card keys never leaving a door, a frozen Cluster paged once across passes and never touched, a stuck pending_on, a failed reap, drive errors, an integrity spike, a latency regression over consecutive windows, the latency door's refusals and idempotency, the signal review surviving rescans, a failing check never failing the pass, the cron job and the config.
- Measured in the harness: overview of more than 60 Clusters p50 150 ms, p95 159 ms; Cluster detail p50 6.5 ms, p95 7.2 ms; latency report p50 0.24 ms; a sweep pass p50 6.1 ms, p95 6.3 ms.
- `tests/lightning-phase-12-operator-alerts.test.ts`: the static contract.
- CI: shard 1 of accounting_postgres, after the Phase 11 step. Schema manifest fragment `scripts/ci/schema-manifest.d/lightning-phase12-operator-alerts.json`; the ci.yml pin in `scripts/qualification/cash-native-hosted.manifest.json`; the cron roster moves 128 → 129.
