-- 20261009181945_lightning_phase_11_remediation_integrity_signals_are_fair_an.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- LIGHTNING PHASE 11 REMEDIATION (THE DATABASE HALF): INTEGRITY SIGNALS ARE
-- FAIR, A FINDING IS ONE ROW THAT EXTENDS, AND THE SHADOW IS SCORED LIKE FOR
-- LIKE. It closes the database findings of the verified Phase 11 adversarial
-- review (2026-10-09): 1, 2, 3 (database part), 5, 6, 7 (database part), 10
-- and 12. Every body changed here was read with pg_get_functiondef from
-- PokerIQ-Production on 2026-10-09 after 20261009143757, 20261009144343 and
-- 20261009151825 were applied, and is changed by an asserted substitution
-- into exactly that text.
--
-- WHAT WAS WRONG, AND WHAT CHANGES (fn_lightning_integrity_scan unless named):
--
--   1. COORDINATED_JOIN_LEAVE flagged every pair present through three
--      Lightning on/off cycles, because the conversion opens every pool
--      session in one statement and the reversion (lightning_off) and the
--      unfreeze (cluster_unfrozen) close them all at once. Now only
--      PLAYER-INITIATED entries and exits are compared: an entry within ten
--      seconds (the pattern's own window) of any epoch start of the Cluster
--      (cash_cluster_epoch.started_at) is the system's, and only an exit
--      whose reason is stop_playing or anchor_seat_left (the player's own
--      Stop Playing, or the player standing up from the anchor seat) is the
--      player's. Every other exit reason (lightning_off, cluster_unfrozen,
--      rg_limit, disconnect_expired and any future one) is decided by the
--      system and its timing says nothing about two players; a server-wide
--      outage expiring every disconnected player at once is exactly such a
--      correlated system exit.
--   2. PAIRING_CONCENTRATION compared hands together with hands_a * hands_b /
--      hands over the whole window, so in a pool where players come and go
--      nearly every pair that shared a session was "concentrated". The
--      expectation is now the CO-PRESENCE expectation: for every hand of A
--      formed while B was in the pool, the chance a random seating puts B in
--      it, (players in the hand - 1) / (players in the pool - 1), summed, and
--      averaged with the same sum from B's side. The pool's size at each hand
--      comes from one ordered sweep over the pool sessions (entries add,
--      exits subtract), so it costs a sort, not a join per hand. A pair whose
--      presence is not on record falls back to the old expectation
--      (evidence.expectation says which). Thresholds unchanged (30 together,
--      twice the expectation).
--   5. CHIP_FLOW flagged about 4% of no-edge pairs at 10 opposed hands. Now:
--      at least 30 opposed hands, a binomial significance test on the
--      receiver's wins (z = (wins - n/2) / sqrt(n/4) >= 4.0, two-sided p
--      about 6e-5), and a gross flow of at least 50 big blinds of the Cluster
--      (cash_games.bb), on top of the old direction >= 0.8 and win share >=
--      0.8. Evidence gains win_z and gross_bb.
--   6. Findings were keyed to the exact window, so the sweep's rolling hourly
--      scan wrote a new row per pair per hour, re-mirrored CHIP_FLOW into
--      ca_collusion_signals every hour, and an operator's 'cleared' did not
--      carry. Now ONE FINDING PER (Cluster, pattern, subject) EXTENDS: a
--      candidate whose window meets the newest finding of the same subject
--      (window_end >= from and window_start <= to) extends that row's window
--      (window_start = least, window_end = greatest), keeps its peak score
--      (suspicion_score = greatest, severity from it), takes the latest
--      evidence (plus latest_score, latest_window_start, latest_window_end)
--      and NEVER touches status, reviewed_by, reviewed_at or notes, so the
--      operator's review carries forward. Only a subject seen again after a
--      gap longer than a window opens a new finding. A rescan of the same
--      window still changes nothing. The mirror into ca_collusion_signals is
--      once per FINDING (detail.lightning_signal_id), guarded by a new unique
--      index ca_collusion_signals_one_per_lightning_finding and ON CONFLICT
--      DO NOTHING; detail.lightning_key is now <cluster>:<a>:<b>:<signal id>
--      and since/until are the finding's window. Overlapping runs cannot
--      double-insert: every scan of a Cluster and every engine report for it
--      takes pg_advisory_xact_lock(hashtext('lightning-integrity:' ||
--      cluster)) first (a scan of many Clusters takes them in cluster_id
--      order, so two scans cannot deadlock). SESSION_LENGTH reads at most
--      5000 qualifying sessions (newest first). fn_lightning_alert_sweep now
--      passes a TUMBLING window: the previous full UTC day, once per UTC day
--      per Cluster (was the scan's rolling default, hourly).
--      fn_lightning_operator_cluster lists a finding whose window reaches
--      into the view (window_end >= from), not only one first detected in it.
--   7. Engine-reported DECISION_LATENCY and TIMING_CORRELATION never fired at
--      the default 5-minute window (a pair shares one or two hands per window
--      at 25 to 50 players). fn_lightning_integrity_report now KEEPS every
--      window's per-player and per-pair evidence in a new store,
--      lightning_integrity_engine_window (one row per Cluster, subject and
--      window; RLS on, no privilege for any role; kept 48 hours, pruned by
--      the report itself, at most 5000 rows a call), and decides over the
--      ROLLING 24 HOURS of stored evidence of every subject in the report:
--      decisions, timeouts, hands together, sequential actions and fast
--      follows are summed; fast_share, p50 and p95 are decision-weighted;
--      cv is the pooled cv from mean_ms and stddev_ms (decision-weighted
--      first and second moments), or the decision-weighted cv when the
--      engine sent no mean and stddev; latency_corr is weighted by
--      sequential actions. The thresholds are unchanged. The finding extends
--      exactly as in 6, its window being the evidence's span.
--  12. SESSION_LENGTH scored every 12 h+ session up to 90 (high), and horses
--      run long sessions (Law 10.5: they are never excluded). It is capped at
--      69 (medium), so the Phase 12 integrity-spike alert (high-severity
--      signals) is never driven by it.
--   3. fn_lightning_shadow_record scored each side over the components that
--      side had, so a component null on one side only (shadow bb_fairness n =
--      0) reweighted the two scores over different sets. Now a component
--      null on EITHER side is null on BOTH before scoring (the stored
--      live_components and shadow_components are the aligned ones), and the
--      two scores are the same weighted mean fn_lightning_quality_score
--      computes, over exactly the shared components. A/A calibration is
--      recorded: live 'm1' against shadow 'm1-port' (the engine's TypeScript
--      port registered under its own name) is two versions and is accepted;
--      identical versions still answer SAME_VERSION.
--  10. fn_lightning_shadow_report counted windows with a NULL score toward
--      the 30-comparison threshold. 'comparisons' now counts only windows
--      where both scores are non-null (as do the means and the shadow win
--      share); the new key 'windows' counts every row.
--
-- PAYLOAD CONTRACTS (for the app remediation agent and the operator
-- dashboard). NO INPUT CHANGES: fn_lightning_integrity_report(uuid, jsonb,
-- timestamptz) and fn_lightning_shadow_record(uuid, text, text, timestamptz,
-- timestamptz, jsonb, jsonb) take exactly the arguments and keys they took.
-- ANSWERS, additive only:
--   * fn_lightning_integrity_report: every old key, plus evidence_stored (the
--     subjects of this window kept), aggregation_hours (24) and
--     evidence_pruned. 'flagged', 'inserted', 'updated' and 'unchanged' now
--     count the 24-hour decision of each subject of the report.
--   * fn_lightning_shadow_report version_pairs[]: every old key ('comparisons'
--     now counts scored windows only), plus 'windows' (every row) and
--     'aa_calibration' (shadow_matcher_version = live_matcher_version ||
--     '-port'). An A/A pair with 30 or more comparisons has verdict
--     'calibrated' (|quality_delta_mean| <= 1) or 'calibration_bias'; A/A
--     pairs sort after every real candidate, so the overview's first pair is
--     never the calibration.
--   * fn_lightning_integrity_scan: every old key; thresholds gains
--     flow_min_z, flow_min_gross_bb, long_session_max_score,
--     pairing_expectation, join_leave_counts and findings. Signal evidence
--     gains keys (PAIRING: expectation, hands_a_while_b_present,
--     hands_b_while_a_present; CHIP_FLOW: win_z, gross_bb, min_z,
--     min_gross_bb; COORDINATED_JOIN_LEAVE: player_initiated_only; every
--     scan finding: latest_score, latest_window_start, latest_window_end).
--     Engine findings carry the aggregated numbers plus windows,
--     aggregation_hours and the same latest_ keys.
--   * fn_lightning_operator_cluster: the same shape; integrity_signals now
--     also lists findings detected earlier whose window reaches the view.
--
-- DECIDED AND LEFT ALONE: fn_ca_integrity_detector_health (finding 12's
-- second half). It belongs to the Smarter-Poker-World-Hub migrations. Its
-- state never reads ca_collusion_signals (it is decided by the worker, the
-- cron sources and the daily jobs), and its chip_flow_rows already excludes
-- every row with a detail.signal; its total and newest_at describe the whole
-- pair store, which by design holds the Lightning findings too. With one
-- mirror row per finding (6) those can no longer swell it. Not rewritten.
-- Also left alone: fn_lightning_player_legality's per-player exposure cost
-- and the presence/settlement deadlocks (recorded, retryable, no money lost):
-- not changed here, so no seating or settlement body moves.
--
-- HOUSE RULES OBSERVED. One BEGIN/COMMIT, SET LOCAL lock_timeout '3s' (one
-- short SHARE lock on ca_collusion_signals to build its partial unique index,
-- about 91,000 rows and none of them a Lightning row today). Every substitution
-- asserts each anchor's count and refuses otherwise; a body already carrying
-- its marker is left alone; who may execute each function is read back per
-- role with has_function_privilege. The new table has RLS on, no policy and
-- no privilege for any role (its sequence too), so 20260920235343's census of
-- exactly seven Lightning tables granted to service_role stays true. No new
-- function, so 20261009144343's census of the functions that may read the
-- integrity stores stays true (restated below with the new store). No
-- fn_lightning_config key is added. No foreign key. Not applied to
-- production by this change.
--
-- NO MATCHMAKING MANIPULATION. Nothing in the seating path reads any of it:
-- form_hand, legality, match, match_plan, match_and_form and tick_all are
-- untouched and still carry no integrity, shadow_comparison, quality_,
-- latency, lightning_alert or fn_lightning_operator_ term (20261009144343
-- proof 6 and 7 hold, restated below).
--
-- LAW 10.5. Nothing here reads is_horse or horse_id. A horse is scanned,
-- aggregated, capped and mirrored exactly as a human; the harness seats
-- humans and horses in every pool it plants.
--
-- @live-proof: (SELECT c.relrowsecurity AND NOT EXISTS (SELECT 1 FROM pg_policy pol WHERE pol.polrelid = c.oid) AND NOT has_table_privilege('anon', c.oid, 'SELECT') AND NOT has_table_privilege('authenticated', c.oid, 'SELECT') AND NOT has_table_privilege('service_role', c.oid, 'SELECT') AND NOT has_table_privilege('service_role', c.oid, 'INSERT') AND NOT has_sequence_privilege('anon', 'public.lightning_integrity_engine_window_id_seq', 'USAGE') AND NOT has_sequence_privilege('authenticated', 'public.lightning_integrity_engine_window_id_seq', 'USAGE') AND NOT has_sequence_privilege('service_role', 'public.lightning_integrity_engine_window_id_seq', 'USAGE') FROM pg_class c WHERE c.oid = 'public.lightning_integrity_engine_window'::regclass)
-- @live-proof: (SELECT count(*) = 7 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name LIKE 'lightning\_%' AND grantee = 'service_role' AND privilege_type = 'SELECT') AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name LIKE 'lightning\_%' AND grantee IN ('anon', 'authenticated', 'PUBLIC'))
-- @live-proof: (SELECT i.indisunique AND pg_get_indexdef(i.indexrelid) ~ 'NULLS NOT DISTINCT' FROM pg_index i WHERE i.indexrelid = 'public.lightning_integrity_engine_window_one_per_key'::regclass) AND (SELECT i.indisunique AND pg_get_indexdef(i.indexrelid) ~ 'lightning_signal_id' AND pg_get_indexdef(i.indexrelid) ~ 'lightning_chip_flow' FROM pg_index i WHERE i.indexrelid = 'public.ca_collusion_signals_one_per_lightning_finding'::regclass) AND to_regclass('public.lightning_integrity_signal_by_subject') IS NOT NULL
-- @live-proof: (SELECT s ~ 'pg_advisory_xact_lock\(hashtext\(''lightning-integrity:''' AND s ~ 'window_end = GREATEST\(t\.window_end, v_to\)' AND s !~ 'DO UPDATE SET suspicion_score' AND s ~ 'ON CONFLICT \(\(detail ->> ''lightning_signal_id''\)\)' AND s ~ '''lightning_signal_id''\) = t\.id::text' AND s ~ 'pres AS MATERIALIZED' AND s ~ 'c_flow_min_hands constant integer := 30' AND s ~ 'c_flow_min_z' AND s ~ 'c_flow_min_gross_bb \* coalesce\(v_bb, 0\)' AND s ~ 'exit_reason IN \(''stop_playing'', ''anchor_seat_left''\)' AND s ~ 'public\.cash_cluster_epoch' AND s ~ 'c_long_max_score constant integer := 69' AND s ~ 'LEAST\(c_long_max_score,' AND s ~ 'LIMIT c_max_sessions\) ps' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_integrity_scan(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT s ~ 'INSERT INTO public\.lightning_integrity_engine_window' AND s ~ 'c_agg_hours\s+constant integer := 24' AND s ~ 'pg_advisory_xact_lock\(hashtext\(''lightning-integrity:''' AND s ~ 'window_end = GREATEST\(t\.window_end, a\.w_to\)' AND s ~ 'evidence_carries_cards' AND s ~ '''DECISION_LATENCY''' AND s ~ '''TIMING_CORRELATION''' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_integrity_report(uuid,jsonb,timestamp with time zone)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT r ~ 'IF v_live_v = p_shadow_version THEN' AND r ~ '''SAME_VERSION''' AND r ~ 'AS paired' AND r ~ 'jsonb_typeof\(v_shadow_c -> e\.key\) = ''number''' AND p ~ 'count\(\*\) FILTER \(WHERE c\.live_quality_score IS NOT NULL AND c\.shadow_quality_score IS NOT NULL\) AS n' AND p ~ '''windows'', g\.windows' AND p ~ '''aa_calibration''' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_shadow_record(uuid,text,text,timestamp with time zone,timestamp with time zone,jsonb,jsonb)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS r, regexp_replace(pg_get_functiondef('public.fn_lightning_shadow_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS p) q)
-- @live-proof: (SELECT s ~ 'fn_lightning_integrity_scan\(c\.id, date_trunc\(''day'', v_now, ''UTC''\) - interval ''1 day'', date_trunc\(''day'', v_now, ''UTC''\)\)' AND s !~ 'fn_lightning_integrity_scan\(c\.id, NULL, NULL\)' AND s ~ 'st\.last_at < date_trunc\(''day'', v_now, ''UTC''\)' AND s ~ 'pg_try_advisory_xact_lock' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_alert_sweep(timestamp with time zone)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT s ~ 'x\.window_end >= v_from AND x\.detected_at <= v_to' AND s ~ 'public\.fn_lightning_operator_redact\(' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_operator_cluster(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT bool_and(p.prosecdef AND array_to_string(p.proconfig, ',') ~ 'search_path=' AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('authenticated', p.oid, 'EXECUTE') = (p.proname = 'fn_lightning_operator_cluster')) AND count(*) = 6 FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_integrity_scan(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure, 'public.fn_lightning_integrity_report(uuid,jsonb,timestamp with time zone)'::regprocedure, 'public.fn_lightning_shadow_record(uuid,text,text,timestamp with time zone,timestamp with time zone,jsonb,jsonb)'::regprocedure, 'public.fn_lightning_shadow_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure, 'public.fn_lightning_alert_sweep(timestamp with time zone)'::regprocedure, 'public.fn_lightning_operator_cluster(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))
-- @live-proof: (SELECT bool_and(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') !~ 'integrity|shadow_comparison|quality_|latency|lightning_alert|fn_lightning_operator_') FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure, 'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure, 'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text,jsonb)'::regprocedure, 'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)'::regprocedure, 'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure, 'public.fn_cash_clusters_tick_all(jsonb)'::regprocedure))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND (p.proname LIKE 'fn\_lightning\_%' OR p.proname LIKE 'fn\_cash\_cluster%') AND p.proname NOT IN ('fn_lightning_integrity_scan', 'fn_lightning_integrity_report', 'fn_lightning_quality_score', 'fn_lightning_quality_components', 'fn_lightning_shadow_record', 'fn_lightning_shadow_report', 'fn_lightning_config', 'fn_lightning_operator_overview', 'fn_lightning_operator_cluster', 'fn_lightning_operator_cluster_row', 'fn_lightning_operator_signal_review', 'fn_lightning_alert_sweep', 'fn_lightning_latency_report', 'fn_lightning_latency_regression') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'lightning_integrity_signal|lightning_integrity_engine_window|lightning_matcher_shadow_comparison|ca_collusion_signals|collusion_tracking|anti_cheat_flags|quality_score|quality_weights|fn_lightning_integrity_|lightning_latency_window|lightning_alert_sweep_state'))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_lightning_integrity_scan', 'fn_lightning_integrity_report', 'fn_lightning_shadow_record', 'fn_lightning_shadow_report', 'fn_lightning_alert_sweep', 'fn_lightning_operator_cluster') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id'))
--

BEGIN;
SET LOCAL lock_timeout = '3s';

-- ===========================================================================
-- 1. THE REWRITER, in the shape 20261009151825 cut it: an asserted
--    substitution into the body production carries. Every anchor must
--    appear exactly as often as stated or the file refuses. Every change
--    keeps its signature; a body already carrying the marker is left
--    alone, so the file is re-appliable.
-- ===========================================================================

CREATE OR REPLACE FUNCTION pg_temp.lp11r_rewrite(p_sig text, p_marker text,
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
BEGIN
  v_src := pg_get_functiondef(p_sig::regprocedure);
  IF position(p_marker in v_src) > 0 THEN
    RETURN;
  END IF;
  v_new := v_src;
  FOR k IN 1 .. array_length(p_from, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_from[k], ''))) / length(p_from[k]);
    IF v_n IS DISTINCT FROM p_counts[k] THEN
      RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', p_sig, k, v_n, p_counts[k];
    END IF;
    v_new := replace(v_new, p_from[k], p_to[k]);
  END LOOP;
  SELECT array_agg(has_function_privilege(t.r, p_sig::regprocedure, 'EXECUTE') ORDER BY t.ord)
    INTO v_had FROM unnest(v_roles) WITH ORDINALITY t(r, ord);
  EXECUTE v_new;
  -- WHO MAY EXECUTE IS KEPT, read back per role (never acl::text).
  SELECT string_agg(t.r || ': had ' || v_had[t.ord] || ', has '
                    || has_function_privilege(t.r, p_sig::regprocedure, 'EXECUTE'), '; ')
    INTO v_bad
    FROM unnest(v_roles) WITH ORDINALITY t(r, ord)
   WHERE has_function_privilege(t.r, p_sig::regprocedure, 'EXECUTE') IS DISTINCT FROM v_had[t.ord];
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '% did not keep who may execute it (%)', p_sig, v_bad;
  END IF;
  IF position(p_marker in pg_get_functiondef(p_sig::regprocedure)) = 0 THEN
    RAISE EXCEPTION '% does not read back carrying %', p_sig, p_marker;
  END IF;
END
$rw$;

-- ===========================================================================
-- 2. THE STORES: the engine's per-window evidence, the subject index the
--    extending findings are found by, and the mirror's one-per-finding key.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.lightning_integrity_engine_window (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cluster_id  uuid NOT NULL,
  window_from timestamptz NOT NULL,
  window_to   timestamptz NOT NULL,
  player_a    uuid NOT NULL,
  player_b    uuid,
  numbers     jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lightning_integrity_engine_window_ordered CHECK (window_to > window_from),
  CONSTRAINT lightning_integrity_engine_window_subject_shape CHECK (player_b IS NULL OR player_a < player_b),
  CONSTRAINT lightning_integrity_engine_window_numbers_bounded CHECK (
    jsonb_typeof(numbers) = 'object' AND octet_length(numbers::text) <= 2048)
);

COMMENT ON TABLE public.lightning_integrity_engine_window IS
  'Lightning Phase 11 remediation (20261009181945): the engine''s integrity evidence per (Cluster, subject, window) as fn_lightning_integrity_report validated and clamped it - per player (player_b NULL): decisions, timeouts, p50_ms, p95_ms, mean_ms, stddev_ms, cv, fast_share; per pair (player_a < player_b): hands_together, sequential_actions, fast_follows, latency_corr. The report decides DECISION_LATENCY and TIMING_CORRELATION over the rolling 24 hours of it. Kept 48 hours. Telemetry only: nothing in the seating path reads it. Never carries a card. RLS on, no role holds a privilege.';

CREATE UNIQUE INDEX IF NOT EXISTS lightning_integrity_engine_window_one_per_key
  ON public.lightning_integrity_engine_window (cluster_id, player_a, player_b, window_from, window_to) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS lightning_integrity_engine_window_by_end
  ON public.lightning_integrity_engine_window (cluster_id, window_to);

ALTER TABLE public.lightning_integrity_engine_window ENABLE ROW LEVEL SECURITY;
-- NO ROLE HOLDS A TABLE OR SEQUENCE PRIVILEGE, service_role included:
-- production's default privileges grant all three roles at birth, so they are
-- taken back here, and 20260920235343's census of exactly seven Lightning
-- tables granted to service_role stays true.
REVOKE ALL ON TABLE public.lightning_integrity_engine_window FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.lightning_integrity_engine_window_id_seq FROM PUBLIC, anon, authenticated, service_role;

-- The newest finding of a subject (lightning_integrity_signal is empty in
-- production).
CREATE INDEX IF NOT EXISTS lightning_integrity_signal_by_subject
  ON public.lightning_integrity_signal (cluster_id, pattern_type, player_a, player_b, window_end DESC);

-- ONE MIRROR ROW PER LIGHTNING FINDING, whatever runs overlap. Partial: the
-- other detectors' rows (detail.signal NULL or duel_repeat_pairing) are not
-- in it, and no Lightning row exists in production today.
CREATE UNIQUE INDEX IF NOT EXISTS ca_collusion_signals_one_per_lightning_finding
  ON public.ca_collusion_signals ((detail ->> 'lightning_signal_id'))
  WHERE (detail ->> 'signal') = 'lightning_chip_flow';

-- ===========================================================================
-- 3. THE SCAN: fair join/leave, co-presence pairing, significant chip flow,
--    capped session length, and one finding per subject that extends.
-- ===========================================================================

SELECT pg_temp.lp11r_rewrite(
  'public.fn_lightning_integrity_scan(uuid,timestamp with time zone,timestamp with time zone)',
  'FINDINGS EXTEND, NEVER DUPLICATE',
  ARRAY[
$a$  c_flow_min_hands constant integer := 10;
$a$,
$a$  v_n        integer;
BEGIN
$a$,
$a$    v_scanned := v_scanned + 1;
$a$,
$a$      SELECT lh.hand_id FROM public.lightning_hand lh
$a$,
$a$      SELECT p.hand_id, p.player_id, coalesce(p.net_result, 0) AS net
$a$,
$a$    ), scored AS (
      SELECT pr.*, pa_.hands AS hands_a, pb_.hands AS hands_b,
             (pa_.hands::numeric * pb_.hands::numeric / GREATEST(v_hands, 1)) AS expected
        FROM pairs pr
        JOIN per pa_ ON pa_.player_id = pr.pa
        JOIN per pb_ ON pb_.player_id = pr.pb
    ), cand AS (
$a$,
$a$                                'hands_in_window', v_hands, 'expected_together', round(s.expected, 2),
$a$,
$a$                                'min_win_share', c_flow_min_win)
$a$,
$a$         AND GREATEST(s.b_won, s.opposed - s.b_won)::numeric / s.opposed >= c_flow_min_win
$a$,
$a$    ), up AS (
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
$a$,
$a$    WITH s AS MATERIALIZED (
      SELECT ps.id, ps.player_id, ps.entered_at, ps.exited_at
        FROM public.lightning_pool_session ps
$a$,
$a$                AND a.exited_at IS NOT NULL AND b.exited_at IS NOT NULL
$a$,
$a$                                'within_seconds', c_join_window_s, 'min_joint', c_join_min) AS evidence
$a$,
$a$             LEAST(90, round(50 + (l.hours - c_long_hours) * 10 / 3))::integer,
$a$,
$a$            FROM public.lightning_pool_session ps
           WHERE ps.cluster_id = v_cluster
             AND ps.entered_at >= v_from - interval '7 days' AND ps.entered_at < v_to
             AND (ps.exited_at IS NULL OR ps.exited_at > v_from)
$a$,
$a$    SELECT GREATEST(1, ceil(extract(epoch FROM (v_to - v_from)) / 86400))::integer,
$a$,
$a$             'since', v_from,
             'until', v_to,
$a$,
$a$             'lightning_key', v_cluster::text || ':' || to_char(v_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
                              || ':' || to_char(v_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
                              || ':' || t.player_a::text || ':' || t.player_b::text,
$a$,
$a$       AND t.window_start = v_from AND t.window_end = v_to
       AND NOT EXISTS (
         SELECT 1 FROM public.ca_collusion_signals x
          WHERE LEAST(x.user_a, x.user_b) = t.player_a AND GREATEST(x.user_a, x.user_b) = t.player_b
            AND x.detail ->> 'signal' = 'lightning_chip_flow'
            AND x.detail ->> 'lightning_key' = v_cluster::text || ':' || to_char(v_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
                              || ':' || to_char(v_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
                              || ':' || t.player_a::text || ':' || t.player_b::text);
$a$,
$a$      'max_sessions', c_max_sessions, 'max_clusters', c_max_clusters));
$a$],
  ARRAY[
$b$  c_flow_min_hands constant integer := 30;
  c_flow_min_z     constant numeric := 4.0;
  c_flow_min_gross_bb constant numeric := 50;
  c_long_max_score constant integer := 69;
$b$,
$b$  v_n        integer;
  v_bb       numeric;
BEGIN
$b$,
$b$    v_scanned := v_scanned + 1;
    -- FINDINGS EXTEND, NEVER DUPLICATE (2026-10-09, Phase 11 remediation).
    -- One scan or engine report of a Cluster at a time: overlapping runs
    -- (the sweep, an operator, a retry) wait for each other here, so the
    -- extend-or-insert below and the mirror's check see each other's rows.
    -- Clusters are taken in cluster_id order, so two scans cannot deadlock.
    PERFORM pg_advisory_xact_lock(hashtext('lightning-integrity:' || v_cluster::text));
    SELECT cg.bb INTO v_bb FROM public.cash_games cg WHERE cg.id = v_cluster;
$b$,
$b$      SELECT lh.hand_id, lh.formed_at FROM public.lightning_hand lh
$b$,
$b$      SELECT p.hand_id, p.player_id, coalesce(p.net_result, 0) AS net, h.formed_at
$b$,
$b$    ), pres AS MATERIALIZED (
      -- WHO WAS IN THE POOL, AND WHEN: every pool session of the Cluster
      -- open at some moment of the window (bounded like the session scan).
      SELECT ps.player_id, ps.entered_at, ps.exited_at
        FROM public.lightning_pool_session ps
       WHERE ps.cluster_id = v_cluster
         AND ps.entered_at < v_to AND ps.entered_at >= v_from - interval '7 days'
         AND (ps.exited_at IS NULL OR ps.exited_at > v_from)
       ORDER BY ps.entered_at DESC, ps.id
       LIMIT c_max_sessions
    ), pool AS (
      -- THE POOL'S SIZE AT EACH HAND, by one ordered sweep: an entry adds
      -- one, an exit takes one away, and a hand reads the running total
      -- after every entry and exit at or before its formation.
      SELECT q.hand_id, q.present FROM (
        SELECT e.hand_id, sum(e.d) OVER (ORDER BY e.t, e.k ROWS UNBOUNDED PRECEDING) AS present
          FROM (SELECT pr_.entered_at AS t, 1 AS d, 0 AS k, NULL::uuid AS hand_id FROM pres pr_
                UNION ALL
                SELECT pr_.exited_at, -1, 0, NULL::uuid FROM pres pr_ WHERE pr_.exited_at IS NOT NULL
                UNION ALL
                SELECT h.formed_at, 0, 1, h.hand_id FROM h) e) q
       WHERE q.hand_id IS NOT NULL
    ), hw AS MATERIALIZED (
      -- THE CHANCE A RANDOM SEATING PUTS A GIVEN OTHER PLAYER OF THE POOL
      -- IN THIS HAND: (players in the hand - 1) / (players in the pool - 1).
      SELECT hp.hand_id, hp.player_id, hp.formed_at,
             (sz.n - 1)::numeric / GREATEST(GREATEST(pl.present, sz.n) - 1, 1) AS w
        FROM hp
        JOIN (SELECT hp2.hand_id, count(*) AS n FROM hp hp2 GROUP BY 1) sz ON sz.hand_id = hp.hand_id
        JOIN pool pl ON pl.hand_id = hp.hand_id
    ), ex AS (
      -- THE CO-PRESENCE EXPECTATION of a candidate pair: over A's hands
      -- formed while B was in the pool, and B's while A was, averaged.
      SELECT d.pa, d.pb, sum(hw.w) / 2 AS expected,
             count(*) FILTER (WHERE d.x = d.pa) AS hands_a_copresent,
             count(*) FILTER (WHERE d.x = d.pb) AS hands_b_copresent
        FROM (SELECT pr.pa AS x, pr.pb AS y, pr.pa, pr.pb FROM pairs pr WHERE pr.together >= c_pair_min_hands
              UNION ALL
              SELECT pr.pb, pr.pa, pr.pa, pr.pb FROM pairs pr WHERE pr.together >= c_pair_min_hands) d
        JOIN hw ON hw.player_id = d.x
        JOIN pres s ON s.player_id = d.y AND s.entered_at <= hw.formed_at
                   AND (s.exited_at IS NULL OR s.exited_at > hw.formed_at)
       GROUP BY d.pa, d.pb
    ), scored AS (
      SELECT pr.*, pa_.hands AS hands_a, pb_.hands AS hands_b,
             coalesce(ex.expected, pa_.hands::numeric * pb_.hands::numeric / GREATEST(v_hands, 1)) AS expected,
             CASE WHEN ex.expected IS NOT NULL THEN 'co_presence' ELSE 'whole_window' END AS expectation,
             ex.hands_a_copresent, ex.hands_b_copresent
        FROM pairs pr
        JOIN per pa_ ON pa_.player_id = pr.pa
        JOIN per pb_ ON pb_.player_id = pr.pb
        LEFT JOIN ex ON ex.pa = pr.pa AND ex.pb = pr.pb
    ), cand AS (
$b$,
$b$                                'hands_in_window', v_hands, 'expected_together', round(s.expected, 2),
                                'expectation', s.expectation,
                                'hands_a_while_b_present', s.hands_a_copresent,
                                'hands_b_while_a_present', s.hands_b_copresent,
$b$,
$b$                                'min_win_share', c_flow_min_win,
                                'win_z', round((GREATEST(s.b_won, s.opposed - s.b_won) - s.opposed / 2.0) / sqrt(s.opposed / 4.0), 3),
                                'gross_bb', CASE WHEN coalesce(v_bb, 0) > 0 THEN round(s.gross / v_bb, 2) END,
                                'min_z', c_flow_min_z, 'min_gross_bb', c_flow_min_gross_bb)
$b$,
$b$         AND GREATEST(s.b_won, s.opposed - s.b_won)::numeric / s.opposed >= c_flow_min_win
         AND (GREATEST(s.b_won, s.opposed - s.b_won) - s.opposed / 2.0) / sqrt(s.opposed / 4.0) >= c_flow_min_z
         AND s.gross >= c_flow_min_gross_bb * coalesce(v_bb, 0)
$b$,
$b$    ), k AS (
      SELECT c.pattern, c.pa, c.pb, c.score,
             c.evidence || jsonb_build_object('latest_score', c.score, 'latest_window_start', v_from,
                                              'latest_window_end', v_to) AS evidence
        FROM capped c WHERE c.rn <= c_max_signals
    ), cur AS (
      -- THE SUBJECT'S FINDING: the newest row of the same Cluster, pattern
      -- and subject whose window meets this one. It is extended; its status
      -- (an operator's review) is never touched.
      SELECT DISTINCT ON (k.pattern, k.pa, k.pb) t.id, k.pattern, k.pa, k.pb
        FROM k JOIN public.lightning_integrity_signal t
          ON t.cluster_id = v_cluster AND t.pattern_type = k.pattern AND t.player_a = k.pa
         AND t.player_b IS NOT DISTINCT FROM k.pb
         AND t.window_end >= v_from AND t.window_start <= v_to
       ORDER BY k.pattern, k.pa, k.pb, t.window_end DESC, t.id DESC
    ), ext AS (
      UPDATE public.lightning_integrity_signal t
         SET window_start = LEAST(t.window_start, v_from),
             window_end = GREATEST(t.window_end, v_to),
             suspicion_score = GREATEST(t.suspicion_score, k.score),
             severity = CASE WHEN GREATEST(t.suspicion_score, k.score) >= 70 THEN 'high'
                             WHEN GREATEST(t.suspicion_score, k.score) >= 40 THEN 'medium' ELSE 'low' END,
             evidence = k.evidence, updated_at = now()
        FROM cur JOIN k ON k.pattern = cur.pattern AND k.pa = cur.pa AND k.pb IS NOT DISTINCT FROM cur.pb
       WHERE t.id = cur.id
         AND (t.window_start, t.window_end, t.suspicion_score::integer, t.evidence)
             IS DISTINCT FROM (LEAST(t.window_start, v_from), GREATEST(t.window_end, v_to),
                               GREATEST(t.suspicion_score::integer, k.score), k.evidence)
      RETURNING t.pattern_type
    ), ins AS (
      INSERT INTO public.lightning_integrity_signal AS t
        (cluster_id, pattern_type, source, player_a, player_b, window_start, window_end,
         suspicion_score, severity, evidence)
      SELECT v_cluster, k.pattern, 'scan', k.pa, k.pb, v_from, v_to, k.score,
             CASE WHEN k.score >= 70 THEN 'high' WHEN k.score >= 40 THEN 'medium' ELSE 'low' END,
             k.evidence
        FROM k
       WHERE NOT EXISTS (SELECT 1 FROM cur WHERE cur.pattern = k.pattern AND cur.pa = k.pa
                                             AND cur.pb IS NOT DISTINCT FROM k.pb)
      ON CONFLICT (cluster_id, pattern_type, window_start, window_end, player_a, player_b) DO NOTHING
      RETURNING t.pattern_type
    ), up AS (
      SELECT ext.pattern_type FROM ext UNION ALL SELECT ins.pattern_type FROM ins
    )
$b$,
$b$    WITH s AS MATERIALIZED (
      SELECT ps.id, ps.player_id, ps.entered_at, ps.exited_at,
             -- ONLY WHAT THE PLAYER DID: an entry within the pattern's window
             -- of an epoch start (the conversion entering everyone, the
             -- unfreeze) is the system's; only Stop Playing and standing up
             -- from the anchor seat are the player's own exits.
             NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch ce
                          WHERE ce.cluster_id = ps.cluster_id
                            AND ce.started_at BETWEEN ps.entered_at - make_interval(secs => c_join_window_s)
                                                  AND ps.entered_at + make_interval(secs => c_join_window_s)) AS own_entry,
             coalesce(ps.exit_reason IN ('stop_playing', 'anchor_seat_left'), false) AS own_exit
        FROM public.lightning_pool_session ps
$b$,
$b$                AND a.exited_at IS NOT NULL AND b.exited_at IS NOT NULL
                AND a.own_entry AND b.own_entry AND a.own_exit AND b.own_exit
$b$,
$b$                                'within_seconds', c_join_window_s, 'min_joint', c_join_min,
                                'player_initiated_only', true) AS evidence
$b$,
$b$             LEAST(c_long_max_score, round(50 + (l.hours - c_long_hours) * 10 / 3))::integer,
$b$,
$b$            FROM (SELECT x.* FROM public.lightning_pool_session x
                   WHERE x.cluster_id = v_cluster
                     AND x.entered_at >= v_from - interval '7 days' AND x.entered_at < v_to
                     AND (x.exited_at IS NULL OR x.exited_at > v_from)
                     AND coalesce(x.exited_at, v_to) - x.entered_at >= c_long_hours * interval '1 hour'
                   ORDER BY x.entered_at DESC, x.id
                   LIMIT c_max_sessions) ps
$b$,
$b$    SELECT GREATEST(1, ceil(extract(epoch FROM (t.window_end - t.window_start)) / 86400))::integer,
$b$,
$b$             'since', t.window_start,
             'until', t.window_end,
$b$,
$b$             'lightning_key', v_cluster::text || ':' || t.player_a::text || ':' || t.player_b::text || ':' || t.id::text,
$b$,
$b$       AND t.window_start <= v_from AND t.window_end >= v_to
       AND NOT EXISTS (
         SELECT 1 FROM public.ca_collusion_signals x
          WHERE (x.detail ->> 'signal') = 'lightning_chip_flow'
            AND (x.detail ->> 'lightning_signal_id') = t.id::text)
    ON CONFLICT ((detail ->> 'lightning_signal_id')) WHERE ((detail ->> 'signal') = 'lightning_chip_flow') DO NOTHING;
$b$,
$b$      'max_sessions', c_max_sessions, 'max_clusters', c_max_clusters,
      'flow_min_z', c_flow_min_z, 'flow_min_gross_bb', c_flow_min_gross_bb,
      'long_session_max_score', c_long_max_score, 'pairing_expectation', 'co_presence',
      'join_leave_counts', 'player_initiated', 'findings', 'extend_per_subject'));
$b$],
  ARRAY[1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);

-- ===========================================================================
-- 4. THE ENGINE REPORT: every window's evidence is kept, and the decision is
--    taken over the rolling day of it.
-- ===========================================================================

SELECT pg_temp.lp11r_rewrite(
  'public.fn_lightning_integrity_report(uuid,jsonb,timestamp with time zone)',
  'THE ENGINE''S EVIDENCE IS JUDGED OVER A DAY',
  ARRAY[
$a$  v_id       bigint;
BEGIN
$a$,
$a$  FOREACH v_list IN ARRAY ARRAY['players', 'pairs'] LOOP
$a$,
$a$      -- THE DECISION: abnormal or not.
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
$a$,
$a$                            'inserted', v_ins, 'updated', v_upd, 'unchanged', v_same,
$a$],
  ARRAY[
$b$  v_id       bigint;
  c_agg_hours  constant integer := 24;
  c_keep_hours constant integer := 48;
  v_stored   integer := 0;
  v_pruned   integer := 0;
  a          record;
  v_cur      record;
  v_ev       jsonb;
  v_cv       numeric;
  v_fs       numeric;
  v_corr     numeric;
  v_peak     integer;
BEGIN
$b$,
$b$  -- ONE REPORT OR SCAN OF A CLUSTER AT A TIME (the scan takes the same
  -- lock), so the extend-or-insert below sees every earlier window.
  PERFORM pg_advisory_xact_lock(hashtext('lightning-integrity:' || p_cluster_id::text));
  FOREACH v_list IN ARRAY ARRAY['players', 'pairs'] LOOP
$b$,
$b$      -- THE ENGINE'S EVIDENCE IS JUDGED OVER A DAY (2026-10-09, Phase 11
      -- remediation). At the engine's five-minute window a pair shares one
      -- or two hands, so no single window ever reached a threshold. Every
      -- subject's validated numbers are KEPT per window (idempotent per
      -- Cluster, subject and window; a resend with other numbers replaces
      -- them) and the decision below is taken over the rolling 24 hours.
      INSERT INTO public.lightning_integrity_engine_window AS w
        (cluster_id, window_from, window_to, player_a, player_b, numbers)
      VALUES (p_cluster_id, v_from, v_to, v_p, v_o, v_num)
      ON CONFLICT (cluster_id, player_a, player_b, window_from, window_to)
      DO UPDATE SET numbers = EXCLUDED.numbers, received_at = clock_timestamp()
       WHERE w.numbers IS DISTINCT FROM EXCLUDED.numbers;
      v_stored := v_stored + 1;
    END LOOP;
  END LOOP;

  -- THE DECISION: for every subject of this window, its evidence of the last
  -- 24 hours. Counts are summed; fast_share, p50 and p95 are weighted by
  -- decisions; cv is the pooled cv of the windows that sent mean_ms and
  -- stddev_ms (else the decision-weighted cv); latency_corr is weighted by
  -- sequential actions. The thresholds are the ones a single window used.
  FOR a IN
    WITH subj AS (
      SELECT DISTINCT ew.player_a, ew.player_b FROM public.lightning_integrity_engine_window ew
       WHERE ew.cluster_id = p_cluster_id AND ew.window_from = v_from AND ew.window_to = v_to
    ), ev AS (
      SELECT ew.player_a, ew.player_b, ew.window_from, ew.window_to,
             (ew.numbers ->> 'decisions')::numeric AS dn, (ew.numbers ->> 'timeouts')::numeric AS tmo,
             (ew.numbers ->> 'p50_ms')::numeric AS p50, (ew.numbers ->> 'p95_ms')::numeric AS p95,
             (ew.numbers ->> 'mean_ms')::numeric AS mn, (ew.numbers ->> 'stddev_ms')::numeric AS sd,
             (ew.numbers ->> 'cv')::numeric AS cv, (ew.numbers ->> 'fast_share')::numeric AS fast,
             (ew.numbers ->> 'hands_together')::numeric AS ht, (ew.numbers ->> 'sequential_actions')::numeric AS seq,
             (ew.numbers ->> 'fast_follows')::numeric AS ff, (ew.numbers ->> 'latency_corr')::numeric AS cr
        FROM subj s
        JOIN public.lightning_integrity_engine_window ew
          ON ew.cluster_id = p_cluster_id AND ew.player_a = s.player_a AND ew.player_b IS NOT DISTINCT FROM s.player_b
       WHERE ew.window_to > v_to - make_interval(hours => c_agg_hours) AND ew.window_to <= v_to
    )
    SELECT ev.player_a, ev.player_b, count(*)::integer AS windows,
           min(ev.window_from) AS w_from, max(ev.window_to) AS w_to,
           sum(ev.dn) AS decisions, sum(ev.tmo) AS timeouts,
           sum(ev.dn * ev.fast) / nullif(sum(ev.dn) FILTER (WHERE ev.fast IS NOT NULL), 0) AS fast_w,
           avg(ev.fast) AS fast_u,
           sum(ev.dn * ev.mn) FILTER (WHERE ev.sd IS NOT NULL)
             / nullif(sum(ev.dn) FILTER (WHERE ev.mn IS NOT NULL AND ev.sd IS NOT NULL), 0) AS mean_p,
           sum(ev.dn * (ev.sd * ev.sd + ev.mn * ev.mn))
             / nullif(sum(ev.dn) FILTER (WHERE ev.mn IS NOT NULL AND ev.sd IS NOT NULL), 0) AS m2_p,
           sum(ev.dn * ev.cv) / nullif(sum(ev.dn) FILTER (WHERE ev.cv IS NOT NULL), 0) AS cv_w,
           avg(ev.cv) AS cv_u,
           sum(ev.dn * ev.p50) / nullif(sum(ev.dn) FILTER (WHERE ev.p50 IS NOT NULL), 0) AS p50,
           sum(ev.dn * ev.p95) / nullif(sum(ev.dn) FILTER (WHERE ev.p95 IS NOT NULL), 0) AS p95,
           sum(ev.ht) AS hands_together, sum(ev.seq) AS sequential_actions, sum(ev.ff) AS fast_follows,
           sum(ev.seq * ev.cr) / nullif(sum(ev.seq) FILTER (WHERE ev.cr IS NOT NULL), 0) AS corr_w,
           avg(ev.cr) AS corr_u
      FROM ev
     GROUP BY ev.player_a, ev.player_b
     ORDER BY ev.player_a, ev.player_b
  LOOP
    v_type := NULL;
    v_score := NULL;
    v_follow := NULL;
    IF a.player_b IS NULL THEN
      v_cv := CASE WHEN a.mean_p > 0 THEN round(sqrt(GREATEST(a.m2_p - a.mean_p * a.mean_p, 0)) / a.mean_p, 4)
                   ELSE round(coalesce(a.cv_w, a.cv_u), 4) END;
      v_fs := round(coalesce(a.fast_w, a.fast_u), 4);
      v_num := jsonb_strip_nulls(jsonb_build_object(
                 'decisions', a.decisions, 'timeouts', a.timeouts,
                 'p50_ms', round(a.p50, 1), 'p95_ms', round(a.p95, 1), 'mean_ms', round(a.mean_p, 1),
                 'stddev_ms', CASE WHEN a.mean_p > 0 THEN round(sqrt(GREATEST(a.m2_p - a.mean_p * a.mean_p, 0)), 1) END,
                 'cv', v_cv, 'fast_share', v_fs));
      IF coalesce(a.decisions, 0) >= c_lat_min_dec AND (v_cv <= c_lat_max_cv OR v_fs >= c_lat_min_fast) THEN
        v_type := 'DECISION_LATENCY';
        v_score := LEAST(100, GREATEST(
          CASE WHEN v_cv <= c_lat_max_cv THEN round(50 + 40 * (c_lat_max_cv - v_cv) / c_lat_max_cv) END,
          CASE WHEN v_fs >= c_lat_min_fast THEN round(40 + 50 * v_fs) END))::integer;
      END IF;
    ELSE
      v_corr := round(coalesce(a.corr_w, a.corr_u), 4);
      v_follow := CASE WHEN coalesce(a.sequential_actions, 0) > 0
                       THEN LEAST(coalesce(a.fast_follows, 0) / a.sequential_actions, 1) END;
      v_num := jsonb_strip_nulls(jsonb_build_object(
                 'hands_together', a.hands_together, 'sequential_actions', a.sequential_actions,
                 'fast_follows', a.fast_follows, 'latency_corr', v_corr, 'follow_share', round(v_follow, 4)));
      IF coalesce(a.hands_together, 0) >= c_tc_min_hands AND coalesce(a.sequential_actions, 0) >= c_tc_min_seq
         AND (v_corr >= c_tc_min_corr OR v_follow >= c_tc_min_follow) THEN
        v_type := 'TIMING_CORRELATION';
        v_score := LEAST(100, round(40 + 50 * GREATEST(coalesce(v_corr, 0), coalesce(v_follow, 0))))::integer;
      END IF;
    END IF;
    CONTINUE WHEN v_type IS NULL;
    v_flagged := jsonb_set(v_flagged, ARRAY[v_type], to_jsonb((v_flagged ->> v_type)::integer + 1));
    v_ev := v_num || v_ctx || jsonb_build_object('source', 'engine', 'windows', a.windows,
              'aggregation_hours', c_agg_hours, 'latest_score', v_score,
              'latest_window_start', v_from, 'latest_window_end', v_to);

    -- ONE FINDING PER SUBJECT EXTENDS: the newest finding of the subject
    -- whose window meets the evidence's span. Its status is never touched.
    SELECT t.id, t.suspicion_score INTO v_cur
      FROM public.lightning_integrity_signal t
     WHERE t.cluster_id = p_cluster_id AND t.pattern_type = v_type AND t.player_a = a.player_a
       AND t.player_b IS NOT DISTINCT FROM a.player_b
       AND t.window_end >= a.w_from AND t.window_start <= a.w_to
     ORDER BY t.window_end DESC, t.id DESC
     LIMIT 1
       FOR UPDATE;
    IF NOT FOUND THEN
      v_id := NULL;
      INSERT INTO public.lightning_integrity_signal AS t
        (cluster_id, pattern_type, source, player_a, player_b, window_start, window_end,
         suspicion_score, severity, evidence)
      VALUES (p_cluster_id, v_type, 'engine', a.player_a, a.player_b, a.w_from, a.w_to, v_score,
              CASE WHEN v_score >= 70 THEN 'high' WHEN v_score >= 40 THEN 'medium' ELSE 'low' END, v_ev)
      ON CONFLICT (cluster_id, pattern_type, window_start, window_end, player_a, player_b) DO NOTHING
      RETURNING t.id INTO v_id;
      IF v_id IS NULL THEN
        v_same := v_same + 1;
      ELSE
        v_ins := v_ins + 1;
      END IF;
    ELSE
      v_peak := GREATEST(v_cur.suspicion_score::integer, v_score);
      UPDATE public.lightning_integrity_signal t
         SET window_start = LEAST(t.window_start, a.w_from), window_end = GREATEST(t.window_end, a.w_to),
             suspicion_score = v_peak,
             severity = CASE WHEN v_peak >= 70 THEN 'high' WHEN v_peak >= 40 THEN 'medium' ELSE 'low' END,
             evidence = v_ev, updated_at = now()
       WHERE t.id = v_cur.id
         AND (t.window_start, t.window_end, t.suspicion_score::integer, t.evidence)
             IS DISTINCT FROM (LEAST(t.window_start, a.w_from), GREATEST(t.window_end, a.w_to), v_peak, v_ev);
      IF FOUND THEN
        v_upd := v_upd + 1;
      ELSE
        v_same := v_same + 1;
      END IF;
    END IF;
  END LOOP;

  -- RETENTION: 48 hours of evidence, at most 5000 rows of this Cluster a call.
  DELETE FROM public.lightning_integrity_engine_window w
   WHERE w.id IN (SELECT x.id FROM public.lightning_integrity_engine_window x
                   WHERE x.cluster_id = p_cluster_id AND x.window_to < v_now - make_interval(hours => c_keep_hours)
                   ORDER BY x.window_to LIMIT 5000);
  GET DIAGNOSTICS v_pruned = ROW_COUNT;
$b$,
$b$                            'inserted', v_ins, 'updated', v_upd, 'unchanged', v_same,
                            'evidence_stored', v_stored, 'aggregation_hours', c_agg_hours,
                            'evidence_pruned', v_pruned,
$b$],
  ARRAY[1, 1, 1, 1]);

-- ===========================================================================
-- 5. THE SHADOW RECORD: a component null on either side is null on both, so
--    both scores are means over the same components.
-- ===========================================================================

SELECT pg_temp.lp11r_rewrite(
  'public.fn_lightning_shadow_record(uuid,text,text,timestamp with time zone,timestamp with time zone,jsonb,jsonb)',
  'LIKE FOR LIKE',
  ARRAY[
$a$  v_live_q := public.fn_lightning_quality_score(p_live, v_weights);
  v_shadow_q := public.fn_lightning_quality_score(p_shadow, v_weights);
$a$],
  ARRAY[
$b$  -- LIKE FOR LIKE (2026-10-09, Phase 11 remediation): a component either
  -- side could not measure (bb_fairness with no BB, an order the live side
  -- cannot see) is null on BOTH sides, so the two scores are weighted means
  -- over exactly the same components - fn_lightning_quality_score's own
  -- arithmetic over the shared set. The aligned components are the ones
  -- stored. Live 'm1' against shadow 'm1-port' is A/A calibration and is two
  -- versions; identical versions are still refused above (SAME_VERSION).
  SELECT coalesce(jsonb_object_agg(x.k, CASE WHEN b.paired THEN v_live_c -> x.k ELSE 'null'::jsonb END), '{}'::jsonb),
         coalesce(jsonb_object_agg(x.k, CASE WHEN b.paired THEN v_shadow_c -> x.k ELSE 'null'::jsonb END), '{}'::jsonb)
    INTO v_live_c, v_shadow_c
    FROM (SELECT jsonb_object_keys(coalesce(v_live_c, '{}'::jsonb)) AS k
          UNION SELECT jsonb_object_keys(coalesce(v_shadow_c, '{}'::jsonb))) x
   CROSS JOIN LATERAL (SELECT jsonb_typeof(v_live_c -> x.k) = 'number'
                              AND jsonb_typeof(v_shadow_c -> x.k) = 'number' AS paired) b;
  SELECT CASE WHEN sum(q.w) > 0 THEN round(100 * sum(q.w * q.l) / sum(q.w), 2) END,
         CASE WHEN sum(q.w) > 0 THEN round(100 * sum(q.w * q.s) / sum(q.w), 2) END
    INTO v_live_q, v_shadow_q
    FROM (SELECT (e.value #>> '{}')::numeric AS w, (v_live_c ->> e.key)::numeric AS l,
                 (v_shadow_c ->> e.key)::numeric AS s
            FROM jsonb_each(CASE WHEN jsonb_typeof(v_weights) = 'object' THEN v_weights ELSE '{}'::jsonb END) e
           WHERE jsonb_typeof(e.value) = 'number' AND (e.value #>> '{}')::numeric > 0
             AND jsonb_typeof(v_live_c -> e.key) = 'number' AND jsonb_typeof(v_shadow_c -> e.key) = 'number') q;
$b$],
  ARRAY[1]);

-- ===========================================================================
-- 6. THE SHADOW REPORT: only scored windows are comparisons; A/A is labelled.
-- ===========================================================================

SELECT pg_temp.lp11r_rewrite(
  'public.fn_lightning_shadow_report(uuid,timestamp with time zone,timestamp with time zone)',
  'WINDOWS WITHOUT BOTH SCORES ARE NOT COMPARISONS',
  ARRAY[
$a$           count(*) AS n,
$a$,
$a$           avg(c.live_quality_score) AS live_q,
           avg(c.shadow_quality_score) AS shadow_q,
$a$,
$a$           avg(CASE WHEN c.shadow_quality_score > c.live_quality_score THEN 1.0 ELSE 0.0 END) AS won,
$a$,
$a$           'comparisons', g.n,
$a$,
$a$             WHEN g.n < 30 THEN 'insufficient_evidence'
$a$,
$a$ORDER BY g.n DESC, g.lv, g.sv$a$],
  ARRAY[
$b$           -- WINDOWS WITHOUT BOTH SCORES ARE NOT COMPARISONS (2026-10-09,
           -- Phase 11 remediation): they count as windows, not toward the
           -- 30 comparisons a verdict needs, nor in the means.
           count(*) FILTER (WHERE c.live_quality_score IS NOT NULL AND c.shadow_quality_score IS NOT NULL) AS n,
           count(*) AS windows,
$b$,
$b$           avg(c.live_quality_score) FILTER (WHERE c.live_quality_score IS NOT NULL AND c.shadow_quality_score IS NOT NULL) AS live_q,
           avg(c.shadow_quality_score) FILTER (WHERE c.live_quality_score IS NOT NULL AND c.shadow_quality_score IS NOT NULL) AS shadow_q,
$b$,
$b$           avg(CASE WHEN c.shadow_quality_score > c.live_quality_score THEN 1.0 ELSE 0.0 END)
             FILTER (WHERE c.live_quality_score IS NOT NULL AND c.shadow_quality_score IS NOT NULL) AS won,
$b$,
$b$           'comparisons', g.n,
           'windows', g.windows,
           'aa_calibration', g.sv = g.lv || '-port',
$b$,
$b$             WHEN g.n < 30 THEN 'insufficient_evidence'
             WHEN g.sv = g.lv || '-port' THEN CASE WHEN abs(g.d_mean) <= 1 THEN 'calibrated' ELSE 'calibration_bias' END
$b$,
$b$ORDER BY (g.sv = g.lv || '-port'), g.n DESC, g.lv, g.sv$b$],
  ARRAY[1, 1, 1, 1, 1, 2]);

-- ===========================================================================
-- 7. THE SWEEP PASSES A TUMBLING WINDOW: the previous full UTC day, once a
--    UTC day per Cluster.
-- ===========================================================================

SELECT pg_temp.lp11r_rewrite(
  'public.fn_lightning_alert_sweep(timestamp with time zone)',
  'THE PREVIOUS FULL UTC DAY',
  ARRAY[
$a$  --    integrity_telemetry on and that is not frozen is scanned at most once
  --    per clock hour (the scan's own default window: the 24 hours before
  --    the current hour), at most five a pass, oldest first. It runs before
  --    the checks so its findings count in this pass.
$a$,
$a$       AND (st.last_at IS NULL OR st.last_at < date_trunc('hour', v_now))
$a$,
$a$        v_scan := public.fn_lightning_integrity_scan(c.id, NULL, NULL);
$a$],
  ARRAY[
$b$  --    integrity_telemetry on and that is not frozen is scanned once a UTC
  --    day over THE PREVIOUS FULL UTC DAY (a tumbling window, 2026-10-09
  --    Phase 11 remediation; it was the scan's rolling default every hour),
  --    at most five a pass, oldest first. A finding seen again on the next
  --    day extends its row. It runs before the checks so its findings count
  --    in this pass.
$b$,
$b$       AND (st.last_at IS NULL OR st.last_at < date_trunc('day', v_now, 'UTC'))
$b$,
$b$        v_scan := public.fn_lightning_integrity_scan(c.id, date_trunc('day', v_now, 'UTC') - interval '1 day', date_trunc('day', v_now, 'UTC'));
$b$],
  ARRAY[1, 1, 1]);

-- ===========================================================================
-- 8. THE OPERATOR'S CLUSTER VIEW lists a finding whose window reaches into
--    the view, not only one first detected in it (a finding now extends).
-- ===========================================================================

SELECT pg_temp.lp11r_rewrite(
  'public.fn_lightning_operator_cluster(uuid,timestamp with time zone,timestamp with time zone)',
  'A FINDING THAT EXTENDS INTO THE VIEW IS IN IT',
  ARRAY[
$a$           WHERE x.cluster_id = g.id AND x.detected_at >= v_from AND x.detected_at <= v_to
$a$],
  ARRAY[
$b$           -- A FINDING THAT EXTENDS INTO THE VIEW IS IN IT (2026-10-09, Phase 11 remediation).
           WHERE x.cluster_id = g.id AND x.window_end >= v_from AND x.detected_at <= v_to
$b$],
  ARRAY[1]);

-- ===========================================================================
-- 9. READ BACK.
-- ===========================================================================

DO $readback$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(q.what, '; ') INTO v_bad FROM (VALUES
    ('the engine evidence store is closed to every role', (SELECT c.relrowsecurity
       AND NOT has_table_privilege('anon', c.oid, 'SELECT') AND NOT has_table_privilege('authenticated', c.oid, 'SELECT')
       AND NOT has_table_privilege('service_role', c.oid, 'SELECT') AND NOT has_table_privilege('service_role', c.oid, 'INSERT')
       AND NOT has_sequence_privilege('service_role', 'public.lightning_integrity_engine_window_id_seq', 'USAGE')
       AND NOT has_sequence_privilege('anon', 'public.lightning_integrity_engine_window_id_seq', 'USAGE')
       AND NOT has_sequence_privilege('authenticated', 'public.lightning_integrity_engine_window_id_seq', 'USAGE')
       FROM pg_class c WHERE c.oid = 'public.lightning_integrity_engine_window'::regclass)),
    ('seven Lightning tables are granted to the service, none to a player', (SELECT count(*) = 7
       FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name LIKE 'lightning\_%'
        AND grantee = 'service_role' AND privilege_type = 'SELECT')
       AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public'
                        AND table_name LIKE 'lightning\_%' AND grantee IN ('anon', 'authenticated', 'PUBLIC'))),
    ('the mirror is one row per finding', (SELECT i.indisunique FROM pg_index i
       WHERE i.indexrelid = 'public.ca_collusion_signals_one_per_lightning_finding'::regclass)),
    ('the integrity doors are the service''s alone', (SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
       AND count(*) = 5
       FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_integrity_scan(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure,
         'public.fn_lightning_integrity_report(uuid,jsonb,timestamp with time zone)'::regprocedure,
         'public.fn_lightning_shadow_record(uuid,text,text,timestamp with time zone,timestamp with time zone,jsonb,jsonb)'::regprocedure,
         'public.fn_lightning_shadow_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure,
         'public.fn_lightning_alert_sweep(timestamp with time zone)'::regprocedure))),
    ('the operator detail door is authenticated and service, never anon', (SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       FROM pg_proc p WHERE p.oid = 'public.fn_lightning_operator_cluster(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)),
    ('no seating path reads the stores', (SELECT bool_and(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g')
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
         AND p.proname IN ('fn_lightning_integrity_scan', 'fn_lightning_integrity_report', 'fn_lightning_shadow_record',
                           'fn_lightning_shadow_report', 'fn_lightning_alert_sweep', 'fn_lightning_operator_cluster')
         AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id')))
  ) q(what, ok) WHERE q.ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIGHTNING_P11R_READBACK: the catalogue does not carry: %', v_bad;
  END IF;
END
$readback$;

COMMIT;
