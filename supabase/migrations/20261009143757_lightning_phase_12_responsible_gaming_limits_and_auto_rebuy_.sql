-- 20261009143757_lightning_phase_12_responsible_gaming_limits_and_auto_rebuy_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- LIGHTNING PHASE 12, DATABASE CARRY-FORWARD (handoff Section 11 Order 2):
-- RESPONSIBLE GAMING LIMITS AT THE LIGHTNING DOOR, AND THE AUTO-REBUY STATUS
-- LINE THE CLIENT COULD NEVER READ.
--
-- ITEM 1. RESPONSIBLE GAMING LIMITS: VERIFIED AGAINST THE CASH PATH FIRST.
--
-- Read from PokerIQ-Production on 2026-10-09 (pg_get_functiondef, pg_trigger,
-- information_schema), the rule being "Lightning enforces exactly what normal
-- cash enforces, through the same helpers":
--
--   a. responsible_gaming_limits carries daily/weekly/monthly_deposit_limit,
--      daily_loss_limit, session_time_limit_minutes,
--      reality_check_interval_minutes, self_excluded_until and
--      cooling_off_until. It has NO stake-limit column and NO mandated-break
--      column; cooling_off_until is the platform's break. It holds 0 rows.
--   b. THE CASH SIT-DOWN, BUY-IN AND REBUY PATH CONSULTS NO fn_rg_* HELPER AT
--      ALL: fn_cash_game_join(uuid), atomic_table_buyin(...) and its
--      _before_maintenance_announcement_gate body, atomic_table_rebuy(...)
--      and its gate body reference neither responsible_gaming_limits nor any
--      fn_rg_* function. The only gate the cash seat door carries is the
--      account-restriction trigger zz_restriction_seat_guard /
--      zz_restriction_seat_revive_guard on table_seats
--      (fn_ca_refuse_restricted_entry -> fn_ca_player_restricted, refusing
--      only when ca_operator_policy.restrictions_enforced), which
--      fn_lightning_player_legality already mirrors as RESTRICTED.
--   c. daily_loss_limit is read by NO function in the database.
--      session_time_limit_minutes is read only by
--      fn_rg_should_show_reality_check, the World Hub's per-page-load UI
--      predicate, which WRITES (it force-closes the Hub's
--      responsible_gaming_sessions row and appends reality_check_shown_at)
--      and keys on a session only the Hub's /api/rg/session/start opens.
--      Deposit limits are read only by fn_rg_check_deposit, which nothing in
--      the database calls; a rebuy is a club-wallet debit, not a deposit.
--   d. Lightning ALREADY consults the one read-only RG helper that exists,
--      fn_rg_require_not_excluded (self-exclusion and cooling-off), at every
--      door: fn_lightning_pool_enter (Phase 10), fn_lightning_player_legality
--      (RG_EXCLUDED, Phase 6), fn_lightning_auto_rebuy (Phase 10, before
--      public.atomic_table_rebuy). That is a superset of what cash enforces.
--
-- So no limit is invented here. Stake limits, session-time limits, loss
-- limits and mandated breaks are NOT enforced by normal cash; matching the
-- cash path exactly means Lightning does not enforce them either, and the gap
-- is recorded in docs/changelog/2026-10-09-lightning-phase-12-rg-limits.md for
-- the platform to close in BOTH places through one shared helper. Calling
-- fn_rg_should_show_reality_check from the engine path would mutate the Hub's
-- reality-check record and is refused for that reason; re-deriving loss or
-- session time in a Lightning body would be the second implementation the
-- order forbids. A live proof below pins the parity as containment: every
-- fn_rg_* helper the cash sit-down/buy-in path calls is also called by the
-- Lightning pool door, and every one the cash rebuy path calls by the
-- auto-rebuy door, so the day cash gains a limit helper this proof turns
-- false until Lightning calls it too.
--
-- WHAT WAS REALLY MISSING, AND LANDS HERE: THE LIMIT ENDS THE SESSION LIKE
-- STOP PLAYING. A player whose self-exclusion or cooling-off begins
-- mid-session was refused RG_EXCLUDED on every matcher pass and then sat in
-- the pool forever, open, never dealt, never told. Now
-- fn_lightning_reap_expired_disconnects (already wired into
-- fn_cash_clusters_tick_all, the post-hand exit machinery Stop Playing uses)
-- also finishes a session whose player fn_rg_require_not_excluded refuses,
-- under exactly the Stop Playing discipline: the current hand is never cut
-- short (a player in a live hand or holding a live reservation is skipped
-- and exits on the first pass after the hand lets go; the legality chain
-- already refuses RG_EXCLUDED ahead of IN_HAND, so no new hand is dealt),
-- never cashed out (the anchor seat and the cash session are untouched,
-- exactly as a stop exit), frozen Clusters skipped, SKIP LOCKED, per-item
-- isolation, one pool_player_left in the anchor-seat payload shape. The exit
-- carries the distinct exit_reason 'rg_limit' (pool_player_left reason
-- 'rg_limit'), and it is never counted into the player_expired record. A
-- standing Stop Playing request keeps its own reason ('stop_playing' wins:
-- the player chose first). The helper is the SAME fn_rg_require_not_excluded;
-- an EXISTS on responsible_gaming_limits.user_id (the helper's own primary
-- key) only spares the call for the overwhelming majority with no row, for
-- whom the helper answers ok by construction.
--
-- ITEM 2. THE AUTO-REBUY STATUS LINE. The client read fn_lightning_config,
-- which is service_role only (pinned by the Phase 6 matcher proof), so
-- "Auto-Rebuy: ..." never displayed. fn_lightning_pool_status(uuid) (the
-- authenticated browser door, SECURITY DEFINER, already reading
-- fn_lightning_config as its owner) gains one read-only key, so the clamps
-- and validation stay in fn_lightning_config alone:
--
--   auto_rebuy: { enabled: boolean, trigger: 'zero'|'below_bb'|'below_pct',
--                 threshold_bb: number, threshold_pct: number,
--                 target: 'initial'|'max', max_count: integer,
--                 session_cap: number (0 = uncapped),
--                 used_count: integer|null, used_total: number|null }
--
-- used_* are the CALLER'S OWN open pool session's auto_rebuys and
-- auto_rebuy_total in that Cluster (auth.uid() scoped), null when the caller
-- has none (and for a service_role caller). The existing keys (players,
-- status, joinable, multi_table_limit) are unchanged and cluster_mode is
-- still never answered. fn_lightning_config's grants are NOT loosened.
--
-- LIGHTNING IS OFF EVERYWHERE (lightning_enabled false on all 166 Clusters,
-- no open pool session). The reaper widening only ever touches open
-- lightning_pool_session rows of a player with a live exclusion or
-- cooling-off; pool_status gains a read. Non-Lightning cash play is
-- unchanged.
--
-- HOUSE RULES OBSERVED. One BEGIN/COMMIT with SET LOCAL lock_timeout. No
-- table is altered or created (Phase 2's seven-tables proof stands). Both
-- body changes (fn_lightning_reap_expired_disconnects,
-- fn_lightning_pool_status) are asserted substitutions into the bodies
-- production carries (read with pg_get_functiondef on 2026-10-09, after
-- 20261008161509): each anchor must appear exactly as often as stated or the
-- file refuses, and a body already carrying its marker is left alone, so the
-- file is re-appliable. Same signatures, so ACLs are kept by CREATE OR
-- REPLACE and read back per role with has_function_privilege. No predecessor
-- live proof is falsified. Untouched: fn_lightning_config,
-- fn_cash_clusters_tick_all, fn_lightning_player_legality (the
-- anti-manipulation pin over it still holds), fn_lightning_pool_enter,
-- fn_lightning_auto_rebuy, and every operator/alert door.
--
-- LAW 10.5. Nothing here reads is_horse or horse_id. A horse with a
-- self-exclusion or cooling-off is held and exited exactly as a human, and a
-- horse reads its own auto-rebuy status exactly as a human.
--
-- @live-proof: (SELECT NOT p.prosecdef AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND s ~ '''rg_limit''' AND s ~ 'public\.fn_rg_require_not_excluded\(ps\.player_id\)' AND s ~ 'OR rg\.refused\)' AND s ~ '\(x ->> ''rg_limit''\)::boolean IS NOT TRUE' AND s ~ 'fn_lightning_player_in_hand\(s\.player_id, s\.cluster_id\)' AND s ~ 'FOR UPDATE OF ps SKIP LOCKED' AND s ~ 'fz\.cluster_mode = ''frozen''' FROM pg_proc p, LATERAL (SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') AS s) q WHERE p.oid = 'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure)
-- @live-proof: (SELECT count(*) = 4 AND bool_and(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'public\.fn_rg_require_not_excluded\(') FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_pool_enter(uuid,timestamp with time zone)'::regprocedure, 'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure, 'public.fn_lightning_auto_rebuy(uuid,uuid,timestamp with time zone)'::regprocedure, 'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN LATERAL regexp_matches(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g'), '(fn_rg_[a-z_]+)\(', 'g') m WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_cash_game_join', 'atomic_table_buyin', 'atomic_table_buyin_before_maintenance_announcement_gate', 'atomic_table_rebuy', 'atomic_table_rebuy_before_maintenance_announcement_gate') AND position(m[1] || '(' in CASE WHEN p.proname LIKE 'atomic\_table\_rebuy%' THEN pg_get_functiondef('public.fn_lightning_auto_rebuy(uuid,uuid,timestamp with time zone)'::regprocedure) ELSE pg_get_functiondef('public.fn_lightning_pool_enter(uuid,timestamp with time zone)'::regprocedure) END) = 0))
-- @live-proof: (SELECT position('THEN ''RG_EXCLUDED''' in s) > 0 AND position('THEN ''RG_EXCLUDED''' in s) < position('THEN ''IN_HAND''' in s) FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT p.prosecdef AND p.provolatile = 's' AND p.proconfig::text ~ 'search_path' AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND s ~ 'auth\.uid\(\)' AND s ~ '''auto_rebuy'', jsonb_build_object\(' AND s ~ '''enabled'', v_cfg -> ''auto_rebuy_enabled''' AND s ~ '''trigger'', v_cfg -> ''auto_rebuy_trigger''' AND s ~ '''threshold_bb'', v_cfg -> ''auto_rebuy_threshold_bb''' AND s ~ '''threshold_pct'', v_cfg -> ''auto_rebuy_threshold_pct''' AND s ~ '''target'', v_cfg -> ''auto_rebuy_target''' AND s ~ '''max_count'', v_cfg -> ''auto_rebuy_max_count''' AND s ~ '''session_cap'', v_cfg -> ''auto_rebuy_session_cap''' AND s ~ '''used_count'', to_jsonb\(v_ar_used\)' AND s ~ '''used_total'', to_jsonb\(v_ar_total\)' AND s ~ 'ps\.player_id = v_uid' AND s ~ '''joinable''' AND s ~ '''multi_table_limit'', v_cfg -> ''multi_table_limit''' AND s !~ '''cluster_mode'', g\.cluster_mode' AND s !~ 'INSERT INTO|UPDATE public|DELETE FROM|is_horse|horse_id|lightning_instance_id' FROM pg_proc p, LATERAL (SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') AS s) q WHERE p.oid = 'public.fn_lightning_pool_status(uuid)'::regprocedure)
-- @live-proof: (SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) AND count(*) = 4 FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_config(uuid)'::regprocedure, 'public.fn_lightning_pool_enter(uuid,timestamp with time zone)'::regprocedure, 'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure, 'public.fn_lightning_auto_rebuy(uuid,uuid,timestamp with time zone)'::regprocedure))
-- @live-proof: (SELECT bool_and(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') !~ 'integrity|shadow_comparison|quality_') AND count(*) = 8 FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure, 'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure, 'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text,jsonb)'::regprocedure, 'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)'::regprocedure, 'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure, 'public.fn_cash_clusters_tick_all(jsonb)'::regprocedure, 'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure, 'public.fn_lightning_pool_status(uuid)'::regprocedure))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_lightning_reap_expired_disconnects', 'fn_lightning_pool_status', 'fn_lightning_player_legality', 'fn_lightning_pool_enter', 'fn_lightning_auto_rebuy', 'fn_rg_require_not_excluded') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id'))

BEGIN;

SET LOCAL lock_timeout = '2s';

-- ===========================================================================
-- 1. THE REWRITER, in the shape 20261008111425 cut it: an asserted
--    substitution into the body production carries. Every anchor must
--    appear exactly as often as stated or the file refuses. Both changes
--    keep their signatures, so the old-vs-new arms stay dormant; a body
--    already carrying the marker is left alone, so the file is re-appliable.
-- ===========================================================================

CREATE OR REPLACE FUNCTION pg_temp.lp12_rewrite(p_old text, p_new text, p_marker text,
                                    p_from text[], p_to text[], p_counts integer[])
RETURNS void LANGUAGE plpgsql AS $rw$
DECLARE
  v_same    boolean := p_old = p_new;
  v_src     text;
  v_new     text;
  v_n       integer;
  k         integer;
  v_roles   constant text[] := ARRAY['anon', 'authenticated', 'service_role'];
  v_had     boolean[];
  v_bad     text;
  v_comment text;
BEGIN
  IF NOT v_same AND to_regprocedure(p_new) IS NOT NULL THEN
    IF to_regprocedure(p_old) IS NOT NULL THEN
      RAISE EXCEPTION '% and % both exist; refusing to guess which one callers reach', p_old, p_new;
    END IF;
    IF position(p_marker in pg_get_functiondef(p_new::regprocedure)) = 0 THEN
      RAISE EXCEPTION '% exists without %', p_new, p_marker;
    END IF;
    RETURN;
  END IF;
  v_src := pg_get_functiondef(p_old::regprocedure);
  IF v_same AND position(p_marker in v_src) > 0 THEN
    RETURN;
  END IF;
  v_new := v_src;
  FOR k IN 1 .. array_length(p_from, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_from[k], ''))) / length(p_from[k]);
    IF v_n IS DISTINCT FROM p_counts[k] THEN
      RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', p_old, k, v_n, p_counts[k];
    END IF;
    v_new := replace(v_new, p_from[k], p_to[k]);
  END LOOP;
  SELECT array_agg(has_function_privilege(t.r, p_old::regprocedure, 'EXECUTE') ORDER BY t.ord)
    INTO v_had FROM unnest(v_roles) WITH ORDINALITY t(r, ord);
  v_comment := obj_description(p_old::regprocedure, 'pg_proc');
  IF NOT v_same THEN
    EXECUTE format('DROP FUNCTION %s', p_old);
  END IF;
  EXECUTE v_new;
  IF NOT v_same THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', p_new);
    FOR k IN 1 .. array_length(v_roles, 1) LOOP
      IF v_had[k] THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', p_new, v_roles[k]);
      END IF;
    END LOOP;
    IF v_comment IS NOT NULL THEN
      EXECUTE format('COMMENT ON FUNCTION %s IS %L', p_new, v_comment);
    END IF;
  END IF;
  -- WHO MAY EXECUTE IS KEPT, read back per role (never acl::text), on the
  -- same-signature path too: production's autorevoke trigger fires on
  -- CREATE FUNCTION, and a door that silently lost or gained a role is a
  -- refusal here, not a surprise in production.
  SELECT string_agg(t.r || ': had ' || v_had[t.ord] || ', has '
                    || has_function_privilege(t.r, p_new::regprocedure, 'EXECUTE'), '; ')
    INTO v_bad
    FROM unnest(v_roles) WITH ORDINALITY t(r, ord)
   WHERE has_function_privilege(t.r, p_new::regprocedure, 'EXECUTE') IS DISTINCT FROM v_had[t.ord];
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '% did not keep who may execute it (%)', p_new, v_bad;
  END IF;
  IF position(p_marker in pg_get_functiondef(p_new::regprocedure)) = 0 THEN
    RAISE EXCEPTION '% does not read back carrying %', p_new, p_marker;
  END IF;
END
$rw$;

-- ===========================================================================
-- 2. fn_lightning_reap_expired_disconnects ALSO FINISHES A SESSION THE
--    RESPONSIBLE-GAMING HELPER REFUSES, exactly as it finishes a Stop
--    Playing request: the moment the player holds no live hand and no live
--    reservation, exit_reason 'rg_limit', same skip rules, locks, per-item
--    isolation and pool_player_left discipline, never counted into the
--    player_expired record, never touching the anchor seat or cash session.
-- ===========================================================================

SELECT pg_temp.lp12_rewrite(
  'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)',
  'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)',
  '''rg_limit''',
  ARRAY[$a$           ps.disconnected_at, ps.stop_requested_at, cfg.timeout_ms
$a$,
        $a$                      AS timeout_ms) cfg ON true
$a$,
        $a$            OR ps.stop_requested_at IS NOT NULL)
$a$,
        $a$     ORDER BY LEAST(coalesce(ps.disconnected_at, ps.stop_requested_at),
                    coalesce(ps.stop_requested_at, ps.disconnected_at)), ps.id
$a$,
        $a$             exit_reason = CASE WHEN s.stop_requested_at IS NOT NULL
                                THEN 'stop_playing' ELSE 'disconnect_expired' END,
$a$,
        $a$        'reason', CASE WHEN s.stop_requested_at IS NOT NULL
                       THEN 'stop_playing' ELSE 'disconnect_expired' END,
$a$,
        $a$        'stopped', s.stop_requested_at IS NOT NULL,
$a$,
        $a$           jsonb_agg(x - 'cluster_id' - 'cluster_epoch' - 'stopped' ORDER BY x ->> 'player_id') AS players
$a$,
        $a$     WHERE (x ->> 'stopped')::boolean IS NOT TRUE
$a$],
  ARRAY[$b$           ps.disconnected_at, ps.stop_requested_at, cfg.timeout_ms, rg.refused AS rg_refused
$b$,
        $b$                      AS timeout_ms) cfg ON true
      -- LIGHTNING PHASE 12 (20261009143757): RESPONSIBLE GAMING ENDS THE
      -- SESSION, NOT ONLY THE NEXT DEAL. The SAME helper every Lightning door
      -- consults (fn_rg_require_not_excluded: self-exclusion, cooling-off);
      -- the EXISTS on its own primary key only spares the call for a player
      -- with no limits row, whom the helper answers ok by construction.
      JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM public.responsible_gaming_limits rgl
                                    WHERE rgl.user_id = ps.player_id)
                           AND (public.fn_rg_require_not_excluded(ps.player_id) ->> 'ok')::boolean IS DISTINCT FROM true
                      AS refused) rg ON true
$b$,
        $b$            OR ps.stop_requested_at IS NOT NULL
            -- LIGHTNING PHASE 12: a player responsible gaming refuses is
            -- finished like a stopper, the moment the hand lets go.
            OR rg.refused)
$b$,
        $b$     ORDER BY coalesce(LEAST(coalesce(ps.disconnected_at, ps.stop_requested_at),
                             coalesce(ps.stop_requested_at, ps.disconnected_at)), ps.entered_at), ps.id
$b$,
        $b$             exit_reason = CASE WHEN s.stop_requested_at IS NOT NULL THEN 'stop_playing'
                                WHEN s.rg_refused THEN 'rg_limit'
                                ELSE 'disconnect_expired' END,
$b$,
        $b$        'reason', CASE WHEN s.stop_requested_at IS NOT NULL THEN 'stop_playing'
                       WHEN s.rg_refused THEN 'rg_limit'
                       ELSE 'disconnect_expired' END,
$b$,
        $b$        'stopped', s.stop_requested_at IS NOT NULL,
        'rg_limit', s.stop_requested_at IS NULL AND coalesce(s.rg_refused, false),
$b$,
        $b$           jsonb_agg(x - 'cluster_id' - 'cluster_epoch' - 'stopped' - 'rg_limit' ORDER BY x ->> 'player_id') AS players
$b$,
        $b$     WHERE (x ->> 'stopped')::boolean IS NOT TRUE
     -- Nor is a session responsible gaming ended (Phase 12).
       AND (x ->> 'rg_limit')::boolean IS NOT TRUE
$b$],
  ARRAY[1, 1, 1, 1, 1, 1, 1, 1, 1]);

COMMENT ON FUNCTION public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer) IS
  'Lightning Phase 9 (spec Phase 14), widened by Phase 10 and Phase 12. Exits every open pool session that is (a) disconnected longer than its Cluster''s disconnect_timeout_ms (exit_reason disconnect_expired), (b) carrying a Stop Playing request (exit_reason stop_playing), or (c) refused by the responsible-gaming helper fn_rg_require_not_excluded, self-exclusion or cooling-off (exit_reason rg_limit), whose player is not in a live hand and holds no live reservation: state closed, slot closed, one pool_player_left per session (reason = the exit_reason) and one player_expired event per Cluster per call for (a) alone. Releases nothing in-hand, never touches the anchor seat or the cash session, skips frozen Clusters. Clock-guarded, bounded (2000), SKIP LOCKED, each session isolated in its own sub-block. Run by fn_cash_clusters_tick_all beside the formation reaper; service_role only.';

-- ===========================================================================
-- 3. fn_lightning_pool_status ANSWERS THE AUTO-REBUY STATUS, read-only, from
--    fn_lightning_config (its clamps, its validation) and the caller's own
--    open pool session. The existing four keys are unchanged; cluster_mode
--    is still never answered.
-- ===========================================================================

SELECT pg_temp.lp12_rewrite(
  'public.fn_lightning_pool_status(uuid)',
  'public.fn_lightning_pool_status(uuid)',
  '''auto_rebuy'', jsonb_build_object(',
  ARRAY[$a$  v_status  text;
$a$,
        $a$  RETURN jsonb_build_object('players', v_live, 'status', v_status,
$a$,
        $a$    'multi_table_limit', v_cfg -> 'multi_table_limit');
$a$],
  ARRAY[$b$  v_status  text;
  v_ar_used  integer;
  v_ar_total numeric;
$b$,
        $b$  -- LIGHTNING PHASE 12 (20261009143757): THE AUTO-REBUY STATUS LINE. The
  -- client cannot read fn_lightning_config (service_role only, and it stays
  -- so); this door already reads it as its owner, so the settings come from
  -- there (its clamps, its validation) and the usage from the CALLER'S OWN
  -- open pool session in this Cluster, null without one.
  SELECT ps.auto_rebuys, ps.auto_rebuy_total INTO v_ar_used, v_ar_total
    FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = g.id AND ps.player_id = v_uid AND ps.exited_at IS NULL
   ORDER BY ps.entered_at DESC, ps.id
   LIMIT 1;
  RETURN jsonb_build_object('players', v_live, 'status', v_status,
$b$,
        $b$    'multi_table_limit', v_cfg -> 'multi_table_limit',
    'auto_rebuy', jsonb_build_object(
      'enabled', v_cfg -> 'auto_rebuy_enabled',
      'trigger', v_cfg -> 'auto_rebuy_trigger',
      'threshold_bb', v_cfg -> 'auto_rebuy_threshold_bb',
      'threshold_pct', v_cfg -> 'auto_rebuy_threshold_pct',
      'target', v_cfg -> 'auto_rebuy_target',
      'max_count', v_cfg -> 'auto_rebuy_max_count',
      'session_cap', v_cfg -> 'auto_rebuy_session_cap',
      'used_count', to_jsonb(v_ar_used),
      'used_total', to_jsonb(v_ar_total)));
$b$],
  ARRAY[1, 1, 1]);

COMMENT ON FUNCTION public.fn_lightning_pool_status(uuid) IS
  'Lightning Phase 8, contract tightened by 20261008043021, auto_rebuy added by 20261009143757. Player-facing pool status {players, status, joinable, multi_table_limit, auto_rebuy}: players is the live eligible count; status is lightning at or above the large diversity band HOT, at or above the medium band ACTIVE, below it or pending_off THIN, every other mode BUILDING; joinable is true only for an enabled Lightning Cluster in lightning mode; multi_table_limit is the configured {desktop, tablet, mobile} object the client entry door enforces; auto_rebuy is {enabled, trigger, threshold_bb, threshold_pct, target, max_count, session_cap} exactly as fn_lightning_config answers them plus {used_count, used_total} from the caller''s own open pool session in this Cluster (null without one). Never the raw cluster_mode. Visible to whoever the lobby policy cash_games_read shows the Cluster to.';

-- ===========================================================================
-- 4. READ BACK.
-- ===========================================================================

DO $readback$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(q.what, '; ') INTO v_bad FROM (VALUES
    ('the reaper finishes a responsible-gaming refusal through the same helper', (SELECT s ~ '''rg_limit'''
       AND s ~ 'public\.fn_rg_require_not_excluded\(ps\.player_id\)' AND s ~ 'OR rg\.refused\)'
       AND s ~ '\(x ->> ''rg_limit''\)::boolean IS NOT TRUE' AND s ~ '\(x ->> ''stopped''\)::boolean IS NOT TRUE'
       AND s ~ '''stop_playing''' AND s ~ '''disconnect_expired''' AND s ~ 'FOR UPDATE OF ps SKIP LOCKED'
       FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q2)),
    ('the reaper is the engine''s alone', (SELECT NOT p.prosecdef
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       FROM pg_proc p WHERE p.oid = 'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure)),
    ('pool status answers auto_rebuy and stays a caller-scoped browser door', (SELECT p.prosecdef
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND pg_get_functiondef(p.oid) ~ '''auto_rebuy'', jsonb_build_object\('
       AND pg_get_functiondef(p.oid) ~ 'ps\.player_id = v_uid'
       AND pg_get_functiondef(p.oid) !~ '''cluster_mode'', g\.cluster_mode'
       FROM pg_proc p WHERE p.oid = 'public.fn_lightning_pool_status(uuid)'::regprocedure)),
    ('the configuration reader is still the service''s alone', (SELECT has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       FROM pg_proc p WHERE p.oid = 'public.fn_lightning_config(uuid)'::regprocedure)),
    ('no horse is singled out', (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f'
         AND p.proname IN ('fn_lightning_reap_expired_disconnects', 'fn_lightning_pool_status')
         AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id')))
  ) q(what, ok) WHERE q.ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIGHTNING_P12_RG_LIMITS_READBACK: the catalogue does not carry: %', v_bad;
  END IF;
END
$readback$;

COMMIT;
