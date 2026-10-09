-- 20261009144343_lightning_phase_12_operator_dashboard_and_alerting.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- LIGHTNING PHASE 12 (SPECIFICATION PHASE 21, THE DATABASE SIDE): THE
-- OPERATOR DASHBOARD, ITS ALERTS, THE LATENCY LEDGER, AND A CALLER FOR THE
-- INTEGRITY SCAN. It also closes the two Phase 11 carry-forward items
-- "integrity scan has no caller" and "latency telemetry is not persisted".
--
-- WHAT EXISTS AND IS REUSED, read from PokerIQ-Production on 2026-10-09:
--   * The gate. fn_ca_can_review_integrity(club) (SECURITY DEFINER, STABLE,
--     authenticated) is true for a platform admin (fn_is_platform_admin():
--     profiles.role in admin, superadmin, god), the club's owner
--     (clubs.owner_id) and an owner, co_owner or admin club_members row that
--     is not banned or suspended. It is the Hub's own integrity-review gate,
--     so the operator doors use exactly it, plus service_role.
--   * The page. fn_raise_server_financial_alert(severity, source, message,
--     context, dedupe_key, entity_id) writes one financial_alerts row and
--     answers the OPEN row of the same source and context.dedupe_key instead
--     of a second one (one open alert per thing that is wrong), rate limited
--     to 60 a minute per source. Its AFTER triggers turn a row into an
--     incident and carry a resolution to it. The freezes already page through
--     it: source lightning_formation (the barrier) and lightning_settlement
--     (the settlement freeze), message LIGHTNING_CLUSTER_FROZEN, dedupe key
--     lightning_cluster_frozen:<cluster>.
--   * The event ledger is cash_cluster_events (game_id, kind, payload, at,
--     cluster_epoch, request_id), indexed (game_id, at DESC). A drive failure
--     is kind lightning_drive_error (fn_cash_cluster_lightning_drive's own
--     sub-block); a stuck-conversion reap that failed is
--     lightning_pending_on_reap_failed or lightning_pending_off_reap_failed
--     (fn_cash_cluster_reap_stuck_conversions); a freeze is cluster_frozen.
--     The tick's own result (reaped, lightning_reaped, disconnects_reaped) is
--     not persisted, so the formation reaper is judged by its OUTCOME: a live
--     instance past its deadline by more than the alert window.
--   * Mode transitions are cash_cluster_epoch (one row per epoch; its mode is
--     updated in place by trg_cash_games_epoch_follows_its_game) and
--     cash_cluster_conversion (pending_on / pending_off and their outcome).
--   * The reconcile view is fn_lightning_pool_stack(session) = the anchor
--     seat's stack minus fn_lightning_pool_exposure(player, cluster), the
--     chips committed by a fold in a hand still live.
--   * fn_lightning_cluster_forensics and fn_lightning_hand_replay_check are
--     service_role only and carry raw event payloads; every operator door
--     wraps them through fn_lightning_operator_redact, which drops every key
--     at any depth whose name contains card, hole, deck, seed or shuffle.
--   * The managed cron API of 20261009045421: managed postgres reads
--     cron.job and writes it only through cron.schedule / cron.alter_job.
--     This file adds one job through exactly that API and reads it back.
--
-- THE DOORS (all SECURITY DEFINER, search_path pinned). Every browser door is
-- executable by authenticated and service_role and never by anon. Its gate is
-- service_role (auth.role()), or fn_is_platform_admin(), or
-- fn_ca_can_review_integrity(<the Cluster's club>); anyone else is answered
-- {ok:false, code:'NOT_AUTHORIZED', reason:'NOT_AUTHORIZED'} and learns
-- nothing, not even whether the Cluster exists. Every answer is passed
-- through fn_lightning_operator_redact, and none ever reads a hole card.
-- Refusals carry both code and reason with the same value.
--
--   fn_lightning_operator_overview(p_club_id uuid) -> jsonb
--     {ok:true, club_id, as_of, truncated, clusters:[<row>]}  (at most 200
--     Clusters of the club, by name: every one not closed, plus any closed
--     one still in a Lightning mode). <row> carries counts only, never a
--     player:
--     {cluster_id, name, variant, sb, bb, handedness, lightning_enabled,
--      cluster_mode, cluster_epoch, mode_since, on_threshold, off_threshold,
--      live_eligible, worker_mode,
--      flags:{shadow_matcher, integrity_telemetry, auto_rebuy, latency_telemetry},
--      pool:{joining, eligibility_check, active, sit_out, disconnected, leaving},
--      reservations:{pending, committed},
--      instances:{forming, reserved, dealing, settling},
--      orphan_reservations, blind_obligations_open,
--      stuck_conversion: null | {conversion_id, from_mode, to_mode, opened_at,
--                                age_ms, threshold_ms},
--      frozen: null | {at, reason, invariant},
--      open_alerts, integrity_open_signals,
--      shadow: null | {verdict, comparisons, delta_mean, live_matcher_version,
--                      shadow_matcher_version},
--      latency: null | {window_from, window_to, legs:{<leg>:{n,p50,p95,p99}}}}
--     An orphan reservation is a pending or committed one whose instance is
--     missing or no longer live, whose slot is closed, or (pending) past its
--     expiry. mode_since is the open conversion's opened_at in pending_on /
--     pending_off, the freeze event's at when frozen, else the epoch's start.
--
--   fn_lightning_operator_cluster(p_cluster_id uuid, p_from timestamptz,
--                                 p_to timestamptz) -> jsonb
--     The window defaults to the 24 hours before now, at most 90 days.
--     {ok:true, cluster_id, from, to, cluster:<row>,
--      transitions:[latest 50, newest first: {kind:'epoch', at, epoch, mode,
--        started_by, ended_at} | {kind:'conversion', at, conversion_id,
--        from_mode, to_mode, status, abort_reason, trigger_population,
--        on_threshold, off_threshold, epoch_before, epoch_after, opened_at,
--        closed_at, chips_at_begin, chips_at_commit} | {kind:'freeze', at,
--        reason, invariant, cluster_epoch}],
--      reservations:[open, at most 200: {reservation_id, player_id, state,
--        seat_number, instance_id, instance_state, created_at, expires_at,
--        orphan}],
--      blind_ledger:[open obligations, at most 200: {player_id,
--        missed_bb_debt, missed_sb_debt, bb_owed, sb_owed, debt_since,
--        bb_count, sb_count}],
--      reconcile:[open pool sessions, at most 500: {pool_session_id,
--        player_id, state, anchor_seat_id, anchor_stack, exposure,
--        pool_stack, ok}],
--      shadow_report:<fn_lightning_shadow_report(cluster, from, to)>,
--      integrity_signals:[latest 100 detected in the window: {id,
--        pattern_type, source, player_a, player_b, window_start, window_end,
--        suspicion_score, severity, status, detected_at, reviewed_by,
--        reviewed_at, notes, evidence}],
--      alerts:[open lightning financial_alerts of the Cluster, at most 50:
--        {id, severity, source, check, message, created_at, dedupe_key}],
--      latency_windows:[latest 60 ending in the window: {window_from,
--        window_to, legs}],
--      quality: null | {window_from, window_to, live_matcher_version,
--        shadow_matcher_version, live_quality_score, shadow_quality_score,
--        live_components, shadow_components, quality_weights},
--      matcher_passes:[latest 20: {request_id, cluster_epoch,
--        matcher_version, started_at, finished_at, hands_formed, result}]}
--     reconcile.ok: the anchor seat is live and the player's, and its stack
--     covers the exposure, so pool_stack = anchor_stack - exposure exactly.
--
--   fn_lightning_operator_hand_replay(p_cluster_id uuid, p_hand_id uuid)
--     {ok:true, cluster_id, hand_id, replay:<fn_lightning_hand_replay_check>,
--      hand:{hand_id, hand_number, cluster_epoch, lightning_instance_id,
--        instance_state, formed_at, settled_at, player_count, hand_history_id,
--        rules_version, matcher_version, blind_algorithm_version,
--        lightning_version, rake_version, rake, bbj},
--      players:[{player_id, seat, position, blind_role, stack_before,
--        stack_after, net_result, fold_type, folded_at, committed_at_fold,
--        waited_ms, showed}],
--      events:[the hand's ledger events, at most 200: {id, kind, at,
--        cluster_epoch, payload}]}
--     A hand of another Cluster is NOT_FOUND. Never a card.
--
--   fn_lightning_operator_session_trail(p_cluster_id uuid,
--                                       p_pool_session_id uuid)
--     REPLAY PLAYER SESSION and REPLAY MODE TRANSITION:
--     {ok:true, cluster_id, pool_session:{pool_session_id, player_id, state,
--        cluster_epoch, entered_at, exited_at, exit_reason, starting_stack,
--        ending_stack, net_result, hands, fast_folds, normal_folds,
--        fold_and_watch, showdowns, anchor_seat_id, disconnected_at,
--        stop_requested_at, auto_rebuys, auto_rebuy_total, pool_stack},
--      trail:[oldest first, at most 500: {at, source:'event'|'slot'|
--        'reservation'|'hand', kind, ...}],
--      transitions:[the Cluster's epochs and conversions overlapping the
--        session, oldest first]}
--
--   fn_lightning_operator_forensics(p_cluster_id uuid, p_from timestamptz,
--                                   p_to timestamptz, p_limit integer)
--     fn_lightning_cluster_forensics, gated and redacted (default window the
--     last hour, limit as that reader clamps it: 1..2000).
--
--   fn_lightning_operator_signal_review(p_signal_id bigint, p_status text,
--                                       p_note text)
--     The only writing operator door. lightning_integrity_signal.id is a
--     bigint, so the contract's name is kept and its type is bigint. Sets
--     status to reviewed | cleared | actioned with reviewed_by = auth.uid(),
--     reviewed_at and the note (at most 2000 characters; NULL keeps the old
--     note), and writes one cash_cluster_events row kind
--     integrity_signal_reviewed {signal_id, pattern_type, from_status,
--     to_status, reviewer, note, at}. The same status and note again answers
--     idempotent and writes nothing. Refusals: NOT_AUTHORIZED, NOT_FOUND,
--     INVALID_STATUS, REVIEWER_REQUIRED (no auth.uid()). Answer {ok:true,
--     idempotent, signal_id, cluster_id, status, previous_status,
--     reviewed_by, reviewed_at, notes}. A rescan never overwrites it (the
--     Phase 11 scan and report never touch status).
--
-- THE ENGINE'S DOOR (SECURITY DEFINER, service_role only):
--   fn_lightning_latency_report(p_cluster_id uuid, p_window_from timestamptz,
--                               p_window_to timestamptz, p_legs jsonb)
--     p_legs: an object of at most these legs, each {n, p50, p95, p99}
--     (n a required integer 0..1e9; each percentile null or 0..86400000 ms,
--     p50 <= p95 <= p99 where present, no other member): fold_ack,
--     ack_to_idle, idle_to_match, match_to_hand, hand_to_first_render,
--     fast_fold_to_next_hand, normal_fold_to_next_hand,
--     fold_watch_to_next_hand. Window: to > from, at most one hour long,
--     from no more than seven days ago, to at most five minutes ahead.
--     Refusals, checked in this order: INVALID_ARGUMENT, CLUSTER_NOT_FOUND,
--     TELEMETRY_OFF (latency_telemetry false), INVALID_WINDOW, INVALID_LEGS
--     (not an object), LEGS_TOO_LARGE (> 8 KB), CARRIES_CARDS (any key at
--     any depth naming a card, hole, deck or seed), UNKNOWN_LEG {keys},
--     INVALID_LEG {errors:[{leg, key, reason}]}. Idempotent per (Cluster,
--     window_from): the same window_to and legs again answer idempotent:true;
--     anything different answers IDEMPOTENCY_CONFLICT {id} and changes
--     nothing. Answer {ok:true, idempotent, id, cluster_id, window_from,
--     window_to, legs:<count>}. Stored in lightning_latency_window.
--
-- THE SWEEP (SECURITY DEFINER, service_role only, scheduled every minute by
-- the managed cron API as lightning-alert-sweep-1m; NOT in the tick):
--   fn_lightning_alert_sweep(p_now timestamptz DEFAULT now()) -> jsonb
--     One pass over the Lightning estate (Clusters with lightning_enabled or
--     in pending_on, lightning, pending_off, frozen, paused or draining; at
--     most 500), every check of every Cluster in its own EXCEPTION block, so
--     a failure is a line in the answer's errors and never a failed job. A
--     concurrent pass answers skipped:'busy' (transaction advisory lock).
--     Each finding raises through fn_raise_server_financial_alert, source
--     lightning_alerts, with a stable dedupe key, so a thing that stays
--     wrong is one open alert however many passes see it:
--       frozen             critical  lightning_cluster_frozen:<cluster>
--                          raised only when no open alert of the freeze
--                          sources (lightning_formation, lightning_settlement,
--                          lightning_alerts) carries that key.
--       stuck_conversion   critical  lightning_stuck_conversion:<conversion>
--                          a pending conversion older than
--                          alert_stuck_conversion_ms (default 20 minutes,
--                          five beyond the 15-minute reaper).
--       drive_error        warning   lightning_drive_error:<cluster>
--                          at least alert_drive_errors lightning_drive_error
--                          events in the alert window.
--       reaper_failure     critical  lightning_reaper_failure:<cluster>
--                          at least alert_reaper_failures reap_failed events
--                          in the window, or a live instance past its
--                          deadline by more than the window.
--       integrity_spike    warning   lightning_integrity_spike:<cluster>
--                          at least alert_integrity_high_signals new
--                          high-severity signals in the window.
--       latency_regression warning   lightning_latency_regression:<cluster>:<leg>
--                          the latest alert_latency_windows windows (within
--                          their own span) each carry >= alert_latency_min_samples
--                          samples of the leg with p95 above
--                          alert_latency_p95_ms.<leg>.
--     The window of an event check starts at the later of now minus
--     alert_window_ms and the last resolution of its key, so a resolved alert
--     comes back only for new events. A state check (frozen,
--     stuck_conversion, latency_regression) re-measures its open alerts and
--     resolves them when the condition is gone; an event check stays open
--     until an operator resolves it. It also runs fn_lightning_integrity_scan
--     for every Cluster whose config has integrity_telemetry true and that is
--     not frozen, at most once per clock hour each and at most five per pass
--     (closing "integrity scan has no caller"), and prunes latency windows
--     older than 30 days, at most 5000 rows a pass. It never writes a
--     Cluster's state: no cash_games, seat, cash session, pool, slot,
--     reservation, instance, hand or blind-ledger row (pinned below), so a
--     frozen Cluster stays exactly as it froze.
--     Answer {ok:true, as_of, clusters_checked, raised:{<check>:n},
--     open:{<check>:n}, rate_limited, resolved:{<check>:n},
--     integrity_scans:[{cluster_id, ok, written}], pruned, errors:[{check,
--     cluster_id, sqlstate, message}]} or {ok:true, skipped:'busy'}.
--
-- periodic-work: the alert sweep IS the operator alerting the specification
-- requires (Phase 21: alert on freeze, stuck conversions, drive errors,
-- reaper failures, integrity spikes and latency regressions). It repairs,
-- retries, re-drives and pays nothing; it raises the page a person acts on
-- and resolves only its own state alerts when a re-measure finds them gone.
-- The integrity scan it calls is Phase 11's on-demand telemetry door; this
-- schedule is that door's caller, not compensation for a failing writer.
--
-- CONFIG. fn_lightning_config gains, in a THIRD jsonb_build_object (the first
-- is at 88 of its 100 arguments; the Phase 11 second object is left exactly
-- as it is), read, clamped and reported in invalid like every other key:
--   latency_telemetry             true      (inert without Lightning traffic)
--   latency_window_ms             60000     10000..600000
--   alert_window_ms               600000    60000..86400000
--   alert_stuck_conversion_ms     1200000   60000..86400000
--   alert_drive_errors            3         1..100000
--   alert_reaper_failures         1         1..100000
--   alert_integrity_high_signals  5         1..100000
--   alert_latency_windows         3         2..60
--   alert_latency_min_samples     20        1..1000000
--   alert_latency_p95_ms          {fold_ack 500, ack_to_idle 500,
--                                  idle_to_match 5000, match_to_hand 2000,
--                                  hand_to_first_render 2000,
--                                  fast_fold_to_next_hand 5000,
--                                  normal_fold_to_next_hand 60000,
--                                  fold_watch_to_next_hand 90000}, each
--                                  10..3600000; an unknown leg is reported.
--
-- TABLES. lightning_latency_window (one row per Cluster and window_from) and
-- lightning_alert_sweep_state (the sweep's own cadence, keyed by text). Both
-- have RLS on, no policy and NO table or sequence privilege for any role,
-- service_role included, so 20260920235343's census of exactly seven
-- Lightning tables granted to service_role stays true. No foreign key to
-- cash_games. Two indexes on lightning_integrity_signal (empty in
-- production) serve the per-Cluster reads.
--
-- PROOFS RESTATED. 20261008161509's proof that no fn_lightning_ or
-- fn_cash_cluster body outside its own doors names the signal store, the
-- shadow ledger or the quality score is superseded: the operator doors and
-- the sweep read them by design. Its intent ("no seating path reads them")
-- is restated below with the Phase 12 doors added to its exclusion list, and
-- the anti-manipulation pin (matcher, legality, form_hand, match_plan,
-- match_and_form, tick_all) is restated with the latency ledger and the
-- alerting added to its forbidden terms.
--
-- LAW 10.5. Nothing here reads is_horse or horse_id. A horse is counted,
-- reconciled, replayed, timed and alerted on exactly as a human.
-- LIGHTNING IS OFF EVERYWHERE: on production every Cluster is must_move with
-- lightning_enabled false, so the sweep's estate is empty and every door
-- answers zeros. Non-Lightning cash play is unchanged.
--
-- @live-proof: (SELECT c.relrowsecurity AND NOT EXISTS (SELECT 1 FROM pg_policy pol WHERE pol.polrelid = c.oid) AND NOT has_table_privilege('anon', c.oid, 'SELECT') AND NOT has_table_privilege('authenticated', c.oid, 'SELECT') AND NOT has_table_privilege('service_role', c.oid, 'SELECT') AND NOT has_table_privilege('service_role', c.oid, 'INSERT') FROM pg_class c WHERE c.oid = 'public.lightning_latency_window'::regclass)
-- @live-proof: (SELECT c.relrowsecurity AND NOT EXISTS (SELECT 1 FROM pg_policy pol WHERE pol.polrelid = c.oid) AND NOT has_table_privilege('anon', c.oid, 'SELECT') AND NOT has_table_privilege('authenticated', c.oid, 'SELECT') AND NOT has_table_privilege('service_role', c.oid, 'SELECT') AND NOT has_table_privilege('service_role', c.oid, 'INSERT') FROM pg_class c WHERE c.oid = 'public.lightning_alert_sweep_state'::regclass)
-- @live-proof: (SELECT count(*) = 7 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name LIKE 'lightning\_%' AND grantee = 'service_role' AND privilege_type = 'SELECT') AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name LIKE 'lightning\_%' AND grantee IN ('anon', 'authenticated', 'PUBLIC'))
-- @live-proof: (SELECT bool_and(p.prosecdef AND array_to_string(p.proconfig, ',') ~ 'search_path=' AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) AND count(*) = 6 FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_operator_overview(uuid)'::regprocedure, 'public.fn_lightning_operator_cluster(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure, 'public.fn_lightning_operator_hand_replay(uuid,uuid)'::regprocedure, 'public.fn_lightning_operator_session_trail(uuid,uuid)'::regprocedure, 'public.fn_lightning_operator_forensics(uuid,timestamp with time zone,timestamp with time zone,integer)'::regprocedure, 'public.fn_lightning_operator_signal_review(bigint,text,text)'::regprocedure))
-- @live-proof: (SELECT bool_and(array_to_string(p.proconfig, ',') ~ 'search_path=' AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND p.prosecdef = (p.proname IN ('fn_lightning_latency_report', 'fn_lightning_alert_sweep', 'fn_lightning_operator_cluster_row'))) AND count(*) = 7 FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_latency_report(uuid,timestamp with time zone,timestamp with time zone,jsonb)'::regprocedure, 'public.fn_lightning_latency_regression(uuid,text,jsonb,timestamp with time zone)'::regprocedure, 'public.fn_lightning_alert_sweep(timestamp with time zone)'::regprocedure, 'public.fn_lightning_operator_redact(jsonb)'::regprocedure, 'public.fn_lightning_operator_may(uuid)'::regprocedure, 'public.fn_lightning_operator_cluster_row(uuid,timestamp with time zone)'::regprocedure, 'public.fn_lightning_alert_raise(text,uuid,text,text,text,jsonb)'::regprocedure))
-- @live-proof: (SELECT bool_and(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') !~ 'integrity|shadow_comparison|quality_|latency|lightning_alert|fn_lightning_operator_') FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure, 'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure, 'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text,jsonb)'::regprocedure, 'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)'::regprocedure, 'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure, 'public.fn_cash_clusters_tick_all(jsonb)'::regprocedure))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND (p.proname LIKE 'fn\_lightning\_%' OR p.proname LIKE 'fn\_cash\_cluster%') AND p.proname NOT IN ('fn_lightning_integrity_scan', 'fn_lightning_integrity_report', 'fn_lightning_quality_score', 'fn_lightning_quality_components', 'fn_lightning_shadow_record', 'fn_lightning_shadow_report', 'fn_lightning_config', 'fn_lightning_operator_overview', 'fn_lightning_operator_cluster', 'fn_lightning_operator_cluster_row', 'fn_lightning_operator_signal_review', 'fn_lightning_alert_sweep', 'fn_lightning_latency_report', 'fn_lightning_latency_regression') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'lightning_integrity_signal|lightning_matcher_shadow_comparison|ca_collusion_signals|collusion_tracking|anti_cheat_flags|quality_score|quality_weights|fn_lightning_integrity_|lightning_latency_window|lightning_alert_sweep_state'))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND (p.proname LIKE 'fn\_lightning\_operator\_%' OR p.proname IN ('fn_lightning_latency_report', 'fn_lightning_latency_regression', 'fn_lightning_alert_sweep', 'fn_lightning_alert_raise', 'fn_lightning_config')) AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id'))
-- @live-proof: (SELECT bool_and(s ~ 'public\.fn_lightning_operator_redact\(' AND s !~* 'hole_cards|hand_private_state|table_hole_cards|hand_history[^_]') AND count(*) = 6 FROM (SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') AS s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('fn_lightning_operator_overview', 'fn_lightning_operator_cluster', 'fn_lightning_operator_hand_replay', 'fn_lightning_operator_session_trail', 'fn_lightning_operator_forensics', 'fn_lightning_operator_signal_review')) q) AND (SELECT s ~ '\(card\|hole\|deck\|seed\|shuffle\)' FROM (SELECT pg_get_functiondef('public.fn_lightning_operator_redact(jsonb)'::regprocedure) AS s) r) AND public.fn_lightning_operator_redact('{"a":{"hole_cards":["As"],"deck_seed":"x","b":[{"card":1,"ok":2}]},"seedless":1}'::jsonb) = '{"a":{"b":[{"ok":2}]}}'::jsonb
-- @live-proof: (SELECT count(*) = 1 FROM cron.job WHERE jobname = 'lightning-alert-sweep-1m' AND active AND schedule = '* * * * *' AND position('public.fn_lightning_alert_sweep()' IN command) > 0)
-- @live-proof: (SELECT (c ->> 'latency_telemetry')::boolean = true AND (c ->> 'latency_window_ms')::integer = 60000 AND (c ->> 'alert_window_ms')::integer = 600000 AND (c ->> 'alert_stuck_conversion_ms')::integer = 1200000 AND (c ->> 'alert_drive_errors')::integer = 3 AND (c ->> 'alert_reaper_failures')::integer = 1 AND (c ->> 'alert_integrity_high_signals')::integer = 5 AND (c ->> 'alert_latency_windows')::integer = 3 AND (c ->> 'alert_latency_min_samples')::integer = 20 AND (c -> 'alert_latency_p95_ms' ->> 'fast_fold_to_next_hand')::integer = 5000 AND (SELECT count(*) FROM jsonb_object_keys(c -> 'alert_latency_p95_ms')) = 8 AND c ? 'quality_weights' AND c ? 'multi_table_limit' FROM (SELECT public.fn_lightning_config(NULL) AS c) q)
-- @live-proof: (SELECT i.indisunique AND pg_get_indexdef(i.indexrelid) ~ '\(cluster_id, window_from\)' FROM pg_index i WHERE i.indexrelid = 'public.lightning_latency_window_one_per_window'::regclass) AND to_regclass('public.lightning_integrity_signal_by_cluster') IS NOT NULL AND to_regclass('public.lightning_integrity_signal_open_by_cluster') IS NOT NULL
-- @live-proof: (SELECT s ~ 'pg_try_advisory_xact_lock' AND s ~ 'fn_raise_server_financial_alert|fn_lightning_alert_raise' AND (length(s) - length(replace(s, 'EXCEPTION WHEN OTHERS', ''))) / length('EXCEPTION WHEN OTHERS') >= 8 AND s !~* '(UPDATE|INSERT INTO|DELETE FROM)\s+public\.(cash_games|tables|table_seats|cash_player_session|lightning_pool_session|lightning_pool_slot|lightning_reservation|lightning_instance|lightning_hand|lightning_blind_ledger|cash_cluster_conversion|cash_cluster_epoch)\M' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_alert_sweep(timestamp with time zone)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_clusters_tick_all(jsonb)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') !~ 'fn_lightning_alert_sweep|fn_lightning_integrity_scan|fn_lightning_latency_report')

BEGIN;

-- The managed cron API's own isolation (20261009045421): a repeatable-read
-- snapshot, so a concurrent edit of the job row fails this file with 40001
-- rather than being overwritten. Nothing else here depends on it.
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '2s';

-- ===========================================================================
-- 1. THE LATENCY LEDGER: one row per Cluster and engine window. The legs are
--    the engine's aggregates (n, p50, p95, p99 per leg, milliseconds), kept
--    as sent after validation by fn_lightning_latency_report.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.lightning_latency_window (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cluster_id  uuid NOT NULL,
  window_from timestamptz NOT NULL,
  window_to   timestamptz NOT NULL,
  legs        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lightning_latency_window_ordered CHECK (window_to > window_from),
  CONSTRAINT lightning_latency_window_legs_bounded CHECK (
    jsonb_typeof(legs) = 'object' AND octet_length(legs::text) <= 8192)
);

COMMENT ON TABLE public.lightning_latency_window IS
  'Lightning Phase 12 (20261009144343): the action-latency ledger. One row per (Cluster, engine window): per leg (fold_ack, ack_to_idle, idle_to_match, match_to_hand, hand_to_first_render, fast_fold_to_next_hand, normal_fold_to_next_hand, fold_watch_to_next_hand) the sample count and the p50/p95/p99 in milliseconds. Written only by fn_lightning_latency_report (idempotent per Cluster and window_from), read by the operator doors and fn_lightning_alert_sweep (latency regression). Telemetry only: nothing in the seating path reads it. Never carries a card. RLS on, no role holds a privilege.';

CREATE UNIQUE INDEX IF NOT EXISTS lightning_latency_window_one_per_window
  ON public.lightning_latency_window (cluster_id, window_from);
CREATE INDEX IF NOT EXISTS lightning_latency_window_by_end
  ON public.lightning_latency_window (window_to);

ALTER TABLE public.lightning_latency_window ENABLE ROW LEVEL SECURITY;
-- NO ROLE HOLDS A TABLE OR SEQUENCE PRIVILEGE, service_role included:
-- production's default privileges grant all three roles at birth, so they are
-- taken back here, and 20260920235343's census of exactly seven Lightning
-- tables granted to service_role stays true.
REVOKE ALL ON TABLE public.lightning_latency_window FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.lightning_latency_window_id_seq FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 2. THE SWEEP'S OWN CADENCE: when it last ran the integrity scan for a
--    Cluster (key integrity_scan:<cluster>), so the scan runs at most once a
--    clock hour per Cluster and is never lost to a missed minute.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.lightning_alert_sweep_state (
  key     text PRIMARY KEY,
  last_at timestamptz NOT NULL,
  detail  jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT lightning_alert_sweep_state_key_shape CHECK (key ~ '^[a-z_]{1,40}:[0-9a-f-]{36}$'),
  CONSTRAINT lightning_alert_sweep_state_detail_bounded CHECK (
    jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 16384)
);

COMMENT ON TABLE public.lightning_alert_sweep_state IS
  'Lightning Phase 12 (20261009144343): fn_lightning_alert_sweep''s own cadence - key integrity_scan:<cluster> records when the sweep last ran fn_lightning_integrity_scan for that Cluster and what it answered, so the scan runs at most once per clock hour per Cluster. RLS on, no role holds a privilege.';

ALTER TABLE public.lightning_alert_sweep_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lightning_alert_sweep_state FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 3. THE PER-CLUSTER READS OF THE SIGNAL STORE (empty in production, so
--    neither build holds a lock for any time): the newest signals of a
--    Cluster, and its open ones.
-- ===========================================================================

CREATE INDEX IF NOT EXISTS lightning_integrity_signal_by_cluster
  ON public.lightning_integrity_signal (cluster_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS lightning_integrity_signal_open_by_cluster
  ON public.lightning_integrity_signal (cluster_id) WHERE status = 'open';

-- ===========================================================================
-- 4. THE REWRITER, in the shape 20261008050805 cut it and 20261008161509
--    reused: an asserted substitution into the body the database carries.
--    Every anchor must appear exactly as often as stated or the file
--    refuses; a body already carrying the marker is left alone, so the file
--    is re-appliable; who may execute and the comment must survive.
-- ===========================================================================

CREATE OR REPLACE FUNCTION pg_temp.lp12_rewrite(p_fn text, p_marker text,
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
-- 5. fn_lightning_config answers the Phase 12 keys (see the header), read,
--    clamped and reported in `invalid` exactly as every other key. Three
--    anchors, each kept in the result so a later substitution still finds
--    it exactly once: the last declaration, the RETURN, and the close of the
--    first jsonb_build_object (88 of its 100 arguments), after which a
--    third object is joined. The Phase 11 second object is untouched.
-- ===========================================================================

SELECT pg_temp.lp12_rewrite(
  'public.fn_lightning_config(uuid)',
  '''latency_window_ms''',
  ARRAY[$a$  v_it_on    boolean;
$a$,
        $a$
  RETURN CASE WHEN v_found THEN '{}'::jsonb
$a$,
        $a$    'invalid', v_inv)
$a$],
  ARRAY[$b$  v_it_on    boolean;
  v_lt_on    boolean;
  v_lt_win   integer;
  v_al_win   integer;
  v_al_stuck integer;
  v_al_drive integer;
  v_al_reap  integer;
  v_al_integ integer;
  v_al_lwin  integer;
  v_al_lmin  integer;
  v_lc_def   jsonb;
  v_lc       jsonb;
  v_lc_cfg   jsonb;
  v_lc_k     text;
$b$,
        $b$
  -- LIGHTNING PHASE 12 (20261009144343): THE LATENCY LEDGER AND THE
  -- OPERATOR ALERTS. latency_telemetry is on by default and inert without
  -- Lightning traffic; the alert thresholds are read by
  -- fn_lightning_alert_sweep. Nothing in the seating path reads any of them.
  v_lt_on := true;
  IF v_cfg ? 'latency_telemetry' AND jsonb_typeof(v_cfg -> 'latency_telemetry') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'latency_telemetry') = 'boolean' THEN
      v_lt_on := (v_cfg ->> 'latency_telemetry')::boolean;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'latency_telemetry', 'given', v_cfg -> 'latency_telemetry',
                                           'reason', 'wrong_type', 'used', v_lt_on);
    END IF;
  END IF;
  r := public.fn_lightning_config_number(v_cfg, 'latency_window_ms', 60000, 10000, 600000, true);
  v_lt_win := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'alert_window_ms', 600000, 60000, 86400000, true);
  v_al_win := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'alert_stuck_conversion_ms', 1200000, 60000, 86400000, true);
  v_al_stuck := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'alert_drive_errors', 3, 1, 100000, true);
  v_al_drive := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'alert_reaper_failures', 1, 1, 100000, true);
  v_al_reap := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'alert_integrity_high_signals', 5, 1, 100000, true);
  v_al_integ := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'alert_latency_windows', 3, 2, 60, true);
  v_al_lwin := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'alert_latency_min_samples', 20, 1, 1000000, true);
  v_al_lmin := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  v_lc_def := jsonb_build_object('fold_ack', 500, 'ack_to_idle', 500, 'idle_to_match', 5000,
                                 'match_to_hand', 2000, 'hand_to_first_render', 2000,
                                 'fast_fold_to_next_hand', 5000, 'normal_fold_to_next_hand', 60000,
                                 'fold_watch_to_next_hand', 90000);
  v_lc := v_lc_def;
  v_lc_cfg := v_cfg -> 'alert_latency_p95_ms';
  IF v_lc_cfg IS NOT NULL AND jsonb_typeof(v_lc_cfg) <> 'null' THEN
    IF jsonb_typeof(v_lc_cfg) <> 'object' THEN
      v_inv := v_inv || jsonb_build_object('key', 'alert_latency_p95_ms', 'given', v_lc_cfg,
                                           'reason', 'wrong_type', 'used', v_lc_def);
    ELSE
      FOREACH v_lc_k IN ARRAY ARRAY['fold_ack', 'ack_to_idle', 'idle_to_match', 'match_to_hand',
                                    'hand_to_first_render', 'fast_fold_to_next_hand',
                                    'normal_fold_to_next_hand', 'fold_watch_to_next_hand'] LOOP
        r := public.fn_lightning_config_number(v_lc_cfg, v_lc_k, (v_lc_def ->> v_lc_k)::numeric, 10, 3600000, true);
        v_lc := v_lc || jsonb_build_object(v_lc_k, (r ->> 'value')::integer);
        IF r ? 'invalid' THEN
          v_inv := v_inv || jsonb_set(r -> 'invalid', '{key}', to_jsonb('alert_latency_p95_ms.' || v_lc_k));
        END IF;
      END LOOP;
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_lc_cfg) k
                  WHERE k NOT IN ('fold_ack', 'ack_to_idle', 'idle_to_match', 'match_to_hand',
                                  'hand_to_first_render', 'fast_fold_to_next_hand',
                                  'normal_fold_to_next_hand', 'fold_watch_to_next_hand')) THEN
        v_inv := v_inv || jsonb_build_object('key', 'alert_latency_p95_ms', 'given', v_lc_cfg,
                                             'reason', 'unknown_leg', 'used', v_lc);
      END IF;
    END IF;
  END IF;

  RETURN CASE WHEN v_found THEN '{}'::jsonb
$b$,
        $b$    'invalid', v_inv)
    -- LIGHTNING PHASE 12 (20261009144343): a third object, so neither the
    -- first (88 of 100 arguments) nor the Phase 11 second one is touched.
    || jsonb_build_object(
    'latency_telemetry', v_lt_on,
    'latency_window_ms', v_lt_win,
    'alert_window_ms', v_al_win,
    'alert_stuck_conversion_ms', v_al_stuck,
    'alert_drive_errors', v_al_drive,
    'alert_reaper_failures', v_al_reap,
    'alert_integrity_high_signals', v_al_integ,
    'alert_latency_windows', v_al_lwin,
    'alert_latency_min_samples', v_al_lmin,
    'alert_latency_p95_ms', v_lc)
$b$],
  ARRAY[1, 1, 1]);

-- ===========================================================================
-- 6. THE REDACTOR. Every operator answer passes through it: any key, at any
--    depth, whose name contains card, hole, deck, seed or shuffle is
--    dropped with its value. A value whose text names none of them cannot
--    hold such a key and is returned as it is, so the common case costs one
--    regular-expression test.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_operator_redact(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v jsonb;
BEGIN
  IF p IS NULL OR p::text !~* '(card|hole|deck|seed|shuffle)' THEN
    RETURN p;
  END IF;
  IF jsonb_typeof(p) = 'object' THEN
    SELECT coalesce(jsonb_object_agg(e.key, public.fn_lightning_operator_redact(e.value)), '{}'::jsonb)
      INTO v
      FROM jsonb_each(p) e
     WHERE e.key !~* '(card|hole|deck|seed|shuffle)';
    RETURN v;
  ELSIF jsonb_typeof(p) = 'array' THEN
    SELECT coalesce(jsonb_agg(public.fn_lightning_operator_redact(e.value) ORDER BY e.ord), '[]'::jsonb)
      INTO v
      FROM jsonb_array_elements(p) WITH ORDINALITY e(value, ord);
    RETURN v;
  END IF;
  RETURN p;
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_operator_redact(jsonb) IS
  'Lightning Phase 12 (20261009144343): drops every key at any depth whose name contains card, hole, deck, seed or shuffle (with its value). Every Lightning operator door answers through it, so no operator payload can carry a hidden card. service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_operator_redact(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_operator_redact(jsonb) TO service_role;

-- ===========================================================================
-- 7. THE GATE: the service, a platform admin, or a reviewer of the club
--    (fn_ca_can_review_integrity: the owner, a co_owner or an admin who is
--    not banned or suspended). Called only inside the definer doors.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_operator_may(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce(auth.role(), '') = 'service_role'
      OR (auth.uid() IS NOT NULL
          AND (coalesce(public.fn_is_platform_admin(), false)
               OR coalesce(public.fn_ca_can_review_integrity(p_club_id), false)));
$fn$;

COMMENT ON FUNCTION public.fn_lightning_operator_may(uuid) IS
  'Lightning Phase 12 (20261009144343): the operator gate - service_role (auth.role()), or a signed-in caller who is a platform admin (fn_is_platform_admin) or may review the club''s integrity (fn_ca_can_review_integrity: owner, co_owner or admin, not banned or suspended). service_role only; the operator doors call it as their owner.';

REVOKE ALL ON FUNCTION public.fn_lightning_operator_may(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_operator_may(uuid) TO service_role;

-- ===========================================================================
-- 8. THE PAGE: one alert of the sweep, through the estate's own path.
--    Answers 'open' when an open lightning_alerts row already carries the
--    key (the page is not repeated), 'raised' for a new row, and
--    'rate_limited' when fn_raise_server_financial_alert declined it.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_alert_raise(
  p_check text, p_cluster_id uuid, p_key text, p_severity text, p_message text, p_context jsonb)
RETURNS text
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.financial_alerts fa
              WHERE fa.source = 'lightning_alerts' AND fa.resolved IS NOT TRUE
                AND fa.context ->> 'dedupe_key' = p_key) THEN
    RETURN 'open';
  END IF;
  v_id := public.fn_raise_server_financial_alert(
    p_severity, 'lightning_alerts', p_message,
    coalesce(p_context, '{}'::jsonb) || jsonb_build_object('check', p_check, 'cluster_id', p_cluster_id),
    p_key, p_cluster_id::text);
  RETURN CASE WHEN v_id IS NULL THEN 'rate_limited' ELSE 'raised' END;
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_alert_raise(text, uuid, text, text, text, jsonb) IS
  'Lightning Phase 12 (20261009144343): one page of fn_lightning_alert_sweep through fn_raise_server_financial_alert, source lightning_alerts, context {check, cluster_id, dedupe_key, ...}; answers open (already paged), raised or rate_limited. service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_alert_raise(text, uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_alert_raise(text, uuid, text, text, text, jsonb) TO service_role;

-- ===========================================================================
-- 9. ONE CLUSTER'S DASHBOARD ROW, counts only (see the header). Every read
--    is a single indexed lookup on the Cluster: the open-pool, live
--    reservation, live instance, owing ledger, open conversion and current
--    epoch partial indexes, financial_alerts' unresolved-by-source index,
--    the signal store's open-by-Cluster index, the shadow ledger's and the
--    latency ledger's keys. The freeze event is read newest-first inside the
--    current epoch only, and only for a frozen Cluster.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_operator_cluster_row(p_cluster_id uuid, p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_now    timestamptz := coalesce(p_now, now());
  g        record;
  v_cfg    jsonb;
  v_pool   jsonb;
  v_res    jsonb;
  v_inst   jsonb;
  v_orphan integer;
  v_owing  integer;
  v_conv   record;
  v_epoch  timestamptz;
  v_frozen jsonb;
  v_fz_at  timestamptz;
  v_fz_p   jsonb;
  v_stuck  jsonb;
  v_alerts integer;
  v_open   integer;
  v_shadow jsonb;
  v_sr     jsonb;
  v_lat    jsonb;
  v_since  timestamptz;
  v_stuck_ms integer;
BEGIN
  SELECT cg.id, cg.club_id, cg.name, cg.variant, cg.sb, cg.bb, cg.handedness, cg.lightning_enabled,
         cg.cluster_mode, cg.cluster_epoch
    INTO g FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_cfg := public.fn_lightning_config(g.id);

  SELECT jsonb_build_object(
           'joining', count(*) FILTER (WHERE s.state = 'joining'),
           'eligibility_check', count(*) FILTER (WHERE s.state = 'eligibility_check'),
           'active', count(*) FILTER (WHERE s.state = 'active'),
           'sit_out', count(*) FILTER (WHERE s.state = 'sit_out'),
           'disconnected', count(*) FILTER (WHERE s.state = 'disconnected'),
           'leaving', count(*) FILTER (WHERE s.state = 'leaving'))
    INTO v_pool
    FROM public.lightning_pool_session s
   WHERE s.cluster_id = g.id AND s.exited_at IS NULL;

  SELECT jsonb_build_object(
           'pending', count(*) FILTER (WHERE r.state = 'pending'),
           'committed', count(*) FILTER (WHERE r.state = 'committed')),
         count(*) FILTER (WHERE (r.state = 'pending' AND r.expires_at < v_now)
                             OR i.id IS NULL
                             OR i.state NOT IN ('forming', 'reserved', 'dealing', 'settling')
                             OR sl.id IS NULL OR sl.closed_at IS NOT NULL)::integer
    INTO v_res, v_orphan
    FROM public.lightning_reservation r
    LEFT JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
    LEFT JOIN public.lightning_pool_slot sl ON sl.id = r.pool_slot_id
   WHERE r.cluster_id = g.id AND r.state IN ('pending', 'committed');

  SELECT jsonb_build_object(
           'forming', count(*) FILTER (WHERE i.state = 'forming'),
           'reserved', count(*) FILTER (WHERE i.state = 'reserved'),
           'dealing', count(*) FILTER (WHERE i.state = 'dealing'),
           'settling', count(*) FILTER (WHERE i.state = 'settling'))
    INTO v_inst
    FROM public.lightning_instance i
   WHERE i.cluster_id = g.id AND i.state IN ('forming', 'reserved', 'dealing', 'settling');

  SELECT count(*)::integer INTO v_owing FROM public.lightning_blind_ledger bl
   WHERE bl.cluster_id = g.id AND (bl.missed_bb_debt > 0 OR bl.missed_sb_debt > 0);

  SELECT cc.id, cc.from_mode, cc.to_mode, cc.opened_at INTO v_conv
    FROM public.cash_cluster_conversion cc WHERE cc.cluster_id = g.id AND cc.status = 'pending';
  SELECT e.started_at INTO v_epoch FROM public.cash_cluster_epoch e
   WHERE e.cluster_id = g.id AND e.ended_at IS NULL;

  IF g.cluster_mode = 'frozen' THEN
    SELECT e.at, e.payload INTO v_fz_at, v_fz_p
      FROM public.cash_cluster_events e
     WHERE e.game_id = g.id AND e.at >= coalesce(v_epoch, '-infinity'::timestamptz)
       AND e.kind = 'cluster_frozen'
     ORDER BY e.at DESC LIMIT 1;
    v_frozen := jsonb_build_object(
      'at', v_fz_at,
      'reason', coalesce(v_fz_p ->> 'reason', CASE WHEN v_fz_at IS NULL THEN 'unrecorded' END),
      'invariant', coalesce(v_fz_p ->> 'invariant', v_fz_p ->> 'constraint', v_fz_p ->> 'sqlstate'));
  END IF;

  v_stuck_ms := coalesce((v_cfg ->> 'alert_stuck_conversion_ms')::integer, 1200000);
  IF v_conv.id IS NOT NULL AND v_conv.opened_at < v_now - make_interval(secs => v_stuck_ms / 1000.0) THEN
    v_stuck := jsonb_build_object(
      'conversion_id', v_conv.id, 'from_mode', v_conv.from_mode, 'to_mode', v_conv.to_mode,
      'opened_at', v_conv.opened_at,
      'age_ms', floor(extract(epoch FROM (v_now - v_conv.opened_at)) * 1000)::bigint,
      'threshold_ms', v_stuck_ms);
  END IF;

  SELECT count(*)::integer INTO v_alerts FROM public.financial_alerts fa
   WHERE NOT fa.resolved
     AND fa.source IN ('lightning_formation', 'lightning_settlement', 'lightning_alerts')
     AND fa.context ->> 'cluster_id' = g.id::text;

  SELECT count(*)::integer INTO v_open FROM public.lightning_integrity_signal s
   WHERE s.cluster_id = g.id AND s.status = 'open';

  IF EXISTS (SELECT 1 FROM public.lightning_matcher_shadow_comparison c
              WHERE c.cluster_id = g.id AND c.window_from > v_now - interval '8 days'
                AND c.window_to > v_now - interval '7 days') THEN
    v_sr := public.fn_lightning_shadow_report(g.id, v_now - interval '7 days', v_now);
    IF jsonb_array_length(coalesce(v_sr -> 'version_pairs', '[]'::jsonb)) > 0 THEN
      v_shadow := jsonb_build_object(
        'verdict', v_sr -> 'version_pairs' -> 0 ->> 'verdict',
        'comparisons', (v_sr -> 'version_pairs' -> 0 ->> 'comparisons')::integer,
        'delta_mean', (v_sr -> 'version_pairs' -> 0 ->> 'quality_delta_mean')::numeric,
        'live_matcher_version', v_sr -> 'version_pairs' -> 0 ->> 'live_matcher_version',
        'shadow_matcher_version', v_sr -> 'version_pairs' -> 0 ->> 'shadow_matcher_version');
    END IF;
  END IF;

  SELECT jsonb_build_object('window_from', w.window_from, 'window_to', w.window_to, 'legs', w.legs)
    INTO v_lat
    FROM public.lightning_latency_window w
   WHERE w.cluster_id = g.id
   ORDER BY w.window_from DESC LIMIT 1;

  v_since := CASE WHEN g.cluster_mode IN ('pending_on', 'pending_off') AND v_conv.id IS NOT NULL THEN v_conv.opened_at
                  WHEN g.cluster_mode = 'frozen' AND v_fz_at IS NOT NULL THEN v_fz_at
                  ELSE v_epoch END;

  RETURN jsonb_build_object(
    'cluster_id', g.id,
    'name', g.name,
    'variant', g.variant,
    'sb', g.sb,
    'bb', g.bb,
    'handedness', g.handedness,
    'lightning_enabled', coalesce(g.lightning_enabled, false),
    'cluster_mode', g.cluster_mode,
    'cluster_epoch', g.cluster_epoch,
    'mode_since', v_since,
    'on_threshold', (v_cfg ->> 'on_threshold')::integer,
    'off_threshold', (v_cfg ->> 'off_threshold')::integer,
    'live_eligible', public.fn_cash_cluster_live_eligible(g.id, v_now),
    'worker_mode', v_cfg ->> 'worker_mode',
    'flags', jsonb_build_object(
      'shadow_matcher', coalesce((v_cfg ->> 'lightning_shadow_matcher')::boolean, false),
      'integrity_telemetry', coalesce((v_cfg ->> 'integrity_telemetry')::boolean, false),
      'auto_rebuy', coalesce((v_cfg ->> 'auto_rebuy_enabled')::boolean, false),
      'latency_telemetry', coalesce((v_cfg ->> 'latency_telemetry')::boolean, false)),
    'pool', v_pool,
    'reservations', v_res,
    'instances', v_inst,
    'orphan_reservations', coalesce(v_orphan, 0),
    'blind_obligations_open', coalesce(v_owing, 0),
    'stuck_conversion', v_stuck,
    'frozen', v_frozen,
    'open_alerts', coalesce(v_alerts, 0),
    'integrity_open_signals', coalesce(v_open, 0),
    'shadow', v_shadow,
    'latency', v_lat);
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_operator_cluster_row(uuid, timestamptz) IS
  'Lightning Phase 12 (20261009144343): one Cluster''s operator dashboard row - identity, mode, epoch and mode_since, thresholds, live eligible population, worker mode and flags, pool/reservation/instance counts, orphan reservations, open blind obligations, a stuck conversion, the freeze, open alerts, open integrity signals, the shadow verdict and the latest latency window. Counts only, never a player. The body of fn_lightning_operator_overview and fn_lightning_operator_cluster; service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_operator_cluster_row(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_operator_cluster_row(uuid, timestamptz) TO service_role;

-- ===========================================================================
-- 10. THE OVERVIEW: every Cluster of one club, one row each, counts only.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_operator_overview(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_now  timestamptz := now();
  v_n    integer;
  v_rows jsonb;
BEGIN
  IF NOT public.fn_lightning_operator_may(p_club_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED', 'reason', 'NOT_AUTHORIZED');
  END IF;
  IF p_club_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGUMENT', 'reason', 'INVALID_ARGUMENT');
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.cash_games cg
   WHERE cg.club_id = p_club_id
     AND (cg.closed_at IS NULL OR cg.lightning_enabled IS TRUE OR cg.cluster_mode NOT IN ('must_move', 'dead'));
  SELECT coalesce(jsonb_agg(public.fn_lightning_operator_cluster_row(x.id, v_now) ORDER BY x.name, x.id), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT cg.id, cg.name FROM public.cash_games cg
           WHERE cg.club_id = p_club_id
             AND (cg.closed_at IS NULL OR cg.lightning_enabled IS TRUE OR cg.cluster_mode NOT IN ('must_move', 'dead'))
           ORDER BY cg.name, cg.id LIMIT 200) x;
  RETURN public.fn_lightning_operator_redact(jsonb_build_object(
    'ok', true, 'club_id', p_club_id, 'as_of', v_now, 'truncated', v_n > 200, 'clusters', v_rows));
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_operator_overview(uuid) IS
  'Lightning Phase 12 (20261009144343): the operator dashboard of one club - {ok, club_id, as_of, truncated, clusters:[fn_lightning_operator_cluster_row]} for at most 200 Clusters, counts only. Gate: service_role, a platform admin, or fn_ca_can_review_integrity(club); otherwise NOT_AUTHORIZED. Never anon, never a card.';

REVOKE ALL ON FUNCTION public.fn_lightning_operator_overview(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_lightning_operator_overview(uuid) TO authenticated, service_role;

-- ===========================================================================
-- 11. ONE CLUSTER IN DETAIL: matcher, reservations, blind ledger,
--     conversion state, pool health, reconcile stack, shadow, integrity,
--     alerts, latency and quality (see the header for the shape).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_operator_cluster(
  p_cluster_id uuid, p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_now     timestamptz := now();
  g         record;
  v_to      timestamptz;
  v_from    timestamptz;
  v_clamped boolean := false;
  v_row     jsonb;
  v_trans   jsonb;
  v_res     jsonb;
  v_ledger  jsonb;
  v_recon   jsonb;
  v_sig     jsonb;
  v_alerts  jsonb;
  v_lat     jsonb;
  v_quality jsonb;
  v_passes  jsonb;
BEGIN
  SELECT cg.id, cg.club_id, cg.cluster_mode, cg.cluster_epoch INTO g
    FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  IF NOT public.fn_lightning_operator_may(g.club_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED', 'reason', 'NOT_AUTHORIZED');
  END IF;
  IF g.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'NOT_FOUND');
  END IF;
  v_to := coalesce(p_to, clock_timestamp());
  v_from := coalesce(p_from, v_to - interval '24 hours');
  IF NOT isfinite(v_from) OR NOT isfinite(v_to) OR v_from >= v_to THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_WINDOW', 'reason', 'INVALID_WINDOW');
  END IF;
  IF v_to - v_from > interval '90 days' THEN
    v_from := v_to - interval '90 days';
    v_clamped := true;
  END IF;

  v_row := public.fn_lightning_operator_cluster_row(g.id, v_now);

  -- MODE TRANSITIONS: the epochs (each one a regime the Cluster ran under,
  -- its mode kept current by trg_cash_games_epoch_follows_its_game), the
  -- conversions (pending_on / pending_off and their outcome) and, for a
  -- frozen Cluster, its freeze.
  WITH t AS (
    SELECT e.started_at AS at,
           jsonb_build_object('kind', 'epoch', 'at', e.started_at, 'epoch', e.epoch, 'mode', e.mode,
                              'started_by', e.started_by, 'ended_at', e.ended_at) AS j
      FROM (SELECT * FROM public.cash_cluster_epoch ce
             WHERE ce.cluster_id = g.id AND ce.started_at < v_to
               AND coalesce(ce.ended_at, 'infinity'::timestamptz) >= v_from
             ORDER BY ce.epoch DESC LIMIT 50) e
    UNION ALL
    SELECT c.opened_at,
           jsonb_build_object('kind', 'conversion', 'at', c.opened_at, 'conversion_id', c.id,
                              'from_mode', c.from_mode, 'to_mode', c.to_mode, 'status', c.status,
                              'abort_reason', c.abort_reason, 'trigger_population', c.trigger_population,
                              'on_threshold', c.on_threshold, 'off_threshold', c.off_threshold,
                              'epoch_before', c.epoch_before, 'epoch_after', c.epoch_after,
                              'opened_at', c.opened_at, 'closed_at', c.closed_at,
                              'chips_at_begin', c.chips_at_begin, 'chips_at_commit', c.chips_at_commit)
      FROM (SELECT * FROM public.cash_cluster_conversion cc
             WHERE cc.cluster_id = g.id AND cc.opened_at < v_to
               AND coalesce(cc.closed_at, 'infinity'::timestamptz) >= v_from
             ORDER BY cc.opened_at DESC LIMIT 50) c
    UNION ALL
    SELECT (v_row -> 'frozen' ->> 'at')::timestamptz,
           jsonb_build_object('kind', 'freeze', 'at', v_row -> 'frozen' -> 'at',
                              'reason', v_row -> 'frozen' -> 'reason',
                              'invariant', v_row -> 'frozen' -> 'invariant',
                              'cluster_epoch', g.cluster_epoch)
     WHERE jsonb_typeof(v_row -> 'frozen') = 'object' AND v_row -> 'frozen' ->> 'at' IS NOT NULL
  )
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.at DESC), '[]'::jsonb) INTO v_trans
    FROM (SELECT * FROM t ORDER BY t.at DESC LIMIT 50) x;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'reservation_id', r.id, 'player_id', r.player_id, 'state', r.state,
           'seat_number', r.seat_number, 'instance_id', r.lightning_instance_id,
           'instance_state', i.state, 'created_at', r.created_at, 'expires_at', r.expires_at,
           'orphan', (r.state = 'pending' AND r.expires_at < v_now) OR i.id IS NULL
                     OR i.state NOT IN ('forming', 'reserved', 'dealing', 'settling')
                     OR sl.id IS NULL OR sl.closed_at IS NOT NULL)
           ORDER BY r.created_at, r.id), '[]'::jsonb)
    INTO v_res
    FROM (SELECT * FROM public.lightning_reservation rr
           WHERE rr.cluster_id = g.id AND rr.state IN ('pending', 'committed')
           ORDER BY rr.created_at, rr.id LIMIT 200) r
    LEFT JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
    LEFT JOIN public.lightning_pool_slot sl ON sl.id = r.pool_slot_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'player_id', bl.player_id, 'missed_bb_debt', bl.missed_bb_debt, 'missed_sb_debt', bl.missed_sb_debt,
           'bb_owed', bl.bb_owed, 'sb_owed', bl.sb_owed, 'debt_since', bl.debt_since,
           'bb_count', bl.bb_count, 'sb_count', bl.sb_count)
           ORDER BY bl.debt_since NULLS LAST, bl.player_id), '[]'::jsonb)
    INTO v_ledger
    FROM (SELECT * FROM public.lightning_blind_ledger b
           WHERE b.cluster_id = g.id AND (b.missed_bb_debt > 0 OR b.missed_sb_debt > 0)
           ORDER BY b.debt_since NULLS LAST, b.player_id LIMIT 200) bl;

  -- RECONCILE STACK: the pool stack is the anchor seat's stack minus the
  -- chips a fold committed to a hand still live, and nothing else.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'pool_session_id', q.id, 'player_id', q.player_id, 'state', q.state,
           'anchor_seat_id', q.anchor_seat_id, 'anchor_stack', q.anchor_stack,
           'exposure', q.exposure, 'pool_stack', q.pool_stack,
           'ok', q.seat_ok AND q.anchor_stack >= q.exposure
                 AND q.pool_stack = round(q.anchor_stack, 2) - q.exposure)
           ORDER BY q.entered_at, q.id), '[]'::jsonb)
    INTO v_recon
    FROM (SELECT s.id, s.player_id, s.state, s.anchor_seat_id, s.entered_at,
                 ts.id IS NOT NULL AND ts.left_at IS NULL AND ts.user_id IS NOT DISTINCT FROM s.player_id AS seat_ok,
                 round(coalesce(ts.stack, 0), 2) AS anchor_stack,
                 public.fn_lightning_pool_exposure(s.player_id, s.cluster_id) AS exposure,
                 public.fn_lightning_pool_stack(s.id) AS pool_stack
            FROM (SELECT * FROM public.lightning_pool_session ps
                   WHERE ps.cluster_id = g.id AND ps.exited_at IS NULL
                   ORDER BY ps.entered_at, ps.id LIMIT 500) s
            LEFT JOIN public.table_seats ts ON ts.id = s.anchor_seat_id) q;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'pattern_type', s.pattern_type, 'source', s.source,
           'player_a', s.player_a, 'player_b', s.player_b,
           'window_start', s.window_start, 'window_end', s.window_end,
           'suspicion_score', s.suspicion_score, 'severity', s.severity, 'status', s.status,
           'detected_at', s.detected_at, 'reviewed_by', s.reviewed_by, 'reviewed_at', s.reviewed_at,
           'notes', s.notes, 'evidence', s.evidence)
           ORDER BY s.detected_at DESC, s.id DESC), '[]'::jsonb)
    INTO v_sig
    FROM (SELECT * FROM public.lightning_integrity_signal x
           WHERE x.cluster_id = g.id AND x.detected_at >= v_from AND x.detected_at <= v_to
           ORDER BY x.detected_at DESC, x.id DESC LIMIT 100) s;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', fa.id, 'severity', fa.severity, 'source', fa.source, 'check', fa.context ->> 'check',
           'message', fa.message, 'created_at', fa.created_at, 'dedupe_key', fa.context ->> 'dedupe_key')
           ORDER BY fa.created_at DESC, fa.id), '[]'::jsonb)
    INTO v_alerts
    FROM (SELECT * FROM public.financial_alerts a
           WHERE NOT a.resolved
             AND a.source IN ('lightning_formation', 'lightning_settlement', 'lightning_alerts')
             AND a.context ->> 'cluster_id' = g.id::text
           ORDER BY a.created_at DESC LIMIT 50) fa;

  SELECT coalesce(jsonb_agg(jsonb_build_object('window_from', w.window_from, 'window_to', w.window_to,
                                               'legs', w.legs) ORDER BY w.window_from DESC), '[]'::jsonb)
    INTO v_lat
    FROM (SELECT * FROM public.lightning_latency_window lw
           WHERE lw.cluster_id = g.id AND lw.window_from < v_to AND lw.window_to > v_from
           ORDER BY lw.window_from DESC LIMIT 60) w;

  SELECT jsonb_build_object('window_from', c.window_from, 'window_to', c.window_to,
                            'live_matcher_version', c.live_matcher_version,
                            'shadow_matcher_version', c.shadow_matcher_version,
                            'live_quality_score', c.live_quality_score,
                            'shadow_quality_score', c.shadow_quality_score,
                            'live_components', c.live_components, 'shadow_components', c.shadow_components,
                            'quality_weights', c.quality_weights)
    INTO v_quality
    FROM public.lightning_matcher_shadow_comparison c
   WHERE c.cluster_id = g.id
   ORDER BY c.window_from DESC, c.window_to DESC LIMIT 1;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'request_id', mp.request_id, 'cluster_epoch', mp.cluster_epoch,
           'matcher_version', mp.matcher_version, 'started_at', mp.started_at,
           'finished_at', mp.finished_at, 'hands_formed', mp.hands_formed, 'result', mp.result)
           ORDER BY mp.started_at DESC, mp.request_id), '[]'::jsonb)
    INTO v_passes
    FROM (SELECT * FROM public.cash_cluster_matcher_pass p
           WHERE p.cluster_id = g.id
           ORDER BY p.started_at DESC LIMIT 20) mp;

  RETURN public.fn_lightning_operator_redact(jsonb_build_object(
    'ok', true,
    'cluster_id', g.id,
    'from', v_from,
    'to', v_to,
    'window_clamped', v_clamped,
    'cluster', v_row,
    'transitions', v_trans,
    'reservations', v_res,
    'blind_ledger', v_ledger,
    'reconcile', v_recon,
    'shadow_report', public.fn_lightning_shadow_report(g.id, v_from, v_to),
    'integrity_signals', v_sig,
    'alerts', v_alerts,
    'latency_windows', v_lat,
    'quality', v_quality,
    'matcher_passes', v_passes));
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_operator_cluster(uuid, timestamptz, timestamptz) IS
  'Lightning Phase 12 (20261009144343): one Lightning Cluster for an operator - its dashboard row, the latest 50 mode transitions (epochs, conversions, the freeze), open reservations, open blind obligations, the reconcile stack of every open pool session (anchor stack, exposure, pool stack, ok), fn_lightning_shadow_report, the latest 100 integrity signals, open alerts, the latest 60 latency windows, the latest quality score and the latest 20 matcher passes, over a window defaulting to the last 24 hours (at most 90 days). Gate as fn_lightning_operator_overview, through the Cluster''s club. Never anon, never a card.';

REVOKE ALL ON FUNCTION public.fn_lightning_operator_cluster(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_lightning_operator_cluster(uuid, timestamptz, timestamptz) TO authenticated, service_role;

-- ===========================================================================
-- 12. REPLAY HAND: the Phase 9 replay check of one hand of the Cluster, its
--     public record, its participants' arithmetic and its ledger events.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_operator_hand_replay(p_cluster_id uuid, p_hand_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  g         record;
  h         record;
  v_istate  text;
  v_iend    timestamptz;
  v_players jsonb;
  v_events  jsonb;
BEGIN
  SELECT cg.id, cg.club_id INTO g FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  IF NOT public.fn_lightning_operator_may(g.club_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED', 'reason', 'NOT_AUTHORIZED');
  END IF;
  SELECT lh.* INTO h FROM public.lightning_hand lh
   WHERE lh.hand_id = p_hand_id AND lh.cluster_id = g.id;
  IF g.id IS NULL OR h.hand_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'NOT_FOUND');
  END IF;
  SELECT i.state, i.completed_at INTO v_istate, v_iend
    FROM public.lightning_instance i WHERE i.id = h.lightning_instance_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'player_id', hp.player_id, 'seat', hp.seat, 'position', hp.position, 'blind_role', hp.blind_role,
           'stack_before', hp.stack_before, 'stack_after', hp.stack_after, 'net_result', hp.net_result,
           'fold_type', hp.fold_type, 'folded_at', hp.folded_at, 'committed_at_fold', hp.committed_at_fold,
           'waited_ms', hp.waited_ms, 'showed', hp.showed) ORDER BY hp.seat), '[]'::jsonb)
    INTO v_players
    FROM public.lightning_hand_player hp WHERE hp.hand_id = h.hand_id;

  -- The hand's events, read on the ledger's (game_id, at) index inside the
  -- hand's own lifetime only.
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'at', e.at,
                                               'cluster_epoch', e.cluster_epoch, 'payload', e.payload)
                            ORDER BY e.at, e.id), '[]'::jsonb)
    INTO v_events
    FROM (SELECT * FROM public.cash_cluster_events ev
           WHERE ev.game_id = g.id
             AND ev.at >= h.formed_at - interval '5 seconds'
             AND ev.at <= coalesce(h.settled_at, v_iend, clock_timestamp()) + interval '5 seconds'
             AND (ev.payload ->> 'hand_id' = h.hand_id::text
                  OR ev.payload ->> 'instance_id' = h.lightning_instance_id::text)
           ORDER BY ev.at, ev.id LIMIT 200) e;

  RETURN public.fn_lightning_operator_redact(jsonb_build_object(
    'ok', true,
    'cluster_id', g.id,
    'hand_id', h.hand_id,
    'replay', public.fn_lightning_hand_replay_check(h.hand_id),
    'hand', jsonb_build_object(
      'hand_id', h.hand_id, 'hand_number', h.hand_number, 'cluster_epoch', h.cluster_epoch,
      'lightning_instance_id', h.lightning_instance_id, 'instance_state', v_istate,
      'formed_at', h.formed_at, 'settled_at', h.settled_at, 'player_count', h.player_count,
      'hand_history_id', h.hand_history_id, 'rules_version', h.rules_version,
      'matcher_version', h.matcher_version, 'blind_algorithm_version', h.blind_algorithm_version,
      'lightning_version', h.lightning_version, 'rake_version', h.rake_version,
      'rake', h.settle_receipt -> 'rake', 'bbj', h.settle_receipt -> 'bbj'),
    'players', v_players,
    'events', v_events));
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_operator_hand_replay(uuid, uuid) IS
  'Lightning Phase 12 (20261009144343): REPLAY HAND for an operator - fn_lightning_hand_replay_check (participants, stack arithmetic, conservation, receipt, versions, event order) of a hand of this Cluster, the hand''s public record, its participants'' stacks and folds, and its ledger events, redacted by fn_lightning_operator_redact. A hand of another Cluster is NOT_FOUND. Gate as fn_lightning_operator_overview. Never anon, never a card.';

REVOKE ALL ON FUNCTION public.fn_lightning_operator_hand_replay(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_lightning_operator_hand_replay(uuid, uuid) TO authenticated, service_role;

-- ===========================================================================
-- 13. REPLAY PLAYER SESSION AND REPLAY MODE TRANSITION: one pool session's
--     ordered trail (its ledger events, slots, reservations and hands) and
--     the Cluster's epochs and conversions that overlap it.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_operator_session_trail(p_cluster_id uuid, p_pool_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  g       record;
  s       record;
  v_start timestamptz;
  v_end   timestamptz;
  v_trail jsonb;
  v_trans jsonb;
BEGIN
  SELECT cg.id, cg.club_id INTO g FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  IF NOT public.fn_lightning_operator_may(g.club_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED', 'reason', 'NOT_AUTHORIZED');
  END IF;
  SELECT ps.* INTO s FROM public.lightning_pool_session ps
   WHERE ps.id = p_pool_session_id AND ps.cluster_id = g.id;
  IF g.id IS NULL OR s.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'NOT_FOUND');
  END IF;
  v_start := s.entered_at - interval '1 second';
  v_end := coalesce(s.exited_at, clock_timestamp()) + interval '1 second';

  WITH ev AS (
    SELECT e.at, e.id::text AS ord,
           jsonb_build_object('at', e.at, 'source', 'event', 'kind', e.kind, 'event_id', e.id,
                              'cluster_epoch', e.cluster_epoch, 'payload', e.payload) AS j
      FROM public.cash_cluster_events e
     WHERE e.game_id = g.id AND e.at >= v_start AND e.at <= v_end
       AND (e.payload ->> 'pool_session_id' = s.id::text
            OR strpos(e.payload::text, s.player_id::text) > 0)
     ORDER BY e.at, e.id LIMIT 500
  ), sl AS (
    SELECT x.opened_at AS at, x.id::text AS ord,
           jsonb_build_object('at', x.opened_at, 'source', 'slot', 'kind', 'slot_opened', 'slot_id', x.id,
                              'slot', x.slot, 'cluster_epoch', x.cluster_epoch) AS j
      FROM public.lightning_pool_slot x WHERE x.pool_session_id = s.id
    UNION ALL
    SELECT x.closed_at, x.id::text,
           jsonb_build_object('at', x.closed_at, 'source', 'slot', 'kind', 'slot_closed', 'slot_id', x.id,
                              'close_reason', x.close_reason, 'hands', x.hands, 'fast_folds', x.fast_folds,
                              'normal_folds', x.normal_folds, 'fold_and_watch', x.fold_and_watch)
      FROM public.lightning_pool_slot x WHERE x.pool_session_id = s.id AND x.closed_at IS NOT NULL
  ), rv AS (
    SELECT r.created_at AS at, r.id::text AS ord,
           jsonb_build_object('at', r.created_at, 'source', 'reservation', 'kind', 'reservation_' || r.state,
                              'reservation_id', r.id, 'instance_id', r.lightning_instance_id,
                              'seat_number', r.seat_number, 'reason', r.reason,
                              'expires_at', r.expires_at, 'resolved_at', r.resolved_at) AS j
      FROM public.lightning_reservation r
     WHERE r.pool_slot_id IN (SELECT x.id FROM public.lightning_pool_slot x WHERE x.pool_session_id = s.id)
     ORDER BY r.created_at, r.id LIMIT 500
  ), hd AS (
    SELECT lh.formed_at AS at, lh.hand_id::text AS ord,
           jsonb_build_object('at', lh.formed_at, 'source', 'hand', 'kind', 'hand', 'hand_id', lh.hand_id,
                              'hand_number', lh.hand_number, 'settled_at', lh.settled_at,
                              'seat', hp.seat, 'position', hp.position, 'blind_role', hp.blind_role,
                              'stack_before', hp.stack_before, 'stack_after', hp.stack_after,
                              'net_result', hp.net_result, 'fold_type', hp.fold_type,
                              'waited_ms', hp.waited_ms, 'showed', hp.showed) AS j
      FROM public.lightning_hand_player hp
      JOIN public.lightning_hand lh ON lh.hand_id = hp.hand_id
     WHERE hp.pool_slot_id IN (SELECT x.id FROM public.lightning_pool_slot x WHERE x.pool_session_id = s.id)
     ORDER BY lh.formed_at, lh.hand_id LIMIT 500
  ), allx AS (
    SELECT * FROM ev UNION ALL SELECT * FROM sl UNION ALL SELECT * FROM rv UNION ALL SELECT * FROM hd
  )
  SELECT coalesce(jsonb_agg(a.j ORDER BY a.at, a.ord), '[]'::jsonb) INTO v_trail
    FROM (SELECT * FROM allx ORDER BY allx.at, allx.ord LIMIT 500) a;

  WITH t AS (
    SELECT e.started_at AS at,
           jsonb_build_object('kind', 'epoch', 'at', e.started_at, 'epoch', e.epoch, 'mode', e.mode,
                              'started_by', e.started_by, 'ended_at', e.ended_at) AS j
      FROM public.cash_cluster_epoch e
     WHERE e.cluster_id = g.id AND e.started_at <= v_end AND coalesce(e.ended_at, 'infinity'::timestamptz) >= v_start
    UNION ALL
    SELECT c.opened_at,
           jsonb_build_object('kind', 'conversion', 'at', c.opened_at, 'conversion_id', c.id,
                              'from_mode', c.from_mode, 'to_mode', c.to_mode, 'status', c.status,
                              'abort_reason', c.abort_reason, 'epoch_before', c.epoch_before,
                              'epoch_after', c.epoch_after, 'opened_at', c.opened_at, 'closed_at', c.closed_at)
      FROM public.cash_cluster_conversion c
     WHERE c.cluster_id = g.id AND c.opened_at <= v_end AND coalesce(c.closed_at, 'infinity'::timestamptz) >= v_start
  )
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.at), '[]'::jsonb) INTO v_trans
    FROM (SELECT * FROM t ORDER BY t.at LIMIT 100) x;

  RETURN public.fn_lightning_operator_redact(jsonb_build_object(
    'ok', true,
    'cluster_id', g.id,
    'pool_session', jsonb_build_object(
      'pool_session_id', s.id, 'player_id', s.player_id, 'state', s.state, 'cluster_epoch', s.cluster_epoch,
      'entered_at', s.entered_at, 'exited_at', s.exited_at, 'exit_reason', s.exit_reason,
      'starting_stack', s.starting_stack, 'ending_stack', s.ending_stack, 'net_result', s.net_result,
      'hands', s.hands, 'fast_folds', s.fast_folds, 'normal_folds', s.normal_folds,
      'fold_and_watch', s.fold_and_watch, 'showdowns', s.showdowns, 'anchor_seat_id', s.anchor_seat_id,
      'disconnected_at', s.disconnected_at, 'stop_requested_at', s.stop_requested_at,
      'auto_rebuys', s.auto_rebuys, 'auto_rebuy_total', s.auto_rebuy_total,
      'pool_stack', CASE WHEN s.exited_at IS NULL THEN public.fn_lightning_pool_stack(s.id) END),
    'trail', v_trail,
    'transitions', v_trans));
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_operator_session_trail(uuid, uuid) IS
  'Lightning Phase 12 (20261009144343): REPLAY PLAYER SESSION and REPLAY MODE TRANSITION for an operator - one pool session of this Cluster, its ordered trail (ledger events naming it or its player inside its lifetime, slots, reservations, hands with stacks and folds; at most 500) and the epochs and conversions overlapping it. Gate as fn_lightning_operator_overview. Never anon, never a card.';

REVOKE ALL ON FUNCTION public.fn_lightning_operator_session_trail(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_lightning_operator_session_trail(uuid, uuid) TO authenticated, service_role;

-- ===========================================================================
-- 14. FORENSICS: the Phase 9 reader, gated and redacted.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_operator_forensics(
  p_cluster_id uuid, p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL, p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  g      record;
  v_to   timestamptz;
  v_from timestamptz;
BEGIN
  SELECT cg.id, cg.club_id INTO g FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  IF NOT public.fn_lightning_operator_may(g.club_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED', 'reason', 'NOT_AUTHORIZED');
  END IF;
  IF g.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'NOT_FOUND');
  END IF;
  v_to := coalesce(p_to, clock_timestamp());
  v_from := coalesce(p_from, v_to - interval '1 hour');
  IF v_from >= v_to THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_WINDOW', 'reason', 'INVALID_WINDOW');
  END IF;
  RETURN public.fn_lightning_operator_redact(public.fn_lightning_cluster_forensics(g.id, v_from, v_to, p_limit));
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_operator_forensics(uuid, timestamptz, timestamptz, integer) IS
  'Lightning Phase 12 (20261009144343): fn_lightning_cluster_forensics (events, conversions, matcher passes, instances and hands in time order) for an operator, over a window defaulting to the last hour, redacted by fn_lightning_operator_redact. Gate as fn_lightning_operator_overview. Never anon, never a card.';

REVOKE ALL ON FUNCTION public.fn_lightning_operator_forensics(uuid, timestamptz, timestamptz, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_lightning_operator_forensics(uuid, timestamptz, timestamptz, integer) TO authenticated, service_role;

-- ===========================================================================
-- 15. THE ONE WRITING OPERATOR DOOR: an integrity signal's review.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_operator_signal_review(
  p_signal_id bigint, p_status text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_cluster uuid;
  v_club    uuid;
  s         record;
  v_note    text;
  v_at      timestamptz := clock_timestamp();
BEGIN
  SELECT x.cluster_id INTO v_cluster FROM public.lightning_integrity_signal x WHERE x.id = p_signal_id;
  SELECT cg.club_id INTO v_club FROM public.cash_games cg WHERE cg.id = v_cluster;
  IF NOT public.fn_lightning_operator_may(v_club) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED', 'reason', 'NOT_AUTHORIZED');
  END IF;
  IF v_cluster IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'NOT_FOUND');
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('reviewed', 'cleared', 'actioned') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATUS', 'reason', 'INVALID_STATUS',
                              'allowed', jsonb_build_array('reviewed', 'cleared', 'actioned'));
  END IF;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'REVIEWER_REQUIRED', 'reason', 'REVIEWER_REQUIRED');
  END IF;
  v_note := nullif(btrim(left(coalesce(p_note, ''), 2000)), '');

  SELECT x.id, x.cluster_id, x.pattern_type, x.status, x.notes, x.reviewed_by, x.reviewed_at INTO s
    FROM public.lightning_integrity_signal x WHERE x.id = p_signal_id FOR UPDATE;
  IF s.status = p_status AND s.notes IS NOT DISTINCT FROM coalesce(v_note, s.notes) THEN
    RETURN public.fn_lightning_operator_redact(jsonb_build_object(
      'ok', true, 'idempotent', true, 'signal_id', s.id, 'cluster_id', s.cluster_id,
      'status', s.status, 'previous_status', s.status, 'reviewed_by', s.reviewed_by,
      'reviewed_at', s.reviewed_at, 'notes', s.notes));
  END IF;

  UPDATE public.lightning_integrity_signal x
     SET status = p_status, reviewed_by = v_uid, reviewed_at = v_at,
         notes = coalesce(v_note, x.notes), updated_at = v_at
   WHERE x.id = s.id;

  -- THE AUDIT: one immutable ledger event per review.
  INSERT INTO public.cash_cluster_events (game_id, kind, payload)
  VALUES (s.cluster_id, 'integrity_signal_reviewed', jsonb_build_object(
    'signal_id', s.id, 'pattern_type', s.pattern_type, 'from_status', s.status, 'to_status', p_status,
    'reviewer', v_uid, 'note', v_note, 'at', v_at));

  RETURN public.fn_lightning_operator_redact(jsonb_build_object(
    'ok', true, 'idempotent', false, 'signal_id', s.id, 'cluster_id', s.cluster_id,
    'status', p_status, 'previous_status', s.status, 'reviewed_by', v_uid,
    'reviewed_at', v_at, 'notes', coalesce(v_note, s.notes)));
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_operator_signal_review(bigint, text, text) IS
  'Lightning Phase 12 (20261009144343): the one writing operator door - sets a lightning_integrity_signal''s status to reviewed, cleared or actioned with reviewed_by = auth.uid(), reviewed_at and the note, and records one integrity_signal_reviewed event. The same status and note again is idempotent. A rescan never overwrites it. Gate as fn_lightning_operator_overview, through the signal''s Cluster; a signed-in reviewer is required. Never anon.';

REVOKE ALL ON FUNCTION public.fn_lightning_operator_signal_review(bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_lightning_operator_signal_review(bigint, text, text) TO authenticated, service_role;

-- ===========================================================================
-- 16. THE ENGINE'S LATENCY DOOR (see the header for the contract).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_latency_report(
  p_cluster_id uuid, p_window_from timestamptz, p_window_to timestamptz, p_legs jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  c_legs  constant text[] := ARRAY['fold_ack', 'ack_to_idle', 'idle_to_match', 'match_to_hand',
                                   'hand_to_first_render', 'fast_fold_to_next_hand',
                                   'normal_fold_to_next_hand', 'fold_watch_to_next_hand'];
  v_now   timestamptz := clock_timestamp();
  v_cfg   jsonb;
  v_bad   jsonb := '[]'::jsonb;
  v_unk   jsonb;
  v_leg   record;
  v_m     record;
  v_p     numeric[];
  v_id    bigint;
  v_row   public.lightning_latency_window;
BEGIN
  IF p_cluster_id IS NULL OR p_window_from IS NULL OR p_window_to IS NULL OR p_legs IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGUMENT', 'reason', 'INVALID_ARGUMENT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cash_games cg WHERE cg.id = p_cluster_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CLUSTER_NOT_FOUND', 'reason', 'CLUSTER_NOT_FOUND');
  END IF;
  v_cfg := public.fn_lightning_config(p_cluster_id);
  IF (v_cfg ->> 'latency_telemetry')::boolean IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TELEMETRY_OFF', 'reason', 'TELEMETRY_OFF');
  END IF;
  IF NOT isfinite(p_window_from) OR NOT isfinite(p_window_to) OR p_window_to <= p_window_from
     OR p_window_to - p_window_from > interval '1 hour'
     OR p_window_from < v_now - interval '7 days' OR p_window_to > v_now + interval '5 minutes' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_WINDOW', 'reason', 'INVALID_WINDOW');
  END IF;
  IF jsonb_typeof(p_legs) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_LEGS', 'reason', 'INVALID_LEGS');
  END IF;
  IF octet_length(p_legs::text) > 8192 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LEGS_TOO_LARGE', 'reason', 'LEGS_TOO_LARGE');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_path_query(p_legs, 'strict $.**') q(v)
              CROSS JOIN LATERAL (SELECT jsonb_object_keys(q.v) AS k WHERE jsonb_typeof(q.v) = 'object') kk
             WHERE kk.k ~* '(card|hole|deck|seed)') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CARRIES_CARDS', 'reason', 'CARRIES_CARDS');
  END IF;
  SELECT jsonb_agg(k ORDER BY k) INTO v_unk FROM jsonb_object_keys(p_legs) k WHERE NOT (k = ANY (c_legs));
  IF v_unk IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNKNOWN_LEG', 'reason', 'UNKNOWN_LEG', 'keys', v_unk);
  END IF;

  FOR v_leg IN SELECT e.key, e.value FROM jsonb_each(p_legs) e ORDER BY e.key LOOP
    IF jsonb_typeof(v_leg.value) IS DISTINCT FROM 'object' THEN
      v_bad := v_bad || jsonb_build_object('leg', v_leg.key, 'key', NULL, 'reason', 'not_an_object');
      CONTINUE;
    END IF;
    FOR v_m IN SELECT x.key, x.value FROM jsonb_each(v_leg.value) x LOOP
      IF v_m.key NOT IN ('n', 'p50', 'p95', 'p99') THEN
        v_bad := v_bad || jsonb_build_object('leg', v_leg.key, 'key', v_m.key, 'reason', 'unknown_member');
      ELSIF v_m.key = 'n' THEN
        IF jsonb_typeof(v_m.value) IS DISTINCT FROM 'number'
           OR (v_m.value #>> '{}')::numeric <> trunc((v_m.value #>> '{}')::numeric)
           OR (v_m.value #>> '{}')::numeric NOT BETWEEN 0 AND 1000000000 THEN
          v_bad := v_bad || jsonb_build_object('leg', v_leg.key, 'key', 'n', 'reason', 'not_a_count');
        END IF;
      ELSIF jsonb_typeof(v_m.value) <> 'null'
            AND (jsonb_typeof(v_m.value) <> 'number' OR (v_m.value #>> '{}')::numeric NOT BETWEEN 0 AND 86400000) THEN
        v_bad := v_bad || jsonb_build_object('leg', v_leg.key, 'key', v_m.key, 'reason', 'not_milliseconds');
      END IF;
    END LOOP;
    IF NOT (v_leg.value ? 'n') THEN
      v_bad := v_bad || jsonb_build_object('leg', v_leg.key, 'key', 'n', 'reason', 'missing');
    END IF;
    IF jsonb_array_length(v_bad) = 0 THEN
      SELECT array_agg((v_leg.value ->> k)::numeric ORDER BY o) INTO v_p
        FROM unnest(ARRAY['p50', 'p95', 'p99']) WITH ORDINALITY t(k, o)
       WHERE jsonb_typeof(v_leg.value -> k) = 'number';
      IF v_p IS NOT NULL AND EXISTS (SELECT 1 FROM generate_subscripts(v_p, 1) i
                                      WHERE i > 1 AND v_p[i] < v_p[i - 1]) THEN
        v_bad := v_bad || jsonb_build_object('leg', v_leg.key, 'key', NULL, 'reason', 'percentiles_out_of_order');
      END IF;
    END IF;
  END LOOP;
  IF jsonb_array_length(v_bad) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_LEG', 'reason', 'INVALID_LEG', 'errors', v_bad);
  END IF;

  INSERT INTO public.lightning_latency_window (cluster_id, window_from, window_to, legs)
  VALUES (p_cluster_id, p_window_from, p_window_to, p_legs)
  ON CONFLICT (cluster_id, window_from) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT * INTO v_row FROM public.lightning_latency_window w
     WHERE w.cluster_id = p_cluster_id AND w.window_from = p_window_from;
    IF v_row.window_to IS DISTINCT FROM p_window_to OR v_row.legs IS DISTINCT FROM p_legs THEN
      RETURN jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_CONFLICT', 'reason', 'IDEMPOTENCY_CONFLICT',
                                'id', v_row.id);
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'id', v_row.id, 'cluster_id', p_cluster_id,
                              'window_from', v_row.window_from, 'window_to', v_row.window_to,
                              'legs', (SELECT count(*) FROM jsonb_object_keys(v_row.legs)));
  END IF;
  RETURN jsonb_build_object('ok', true, 'idempotent', false, 'id', v_id, 'cluster_id', p_cluster_id,
                            'window_from', p_window_from, 'window_to', p_window_to,
                            'legs', (SELECT count(*) FROM jsonb_object_keys(p_legs)));
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_latency_report(uuid, timestamptz, timestamptz, jsonb) IS
  'Lightning Phase 12 (20261009144343): the engine reports one window of action-latency aggregates for a Cluster - p_legs {fold_ack, ack_to_idle, idle_to_match, match_to_hand, hand_to_first_render, fast_fold_to_next_hand, normal_fold_to_next_hand, fold_watch_to_next_hand: {n, p50, p95, p99}}, every leg optional, milliseconds. Unknown legs or members and any card/hole/deck/seed key are refused. Idempotent per (Cluster, window_from); a different body answers IDEMPOTENCY_CONFLICT. Refused with TELEMETRY_OFF when the Cluster''s latency_telemetry is false. Stored in lightning_latency_window. service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_latency_report(uuid, timestamptz, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_latency_report(uuid, timestamptz, timestamptz, jsonb) TO service_role;

-- ===========================================================================
-- 17. A LATENCY REGRESSION, measured: the latest alert_latency_windows
--     windows of the Cluster (ending no earlier than that many windows plus
--     two before now, and spanning at most that many plus one), every one
--     carrying at least alert_latency_min_samples samples of the leg with a
--     p95 above alert_latency_p95_ms.<leg>. NULL when the leg is not
--     regressing; otherwise those windows, oldest first.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_latency_regression(
  p_cluster_id uuid, p_leg text, p_cfg jsonb, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_k    integer := GREATEST(coalesce((p_cfg ->> 'alert_latency_windows')::integer, 3), 2);
  v_wms  integer := GREATEST(coalesce((p_cfg ->> 'latency_window_ms')::integer, 60000), 1000);
  v_min  integer := GREATEST(coalesce((p_cfg ->> 'alert_latency_min_samples')::integer, 20), 1);
  v_ceil numeric := (p_cfg -> 'alert_latency_p95_ms' ->> p_leg)::numeric;
  v_out  jsonb;
BEGIN
  IF v_ceil IS NULL THEN
    RETURN NULL;
  END IF;
  WITH w AS (
    SELECT lw.window_from, lw.window_to, lw.legs -> p_leg AS l
      FROM public.lightning_latency_window lw
     WHERE lw.cluster_id = p_cluster_id
       AND lw.window_to <= p_now + interval '5 minutes'
       AND lw.window_to > p_now - make_interval(secs => (v_k + 2) * v_wms / 1000.0)
     ORDER BY lw.window_from DESC
     LIMIT v_k
  )
  SELECT CASE
           WHEN count(*) = v_k
            AND bool_and(coalesce(jsonb_typeof(w.l -> 'p95') = 'number' AND jsonb_typeof(w.l -> 'n') = 'number'
                                  AND (w.l ->> 'n')::numeric >= v_min AND (w.l ->> 'p95')::numeric > v_ceil, false))
            AND max(w.window_to) - min(w.window_from) <= make_interval(secs => (v_k + 1) * v_wms / 1000.0)
           THEN jsonb_agg(jsonb_build_object('window_from', w.window_from, 'window_to', w.window_to,
                                             'n', w.l -> 'n', 'p95', w.l -> 'p95') ORDER BY w.window_from)
         END
    INTO v_out
    FROM w;
  RETURN v_out;
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_latency_regression(uuid, text, jsonb, timestamptz) IS
  'Lightning Phase 12 (20261009144343): whether one latency leg of a Cluster is regressing - the latest alert_latency_windows consecutive windows each with at least alert_latency_min_samples samples and a p95 above alert_latency_p95_ms.<leg> (all from the given fn_lightning_config answer). NULL when not; otherwise the windows. Read by fn_lightning_alert_sweep. service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_latency_regression(uuid, text, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_latency_regression(uuid, text, jsonb, timestamptz) TO service_role;

-- ===========================================================================
-- 18. THE SWEEP (see the header). It reads; it raises and resolves its own
--     pages; it calls the integrity scan; it prunes the latency ledger. It
--     never writes a Cluster's state.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_alert_sweep(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  c_legs     constant text[] := ARRAY['fold_ack', 'ack_to_idle', 'idle_to_match', 'match_to_hand',
                                      'hand_to_first_render', 'fast_fold_to_next_hand',
                                      'normal_fold_to_next_hand', 'fold_watch_to_next_hand'];
  c_checks   constant text[] := ARRAY['frozen', 'stuck_conversion', 'drive_error', 'reaper_failure',
                                      'integrity_spike', 'latency_regression'];
  c_modes    constant text[] := ARRAY['pending_on', 'lightning', 'pending_off', 'frozen', 'paused', 'draining'];
  v_now      timestamptz := LEAST(coalesce(p_now, now()), clock_timestamp());
  c          record;
  a          record;
  v_conv     record;
  v_cfg      jsonb;
  v_outcomes jsonb := '[]'::jsonb;
  v_errors   jsonb := '[]'::jsonb;
  v_scans    jsonb := '[]'::jsonb;
  v_checked  integer := 0;
  v_pruned   integer := 0;
  v_sqlstate text;
  v_msg      text;
  v_out      text;
  v_key      text;
  v_since    timestamptz;
  v_win      interval;
  v_n        integer;
  v_n2       integer;
  v_detail   jsonb;
  v_leg      text;
  v_ms       integer;
  v_scan     jsonb;
  v_resolve  boolean;
  v_fz_at    timestamptz;
  v_fz_p     jsonb;
  v_result   jsonb;
BEGIN
  -- ONE PASS AT A TIME: a pass that overruns its minute is not joined by the
  -- next one; the next one answers busy and the one after it runs.
  IF NOT pg_try_advisory_xact_lock(hashtext('lightning-alert-sweep')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'busy', 'as_of', v_now);
  END IF;

  -- A. THE INTEGRITY SCAN'S CALLER. A Cluster whose config turns
  --    integrity_telemetry on and that is not frozen is scanned at most once
  --    per clock hour (the scan's own default window: the 24 hours before
  --    the current hour), at most five a pass, oldest first. It runs before
  --    the checks so its findings count in this pass.
  FOR c IN
    SELECT cg.id
      FROM public.cash_games cg
      LEFT JOIN public.lightning_alert_sweep_state st ON st.key = 'integrity_scan:' || cg.id::text
     WHERE (cg.lightning_enabled IS TRUE OR cg.cluster_mode = ANY (c_modes))
       AND cg.cluster_mode IS DISTINCT FROM 'frozen'
       AND (st.last_at IS NULL OR st.last_at < date_trunc('hour', v_now))
     ORDER BY (st.last_at IS NOT NULL), st.last_at, cg.id
     LIMIT 500
  LOOP
    EXIT WHEN jsonb_array_length(v_scans) >= 5;
    BEGIN
      IF coalesce((public.fn_lightning_config(c.id) ->> 'integrity_telemetry')::boolean, false) THEN
        v_scan := public.fn_lightning_integrity_scan(c.id, NULL, NULL);
        INSERT INTO public.lightning_alert_sweep_state (key, last_at, detail)
        VALUES ('integrity_scan:' || c.id::text, v_now, jsonb_build_object(
                  'ok', v_scan -> 'ok', 'window_from', v_scan -> 'window_from', 'window_to', v_scan -> 'window_to',
                  'hands_scanned', v_scan -> 'hands_scanned', 'written', v_scan -> 'written'))
        ON CONFLICT (key) DO UPDATE SET last_at = EXCLUDED.last_at, detail = EXCLUDED.detail;
        v_scans := v_scans || jsonb_build_object('cluster_id', c.id, 'ok', v_scan -> 'ok', 'written', v_scan -> 'written');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_errors := v_errors || jsonb_build_object('check', 'integrity_scan', 'cluster_id', c.id,
                                                 'sqlstate', v_sqlstate, 'message', left(v_msg, 300));
      -- A failing scan still counts as this hour's attempt, so it is not
      -- retried every minute.
      INSERT INTO public.lightning_alert_sweep_state (key, last_at, detail)
      VALUES ('integrity_scan:' || c.id::text, v_now, jsonb_build_object('ok', false, 'sqlstate', v_sqlstate))
      ON CONFLICT (key) DO UPDATE SET last_at = EXCLUDED.last_at, detail = EXCLUDED.detail;
      v_scans := v_scans || jsonb_build_object('cluster_id', c.id, 'ok', false, 'sqlstate', v_sqlstate);
    END;
  END LOOP;

  -- B. EVERY CHECK OF EVERY CLUSTER OF THE LIGHTNING ESTATE, each in its own
  --    sub-block.
  FOR c IN
    SELECT cg.id, cg.name, cg.club_id, cg.cluster_mode, cg.cluster_epoch
      FROM public.cash_games cg
     WHERE cg.lightning_enabled IS TRUE OR cg.cluster_mode = ANY (c_modes)
     ORDER BY cg.id
     LIMIT 500
  LOOP
    v_checked := v_checked + 1;
    v_cfg := NULL;
    BEGIN
      v_cfg := public.fn_lightning_config(c.id);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_errors := v_errors || jsonb_build_object('check', 'config', 'cluster_id', c.id,
                                                 'sqlstate', v_sqlstate, 'message', left(v_msg, 300));
    END;
    v_cfg := coalesce(v_cfg, '{}'::jsonb);
    v_win := make_interval(secs => coalesce((v_cfg ->> 'alert_window_ms')::numeric, 600000) / 1000.0);

    -- B1. FROZEN, with no open page from any freeze source.
    BEGIN
      IF c.cluster_mode = 'frozen' THEN
        v_key := 'lightning_cluster_frozen:' || c.id::text;
        IF EXISTS (SELECT 1 FROM public.financial_alerts fa
                    WHERE NOT fa.resolved
                      AND fa.source IN ('lightning_formation', 'lightning_settlement', 'lightning_alerts')
                      AND fa.context ->> 'dedupe_key' = v_key) THEN
          v_out := 'open';
        ELSE
          v_fz_at := NULL; v_fz_p := NULL;
          SELECT e.at, e.payload INTO v_fz_at, v_fz_p
            FROM public.cash_cluster_events e
           WHERE e.game_id = c.id AND e.kind = 'cluster_frozen'
             AND e.at >= coalesce((SELECT ce.started_at FROM public.cash_cluster_epoch ce
                                    WHERE ce.cluster_id = c.id AND ce.ended_at IS NULL), '-infinity'::timestamptz)
           ORDER BY e.at DESC LIMIT 1;
          v_out := public.fn_lightning_alert_raise('frozen', c.id, v_key, 'critical',
            format('LIGHTNING_CLUSTER_FROZEN: Lightning Cluster %s (%s) is frozen at epoch %s%s and no alert is open for it. '
                   || 'A frozen Cluster is evidence: nothing mutates it. Read fn_lightning_operator_cluster and '
                   || 'fn_lightning_operator_forensics, then recover only through fn_cash_cluster_unfreeze(cluster, operator, reason).',
                   c.name, c.id, c.cluster_epoch, CASE WHEN v_fz_at IS NOT NULL THEN ' since ' || v_fz_at::text ELSE '' END),
            jsonb_build_object('cluster_name', c.name, 'club_id', c.club_id, 'cluster_epoch', c.cluster_epoch,
                               'frozen_at', v_fz_at, 'reason', v_fz_p ->> 'reason', 'invariant', v_fz_p ->> 'invariant',
                               'recovery', 'fn_cash_cluster_unfreeze(cluster_id, operator, reason)'));
        END IF;
        v_outcomes := v_outcomes || jsonb_build_object('check', 'frozen', 'outcome', v_out);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_errors := v_errors || jsonb_build_object('check', 'frozen', 'cluster_id', c.id,
                                                 'sqlstate', v_sqlstate, 'message', left(v_msg, 300));
    END;

    -- B2. A CONVERSION STUCK PAST THE REAPER.
    BEGIN
      v_ms := coalesce((v_cfg ->> 'alert_stuck_conversion_ms')::integer, 1200000);
      SELECT cc.id, cc.from_mode, cc.to_mode, cc.opened_at INTO v_conv
        FROM public.cash_cluster_conversion cc WHERE cc.cluster_id = c.id AND cc.status = 'pending';
      IF v_conv.id IS NOT NULL AND v_conv.opened_at < v_now - make_interval(secs => v_ms / 1000.0) THEN
        v_out := public.fn_lightning_alert_raise('stuck_conversion', c.id,
          'lightning_stuck_conversion:' || v_conv.id::text, 'critical',
          format('LIGHTNING_CONVERSION_STUCK: Lightning Cluster %s (%s) has held its %s -> %s conversion %s open since %s, '
                 || 'longer than %s ms and past the stuck-conversion reaper. Its member tables stay halted while it is open. '
                 || 'Read fn_lightning_operator_cluster (transitions) and the drive and reaper events.',
                 c.name, c.id, v_conv.from_mode, v_conv.to_mode, v_conv.id, v_conv.opened_at, v_ms),
          jsonb_build_object('cluster_name', c.name, 'club_id', c.club_id, 'cluster_mode', c.cluster_mode,
                             'conversion_id', v_conv.id, 'from_mode', v_conv.from_mode, 'to_mode', v_conv.to_mode,
                             'opened_at', v_conv.opened_at, 'threshold_ms', v_ms,
                             'age_ms', floor(extract(epoch FROM (v_now - v_conv.opened_at)) * 1000)::bigint));
        v_outcomes := v_outcomes || jsonb_build_object('check', 'stuck_conversion', 'outcome', v_out);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_errors := v_errors || jsonb_build_object('check', 'stuck_conversion', 'cluster_id', c.id,
                                                 'sqlstate', v_sqlstate, 'message', left(v_msg, 300));
    END;

    -- B3. DRIVE ERRORS in the window (since the key's last resolution).
    BEGIN
      v_key := 'lightning_drive_error:' || c.id::text;
      v_since := GREATEST(v_now - v_win, coalesce(
        (SELECT max(fa.resolved_at) FROM public.financial_alerts fa
          WHERE fa.source = 'lightning_alerts' AND fa.resolved AND fa.context ->> 'dedupe_key' = v_key
            AND fa.created_at > v_now - interval '30 days'), '-infinity'::timestamptz));
      SELECT count(*)::integer,
             jsonb_agg(jsonb_build_object('at', x.at, 'action', x.payload ->> 'action', 'mode', x.payload ->> 'mode',
                                          'sqlstate', x.payload ->> 'sqlstate', 'message', left(x.payload ->> 'message', 300))
                       ORDER BY x.at DESC) FILTER (WHERE x.rn <= 5)
        INTO v_n, v_detail
        FROM (SELECT e.at, e.payload, row_number() OVER (ORDER BY e.at DESC, e.id DESC) AS rn
                FROM public.cash_cluster_events e
               WHERE e.game_id = c.id AND e.at > v_since AND e.kind = 'lightning_drive_error') x;
      IF v_n >= coalesce((v_cfg ->> 'alert_drive_errors')::integer, 3) THEN
        v_out := public.fn_lightning_alert_raise('drive_error', c.id, v_key, 'warning',
          format('LIGHTNING_DRIVE_ERROR: the drive of Lightning Cluster %s (%s) failed %s time(s) since %s (threshold %s). '
                 || 'Each failure rolled back only that step; the latest is in this alert''s context.',
                 c.name, c.id, v_n, v_since, coalesce((v_cfg ->> 'alert_drive_errors')::integer, 3)),
          jsonb_build_object('cluster_name', c.name, 'club_id', c.club_id, 'errors', v_n, 'since', v_since,
                             'latest', v_detail));
        v_outcomes := v_outcomes || jsonb_build_object('check', 'drive_error', 'outcome', v_out);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_errors := v_errors || jsonb_build_object('check', 'drive_error', 'cluster_id', c.id,
                                                 'sqlstate', v_sqlstate, 'message', left(v_msg, 300));
    END;

    -- B4. REAPER FAILURES: a reap that recorded its own failure, or a live
    --     instance the formation reaper has left past its deadline for
    --     longer than the window (not judged on a frozen Cluster, whose
    --     instances are evidence and which has its own page).
    BEGIN
      v_key := 'lightning_reaper_failure:' || c.id::text;
      v_since := GREATEST(v_now - v_win, coalesce(
        (SELECT max(fa.resolved_at) FROM public.financial_alerts fa
          WHERE fa.source = 'lightning_alerts' AND fa.resolved AND fa.context ->> 'dedupe_key' = v_key
            AND fa.created_at > v_now - interval '30 days'), '-infinity'::timestamptz));
      SELECT count(*)::integer,
             jsonb_agg(jsonb_build_object('at', x.at, 'kind', x.kind, 'sqlstate', x.payload ->> 'sqlstate',
                                          'message', left(x.payload ->> 'message', 300))
                       ORDER BY x.at DESC) FILTER (WHERE x.rn <= 5)
        INTO v_n, v_detail
        FROM (SELECT e.at, e.kind, e.payload, row_number() OVER (ORDER BY e.at DESC, e.id DESC) AS rn
                FROM public.cash_cluster_events e
               WHERE e.game_id = c.id AND e.at > v_since
                 AND e.kind IN ('lightning_pending_on_reap_failed', 'lightning_pending_off_reap_failed')) x;
      v_n2 := 0;
      IF c.cluster_mode IS DISTINCT FROM 'frozen' THEN
        SELECT count(*)::integer INTO v_n2 FROM public.lightning_instance i
         WHERE i.cluster_id = c.id AND i.state IN ('forming', 'reserved', 'dealing', 'settling')
           AND i.deadline_at < v_now - v_win;
      END IF;
      IF v_n >= coalesce((v_cfg ->> 'alert_reaper_failures')::integer, 1) OR v_n2 > 0 THEN
        v_out := public.fn_lightning_alert_raise('reaper_failure', c.id, v_key, 'critical',
          format('LIGHTNING_REAPER_FAILURE: Lightning Cluster %s (%s) has %s failed reap(s) since %s and %s live instance(s) '
                 || 'past their deadline by more than the alert window. A stuck conversion or a buried instance holds players.',
                 c.name, c.id, v_n, v_since, v_n2),
          jsonb_build_object('cluster_name', c.name, 'club_id', c.club_id, 'failed_reaps', v_n,
                             'instances_past_deadline', v_n2, 'since', v_since, 'latest', v_detail));
        v_outcomes := v_outcomes || jsonb_build_object('check', 'reaper_failure', 'outcome', v_out);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_errors := v_errors || jsonb_build_object('check', 'reaper_failure', 'cluster_id', c.id,
                                                 'sqlstate', v_sqlstate, 'message', left(v_msg, 300));
    END;

    -- B5. AN INTEGRITY SPIKE: new high-severity signals in the window.
    BEGIN
      v_key := 'lightning_integrity_spike:' || c.id::text;
      v_since := GREATEST(v_now - v_win, coalesce(
        (SELECT max(fa.resolved_at) FROM public.financial_alerts fa
          WHERE fa.source = 'lightning_alerts' AND fa.resolved AND fa.context ->> 'dedupe_key' = v_key
            AND fa.created_at > v_now - interval '30 days'), '-infinity'::timestamptz));
      SELECT count(*)::integer, jsonb_object_agg(q.pattern_type, q.n)
        INTO v_n, v_detail
        FROM (SELECT s.pattern_type, count(*) AS n FROM public.lightning_integrity_signal s
               WHERE s.cluster_id = c.id AND s.severity = 'high' AND s.detected_at > v_since
               GROUP BY s.pattern_type) q;
      SELECT coalesce(sum((e.value #>> '{}')::integer), 0)::integer INTO v_n FROM jsonb_each(coalesce(v_detail, '{}'::jsonb)) e;
      IF v_n >= coalesce((v_cfg ->> 'alert_integrity_high_signals')::integer, 5) THEN
        v_out := public.fn_lightning_alert_raise('integrity_spike', c.id, v_key, 'warning',
          format('LIGHTNING_INTEGRITY_SPIKE: Lightning Cluster %s (%s) has %s new high-severity integrity signal(s) since %s '
                 || '(threshold %s). Review them in fn_lightning_operator_cluster; telemetry never changes seating.',
                 c.name, c.id, v_n, v_since, coalesce((v_cfg ->> 'alert_integrity_high_signals')::integer, 5)),
          jsonb_build_object('cluster_name', c.name, 'club_id', c.club_id, 'high_signals', v_n, 'since', v_since,
                             'by_pattern', v_detail));
        v_outcomes := v_outcomes || jsonb_build_object('check', 'integrity_spike', 'outcome', v_out);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_errors := v_errors || jsonb_build_object('check', 'integrity_spike', 'cluster_id', c.id,
                                                 'sqlstate', v_sqlstate, 'message', left(v_msg, 300));
    END;

    -- B6. A LATENCY REGRESSION, per leg.
    BEGIN
      FOREACH v_leg IN ARRAY c_legs LOOP
        v_detail := public.fn_lightning_latency_regression(c.id, v_leg, v_cfg, v_now);
        IF v_detail IS NOT NULL THEN
          v_out := public.fn_lightning_alert_raise('latency_regression', c.id,
            'lightning_latency_regression:' || c.id::text || ':' || v_leg, 'warning',
            format('LIGHTNING_LATENCY_REGRESSION: Lightning Cluster %s (%s) leg %s has had a p95 above %s ms in each of '
                   || 'its last %s windows. Measure before optimizing; the windows are in this alert''s context.',
                   c.name, c.id, v_leg, v_cfg -> 'alert_latency_p95_ms' ->> v_leg, jsonb_array_length(v_detail)),
            jsonb_build_object('cluster_name', c.name, 'club_id', c.club_id, 'leg', v_leg,
                               'ceiling_ms', (v_cfg -> 'alert_latency_p95_ms' ->> v_leg)::integer,
                               'min_samples', (v_cfg ->> 'alert_latency_min_samples')::integer,
                               'windows', v_detail));
          v_outcomes := v_outcomes || jsonb_build_object('check', 'latency_regression', 'outcome', v_out);
        END IF;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_errors := v_errors || jsonb_build_object('check', 'latency_regression', 'cluster_id', c.id,
                                                 'sqlstate', v_sqlstate, 'message', left(v_msg, 300));
    END;
  END LOOP;

  -- C. THE STATE PAGES ARE RE-MEASURED: a frozen Cluster that is no longer
  --    frozen, a conversion that is no longer pending, a leg that is no
  --    longer regressing. Event pages stay for a person to close.
  FOR a IN
    SELECT fa.id, fa.context, fa.created_at
      FROM public.financial_alerts fa
     WHERE NOT fa.resolved AND fa.source = 'lightning_alerts'
       AND fa.context ->> 'check' IN ('frozen', 'stuck_conversion', 'latency_regression')
     ORDER BY fa.created_at, fa.id
     LIMIT 500
  LOOP
    BEGIN
      v_resolve := false;
      IF a.context ->> 'check' = 'frozen' THEN
        v_resolve := NOT EXISTS (SELECT 1 FROM public.cash_games cg
                                  WHERE cg.id::text = a.context ->> 'cluster_id' AND cg.cluster_mode = 'frozen');
      ELSIF a.context ->> 'check' = 'stuck_conversion' THEN
        v_resolve := NOT EXISTS (SELECT 1 FROM public.cash_cluster_conversion cc
                                  WHERE cc.id::text = a.context ->> 'conversion_id' AND cc.status = 'pending');
      ELSE
        v_resolve := NOT EXISTS (SELECT 1 FROM public.cash_games cg WHERE cg.id::text = a.context ->> 'cluster_id')
                     OR public.fn_lightning_latency_regression((a.context ->> 'cluster_id')::uuid, a.context ->> 'leg',
                          public.fn_lightning_config((a.context ->> 'cluster_id')::uuid), v_now) IS NULL;
      END IF;
      IF v_resolve THEN
        UPDATE public.financial_alerts fa
           SET resolved = true, resolved_at = clock_timestamp(),
               resolution = format('Re-measured by fn_lightning_alert_sweep at %s: the %s condition raised at %s no longer holds.',
                                   v_now, a.context ->> 'check', a.created_at)
         WHERE fa.id = a.id AND NOT fa.resolved;
        IF FOUND THEN
          v_outcomes := v_outcomes || jsonb_build_object('check', a.context ->> 'check', 'outcome', 'resolved');
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_errors := v_errors || jsonb_build_object('check', 'resolve:' || coalesce(a.context ->> 'check', '?'),
                                                 'cluster_id', a.context ->> 'cluster_id',
                                                 'sqlstate', v_sqlstate, 'message', left(v_msg, 300));
    END;
  END LOOP;

  -- D. RETENTION of the latency ledger: 30 days, at most 5000 rows a pass.
  BEGIN
    DELETE FROM public.lightning_latency_window w
     WHERE w.id IN (SELECT x.id FROM public.lightning_latency_window x
                     WHERE x.window_to < v_now - interval '30 days'
                     ORDER BY x.window_to LIMIT 5000);
    GET DIAGNOSTICS v_pruned = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_errors := v_errors || jsonb_build_object('check', 'prune', 'cluster_id', NULL,
                                               'sqlstate', v_sqlstate, 'message', left(v_msg, 300));
  END;

  SELECT jsonb_build_object(
           'ok', true,
           'as_of', v_now,
           'clusters_checked', v_checked,
           'raised', (SELECT jsonb_object_agg(k, (SELECT count(*) FROM jsonb_array_elements(v_outcomes) o
                                                   WHERE o ->> 'check' = k AND o ->> 'outcome' = 'raised'))
                        FROM unnest(c_checks) k),
           'open', (SELECT jsonb_object_agg(k, (SELECT count(*) FROM jsonb_array_elements(v_outcomes) o
                                                 WHERE o ->> 'check' = k AND o ->> 'outcome' = 'open'))
                      FROM unnest(c_checks) k),
           'rate_limited', (SELECT count(*) FROM jsonb_array_elements(v_outcomes) o WHERE o ->> 'outcome' = 'rate_limited'),
           'resolved', (SELECT jsonb_object_agg(k, (SELECT count(*) FROM jsonb_array_elements(v_outcomes) o
                                                     WHERE o ->> 'check' = k AND o ->> 'outcome' = 'resolved'))
                          FROM unnest(c_checks) k),
           'integrity_scans', v_scans,
           'pruned', v_pruned,
           'errors', (SELECT coalesce(jsonb_agg(e.value ORDER BY e.ord), '[]'::jsonb)
                        FROM jsonb_array_elements(v_errors) WITH ORDINALITY e(value, ord) WHERE e.ord <= 50),
           'errors_total', jsonb_array_length(v_errors))
    INTO v_result;
  RETURN v_result;
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_alert_sweep(timestamptz) IS
  'Lightning Phase 12 (20261009144343): the Lightning operator alerting pass, every minute from cron job lightning-alert-sweep-1m (never inside fn_cash_clusters_tick_all). Over the Lightning estate it pages, through fn_raise_server_financial_alert source lightning_alerts with stable dedupe keys, a frozen Cluster with no open freeze alert, a conversion stuck past the reaper, drive errors, reaper failures, an integrity spike and a latency regression; it resolves its own state pages when a re-measure finds them gone; it runs fn_lightning_integrity_scan hourly for Clusters with integrity_telemetry; it prunes latency windows older than 30 days. Every check is isolated and reported in the answer; it never raises and never writes a Cluster''s state. service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_alert_sweep(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_alert_sweep(timestamptz) TO service_role;

-- ===========================================================================
-- 19. THE SCHEDULE, through the managed cron API exactly as 20261009045421
--     uses it: cron.job is read, and written only by cron.schedule (a new
--     row) or cron.alter_job (an existing row whose schedule, command or
--     active flag differs). A job already exactly right is left alone, so a
--     second application changes nothing and the jobid is stable.
-- ===========================================================================

DO $cron$
DECLARE
  c_name constant text := 'lightning-alert-sweep-1m';
  c_sched constant text := '* * * * *';
  c_cmd  constant text := $cmd$SET statement_timeout = '50s'; SELECT public.fn_lightning_alert_sweep();$cmd$;
  v_job  record;
BEGIN
  SELECT j.jobid, j.schedule, j.command, j.active INTO v_job FROM cron.job j WHERE j.jobname = c_name;
  IF v_job.jobid IS NULL THEN
    PERFORM cron.schedule('lightning-alert-sweep-1m', '* * * * *', c_cmd);
  ELSIF v_job.schedule IS DISTINCT FROM c_sched OR v_job.command IS DISTINCT FROM c_cmd
        OR v_job.active IS DISTINCT FROM true THEN
    PERFORM cron.alter_job(v_job.jobid, schedule := c_sched, command := c_cmd, active := true);
  END IF;
  IF (SELECT count(*) FROM cron.job j
       WHERE j.jobname = c_name AND j.active AND j.schedule = c_sched AND j.command = c_cmd) <> 1 THEN
    RAISE EXCEPTION 'LIGHTNING_P12_CRON: % is not exactly one active job at % running the sweep', c_name, c_sched
      USING ERRCODE = '55000';
  END IF;
END
$cron$;

-- ===========================================================================
-- 20. READ BACK.
-- ===========================================================================

DO $readback$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(q.what, '; ') INTO v_bad FROM (VALUES
    ('the latency ledger is closed to every role', (SELECT c.relrowsecurity
       AND NOT has_table_privilege('anon', c.oid, 'SELECT') AND NOT has_table_privilege('authenticated', c.oid, 'SELECT')
       AND NOT has_table_privilege('service_role', c.oid, 'SELECT') AND NOT has_table_privilege('service_role', c.oid, 'INSERT')
       FROM pg_class c WHERE c.oid = 'public.lightning_latency_window'::regclass)),
    ('the sweep state is closed to every role', (SELECT c.relrowsecurity
       AND NOT has_table_privilege('anon', c.oid, 'SELECT') AND NOT has_table_privilege('authenticated', c.oid, 'SELECT')
       AND NOT has_table_privilege('service_role', c.oid, 'SELECT')
       FROM pg_class c WHERE c.oid = 'public.lightning_alert_sweep_state'::regclass)),
    ('the latency sequence is closed to every role', (SELECT NOT has_sequence_privilege('anon', 'public.lightning_latency_window_id_seq', 'USAGE')
       AND NOT has_sequence_privilege('authenticated', 'public.lightning_latency_window_id_seq', 'USAGE')
       AND NOT has_sequence_privilege('service_role', 'public.lightning_latency_window_id_seq', 'USAGE'))),
    ('seven Lightning tables are granted to the service, none to a player', (SELECT count(*) = 7
       FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name LIKE 'lightning\_%'
        AND grantee = 'service_role' AND privilege_type = 'SELECT')
       AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public'
                        AND table_name LIKE 'lightning\_%' AND grantee IN ('anon', 'authenticated', 'PUBLIC'))),
    ('the six operator doors are authenticated and service, never anon', (SELECT bool_and(p.prosecdef
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) AND count(*) = 6
       FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_operator_overview(uuid)'::regprocedure,
         'public.fn_lightning_operator_cluster(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure,
         'public.fn_lightning_operator_hand_replay(uuid,uuid)'::regprocedure,
         'public.fn_lightning_operator_session_trail(uuid,uuid)'::regprocedure,
         'public.fn_lightning_operator_forensics(uuid,timestamp with time zone,timestamp with time zone,integer)'::regprocedure,
         'public.fn_lightning_operator_signal_review(bigint,text,text)'::regprocedure))),
    ('the service doors are the service''s alone', (SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
       AND count(*) = 7
       FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_latency_report(uuid,timestamp with time zone,timestamp with time zone,jsonb)'::regprocedure,
         'public.fn_lightning_alert_sweep(timestamp with time zone)'::regprocedure,
         'public.fn_lightning_operator_redact(jsonb)'::regprocedure,
         'public.fn_lightning_operator_may(uuid)'::regprocedure,
         'public.fn_lightning_operator_cluster_row(uuid,timestamp with time zone)'::regprocedure,
         'public.fn_lightning_alert_raise(text,uuid,text,text,text,jsonb)'::regprocedure,
         'public.fn_lightning_latency_regression(uuid,text,jsonb,timestamp with time zone)'::regprocedure))),
    ('the configuration answers the Phase 12 keys', (SELECT (c ->> 'latency_window_ms')::integer = 60000
       AND (c ->> 'latency_telemetry')::boolean AND c ? 'quality_weights' AND c ? 'alert_latency_p95_ms'
       FROM (SELECT public.fn_lightning_config(NULL) AS c) q)),
    ('the redactor drops every card key', (SELECT public.fn_lightning_operator_redact(
       '{"a":{"hole_cards":["As"],"deck_seed":"x","b":[{"card":1,"ok":2}]},"seedless":1}'::jsonb) = '{"a":{"b":[{"ok":2}]}}'::jsonb)),
    ('the sweep is scheduled', (SELECT count(*) = 1 FROM cron.job WHERE jobname = 'lightning-alert-sweep-1m' AND active)),
    ('no seating path reads the new stores', (SELECT bool_and(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g')
       !~ 'integrity|shadow_comparison|quality_|latency|lightning_alert|fn_lightning_operator_')
       FROM pg_proc p WHERE p.oid IN (
         'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure,
         'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure,
         'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text,jsonb)'::regprocedure,
         'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)'::regprocedure,
         'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure,
         'public.fn_cash_clusters_tick_all(jsonb)'::regprocedure))),
    ('no horse is singled out', (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f'
         AND (p.proname LIKE 'fn\_lightning\_operator\_%' OR p.proname IN ('fn_lightning_latency_report', 'fn_lightning_latency_regression',
              'fn_lightning_alert_sweep', 'fn_lightning_alert_raise', 'fn_lightning_config'))
         AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id')))
  ) q(what, ok) WHERE q.ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIGHTNING_P12_OPERATOR_READBACK: the catalogue does not carry: %', v_bad;
  END IF;
END
$readback$;

COMMIT;
