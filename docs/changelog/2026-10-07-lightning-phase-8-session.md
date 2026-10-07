# Lightning Phase 8: Multi-Table Limits, Session Statistics, Pool Status and Recent Hands

Migration `20261007212735_lightning_phase_8_multi_table_limits_session_statistics_pool.sql` (specification Phases 11, 12 and 13, the database side). One transaction with `SET LOCAL lock_timeout`; the only table altered is `lightning_hand_player`, and neither `tables` nor `table_seats` is locked. Every change to an existing body is an asserted substitution into the body PokerIQ-Production carries: the six bodies it rewrites were read from production with `pg_get_functiondef` and are byte-identical to the harness chain, and each anchor must appear exactly as often as stated or the file refuses. Not applied to production by this change.

## Multi-Table Limits Per Platform

Multi-table Lightning is one player playing in several Clusters at once, each with its own pool session and anchor seat. Nothing here lets one Cluster deal the same player two hands at once beyond what fast fold already allows.

- `fn_lightning_config` now answers `multi_table_limit` as an object `{desktop, tablet, mobile}`, defaults 4, 3 and 2, each clamped to 1..8. The old scalar configuration is still read: a number is the limit of every platform (so an existing `"multi_table_limit": 4` keeps meaning 4 everywhere). Out of range values clamp, wrong types fall back and unknown platforms are reported in `invalid`, exactly as every other key.
- `fn_lightning_player_legality`, `fn_lightning_match_plan`, `fn_lightning_match` and `fn_lightning_match_and_form` take a trailing `p_player_platforms jsonb DEFAULT NULL`, a map `{player_id: 'desktop' | 'tablet' | 'mobile'}`; a missing player or any other value is desktop. `MULTI_TABLE_LIMIT` compares the player's live Lightning hands in other Clusters (unchanged counting) with the limit of that player's platform, and its detail now carries `platform`. Each function was dropped and recreated from its production body with its ACL and comment restored and asserted identical, so every existing caller, positional or by name (the engine's `LightningRpc.ts`), keeps working and is treated as desktop.

## The Wait and the Showdown Are Recorded

- `lightning_hand_player.waited_ms integer`: set by the BEFORE INSERT trigger `trg_hand_player_records_its_wait` (`fn_lightning_hand_player_records_its_wait`) at formation, from the slot's `idle_since` to the hand's `formed_at`. A caller cannot supply it and it can never be rewritten (`LIGHTNING_WAIT_IS_FINAL`).
- `lightning_hand_player.showed boolean`: written by `fn_lightning_settle_hand` from the engine's own `showed` result in the same statement as the outcome, final once written (`LIGHTNING_SHOWDOWN_IS_FINAL`).

## Five Browser Doors

All five are SECURITY DEFINER with a pinned search path, ask `auth.uid()` (and `auth.role()` for the engine's service role), are executable by `authenticated` and `service_role` only, and write nothing. Asking about somebody else's session answers exactly what a session that does not exist answers.

- `fn_lightning_session_stats(p_pool_session_id uuid) RETURNS jsonb`: owner or service_role, otherwise NULL. `{pool_session_id, cluster_id, started_at, ended_at, duration_s, hands, hands_per_hour, starting_stack, current_stack, net, bb_per_100, vpip, pfr, avg_pot, showdowns, fast_folds, normal_folds, fold_and_watch, avg_wait_ms, p95_wait_ms, p99_wait_ms}` from the session's settled hand rows. VPIP and PFR come from `ca_hand_facts`, the per-hand per-player facts the cash VPIP gate and player statistics already read (keyed by `hand_history` id), so there is no competing source of truth; a hand not projected yet does not count, and with none both are null. P95 and P99 are nearest-rank (`percentile_disc`) over `waited_ms`.
- `fn_lightning_session_summary(p_pool_session_id uuid) RETURNS jsonb`: the statistics plus `{ended, exit_reason}`, for an open or exited session.
- `fn_lightning_my_sessions() RETURNS jsonb`: the caller's open pool sessions in every Cluster, `[{pool_session_id, cluster_id, name, stakes: {sb, bb}, variant, stack, in_hand}]`, no instance id.
- `fn_lightning_pool_status(p_cluster_id uuid) RETURNS jsonb`: `{cluster_mode, players, status}` for anyone the lobby policy `cash_games_read` shows the Cluster to (a private Cluster to its club's members), otherwise NULL. `players` is the live eligible count from `fn_cash_cluster_pool_health`; status is HOT in `lightning` at or above the Cluster's large diversity band (twice ON by default), ACTIVE at or above the medium band (ON), THIN below it or in `pending_off`, BUILDING in every other mode. No matcher internal or other player's eligibility is exposed.
- `fn_lightning_recent_hands(p_limit integer DEFAULT 50, p_pool_session_id uuid DEFAULT NULL) RETURNS jsonb`: the caller's own settled Lightning hands, newest first, at most 50, optionally one of their own sessions: `[{hand_id, hand_history_id, hand_number, played_at, cluster_id, small_blind, big_blind, position, stack_before, stack_after, net, pot, fold_type, showdown, result}]`, result `won`, `lost`, `folded` or `split` (split when another player won a pot this player also won, from the engine's recorded winners).

## Statistics Reset Rule

Nothing here writes a statistic. Entering or leaving Lightning resets no Cluster-level statistic, and the hand rows, `hand_history` rows and facts outlive the instance and the pool session.

## Proof

- `scripts/dev/test-lightning-phase8-session.sh`: 13 sections on PostgreSQL 17, port 55555, over the real Lightning chain through Phase 7 with humans and horses in every Cluster. Every earlier live proof still holds except exactly the seven that name the replaced argument lists, whose intent the file restates. Configuration defaults, scalar compatibility and bad values. A human and a horse in three Clusters with live hands in two are refused on mobile and legal on tablet and desktop; the old signatures answer desktop; `fn_lightning_match_and_form` honours the map. Real waits and showdowns, both final. Statistics from six real settled hands equal the settlement's counters, with VPIP and PFR from `ca_hand_facts` and nearest-rank wait percentiles. Recent hands ordering, results, limit, the cap at fifty over 52 hands and the session filter. Pool status BUILDING, ACTIVE, HOT and THIN, and the lobby policy under row security. My sessions across three Clusters. The summary after a real reversion with every `hand_history` row intact. Ownership refusals and grants. Every live proof; re-appliable.
- `tests/lightning-phase-8-session.test.ts`: the static contract.
- CI: shard 1, right after the Phase 7 harness.
