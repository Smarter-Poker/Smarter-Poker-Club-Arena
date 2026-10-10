-- 20261009235505_lightning_phase_13_rollout_drain_and_rollback.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- LIGHTNING PHASE 13 OF 14 (SPECIFICATION PHASE 22, THE DATABASE SIDE):
-- ROLLOUT, DRAIN AND ROLLBACK. The operator controls (pause, disable joins,
-- drain, freeze, matcher versions, feature flags), the EMERGENCY DRAIN as a
-- driven, audited state machine, and the rollout readiness verdict.
--
-- Owner rule: "Never strand players by simply toggling a flag." A drain is a
-- state machine the tick drives, not a boolean.
--
-- WHAT EXISTS AND IS REUSED, read from PokerIQ-Production on 2026-10-09
-- (latest Lightning file applied there: 20261009181945):
--   * THE CONTROL GATE. The operations rail's access 'control'
--     (src/config/clubOperationsNavigation.ts -> canControlClub) is platform
--     staff or the club roles owner / co_owner / admin
--     (src/config/clubArenaNavigation.ts CLUB_CONTROL_ROLES). Its SQL is
--     fn_ca_is_club_control(club, user) (20260906111420: owner, co_owner or
--     admin, active, or clubs.owner_id) beside fn_is_platform_admin(). The
--     write door uses exactly those two, plus service_role.
--   * THE FREEZE PATH. A freeze moves cash_games.cluster_mode to 'frozen' from
--     any live mode under the Cluster row lock, pages once through
--     fn_raise_server_financial_alert with dedupe key
--     lightning_cluster_frozen:<cluster> and message LIGHTNING_CLUSTER_FROZEN,
--     and records cluster_frozen. Recovery is fn_cash_cluster_unfreeze only.
--     The manual freeze takes the same transition, the same key, message and
--     event shape (reason / invariant operator_freeze), source
--     lightning_alerts (the dashboard and the sweep count all three freeze
--     sources). fn_lightning_settlement_freeze is not called, because it would
--     record a stack_invariant_failed event at stage settlement that never
--     happened: a freeze is evidence, and its evidence must be true.
--   * THE REVERSION PATH. fn_cash_cluster_begin_pending_off /
--     fn_cash_cluster_commit_must_move (Phase 7): every open pool session
--     exits, one pool_player_left each, slots close, reservations expire, the
--     next epoch opens in must_move, Lightning's halts lift, and the md5 over
--     every live seat, open cash session and the blind ledger is asserted
--     (LIGHTNING_REVERSION_MOVED_MONEY). The drain ends through it.
--   * THE FEATURE-FLAG ARCHITECTURE. The repository's one flag table,
--     club_entry_feature_flags (20260831150300), is platform-wide and CHECKs
--     its keys to create_club / find_player / join_club, so it is not
--     per-Cluster capable. Lightning's gates have always been per-Cluster
--     keys in cash_games.ruleset_snapshot -> 'lightning', read, clamped and
--     reported by fn_lightning_config (worker_mode, lightning_shadow_matcher,
--     auto_rebuy_enabled, integrity_telemetry) plus cash_games.lightning_enabled.
--     That is reused; no flag table is created.
--
-- DESIGN DECISIONS (each keeps every existing invariant):
--   * PAUSE is the existing 'paused' cluster_mode (cash_games_cluster_mode_check
--     already allows it), with the mode it was paused from kept in
--     lightning_cluster_control. Every existing body already treats it
--     correctly with no change: fn_lightning_form_hand and fn_lightning_pool_enter
--     refuse every mode but lightning, fn_lightning_instance_begin_dealing
--     voids a formation outside lightning, fn_lightning_player_legality holds
--     every player as CLUSTER_FROZEN, the drive answers mode_not_driven (no
--     conversion), the must-move tick and balancer stand down, and settlement
--     and the fold door refuse only 'frozen', so a hand already dealing plays
--     out and settles. A pause from lightning also voids, at once, every
--     formation not yet dealt (forming / reserved; nothing was dealt, no chip
--     moves). Pause is allowed from lightning and must_move (physical cash
--     tables keep dealing in a must-move pause; only the controller, the
--     balancer and the seat-change door stand down, exactly as in every
--     non-must_move mode). It is refused while a conversion or a drain is in
--     flight (CLUSTER_BUSY): the stuck-conversion reaper would otherwise
--     orphan the open conversion. RESUME returns to exactly paused_from, and a
--     resume to lightning enters every eligible seated player that sat down
--     during the pause through fn_lightning_pool_enter.
--   * JOINS are the config keys lightning_joins_enabled (default true) and
--     lightning_joins_disabled_at. fn_lightning_pool_enter answers NULL (its
--     refusal, as for every ineligible seat) for a player with no open pool
--     session while joins are closed; fn_lightning_player_legality holds a
--     session that entered after the close as LIGHTNING_JOINS_DISABLED;
--     fn_lightning_pool_status answers joinable false and joins_enabled false;
--     fn_lightning_reconnect_state answers joinable false; the lobby's
--     lightning key (fn_cash_cluster_lightning_state) carries joins_enabled.
--     Seated players keep playing. Enabling joins on a lightning Cluster
--     enters every eligible seated player who sat down while they were closed.
--   * THE DRAIN uses the existing 'draining' cluster_mode and a row in
--     lightning_cluster_drain, and is driven by fn_cash_cluster_lightning_drive
--     (fn_cash_clusters_tick_all now drives 'draining' and any Cluster with an
--     open drain) through fn_lightning_drain_advance:
--       from lightning (or a pause from lightning): lightning_enabled false,
--       cluster_mode draining, steps 1 (stop joins), 2 (stop formation) and 3
--       (let active hands finish) recorded at once. Every pass after: while a
--       hand is dealing or settling the drain WAITS, however long (a dealing
--       hand is never cut by the drain; only the existing formation reaper
--       ever voids a hand nothing vouches for). Past drain_timeout_ms (default
--       120000) every instance that never started dealing (forming / reserved)
--       is abandoned through fn_lightning_instance_abandon (no money moves;
--       begin_dealing voids such a formation outside lightning anyway). With
--       nothing in flight: step 4 (settle) is recorded, then
--       fn_cash_cluster_begin_pending_off (accepting draining only for its own
--       reason 'lightning_drain') and fn_cash_cluster_commit_must_move run in
--       the same transaction: every pool session exits 'lightning_drained',
--       the anchors are untouched, MUST-MOVE is rebuilt at a new epoch, the
--       md5 digest is asserted, then steps 5 (restore players), 6 (rebuild
--       MUST-MOVE), 7 (preserve stacks) and 8 (audit trail) are recorded and
--       the drain closes 'drained'.
--       from pending_off: the reversion already in flight finishes through
--       the drive (lightning disabled, so it can no longer abort); its pool
--       sessions exit 'lightning_drained'.
--       from pending_on: lightning disabled, the drive aborts the conversion
--       through the existing abort (Phase 5); outcome 'aborted_pending_on'.
--       from must_move: there is nothing in Lightning to drain; the flag is
--       cleared (and a must-move pause resumed).
--     A drained Cluster ends in must_move with lightning_enabled false, so it
--     cannot re-convert until an operator enables it again. A freeze (manual
--     or automatic) ends an open drain ('ended_by_frozen').
--   * MATCHER VERSIONS are config keys matcher_version (live),
--     matcher_version_previous, matcher_versions_disabled (text[]) and
--     shadow_matcher_version. Known versions: m1 (the SQL matcher,
--     fn_lightning_match_plan), m1-port and m2 (engine candidates). The live
--     matcher can only be a version the SQL matcher implements: m1.
--     fn_lightning_config now clamps an unknown, non-SQL or disabled
--     matcher_version back to m1 and reports it in invalid, reports
--     matcher_version_previous (default m1), matcher_versions_disabled and
--     shadow_matcher_disabled (the engine records no shadow while true).
--   * FLAGS (set_flag) map the Spec's names onto existing gates:
--       lightning_v1                 -> cash_games.lightning_enabled (through
--                                       enable_lightning / disable_lightning,
--                                       so off on a live Cluster IS the drain)
--       lightning_shadow_matcher     -> lightning_shadow_matcher
--       lightning_auto_rebuy         -> auto_rebuy_enabled
--       lightning_multi_table        -> multi_table_limit (off writes 1 on
--                                       every platform; on removes the
--                                       override, back to 4 / 3 / 2)
--       lightning_fast_fold          -> NEW key lightning_fast_fold (default
--       lightning_fold_watch            true) and lightning_fold_watch (default
--                                       true): engine kill switches for
--                                       LIGHTNING FOLD and FOLD & WATCH, the
--                                       engine's action door being the
--                                       enforcement point. Both features are
--                                       always on today; the default keeps it.
--       lightning_pool_health, lightning_session_stats -> FLAG_NOT_SUPPORTED:
--                                       read-only player displays from the
--                                       one population and statistics
--                                       readers; switching them off protects
--                                       nothing and would add a flag for its
--                                       own sake ("do not create flags
--                                       unnecessarily"). Reported true.
--       lightning_repeat_suppression, lightning_adaptive_liquidity ->
--                                       FLAG_NOT_SUPPORTED: they are the live
--                                       matcher's own P5 diversity and its
--                                       population bands; changing them
--                                       changes the live matcher, which goes
--                                       through a matcher version with shadow
--                                       evidence first, never a flag.
--                                       Reported true.
--
-- THE DOORS:
--
--   fn_lightning_operator_control(p_cluster_id uuid, p_action text,
--                                 p_reason text, p_args jsonb DEFAULT '{}')
--     SECURITY DEFINER, search_path pinned, authenticated + service_role,
--     never anon. Gate: service_role, fn_is_platform_admin(), or
--     fn_ca_is_club_control(<the Cluster's club>, auth.uid());
--     unfreeze: service_role or a platform admin only. Reason required
--     (3 .. 2000 characters). p_args.request_id (uuid) required: a repeat
--     with the same request id answers the first answer with idempotent:true
--     and replayed:true, and writes nothing; a request id used for another
--     Cluster or action is INVALID_ARGS. Every answer after the lock is kept
--     in lightning_operator_request. Every real change writes exactly one
--     cash_cluster_events row of kind operator_<action> {action, actor,
--     actor_kind, reason, request_id, args, before, after, detail, at} (and
--     the drain its lightning_drain_step rows), visible in
--     fn_lightning_operator_cluster and fn_lightning_operator_session_trail
--     transitions.
--     Actions and args:
--       pause, resume, disable_joins, enable_joins, drain, freeze, unfreeze,
--       enable_lightning, disable_lightning,
--       set_matcher_version {version, role: 'live' (default) | 'shadow'},
--       disable_matcher_version {version}, enable_matcher_version {version},
--       rollback_matcher_version, set_flag {flag, value: boolean},
--       set_worker_mode {mode: 'off' | 'shadow' | 'form'} (the engine
--       worker's configuration key worker_mode, a rollout stage rather than a
--       specification flag, so a pilot never needs a hand-written config).
--       A service_role caller may name the operator as actor_id (uuid);
--       unfreeze requires one.
--     Refusals {ok:false, code, reason}: NOT_AUTHORIZED, INVALID_ACTION,
--     REASON_REQUIRED, INVALID_ARGS, CLUSTER_NOT_FOUND, CLUSTER_FROZEN (any
--     action but freeze / unfreeze on a frozen Cluster), CLUSTER_BUSY (a
--     conversion or a drain in flight that the action would race),
--     UNKNOWN_VERSION, VERSION_DISABLED, NOT_SQL_MATCHER, FLAG_NOT_SUPPORTED.
--     An idempotent no-op answers ok:true, idempotent:true, already:true,
--     code ALREADY, after = before, event_id null, and writes no event.
--     Success {ok:true, idempotent:false, action, cluster_id, request_id,
--       before:<state>, after:<state>, event_id, detail}, where <state> is
--       {cluster_mode, cluster_epoch, lightning_enabled, paused, paused_from,
--        joins_enabled, drain: null | {drain_id, phase, from_mode,
--        requested_at, deadline_at}, matcher: {version, previous, disabled,
--        shadow_version, shadow_disabled}, flags: <spec flags>}.
--
--   fn_lightning_rollout_readiness(p_cluster_id uuid) -> jsonb
--     SECURITY DEFINER, authenticated + service_role, never anon, read-only,
--     the operator doors' gate (fn_lightning_operator_may). Refusals
--     NOT_AUTHORIZED, NOT_FOUND. Answer {ok:true, cluster_id, as_of, verdict:
--     'go' | 'no_go' | 'insufficient_evidence', reasons:[{code, severity:
--     'blocking' | 'evidence', detail}], evidence:{migrations:{expected,
--     applied, missing:[...]}, invariants:{seven_tables, anti_manipulation,
--     law_10_5, no_anon_door, proofs_evaluated_in_sql:false},
--     cluster:{cluster_mode, lightning_enabled, game_enabled, must_move,
--     frozen, paused, drain_open, worker_mode, live_eligible, on_threshold,
--     off_threshold, would_turn_on, club_is_public, game_is_private},
--     alerts:{open}, integrity:{open, open_high}, shadow:{scope:
--     'cluster' | 'estate' | null, aa_calibration: null | <pair>, candidate:
--     null | <pair>}, latency:{latest_window_to, over:[{leg, windows}]},
--     matcher:<the matcher object>}}.
--     The @live-proof lines live in the migration files and bin/proofs.sh
--     evaluates them; evaluating them in SQL would mean shipping every file's
--     text into the database, so this door re-derives the structural
--     invariants those proofs pin (the seven-tables census, the
--     anti-manipulation pin, Law 10.5 over every fn_lightning_ body, no
--     fn_lightning_ function executable by anon) and checks every Lightning
--     migration is recorded in supabase_migrations.schema_migrations.
--     Blocking: MIGRATIONS_MISSING, MIGRATION_LEDGER_UNREADABLE,
--     INVARIANT_FAILED, CLUSTER_FROZEN, CLUSTER_BUSY, CLUSTER_NOT_READY,
--     GAME_DISABLED, NOT_A_MUST_MOVE_GAME, OPEN_ALERTS,
--     INTEGRITY_HIGH_SIGNALS_OPEN, LATENCY_ABOVE_CEILING,
--     MATCHER_VERSION_INVALID, AA_CALIBRATION_BIAS, WORKER_OFF.
--     Evidence: NO_AA_CALIBRATION, NO_LATENCY_EVIDENCE, WORKER_SHADOW_ONLY.
--     verdict: no_go with any blocking reason, else insufficient_evidence with
--     any evidence reason, else go.
--
-- THE SERVICE'S OWN (service_role only):
--   fn_lightning_drain_advance(p_cluster_id uuid, p_now timestamptz DEFAULT NULL)
--     SECURITY DEFINER: one step of the drain state machine (above); answers
--     {ok:true, drain:null} | {ok:true, drain_id, phase, waiting, ...} |
--     {ok:true, drain_id, phase:'complete', outcome}.
--   fn_lightning_operator_may_control(uuid)       the write gate (STABLE)
--   fn_lightning_operator_state(uuid)             <state> above (STABLE)
--   fn_lightning_spec_flags(boolean, jsonb)       the ten Spec flags (IMMUTABLE)
--   fn_lightning_joins_enabled(uuid)              the joins key (STABLE)
--   fn_lightning_pool_enter_seated(uuid)          enter seated players
--
-- CHANGED BY ASSERTED SUBSTITUTION into the bodies production carries now:
--   fn_lightning_config (clamp and keys in its third object), fn_lightning_pool_enter,
--   fn_lightning_player_legality, fn_lightning_pool_status (joinable,
--   joins_enabled, draining), fn_lightning_reconnect_state (joinable),
--   fn_cash_cluster_lightning_state (joins_enabled), fn_cash_cluster_begin_pending_off,
--   fn_cash_cluster_commit_must_move ('lightning_drained', 'drained'),
--   fn_cash_cluster_lightning_drive (the draining branch and the advance),
--   fn_cash_clusters_tick_all (drives draining and open drains),
--   fn_lightning_operator_cluster_row (paused, paused_from, joins_enabled,
--   drain, matcher, the ten Spec flags inside flags, integrity_open_high),
--   fn_lightning_operator_cluster and fn_lightning_operator_session_trail
--   (operator and drain events among the transitions).
--
-- CONFIG (fn_lightning_config's third object, read, clamped and reported in
-- invalid like every other key): drain_timeout_ms 120000 (10000..3600000),
-- lightning_joins_enabled true, lightning_joins_disabled_at null (a
-- timestamp), matcher_version_previous 'm1' (a known version),
-- matcher_versions_disabled [] (known versions), shadow_matcher_disabled
-- (derived), lightning_fast_fold true, lightning_fold_watch true,
-- known_matcher_versions [m1, m1-port, m2], sql_matcher_versions [m1].
--
-- TABLES. lightning_operator_request (one row per operator request: the
-- idempotency key and the audit of every answer), lightning_cluster_control
-- (one row per Cluster: the pause), lightning_cluster_drain (one row per
-- drain; at most one open per Cluster). RLS on, no policy and NO table
-- privilege for any role, service_role included, so 20260920235343's census
-- of exactly seven Lightning tables granted to service_role stays true; only
-- the SECURITY DEFINER doors read and write them. No foreign key to any hot
-- table. The request and drain ledgers refuse TRUNCATE like every Lightning
-- history table.
--
-- ANTI-MANIPULATION. fn_lightning_player_legality reads the config key
-- lightning_joins_enabled (through the configuration it already read) and
-- calls no operator function; the anti-manipulation pin (form_hand,
-- legality, match, match_plan, match_and_form, tick_all contain none of
-- integrity, shadow_comparison, quality_, latency, lightning_alert,
-- fn_lightning_operator_) is restated below, as is 20261009181945's proof
-- that no seating body reads the telemetry stores (this file's new bodies
-- read none of them; the readiness door reads them only through the
-- dashboard row, the shadow report and the regression reader, all of which
-- the proof already admits).
--
-- LAW 10.5. Nothing here reads is_horse or horse_id. A horse is paused,
-- drained, released to its seat, re-entered and counted exactly as a human.
-- LIGHTNING IS OFF EVERYWHERE: on production every Cluster is must_move with
-- lightning_enabled false; no operator action runs by itself, no new body
-- moves money, and nothing here changes non-Lightning cash play.
--
-- @live-proof: (SELECT bool_and(c.relrowsecurity AND NOT EXISTS (SELECT 1 FROM pg_policy pol WHERE pol.polrelid = c.oid) AND NOT has_table_privilege('anon', c.oid, 'SELECT') AND NOT has_table_privilege('authenticated', c.oid, 'SELECT') AND NOT has_table_privilege('service_role', c.oid, 'SELECT') AND NOT has_table_privilege('service_role', c.oid, 'INSERT') AND NOT has_table_privilege('authenticated', c.oid, 'INSERT')) AND count(*) = 3 FROM pg_class c WHERE c.oid IN ('public.lightning_operator_request'::regclass, 'public.lightning_cluster_control'::regclass, 'public.lightning_cluster_drain'::regclass))
-- @live-proof: (SELECT count(*) = 7 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name LIKE 'lightning\_%' AND grantee = 'service_role' AND privilege_type = 'SELECT') AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name LIKE 'lightning\_%' AND grantee IN ('anon', 'authenticated', 'PUBLIC'))
-- @live-proof: (SELECT bool_and(p.prosecdef AND array_to_string(p.proconfig, ',') ~ 'search_path=' AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) AND count(*) = 2 FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure, 'public.fn_lightning_rollout_readiness(uuid)'::regprocedure))
-- @live-proof: (SELECT bool_and(array_to_string(p.proconfig, ',') ~ 'search_path=' AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND p.prosecdef = (p.proname = 'fn_lightning_drain_advance')) AND count(*) = 6 FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_drain_advance(uuid,timestamp with time zone)'::regprocedure, 'public.fn_lightning_operator_may_control(uuid)'::regprocedure, 'public.fn_lightning_operator_state(uuid)'::regprocedure, 'public.fn_lightning_spec_flags(boolean,jsonb)'::regprocedure, 'public.fn_lightning_joins_enabled(uuid)'::regprocedure, 'public.fn_lightning_pool_enter_seated(uuid)'::regprocedure))
-- @live-proof: (SELECT s ~ 'public\.fn_lightning_operator_may_control\(v_club\)' AND s ~ 'public\.fn_lightning_operator_state\(g\.id\)' AND s ~ '''operator_'' \|\| v_action' AND s ~ 'INSERT INTO public\.lightning_operator_request' AND s ~ 'FOR UPDATE' AND s ~ '''REASON_REQUIRED''' AND s ~ '''CLUSTER_FROZEN''' AND s ~ '''CLUSTER_BUSY''' AND s ~ '''NOT_SQL_MATCHER''' AND s ~ '''FLAG_NOT_SUPPORTED''' AND s ~ 'public\.fn_cash_cluster_unfreeze\(g\.id, v_actor, v_reason\)' AND s ~ 'public\.fn_raise_server_financial_alert\(' AND s ~ '''lightning_cluster_frozen:''' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q) AND (SELECT s ~ 'public\.fn_ca_is_club_control\(p_club_id, auth\.uid\(\)\)' AND s ~ 'public\.fn_is_platform_admin\(\)' AND s ~ 'service_role' FROM (SELECT pg_get_functiondef('public.fn_lightning_operator_may_control(uuid)'::regprocedure) AS s) q)
-- @live-proof: (SELECT position('IF v_live > 0 OR v_wait > 0 THEN' in s) > 0 AND position('IF v_live > 0 OR v_wait > 0 THEN' in s) < position('public.fn_cash_cluster_begin_pending_off(g.id, v_req, ''lightning_drain'')' in s) AND position('public.fn_cash_cluster_begin_pending_off(g.id, v_req, ''lightning_drain'')' in s) < position('public.fn_cash_cluster_commit_must_move(g.id, v_req)' in s) AND s ~ 'li\.state IN \(''forming'', ''reserved''\)\s+ORDER BY li\.id\s+FOR UPDATE' AND s ~ 'v_now >= d\.deadline_at' AND s !~ 'SET state = ''abandoned''' AND s !~ '''dealing'', ''settling''\)\s+ORDER BY li\.id\s+FOR UPDATE' AND s !~ 'UPDATE public\.(table_seats|cash_player_session|lightning_blind_ledger|lightning_pool_session)' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_drain_advance(uuid,timestamp with time zone)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT s ~ 'LIGHTNING_REVERSION_MOVED_MONEY' AND s ~ 'INTO v_locked_seats' AND s ~ 'INTO v_locked_sessions' AND s ~ 'CASE WHEN v_drained THEN ''lightning_drained'' ELSE ''lightning_off'' END' AND s ~ 'lightning_cluster_drain' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_commit_must_move(uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q) AND (SELECT s ~ 'g\.cluster_mode = ''draining'' AND p_reason IS NOT DISTINCT FROM ''lightning_drain''' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q) AND (SELECT s ~ 'LIGHTNING_CONVERSION_MOVED_MONEY' FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure) AS s) q) AND (SELECT s ~ 'LIGHTNING_UNFREEZE_MOVED_MONEY' FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_unfreeze(uuid,uuid,text)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ 'ELSIF g\.cluster_mode = ''draining'' THEN' AND s ~ 'public\.fn_lightning_drain_advance\(g\.id\)' AND position('public.fn_lightning_drain_advance(g.id)' in s) < position('EXCEPTION WHEN OTHERS THEN' in s) FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_lightning_drive(uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q) AND (SELECT s ~ '''pending_on'', ''lightning'', ''pending_off'', ''draining''' AND s ~ 'lightning_cluster_drain d' AND s ~ 'public\.fn_cash_cluster_lightning_drive\(lc\.id\)' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_clusters_tick_all(jsonb)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT bool_and(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') !~ 'integrity|shadow_comparison|quality_|latency|lightning_alert|fn_lightning_operator_') AND count(*) = 6 FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure, 'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure, 'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text,jsonb)'::regprocedure, 'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)'::regprocedure, 'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure, 'public.fn_cash_clusters_tick_all(jsonb)'::regprocedure))
-- @live-proof: (SELECT s ~ '''LIGHTNING_JOINS_DISABLED''' AND s ~ 'lightning_joins_enabled' AND s ~ 'public\.fn_lightning_config\(cg\.id\) AS lcfg' AND s ~ '>= f\.multi_table_limit THEN ' AND s ~ 'f\.stop_requested_at IS NOT NULL' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q) AND (SELECT s ~ 'IF NOT public\.fn_lightning_joins_enabled\(g\.id\) THEN' AND s ~ 'fn_rg_require_not_excluded\(s\.user_id\)' FROM (SELECT pg_get_functiondef('public.fn_lightning_pool_enter(uuid,timestamp with time zone)'::regprocedure) AS s) q) AND (SELECT s ~ '''joins_enabled''' AND s ~ '''draining''' AND s !~ '''cluster_mode'', g\.cluster_mode' FROM (SELECT pg_get_functiondef('public.fn_lightning_pool_status(uuid)'::regprocedure) AS s) q) AND (SELECT (length(s) - length(replace(s, 'AND public.fn_lightning_joins_enabled(g.id))', ''))) / length('AND public.fn_lightning_joins_enabled(g.id))') = 2 AND s !~ '''cluster_mode''' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_reconnect_state(uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q) AND public.fn_cash_cluster_lightning_state((SELECT id FROM public.cash_games ORDER BY created_at, id LIMIT 1)) ? 'joins_enabled'
-- @live-proof: (SELECT (c ->> 'drain_timeout_ms')::integer = 120000 AND (c ->> 'lightning_joins_enabled')::boolean AND c -> 'lightning_joins_disabled_at' = 'null'::jsonb AND c ->> 'matcher_version' = 'm1' AND c ->> 'matcher_version_previous' = 'm1' AND c -> 'matcher_versions_disabled' = '[]'::jsonb AND (c ->> 'shadow_matcher_disabled')::boolean = false AND (c ->> 'lightning_fast_fold')::boolean AND (c ->> 'lightning_fold_watch')::boolean AND c -> 'sql_matcher_versions' = '["m1"]'::jsonb AND c -> 'known_matcher_versions' = '["m1", "m1-port", "m2"]'::jsonb AND (c ->> 'latency_window_ms')::integer = 60000 AND c ? 'quality_weights' AND c ? 'multi_table_limit' FROM (SELECT public.fn_lightning_config(NULL) AS c) q)
-- @live-proof: (SELECT r ? 'paused' AND r ? 'paused_from' AND r ? 'joins_enabled' AND r ? 'drain' AND r ? 'matcher' AND r ? 'integrity_open_high' AND (r -> 'flags') ? 'lightning_v1' AND (r -> 'flags') ? 'lightning_adaptive_liquidity' AND (r -> 'flags') ? 'shadow_matcher' AND (r -> 'matcher') ? 'shadow_disabled' FROM (SELECT public.fn_lightning_operator_cluster_row((SELECT id FROM public.cash_games ORDER BY created_at, id LIMIT 1), now()) AS r) q) AND (SELECT s ~ 'lightning\\_drain%' AND s ~ 'operator\\_%' FROM (SELECT pg_get_functiondef('public.fn_lightning_operator_cluster(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure) AS s) q) AND (SELECT s ~ 'lightning\\_drain%' AND s ~ 'operator\\_%' FROM (SELECT pg_get_functiondef('public.fn_lightning_operator_session_trail(uuid,uuid)'::regprocedure) AS s) q)
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND (p.proname LIKE 'fn\_lightning\_%' OR p.proname LIKE 'fn\_cash\_cluster%') AND p.proname NOT IN ('fn_lightning_integrity_scan', 'fn_lightning_integrity_report', 'fn_lightning_quality_score', 'fn_lightning_quality_components', 'fn_lightning_shadow_record', 'fn_lightning_shadow_report', 'fn_lightning_config', 'fn_lightning_operator_overview', 'fn_lightning_operator_cluster', 'fn_lightning_operator_cluster_row', 'fn_lightning_operator_signal_review', 'fn_lightning_alert_sweep', 'fn_lightning_latency_report', 'fn_lightning_latency_regression') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'lightning_integrity_signal|lightning_integrity_engine_window|lightning_matcher_shadow_comparison|ca_collusion_signals|collusion_tracking|anti_cheat_flags|quality_score|quality_weights|fn_lightning_integrity_|lightning_latency_window|lightning_alert_sweep_state'))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_lightning_operator_control', 'fn_lightning_rollout_readiness', 'fn_lightning_drain_advance', 'fn_lightning_operator_may_control', 'fn_lightning_operator_state', 'fn_lightning_spec_flags', 'fn_lightning_joins_enabled', 'fn_lightning_pool_enter_seated', 'fn_lightning_config', 'fn_lightning_pool_enter', 'fn_lightning_player_legality', 'fn_lightning_pool_status', 'fn_lightning_reconnect_state', 'fn_cash_cluster_lightning_state', 'fn_cash_cluster_begin_pending_off', 'fn_cash_cluster_commit_must_move', 'fn_cash_cluster_lightning_drive', 'fn_cash_clusters_tick_all', 'fn_lightning_operator_cluster_row', 'fn_lightning_operator_cluster', 'fn_lightning_operator_session_trail') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id'))
-- @live-proof: (SELECT count(*) = 2 FROM pg_trigger t WHERE t.tgrelid IN ('public.lightning_operator_request'::regclass, 'public.lightning_cluster_drain'::regclass) AND t.tgfoid = 'public.fn_lightning_refuses_truncate()'::regprocedure) AND (SELECT i.indisunique AND pg_get_indexdef(i.indexrelid) ~ 'WHERE \(completed_at IS NULL\)' FROM pg_index i WHERE i.indexrelid = 'public.lightning_cluster_drain_one_open'::regclass) AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.contype = 'f' AND k.conrelid IN ('public.lightning_operator_request'::regclass, 'public.lightning_cluster_control'::regclass, 'public.lightning_cluster_drain'::regclass))
-- @live-proof: (SELECT pg_get_constraintdef(k.oid) ~ '''paused''' AND pg_get_constraintdef(k.oid) ~ '''draining''' FROM pg_constraint k WHERE k.conrelid = 'public.cash_games'::regclass AND k.conname = 'cash_games_cluster_mode_check') AND (SELECT pg_get_constraintdef(k.oid) ~ 'lightning' AND pg_get_constraintdef(k.oid) ~ 'pending_on' FROM pg_constraint k WHERE k.conrelid = 'public.lightning_cluster_drain'::regclass AND k.conname = 'lightning_cluster_drain_from_mode')

BEGIN;

SET LOCAL lock_timeout = '2s';

-- ===========================================================================
-- 1. THE TABLES. Three, all closed to every role; only the SECURITY DEFINER
--    doors below read and write them.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.lightning_operator_request (
  request_id  uuid PRIMARY KEY,
  cluster_id  uuid NOT NULL,
  action      text NOT NULL,
  actor       uuid,
  actor_kind  text NOT NULL,
  reason      text NOT NULL,
  args        jsonb NOT NULL DEFAULT '{}'::jsonb,
  answer      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT lightning_operator_request_actor_kind CHECK (actor_kind IN ('service', 'platform_admin', 'club_control')),
  CONSTRAINT lightning_operator_request_bounded CHECK (
    jsonb_typeof(args) = 'object' AND jsonb_typeof(answer) = 'object'
    AND octet_length(args::text) <= 4096 AND octet_length(answer::text) <= 65536
    AND length(reason) BETWEEN 3 AND 2000)
);

COMMENT ON TABLE public.lightning_operator_request IS
  'Lightning Phase 13 (20261009235505): one row per Lightning operator request through fn_lightning_operator_control - the idempotency key (request_id) and the audit of every answer given after the Cluster lock. Written only by that door. RLS on, no role holds a privilege. History: TRUNCATE is refused.';

CREATE INDEX IF NOT EXISTS lightning_operator_request_by_cluster
  ON public.lightning_operator_request (cluster_id, created_at DESC);

ALTER TABLE public.lightning_operator_request ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lightning_operator_request FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.lightning_cluster_control (
  cluster_id        uuid PRIMARY KEY,
  paused_from       text,
  paused_at         timestamptz,
  paused_by         uuid,
  paused_reason     text,
  paused_request_id uuid,
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT lightning_cluster_control_paused_from CHECK (paused_from IS NULL OR paused_from IN ('lightning', 'must_move')),
  CONSTRAINT lightning_cluster_control_pause_is_whole CHECK ((paused_from IS NULL) = (paused_at IS NULL))
);

COMMENT ON TABLE public.lightning_cluster_control IS
  'Lightning Phase 13 (20261009235505): the operator pause of one Cluster - the mode it was paused from (lightning or must_move), when, by whom and why. Read only while cash_games.cluster_mode is paused; resume returns to exactly paused_from. Written only by fn_lightning_operator_control. RLS on, no role holds a privilege.';

ALTER TABLE public.lightning_cluster_control ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lightning_cluster_control FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.lightning_cluster_drain (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id       uuid NOT NULL,
  request_id       uuid NOT NULL,
  requested_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  requested_by     uuid,
  actor_kind       text NOT NULL,
  reason           text NOT NULL,
  from_mode        text NOT NULL,
  epoch_at_request integer NOT NULL,
  deadline_at      timestamptz NOT NULL,
  phase            text NOT NULL,
  conversion_id    uuid,
  steps            integer[] NOT NULL DEFAULT ARRAY[]::integer[],
  counts           jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at     timestamptz,
  outcome          text,
  CONSTRAINT lightning_cluster_drain_request_once UNIQUE (request_id),
  CONSTRAINT lightning_cluster_drain_phase CHECK (phase IN ('finishing', 'reverting', 'complete')),
  CONSTRAINT lightning_cluster_drain_from_mode CHECK (from_mode IN ('lightning', 'paused', 'pending_on', 'pending_off')),
  CONSTRAINT lightning_cluster_drain_closes_whole CHECK (
    (phase = 'complete') = (completed_at IS NOT NULL) AND (completed_at IS NULL) = (outcome IS NULL)),
  CONSTRAINT lightning_cluster_drain_counts_bounded CHECK (
    jsonb_typeof(counts) = 'object' AND octet_length(counts::text) <= 16384)
);

COMMENT ON TABLE public.lightning_cluster_drain IS
  'Lightning Phase 13 (20261009235505): the EMERGENCY DRAIN of one Cluster - opened by fn_lightning_operator_control (drain, disable_lightning, set_flag lightning_v1 false), advanced only by fn_lightning_drain_advance from fn_cash_cluster_lightning_drive, closed drained / aborted_pending_on / ended_by_frozen. steps lists the specification steps already recorded as lightning_drain_step events. At most one open per Cluster. RLS on, no role holds a privilege. History: TRUNCATE is refused.';

CREATE UNIQUE INDEX IF NOT EXISTS lightning_cluster_drain_one_open
  ON public.lightning_cluster_drain (cluster_id) WHERE (completed_at IS NULL);
CREATE INDEX IF NOT EXISTS lightning_cluster_drain_by_cluster
  ON public.lightning_cluster_drain (cluster_id, requested_at DESC);

ALTER TABLE public.lightning_cluster_drain ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lightning_cluster_drain FROM PUBLIC, anon, authenticated, service_role;

DO $tr$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lightning_operator_request', 'lightning_cluster_drain'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = ('public.' || t)::regclass
                    AND tg.tgname = 'trg_' || t || '_refuses_truncate') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.fn_lightning_refuses_truncate()',
                     'trg_' || t || '_refuses_truncate', t);
    END IF;
  END LOOP;
END
$tr$;

-- ===========================================================================
-- 2. THE REWRITER, in the shape 20261008050805 cut it and 20261009144343
--    reused: an asserted substitution into the body the database carries.
--    Every anchor must appear exactly as often as stated or the file
--    refuses; a body already carrying the marker is left alone, so the file
--    is re-appliable; who may execute and the comment must survive.
-- ===========================================================================

CREATE OR REPLACE FUNCTION pg_temp.lp13_rewrite(p_fn text, p_marker text,
                                              p_from text[], p_to text[], p_counts integer[])
RETURNS void LANGUAGE plpgsql AS $rw$
DECLARE
  v_src     text;
  v_new     text;
  v_n       integer;
  k         integer;
  v_roles   constant text[] := ARRAY['anon', 'authenticated', 'service_role'];
  v_had     boolean[];
  v_bad     text;
  v_comment text;
BEGIN
  v_src := pg_get_functiondef(p_fn::regprocedure);
  IF position(p_marker in v_src) > 0 THEN
    RETURN;
  END IF;
  v_new := v_src;
  FOR k IN 1 .. array_length(p_from, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_from[k], ''))) / length(p_from[k]);
    IF v_n IS DISTINCT FROM p_counts[k] THEN
      RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', p_fn, k, v_n, p_counts[k];
    END IF;
    v_new := replace(v_new, p_from[k], p_to[k]);
  END LOOP;
  SELECT array_agg(has_function_privilege(t.r, p_fn::regprocedure, 'EXECUTE') ORDER BY t.ord)
    INTO v_had FROM unnest(v_roles) WITH ORDINALITY t(r, ord);
  v_comment := obj_description(p_fn::regprocedure, 'pg_proc');
  EXECUTE v_new;
  SELECT string_agg(t.r || ': had ' || v_had[t.ord] || ', has '
                    || has_function_privilege(t.r, p_fn::regprocedure, 'EXECUTE'), '; ')
    INTO v_bad
    FROM unnest(v_roles) WITH ORDINALITY t(r, ord)
   WHERE has_function_privilege(t.r, p_fn::regprocedure, 'EXECUTE') IS DISTINCT FROM v_had[t.ord];
  IF v_bad IS NOT NULL OR obj_description(p_fn::regprocedure, 'pg_proc') IS DISTINCT FROM v_comment THEN
    RAISE EXCEPTION '% did not keep who may execute (%) and its comment', p_fn, coalesce(v_bad, 'comment');
  END IF;
  IF position(p_marker in pg_get_functiondef(p_fn::regprocedure)) = 0 THEN
    RAISE EXCEPTION '% does not read back carrying %', p_fn, p_marker;
  END IF;
END
$rw$;

-- ===========================================================================
-- 3. fn_lightning_config: the live matcher is clamped to a version the SQL
--    matcher implements and that is not disabled, and the Phase 13 keys are
--    answered in its THIRD object (the first is at 88 of its 100 arguments;
--    the Phase 11 second object is left as it is). Three anchors, each kept
--    in the result so a later substitution still finds it exactly once.
-- ===========================================================================

SELECT pg_temp.lp13_rewrite(
  'public.fn_lightning_config(uuid)',
  '''drain_timeout_ms''',
  ARRAY[$a$  v_lc_k     text;
$a$,
        $a$
  RETURN CASE WHEN v_found THEN '{}'::jsonb
$a$,
        $a$    'alert_latency_p95_ms', v_lc)
$a$],
  ARRAY[$b$  v_lc_k     text;
  v_p13_drain    integer;
  v_p13_joins    boolean;
  v_p13_closed   timestamptz;
  v_p13_prev     text;
  v_p13_off      text[];
  v_p13_bad      boolean;
  v_p13_known    text[];
  v_p13_ff       boolean;
  v_p13_fw       boolean;
$b$,
        $b$
  -- LIGHTNING PHASE 13 (20261009235505): ROLLOUT, DRAIN AND ROLLBACK. The
  -- drain's deadline for formations that never dealt, the pool's door
  -- (joins), the matcher versions (the live one is a version the SQL matcher
  -- implements and that is not disabled; a disabled shadow version records
  -- nothing) and the engine's kill switches for LIGHTNING FOLD and FOLD &
  -- WATCH. Written by fn_lightning_operator_control.
  v_p13_known := ARRAY['m1', 'm1-port', 'm2'];
  r := public.fn_lightning_config_number(v_cfg, 'drain_timeout_ms', 120000, 10000, 3600000, true);
  v_p13_drain := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  v_p13_joins := true;
  IF v_cfg ? 'lightning_joins_enabled' AND jsonb_typeof(v_cfg -> 'lightning_joins_enabled') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'lightning_joins_enabled') = 'boolean' THEN
      v_p13_joins := (v_cfg ->> 'lightning_joins_enabled')::boolean;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'lightning_joins_enabled', 'given', v_cfg -> 'lightning_joins_enabled',
                                           'reason', 'wrong_type', 'used', v_p13_joins);
    END IF;
  END IF;
  v_p13_closed := NULL;
  IF NOT v_p13_joins AND v_cfg ? 'lightning_joins_disabled_at'
     AND jsonb_typeof(v_cfg -> 'lightning_joins_disabled_at') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'lightning_joins_disabled_at') = 'string' THEN
      BEGIN
        v_p13_closed := (v_cfg ->> 'lightning_joins_disabled_at')::timestamptz;
      EXCEPTION WHEN data_exception THEN
        v_inv := v_inv || jsonb_build_object('key', 'lightning_joins_disabled_at', 'given', v_cfg -> 'lightning_joins_disabled_at',
                                             'reason', 'not_a_timestamp', 'used', NULL);
      END;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'lightning_joins_disabled_at', 'given', v_cfg -> 'lightning_joins_disabled_at',
                                           'reason', 'wrong_type', 'used', NULL);
    END IF;
  END IF;
  v_p13_off := ARRAY[]::text[];
  IF v_cfg ? 'matcher_versions_disabled' AND jsonb_typeof(v_cfg -> 'matcher_versions_disabled') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'matcher_versions_disabled') = 'array' THEN
      SELECT coalesce(array_agg(DISTINCT y.e ORDER BY y.e) FILTER (WHERE y.e = ANY (v_p13_known)), ARRAY[]::text[]),
             coalesce(bool_or(y.e IS NULL OR NOT (y.e = ANY (v_p13_known))), false)
        INTO v_p13_off, v_p13_bad
        FROM jsonb_array_elements(v_cfg -> 'matcher_versions_disabled') x(v)
       CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(x.v) = 'string' THEN x.v #>> '{}' END AS e) y;
      IF v_p13_bad THEN
        v_inv := v_inv || jsonb_build_object('key', 'matcher_versions_disabled', 'given', v_cfg -> 'matcher_versions_disabled',
                                             'reason', 'unknown_version', 'used', to_jsonb(v_p13_off));
      END IF;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'matcher_versions_disabled', 'given', v_cfg -> 'matcher_versions_disabled',
                                           'reason', 'wrong_type', 'used', to_jsonb(v_p13_off));
    END IF;
  END IF;
  -- THE LIVE MATCHER IS THE SQL MATCHER. fn_lightning_match_plan implements
  -- one algorithm, m1; a hand labelled with any other live version would
  -- name a matcher that never seated it.
  IF v_version IS DISTINCT FROM 'm1' THEN
    v_inv := v_inv || jsonb_build_object('key', 'matcher_version', 'given', v_version,
                                         'reason', CASE WHEN v_version = ANY (v_p13_known) THEN 'not_a_sql_matcher'
                                                        ELSE 'unknown_version' END,
                                         'used', 'm1');
    v_version := 'm1';
  ELSIF v_version = ANY (v_p13_off) THEN
    v_inv := v_inv || jsonb_build_object('key', 'matcher_version', 'given', v_version,
                                         'reason', 'version_disabled', 'used', 'm1');
  END IF;
  v_p13_prev := 'm1';
  IF v_cfg ? 'matcher_version_previous' AND jsonb_typeof(v_cfg -> 'matcher_version_previous') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'matcher_version_previous') = 'string'
       AND (v_cfg ->> 'matcher_version_previous') = ANY (v_p13_known) THEN
      v_p13_prev := v_cfg ->> 'matcher_version_previous';
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'matcher_version_previous', 'given', v_cfg -> 'matcher_version_previous',
                                           'reason', 'unknown_version', 'used', v_p13_prev);
    END IF;
  END IF;
  v_p13_ff := true;
  IF v_cfg ? 'lightning_fast_fold' AND jsonb_typeof(v_cfg -> 'lightning_fast_fold') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'lightning_fast_fold') = 'boolean' THEN
      v_p13_ff := (v_cfg ->> 'lightning_fast_fold')::boolean;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'lightning_fast_fold', 'given', v_cfg -> 'lightning_fast_fold',
                                           'reason', 'wrong_type', 'used', v_p13_ff);
    END IF;
  END IF;
  v_p13_fw := true;
  IF v_cfg ? 'lightning_fold_watch' AND jsonb_typeof(v_cfg -> 'lightning_fold_watch') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'lightning_fold_watch') = 'boolean' THEN
      v_p13_fw := (v_cfg ->> 'lightning_fold_watch')::boolean;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'lightning_fold_watch', 'given', v_cfg -> 'lightning_fold_watch',
                                           'reason', 'wrong_type', 'used', v_p13_fw);
    END IF;
  END IF;

  RETURN CASE WHEN v_found THEN '{}'::jsonb
$b$,
        $b$    'alert_latency_p95_ms', v_lc,
    -- LIGHTNING PHASE 13 (20261009235505): rollout, drain and rollback.
    'drain_timeout_ms', v_p13_drain,
    'lightning_joins_enabled', v_p13_joins,
    'lightning_joins_disabled_at', v_p13_closed,
    'matcher_version_previous', v_p13_prev,
    'matcher_versions_disabled', to_jsonb(v_p13_off),
    'shadow_matcher_disabled', v_sh_ver = ANY (v_p13_off),
    'lightning_fast_fold', v_p13_ff,
    'lightning_fold_watch', v_p13_fw,
    'known_matcher_versions', to_jsonb(v_p13_known),
    'sql_matcher_versions', to_jsonb(ARRAY['m1']))
$b$],
  ARRAY[1, 1, 1]);

-- ===========================================================================
-- 4. THE JOINS KEY, read the way fn_lightning_config reads it (a JSON boolean
--    false closes the door; anything else leaves it open), cheaply, for the
--    seat trigger's path and the browser doors.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_joins_enabled(p_cluster_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce((SELECT NOT (jsonb_typeof(cg.ruleset_snapshot #> '{lightning,lightning_joins_enabled}') = 'boolean'
                               AND (cg.ruleset_snapshot #>> '{lightning,lightning_joins_enabled}') = 'false')
                     FROM public.cash_games cg WHERE cg.id = p_cluster_id), true);
$fn$;

COMMENT ON FUNCTION public.fn_lightning_joins_enabled(uuid) IS
  'Lightning Phase 13 (20261009235505): whether the Cluster''s Lightning pool takes new players - false only when ruleset_snapshot -> lightning -> lightning_joins_enabled is the JSON boolean false, exactly as fn_lightning_config reads it. Read by fn_lightning_pool_enter, fn_lightning_reconnect_state and fn_cash_cluster_lightning_state. service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_joins_enabled(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_joins_enabled(uuid) TO service_role;

-- ===========================================================================
-- 5. THE TEN SPECIFICATION FLAGS, with their effective values, from the
--    Cluster's flag and its clean configuration.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_spec_flags(p_lightning_enabled boolean, p_cfg jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT jsonb_build_object(
    'lightning_v1', coalesce(p_lightning_enabled, false),
    'lightning_fast_fold', coalesce((p_cfg ->> 'lightning_fast_fold')::boolean, true),
    'lightning_fold_watch', coalesce((p_cfg ->> 'lightning_fold_watch')::boolean, true),
    'lightning_multi_table', coalesce((SELECT max(x.v::integer)
                                         FROM jsonb_each_text(CASE WHEN jsonb_typeof(p_cfg -> 'multi_table_limit') = 'object'
                                                                   THEN p_cfg -> 'multi_table_limit' ELSE '{}'::jsonb END) x(k, v)), 2) > 1,
    'lightning_pool_health', true,
    'lightning_repeat_suppression', true,
    'lightning_session_stats', true,
    'lightning_shadow_matcher', coalesce((p_cfg ->> 'lightning_shadow_matcher')::boolean, false),
    'lightning_auto_rebuy', coalesce((p_cfg ->> 'auto_rebuy_enabled')::boolean, false),
    'lightning_adaptive_liquidity', true);
$fn$;

COMMENT ON FUNCTION public.fn_lightning_spec_flags(boolean, jsonb) IS
  'Lightning Phase 13 (20261009235505): the specification''s ten Lightning flags with their effective values - lightning_v1 is cash_games.lightning_enabled, the rest map onto fn_lightning_config keys; lightning_pool_health, lightning_repeat_suppression, lightning_session_stats and lightning_adaptive_liquidity are always on and have no switch (FLAG_NOT_SUPPORTED). service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_spec_flags(boolean, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_spec_flags(boolean, jsonb) TO service_role;

-- ===========================================================================
-- 6. THE LOBBY'S ONE LIGHTNING READER says whether the pool takes players.
-- ===========================================================================

SELECT pg_temp.lp13_rewrite(
  'public.fn_cash_cluster_lightning_state(uuid)',
  'fn_lightning_joins_enabled',
  ARRAY[$a$      'confidence', 'partial'));
$a$],
  ARRAY[$b$      'confidence', 'partial'),
    -- LIGHTNING PHASE 13 (20261009235505): whether the pool takes new
    -- players (an operator can close it while seated players play on).
    'joins_enabled', public.fn_lightning_joins_enabled(g.id));
$b$],
  ARRAY[1]);

-- ===========================================================================
-- 7. THE POOL DOOR refuses a newcomer while joins are closed. A player who
--    already holds an open pool session (a seat change, a re-seat) is not a
--    newcomer and is answered as before.
-- ===========================================================================

SELECT pg_temp.lp13_rewrite(
  'public.fn_lightning_pool_enter(uuid,timestamp with time zone)',
  'fn_lightning_joins_enabled',
  ARRAY[$a$  SELECT cps.id INTO v_cps
    FROM public.cash_player_session cps
$a$],
  ARRAY[$b$  -- LIGHTNING PHASE 13 (20261009235505): JOINS CAN BE CLOSED. An operator's
  -- disable_joins closes the pool to newcomers; the door's refusal is its
  -- NULL, as for every other ineligible seat, and the player's seat and
  -- cash session are untouched.
  IF NOT public.fn_lightning_joins_enabled(g.id) THEN
    RETURN NULL;
  END IF;

  SELECT cps.id INTO v_cps
    FROM public.cash_player_session cps
$b$],
  ARRAY[1]);

-- ===========================================================================
-- 8. P0 HOLDS A SESSION THAT ENTERED AFTER JOINS CLOSED. The configuration
--    is read once, as before (the CTE is materialized); its multi-table
--    limits are read from the same answer.
-- ===========================================================================

SELECT pg_temp.lp13_rewrite(
  'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)',
  'LIGHTNING_JOINS_DISABLED',
  ARRAY[$a$           public.fn_lightning_config(cg.id) -> 'multi_table_limit' AS multi_table_limits
$a$,
        $a$coalesce((g.multi_table_limits ->> CASE$a$,
        $a$           ps.stop_requested_at,
$a$,
        $a$        WHEN f.stop_requested_at IS NOT NULL THEN 'STOP_REQUESTED'
$a$,
        $a$              WHEN 'STOP_REQUESTED' THEN jsonb_build_object('stop_requested_at', c.stop_requested_at)
$a$],
  ARRAY[$b$           public.fn_lightning_config(cg.id) AS lcfg
$b$,
        $b$coalesce(((g.lcfg -> 'multi_table_limit') ->> CASE$b$,
        $b$           ps.stop_requested_at,
           -- LIGHTNING PHASE 13 (20261009235505): when the pool closed to
           -- newcomers, and when this session entered it.
           ps.entered_at AS pool_entered_at,
           CASE WHEN (g.lcfg ->> 'lightning_joins_enabled')::boolean IS FALSE
                THEN (g.lcfg ->> 'lightning_joins_disabled_at')::timestamptz END AS joins_closed_at,
$b$,
        $b$        -- LIGHTNING PHASE 13 (20261009235505): a session that entered after
        -- an operator closed joins is held; everyone already in plays on.
        WHEN f.joins_closed_at IS NOT NULL AND f.pool_entered_at >= f.joins_closed_at THEN 'LIGHTNING_JOINS_DISABLED'
        WHEN f.stop_requested_at IS NOT NULL THEN 'STOP_REQUESTED'
$b$,
        $b$              WHEN 'LIGHTNING_JOINS_DISABLED' THEN jsonb_build_object('joins_disabled_at', c.joins_closed_at)
              WHEN 'STOP_REQUESTED' THEN jsonb_build_object('stop_requested_at', c.stop_requested_at)
$b$],
  ARRAY[1, 1, 1, 1, 1]);

-- ===========================================================================
-- 9. THE PLAYER'S POOL STATUS: joinable is false while joins are closed; it
--    says so (joins_enabled) and says when Lightning is ending (draining),
--    and still never leaks cluster_mode.
-- ===========================================================================

SELECT pg_temp.lp13_rewrite(
  'public.fn_lightning_pool_status(uuid)',
  '''joins_enabled''',
  ARRAY[$a$    'joinable', (g.cluster_mode = 'lightning' AND coalesce(g.lightning_enabled, false) AND g.enabled IS TRUE),
$a$],
  ARRAY[$b$    'joinable', (g.cluster_mode = 'lightning' AND coalesce(g.lightning_enabled, false) AND g.enabled IS TRUE
                 AND coalesce((v_cfg ->> 'lightning_joins_enabled')::boolean, true)),
    -- LIGHTNING PHASE 13 (20261009235505): the pool closed to newcomers by an
    -- operator, and Lightning ending (an emergency drain in flight).
    'joins_enabled', coalesce((v_cfg ->> 'lightning_joins_enabled')::boolean, true),
    'draining', (g.cluster_mode = 'draining'
                 OR EXISTS (SELECT 1 FROM public.lightning_cluster_drain d
                             WHERE d.cluster_id = g.id AND d.completed_at IS NULL)),
$b$],
  ARRAY[1]);

SELECT pg_temp.lp13_rewrite(
  'public.fn_lightning_reconnect_state(uuid)',
  'fn_lightning_joins_enabled',
  ARRAY[$a$'joinable', (g.cluster_mode = 'lightning' AND coalesce(g.lightning_enabled, false) AND g.enabled IS TRUE)$a$],
  ARRAY[$b$'joinable', (g.cluster_mode = 'lightning' AND coalesce(g.lightning_enabled, false) AND g.enabled IS TRUE AND public.fn_lightning_joins_enabled(g.id))$b$],
  ARRAY[2]);

-- ===========================================================================
-- 10. THE REVERSION'S BEGIN accepts a draining Cluster, for the drain's own
--     call only (reason 'lightning_drain'); every other caller is answered
--     wrong_state as before, so a drive pass that read 'lightning' a moment
--     before the drain began cannot open the reversion under it. The
--     conversion records the mode it truly left.
-- ===========================================================================

SELECT pg_temp.lp13_rewrite(
  'public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)',
  '''lightning_drain''',
  ARRAY[$a$  IF g.cluster_mode IS DISTINCT FROM 'lightning' THEN
    RETURN jsonb_build_object('ok', false,
$a$,
        $a$    g.id, p_request_id, 'lightning', 'must_move',
$a$],
  ARRAY[$b$  -- LIGHTNING PHASE 13 (20261009235505): the emergency drain ends through
  -- this path; a draining Cluster is admitted for the drain alone.
  IF g.cluster_mode IS DISTINCT FROM 'lightning'
     AND NOT (g.cluster_mode = 'draining' AND p_reason IS NOT DISTINCT FROM 'lightning_drain') THEN
    RETURN jsonb_build_object('ok', false,
$b$,
        $b$    g.id, p_request_id, g.cluster_mode, 'must_move',
$b$],
  ARRAY[1, 1]);

-- ===========================================================================
-- 11. THE REVERSION'S COMMIT names a drained session for what it was:
--     exit_reason 'lightning_drained' while an emergency drain is open.
--     Nothing else changes: the same locks, the same digests, the same
--     LIGHTNING_REVERSION_MOVED_MONEY.
-- ===========================================================================

SELECT pg_temp.lp13_rewrite(
  'public.fn_cash_cluster_commit_must_move(uuid,uuid)',
  'lightning_drained',
  ARRAY[$a$  v_locked_sessions uuid[];
$a$,
        $a$  WITH exited AS (
    UPDATE public.lightning_pool_session ps
$a$,
        $a$           exit_reason = 'lightning_off',
$a$,
        $a$'anchor_seat_id', e.anchor_seat_id, 'reason', 'lightning_off',$a$,
        $a$    'chip_total', v_chips, 'money_md5', v_before), p_request_id);$a$,
        $a$    'chip_total', v_chips, 'population_at_commit', v_live);$a$],
  ARRAY[$b$  v_locked_sessions uuid[];
  v_drained         boolean := false;
$b$,
        $b$  -- LIGHTNING PHASE 13 (20261009235505): AN EMERGENCY DRAIN SAYS SO. The
  -- sessions a drain releases exit 'lightning_drained', the ones a falling
  -- population releases 'lightning_off'; the transition is the same.
  v_drained := EXISTS (SELECT 1 FROM public.lightning_cluster_drain d
                        WHERE d.cluster_id = g.id AND d.completed_at IS NULL);
  WITH exited AS (
    UPDATE public.lightning_pool_session ps
$b$,
        $b$           exit_reason = CASE WHEN v_drained THEN 'lightning_drained' ELSE 'lightning_off' END,
$b$,
        $b$'anchor_seat_id', e.anchor_seat_id, 'reason', CASE WHEN v_drained THEN 'lightning_drained' ELSE 'lightning_off' END,$b$,
        $b$    'chip_total', v_chips, 'money_md5', v_before, 'drained', v_drained), p_request_id);$b$,
        $b$    'chip_total', v_chips, 'population_at_commit', v_live, 'drained', v_drained);$b$],
  ARRAY[1, 1, 1, 1, 1, 1]);

-- ===========================================================================
-- 12. THE SEATED ENTER THE POOL: every eligible seated player of the Cluster
--     without an open pool session, through the pool door, after the live
--     seats are taken FOR SHARE in seat-id order (fn_cash_cluster_abort_pending_off's
--     own shape). The caller holds the Cluster row.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_pool_enter_seated(p_cluster_id uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  s   record;
  v_n integer := 0;
BEGIN
  PERFORM 1 FROM public.table_seats ts
   WHERE ts.left_at IS NULL
     AND ts.table_id IN (SELECT tb.id FROM public.tables tb WHERE tb.cluster_id = p_cluster_id)
   ORDER BY ts.id
     FOR SHARE;
  FOR s IN
    SELECT DISTINCT ON (ts.user_id) ts.id, ts.user_id
      FROM public.table_seats ts
      JOIN public.tables tb ON tb.id = ts.table_id
     WHERE tb.cluster_id = p_cluster_id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
       AND public.fn_lightning_anchor_is_live_eligible(ts.id, p_cluster_id, ts.user_id)
       AND NOT EXISTS (SELECT 1 FROM public.lightning_pool_session ps
                        WHERE ps.cluster_id = p_cluster_id AND ps.player_id = ts.user_id
                          AND ps.exited_at IS NULL)
     ORDER BY ts.user_id, ts.joined_at, ts.id
  LOOP
    IF public.fn_lightning_pool_enter(s.id, clock_timestamp()) IS NOT NULL THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_pool_enter_seated(uuid) IS
  'Lightning Phase 13 (20261009235505): enters every eligible seated player of a Lightning Cluster who has no open pool session through fn_lightning_pool_enter (seats FOR SHARE in seat-id order first), answering how many entered. Called by fn_lightning_operator_control on resume to lightning and on enable_joins. service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_pool_enter_seated(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pool_enter_seated(uuid) TO service_role;

-- ===========================================================================
-- 13. THE EMERGENCY DRAIN, one step per call, driven by
--     fn_cash_cluster_lightning_drive. See the header for the state machine.
--     It never writes a seat, a cash session, the blind ledger or a pool
--     session itself: the reversion does, through its asserted digest.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_drain_advance(p_cluster_id uuid, p_now timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_now       timestamptz := LEAST(coalesce(p_now, clock_timestamp()), clock_timestamp());
  d           record;
  g           record;
  i           record;
  v_conv      record;
  v_mode      text;
  v_wait      integer;
  v_live      integer;
  v_open      integer;
  v_abandoned integer := 0;
  v_req       uuid;
  v_res       jsonb;
  v_commit    jsonb;
  v_off       jsonb;
  v_outcome   text;
  v_c         jsonb;
  v_chips     numeric;
  v_events    integer;
BEGIN
  SELECT * INTO d FROM public.lightning_cluster_drain x
   WHERE x.cluster_id = p_cluster_id AND x.completed_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'drain', NULL);
  END IF;
  SELECT cg.cluster_mode INTO v_mode FROM public.cash_games cg WHERE cg.id = p_cluster_id;

  -- THE CHEAP COUNTS, before any lock: what has not dealt, what is dealing.
  SELECT count(*) FILTER (WHERE li.state IN ('forming', 'reserved'))::integer,
         count(*) FILTER (WHERE li.state IN ('dealing', 'settling'))::integer
    INTO v_wait, v_live
    FROM public.lightning_instance li
   WHERE li.cluster_id = p_cluster_id AND li.state IN ('forming', 'reserved', 'dealing', 'settling');

  IF v_mode = 'draining' THEN
    -- STEP 3, LET ACTIVE HANDS FINISH. A hand dealing or settling is waited
    -- for, whatever the deadline says.
    IF NOT (v_live = 0 AND v_wait = 0) AND NOT (v_now >= d.deadline_at AND v_wait > 0) THEN
      RETURN jsonb_build_object('ok', true, 'drain_id', d.id, 'phase', d.phase, 'waiting', true,
                                'hands_remaining', v_live, 'instances_remaining', v_wait,
                                'deadline_at', d.deadline_at, 'overdue', v_now >= d.deadline_at);
    END IF;

    -- THE CLUSTER ROW FIRST, in the order every formation, conversion and
    -- operator action takes it, then the drain.
    SELECT * INTO g FROM public.cash_games cg WHERE cg.id = p_cluster_id FOR UPDATE;
    SELECT * INTO d FROM public.lightning_cluster_drain x
     WHERE x.id = d.id AND x.completed_at IS NULL FOR UPDATE;
    IF NOT FOUND OR g.cluster_mode IS DISTINCT FROM 'draining' THEN
      RETURN jsonb_build_object('ok', true, 'drain_id', d.id, 'raced', true);
    END IF;

    -- THE DEADLINE: an instance that never started dealing is void. The
    -- state is asked again under each row's lock, so a formation that began
    -- dealing a moment ago is skipped and waited for like any other hand.
    IF v_now >= d.deadline_at THEN
      FOR i IN
        SELECT li.id FROM public.lightning_instance li
         WHERE li.cluster_id = g.id AND li.state IN ('forming', 'reserved')
         ORDER BY li.id
         FOR UPDATE
      LOOP
        PERFORM public.fn_lightning_instance_abandon(i.id,
          'lightning drain: past its deadline, a hand that never started dealing is void; nothing was dealt and no chip moved',
          clock_timestamp());
        v_abandoned := v_abandoned + 1;
      END LOOP;
      IF v_abandoned > 0 THEN
        INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
        VALUES (g.id, 'lightning_drain_timeout', jsonb_build_object(
          'drain_id', d.id, 'request_id', d.request_id, 'deadline_at', d.deadline_at,
          'instances_abandoned', v_abandoned, 'at', clock_timestamp()), d.request_id);
        UPDATE public.lightning_cluster_drain x
           SET counts = x.counts || jsonb_build_object('timeout_abandoned',
                          coalesce((x.counts ->> 'timeout_abandoned')::integer, 0) + v_abandoned)
         WHERE x.id = d.id
        RETURNING * INTO d;
      END IF;
    END IF;

    SELECT count(*) FILTER (WHERE li.state IN ('forming', 'reserved'))::integer,
           count(*) FILTER (WHERE li.state IN ('dealing', 'settling'))::integer
      INTO v_wait, v_live
      FROM public.lightning_instance li
     WHERE li.cluster_id = g.id AND li.state IN ('forming', 'reserved', 'dealing', 'settling');
    IF v_live > 0 OR v_wait > 0 THEN
      RETURN jsonb_build_object('ok', true, 'drain_id', d.id, 'phase', d.phase, 'waiting', true,
                                'hands_remaining', v_live, 'instances_remaining', v_wait,
                                'instances_abandoned', v_abandoned,
                                'deadline_at', d.deadline_at, 'overdue', v_now >= d.deadline_at);
    END IF;

    -- STEP 4, SETTLE ACTIVE HANDS: every hand that was in flight has settled.
    IF NOT (4 = ANY (d.steps)) THEN
      SELECT jsonb_build_object(
               'hands_settled', count(*) FILTER (WHERE li.state = 'complete'),
               'hands_void_never_dealt', count(*) FILTER (WHERE li.state = 'abandoned' AND li.started_at IS NULL),
               'hands_void_after_dealing', count(*) FILTER (WHERE li.state = 'abandoned' AND li.started_at IS NOT NULL))
        INTO v_c
        FROM public.lightning_instance li
       WHERE li.cluster_id = g.id AND li.cluster_epoch = d.epoch_at_request
         AND li.state IN ('complete', 'abandoned')
         AND (li.completed_at >= d.requested_at
              OR (li.completed_at IS NULL AND li.created_at >= d.requested_at - interval '1 hour'
                  AND (li.abandon_reason LIKE 'lightning drain:%'
                       OR li.abandon_reason LIKE 'begin_dealing refused: cluster_is_not_lightning%')));
      INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
      VALUES (g.id, 'lightning_drain_step', jsonb_build_object(
        'drain_id', d.id, 'request_id', d.request_id, 'step', 4, 'name', 'settle_active_hands',
        'hands_in_flight', 0, 'at', clock_timestamp()) || v_c, d.request_id);
      UPDATE public.lightning_cluster_drain x SET steps = x.steps || 4 WHERE x.id = d.id RETURNING * INTO d;
    END IF;

    -- STEP 6 BEGINS: THE EXISTING REVERSION PATH. Same transaction, so the
    -- pool is never left open behind a closed door.
    v_req := md5('lightning-drain:' || d.id::text)::uuid;
    v_res := public.fn_cash_cluster_begin_pending_off(g.id, v_req, 'lightning_drain');
    IF coalesce((v_res ->> 'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'LIGHTNING_DRAIN_COULD_NOT_BEGIN_THE_REVERSION: cluster % drain %: %', g.id, d.id, v_res
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.lightning_cluster_drain x
       SET phase = 'reverting', conversion_id = (v_res ->> 'conversion_id')::uuid
     WHERE x.id = d.id
    RETURNING * INTO d;
    v_commit := public.fn_cash_cluster_commit_must_move(g.id, v_req);
    IF coalesce((v_commit ->> 'reverted')::boolean, false) IS NOT TRUE THEN
      RETURN jsonb_build_object('ok', true, 'drain_id', d.id, 'phase', d.phase, 'waiting', true,
                                'conversion_id', d.conversion_id, 'commit', v_commit);
    END IF;
    v_mode := 'must_move';
  ELSIF v_mode IN ('pending_off', 'pending_on') THEN
    -- The reversion already in flight (pending_off) commits, and the
    -- conversion in flight (pending_on) aborts, through the drive's own
    -- branch: lightning is disabled, so neither can turn back.
    RETURN jsonb_build_object('ok', true, 'drain_id', d.id, 'phase', d.phase, 'waiting', true,
                              'cluster_mode', v_mode, 'hands_remaining', v_live,
                              'instances_remaining', v_wait, 'conversion_id', d.conversion_id);
  END IF;

  -- THE DRAIN ENDS. The Cluster row first, then the drain.
  SELECT * INTO g FROM public.cash_games cg WHERE cg.id = p_cluster_id FOR UPDATE;
  SELECT * INTO d FROM public.lightning_cluster_drain x
   WHERE x.id = d.id AND x.completed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'raced', true);
  END IF;

  IF g.cluster_mode IS DISTINCT FROM 'must_move' THEN
    -- A freeze, a dead game or anything else ended it: the drain records
    -- that and closes, and touches nothing of the Cluster (a frozen Cluster
    -- is evidence).
    v_outcome := 'ended_by_' || coalesce(g.cluster_mode, 'missing');
    INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
    VALUES (g.id, 'lightning_drain_ended', jsonb_build_object(
      'drain_id', d.id, 'request_id', d.request_id, 'outcome', v_outcome, 'cluster_mode', g.cluster_mode,
      'steps_recorded', to_jsonb(d.steps), 'at', clock_timestamp()), d.request_id);
    UPDATE public.lightning_cluster_drain x
       SET phase = 'complete', completed_at = clock_timestamp(), outcome = v_outcome
     WHERE x.id = d.id;
    RETURN jsonb_build_object('ok', true, 'drain_id', d.id, 'phase', 'complete', 'outcome', v_outcome);
  END IF;

  SELECT * INTO v_conv FROM public.cash_cluster_conversion cc
   WHERE cc.cluster_id = g.id
     AND (cc.id = d.conversion_id
          OR (d.conversion_id IS NULL AND cc.status <> 'pending' AND cc.closed_at >= d.requested_at))
   ORDER BY (cc.id = d.conversion_id) DESC, cc.closed_at DESC NULLS LAST
   LIMIT 1;
  v_outcome := CASE WHEN v_conv.status = 'aborted' THEN 'aborted_pending_on' ELSE 'drained' END;
  SELECT e.payload INTO v_off FROM public.cash_cluster_events e
   WHERE e.game_id = g.id AND e.at >= d.requested_at AND e.kind = 'lightning_off'
     AND e.payload ->> 'conversion_id' = v_conv.id::text
   ORDER BY e.at DESC, e.id DESC LIMIT 1;

  IF NOT (4 = ANY (d.steps)) THEN
    SELECT jsonb_build_object(
             'hands_settled', count(*) FILTER (WHERE li.state = 'complete'),
             'hands_void_never_dealt', count(*) FILTER (WHERE li.state = 'abandoned' AND li.started_at IS NULL),
             'hands_void_after_dealing', count(*) FILTER (WHERE li.state = 'abandoned' AND li.started_at IS NOT NULL))
      INTO v_c
      FROM public.lightning_instance li
     WHERE li.cluster_id = g.id AND li.cluster_epoch = d.epoch_at_request
       AND li.state IN ('complete', 'abandoned')
       AND (li.completed_at >= d.requested_at
            OR (li.completed_at IS NULL AND li.created_at >= d.requested_at - interval '1 hour'
                AND (li.abandon_reason LIKE 'lightning drain:%'
                     OR li.abandon_reason LIKE 'begin_dealing refused: cluster_is_not_lightning%')));
    INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
    VALUES (g.id, 'lightning_drain_step', jsonb_build_object(
      'drain_id', d.id, 'request_id', d.request_id, 'step', 4, 'name', 'settle_active_hands',
      'hands_in_flight', 0, 'at', clock_timestamp()) || v_c, d.request_id);
  END IF;

  -- STEP 5, RESTORE PLAYERS TO A SAFE STABLE STATE: every pool session is
  -- closed, each player on the anchor seat they never left.
  SELECT jsonb_build_object(
           'pool_sessions_drained', count(*) FILTER (WHERE ps.exit_reason = 'lightning_drained'),
           'anchors_intact', count(*) FILTER (WHERE ps.exit_reason = 'lightning_drained' AND ts.id IS NOT NULL
                                               AND ts.left_at IS NULL AND ts.user_id = ps.player_id),
           'pool_sessions_left_otherwise', count(*) FILTER (WHERE ps.exit_reason IS DISTINCT FROM 'lightning_drained'),
           'pool_sessions_open', (SELECT count(*) FROM public.lightning_pool_session o
                                   WHERE o.cluster_id = g.id AND o.exited_at IS NULL))
    INTO v_c
    FROM public.lightning_pool_session ps
    LEFT JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
   WHERE ps.cluster_id = g.id AND ps.exited_at >= d.requested_at;
  INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
  VALUES (g.id, 'lightning_drain_step', jsonb_build_object(
    'drain_id', d.id, 'request_id', d.request_id, 'step', 5, 'name', 'restore_players',
    'at', clock_timestamp()) || v_c, d.request_id);

  -- STEP 6, REBUILD MUST-MOVE: the reversion (or the aborted conversion).
  INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
  VALUES (g.id, 'lightning_drain_step', jsonb_build_object(
    'drain_id', d.id, 'request_id', d.request_id, 'step', 6, 'name', 'rebuild_must_move',
    'path', CASE WHEN v_conv.status = 'aborted' THEN 'fn_cash_cluster_abort_pending_on'
                 ELSE 'fn_cash_cluster_commit_must_move' END,
    'conversion_id', v_conv.id, 'conversion_status', v_conv.status, 'abort_reason', v_conv.abort_reason,
    'epoch_before', v_conv.epoch_before, 'epoch_after', v_conv.epoch_after, 'cluster_epoch', g.cluster_epoch,
    'cluster_mode', g.cluster_mode, 'lightning_enabled', coalesce(g.lightning_enabled, false),
    'tables_released', v_off -> 'tables_released', 'tables_still_halted', v_off -> 'tables_still_halted',
    'at', clock_timestamp()), d.request_id);

  -- STEP 7, PRESERVE ALL STACKS: the reversion asserted its md5 over every
  -- live seat, open cash session and the blind ledger before and after
  -- (LIGHTNING_REVERSION_MOVED_MONEY); the totals are recorded beside it.
  SELECT coalesce(sum(ts.stack), 0) INTO v_chips
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = g.id AND ts.left_at IS NULL;
  INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
  VALUES (g.id, 'lightning_drain_step', jsonb_build_object(
    'drain_id', d.id, 'request_id', d.request_id, 'step', 7, 'name', 'preserve_stacks',
    'digest_asserted', v_conv.status = 'committed', 'money_md5', v_off -> 'money_md5',
    'chips_at_begin', v_conv.chips_at_begin, 'chips_at_commit', v_conv.chips_at_commit,
    'chips_at_request', d.counts -> 'chips_at_request', 'chips_now', v_chips,
    'at', clock_timestamp()), d.request_id);

  -- STEP 8, THE AUDIT TRAIL: this record and every event of the drain.
  SELECT count(*)::integer INTO v_events FROM public.cash_cluster_events e
   WHERE e.game_id = g.id AND e.at >= d.requested_at - interval '1 second'
     AND (e.kind LIKE 'lightning\_drain%' OR e.kind LIKE 'operator\_%')
     AND (e.payload ->> 'drain_id' = d.id::text OR e.request_id = d.request_id);
  INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
  VALUES (g.id, 'lightning_drain_step', jsonb_build_object(
    'drain_id', d.id, 'request_id', d.request_id, 'step', 8, 'name', 'audit_trail',
    'outcome', v_outcome, 'events', v_events + 1, 'from_mode', d.from_mode,
    'requested_at', d.requested_at, 'requested_by', d.requested_by, 'reason', d.reason,
    'duration_ms', floor(extract(epoch FROM (clock_timestamp() - d.requested_at)) * 1000)::bigint,
    'at', clock_timestamp()), d.request_id);

  UPDATE public.lightning_cluster_drain x
     SET phase = 'complete', completed_at = clock_timestamp(), outcome = v_outcome,
         conversion_id = coalesce(x.conversion_id, v_conv.id),
         steps = (SELECT array_agg(DISTINCT u.n ORDER BY u.n) FROM unnest(x.steps || ARRAY[4, 5, 6, 7, 8]) u(n)),
         counts = x.counts || jsonb_build_object('chips_at_completion', v_chips)
   WHERE x.id = d.id;

  RETURN jsonb_build_object('ok', true, 'drain_id', d.id, 'phase', 'complete', 'outcome', v_outcome,
                            'conversion_id', v_conv.id, 'cluster_mode', g.cluster_mode,
                            'instances_abandoned', v_abandoned);
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_drain_advance(uuid, timestamptz) IS
  'Lightning Phase 13 (20261009235505): one step of a Cluster''s EMERGENCY DRAIN, called by fn_cash_cluster_lightning_drive. Draining: waits while any hand is dealing or settling (never cuts one), past drain_timeout_ms abandons the instances that never started dealing (fn_lightning_instance_abandon), then records step 4 and reverts through fn_cash_cluster_begin_pending_off (reason lightning_drain) and fn_cash_cluster_commit_must_move in one transaction. In must_move records steps 5 to 8 and closes the drain (drained / aborted_pending_on); any other end (a freeze) closes it ended_by_<mode>. Writes no seat, cash session, blind ledger or pool session itself. service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_drain_advance(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_drain_advance(uuid, timestamptz) TO service_role;

-- ===========================================================================
-- 14. THE DRIVE drives the drain: a draining Cluster is driven, and every
--     Cluster with an open drain advances it after its own step, inside the
--     same isolating sub-block (a failure is a lightning_drive_error).
-- ===========================================================================

SELECT pg_temp.lp13_rewrite(
  'public.fn_cash_cluster_lightning_drive(uuid)',
  'fn_lightning_drain_advance',
  ARRAY[$a$  v_message  text;
BEGIN
$a$,
        $a$  ELSE
    v_action := 'mode_not_driven';
  END IF;
$a$,
        $a$ELSE jsonb_build_object('result', v_res) END;
$a$],
  ARRAY[$b$  v_message  text;
  v_drain    jsonb;
BEGIN
$b$,
        $b$  ELSIF g.cluster_mode = 'draining' THEN
    -- LIGHTNING PHASE 13 (20261009235505): the emergency drain's own mode;
    -- its step is the advance below.
    v_action := 'drain';
  ELSE
    v_action := 'mode_not_driven';
  END IF;

  -- LIGHTNING PHASE 13 (20261009235505): THE EMERGENCY DRAIN ADVANCES HERE,
  -- after the Cluster's own step (a pending_off committed, a pending_on
  -- aborted), so a drain whose reversion just landed closes in the same
  -- pass.
  IF EXISTS (SELECT 1 FROM public.lightning_cluster_drain d
              WHERE d.cluster_id = g.id AND d.completed_at IS NULL) THEN
    v_drain := public.fn_lightning_drain_advance(g.id);
  END IF;
$b$,
        $b$ELSE jsonb_build_object('result', v_res) END
    || CASE WHEN v_drain IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('drain', v_drain) END;
$b$],
  ARRAY[1, 1, 1]);

-- ===========================================================================
-- 15. THE TICK drives every draining Cluster and every Cluster with an open
--     drain (a drain whose Cluster is already in must_move closes there).
-- ===========================================================================

SELECT pg_temp.lp13_rewrite(
  'public.fn_cash_clusters_tick_all(jsonb)',
  'lightning_cluster_drain',
  ARRAY[$a$        OR cg.cluster_mode IN ('pending_on', 'lightning', 'pending_off')
$a$],
  ARRAY[$b$        OR cg.cluster_mode IN ('pending_on', 'lightning', 'pending_off', 'draining')
        -- LIGHTNING PHASE 13 (20261009235505): an emergency drain is driven
        -- until it closes.
        OR EXISTS (SELECT 1 FROM public.lightning_cluster_drain d
                    WHERE d.cluster_id = cg.id AND d.completed_at IS NULL)
$b$],
  ARRAY[1]);

-- ===========================================================================
-- 16. ONE CLUSTER'S DASHBOARD ROW gains the operator state: paused and the
--     mode it was paused from, whether joins are open, the drain and its
--     progress, the matcher versions, the ten specification flags (inside
--     flags, beside the four Phase 12 keys) and the open high-severity
--     integrity signals.
-- ===========================================================================

SELECT pg_temp.lp13_rewrite(
  'public.fn_lightning_operator_cluster_row(uuid,timestamp with time zone)',
  'integrity_open_high',
  ARRAY[$a$  v_stuck_ms integer;
$a$,
        $a$  v_cfg := public.fn_lightning_config(g.id);
$a$,
        $a$  v_since := CASE WHEN$a$,
        $a$                  WHEN g.cluster_mode = 'frozen' AND v_fz_at IS NOT NULL THEN v_fz_at
$a$,
        $a$      'latency_telemetry', coalesce((v_cfg ->> 'latency_telemetry')::boolean, false)),
$a$,
        $a$    'latency', v_lat);
$a$],
  ARRAY[$b$  v_stuck_ms integer;
  v_p13_d     record;
  v_p13_c     record;
  v_p13_high  integer;
  v_p13_drain jsonb;
$b$,
        $b$  v_cfg := public.fn_lightning_config(g.id);
  -- LIGHTNING PHASE 13 (20261009235505): the open drain, the pause and the
  -- open high-severity signals.
  SELECT x.id, x.phase, x.requested_at, x.requested_by, x.reason, x.from_mode, x.deadline_at
    INTO v_p13_d
    FROM public.lightning_cluster_drain x WHERE x.cluster_id = g.id AND x.completed_at IS NULL;
  SELECT x.paused_from, x.paused_at INTO v_p13_c
    FROM public.lightning_cluster_control x WHERE x.cluster_id = g.id;
  SELECT count(*)::integer INTO v_p13_high FROM public.lightning_integrity_signal s
   WHERE s.cluster_id = g.id AND s.status = 'open' AND s.severity = 'high';
$b$,
        $b$  v_p13_drain := CASE WHEN v_p13_d.id IS NULL THEN NULL ELSE jsonb_build_object(
    'drain_id', v_p13_d.id, 'phase', v_p13_d.phase, 'requested_at', v_p13_d.requested_at,
    'requested_by', v_p13_d.requested_by, 'reason', v_p13_d.reason, 'from_mode', v_p13_d.from_mode,
    'deadline_at', v_p13_d.deadline_at, 'overdue', v_now >= v_p13_d.deadline_at,
    'instances_remaining', coalesce((v_inst ->> 'forming')::integer, 0) + coalesce((v_inst ->> 'reserved')::integer, 0),
    'hands_remaining', coalesce((v_inst ->> 'dealing')::integer, 0) + coalesce((v_inst ->> 'settling')::integer, 0),
    'sessions_remaining', coalesce((SELECT sum(x.v::integer) FROM jsonb_each_text(v_pool) x(k, v)), 0)) END;
  v_since := CASE WHEN$b$,
        $b$                  WHEN g.cluster_mode = 'paused' AND v_p13_c.paused_at IS NOT NULL THEN v_p13_c.paused_at
                  WHEN g.cluster_mode = 'draining' AND v_p13_d.id IS NOT NULL THEN v_p13_d.requested_at
                  WHEN g.cluster_mode = 'frozen' AND v_fz_at IS NOT NULL THEN v_fz_at
$b$,
        $b$      'latency_telemetry', coalesce((v_cfg ->> 'latency_telemetry')::boolean, false))
      -- LIGHTNING PHASE 13 (20261009235505): the specification's ten flags.
      || public.fn_lightning_spec_flags(g.lightning_enabled, v_cfg),
$b$,
        $b$    'latency', v_lat,
    -- LIGHTNING PHASE 13 (20261009235505): the operator state.
    'paused', g.cluster_mode = 'paused',
    'paused_from', CASE WHEN g.cluster_mode = 'paused' THEN v_p13_c.paused_from END,
    'joins_enabled', coalesce((v_cfg ->> 'lightning_joins_enabled')::boolean, true),
    'drain', v_p13_drain,
    'matcher', jsonb_build_object(
      'version', v_cfg -> 'matcher_version',
      'previous', v_cfg -> 'matcher_version_previous',
      'disabled', coalesce(v_cfg -> 'matcher_versions_disabled', '[]'::jsonb),
      'shadow_version', v_cfg -> 'shadow_matcher_version',
      'shadow_disabled', coalesce((v_cfg ->> 'shadow_matcher_disabled')::boolean, false)),
    'integrity_open_high', coalesce(v_p13_high, 0));
$b$],
  ARRAY[1, 1, 1, 1, 1, 1]);

-- ===========================================================================
-- 17. THE TRANSITIONS an operator replays carry every operator action and
--     every drain step (REPLAY MODE TRANSITION).
-- ===========================================================================

SELECT pg_temp.lp13_rewrite(
  'public.fn_lightning_operator_cluster(uuid,timestamp with time zone,timestamp with time zone)',
  'lightning\_drain%',
  ARRAY[$a$     WHERE jsonb_typeof(v_row -> 'frozen') = 'object' AND v_row -> 'frozen' ->> 'at' IS NOT NULL
  )
$a$],
  ARRAY[$b$     WHERE jsonb_typeof(v_row -> 'frozen') = 'object' AND v_row -> 'frozen' ->> 'at' IS NOT NULL
    UNION ALL
    -- LIGHTNING PHASE 13 (20261009235505): every operator action and every
    -- step of an emergency drain.
    SELECT o.at,
           jsonb_build_object('kind', CASE WHEN o.kind LIKE 'operator\_%' THEN 'operator' ELSE 'drain' END,
                              'at', o.at, 'event_id', o.id, 'event_kind', o.kind,
                              'cluster_epoch', o.cluster_epoch, 'request_id', o.request_id,
                              'payload', o.payload)
      FROM (SELECT * FROM public.cash_cluster_events ev
             WHERE ev.game_id = g.id AND ev.at >= v_from AND ev.at <= v_to
               AND (ev.kind LIKE 'operator\_%' OR ev.kind LIKE 'lightning\_drain%')
             ORDER BY ev.at DESC, ev.id DESC LIMIT 50) o
  )
$b$],
  ARRAY[1]);

SELECT pg_temp.lp13_rewrite(
  'public.fn_lightning_operator_session_trail(uuid,uuid)',
  'lightning\_drain%',
  ARRAY[$a$     WHERE c.cluster_id = g.id AND c.opened_at <= v_end AND coalesce(c.closed_at, 'infinity'::timestamptz) >= v_start
  )
$a$],
  ARRAY[$b$     WHERE c.cluster_id = g.id AND c.opened_at <= v_end AND coalesce(c.closed_at, 'infinity'::timestamptz) >= v_start
    UNION ALL
    -- LIGHTNING PHASE 13 (20261009235505): the operator actions and drain
    -- steps the session lived through.
    SELECT o.at,
           jsonb_build_object('kind', CASE WHEN o.kind LIKE 'operator\_%' THEN 'operator' ELSE 'drain' END,
                              'at', o.at, 'event_id', o.id, 'event_kind', o.kind,
                              'cluster_epoch', o.cluster_epoch, 'request_id', o.request_id,
                              'payload', o.payload)
      FROM (SELECT * FROM public.cash_cluster_events ev
             WHERE ev.game_id = g.id AND ev.at >= v_start AND ev.at <= v_end
               AND (ev.kind LIKE 'operator\_%' OR ev.kind LIKE 'lightning\_drain%')
             ORDER BY ev.at, ev.id LIMIT 100) o
  )
$b$],
  ARRAY[1]);

-- ===========================================================================
-- 18. THE WRITE GATE: the service, a platform admin, or a member holding the
--     club's control role (fn_ca_is_club_control: owner, co_owner or admin,
--     active; or the club's owner_id) - the operations rail's 'control'.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_operator_may_control(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce(auth.role(), '') = 'service_role'
      OR (auth.uid() IS NOT NULL
          AND (coalesce(public.fn_is_platform_admin(), false)
               OR (p_club_id IS NOT NULL
                   AND coalesce(public.fn_ca_is_club_control(p_club_id, auth.uid()), false))));
$fn$;

COMMENT ON FUNCTION public.fn_lightning_operator_may_control(uuid) IS
  'Lightning Phase 13 (20261009235505): the Lightning operator CONTROL gate - service_role (auth.role()), or a signed-in platform admin (fn_is_platform_admin), or a club control member (fn_ca_is_club_control: owner, co_owner or admin, active, or clubs.owner_id), the SQL of the operations rail''s access control. service_role only; fn_lightning_operator_control calls it as its owner.';

REVOKE ALL ON FUNCTION public.fn_lightning_operator_may_control(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_operator_may_control(uuid) TO service_role;

-- ===========================================================================
-- 19. THE OPERATOR STATE an action is judged against, before and after.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_operator_state(p_cluster_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  g     record;
  v_cfg jsonb;
  d     record;
  v_ctl record;
BEGIN
  SELECT cg.id, cg.cluster_mode, cg.cluster_epoch, cg.lightning_enabled INTO g
    FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_cfg := public.fn_lightning_config(g.id);
  SELECT x.id, x.phase, x.from_mode, x.requested_at, x.deadline_at INTO d
    FROM public.lightning_cluster_drain x WHERE x.cluster_id = g.id AND x.completed_at IS NULL;
  SELECT x.* INTO v_ctl FROM public.lightning_cluster_control x WHERE x.cluster_id = g.id;
  RETURN jsonb_build_object(
    'cluster_mode', g.cluster_mode,
    'cluster_epoch', g.cluster_epoch,
    'lightning_enabled', coalesce(g.lightning_enabled, false),
    'paused', g.cluster_mode = 'paused',
    'paused_from', CASE WHEN g.cluster_mode = 'paused' THEN v_ctl.paused_from END,
    'joins_enabled', coalesce((v_cfg ->> 'lightning_joins_enabled')::boolean, true),
    'drain', CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object(
               'drain_id', d.id, 'phase', d.phase, 'from_mode', d.from_mode,
               'requested_at', d.requested_at, 'deadline_at', d.deadline_at) END,
    'matcher', jsonb_build_object(
      'version', v_cfg -> 'matcher_version',
      'previous', v_cfg -> 'matcher_version_previous',
      'disabled', coalesce(v_cfg -> 'matcher_versions_disabled', '[]'::jsonb),
      'shadow_version', v_cfg -> 'shadow_matcher_version',
      'shadow_disabled', coalesce((v_cfg ->> 'shadow_matcher_disabled')::boolean, false)),
    'flags', public.fn_lightning_spec_flags(g.lightning_enabled, v_cfg));
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_operator_state(uuid) IS
  'Lightning Phase 13 (20261009235505): a Cluster''s operator state - cluster_mode, epoch, lightning_enabled, paused and paused_from, joins_enabled, the open drain, the matcher versions and the ten specification flags - the before and after of every fn_lightning_operator_control answer. service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_operator_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_operator_state(uuid) TO service_role;

-- ===========================================================================
-- 20. THE OPERATOR CONTROL DOOR. See the header for every action, refusal
--     and shape. The Cluster row is taken FOR UPDATE before anything is
--     judged, so two operators (or an operator and the tick) racing are
--     serialised and the second is judged against the first's result.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_operator_control(
  p_cluster_id uuid, p_action text, p_reason text, p_args jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  c_actions constant text[] := ARRAY['pause', 'resume', 'disable_joins', 'enable_joins', 'drain', 'freeze',
                                     'unfreeze', 'enable_lightning', 'disable_lightning', 'set_matcher_version',
                                     'disable_matcher_version', 'enable_matcher_version', 'rollback_matcher_version',
                                     'set_flag', 'set_worker_mode'];
  c_flags   constant text[] := ARRAY['lightning_v1', 'lightning_fast_fold', 'lightning_fold_watch',
                                     'lightning_multi_table', 'lightning_pool_health', 'lightning_repeat_suppression',
                                     'lightning_session_stats', 'lightning_shadow_matcher', 'lightning_auto_rebuy',
                                     'lightning_adaptive_liquidity'];
  c_known   constant text[] := ARRAY['m1', 'm1-port', 'm2'];
  c_sql     constant text[] := ARRAY['m1'];
  c_uuid    constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_uid      uuid := auth.uid();
  v_service  boolean := coalesce(auth.role(), '') = 'service_role';
  v_action   text := lower(btrim(coalesce(p_action, '')));
  v_reason   text := btrim(coalesce(p_reason, ''));
  v_args     jsonb := CASE WHEN jsonb_typeof(p_args) = 'object' THEN p_args ELSE '{}'::jsonb END;
  v_club     uuid;
  v_actor    uuid;
  v_kind     text;
  v_req      uuid;
  v_prior    record;
  g          record;
  v_op       text;
  v_before   jsonb;
  v_after    jsonb;
  v_cfg      jsonb;
  v_raw      jsonb;
  v_patch    jsonb := '{}'::jsonb;
  v_remove   text[] := ARRAY[]::text[];
  v_detail   jsonb := '{}'::jsonb;
  v_steps    jsonb := '[]'::jsonb;
  v_answer   jsonb;
  v_event    jsonb;
  v_drain    record;
  v_ctl      record;
  v_from     text;
  v_version  text;
  v_role     text;
  v_flag     text;
  v_value    boolean;
  v_live_v   text;
  v_prev     text;
  v_off      text[];
  v_n        integer;
  v_wait     integer;
  v_live     integer;
  v_open     integer;
  v_chips    numeric;
  v_conv     uuid;
  v_id       uuid;
  v_alert    uuid;
  v_alert_err text;
  v_res      jsonb;
  v_safe     jsonb;
  v_timeout  integer;
  i          record;
  st         jsonb;
BEGIN
  -- WHO. Nothing about the Cluster is answered before the gate, not even
  -- whether it exists.
  SELECT cg.club_id INTO v_club FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  IF NOT public.fn_lightning_operator_may_control(v_club) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED', 'reason', 'NOT_AUTHORIZED');
  END IF;
  IF NOT (v_action = ANY (c_actions)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ACTION', 'reason', 'INVALID_ACTION',
                              'actions', to_jsonb(c_actions));
  END IF;
  IF length(v_reason) < 3 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'reason', 'REASON_REQUIRED');
  END IF;
  IF length(v_reason) > 2000 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'reason_too_long');
  END IF;
  IF jsonb_typeof(v_args -> 'request_id') IS DISTINCT FROM 'string' OR NOT ((v_args ->> 'request_id') ~ c_uuid) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'request_id_required');
  END IF;
  v_req := (v_args ->> 'request_id')::uuid;
  -- THE UNFREEZE IS THE PLATFORM'S: a frozen Cluster is evidence.
  IF v_action = 'unfreeze' AND NOT (v_service OR coalesce(public.fn_is_platform_admin(), false)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED', 'reason', 'NOT_AUTHORIZED');
  END IF;
  v_actor := CASE WHEN v_uid IS NOT NULL THEN v_uid
                  WHEN v_service AND jsonb_typeof(v_args -> 'actor_id') = 'string' AND (v_args ->> 'actor_id') ~ c_uuid
                  THEN (v_args ->> 'actor_id')::uuid END;
  v_kind := CASE WHEN v_service THEN 'service'
                 WHEN coalesce(public.fn_is_platform_admin(), false) THEN 'platform_admin'
                 ELSE 'club_control' END;
  v_safe := jsonb_strip_nulls(jsonb_build_object('version', v_args -> 'version', 'role', v_args -> 'role',
                                                 'flag', v_args -> 'flag', 'value', v_args -> 'value',
                                                 'mode', v_args -> 'mode', 'actor_id', v_args -> 'actor_id'));

  -- A REPEATED REQUEST IS ANSWERED, NOT DONE AGAIN.
  SELECT r.cluster_id, r.action, r.answer INTO v_prior
    FROM public.lightning_operator_request r WHERE r.request_id = v_req;
  IF FOUND THEN
    IF v_prior.cluster_id IS DISTINCT FROM p_cluster_id OR v_prior.action IS DISTINCT FROM v_action THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'request_id_belongs_to_another_request');
    END IF;
    RETURN v_prior.answer || jsonb_build_object('idempotent', true, 'replayed', true);
  END IF;
  IF v_club IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CLUSTER_NOT_FOUND', 'reason', 'CLUSTER_NOT_FOUND');
  END IF;

  -- THE CLUSTER ROW, the lock every formation, conversion, drain and tick
  -- takes first.
  SELECT * INTO g FROM public.cash_games cg WHERE cg.id = p_cluster_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CLUSTER_NOT_FOUND', 'reason', 'CLUSTER_NOT_FOUND');
  END IF;
  SELECT r.cluster_id, r.action, r.answer INTO v_prior
    FROM public.lightning_operator_request r WHERE r.request_id = v_req;
  IF FOUND THEN
    IF v_prior.cluster_id IS DISTINCT FROM p_cluster_id OR v_prior.action IS DISTINCT FROM v_action THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'request_id_belongs_to_another_request');
    END IF;
    RETURN v_prior.answer || jsonb_build_object('idempotent', true, 'replayed', true);
  END IF;

  v_before := public.fn_lightning_operator_state(g.id);
  v_cfg := public.fn_lightning_config(g.id);
  v_raw := CASE WHEN jsonb_typeof(g.ruleset_snapshot -> 'lightning') = 'object'
                THEN g.ruleset_snapshot -> 'lightning' ELSE '{}'::jsonb END;
  SELECT * INTO v_drain FROM public.lightning_cluster_drain x WHERE x.cluster_id = g.id AND x.completed_at IS NULL;
  SELECT * INTO v_ctl FROM public.lightning_cluster_control x WHERE x.cluster_id = g.id;
  v_off := ARRAY(SELECT jsonb_array_elements_text(coalesce(v_cfg -> 'matcher_versions_disabled', '[]'::jsonb)));
  -- THE MODE A PAUSED CLUSTER STANDS FOR: the one it was paused from (a
  -- pause recorded nowhere stands for lightning only if its pool is open).
  v_from := CASE WHEN g.cluster_mode = 'paused' THEN
                   coalesce(v_ctl.paused_from,
                            CASE WHEN EXISTS (SELECT 1 FROM public.lightning_pool_session ps
                                               WHERE ps.cluster_id = g.id AND ps.cluster_epoch = g.cluster_epoch
                                                 AND ps.exited_at IS NULL)
                                 THEN 'lightning' ELSE 'must_move' END)
                 ELSE g.cluster_mode END;
  v_op := v_action;

  <<act>>
  BEGIN
    IF g.cluster_mode = 'frozen' AND v_action NOT IN ('freeze', 'unfreeze') THEN
      v_answer := jsonb_build_object('ok', false, 'code', 'CLUSTER_FROZEN', 'reason', 'CLUSTER_FROZEN',
                                     'recovery', 'unfreeze (a platform admin)');
      EXIT act;
    END IF;
    IF g.cluster_mode = 'dead' THEN
      v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ACTION', 'reason', 'cluster_dead');
      EXIT act;
    END IF;

    IF v_action = 'set_flag' THEN
      v_flag := CASE WHEN jsonb_typeof(v_args -> 'flag') = 'string' THEN v_args ->> 'flag' END;
      IF v_flag IS NULL OR NOT (v_flag = ANY (c_flags)) THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'unknown_flag',
                                       'flags', to_jsonb(c_flags));
        EXIT act;
      END IF;
      IF jsonb_typeof(v_args -> 'value') IS DISTINCT FROM 'boolean' THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'value_must_be_boolean');
        EXIT act;
      END IF;
      v_value := (v_args ->> 'value')::boolean;
      IF v_flag IN ('lightning_pool_health', 'lightning_session_stats') THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'FLAG_NOT_SUPPORTED', 'reason', 'FLAG_NOT_SUPPORTED',
          'flag', v_flag, 'why', 'a read-only player display from the one population and statistics readers; always on, with nothing to protect by a switch');
        EXIT act;
      END IF;
      IF v_flag IN ('lightning_repeat_suppression', 'lightning_adaptive_liquidity') THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'FLAG_NOT_SUPPORTED', 'reason', 'FLAG_NOT_SUPPORTED',
          'flag', v_flag, 'why', 'part of the live matcher (P5 diversity and its population bands); a matcher change goes through a matcher version with shadow evidence first, never a flag');
        EXIT act;
      END IF;
      v_detail := jsonb_build_object('flag', v_flag, 'value', v_value);
      IF v_flag = 'lightning_v1' THEN
        v_op := CASE WHEN v_value THEN 'enable_lightning' ELSE 'disable_lightning' END;
        v_detail := v_detail || jsonb_build_object('performed', v_op);
      END IF;
    END IF;

    IF v_op = 'pause' THEN
      IF g.cluster_mode = 'paused' THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      IF v_drain.id IS NOT NULL OR g.cluster_mode IN ('pending_on', 'pending_off', 'draining') THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'CLUSTER_BUSY', 'reason', 'CLUSTER_BUSY',
                                       'cluster_mode', g.cluster_mode, 'drain_id', v_drain.id);
        EXIT act;
      END IF;
      IF g.cluster_mode NOT IN ('lightning', 'must_move') THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ACTION', 'reason', 'not_pausable_from_' || g.cluster_mode);
        EXIT act;
      END IF;
      v_n := 0;
      IF g.cluster_mode = 'lightning' THEN
        -- HOLD NEW HANDS AT THE BOUNDARY: a formation not yet dealt is void
        -- (nothing was dealt, no chip moves); a hand already dealing plays
        -- out and settles.
        FOR i IN
          SELECT li.id FROM public.lightning_instance li
           WHERE li.cluster_id = g.id AND li.state IN ('forming', 'reserved')
           ORDER BY li.id
           FOR UPDATE
        LOOP
          PERFORM public.fn_lightning_instance_abandon(i.id,
            'lightning paused by an operator: a hand not yet dealt is void; nothing was dealt and no chip moved',
            clock_timestamp());
          v_n := v_n + 1;
        END LOOP;
      END IF;
      UPDATE public.cash_games SET cluster_mode = 'paused', updated_at = now() WHERE id = g.id;
      INSERT INTO public.lightning_cluster_control AS c
             (cluster_id, paused_from, paused_at, paused_by, paused_reason, paused_request_id, updated_at)
      VALUES (g.id, g.cluster_mode, clock_timestamp(), v_actor, v_reason, v_req, clock_timestamp())
      ON CONFLICT (cluster_id) DO UPDATE
         SET paused_from = EXCLUDED.paused_from, paused_at = EXCLUDED.paused_at, paused_by = EXCLUDED.paused_by,
             paused_reason = EXCLUDED.paused_reason, paused_request_id = EXCLUDED.paused_request_id,
             updated_at = EXCLUDED.updated_at;
      v_detail := jsonb_build_object('paused_from', g.cluster_mode, 'instances_voided', v_n,
        'hands_in_flight', (SELECT count(*) FROM public.lightning_instance li
                             WHERE li.cluster_id = g.id AND li.state IN ('dealing', 'settling')));

    ELSIF v_op = 'resume' THEN
      IF g.cluster_mode IS DISTINCT FROM 'paused' THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      UPDATE public.cash_games SET cluster_mode = v_from, updated_at = now() WHERE id = g.id;
      UPDATE public.lightning_cluster_control
         SET paused_from = NULL, paused_at = NULL, paused_by = NULL, paused_reason = NULL,
             paused_request_id = NULL, updated_at = clock_timestamp()
       WHERE cluster_id = g.id;
      v_n := 0;
      IF v_from = 'lightning' THEN
        v_n := public.fn_lightning_pool_enter_seated(g.id);
      END IF;
      v_detail := jsonb_build_object('resumed_to', v_from, 'pool_sessions_entered', v_n);

    ELSIF v_op = 'disable_joins' THEN
      IF NOT coalesce((v_cfg ->> 'lightning_joins_enabled')::boolean, true) THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      v_patch := jsonb_build_object('lightning_joins_enabled', false,
                                    'lightning_joins_disabled_at', to_jsonb(clock_timestamp()));
      v_detail := jsonb_build_object('joins_disabled_at', clock_timestamp());

    ELSIF v_op = 'enable_joins' THEN
      IF coalesce((v_cfg ->> 'lightning_joins_enabled')::boolean, true) THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      v_patch := jsonb_build_object('lightning_joins_enabled', true);
      v_remove := ARRAY['lightning_joins_disabled_at'];

    ELSIF v_op IN ('drain', 'disable_lightning') THEN
      IF v_drain.id IS NOT NULL OR g.cluster_mode = 'draining' THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      IF v_from IN ('must_move', 'created', 'opening') THEN
        -- NOTHING IN LIGHTNING TO DRAIN: the flag is cleared, and a drain
        -- of a must-move pause resumes it, so the Cluster ends in must_move.
        IF NOT coalesce(g.lightning_enabled, false) AND NOT (v_op = 'drain' AND g.cluster_mode = 'paused') THEN
          v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
        END IF;
        UPDATE public.cash_games
           SET lightning_enabled = false, lightning_off_condition_since = NULL,
               cluster_mode = CASE WHEN v_op = 'drain' AND cluster_mode = 'paused' THEN 'must_move' ELSE cluster_mode END,
               updated_at = now()
         WHERE id = g.id;
        IF v_op = 'drain' AND g.cluster_mode = 'paused' THEN
          UPDATE public.lightning_cluster_control
             SET paused_from = NULL, paused_at = NULL, paused_by = NULL, paused_reason = NULL,
                 paused_request_id = NULL, updated_at = clock_timestamp()
           WHERE cluster_id = g.id;
        END IF;
        v_detail := v_detail || jsonb_build_object('nothing_to_drain', true, 'drain', NULL);
        EXIT act;
      END IF;

      -- THE EMERGENCY DRAIN. Steps 1 and 2 take effect in this statement
      -- (joins and formation stop: the pool door, the barrier and
      -- begin_dealing all refuse every mode but lightning, and lightning is
      -- disabled so nothing converts back), step 3 is recorded, and the
      -- drive does the rest.
      v_timeout := coalesce((v_cfg ->> 'drain_timeout_ms')::integer, 120000);
      SELECT count(*) FILTER (WHERE li.state IN ('forming', 'reserved'))::integer,
             count(*) FILTER (WHERE li.state IN ('dealing', 'settling'))::integer
        INTO v_wait, v_live
        FROM public.lightning_instance li
       WHERE li.cluster_id = g.id AND li.state IN ('forming', 'reserved', 'dealing', 'settling');
      SELECT count(*)::integer INTO v_open FROM public.lightning_pool_session ps
       WHERE ps.cluster_id = g.id AND ps.exited_at IS NULL;
      SELECT coalesce(sum(ts.stack), 0) INTO v_chips
        FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
       WHERE tb.cluster_id = g.id AND ts.left_at IS NULL;
      SELECT cc.id INTO v_conv FROM public.cash_cluster_conversion cc
       WHERE cc.cluster_id = g.id AND cc.status = 'pending';
      UPDATE public.cash_games
         SET lightning_enabled = false, lightning_off_condition_since = NULL,
             cluster_mode = CASE WHEN g.cluster_mode IN ('lightning', 'paused') THEN 'draining' ELSE cluster_mode END,
             updated_at = now()
       WHERE id = g.id;
      IF g.cluster_mode = 'paused' THEN
        UPDATE public.lightning_cluster_control
           SET paused_from = NULL, paused_at = NULL, paused_by = NULL, paused_reason = NULL,
               paused_request_id = NULL, updated_at = clock_timestamp()
         WHERE cluster_id = g.id;
      END IF;
      INSERT INTO public.lightning_cluster_drain
             (cluster_id, request_id, requested_by, actor_kind, reason, from_mode, epoch_at_request, deadline_at,
              phase, conversion_id, counts)
      VALUES (g.id, v_req, v_actor, v_kind, v_reason, g.cluster_mode, g.cluster_epoch,
              clock_timestamp() + make_interval(secs => v_timeout / 1000.0),
              CASE WHEN g.cluster_mode IN ('lightning', 'paused') THEN 'finishing' ELSE 'reverting' END,
              v_conv,
              jsonb_build_object('chips_at_request', v_chips, 'pool_sessions_at_request', v_open,
                                 'hands_in_flight_at_request', v_live, 'instances_awaiting_deal_at_request', v_wait,
                                 'drain_timeout_ms', v_timeout))
      RETURNING id INTO v_id;
      v_steps := jsonb_build_array(
        jsonb_build_object('step', 1, 'name', 'stop_new_joins', 'joins_closed', true,
                           'lightning_enabled', false, 'pool_sessions_open', v_open),
        jsonb_build_object('step', 2, 'name', 'stop_new_formation', 'formation_stopped', true,
                           'instances_awaiting_deal', v_wait),
        jsonb_build_object('step', 3, 'name', 'let_active_hands_finish', 'hands_in_flight', v_live,
                           'deadline_at', clock_timestamp() + make_interval(secs => v_timeout / 1000.0),
                           'drain_timeout_ms', v_timeout));
      UPDATE public.lightning_cluster_drain SET steps = ARRAY[1, 2, 3] WHERE id = v_id;
      v_detail := v_detail || jsonb_build_object('drain_id', v_id, 'from_mode', g.cluster_mode,
        'phase', CASE WHEN g.cluster_mode IN ('lightning', 'paused') THEN 'finishing' ELSE 'reverting' END,
        'deadline_at', clock_timestamp() + make_interval(secs => v_timeout / 1000.0),
        'hands_in_flight', v_live, 'instances_awaiting_deal', v_wait, 'pool_sessions_open', v_open,
        'conversion_id', v_conv);

    ELSIF v_op = 'enable_lightning' THEN
      IF coalesce(g.lightning_enabled, false) THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      IF v_drain.id IS NOT NULL OR g.cluster_mode IN ('draining', 'pending_off') THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'CLUSTER_BUSY', 'reason', 'CLUSTER_BUSY',
                                       'cluster_mode', g.cluster_mode, 'drain_id', v_drain.id);
        EXIT act;
      END IF;
      IF NOT coalesce(g.must_move, false) THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ACTION', 'reason', 'not_a_must_move_game');
        EXIT act;
      END IF;
      UPDATE public.cash_games SET lightning_enabled = true, updated_at = now() WHERE id = g.id;
      v_detail := v_detail || jsonb_build_object('game_enabled', g.enabled, 'cluster_mode', g.cluster_mode);

    ELSIF v_op = 'freeze' THEN
      IF g.cluster_mode = 'frozen' THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      IF NOT (g.cluster_mode IN ('pending_on', 'lightning', 'pending_off', 'draining')
              OR (g.cluster_mode = 'paused' AND v_from = 'lightning')) THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ACTION', 'reason', 'NOT_IN_A_LIGHTNING_MODE',
                                       'cluster_mode', g.cluster_mode);
        EXIT act;
      END IF;
      -- THE FREEZE PATH: the same transition, the same page and the same
      -- event an automatic freeze writes. Recovery: fn_cash_cluster_unfreeze.
      UPDATE public.cash_games SET cluster_mode = 'frozen', updated_at = now()
       WHERE id = g.id AND cluster_mode NOT IN ('frozen', 'dead');
      BEGIN
        v_alert := public.fn_raise_server_financial_alert(
          'critical', 'lightning_alerts',
          format('LIGHTNING_CLUSTER_FROZEN: Cluster %s frozen by an operator from %s at epoch %s: %s',
                 g.id, g.cluster_mode, g.cluster_epoch, v_reason),
          jsonb_build_object('check', 'frozen', 'cluster_id', g.id, 'cluster_epoch', g.cluster_epoch,
                             'invariant', 'operator_freeze', 'from_mode', g.cluster_mode, 'operator', v_actor,
                             'request_id', v_req, 'recovery', 'fn_cash_cluster_unfreeze(cluster_id, operator, reason)'),
          'lightning_cluster_frozen:' || g.id, g.id::text);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_alert_err = MESSAGE_TEXT;
      END;
      INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
      VALUES (g.id, 'cluster_frozen', jsonb_build_object(
        'cluster_id', g.id, 'cluster_epoch', g.cluster_epoch, 'from_mode', g.cluster_mode, 'to_mode', 'frozen',
        'reason', 'operator_freeze', 'invariant', 'operator_freeze', 'operator', v_actor, 'note', v_reason,
        'alert_id', v_alert, 'alert_error', v_alert_err, 'at', clock_timestamp()), g.cluster_epoch, v_req);
      IF v_drain.id IS NOT NULL THEN
        INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
        VALUES (g.id, 'lightning_drain_ended', jsonb_build_object(
          'drain_id', v_drain.id, 'request_id', v_drain.request_id, 'outcome', 'ended_by_frozen',
          'cluster_mode', 'frozen', 'steps_recorded', to_jsonb(v_drain.steps), 'at', clock_timestamp()), v_drain.request_id);
        UPDATE public.lightning_cluster_drain
           SET phase = 'complete', completed_at = clock_timestamp(), outcome = 'ended_by_frozen'
         WHERE id = v_drain.id;
      END IF;
      IF g.cluster_mode = 'paused' THEN
        UPDATE public.lightning_cluster_control
           SET paused_from = NULL, paused_at = NULL, paused_by = NULL, paused_reason = NULL,
               paused_request_id = NULL, updated_at = clock_timestamp()
         WHERE cluster_id = g.id;
      END IF;
      v_detail := jsonb_build_object('from_mode', g.cluster_mode, 'alert_id', v_alert, 'alert_error', v_alert_err,
                                     'drain_ended', v_drain.id);

    ELSIF v_op = 'unfreeze' THEN
      IF g.cluster_mode IS DISTINCT FROM 'frozen' THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      IF v_actor IS NULL THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'operator_required');
        EXIT act;
      END IF;
      v_res := public.fn_cash_cluster_unfreeze(g.id, v_actor, v_reason);
      IF coalesce((v_res ->> 'ok')::boolean, false) IS NOT TRUE THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', coalesce(v_res ->> 'reason', 'unfreeze_refused'),
                                       'unfreeze', v_res);
        EXIT act;
      END IF;
      UPDATE public.lightning_cluster_control
         SET paused_from = NULL, paused_at = NULL, paused_by = NULL, paused_reason = NULL,
             paused_request_id = NULL, updated_at = clock_timestamp()
       WHERE cluster_id = g.id;
      v_detail := jsonb_build_object('unfreeze', v_res);

    ELSIF v_op IN ('set_matcher_version', 'disable_matcher_version', 'enable_matcher_version') THEN
      v_version := CASE WHEN jsonb_typeof(v_args -> 'version') = 'string' THEN v_args ->> 'version' END;
      IF v_version IS NULL THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'version_required'); EXIT act;
      END IF;
      IF NOT (v_version = ANY (c_known)) THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'UNKNOWN_VERSION', 'reason', 'UNKNOWN_VERSION',
                                       'version', v_version, 'known', to_jsonb(c_known));
        EXIT act;
      END IF;
      v_live_v := coalesce(CASE WHEN jsonb_typeof(v_raw -> 'matcher_version') = 'string' THEN v_raw ->> 'matcher_version' END, 'm1');
      IF v_op = 'set_matcher_version' THEN
        IF v_version = ANY (v_off) THEN
          v_answer := jsonb_build_object('ok', false, 'code', 'VERSION_DISABLED', 'reason', 'VERSION_DISABLED',
                                         'version', v_version);
          EXIT act;
        END IF;
        v_role := coalesce(CASE WHEN jsonb_typeof(v_args -> 'role') = 'string' THEN v_args ->> 'role' END, 'live');
        IF v_role NOT IN ('live', 'shadow') THEN
          v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'role_must_be_live_or_shadow'); EXIT act;
        END IF;
        IF v_role = 'live' THEN
          IF NOT (v_version = ANY (c_sql)) THEN
            v_answer := jsonb_build_object('ok', false, 'code', 'NOT_SQL_MATCHER', 'reason', 'NOT_SQL_MATCHER',
                                           'version', v_version, 'sql_matcher_versions', to_jsonb(c_sql));
            EXIT act;
          END IF;
          IF v_live_v = v_version THEN
            v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
          END IF;
          v_patch := jsonb_build_object('matcher_version', v_version,
                                        'matcher_version_previous', CASE WHEN v_live_v = ANY (c_known) THEN v_live_v ELSE 'm1' END);
        ELSE
          IF (v_cfg ->> 'shadow_matcher_version') = v_version THEN
            v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
          END IF;
          IF (v_cfg ->> 'matcher_version') = v_version THEN
            v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'shadow_equals_live'); EXIT act;
          END IF;
          v_patch := jsonb_build_object('shadow_matcher_version', v_version);
        END IF;
        v_detail := jsonb_build_object('version', v_version, 'role', v_role);
      ELSIF v_op = 'disable_matcher_version' THEN
        IF v_version = ANY (v_off) THEN
          v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
        END IF;
        IF v_version = ANY (c_sql)
           AND NOT EXISTS (SELECT 1 FROM unnest(c_sql) x(v) WHERE x.v <> v_version AND NOT (x.v = ANY (v_off))) THEN
          v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS',
                                         'reason', 'the_only_sql_matcher_cannot_be_disabled', 'version', v_version);
          EXIT act;
        END IF;
        v_patch := jsonb_build_object('matcher_versions_disabled',
                     to_jsonb(ARRAY(SELECT DISTINCT u.x FROM unnest(v_off || v_version) u(x) ORDER BY u.x)));
        v_detail := jsonb_build_object('version', v_version);
        -- DISABLING THE LIVE VERSION ROLLS BACK to the previous enabled one.
        IF v_live_v = v_version THEN
          v_prev := v_cfg ->> 'matcher_version_previous';
          IF v_prev IS NULL OR v_prev = v_version OR v_prev = ANY (v_off) OR NOT (v_prev = ANY (c_sql)) THEN
            v_prev := 'm1';
          END IF;
          v_patch := v_patch || jsonb_build_object('matcher_version', v_prev, 'matcher_version_previous', v_version);
          v_detail := v_detail || jsonb_build_object('forced_rollback', jsonb_build_object('from', v_version, 'to', v_prev));
        END IF;
        IF (v_cfg ->> 'shadow_matcher_version') = v_version THEN
          v_detail := v_detail || jsonb_build_object('shadow_stops', true);
        END IF;
      ELSE
        IF NOT (v_version = ANY (v_off)) THEN
          v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
        END IF;
        v_patch := jsonb_build_object('matcher_versions_disabled',
                     to_jsonb(ARRAY(SELECT u.x FROM unnest(v_off) u(x) WHERE u.x <> v_version ORDER BY u.x)));
        v_detail := jsonb_build_object('version', v_version);
      END IF;

    ELSIF v_op = 'rollback_matcher_version' THEN
      v_live_v := coalesce(CASE WHEN jsonb_typeof(v_raw -> 'matcher_version') = 'string' THEN v_raw ->> 'matcher_version' END, 'm1');
      v_prev := coalesce(v_cfg ->> 'matcher_version_previous', 'm1');
      IF v_prev = v_live_v THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      IF v_prev = ANY (v_off) THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'VERSION_DISABLED', 'reason', 'VERSION_DISABLED', 'version', v_prev);
        EXIT act;
      END IF;
      IF NOT (v_prev = ANY (c_sql)) THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'NOT_SQL_MATCHER', 'reason', 'NOT_SQL_MATCHER', 'version', v_prev);
        EXIT act;
      END IF;
      v_patch := jsonb_build_object('matcher_version', v_prev,
                                    'matcher_version_previous', CASE WHEN v_live_v = ANY (c_known) THEN v_live_v ELSE 'm1' END);
      v_detail := jsonb_build_object('from', v_live_v, 'to', v_prev);

    ELSIF v_op = 'set_worker_mode' THEN
      -- THE ENGINE WORKER: off (nothing), shadow (plans and compares, forms
      -- nothing) or form. A rollout stage, not a specification flag.
      v_role := CASE WHEN jsonb_typeof(v_args -> 'mode') = 'string' THEN v_args ->> 'mode' END;
      IF v_role IS NULL OR v_role NOT IN ('off', 'shadow', 'form') THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'mode_must_be_off_shadow_or_form');
        EXIT act;
      END IF;
      IF (v_cfg ->> 'worker_mode') = v_role THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      v_patch := jsonb_build_object('worker_mode', v_role);
      v_detail := jsonb_build_object('worker_mode', v_role, 'was', v_cfg ->> 'worker_mode');

    ELSIF v_op = 'set_flag' THEN
      IF (public.fn_lightning_spec_flags(g.lightning_enabled, v_cfg) ->> v_flag)::boolean IS NOT DISTINCT FROM v_value THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      IF v_flag = 'lightning_shadow_matcher' THEN
        v_patch := jsonb_build_object('lightning_shadow_matcher', v_value);
      ELSIF v_flag = 'lightning_auto_rebuy' THEN
        v_patch := jsonb_build_object('auto_rebuy_enabled', v_value);
      ELSIF v_flag = 'lightning_fast_fold' THEN
        v_patch := jsonb_build_object('lightning_fast_fold', v_value);
      ELSIF v_flag = 'lightning_fold_watch' THEN
        v_patch := jsonb_build_object('lightning_fold_watch', v_value);
      ELSIF v_flag = 'lightning_multi_table' THEN
        IF v_value THEN
          v_remove := ARRAY['multi_table_limit'];
        ELSE
          v_patch := jsonb_build_object('multi_table_limit', 1);
        END IF;
      END IF;
    END IF;
  END act;

  IF v_answer IS NOT NULL AND coalesce((v_answer ->> 'already')::boolean, false) THEN
    v_answer := jsonb_build_object('ok', true, 'idempotent', true, 'already', true, 'code', 'ALREADY',
                                   'action', v_action, 'cluster_id', g.id, 'request_id', v_req,
                                   'before', v_before, 'after', v_before, 'event_id', NULL, 'detail', v_detail);
  ELSIF v_answer IS NULL THEN
    -- THE CONFIGURATION CHANGE, if the action is one: the Cluster's own
    -- lightning object, every other key left exactly as it was.
    IF v_patch <> '{}'::jsonb OR cardinality(v_remove) > 0 THEN
      UPDATE public.cash_games cg
         SET ruleset_snapshot = jsonb_set(coalesce(cg.ruleset_snapshot, '{}'::jsonb), '{lightning}',
               (CASE WHEN jsonb_typeof(cg.ruleset_snapshot -> 'lightning') = 'object'
                     THEN cg.ruleset_snapshot -> 'lightning' ELSE '{}'::jsonb END - v_remove) || v_patch, true),
             updated_at = now()
       WHERE cg.id = g.id;
      v_detail := v_detail || jsonb_build_object('config_set', v_patch, 'config_removed', to_jsonb(v_remove));
    END IF;
    IF v_op = 'enable_joins' AND g.cluster_mode = 'lightning' THEN
      -- WHOEVER SAT DOWN WHILE JOINS WERE CLOSED IS IN THE POOL NOW.
      v_detail := v_detail || jsonb_build_object('pool_sessions_entered', public.fn_lightning_pool_enter_seated(g.id));
    END IF;
    v_after := public.fn_lightning_operator_state(g.id);
    INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
    VALUES (g.id, 'operator_' || v_action, jsonb_build_object(
      'action', v_action, 'actor', v_actor, 'actor_kind', v_kind, 'reason', v_reason,
      'request_id', v_req, 'args', v_safe, 'before', v_before, 'after', v_after, 'detail', v_detail,
      'at', clock_timestamp()), v_req)
    RETURNING to_jsonb(id) INTO v_event;
    FOR st IN SELECT x.v FROM jsonb_array_elements(v_steps) x(v) LOOP
      INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
      VALUES (g.id, 'lightning_drain_step', st || jsonb_build_object(
        'drain_id', v_detail -> 'drain_id', 'request_id', v_req, 'operator_event_id', v_event,
        'at', clock_timestamp()), v_req);
    END LOOP;
    v_answer := jsonb_build_object('ok', true, 'idempotent', false, 'action', v_action, 'cluster_id', g.id,
                                   'request_id', v_req, 'before', v_before, 'after', v_after,
                                   'event_id', v_event, 'detail', v_detail);
  ELSE
    v_answer := v_answer || jsonb_build_object('action', v_action, 'cluster_id', g.id, 'request_id', v_req);
  END IF;

  INSERT INTO public.lightning_operator_request (request_id, cluster_id, action, actor, actor_kind, reason, args, answer)
  VALUES (v_req, g.id, v_action, v_actor, v_kind, v_reason, v_safe, v_answer)
  ON CONFLICT (request_id) DO NOTHING;
  RETURN v_answer;
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_operator_control(uuid, text, text, jsonb) IS
  'Lightning Phase 13 (20261009235505): THE LIGHTNING OPERATOR CONTROL DOOR - pause / resume, disable_joins / enable_joins, drain (the EMERGENCY DRAIN state machine), freeze (the existing freeze path) / unfreeze (platform admin, through fn_cash_cluster_unfreeze), enable_lightning / disable_lightning (a live Cluster drains), set / disable / enable / rollback matcher version, set_flag (the specification flags on existing gates). Gate: service_role, platform admin or club control (fn_lightning_operator_may_control). Reason required; idempotent by p_args.request_id; every change writes one operator_<action> event. Answers {ok, idempotent, action, cluster_id, request_id, before, after, event_id, detail} or {ok:false, code, reason}. authenticated and service_role, never anon.';

REVOKE ALL ON FUNCTION public.fn_lightning_operator_control(uuid, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_lightning_operator_control(uuid, text, text, jsonb) TO authenticated, service_role;

-- ===========================================================================
-- 21. THE ROLLOUT READINESS VERDICT (read-only). See the header.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_rollout_readiness(p_cluster_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  -- EVERY LIGHTNING MIGRATION, in order (a later Lightning file adds itself).
  c_versions constant text[] := ARRAY[
    '20260920172736', '20260920234647', '20260920235343', '20260921025504', '20260921025523',
    '20260921044045', '20260921064717', '20260921142954', '20260921151618', '20260925204249',
    '20260925215731', '20260926023047', '20260926072527', '20260926072551', '20260926072615',
    '20260926072638', '20260926080332', '20261001154813', '20261001201216', '20261001222856',
    '20261007212735', '20261007222717', '20261008043021', '20261008050805', '20261008111425',
    '20261008142857', '20261008161509', '20261009143757', '20261009144343', '20261009151825',
    '20261009181945', '20261009235505'];
  v_now      timestamptz := now();
  g          record;
  v_club     record;
  v_row      jsonb;
  v_cfg      jsonb;
  v_reasons  jsonb := '[]'::jsonb;
  v_missing  text[];
  v_seven    boolean;
  v_anti     boolean;
  v_law      boolean;
  v_doors    boolean;
  v_sr       jsonb;
  v_scope    text;
  v_aa       jsonb;
  v_cand     jsonb;
  v_live_v   text;
  v_over     jsonb := '[]'::jsonb;
  v_leg      text;
  v_reg      jsonb;
  v_lat_to   timestamptz;
  v_horse    text := 'is_' || 'horse|horse_' || 'id';
  v_verdict  text;
  v_strip    text := '--[^' || chr(10) || ']*';
BEGIN
  SELECT cg.id, cg.club_id, cg.enabled, cg.must_move, cg.lightning_enabled, cg.cluster_mode,
         coalesce(((cg.ruleset_snapshot -> 'options') ->> 'is_private')::boolean, false) AS is_private
    INTO g FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  IF NOT public.fn_lightning_operator_may(g.club_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED', 'reason', 'NOT_AUTHORIZED');
  END IF;
  IF g.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'NOT_FOUND');
  END IF;
  SELECT (to_jsonb(cl) ->> 'is_public')::boolean AS is_public INTO v_club FROM public.clubs cl WHERE cl.id = g.club_id;
  v_row := public.fn_lightning_operator_cluster_row(g.id, v_now);
  v_cfg := public.fn_lightning_config(g.id);
  v_live_v := v_cfg ->> 'matcher_version';

  -- EVERY LIGHTNING MIGRATION IS RECORDED.
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'MIGRATION_LEDGER_UNREADABLE', 'severity', 'blocking',
                                                 'detail', 'supabase_migrations.schema_migrations is not readable');
  ELSE
    EXECUTE 'SELECT coalesce(array_agg(v ORDER BY v), ARRAY[]::text[]) FROM unnest($1) v
              WHERE NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations m WHERE m.version = v)'
       INTO v_missing USING c_versions;
    IF cardinality(v_missing) > 0 THEN
      v_reasons := v_reasons || jsonb_build_object('code', 'MIGRATIONS_MISSING', 'severity', 'blocking',
                                                   'detail', to_jsonb(v_missing));
    END IF;
  END IF;

  -- THE STRUCTURAL INVARIANTS THE LIVE PROOFS PIN, re-derived here.
  v_seven := (SELECT count(*) = 7 FROM information_schema.role_table_grants
               WHERE table_schema = 'public' AND table_name LIKE 'lightning\_%'
                 AND grantee = 'service_role' AND privilege_type = 'SELECT')
             AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                              WHERE table_schema = 'public' AND table_name LIKE 'lightning\_%'
                                AND grantee IN ('anon', 'authenticated', 'PUBLIC'));
  v_anti := (SELECT coalesce(bool_and(regexp_replace(pg_get_functiondef(p.oid), v_strip, '', 'g')
                                      !~ 'integrity|shadow_comparison|quality_|latency|lightning_alert|fn_lightning_operator_'), false)
                    AND count(*) = 6
               FROM pg_proc p
              WHERE p.oid IN ('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure,
                              'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure,
                              'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text,jsonb)'::regprocedure,
                              'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)'::regprocedure,
                              'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure,
                              'public.fn_cash_clusters_tick_all(jsonb)'::regprocedure));
  v_law := NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname LIKE 'fn\_lightning\_%'
                          AND regexp_replace(pg_get_functiondef(p.oid), v_strip, '', 'g') ~ v_horse);
  v_doors := NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                          WHERE n.nspname = 'public' AND p.proname LIKE 'fn\_lightning\_%'
                            AND has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF NOT (v_seven AND v_anti AND v_law AND v_doors) THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'INVARIANT_FAILED', 'severity', 'blocking',
      'detail', jsonb_build_object('seven_tables', v_seven, 'anti_manipulation', v_anti,
                                   'law_10_5', v_law, 'no_anon_door', v_doors));
  END IF;

  -- THE CLUSTER.
  IF g.cluster_mode = 'frozen' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'CLUSTER_FROZEN', 'severity', 'blocking', 'detail', v_row -> 'frozen');
  ELSIF g.cluster_mode IN ('pending_on', 'pending_off', 'draining', 'paused') OR jsonb_typeof(v_row -> 'drain') = 'object' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'CLUSTER_BUSY', 'severity', 'blocking',
                                                 'detail', jsonb_build_object('cluster_mode', g.cluster_mode, 'drain', v_row -> 'drain'));
  ELSIF g.cluster_mode NOT IN ('must_move', 'lightning') THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'CLUSTER_NOT_READY', 'severity', 'blocking', 'detail', g.cluster_mode);
  END IF;
  IF g.enabled IS DISTINCT FROM true THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'GAME_DISABLED', 'severity', 'blocking', 'detail', NULL);
  END IF;
  IF NOT coalesce(g.must_move, false) THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'NOT_A_MUST_MOVE_GAME', 'severity', 'blocking', 'detail', NULL);
  END IF;
  IF coalesce((v_row ->> 'open_alerts')::integer, 0) > 0 THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'OPEN_ALERTS', 'severity', 'blocking',
                                                 'detail', (v_row ->> 'open_alerts')::integer);
  END IF;
  IF coalesce((v_row ->> 'integrity_open_high')::integer, 0) > 0 THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'INTEGRITY_HIGH_SIGNALS_OPEN', 'severity', 'blocking',
                                                 'detail', (v_row ->> 'integrity_open_high')::integer);
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v_cfg -> 'invalid', '[]'::jsonb)) x(v)
              WHERE x.v ->> 'key' = 'matcher_version') THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'MATCHER_VERSION_INVALID', 'severity', 'blocking',
      'detail', (SELECT jsonb_agg(x.v) FROM jsonb_array_elements(v_cfg -> 'invalid') x(v) WHERE x.v ->> 'key' = 'matcher_version'));
  END IF;
  IF (v_cfg ->> 'worker_mode') = 'off' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'WORKER_OFF', 'severity', 'blocking',
      'detail', 'worker_mode off: a converted pool would form no hands (set_worker_mode form)');
  ELSIF (v_cfg ->> 'worker_mode') = 'shadow' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'WORKER_SHADOW_ONLY', 'severity', 'evidence',
      'detail', 'worker_mode shadow plans and compares and forms no hands');
  END IF;

  -- THE SHADOW: the A/A calibration of the live matcher against its port,
  -- and the candidate, from this Cluster's comparisons or else the estate's.
  v_sr := public.fn_lightning_shadow_report(g.id, v_now - interval '7 days', v_now);
  v_scope := 'cluster';
  IF jsonb_array_length(coalesce(v_sr -> 'version_pairs', '[]'::jsonb)) = 0 THEN
    v_sr := public.fn_lightning_shadow_report(NULL, v_now - interval '7 days', v_now);
    v_scope := CASE WHEN jsonb_array_length(coalesce(v_sr -> 'version_pairs', '[]'::jsonb)) = 0 THEN NULL ELSE 'estate' END;
  END IF;
  SELECT p.v INTO v_aa FROM jsonb_array_elements(coalesce(v_sr -> 'version_pairs', '[]'::jsonb)) p(v)
   WHERE p.v ->> 'live_matcher_version' = v_live_v AND coalesce((p.v ->> 'aa_calibration')::boolean, false)
   LIMIT 1;
  SELECT p.v INTO v_cand FROM jsonb_array_elements(coalesce(v_sr -> 'version_pairs', '[]'::jsonb)) p(v)
   WHERE p.v ->> 'live_matcher_version' = v_live_v AND p.v ->> 'shadow_matcher_version' = v_cfg ->> 'shadow_matcher_version'
     AND NOT coalesce((p.v ->> 'aa_calibration')::boolean, false)
   LIMIT 1;
  IF v_aa ->> 'verdict' = 'calibration_bias' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'AA_CALIBRATION_BIAS', 'severity', 'blocking', 'detail', v_aa);
  ELSIF v_aa IS NULL OR v_aa ->> 'verdict' IS DISTINCT FROM 'calibrated' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'NO_AA_CALIBRATION', 'severity', 'evidence',
                                                 'detail', coalesce(v_aa -> 'verdict', 'null'::jsonb));
  END IF;

  -- THE LATENCY: no leg above its ceiling over the configured windows.
  FOR v_leg IN SELECT x.k FROM jsonb_object_keys(coalesce(v_cfg -> 'alert_latency_p95_ms', '{}'::jsonb)) x(k) ORDER BY x.k LOOP
    v_reg := public.fn_lightning_latency_regression(g.id, v_leg, v_cfg, v_now);
    IF v_reg IS NOT NULL THEN
      v_over := v_over || jsonb_build_object('leg', v_leg, 'ceiling_ms', v_cfg -> 'alert_latency_p95_ms' -> v_leg,
                                             'windows', v_reg);
    END IF;
  END LOOP;
  IF jsonb_array_length(v_over) > 0 THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'LATENCY_ABOVE_CEILING', 'severity', 'blocking', 'detail', v_over);
  END IF;
  v_lat_to := (v_row -> 'latency' ->> 'window_to')::timestamptz;
  IF v_lat_to IS NULL OR v_lat_to < v_now - interval '24 hours' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'NO_LATENCY_EVIDENCE', 'severity', 'evidence',
                                                 'detail', to_jsonb(v_lat_to));
  END IF;

  v_verdict := CASE
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_reasons) r(v) WHERE r.v ->> 'severity' = 'blocking') THEN 'no_go'
    WHEN jsonb_array_length(v_reasons) > 0 THEN 'insufficient_evidence'
    ELSE 'go' END;

  RETURN public.fn_lightning_operator_redact(jsonb_build_object(
    'ok', true,
    'cluster_id', g.id,
    'as_of', v_now,
    'verdict', v_verdict,
    'reasons', v_reasons,
    'evidence', jsonb_build_object(
      'migrations', jsonb_build_object('expected', cardinality(c_versions),
                                       'applied', cardinality(c_versions) - coalesce(cardinality(v_missing), cardinality(c_versions)),
                                       'missing', to_jsonb(v_missing)),
      'invariants', jsonb_build_object('seven_tables', v_seven, 'anti_manipulation', v_anti, 'law_10_5', v_law,
                                       'no_anon_door', v_doors, 'proofs_evaluated_in_sql', false),
      'cluster', jsonb_build_object(
        'cluster_mode', g.cluster_mode, 'lightning_enabled', coalesce(g.lightning_enabled, false),
        'game_enabled', g.enabled, 'must_move', g.must_move,
        'frozen', g.cluster_mode = 'frozen', 'paused', g.cluster_mode = 'paused',
        'drain_open', jsonb_typeof(v_row -> 'drain') = 'object',
        'worker_mode', v_cfg ->> 'worker_mode',
        'live_eligible', v_row -> 'live_eligible', 'on_threshold', v_row -> 'on_threshold',
        'off_threshold', v_row -> 'off_threshold',
        'would_turn_on', coalesce((v_row ->> 'live_eligible')::integer, 0) >= coalesce((v_row ->> 'on_threshold')::integer, 0),
        'club_is_public', v_club.is_public, 'game_is_private', g.is_private),
      'alerts', jsonb_build_object('open', v_row -> 'open_alerts'),
      'integrity', jsonb_build_object('open', v_row -> 'integrity_open_signals', 'open_high', v_row -> 'integrity_open_high'),
      'shadow', jsonb_build_object('scope', v_scope, 'aa_calibration', v_aa, 'candidate', v_cand),
      'latency', jsonb_build_object('latest_window_to', v_lat_to, 'over', v_over),
      'matcher', v_row -> 'matcher')));
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_rollout_readiness(uuid) IS
  'Lightning Phase 13 (20261009235505): the go / no-go evidence for enabling Lightning on one Cluster - every Lightning migration recorded, the structural invariants the live proofs pin (seven-tables census, anti-manipulation pin, Law 10.5, no anon door), the Cluster''s state, open alerts, open high integrity signals, the A/A calibration and candidate shadow verdicts, latency against the alert ceilings, the matcher and the worker mode; verdict go / no_go / insufficient_evidence with reasons [{code, severity, detail}]. Read-only; the operator doors'' gate. authenticated and service_role, never anon.';

REVOKE ALL ON FUNCTION public.fn_lightning_rollout_readiness(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_lightning_rollout_readiness(uuid) TO authenticated, service_role;

-- ===========================================================================
-- 22. READ BACK: who may execute what, carried semantically (production's
--     autorevoke event trigger rewrites ACLs after CREATE FUNCTION).
-- ===========================================================================

DO $chk$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.fn_lightning_operator_control(uuid,text,text,jsonb)',
                           'public.fn_lightning_rollout_readiness(uuid)'] LOOP
    IF NOT has_function_privilege('authenticated', f::regprocedure, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f::regprocedure, 'EXECUTE')
       OR has_function_privilege('anon', f::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '% must be executable by authenticated and service_role and never by anon', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.fn_lightning_drain_advance(uuid,timestamp with time zone)',
                           'public.fn_lightning_operator_may_control(uuid)',
                           'public.fn_lightning_operator_state(uuid)',
                           'public.fn_lightning_spec_flags(boolean,jsonb)',
                           'public.fn_lightning_joins_enabled(uuid)',
                           'public.fn_lightning_pool_enter_seated(uuid)'] LOOP
    IF NOT has_function_privilege('service_role', f::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', f::regprocedure, 'EXECUTE')
       OR has_function_privilege('anon', f::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '% must be executable by service_role alone', f;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name LIKE 'lightning\_%'
         AND grantee = 'service_role' AND privilege_type = 'SELECT') <> 7 THEN
    RAISE EXCEPTION 'the Phase 2 census of exactly seven Lightning tables granted to service_role no longer holds';
  END IF;
END
$chk$;

COMMIT;
