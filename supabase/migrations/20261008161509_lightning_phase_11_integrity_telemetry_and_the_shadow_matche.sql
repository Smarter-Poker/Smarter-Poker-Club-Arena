-- 20261008161509_lightning_phase_11_integrity_telemetry_and_the_shadow_matche.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- LIGHTNING PHASE 11 (SPECIFICATION PHASES 18 AND 19, THE DATABASE SIDE):
-- INTEGRITY / BOT / COLLUSION TELEMETRY, AND THE SHADOW MATCHER LEDGER.
--
-- THE EXISTING INTEGRITY SYSTEM, inspected against PokerIQ-Production on
-- 2026-10-08, and what this file does with each part of it:
--
--   * ca_collusion_signals (club-arena's own pair store: user_a the net
--     receiver, user_b the sender, hands_together, gross_flow, net_flow,
--     direction_ratio, both_cert, detail.signal), written by this repo's
--     fn_ca_collusion_scan and fn_ca_duel_pairing_scan and read by the
--     operator review queue (fn_ca_integrity_queue) and the case evidence
--     door (fn_ca_integrity_case_add_item 'collusion_signal'). A Lightning
--     CHIP_FLOW finding has exactly that store's meaning, so it is WRITTEN
--     THERE TOO, in the duel scan's own convention (detail.signal names the
--     detector, here 'lightning_chip_flow'), once per finding key: it reaches
--     the operator queue and can be attached to a case with no new reader.
--   * collusion_tracking (the external collusion worker's store) is NOT
--     written: fn_ca_integrity_detector_health reads its newest row as that
--     worker's heartbeat, so Lightning rows there would hide a dead worker.
--   * fn_ca_integrity_queue and fn_ca_integrity_detector_health belong to the
--     Smarter-Poker-World-Hub migrations; this file does not rewrite them.
--     The health reader counts chip_flow_rows only where detail.signal IS
--     NULL, so the Lightning rows never inflate the daily scan's count.
--   * anti_cheat_flags is club-operator facing (fn_club_anti_cheat_flags) and
--     carries no evidence object; it is not written.
--
-- Every other Lightning signal has no existing home with its shape (a single
-- player subject, a Cluster, a window), so ONE store is added, shaped on
-- collusion_tracking's conventions (player_a/player_b, pattern_type,
-- suspicion_score 0..100, evidence jsonb, window_start/window_end, status
-- open/reviewed/cleared/actioned) plus the Cluster, the source and a
-- severity: public.lightning_integrity_signal. It is keyed for idempotency by
-- (cluster, pattern, window, subject pair or player) and a rescan that finds
-- the same numbers changes nothing; a status an operator set is never
-- touched by a rescan.
--
-- SIGNALS, from persisted Lightning data only (fn_lightning_integrity_scan):
--   PAIRING_CONCENTRATION  repeat encounters / suspicious pairing
--                          concentration: hands together against the count
--                          expected from each player's own hand count in the
--                          window (hands_a * hands_b / hands), so a small pool
--                          that always plays together is not flagged.
--   CHIP_FLOW              one-directional net flow between a pair across the
--                          hands they shared with opposite results.
--   COORDINATED_JOIN_LEAVE pool sessions that entered AND exited within ten
--                          seconds of each other, repeatedly.
--   SESSION_LENGTH         a pool session of twelve hours or more.
--   DEVICE_OVERLAP         a pair that shared hands and shares a recorded IP
--                          address in user_sessions (the platform's existing
--                          session store; nothing new is collected and the
--                          address itself never enters the evidence).
--   ACCOUNT_RELATIONSHIP   a pair that shared hands where one referred the
--                          other (profiles.referred_by, existing data).
-- From the engine (fn_lightning_integrity_report), because the database does
-- NOT persist per-action timing for Lightning (lightning_hand_player carries
-- waited_ms and folded_at, never a decision latency per action). The engine
-- sends its window aggregates (per player: decisions, timeouts, latency
-- percentiles, cv, fast_share; per pair: hands together, sequential actions,
-- fast follows, latency correlation) and THE DATABASE decides what is
-- abnormal, so the thresholds live in one reviewed place:
--   DECISION_LATENCY       robotic consistency (cv <= 0.15) or a fast-action
--                          share >= 0.6 over >= 50 decisions.
--   TIMING_CORRELATION     latency correlation >= 0.7 or fast follows on
--                          >= half of >= 30 sequential actions, over >= 20
--                          hands together.
--
-- THE SCAN IS NOT WIRED INTO fn_cash_clusters_tick_all. The tick runs every
-- few seconds and must stay sub-second; a pair aggregation over a day of
-- hands is bounded (20000 hands and 5000 sessions per Cluster, 50 Clusters
-- per call) but not sub-second at volume. It is an on-demand service door
-- (engine, operator or a later scheduled job). The tick is untouched, so no
-- predecessor proof that counts its EXCEPTION blocks is restated.
--
-- NO MATCHMAKING MANIPULATION. Nothing in the seating path reads a signal:
-- fn_lightning_form_hand, fn_lightning_player_legality, the matcher
-- (fn_lightning_match, fn_lightning_match_plan, fn_lightning_match_and_form,
-- fn_lightning_diversity_assign), reservations and the tick never mention
-- the signal store, the chip-flow mirror, the shadow ledger or the quality
-- score (pinned below over every fn_lightning_ and fn_cash_cluster body).
-- No product or security policy requires an integrity-based seating rule.
--
-- THE SHADOW MATCHER LEDGER. No shadow store existed: the dark worker
-- (server/src/lightning/LightningShadowWorker, worker_mode 'shadow') calls
-- the read-only fn_lightning_match and records nothing, and
-- cash_cluster_matcher_pass is the LIVE pass record. Added:
--   * lightning_matcher_shadow_comparison: one row per (Cluster, window,
--     live_matcher_version, shadow_matcher_version) carrying both sides'
--     metrics, both quality scores and the weights that scored them.
--   * fn_lightning_quality_components(side) and fn_lightning_quality_score(
--     side, weights): the internal Lightning Quality Score, 0..100, a
--     weighted mean of six components in 0..1 read from the engine's window
--     object (next_hand_speed from the wait percentiles, formation_success,
--     bb_fairness from BB order violations, opponent_diversity from the
--     repeat-pair rate, instance_utilization, reliability = 1 -
--     failure_rate). Never exposed to players.
--   * fn_lightning_config gains the engine's switches, all off:
--     lightning_shadow_matcher (false), shadow_matcher_version ('m2'),
--     shadow_window_ms (300000), shadow_max_players (500),
--     shadow_pass_budget_ms (50), integrity_telemetry (false), and
--     quality_weights, defaults 0.25 / 0.20 / 0.15 / 0.15 / 0.10 / 0.15 (sum
--     1), read, clamped and reported in `invalid` like every other key;
--     weights that do not sum to one are normalized.
--   * fn_lightning_shadow_record and fn_lightning_shadow_report: the engine's
--     write door and the operator's promotion read.
-- The shadow never controls live seating: nothing in the seating path reads
-- the ledger (pinned).
--
-- LIGHTNING IS OFF EVERYWHERE. Every object here is new or Lightning-only;
-- the one existing body changed is fn_lightning_config (seven new keys, the
-- two engine switches off by default). The
-- two new indexes sit on lightning_hand and lightning_pool_session, both
-- empty in production. Non-Lightning cash play is unchanged.
--
-- HOUSE RULES OBSERVED. One BEGIN/COMMIT with SET LOCAL lock_timeout. No
-- foreign key to cash_games (that would lock it): the doors check the
-- Cluster themselves. fn_lightning_config is changed by an asserted
-- substitution into the body production carries (read with
-- pg_get_functiondef on 2026-10-08, after 20261008142857): every anchor must
-- appear exactly as often as stated or the file refuses, and a body already
-- carrying the marker is left alone, so the file is re-appliable. Every new
-- function is service_role only (production's autorevoke strips anon and
-- the file revokes authenticated and PUBLIC). Both new tables have RLS on,
-- no policy and NO table privilege for any role, service_role included: the
-- four doors that touch them are SECURITY DEFINER (service_role EXECUTE
-- only), so 20260920235343's census of exactly seven Lightning tables
-- granted to service_role stays true. fn_lightning_config's first
-- jsonb_build_object is at 88 of its 100 arguments, so the Phase 11 keys
-- ride in a second object joined onto it.
--
-- LAW 10.5. Nothing here reads is_horse or horse_id. A horse is scanned,
-- reported, scored and mirrored exactly as a human; the harness plants a
-- human-horse pair and proves it is found like any other.
--
-- @live-proof: (SELECT c.relrowsecurity AND NOT EXISTS (SELECT 1 FROM pg_policy pol WHERE pol.polrelid = c.oid) AND NOT has_table_privilege('anon', c.oid, 'SELECT') AND NOT has_table_privilege('authenticated', c.oid, 'SELECT') AND NOT has_table_privilege('service_role', c.oid, 'SELECT') FROM pg_class c WHERE c.oid = 'public.lightning_integrity_signal'::regclass)
-- @live-proof: (SELECT c.relrowsecurity AND NOT EXISTS (SELECT 1 FROM pg_policy pol WHERE pol.polrelid = c.oid) AND NOT has_table_privilege('anon', c.oid, 'SELECT') AND NOT has_table_privilege('authenticated', c.oid, 'SELECT') AND NOT has_table_privilege('service_role', c.oid, 'SELECT') FROM pg_class c WHERE c.oid = 'public.lightning_matcher_shadow_comparison'::regclass)
-- @live-proof: (SELECT pg_get_indexdef(i.indexrelid) ~ 'NULLS NOT DISTINCT' AND i.indisunique FROM pg_index i WHERE i.indexrelid = 'public.lightning_integrity_signal_one_per_key'::regclass)
-- @live-proof: (SELECT i.indisunique FROM pg_index i WHERE i.indexrelid = 'public.lightning_matcher_shadow_comparison_one_per_key'::regclass)
-- @live-proof: (SELECT count(*) = 9 FROM pg_constraint c WHERE c.conrelid = 'public.lightning_integrity_signal'::regclass AND c.contype = 'c' AND c.conname LIKE 'lightning\_integrity\_signal\_%')
-- @live-proof: (SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND p.prosecdef = (p.proname NOT LIKE 'fn\_lightning\_quality\_%')) AND count(*) = 6 FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_quality_components(jsonb)'::regprocedure, 'public.fn_lightning_integrity_scan(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure, 'public.fn_lightning_integrity_report(uuid,jsonb,timestamp with time zone)'::regprocedure, 'public.fn_lightning_quality_score(jsonb,jsonb)'::regprocedure, 'public.fn_lightning_shadow_record(uuid,text,text,timestamp with time zone,timestamp with time zone,jsonb,jsonb)'::regprocedure, 'public.fn_lightning_shadow_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))
-- @live-proof: (SELECT round((c -> 'quality_weights' ->> 'next_hand_speed')::numeric, 6) = 0.25 AND round((c -> 'quality_weights' ->> 'formation_success')::numeric, 6) = 0.20 AND round((c -> 'quality_weights' ->> 'bb_fairness')::numeric, 6) = 0.15 AND round((c -> 'quality_weights' ->> 'opponent_diversity')::numeric, 6) = 0.15 AND round((c -> 'quality_weights' ->> 'instance_utilization')::numeric, 6) = 0.10 AND round((c -> 'quality_weights' ->> 'reliability')::numeric, 6) = 0.15 AND (c ->> 'lightning_shadow_matcher')::boolean = false AND (c ->> 'integrity_telemetry')::boolean = false AND c ->> 'shadow_matcher_version' = 'm2' AND (c ->> 'shadow_window_ms')::integer = 300000 AND (c ->> 'shadow_max_players')::integer = 500 AND (c ->> 'shadow_pass_budget_ms')::integer = 50 FROM (SELECT public.fn_lightning_config(NULL) AS c) q)
-- @live-proof: (SELECT public.fn_lightning_quality_score('{"passes":10,"formation_success_rate":1,"failure_rate":0,"wait_ms":{"n":5,"p50":0,"p95":0},"bb_fairness":{"n":5,"order_violations":0},"opponent_diversity":{"repeat_pair_rate":0},"instance_occupancy":{"utilization":1}}'::jsonb) = 100 AND public.fn_lightning_quality_score('{"passes":10,"formation_success_rate":0,"failure_rate":1,"wait_ms":{"n":5,"p50":30000,"p95":60000},"bb_fairness":{"n":5,"order_violations":5},"opponent_diversity":{"repeat_pair_rate":1},"instance_occupancy":{"utilization":0}}'::jsonb) = 0)
-- @live-proof: (SELECT s ~ 'ca_collusion_signals' AND s ~ '''lightning_chip_flow''' AND s ~ 'user_sessions' AND s ~ 'referred_by' AND s !~ 'collusion_tracking' AND s !~ 'anti_cheat_flags' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_integrity_scan(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND (p.proname LIKE 'fn\_lightning\_%' OR p.proname LIKE 'fn\_cash\_cluster%') AND p.proname NOT IN ('fn_lightning_integrity_scan', 'fn_lightning_integrity_report', 'fn_lightning_quality_score', 'fn_lightning_quality_components', 'fn_lightning_shadow_record', 'fn_lightning_shadow_report', 'fn_lightning_config') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'lightning_integrity_signal|lightning_matcher_shadow_comparison|ca_collusion_signals|collusion_tracking|anti_cheat_flags|quality_score|quality_weights|fn_lightning_integrity_'))
-- @live-proof: (SELECT bool_and(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') !~ 'integrity|shadow_comparison|quality_') FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure, 'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure, 'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text,jsonb)'::regprocedure, 'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)'::regprocedure, 'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure, 'public.fn_cash_clusters_tick_all(jsonb)'::regprocedure))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_lightning_integrity_scan', 'fn_lightning_integrity_report', 'fn_lightning_quality_score', 'fn_lightning_quality_components', 'fn_lightning_shadow_record', 'fn_lightning_shadow_report', 'fn_lightning_config') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id'))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('lightning_integrity_signal', 'lightning_matcher_shadow_comparison') AND column_name ~* 'card|deck|seed|hole'))
-- @live-proof: (SELECT s ~ 'evidence_carries_cards' AND s ~ '''DECISION_LATENCY''' AND s ~ '''TIMING_CORRELATION''' FROM (SELECT pg_get_functiondef('public.fn_lightning_integrity_report(uuid,jsonb,timestamp with time zone)'::regprocedure) AS s) q)
-- @live-proof: (SELECT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = 'public.lightning_hand_by_formed_at'::regclass) AND EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = 'public.lightning_pool_session_by_entered'::regclass))

BEGIN;

SET LOCAL lock_timeout = '2s';

-- ===========================================================================
-- 1. THE LIGHTNING SIGNAL STORE, shaped on collusion_tracking's conventions.
--    A pair subject is stored canonically (player_a < player_b); a direction
--    (who received, who sent) lives in the evidence. A single-player pattern
--    has player_b NULL, and the key treats that NULL as a value.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.lightning_integrity_signal (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cluster_id      uuid NOT NULL,
  pattern_type    text NOT NULL,
  source          text NOT NULL,
  player_a        uuid NOT NULL,
  player_b        uuid,
  window_start    timestamptz NOT NULL,
  window_end      timestamptz NOT NULL,
  suspicion_score smallint NOT NULL,
  severity        text NOT NULL,
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'open',
  detected_at     timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  notes           text,
  CONSTRAINT lightning_integrity_signal_pattern_known CHECK (pattern_type IN (
    'PAIRING_CONCENTRATION', 'CHIP_FLOW', 'COORDINATED_JOIN_LEAVE', 'SESSION_LENGTH',
    'DEVICE_OVERLAP', 'ACCOUNT_RELATIONSHIP', 'DECISION_LATENCY', 'TIMING_CORRELATION')),
  CONSTRAINT lightning_integrity_signal_source_fits_pattern CHECK (
    (source = 'engine') = (pattern_type IN ('DECISION_LATENCY', 'TIMING_CORRELATION'))
    AND source IN ('scan', 'engine')),
  CONSTRAINT lightning_integrity_signal_subject_shape CHECK (
    (pattern_type IN ('SESSION_LENGTH', 'DECISION_LATENCY')) = (player_b IS NULL)
    AND (player_b IS NULL OR player_a < player_b)),
  CONSTRAINT lightning_integrity_signal_window_ordered CHECK (window_end > window_start),
  CONSTRAINT lightning_integrity_signal_score_range CHECK (suspicion_score BETWEEN 0 AND 100),
  CONSTRAINT lightning_integrity_signal_severity_known CHECK (severity IN ('low', 'medium', 'high')),
  CONSTRAINT lightning_integrity_signal_status_known CHECK (status IN ('open', 'reviewed', 'cleared', 'actioned')),
  CONSTRAINT lightning_integrity_signal_evidence_bounded CHECK (
    jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 16384),
  CONSTRAINT lightning_integrity_signal_review_shape CHECK (
    (reviewed_at IS NULL) = (reviewed_by IS NULL))
);

COMMENT ON TABLE public.lightning_integrity_signal IS
  'Lightning Phase 11 (20261008161509): Lightning integrity telemetry, shaped on collusion_tracking (player_a/player_b, pattern_type, suspicion_score, evidence, window, status) plus the Cluster, the source (scan = fn_lightning_integrity_scan over persisted Lightning data; engine = fn_lightning_integrity_report) and a severity. One row per (Cluster, pattern, window, subject); a rescan with the same numbers changes nothing and never touches status. CHIP_FLOW findings are also written to ca_collusion_signals (detail.signal lightning_chip_flow) so they reach the operator review queue. Telemetry only: nothing in the seating path reads it. Never carries hole cards.';

CREATE UNIQUE INDEX IF NOT EXISTS lightning_integrity_signal_one_per_key
  ON public.lightning_integrity_signal (cluster_id, pattern_type, window_start, window_end, player_a, player_b)
  NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS lightning_integrity_signal_open_by_window
  ON public.lightning_integrity_signal (window_end DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS lightning_integrity_signal_by_player_a
  ON public.lightning_integrity_signal (player_a, window_end DESC);
CREATE INDEX IF NOT EXISTS lightning_integrity_signal_by_player_b
  ON public.lightning_integrity_signal (player_b, window_end DESC) WHERE player_b IS NOT NULL;

ALTER TABLE public.lightning_integrity_signal ENABLE ROW LEVEL SECURITY;
-- NO ROLE HOLDS A TABLE PRIVILEGE, service_role included: the doors below
-- are SECURITY DEFINER and executable by service_role alone, which is also
-- how 20260920235343's census of Lightning tables granted to service_role
-- (exactly seven) stays true.
REVOKE ALL ON TABLE public.lightning_integrity_signal FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 2. THE SHADOW MATCHER LEDGER: one comparison per (Cluster, window, live
--    version, shadow version), both sides' metrics, both quality scores and
--    the weights that scored them, so every score is reproducible.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.lightning_matcher_shadow_comparison (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cluster_id             uuid NOT NULL,
  window_from            timestamptz NOT NULL,
  window_to              timestamptz NOT NULL,
  live_matcher_version   text NOT NULL,
  shadow_matcher_version text NOT NULL,
  live_metrics           jsonb NOT NULL,
  shadow_metrics         jsonb NOT NULL,
  live_components        jsonb NOT NULL,
  shadow_components      jsonb NOT NULL,
  live_quality_score     numeric(5,2),
  shadow_quality_score   numeric(5,2),
  quality_weights        jsonb NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lightning_matcher_shadow_comparison_window_ordered CHECK (window_to > window_from),
  CONSTRAINT lightning_matcher_shadow_comparison_versions_named CHECK (
    live_matcher_version ~ '^[A-Za-z0-9._:-]{1,32}$'
    AND shadow_matcher_version ~ '^[A-Za-z0-9._:-]{1,32}$'
    AND live_matcher_version <> shadow_matcher_version),
  CONSTRAINT lightning_matcher_shadow_comparison_metrics_bounded CHECK (
    jsonb_typeof(live_metrics) = 'object' AND jsonb_typeof(shadow_metrics) = 'object'
    AND jsonb_typeof(quality_weights) = 'object'
    AND jsonb_typeof(live_components) = 'object' AND jsonb_typeof(shadow_components) = 'object'
    AND octet_length(live_metrics::text) <= 16384 AND octet_length(shadow_metrics::text) <= 16384),
  CONSTRAINT lightning_matcher_shadow_comparison_scores_range CHECK (
    live_quality_score BETWEEN 0 AND 100 AND shadow_quality_score BETWEEN 0 AND 100)
);

COMMENT ON TABLE public.lightning_matcher_shadow_comparison IS
  'Lightning Phase 11 (20261008161509): the shadow matcher ledger. The same real population is planned by the live matcher and a shadow matcher; the shadow never seats anyone. Each row compares one window: each side''s window object as the engine measured it (formation success, wait p50/p95, BB fairness, position fairness, opponent diversity, instance occupancy, failure rate), its quality components, its internal Lightning Quality Score (fn_lightning_quality_score, never shown to players) and the weights used. Written by fn_lightning_shadow_record, read by fn_lightning_shadow_report. Nothing in the seating path reads it.';

CREATE UNIQUE INDEX IF NOT EXISTS lightning_matcher_shadow_comparison_one_per_key
  ON public.lightning_matcher_shadow_comparison
     (cluster_id, window_from, window_to, live_matcher_version, shadow_matcher_version);
CREATE INDEX IF NOT EXISTS lightning_matcher_shadow_comparison_by_versions
  ON public.lightning_matcher_shadow_comparison (live_matcher_version, shadow_matcher_version, window_to DESC);
CREATE INDEX IF NOT EXISTS lightning_matcher_shadow_comparison_by_window
  ON public.lightning_matcher_shadow_comparison (window_to DESC);

ALTER TABLE public.lightning_matcher_shadow_comparison ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lightning_matcher_shadow_comparison FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 3. THE SCAN'S TWO READ PATHS. Both tables are empty in production, so
--    neither build holds a lock for any time.
-- ===========================================================================

CREATE INDEX IF NOT EXISTS lightning_hand_by_formed_at
  ON public.lightning_hand (formed_at, cluster_id);
CREATE INDEX IF NOT EXISTS lightning_pool_session_by_entered
  ON public.lightning_pool_session (cluster_id, entered_at);

-- ===========================================================================
-- 4. THE REWRITER, in the shape 20261008050805 cut it and 20261008111425
--    reused: an asserted substitution into the body production carries.
--    Every anchor must appear exactly as often as stated or the file
--    refuses; a body already carrying the marker is left alone, so the file
--    is re-appliable. No signature changes here, so who may execute and the
--    comment ride along with CREATE OR REPLACE untouched.
-- ===========================================================================

CREATE OR REPLACE FUNCTION pg_temp.lp11_rewrite(p_fn text, p_marker text,
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
-- 5. fn_lightning_config answers the Phase 11 keys, read, clamped and
--    reported in `invalid` exactly as every other key, every one OFF or at a
--    conservative default:
--      lightning_shadow_matcher  boolean, false   (the engine plans a shadow)
--      shadow_matcher_version    text, 'm2'       (the matcher_version rule)
--      shadow_window_ms          300000, 60000..3600000
--      shadow_max_players        500, 2..5000
--      shadow_pass_budget_ms     50, 5..1000
--      integrity_telemetry       boolean, false   (the engine reports timing)
--      quality_weights           six weights in 0..1: next_hand_speed 0.25,
--                                formation_success 0.20, bb_fairness 0.15,
--                                opponent_diversity 0.15,
--                                instance_utilization 0.10, reliability 0.15;
--                                a set that does not sum to one is
--                                normalized (reported), one that sums to zero
--                                falls back to the defaults (reported), an
--                                unknown name is reported and ignored.
--    The answer's one jsonb_build_object already carries 88 of its 100
--    arguments, so the new keys ride in a second object joined onto it.
-- ===========================================================================

SELECT pg_temp.lp11_rewrite(
  'public.fn_lightning_config(uuid)',
  '''quality_weights''',
  ARRAY[$a$  v_ar_cap   numeric;
$a$,
        $a$  v_ar_cap := (r ->> 'value')::numeric; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
$a$,
        $a$    'invalid', v_inv);
$a$],
  ARRAY[$b$  v_ar_cap   numeric;
  v_qw_def   jsonb;
  v_qw       jsonb;
  v_qw_cfg   jsonb;
  v_qw_k     text;
  v_qw_sum   numeric;
  v_sh_on    boolean;
  v_sh_ver   text;
  v_sh_win   integer;
  v_sh_max   integer;
  v_sh_bud   integer;
  v_it_on    boolean;
$b$,
        $b$  v_ar_cap := (r ->> 'value')::numeric; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;

  -- LIGHTNING PHASE 11 (20261008161509): THE SHADOW MATCHER, THE INTEGRITY
  -- TELEMETRY AND THE QUALITY WEIGHTS. All off unless the Cluster turns them
  -- on; the shadow never seats anyone and the telemetry never steers the
  -- matcher.
  v_sh_on := false;
  IF v_cfg ? 'lightning_shadow_matcher' AND jsonb_typeof(v_cfg -> 'lightning_shadow_matcher') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'lightning_shadow_matcher') = 'boolean' THEN
      v_sh_on := (v_cfg ->> 'lightning_shadow_matcher')::boolean;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'lightning_shadow_matcher', 'given', v_cfg -> 'lightning_shadow_matcher',
                                           'reason', 'wrong_type', 'used', v_sh_on);
    END IF;
  END IF;
  v_it_on := false;
  IF v_cfg ? 'integrity_telemetry' AND jsonb_typeof(v_cfg -> 'integrity_telemetry') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'integrity_telemetry') = 'boolean' THEN
      v_it_on := (v_cfg ->> 'integrity_telemetry')::boolean;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'integrity_telemetry', 'given', v_cfg -> 'integrity_telemetry',
                                           'reason', 'wrong_type', 'used', v_it_on);
    END IF;
  END IF;
  v_sh_ver := 'm2';
  IF v_cfg ? 'shadow_matcher_version' AND jsonb_typeof(v_cfg -> 'shadow_matcher_version') <> 'null' THEN
    v_text := CASE WHEN jsonb_typeof(v_cfg -> 'shadow_matcher_version') = 'string' THEN v_cfg ->> 'shadow_matcher_version' END;
    IF v_text IS NOT NULL AND v_text ~ '^[A-Za-z0-9._:-]{1,32}$' THEN
      v_sh_ver := v_text;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'shadow_matcher_version', 'given', v_cfg -> 'shadow_matcher_version',
                                           'reason', 'not_a_version_name', 'used', v_sh_ver);
    END IF;
  END IF;
  r := public.fn_lightning_config_number(v_cfg, 'shadow_window_ms', 300000, 60000, 3600000, true);
  v_sh_win := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'shadow_max_players', 500, 2, 5000, true);
  v_sh_max := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'shadow_pass_budget_ms', 50, 5, 1000, true);
  v_sh_bud := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;

  -- The weights of the internal Lightning Quality Score
  -- (fn_lightning_quality_score), which compares matcher versions in the
  -- shadow ledger and is never shown to a player.
  v_qw_def := jsonb_build_object('next_hand_speed', 0.25, 'formation_success', 0.20,
                                 'bb_fairness', 0.15, 'opponent_diversity', 0.15,
                                 'instance_utilization', 0.10, 'reliability', 0.15);
  v_qw := v_qw_def;
  v_qw_cfg := v_cfg -> 'quality_weights';
  IF v_qw_cfg IS NOT NULL AND jsonb_typeof(v_qw_cfg) <> 'null' THEN
    IF jsonb_typeof(v_qw_cfg) <> 'object' THEN
      v_inv := v_inv || jsonb_build_object('key', 'quality_weights', 'given', v_qw_cfg,
                                           'reason', 'wrong_type', 'used', v_qw_def);
    ELSE
      FOREACH v_qw_k IN ARRAY ARRAY['next_hand_speed', 'formation_success', 'bb_fairness',
                                    'opponent_diversity', 'instance_utilization', 'reliability'] LOOP
        r := public.fn_lightning_config_number(v_qw_cfg, v_qw_k, (v_qw_def ->> v_qw_k)::numeric, 0, 1, false);
        v_qw := v_qw || jsonb_build_object(v_qw_k, (r ->> 'value')::numeric);
        IF r ? 'invalid' THEN
          v_inv := v_inv || jsonb_set(r -> 'invalid', '{key}', to_jsonb('quality_weights.' || v_qw_k));
        END IF;
      END LOOP;
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_qw_cfg) k
                  WHERE k NOT IN ('next_hand_speed', 'formation_success', 'bb_fairness',
                                  'opponent_diversity', 'instance_utilization', 'reliability')) THEN
        v_inv := v_inv || jsonb_build_object('key', 'quality_weights', 'given', v_qw_cfg,
                                             'reason', 'unknown_weight', 'used', v_qw);
      END IF;
      SELECT sum(e.value::numeric) INTO v_qw_sum FROM jsonb_each_text(v_qw) e;
      IF coalesce(v_qw_sum, 0) <= 0 THEN
        v_qw := v_qw_def;
        v_inv := v_inv || jsonb_build_object('key', 'quality_weights', 'given', v_qw_cfg,
                                             'reason', 'weights_sum_to_zero', 'used', v_qw);
      ELSIF abs(v_qw_sum - 1) > 0.000001 THEN
        SELECT jsonb_object_agg(e.key, round(e.value::numeric / v_qw_sum, 6)) INTO v_qw
          FROM jsonb_each_text(v_qw) e;
        v_inv := v_inv || jsonb_build_object('key', 'quality_weights', 'given', v_qw_cfg,
                                             'reason', 'normalized_to_sum_one', 'used', v_qw);
      END IF;
    END IF;
  END IF;
$b$,
        $b$    'invalid', v_inv)
    -- LIGHTNING PHASE 11 (20261008161509): the first object is at 88 of its
    -- 100 arguments, so the Phase 11 keys ride in a second.
    || jsonb_build_object(
    'lightning_shadow_matcher', v_sh_on,
    'shadow_matcher_version', v_sh_ver,
    'shadow_window_ms', v_sh_win,
    'shadow_max_players', v_sh_max,
    'shadow_pass_budget_ms', v_sh_bud,
    'integrity_telemetry', v_it_on,
    'quality_weights', v_qw);
$b$],
  ARRAY[1, 1, 1]);

-- ===========================================================================
-- 6. THE LIGHTNING QUALITY SCORE. fn_lightning_quality_components reads one
--    side of a comparison in the engine's shape and answers six components
--    in 0..1, each NULL when its inputs are absent:
--      next_hand_speed      0.7 * (1 - min(wait_ms.p50, 30000) / 30000)
--                         + 0.3 * (1 - min(wait_ms.p95, 60000) / 60000)
--      formation_success    formation_success_rate
--      bb_fairness          1 - min(bb_fairness.order_violations / bb_fairness.n, 1)
--      opponent_diversity   1 - opponent_diversity.repeat_pair_rate
--      instance_utilization instance_occupancy.utilization
--      reliability          1 - failure_rate
--    every ratio clamped to 0..1. fn_lightning_quality_score is the weighted
--    mean of the present components, 0..100 (an absent component's weight
--    leaves the mean rather than scoring zero), weights from
--    fn_lightning_config quality_weights unless given; a weight that is not a
--    positive number is skipped. Internal; never exposed to players.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_quality_components(p_metrics jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_p50  numeric;
  v_p95  numeric;
  v_n    numeric;
  v_viol numeric;
BEGIN
  IF p_metrics IS NULL OR jsonb_typeof(p_metrics) IS DISTINCT FROM 'object' THEN
    RETURN NULL;
  END IF;
  v_p50 := CASE WHEN jsonb_typeof(p_metrics #> '{wait_ms,p50}') = 'number' THEN (p_metrics #>> '{wait_ms,p50}')::numeric END;
  v_p95 := CASE WHEN jsonb_typeof(p_metrics #> '{wait_ms,p95}') = 'number' THEN (p_metrics #>> '{wait_ms,p95}')::numeric END;
  v_n := CASE WHEN jsonb_typeof(p_metrics #> '{bb_fairness,n}') = 'number' THEN (p_metrics #>> '{bb_fairness,n}')::numeric END;
  v_viol := CASE WHEN jsonb_typeof(p_metrics #> '{bb_fairness,order_violations}') = 'number'
                 THEN (p_metrics #>> '{bb_fairness,order_violations}')::numeric END;
  RETURN jsonb_build_object(
    'next_hand_speed', CASE WHEN v_p50 IS NOT NULL AND v_p95 IS NOT NULL THEN round(
        0.7 * (1 - LEAST(GREATEST(v_p50, 0), 30000) / 30000)
      + 0.3 * (1 - LEAST(GREATEST(v_p95, 0), 60000) / 60000), 6) END,
    'formation_success', CASE WHEN jsonb_typeof(p_metrics -> 'formation_success_rate') = 'number'
      THEN LEAST(GREATEST((p_metrics ->> 'formation_success_rate')::numeric, 0), 1) END,
    'bb_fairness', CASE WHEN v_n > 0 AND v_viol IS NOT NULL
      THEN round(1 - LEAST(GREATEST(v_viol, 0) / v_n, 1), 6) END,
    'opponent_diversity', CASE WHEN jsonb_typeof(p_metrics #> '{opponent_diversity,repeat_pair_rate}') = 'number'
      THEN 1 - LEAST(GREATEST((p_metrics #>> '{opponent_diversity,repeat_pair_rate}')::numeric, 0), 1) END,
    'instance_utilization', CASE WHEN jsonb_typeof(p_metrics #> '{instance_occupancy,utilization}') = 'number'
      THEN LEAST(GREATEST((p_metrics #>> '{instance_occupancy,utilization}')::numeric, 0), 1) END,
    'reliability', CASE WHEN jsonb_typeof(p_metrics -> 'failure_rate') = 'number'
      THEN 1 - LEAST(GREATEST((p_metrics ->> 'failure_rate')::numeric, 0), 1) END);
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_quality_components(jsonb) IS
  'Lightning Phase 11 (20261008161509): the six 0..1 components of the internal Lightning Quality Score, read from one side of a shadow comparison in the engine''s shape (wait_ms, formation_success_rate, bb_fairness, opponent_diversity, instance_occupancy, failure_rate); NULL where the input is absent. service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_quality_components(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_quality_components(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_lightning_quality_score(p_metrics jsonb, p_weights jsonb DEFAULT NULL)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  w      jsonb := coalesce(p_weights, public.fn_lightning_config(NULL) -> 'quality_weights');
  c      jsonb := public.fn_lightning_quality_components(p_metrics);
  e      record;
  v_num  numeric := 0;
  v_den  numeric := 0;
  v_c    numeric;
  v_w    numeric;
BEGIN
  IF c IS NULL OR w IS NULL OR jsonb_typeof(w) IS DISTINCT FROM 'object' THEN
    RETURN NULL;
  END IF;
  FOR e IN SELECT x.key, x.value FROM jsonb_each(w) x LOOP
    CONTINUE WHEN jsonb_typeof(e.value) IS DISTINCT FROM 'number';
    v_w := (e.value #>> '{}')::numeric;
    CONTINUE WHEN v_w <= 0;
    v_c := (c ->> e.key)::numeric;
    CONTINUE WHEN v_c IS NULL;
    v_num := v_num + v_w * v_c;
    v_den := v_den + v_w;
  END LOOP;
  IF v_den = 0 THEN
    RETURN NULL;
  END IF;
  RETURN round(100 * v_num / v_den, 2);
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_quality_score(jsonb, jsonb) IS
  'Lightning Phase 11 (20261008161509): the internal Lightning Quality Score, 0..100 - the weighted mean of the present fn_lightning_quality_components (next_hand_speed, formation_success, bb_fairness, opponent_diversity, instance_utilization, reliability), weights from fn_lightning_config quality_weights unless given. Compares matcher versions; never exposed to players. service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_quality_score(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_quality_score(jsonb, jsonb) TO service_role;

-- ===========================================================================
-- 7. THE SHADOW RECORD: the engine's one write door into the ledger.
--    p_live and p_shadow are the engine's per-side window objects, kept as
--    sent (unknown keys included) after validation:
--      passes (required), quorum_passes, failed_passes, groups, seated
--                                  integers >= 0
--      formation_success_rate, failure_rate
--                                  null or 0..1
--      wait_ms {n, p50, p95, avg}, bb_fairness {n, avg_hands_since_bb,
--      p95_hands_since_bb, max_hands_since_bb, order_violations},
--      position_fairness {btn_n, btn_avg_count_before}, opponent_diversity
--      {pairs, repeat_pairs, repeat_pair_rate}, instance_occupancy
--      {avg_size, utilization}
--                                  objects when present, every member a
--                                  number >= 0 or null; repeat_pair_rate and
--                                  utilization null or 0..1
--    at most 16 KB a side, and no key anywhere may name a card, hole, deck
--    or seed. A NULL p_live_version falls back to p_live.matcher_version and
--    then to the Cluster's configured matcher_version. Idempotent per
--    (Cluster, window, live version, shadow version): the same comparison
--    again answers idempotent; different numbers for a recorded key answer
--    IDEMPOTENCY_CONFLICT and change nothing.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_shadow_record(
  p_cluster_id uuid, p_live_version text, p_shadow_version text,
  p_window_from timestamptz, p_window_to timestamptz, p_live jsonb, p_shadow jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_now      timestamptz := clock_timestamp();
  v_live_v   text;
  v_side     text;
  v_in       jsonb;
  v_bad      jsonb;
  v_k        text;
  v_o        text;
  v_m        record;
  v_weights  jsonb;
  v_live_c   jsonb;
  v_shadow_c jsonb;
  v_live_q   numeric;
  v_shadow_q numeric;
  v_id       bigint;
  v_row      public.lightning_matcher_shadow_comparison;
BEGIN
  IF p_cluster_id IS NULL OR p_shadow_version IS NULL
     OR p_window_from IS NULL OR p_window_to IS NULL OR p_live IS NULL OR p_shadow IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'INVALID_ARGUMENT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cash_games cg WHERE cg.id = p_cluster_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'CLUSTER_NOT_FOUND');
  END IF;
  v_live_v := coalesce(p_live_version,
                       CASE WHEN jsonb_typeof(p_live -> 'matcher_version') = 'string' THEN p_live ->> 'matcher_version' END,
                       public.fn_lightning_config(p_cluster_id) ->> 'matcher_version');
  IF v_live_v !~ '^[A-Za-z0-9._:-]{1,32}$' OR p_shadow_version !~ '^[A-Za-z0-9._:-]{1,32}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'INVALID_VERSION');
  END IF;
  IF v_live_v = p_shadow_version THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'SAME_VERSION');
  END IF;
  IF NOT isfinite(p_window_from) OR NOT isfinite(p_window_to) OR p_window_to <= p_window_from
     OR p_window_to - p_window_from > interval '7 days' OR p_window_to > v_now + interval '5 minutes' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'INVALID_WINDOW');
  END IF;

  FOREACH v_side IN ARRAY ARRAY['live', 'shadow'] LOOP
    v_in := CASE v_side WHEN 'live' THEN p_live ELSE p_shadow END;
    v_bad := '[]'::jsonb;
    IF jsonb_typeof(v_in) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'INVALID_METRICS', 'side', v_side, 'errors',
                                jsonb_build_array(jsonb_build_object('key', NULL, 'reason', 'not_an_object')));
    END IF;
    IF octet_length(v_in::text) > 16384 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'METRICS_TOO_LARGE', 'side', v_side);
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_path_query(v_in, 'strict $.**') q(v)
                CROSS JOIN LATERAL (SELECT jsonb_object_keys(q.v) AS k WHERE jsonb_typeof(q.v) = 'object') kk
               WHERE kk.k ~* '(card|hole|deck|seed)') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'INVALID_METRICS', 'side', v_side, 'errors',
                                jsonb_build_array(jsonb_build_object('key', NULL, 'reason', 'carries_cards')));
    END IF;
    IF NOT (v_in ? 'passes') THEN
      v_bad := v_bad || jsonb_build_object('key', 'passes', 'reason', 'missing');
    END IF;
    FOREACH v_k IN ARRAY ARRAY['passes', 'quorum_passes', 'failed_passes', 'groups', 'seated'] LOOP
      CONTINUE WHEN NOT (v_in ? v_k) OR (v_k <> 'passes' AND jsonb_typeof(v_in -> v_k) = 'null');
      IF jsonb_typeof(v_in -> v_k) IS DISTINCT FROM 'number'
         OR (v_in ->> v_k)::numeric <> trunc((v_in ->> v_k)::numeric)
         OR (v_in ->> v_k)::numeric NOT BETWEEN 0 AND 1000000000 THEN
        v_bad := v_bad || jsonb_build_object('key', v_k, 'reason', 'not_a_count', 'given', v_in -> v_k);
      END IF;
    END LOOP;
    FOREACH v_k IN ARRAY ARRAY['formation_success_rate', 'failure_rate'] LOOP
      CONTINUE WHEN NOT (v_in ? v_k) OR jsonb_typeof(v_in -> v_k) = 'null';
      IF jsonb_typeof(v_in -> v_k) IS DISTINCT FROM 'number'
         OR (v_in ->> v_k)::numeric NOT BETWEEN 0 AND 1 THEN
        v_bad := v_bad || jsonb_build_object('key', v_k, 'reason', 'not_a_rate', 'given', v_in -> v_k);
      END IF;
    END LOOP;
    FOREACH v_o IN ARRAY ARRAY['wait_ms', 'bb_fairness', 'position_fairness', 'opponent_diversity', 'instance_occupancy'] LOOP
      CONTINUE WHEN NOT (v_in ? v_o) OR jsonb_typeof(v_in -> v_o) = 'null';
      IF jsonb_typeof(v_in -> v_o) IS DISTINCT FROM 'object' THEN
        v_bad := v_bad || jsonb_build_object('key', v_o, 'reason', 'not_an_object');
        CONTINUE;
      END IF;
      FOR v_m IN SELECT x.key, x.value FROM jsonb_each(v_in -> v_o) x LOOP
        IF jsonb_typeof(v_m.value) = 'null' THEN
          CONTINUE;
        END IF;
        IF jsonb_typeof(v_m.value) IS DISTINCT FROM 'number' OR (v_m.value #>> '{}')::numeric < 0
           OR ((v_o || '.' || v_m.key) IN ('opponent_diversity.repeat_pair_rate', 'instance_occupancy.utilization')
               AND (v_m.value #>> '{}')::numeric > 1) THEN
          v_bad := v_bad || jsonb_build_object('key', v_o || '.' || v_m.key, 'reason', 'out_of_range', 'given', v_m.value);
        END IF;
      END LOOP;
    END LOOP;
    IF jsonb_array_length(v_bad) > 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'INVALID_METRICS', 'side', v_side, 'errors', v_bad);
    END IF;
  END LOOP;

  v_weights := public.fn_lightning_config(p_cluster_id) -> 'quality_weights';
  v_live_c := public.fn_lightning_quality_components(p_live);
  v_shadow_c := public.fn_lightning_quality_components(p_shadow);
  v_live_q := public.fn_lightning_quality_score(p_live, v_weights);
  v_shadow_q := public.fn_lightning_quality_score(p_shadow, v_weights);

  INSERT INTO public.lightning_matcher_shadow_comparison
    (cluster_id, window_from, window_to, live_matcher_version, shadow_matcher_version,
     live_metrics, shadow_metrics, live_components, shadow_components,
     live_quality_score, shadow_quality_score, quality_weights)
  VALUES (p_cluster_id, p_window_from, p_window_to, v_live_v, p_shadow_version,
          p_live, p_shadow, v_live_c, v_shadow_c, v_live_q, v_shadow_q, v_weights)
  ON CONFLICT (cluster_id, window_from, window_to, live_matcher_version, shadow_matcher_version) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT * INTO v_row FROM public.lightning_matcher_shadow_comparison c
     WHERE c.cluster_id = p_cluster_id AND c.window_from = p_window_from AND c.window_to = p_window_to
       AND c.live_matcher_version = v_live_v AND c.shadow_matcher_version = p_shadow_version;
    IF v_row.live_metrics IS DISTINCT FROM p_live OR v_row.shadow_metrics IS DISTINCT FROM p_shadow THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'IDEMPOTENCY_CONFLICT', 'id', v_row.id);
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'id', v_row.id,
                              'live_matcher_version', v_row.live_matcher_version,
                              'shadow_matcher_version', v_row.shadow_matcher_version,
                              'live_quality_score', v_row.live_quality_score,
                              'shadow_quality_score', v_row.shadow_quality_score,
                              'quality_delta', v_row.shadow_quality_score - v_row.live_quality_score,
                              'components', jsonb_build_object('live', v_row.live_components, 'shadow', v_row.shadow_components),
                              'quality_weights', v_row.quality_weights);
  END IF;

  RETURN jsonb_build_object('ok', true, 'idempotent', false, 'id', v_id,
                            'live_matcher_version', v_live_v, 'shadow_matcher_version', p_shadow_version,
                            'live_quality_score', v_live_q, 'shadow_quality_score', v_shadow_q,
                            'quality_delta', v_shadow_q - v_live_q,
                            'components', jsonb_build_object('live', v_live_c, 'shadow', v_shadow_c),
                            'quality_weights', v_weights);
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_shadow_record(uuid, text, text, timestamptz, timestamptz, jsonb, jsonb) IS
  'Lightning Phase 11 (20261008161509): the engine records one live-versus-shadow matcher comparison for a Cluster and window - both sides'' window objects in the engine''s shape (passes, quorum_passes, formation_success_rate, failed_passes, failure_rate, groups, seated, wait_ms, bb_fairness, position_fairness, opponent_diversity, instance_occupancy, ...), validated and kept, their quality components and both quality scores under the Cluster''s quality_weights. A NULL live version falls back to p_live.matcher_version, then the configured matcher_version. Idempotent per (Cluster, window, versions). The shadow never seats anyone. service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_shadow_record(uuid, text, text, timestamptz, timestamptz, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_shadow_record(uuid, text, text, timestamptz, timestamptz, jsonb, jsonb) TO service_role;

-- ===========================================================================
-- 8. THE SHADOW REPORT: what an operator reads before promoting a matcher.
--    Per (live version, shadow version) over comparisons whose window ends
--    in (from, to] (default the last seven days, at most ninety): the count,
--    the Clusters, both mean quality scores, the mean, smallest and largest
--    delta (shadow minus live), the share of windows the shadow won, each
--    quality component's mean per side and its delta, the mean of the raw
--    signals an operator reads beside them (formation_success_rate,
--    failure_rate, wait_ms p50/p95, BB order violations, the button
--    position's average count before, repeat_pair_rate, utilization), and a
--    verdict that needs thirty comparisons before it says anything but
--    insufficient_evidence, and says shadow_leads only when the shadow
--    scores higher without failing more.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_shadow_report(
  p_cluster_id uuid DEFAULT NULL, p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_to    timestamptz := LEAST(coalesce(p_to, now()), now());
  v_from  timestamptz;
  v_pairs jsonb;
BEGIN
  v_from := GREATEST(coalesce(p_from, v_to - interval '7 days'), v_to - interval '90 days');
  IF v_from >= v_to THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'INVALID_WINDOW');
  END IF;

  WITH c AS (
    SELECT s.*
      FROM public.lightning_matcher_shadow_comparison s
     WHERE s.window_to > v_from AND s.window_to <= v_to
       AND (p_cluster_id IS NULL OR s.cluster_id = p_cluster_id)
  ), v AS (
    SELECT c.live_matcher_version AS lv, c.shadow_matcher_version AS sv, x.metric, x.live_v, x.shadow_v
      FROM c CROSS JOIN LATERAL (VALUES
        ('component.next_hand_speed', (c.live_components ->> 'next_hand_speed')::numeric, (c.shadow_components ->> 'next_hand_speed')::numeric),
        ('component.formation_success', (c.live_components ->> 'formation_success')::numeric, (c.shadow_components ->> 'formation_success')::numeric),
        ('component.bb_fairness', (c.live_components ->> 'bb_fairness')::numeric, (c.shadow_components ->> 'bb_fairness')::numeric),
        ('component.opponent_diversity', (c.live_components ->> 'opponent_diversity')::numeric, (c.shadow_components ->> 'opponent_diversity')::numeric),
        ('component.instance_utilization', (c.live_components ->> 'instance_utilization')::numeric, (c.shadow_components ->> 'instance_utilization')::numeric),
        ('component.reliability', (c.live_components ->> 'reliability')::numeric, (c.shadow_components ->> 'reliability')::numeric),
        ('formation_success_rate', CASE WHEN jsonb_typeof(c.live_metrics -> 'formation_success_rate') = 'number' THEN (c.live_metrics ->> 'formation_success_rate')::numeric END,
                                   CASE WHEN jsonb_typeof(c.shadow_metrics -> 'formation_success_rate') = 'number' THEN (c.shadow_metrics ->> 'formation_success_rate')::numeric END),
        ('failure_rate', CASE WHEN jsonb_typeof(c.live_metrics -> 'failure_rate') = 'number' THEN (c.live_metrics ->> 'failure_rate')::numeric END,
                         CASE WHEN jsonb_typeof(c.shadow_metrics -> 'failure_rate') = 'number' THEN (c.shadow_metrics ->> 'failure_rate')::numeric END),
        ('wait_ms.p50', CASE WHEN jsonb_typeof(c.live_metrics #> '{wait_ms,p50}') = 'number' THEN (c.live_metrics #>> '{wait_ms,p50}')::numeric END,
                        CASE WHEN jsonb_typeof(c.shadow_metrics #> '{wait_ms,p50}') = 'number' THEN (c.shadow_metrics #>> '{wait_ms,p50}')::numeric END),
        ('wait_ms.p95', CASE WHEN jsonb_typeof(c.live_metrics #> '{wait_ms,p95}') = 'number' THEN (c.live_metrics #>> '{wait_ms,p95}')::numeric END,
                        CASE WHEN jsonb_typeof(c.shadow_metrics #> '{wait_ms,p95}') = 'number' THEN (c.shadow_metrics #>> '{wait_ms,p95}')::numeric END),
        ('bb_fairness.order_violations', CASE WHEN jsonb_typeof(c.live_metrics #> '{bb_fairness,order_violations}') = 'number' THEN (c.live_metrics #>> '{bb_fairness,order_violations}')::numeric END,
                                         CASE WHEN jsonb_typeof(c.shadow_metrics #> '{bb_fairness,order_violations}') = 'number' THEN (c.shadow_metrics #>> '{bb_fairness,order_violations}')::numeric END),
        ('position_fairness.btn_avg_count_before', CASE WHEN jsonb_typeof(c.live_metrics #> '{position_fairness,btn_avg_count_before}') = 'number' THEN (c.live_metrics #>> '{position_fairness,btn_avg_count_before}')::numeric END,
                                                   CASE WHEN jsonb_typeof(c.shadow_metrics #> '{position_fairness,btn_avg_count_before}') = 'number' THEN (c.shadow_metrics #>> '{position_fairness,btn_avg_count_before}')::numeric END),
        ('opponent_diversity.repeat_pair_rate', CASE WHEN jsonb_typeof(c.live_metrics #> '{opponent_diversity,repeat_pair_rate}') = 'number' THEN (c.live_metrics #>> '{opponent_diversity,repeat_pair_rate}')::numeric END,
                                                CASE WHEN jsonb_typeof(c.shadow_metrics #> '{opponent_diversity,repeat_pair_rate}') = 'number' THEN (c.shadow_metrics #>> '{opponent_diversity,repeat_pair_rate}')::numeric END),
        ('instance_occupancy.utilization', CASE WHEN jsonb_typeof(c.live_metrics #> '{instance_occupancy,utilization}') = 'number' THEN (c.live_metrics #>> '{instance_occupancy,utilization}')::numeric END,
                                           CASE WHEN jsonb_typeof(c.shadow_metrics #> '{instance_occupancy,utilization}') = 'number' THEN (c.shadow_metrics #>> '{instance_occupancy,utilization}')::numeric END)
      ) x(metric, live_v, shadow_v)
  ), mj AS (
    SELECT v.lv, v.sv, jsonb_object_agg(v.metric, jsonb_build_object(
             'live', round(v.live_v, 4), 'shadow', round(v.shadow_v, 4),
             'delta', round(v.shadow_v - v.live_v, 4))) AS metrics
      FROM (SELECT v.lv, v.sv, v.metric, avg(v.live_v) AS live_v, avg(v.shadow_v) AS shadow_v
              FROM v GROUP BY 1, 2, 3) v
     GROUP BY 1, 2
  ), g AS (
    SELECT c.live_matcher_version AS lv, c.shadow_matcher_version AS sv,
           count(*) AS n,
           count(DISTINCT c.cluster_id) AS clusters,
           min(c.window_from) AS first_from,
           max(c.window_to) AS last_to,
           avg(c.live_quality_score) AS live_q,
           avg(c.shadow_quality_score) AS shadow_q,
           avg(c.shadow_quality_score - c.live_quality_score) AS d_mean,
           min(c.shadow_quality_score - c.live_quality_score) AS d_min,
           max(c.shadow_quality_score - c.live_quality_score) AS d_max,
           avg(CASE WHEN c.shadow_quality_score > c.live_quality_score THEN 1.0 ELSE 0.0 END) AS won,
           coalesce(avg((c.live_components ->> 'reliability')::numeric - (c.shadow_components ->> 'reliability')::numeric), 0) AS d_fail
      FROM c GROUP BY 1, 2
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'live_matcher_version', g.lv,
           'shadow_matcher_version', g.sv,
           'comparisons', g.n,
           'clusters', g.clusters,
           'first_window_from', g.first_from,
           'last_window_to', g.last_to,
           'live_quality_mean', round(g.live_q, 2),
           'shadow_quality_mean', round(g.shadow_q, 2),
           'quality_delta_mean', round(g.d_mean, 2),
           'quality_delta_min', g.d_min,
           'quality_delta_max', g.d_max,
           'shadow_better_share', round(g.won, 4),
           'metrics', mj.metrics,
           'verdict', CASE
             WHEN g.n < 30 THEN 'insufficient_evidence'
             WHEN g.d_mean > 0 AND g.d_fail <= 0 THEN 'shadow_leads'
             WHEN g.d_mean < 0 THEN 'live_leads'
             ELSE 'no_clear_winner' END)
         ORDER BY g.n DESC, g.lv, g.sv), '[]'::jsonb)
    INTO v_pairs
    FROM (SELECT * FROM g ORDER BY g.n DESC, g.lv, g.sv LIMIT 50) g
    JOIN mj ON mj.lv = g.lv AND mj.sv = g.sv;

  RETURN jsonb_build_object('ok', true, 'cluster_id', p_cluster_id, 'from', v_from, 'to', v_to,
                            'version_pairs', v_pairs);
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_shadow_report(uuid, timestamptz, timestamptz) IS
  'Lightning Phase 11 (20261008161509): the operator''s matcher-promotion read over lightning_matcher_shadow_comparison - per (live version, shadow version): comparisons, Clusters, mean quality per side, delta mean/min/max (shadow minus live), shadow_better_share, each quality component and the raw signals per side with deltas, and a verdict (insufficient_evidence under thirty comparisons; shadow_leads only when the shadow scores higher without failing more). service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_shadow_report(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_shadow_report(uuid, timestamptz, timestamptz) TO service_role;

-- ===========================================================================
-- 9. THE SCAN: persisted Lightning data only, bounded, idempotent.
--    Window: [p_from, p_to), default the 24 hours before the current hour
--    boundary (so rescans inside an hour share keys), never past now, at
--    most seven days (clamped, reported). Clusters: p_cluster_id, or every
--    Cluster with a hand formed in the window (at most 50 a call). Per
--    Cluster: the newest 20000 settled hands and the newest 5000 pool
--    sessions entered in the window (budget_hit says when a cap bit).
--    Thresholds are constants, reported in the answer:
--      PAIRING_CONCENTRATION  hands together >= 30 and >= 2x the expected
--                             hands_a * hands_b / hands; score 50 at 2x,
--                             75 at 4x, 100 at 8x.
--      CHIP_FLOW              >= 10 shared hands with opposite results, the
--                             net at least 80% of the gross between them and
--                             one side winning at least 80% of those hands;
--                             score 60 * direction + 0.8 per hand (<= 50).
--                             Also written once per key to
--                             ca_collusion_signals (detail.signal
--                             lightning_chip_flow, user_a the receiver).
--      COORDINATED_JOIN_LEAVE >= 3 sessions of each player that entered and
--                             exited within 10 seconds of a session of the
--                             other, covering half the fewer sessions;
--                             score 40 + 10 per joint session (<= 100).
--      SESSION_LENGTH         the longest session of a player overlapping
--                             the window, >= 12 hours; 50 at 12h, 70 at 18h,
--                             90 from 24h.
--      DEVICE_OVERLAP         >= 5 hands together and a shared user_sessions
--                             ip_address; score 60. Only the count of shared
--                             addresses enters the evidence.
--      ACCOUNT_RELATIONSHIP   >= 5 hands together and one referred the other
--                             (profiles.referred_by); score 50.
--    Severity: high from 70, medium from 40, low below.
--    Evidence carries counts, ratios and chips only, never a card.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_integrity_scan(
  p_cluster_id uuid DEFAULT NULL, p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  c_max_hands      constant integer := 20000;
  c_max_sessions   constant integer := 5000;
  c_max_clusters   constant integer := 50;
  c_max_signals    constant integer := 500;
  c_pair_min_hands constant integer := 30;
  c_pair_min_ratio constant numeric := 2.0;
  c_flow_min_hands constant integer := 10;
  c_flow_min_dir   constant numeric := 0.8;
  c_flow_min_win   constant numeric := 0.8;
  c_join_window_s  constant integer := 10;
  c_join_min       constant integer := 3;
  c_long_hours     constant numeric := 12;
  c_link_min_hands constant integer := 5;
  v_now      timestamptz := clock_timestamp();
  v_to       timestamptz;
  v_from     timestamptz;
  v_clamped  boolean := false;
  v_cluster  uuid;
  v_hands    integer;
  v_sessions integer;
  v_scanned  integer := 0;
  v_hand_sum bigint := 0;
  v_budget   boolean := false;
  v_counts   jsonb := '{}'::jsonb;
  v_part     jsonb;
  v_mirrored integer := 0;
  v_n        integer;
BEGIN
  v_to := LEAST(coalesce(p_to, date_trunc('hour', v_now)), v_now);
  v_from := coalesce(p_from, v_to - interval '24 hours');
  IF v_from >= v_to THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'INVALID_WINDOW', 'window_from', v_from, 'window_to', v_to);
  END IF;
  IF v_to - v_from > interval '7 days' THEN
    v_from := v_to - interval '7 days';
    v_clamped := true;
  END IF;

  FOR v_cluster IN
    SELECT x.cluster_id FROM (
      SELECT p_cluster_id AS cluster_id WHERE p_cluster_id IS NOT NULL
      UNION
      SELECT DISTINCT lh.cluster_id FROM public.lightning_hand lh
       WHERE p_cluster_id IS NULL AND lh.formed_at >= v_from AND lh.formed_at < v_to
    ) x ORDER BY x.cluster_id LIMIT c_max_clusters
  LOOP
    v_scanned := v_scanned + 1;

    SELECT count(*) INTO v_hands FROM (
      SELECT 1 FROM public.lightning_hand lh
       WHERE lh.cluster_id = v_cluster AND lh.formed_at >= v_from AND lh.formed_at < v_to
         AND lh.settled_at IS NOT NULL
       LIMIT c_max_hands + 1) q;
    IF v_hands > c_max_hands THEN v_budget := true; v_hands := c_max_hands; END IF;
    v_hand_sum := v_hand_sum + v_hands;

    -- PAIR SIGNALS: one pass over the shared hands feeds four patterns.
    WITH h AS MATERIALIZED (
      SELECT lh.hand_id FROM public.lightning_hand lh
       WHERE lh.cluster_id = v_cluster AND lh.formed_at >= v_from AND lh.formed_at < v_to
         AND lh.settled_at IS NOT NULL
       ORDER BY lh.formed_at DESC, lh.hand_id
       LIMIT c_max_hands
    ), hp AS MATERIALIZED (
      SELECT p.hand_id, p.player_id, coalesce(p.net_result, 0) AS net
        FROM public.lightning_hand_player p JOIN h ON h.hand_id = p.hand_id
    ), per AS (
      SELECT hp.player_id, count(*) AS hands FROM hp GROUP BY 1
    ), pairs AS MATERIALIZED (
      SELECT a.player_id AS pa, b.player_id AS pb,
             count(*) AS together,
             count(*) FILTER (WHERE sign(a.net) * sign(b.net) < 0) AS opposed,
             count(*) FILTER (WHERE a.net < 0 AND b.net > 0) AS b_won,
             coalesce(sum(LEAST(abs(a.net), abs(b.net))) FILTER (WHERE sign(a.net) * sign(b.net) < 0), 0) AS gross,
             coalesce(sum(CASE WHEN a.net < 0 AND b.net > 0 THEN LEAST(-a.net, b.net)
                               WHEN a.net > 0 AND b.net < 0 THEN -LEAST(a.net, -b.net)
                               ELSE 0 END), 0) AS net_to_b
        FROM hp a JOIN hp b ON b.hand_id = a.hand_id AND b.player_id > a.player_id
       GROUP BY 1, 2
    ), scored AS (
      SELECT pr.*, pa_.hands AS hands_a, pb_.hands AS hands_b,
             (pa_.hands::numeric * pb_.hands::numeric / GREATEST(v_hands, 1)) AS expected
        FROM pairs pr
        JOIN per pa_ ON pa_.player_id = pr.pa
        JOIN per pb_ ON pb_.player_id = pr.pb
    ), cand AS (
      SELECT 'PAIRING_CONCENTRATION'::text AS pattern, s.pa, s.pb,
             LEAST(100, GREATEST(0, round(50 + 25 * log(2, (s.together / GREATEST(s.expected, 0.000001)) / c_pair_min_ratio))))::integer AS score,
             jsonb_build_object('hands_together', s.together, 'hands_a', s.hands_a, 'hands_b', s.hands_b,
                                'hands_in_window', v_hands, 'expected_together', round(s.expected, 2),
                                'concentration_ratio', round(s.together / GREATEST(s.expected, 0.000001), 3),
                                'share_of_fewer', round(s.together::numeric / LEAST(s.hands_a, s.hands_b), 3),
                                'min_hands', c_pair_min_hands, 'min_ratio', c_pair_min_ratio) AS evidence
        FROM scored s
       WHERE s.together >= c_pair_min_hands
         AND s.together >= c_pair_min_ratio * s.expected
      UNION ALL
      SELECT 'CHIP_FLOW', s.pa, s.pb,
             LEAST(100, round(60 * abs(s.net_to_b) / s.gross + 0.8 * LEAST(s.opposed, 50)))::integer,
             jsonb_build_object('hands_together', s.together, 'opposed_hands', s.opposed,
                                'gross_flow', s.gross, 'net_flow', abs(s.net_to_b),
                                'direction_ratio', round(abs(s.net_to_b) / s.gross, 4),
                                'receiver_win_share', round(GREATEST(s.b_won, s.opposed - s.b_won)::numeric / s.opposed, 4),
                                'receiver', CASE WHEN s.net_to_b > 0 THEN s.pb ELSE s.pa END,
                                'sender', CASE WHEN s.net_to_b > 0 THEN s.pa ELSE s.pb END,
                                'min_opposed_hands', c_flow_min_hands, 'min_direction', c_flow_min_dir,
                                'min_win_share', c_flow_min_win)
        FROM scored s
       WHERE s.opposed >= c_flow_min_hands AND s.gross > 0
         AND abs(s.net_to_b) / s.gross >= c_flow_min_dir
         AND GREATEST(s.b_won, s.opposed - s.b_won)::numeric / s.opposed >= c_flow_min_win
      UNION ALL
      SELECT 'DEVICE_OVERLAP', s.pa, s.pb, 60,
             jsonb_build_object('hands_together', s.together, 'shared_ip_addresses', d.n,
                                'source', 'user_sessions', 'min_hands', c_link_min_hands)
        FROM scored s
        CROSS JOIN LATERAL (
          SELECT count(DISTINCT ua.ip_address) AS n
            FROM public.user_sessions ua
            JOIN public.user_sessions ub ON ub.ip_address = ua.ip_address
           WHERE ua.user_id = s.pa AND ub.user_id = s.pb AND ua.ip_address IS NOT NULL) d
       WHERE s.together >= c_link_min_hands AND d.n > 0
      UNION ALL
      SELECT 'ACCOUNT_RELATIONSHIP', s.pa, s.pb, 50,
             jsonb_build_object('hands_together', s.together, 'relationship', 'referral',
                                'referrer', CASE WHEN ra.referred_by = s.pb THEN s.pb ELSE s.pa END,
                                'referred', CASE WHEN ra.referred_by = s.pb THEN s.pa ELSE s.pb END,
                                'source', 'profiles.referred_by', 'min_hands', c_link_min_hands)
        FROM scored s
        LEFT JOIN public.profiles ra ON ra.id = s.pa
        LEFT JOIN public.profiles rb ON rb.id = s.pb
       WHERE s.together >= c_link_min_hands
         AND (ra.referred_by = s.pb OR rb.referred_by = s.pa)
    ), capped AS (
      SELECT cand.*, row_number() OVER (PARTITION BY cand.pattern ORDER BY cand.score DESC, cand.pa, cand.pb) AS rn
        FROM cand
    ), up AS (
      INSERT INTO public.lightning_integrity_signal AS t
        (cluster_id, pattern_type, source, player_a, player_b, window_start, window_end,
         suspicion_score, severity, evidence)
      SELECT v_cluster, k.pattern, 'scan', k.pa, k.pb, v_from, v_to, k.score,
             CASE WHEN k.score >= 70 THEN 'high' WHEN k.score >= 40 THEN 'medium' ELSE 'low' END,
             k.evidence
        FROM capped k WHERE k.rn <= c_max_signals
      ON CONFLICT (cluster_id, pattern_type, window_start, window_end, player_a, player_b)
      DO UPDATE SET suspicion_score = EXCLUDED.suspicion_score, severity = EXCLUDED.severity,
                    evidence = EXCLUDED.evidence, updated_at = now()
       WHERE (t.suspicion_score, t.severity, t.evidence)
             IS DISTINCT FROM (EXCLUDED.suspicion_score, EXCLUDED.severity, EXCLUDED.evidence)
      RETURNING t.pattern_type
    )
    SELECT coalesce(jsonb_object_agg(u.pattern_type, u.n), '{}'::jsonb) INTO v_part
      FROM (SELECT up.pattern_type, count(*) AS n FROM up GROUP BY 1) u;
    SELECT coalesce(jsonb_object_agg(k, coalesce((v_counts ->> k)::integer, 0) + coalesce((v_part ->> k)::integer, 0)), '{}'::jsonb)
      INTO v_counts
      FROM (SELECT jsonb_object_keys(v_counts) UNION SELECT jsonb_object_keys(v_part)) x(k);

    -- POOL SESSION SIGNALS.
    SELECT count(*) INTO v_sessions FROM (
      SELECT 1 FROM public.lightning_pool_session ps
       WHERE ps.cluster_id = v_cluster AND ps.entered_at >= v_from AND ps.entered_at < v_to
       LIMIT c_max_sessions + 1) q;
    IF v_sessions > c_max_sessions THEN v_budget := true; END IF;

    WITH s AS MATERIALIZED (
      SELECT ps.id, ps.player_id, ps.entered_at, ps.exited_at
        FROM public.lightning_pool_session ps
       WHERE ps.cluster_id = v_cluster AND ps.entered_at >= v_from AND ps.entered_at < v_to
       ORDER BY ps.entered_at DESC, ps.id
       LIMIT c_max_sessions
    ), per AS (
      SELECT s.player_id, count(*) AS sessions FROM s GROUP BY 1
    ), joint AS (
      SELECT a.player_id AS pa, b.player_id AS pb,
             count(DISTINCT a.id) AS joint_a, count(DISTINCT b.id) AS joint_b
        FROM s a
        JOIN s b ON b.player_id > a.player_id
                AND b.entered_at BETWEEN a.entered_at - make_interval(secs => c_join_window_s)
                                     AND a.entered_at + make_interval(secs => c_join_window_s)
                AND a.exited_at IS NOT NULL AND b.exited_at IS NOT NULL
                AND b.exited_at BETWEEN a.exited_at - make_interval(secs => c_join_window_s)
                                    AND a.exited_at + make_interval(secs => c_join_window_s)
       GROUP BY 1, 2
    ), cand AS (
      SELECT 'COORDINATED_JOIN_LEAVE'::text AS pattern, j.pa, j.pb,
             LEAST(100, 40 + 10 * LEAST(j.joint_a, j.joint_b))::integer AS score,
             jsonb_build_object('joint_sessions', LEAST(j.joint_a, j.joint_b),
                                'sessions_a', pa_.sessions, 'sessions_b', pb_.sessions,
                                'within_seconds', c_join_window_s, 'min_joint', c_join_min) AS evidence
        FROM joint j
        JOIN per pa_ ON pa_.player_id = j.pa
        JOIN per pb_ ON pb_.player_id = j.pb
       WHERE LEAST(j.joint_a, j.joint_b) >= c_join_min
         AND LEAST(j.joint_a, j.joint_b)::numeric / LEAST(pa_.sessions, pb_.sessions) >= 0.5
      UNION ALL
      SELECT 'SESSION_LENGTH', l.player_id, NULL::uuid,
             LEAST(90, round(50 + (l.hours - c_long_hours) * 10 / 3))::integer,
             jsonb_build_object('longest_session_hours', round(l.hours, 2), 'pool_session_id', l.id,
                                'still_open', l.open, 'min_hours', c_long_hours)
        FROM (
          SELECT DISTINCT ON (ps.player_id) ps.player_id, ps.id, ps.exited_at IS NULL AS open,
                 extract(epoch FROM (coalesce(ps.exited_at, v_to) - ps.entered_at)) / 3600 AS hours
            FROM public.lightning_pool_session ps
           WHERE ps.cluster_id = v_cluster
             AND ps.entered_at >= v_from - interval '7 days' AND ps.entered_at < v_to
             AND (ps.exited_at IS NULL OR ps.exited_at > v_from)
           ORDER BY ps.player_id, coalesce(ps.exited_at, v_to) - ps.entered_at DESC, ps.id
        ) l
       WHERE l.hours >= c_long_hours
    ), capped AS (
      SELECT cand.*, row_number() OVER (PARTITION BY cand.pattern ORDER BY cand.score DESC, cand.pa, cand.pb) AS rn
        FROM cand
    ), up AS (
      INSERT INTO public.lightning_integrity_signal AS t
        (cluster_id, pattern_type, source, player_a, player_b, window_start, window_end,
         suspicion_score, severity, evidence)
      SELECT v_cluster, k.pattern, 'scan', k.pa, k.pb, v_from, v_to, k.score,
             CASE WHEN k.score >= 70 THEN 'high' WHEN k.score >= 40 THEN 'medium' ELSE 'low' END,
             k.evidence
        FROM capped k WHERE k.rn <= c_max_signals
      ON CONFLICT (cluster_id, pattern_type, window_start, window_end, player_a, player_b)
      DO UPDATE SET suspicion_score = EXCLUDED.suspicion_score, severity = EXCLUDED.severity,
                    evidence = EXCLUDED.evidence, updated_at = now()
       WHERE (t.suspicion_score, t.severity, t.evidence)
             IS DISTINCT FROM (EXCLUDED.suspicion_score, EXCLUDED.severity, EXCLUDED.evidence)
      RETURNING t.pattern_type
    )
    SELECT coalesce(jsonb_object_agg(u.pattern_type, u.n), '{}'::jsonb) INTO v_part
      FROM (SELECT up.pattern_type, count(*) AS n FROM up GROUP BY 1) u;
    SELECT coalesce(jsonb_object_agg(k, coalesce((v_counts ->> k)::integer, 0) + coalesce((v_part ->> k)::integer, 0)), '{}'::jsonb)
      INTO v_counts
      FROM (SELECT jsonb_object_keys(v_counts) UNION SELECT jsonb_object_keys(v_part)) x(k);

    -- THE EXISTING PAIR STORE: each CHIP_FLOW finding once, in the duel
    -- scan's convention, so it reaches the operator queue and case evidence.
    INSERT INTO public.ca_collusion_signals
      (window_days, user_a, user_b, hands_together, gross_flow, net_flow, direction_ratio, both_cert, detail)
    SELECT GREATEST(1, ceil(extract(epoch FROM (v_to - v_from)) / 86400))::integer,
           (t.evidence ->> 'receiver')::uuid, (t.evidence ->> 'sender')::uuid,
           (t.evidence ->> 'hands_together')::integer,
           (t.evidence ->> 'gross_flow')::numeric, (t.evidence ->> 'net_flow')::numeric,
           (t.evidence ->> 'direction_ratio')::numeric,
           public.fn_ca_is_cert_account((t.evidence ->> 'receiver')::uuid)
             AND public.fn_ca_is_cert_account((t.evidence ->> 'sender')::uuid),
           jsonb_build_object(
             'signal', 'lightning_chip_flow',
             'since', v_from,
             'until', v_to,
             'cluster_id', v_cluster,
             'lightning_signal_id', t.id,
             'lightning_key', v_cluster::text || ':' || to_char(v_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
                              || ':' || to_char(v_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
                              || ':' || t.player_a::text || ':' || t.player_b::text,
             'opposed_hands', (t.evidence ->> 'opposed_hands')::integer,
             'note', 'Lightning: hands_together is Lightning hands both played; gross_flow and net_flow '
                     || 'are chips between the pair over the hands they finished with opposite results; '
                     || 'direction_ratio is net over gross. Telemetry only - no automatic action taken')
      FROM public.lightning_integrity_signal t
     WHERE t.cluster_id = v_cluster AND t.pattern_type = 'CHIP_FLOW'
       AND t.window_start = v_from AND t.window_end = v_to
       AND NOT EXISTS (
         SELECT 1 FROM public.ca_collusion_signals x
          WHERE LEAST(x.user_a, x.user_b) = t.player_a AND GREATEST(x.user_a, x.user_b) = t.player_b
            AND x.detail ->> 'signal' = 'lightning_chip_flow'
            AND x.detail ->> 'lightning_key' = v_cluster::text || ':' || to_char(v_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
                              || ':' || to_char(v_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
                              || ':' || t.player_a::text || ':' || t.player_b::text);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_mirrored := v_mirrored + v_n;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'window_from', v_from,
    'window_to', v_to,
    'window_clamped', v_clamped,
    'clusters_scanned', v_scanned,
    'hands_scanned', v_hand_sum,
    'budget_hit', v_budget,
    'written', v_counts,
    'chip_flow_mirrored', v_mirrored,
    'engine_reported', jsonb_build_array('DECISION_LATENCY', 'TIMING_CORRELATION'),
    'thresholds', jsonb_build_object(
      'pair_min_hands', c_pair_min_hands, 'pair_min_ratio', c_pair_min_ratio,
      'flow_min_opposed_hands', c_flow_min_hands, 'flow_min_direction', c_flow_min_dir,
      'flow_min_win_share', c_flow_min_win, 'join_window_seconds', c_join_window_s,
      'join_min_sessions', c_join_min, 'long_session_hours', c_long_hours,
      'link_min_hands', c_link_min_hands, 'max_hands', c_max_hands,
      'max_sessions', c_max_sessions, 'max_clusters', c_max_clusters));
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_integrity_scan(uuid, timestamptz, timestamptz) IS
  'Lightning Phase 11 (20261008161509): the integrity scanner over persisted Lightning data (hands, participants, pool sessions, and the platform''s existing user_sessions and profiles.referred_by): PAIRING_CONCENTRATION, CHIP_FLOW, COORDINATED_JOIN_LEAVE, SESSION_LENGTH, DEVICE_OVERLAP and ACCOUNT_RELATIONSHIP into lightning_integrity_signal, idempotently per (Cluster, pattern, window, subject); CHIP_FLOW also once into ca_collusion_signals (detail.signal lightning_chip_flow). Bounded (20000 hands and 5000 sessions per Cluster, 50 Clusters, 7-day window). On demand, not in the tick. Telemetry only: no seating path reads it. Horses are scanned exactly as humans. service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_integrity_scan(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_integrity_scan(uuid, timestamptz, timestamptz) TO service_role;

-- ===========================================================================
-- 10. THE ENGINE'S INGEST DOOR for what only the engine can measure. The
--     engine sends its window aggregates; THE DATABASE decides what is
--     abnormal and writes only those, so a quiet window writes nothing.
--     p_signals, the engine's object:
--       { window_from, window_to            timestamptz (required; from <
--                                           to, at most seven days, to at
--                                           most five minutes past p_now)
--         hands, decisions, fast_ms, dropped_players, dropped_pairs
--                                           numbers >= 0, kept as context
--         players: [ { player_id, decisions, timeouts, p50_ms, p95_ms,
--                      mean_ms, stddev_ms, cv, fast_share } ]   (<= 500 read)
--         pairs:   [ { player_a, player_b, hands_together,
--                      sequential_actions, fast_follows, latency_corr } ]
--                                                               (<= 200 read)
--       }
--     Per entry: player ids must be uuids holding a Lightning pool session
--     in the Cluster, every other member a number (or null); counts and
--     milliseconds are clamped to 0..1000000000, fast_share to 0..1,
--     latency_corr to -1..1, cv to 0..1000 (each clamp reported). A bad
--     entry is refused alone with its list, index and reason. Any key at any
--     depth naming a card, hole, deck or seed refuses the whole call.
--     Flagged (thresholds are constants, reported in the answer):
--       DECISION_LATENCY    decisions >= 50 and (cv <= 0.15 or
--                           fast_share >= 0.6): score
--                           max(50 + 40 * (0.15 - cv) / 0.15 when cv is low,
--                               40 + 50 * fast_share when fast_share is high)
--       TIMING_CORRELATION  hands_together >= 20, sequential_actions >= 30
--                           and (latency_corr >= 0.7 or fast_follows /
--                           sequential_actions >= 0.5): score
--                           40 + 50 * max(latency_corr, follow share)
--     Severity high from 70, medium from 40. Idempotent per (Cluster, type,
--     window, subject): the same report again changes nothing, new numbers
--     update the row, a status an operator set is never touched.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_integrity_report(
  p_cluster_id uuid, p_signals jsonb, p_now timestamptz DEFAULT clock_timestamp())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  c_max_players   constant integer := 500;
  c_max_pairs     constant integer := 200;
  c_lat_min_dec   constant integer := 50;
  c_lat_max_cv    constant numeric := 0.15;
  c_lat_min_fast  constant numeric := 0.6;
  c_tc_min_hands  constant integer := 20;
  c_tc_min_seq    constant integer := 30;
  c_tc_min_corr   constant numeric := 0.7;
  c_tc_min_follow constant numeric := 0.5;
  v_now      timestamptz := LEAST(coalesce(p_now, clock_timestamp()), clock_timestamp());
  v_from     timestamptz;
  v_to       timestamptz;
  v_ctx      jsonb := '{}'::jsonb;
  v_list     text;
  v_arr      jsonb;
  v_n        integer;
  v_read     jsonb := '{}'::jsonb;
  v_trunc    jsonb := '{}'::jsonb;
  e          jsonb;
  i          integer;
  v_k        text;
  v_v        numeric;
  v_c        numeric;
  v_lo       numeric;
  v_hi       numeric;
  v_ok       boolean;
  v_num      jsonb;
  v_p        uuid;
  v_o        uuid;
  v_type     text;
  v_score    integer;
  v_follow   numeric;
  v_rejected jsonb := '[]'::jsonb;
  v_clamped  jsonb := '[]'::jsonb;
  v_flagged  jsonb := jsonb_build_object('DECISION_LATENCY', 0, 'TIMING_CORRELATION', 0);
  v_ins      integer := 0;
  v_upd      integer := 0;
  v_same     integer := 0;
  v_new      boolean;
  v_id       bigint;
BEGIN
  IF p_cluster_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.cash_games cg WHERE cg.id = p_cluster_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'CLUSTER_NOT_FOUND');
  END IF;
  IF p_signals IS NULL OR jsonb_typeof(p_signals) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'INVALID_SIGNALS');
  END IF;
  IF octet_length(p_signals::text) > 1048576 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'SIGNALS_TOO_LARGE');
  END IF;
  -- NO HIDDEN INFORMATION: a card, hole, deck or seed key anywhere refuses
  -- the whole report rather than being trimmed.
  IF EXISTS (SELECT 1 FROM jsonb_path_query(p_signals, 'strict $.**') q(v)
              CROSS JOIN LATERAL (SELECT jsonb_object_keys(q.v) AS k WHERE jsonb_typeof(q.v) = 'object') kk
             WHERE kk.k ~* '(card|hole|deck|seed)') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'evidence_carries_cards');
  END IF;
  IF jsonb_typeof(p_signals -> 'window_from') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_signals -> 'window_to') IS DISTINCT FROM 'string'
     OR NOT pg_input_is_valid(p_signals ->> 'window_from', 'timestamptz')
     OR NOT pg_input_is_valid(p_signals ->> 'window_to', 'timestamptz') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'INVALID_WINDOW');
  END IF;
  v_from := (p_signals ->> 'window_from')::timestamptz;
  v_to := (p_signals ->> 'window_to')::timestamptz;
  IF NOT isfinite(v_from) OR NOT isfinite(v_to) OR v_from >= v_to
     OR v_to - v_from > interval '7 days' OR v_to > v_now + interval '5 minutes' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'INVALID_WINDOW');
  END IF;
  FOREACH v_k IN ARRAY ARRAY['hands', 'decisions', 'fast_ms', 'dropped_players', 'dropped_pairs'] LOOP
    IF jsonb_typeof(p_signals -> v_k) = 'number' AND (p_signals ->> v_k)::numeric >= 0 THEN
      v_ctx := v_ctx || jsonb_build_object('window_' || v_k, LEAST((p_signals ->> v_k)::numeric, 1000000000));
    END IF;
  END LOOP;

  FOREACH v_list IN ARRAY ARRAY['players', 'pairs'] LOOP
    v_arr := p_signals -> v_list;
    IF v_arr IS NULL OR jsonb_typeof(v_arr) = 'null' THEN
      v_arr := '[]'::jsonb;
    ELSIF jsonb_typeof(v_arr) <> 'array' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'INVALID_SIGNALS', 'list', v_list);
    END IF;
    v_n := LEAST(jsonb_array_length(v_arr), CASE v_list WHEN 'players' THEN c_max_players ELSE c_max_pairs END);
    v_read := v_read || jsonb_build_object(v_list, v_n);
    v_trunc := v_trunc || jsonb_build_object(v_list, jsonb_array_length(v_arr) - v_n);

    FOR i IN 0 .. v_n - 1 LOOP
      e := v_arr -> i;
      IF jsonb_typeof(e) IS DISTINCT FROM 'object' THEN
        v_rejected := v_rejected || jsonb_build_object('list', v_list, 'index', i, 'reason', 'not_an_object');
        CONTINUE;
      END IF;
      -- THE SUBJECT.
      IF v_list = 'players' THEN
        v_ok := jsonb_typeof(e -> 'player_id') = 'string' AND pg_input_is_valid(e ->> 'player_id', 'uuid');
        v_p := CASE WHEN v_ok THEN (e ->> 'player_id')::uuid END;
        v_o := NULL;
      ELSE
        v_ok := jsonb_typeof(e -> 'player_a') = 'string' AND pg_input_is_valid(e ->> 'player_a', 'uuid')
            AND jsonb_typeof(e -> 'player_b') = 'string' AND pg_input_is_valid(e ->> 'player_b', 'uuid');
        IF v_ok THEN
          v_p := LEAST((e ->> 'player_a')::uuid, (e ->> 'player_b')::uuid);
          v_o := GREATEST((e ->> 'player_a')::uuid, (e ->> 'player_b')::uuid);
          v_ok := v_p <> v_o;
        END IF;
      END IF;
      IF NOT v_ok THEN
        v_rejected := v_rejected || jsonb_build_object('list', v_list, 'index', i, 'reason', 'invalid_player');
        CONTINUE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = p_cluster_id AND ps.player_id = v_p)
         OR (v_o IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.lightning_pool_session ps
                                              WHERE ps.cluster_id = p_cluster_id AND ps.player_id = v_o)) THEN
        v_rejected := v_rejected || jsonb_build_object('list', v_list, 'index', i, 'reason', 'unknown_player');
        CONTINUE;
      END IF;
      -- THE NUMBERS: only the named members are read, each a number or null,
      -- clamped to its range.
      v_num := '{}'::jsonb;
      v_ok := true;
      FOREACH v_k IN ARRAY CASE v_list
          WHEN 'players' THEN ARRAY['decisions', 'timeouts', 'p50_ms', 'p95_ms', 'mean_ms', 'stddev_ms', 'cv', 'fast_share']
          ELSE ARRAY['hands_together', 'sequential_actions', 'fast_follows', 'latency_corr'] END LOOP
        CONTINUE WHEN NOT (e ? v_k) OR jsonb_typeof(e -> v_k) = 'null';
        IF jsonb_typeof(e -> v_k) <> 'number' THEN
          v_rejected := v_rejected || jsonb_build_object('list', v_list, 'index', i, 'reason', 'not_a_number', 'key', v_k);
          v_ok := false;
          EXIT;
        END IF;
        v_v := (e ->> v_k)::numeric;
        v_lo := CASE v_k WHEN 'latency_corr' THEN -1 ELSE 0 END;
        v_hi := CASE v_k WHEN 'latency_corr' THEN 1 WHEN 'fast_share' THEN 1 WHEN 'cv' THEN 1000 ELSE 1000000000 END;
        v_c := LEAST(GREATEST(v_v, v_lo), v_hi);
        IF v_c <> v_v THEN
          v_clamped := v_clamped || jsonb_build_object('list', v_list, 'index', i, 'key', v_k, 'given', e -> v_k, 'used', v_c);
        END IF;
        v_num := v_num || jsonb_build_object(v_k, v_c);
      END LOOP;
      CONTINUE WHEN NOT v_ok;

      -- THE DECISION: abnormal or not.
      v_type := NULL;
      IF v_list = 'players' THEN
        IF coalesce((v_num ->> 'decisions')::numeric, 0) >= c_lat_min_dec
           AND ((v_num ->> 'cv')::numeric <= c_lat_max_cv OR (v_num ->> 'fast_share')::numeric >= c_lat_min_fast) THEN
          v_type := 'DECISION_LATENCY';
          v_score := LEAST(100, GREATEST(
            CASE WHEN (v_num ->> 'cv')::numeric <= c_lat_max_cv
                 THEN round(50 + 40 * (c_lat_max_cv - (v_num ->> 'cv')::numeric) / c_lat_max_cv) END,
            CASE WHEN (v_num ->> 'fast_share')::numeric >= c_lat_min_fast
                 THEN round(40 + 50 * (v_num ->> 'fast_share')::numeric) END))::integer;
        END IF;
      ELSE
        v_follow := CASE WHEN coalesce((v_num ->> 'sequential_actions')::numeric, 0) > 0
                         THEN LEAST(coalesce((v_num ->> 'fast_follows')::numeric, 0) / (v_num ->> 'sequential_actions')::numeric, 1) END;
        IF coalesce((v_num ->> 'hands_together')::numeric, 0) >= c_tc_min_hands
           AND coalesce((v_num ->> 'sequential_actions')::numeric, 0) >= c_tc_min_seq
           AND ((v_num ->> 'latency_corr')::numeric >= c_tc_min_corr OR v_follow >= c_tc_min_follow) THEN
          v_type := 'TIMING_CORRELATION';
          v_score := LEAST(100, round(40 + 50 * GREATEST(coalesce((v_num ->> 'latency_corr')::numeric, 0),
                                                          coalesce(v_follow, 0))))::integer;
          v_num := v_num || jsonb_build_object('follow_share', round(v_follow, 4),
                                               'reported_player_a', e -> 'player_a', 'reported_player_b', e -> 'player_b');
        END IF;
      END IF;
      CONTINUE WHEN v_type IS NULL;
      v_flagged := jsonb_set(v_flagged, ARRAY[v_type], to_jsonb((v_flagged ->> v_type)::integer + 1));

      v_id := NULL;
      INSERT INTO public.lightning_integrity_signal AS t
        (cluster_id, pattern_type, source, player_a, player_b, window_start, window_end,
         suspicion_score, severity, evidence)
      VALUES (p_cluster_id, v_type, 'engine', v_p, v_o, v_from, v_to, v_score,
              CASE WHEN v_score >= 70 THEN 'high' WHEN v_score >= 40 THEN 'medium' ELSE 'low' END,
              v_num || v_ctx || jsonb_build_object('source', 'engine'))
      ON CONFLICT (cluster_id, pattern_type, window_start, window_end, player_a, player_b)
      DO UPDATE SET suspicion_score = EXCLUDED.suspicion_score, severity = EXCLUDED.severity,
                    evidence = EXCLUDED.evidence, updated_at = now()
       WHERE (t.suspicion_score, t.severity, t.evidence)
             IS DISTINCT FROM (EXCLUDED.suspicion_score, EXCLUDED.severity, EXCLUDED.evidence)
      RETURNING t.id, (t.xmax = 0) INTO v_id, v_new;
      IF v_id IS NULL THEN
        v_same := v_same + 1;
      ELSIF v_new THEN
        v_ins := v_ins + 1;
      ELSE
        v_upd := v_upd + 1;
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('ok', true,
                            'window_from', v_from, 'window_to', v_to,
                            'players_read', v_read -> 'players', 'pairs_read', v_read -> 'pairs',
                            'flagged', v_flagged,
                            'inserted', v_ins, 'updated', v_upd, 'unchanged', v_same,
                            'rejected', v_rejected,
                            'clamped', v_clamped,
                            'truncated', v_trunc,
                            'thresholds', jsonb_build_object(
                              'latency_min_decisions', c_lat_min_dec, 'latency_max_cv', c_lat_max_cv,
                              'latency_min_fast_share', c_lat_min_fast, 'timing_min_hands', c_tc_min_hands,
                              'timing_min_sequential', c_tc_min_seq, 'timing_min_corr', c_tc_min_corr,
                              'timing_min_follow_share', c_tc_min_follow));
END
$fn$;

COMMENT ON FUNCTION public.fn_lightning_integrity_report(uuid, jsonb, timestamptz) IS
  'Lightning Phase 11 (20261008161509): the engine reports its decision-timing aggregates for a window ({window_from, window_to, hands, decisions, fast_ms, dropped_players, dropped_pairs, players[<=500]{player_id, decisions, timeouts, p50_ms, p95_ms, mean_ms, stddev_ms, cv, fast_share}, pairs[<=200]{player_a, player_b, hands_together, sequential_actions, fast_follows, latency_corr}}); the database validates and clamps them and writes only the abnormal ones into lightning_integrity_signal (DECISION_LATENCY, TIMING_CORRELATION), idempotently per (Cluster, type, window, subject). Any card/hole/deck/seed key refuses the call. Telemetry only: no seating path reads it. service_role only.';

REVOKE ALL ON FUNCTION public.fn_lightning_integrity_report(uuid, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_integrity_report(uuid, jsonb, timestamptz) TO service_role;

-- ===========================================================================
-- 11. READ BACK.
-- ===========================================================================

DO $readback$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(q.what, '; ') INTO v_bad FROM (VALUES
    ('the signal store is closed to players', (SELECT c.relrowsecurity
       AND NOT has_table_privilege('anon', c.oid, 'SELECT') AND NOT has_table_privilege('authenticated', c.oid, 'SELECT')
       FROM pg_class c WHERE c.oid = 'public.lightning_integrity_signal'::regclass)),
    ('the shadow ledger is closed to players', (SELECT c.relrowsecurity
       AND NOT has_table_privilege('anon', c.oid, 'SELECT') AND NOT has_table_privilege('authenticated', c.oid, 'SELECT')
       FROM pg_class c WHERE c.oid = 'public.lightning_matcher_shadow_comparison'::regclass)),
    ('every new door is the service''s alone', (SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
       AND count(*) = 6
       FROM pg_proc p WHERE p.oid IN (
         'public.fn_lightning_quality_components(jsonb)'::regprocedure,
         'public.fn_lightning_integrity_scan(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure,
         'public.fn_lightning_integrity_report(uuid,jsonb,timestamp with time zone)'::regprocedure,
         'public.fn_lightning_quality_score(jsonb,jsonb)'::regprocedure,
         'public.fn_lightning_shadow_record(uuid,text,text,timestamp with time zone,timestamp with time zone,jsonb,jsonb)'::regprocedure,
         'public.fn_lightning_shadow_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))),
    ('the configuration answers the quality weights', (SELECT (public.fn_lightning_config(NULL) -> 'quality_weights') ? 'reliability')),
    ('the score spans 0 to 100', (SELECT public.fn_lightning_quality_score('{"passes":10,"formation_success_rate":1,"failure_rate":0,"wait_ms":{"n":5,"p50":0,"p95":0},"bb_fairness":{"n":5,"order_violations":0},"opponent_diversity":{"repeat_pair_rate":0},"instance_occupancy":{"utilization":1}}'::jsonb) = 100)),
    ('no seating path reads a signal, the ledger or the score', (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f'
         AND (p.proname LIKE 'fn\_lightning\_%' OR p.proname LIKE 'fn\_cash\_cluster%')
         AND p.proname NOT IN ('fn_lightning_integrity_scan', 'fn_lightning_integrity_report', 'fn_lightning_quality_score',
                               'fn_lightning_quality_components', 'fn_lightning_shadow_record', 'fn_lightning_shadow_report',
                               'fn_lightning_config')
         AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g')
             ~ 'lightning_integrity_signal|lightning_matcher_shadow_comparison|ca_collusion_signals|quality_score|quality_weights'))),
    ('no horse is singled out', (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f'
         AND p.proname IN ('fn_lightning_integrity_scan', 'fn_lightning_integrity_report', 'fn_lightning_quality_score',
                           'fn_lightning_quality_components', 'fn_lightning_shadow_record', 'fn_lightning_shadow_report',
                           'fn_lightning_config')
         AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id')))
  ) q(what, ok) WHERE q.ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIGHTNING_P11_INTEGRITY_SHADOW_READBACK: the catalogue does not carry: %', v_bad;
  END IF;
END
$readback$;

COMMIT;
