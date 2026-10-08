-- 20261007212735_lightning_phase_8_multi_table_limits_session_statistics_pool.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- LIGHTNING PHASE 8 OF 14 (SPECIFICATION PHASES 11, 12 AND 13, THE DATABASE
-- SIDE): MULTI-TABLE LIMITS PER PLATFORM, SESSION STATISTICS, POOL STATUS FOR
-- PLAYERS, THE SESSION SUMMARY AND RECENT HANDS.
--
-- Multi-table Lightning is one player playing in several Clusters at once,
-- each with its own pool session and anchor seat. Nothing here lets one
-- Cluster deal the same player two hands at once beyond what fast fold
-- already allows.
--
-- 1. fn_lightning_config answers multi_table_limit as an object
--    {desktop, tablet, mobile}, defaults 4, 3 and 2, each clamped to 1..8. The
--    old scalar configuration is still read: a number is the limit of every
--    platform. A bad value falls back and is reported in 'invalid' exactly as
--    every other key is.
--
-- 2. fn_lightning_player_legality, fn_lightning_match_plan, fn_lightning_match
--    and fn_lightning_match_and_form take a trailing optional
--    p_player_platforms jsonb DEFAULT NULL ({player_id: 'desktop'|'tablet'|
--    'mobile'}; missing or anything else is desktop). MULTI_TABLE_LIMIT uses
--    the limit of that player's platform, counting the player's live Lightning
--    hands in other Clusters exactly as before, and its detail names the
--    platform. Each is dropped and recreated from the body production
--    carries (an asserted substitution). Who may execute it (anon,
--    authenticated, service_role, asked with has_function_privilege) and its
--    comment are carried over and asserted SEMANTICALLY, never as ACL text:
--    production's default privileges hand every new public function to anon,
--    authenticated and service_role at birth, and the autorevoke event
--    trigger rewrites ACLs after CREATE FUNCTION, so the aclitem[] of a
--    correct carry-over is not byte-stable (the first apply was refused
--    exactly there on 2026-10-07). Every caller that passes the old
--    arguments, positionally or by name, keeps working.
--
-- 3. lightning_hand_player.waited_ms: set at formation, by a BEFORE INSERT
--    trigger, from the slot's idle_since to the hand's formed_at, and final
--    afterwards. lightning_hand_player.showed: written by fn_lightning_settle_
--    hand (an asserted substitution) from the engine's own 'showed' result,
--    final once written. Both feed the statistics and recent hands below;
--    neither is money.
--
-- 4. Five browser doors, SECURITY DEFINER with a pinned search_path, each
--    asking auth.uid() (and auth.role() for the engine's service role):
--      fn_lightning_session_stats(pool_session)    owner, or service_role
--      fn_lightning_session_summary(pool_session)  owner, or service_role
--      fn_lightning_my_sessions()                  the caller's open sessions
--      fn_lightning_pool_status(cluster)           anyone who can see the Cluster
--      fn_lightning_recent_hands(limit, session)   the caller's own hands
--    None returns an instance id, another player's cards, stack, result or
--    eligibility, or a matcher internal. A caller asking about a session that
--    is not theirs gets NULL (or an empty list), the same answer as a session
--    that does not exist.
--
-- THE ONE SOURCE OF TRUTH. Session statistics are read from the hand rows the
-- settlement writes (lightning_hand_player), the hand_history row it commits
-- through the physical door, and VPIP and PFR from ca_hand_facts, the same
-- per-hand per-player facts the cash VPIP gate (fn_cash_vpip_status) and the
-- player statistics read, keyed by hand_history id. A hand whose facts are not
-- projected yet does not count toward VPIP or PFR; with none, both are null.
-- Nothing here writes a statistic, so entering or leaving Lightning resets no
-- Cluster-level statistic (the statistics reset rule).
--
-- POOL STATUS MAPPING. From fn_cash_cluster_pool_health (the one population
-- reader) and the Cluster's own diversity bands in fn_lightning_config
-- (medium = ON, large = twice ON by default):
--    lightning, live eligible at or above the large band  -> HOT
--    lightning, live eligible at or above the medium band -> ACTIVE
--    lightning below the medium band, or pending_off      -> THIN
--    every other mode (must_move, pending_on, opening,
--    frozen, paused, created, draining, dead)              -> BUILDING
-- players is that live eligible count. Visibility is the lobby's own rule,
-- the cash_games_read policy: a Cluster is visible unless its ruleset marks it
-- private, and a private one to members of its club.
--
-- LAW 10.5. Nothing here reads is_horse or horse_id. A horse's hands, waits,
-- statistics and limits are exactly a human's.
--
-- HOUSE RULES OBSERVED. One BEGIN/COMMIT with SET LOCAL lock_timeout. The
-- only table altered is lightning_hand_player; neither tables nor table_seats
-- is locked by this file. Every change to an existing body is an asserted
-- substitution into the body production carries (read with
-- pg_get_functiondef): each anchor must appear exactly as often as stated or
-- the file refuses, and a body already carrying the change is left alone, so
-- the file is re-appliable.
--
-- @live-proof: (SELECT count(*) = 2 FROM pg_attribute a WHERE a.attrelid = 'public.lightning_hand_player'::regclass AND NOT a.attisdropped AND ((a.attname = 'waited_ms' AND a.atttypid = 'integer'::regtype) OR (a.attname = 'showed' AND a.atttypid = 'boolean'::regtype))) AND (SELECT t.tgenabled = 'O' AND t.tgfoid = 'public.fn_lightning_hand_player_records_its_wait()'::regprocedure FROM pg_trigger t WHERE t.tgrelid = 'public.lightning_hand_player'::regclass AND t.tgname = 'trg_hand_player_records_its_wait')
-- @live-proof: (SELECT public.fn_lightning_config(NULL) -> 'multi_table_limit' = '{"desktop": 4, "tablet": 3, "mobile": 2}'::jsonb AND regexp_replace(pg_get_functiondef('public.fn_lightning_config(uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') ~ '''multi_table_limit'', v_mtl_obj')
-- @live-proof: (SELECT to_regprocedure('public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[])') IS NULL AND to_regprocedure('public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer)') IS NULL AND to_regprocedure('public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text)') IS NULL AND to_regprocedure('public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid)') IS NULL)
-- @live-proof: (SELECT count(*) = 4 AND bool_and(NOT p.prosecdef AND p.pronargdefaults >= 1 AND pg_get_function_identity_arguments(p.oid) ~ 'p_player_platforms jsonb$' AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND p.proconfig IS NOT NULL) FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure, 'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)'::regprocedure, 'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text,jsonb)'::regprocedure, 'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure))
-- @live-proof: (SELECT p.provolatile = 's' AND s ~ 'fn_lightning_anchor_is_live_eligible\(f\.anchor_seat_id, f\.cluster_id, f\.player_id\)' AND s ~ 'fn_ca_player_restricted\(f\.player_id, ''cash''\)' AND s ~ 'restrictions_enforced' AND s ~ 'fn_rg_require_not_excluded\(f\.player_id\)' AND s ~ 'fn_lightning_player_in_hand\(f\.player_id, f\.cluster_id\)' AND s ~ 'fn_platform_frozen\(\)' AND s ~ 'fn_lightning_pool_stack\(f\.pool_session_id\)' AND s ~ 'p_player_platforms ->> ps\.player_id::text' AND s ~ '>= f\.multi_table_limit THEN ''MULTI_TABLE_LIMIT''' AND s ~ '''platform'', c\.platform' FROM pg_proc p, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q WHERE p.oid = 'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure)
-- @live-proof: (SELECT a.provolatile = 's' AND a.prorettype = 'jsonb'::regtype AND pg_get_functiondef(a.oid) ~ 'fn_lightning_match_plan\(p_cluster_id, p_now, p_disconnected, p_matcher_version, NULL, p_player_platforms\)' AND b.provolatile = 's' AND sb ~ 'fn_lightning_blind_order\(p_cluster_id, v_epoch' AND (SELECT count(*) FROM regexp_matches(sb, 'fn_lightning_player_legality\(p_cluster_id, v_now, p_disconnected, p_player_platforms\)', 'g')) = 2 AND sb ~ '''WAITING_FOR_RECONNECT''' AND sb ~ '''BLOCKED_WITH_REASON''' AND sb ~ '''VARIANT_NOT_SUPPORTED''' AND sb !~ 'INSERT INTO' AND sb !~ 'UPDATE public' AND c.provolatile = 'v' AND c.prorettype = 'jsonb'::regtype AND sc ~ 'pg_try_advisory_xact_lock' AND sc ~ '''cluster_row_busy''' AND sc ~ 'public\.fn_lightning_form_hand\(' AND sc ~ 'fn_lightning_match_plan\(p_cluster_id, v_now, p_disconnected, v_version, v_max_hands - v_formed, p_player_platforms\)' AND position('''cluster_has_no_front_table''' in sc) < position('pg_try_advisory_xact_lock' in sc) AND position('''variant_not_supported''' in sc) < position('pg_try_advisory_xact_lock' in sc) FROM pg_proc a, pg_proc b, pg_proc c, LATERAL (SELECT regexp_replace(pg_get_functiondef(b.oid), '--[^' || chr(10) || ']*', '', 'g') AS sb, pg_get_functiondef(c.oid) AS sc) q WHERE a.oid = 'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text,jsonb)'::regprocedure AND b.oid = 'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)'::regprocedure AND c.oid = 'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure)
-- @live-proof: (SELECT count(*) = 5 AND bool_and(p.prosecdef AND p.proconfig::text ~ 'search_path' AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND pg_get_functiondef(p.oid) ~ 'auth\.uid\(\)' AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') !~ 'is_horse|horse_id|lightning_instance_id|INSERT INTO|UPDATE public|DELETE FROM') FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_session_stats(uuid)'::regprocedure, 'public.fn_lightning_session_summary(uuid)'::regprocedure, 'public.fn_lightning_my_sessions()'::regprocedure, 'public.fn_lightning_pool_status(uuid)'::regprocedure, 'public.fn_lightning_recent_hands(integer,uuid)'::regprocedure))
-- @live-proof: (SELECT s ~ 'showed = \(x ->> ''showed''\)::boolean' AND s ~ 'v_mode IS NOT DISTINCT FROM ''frozen''' FROM (SELECT pg_get_functiondef('public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure) AS s) q) AND (SELECT pl.qual ~ 'is_private' AND pl.qual ~ 'club_members' FROM pg_policies pl WHERE pl.schemaname = 'public' AND pl.tablename = 'cash_games' AND pl.policyname = 'cash_games_read')
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_lightning_config', 'fn_lightning_player_legality', 'fn_lightning_match_plan', 'fn_lightning_match', 'fn_lightning_match_and_form', 'fn_lightning_hand_player_records_its_wait', 'fn_lightning_session_stats', 'fn_lightning_session_summary', 'fn_lightning_my_sessions', 'fn_lightning_pool_status', 'fn_lightning_recent_hands') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id'))
--
BEGIN;

SET LOCAL lock_timeout = '2s';

-- ===========================================================================
-- 0. THE REWRITER. An asserted substitution into the body production
--    carries. Every anchor must appear exactly as often as stated or the file
--    refuses. Where the signature changes the old function is dropped and
--    the new one created carrying what each request role could execute and
--    the old comment, both asserted semantically with has_function_privilege.
--    A function already carrying the change is left alone.
-- ===========================================================================
CREATE OR REPLACE FUNCTION pg_temp.lp8_rewrite(p_old text, p_new text, p_marker text,
                                    p_from text[], p_to text[], p_counts integer[])
RETURNS void LANGUAGE plpgsql AS $rw$
DECLARE
  v_same    boolean := p_old = p_new;
  v_src     text;
  v_new     text;
  v_n       integer;
  k         integer;
  -- The estate's request roles: what each may execute is the ACL fact that
  -- matters, and the only one that is stable across production's default
  -- privileges and its autorevoke event trigger.
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
  -- WHO MAY EXECUTE, captured before the drop. has_function_privilege reads
  -- the effective answer (PUBLIC and role membership included), so it is the
  -- same question PostgREST answers at the door.
  SELECT array_agg(has_function_privilege(t.r, p_old::regprocedure, 'EXECUTE') ORDER BY t.ord)
    INTO v_had FROM unnest(v_roles) WITH ORDINALITY t(r, ord);
  v_comment := obj_description(p_old::regprocedure, 'pg_proc');
  IF NOT v_same THEN
    EXECUTE format('DROP FUNCTION %s', p_old);
  END IF;
  EXECUTE v_new;
  IF NOT v_same THEN
    -- Born under production's default privileges the new function already
    -- holds grants the old one refused, so the slate is wiped first and each
    -- request role is granted back exactly what it had.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', p_new);
    FOR k IN 1 .. array_length(v_roles, 1) LOOP
      IF v_had[k] THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', p_new, v_roles[k]);
      END IF;
    END LOOP;
    IF v_comment IS NOT NULL THEN
      EXECUTE format('COMMENT ON FUNCTION %s IS %L', p_new, v_comment);
    END IF;
    SELECT string_agg(t.r || ': had ' || v_had[t.ord] || ', has '
                      || has_function_privilege(t.r, p_new::regprocedure, 'EXECUTE'), '; ')
      INTO v_bad
      FROM unnest(v_roles) WITH ORDINALITY t(r, ord)
     WHERE has_function_privilege(t.r, p_new::regprocedure, 'EXECUTE') IS DISTINCT FROM v_had[t.ord];
    IF v_bad IS NOT NULL
       OR obj_description(p_new::regprocedure, 'pg_proc') IS DISTINCT FROM v_comment THEN
      RAISE EXCEPTION '% did not keep who may execute (%) and the comment of %', p_new, coalesce(v_bad, 'comment'), p_old;
    END IF;
  END IF;
  IF position(p_marker in pg_get_functiondef(p_new::regprocedure)) = 0 THEN
    RAISE EXCEPTION '% does not read back carrying %', p_new, p_marker;
  END IF;
END
$rw$;

-- ===========================================================================
-- 1. THE WAIT AND THE SHOWDOWN ARE RECORDED ON THE HAND ROW.
-- ===========================================================================
ALTER TABLE public.lightning_hand_player
  ADD COLUMN IF NOT EXISTS waited_ms integer,
  ADD COLUMN IF NOT EXISTS showed boolean;

DO $cons$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conrelid = 'public.lightning_hand_player'::regclass
                    AND c.conname = 'lightning_hand_player_wait_is_not_negative') THEN
    ALTER TABLE public.lightning_hand_player
      ADD CONSTRAINT lightning_hand_player_wait_is_not_negative CHECK (waited_ms IS NULL OR waited_ms >= 0);
  END IF;
END
$cons$;

-- Recent hands reads one player's rows; the primary key leads with the hand.
CREATE INDEX IF NOT EXISTS lightning_hand_player_by_player
  ON public.lightning_hand_player (player_id);

CREATE OR REPLACE FUNCTION public.fn_lightning_hand_player_records_its_wait()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_formed timestamptz;
  v_idle   timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- THE WAIT IS THE FORMATION'S TO STATE, never a caller's: from the moment
    -- the slot went idle (its last dealt hand released it, or it opened) to
    -- the moment this hand formed. The barrier inserts the hand row first.
    SELECT h.formed_at INTO v_formed FROM public.lightning_hand h WHERE h.hand_id = NEW.hand_id;
    SELECT sl.idle_since INTO v_idle FROM public.lightning_pool_slot sl WHERE sl.id = NEW.pool_slot_id;
    NEW.waited_ms := CASE WHEN v_formed IS NULL OR v_idle IS NULL THEN NULL
                          ELSE LEAST(GREATEST(round(extract(epoch FROM (v_formed - v_idle)) * 1000), 0),
                                     2147483647)::integer END;
    -- The showdown is the settlement's to state.
    NEW.showed := NULL;
    RETURN NEW;
  END IF;
  IF NEW.waited_ms IS DISTINCT FROM OLD.waited_ms THEN
    RAISE EXCEPTION 'LIGHTNING_WAIT_IS_FINAL: hand % player % waited % ms at formation and the wait may not be rewritten',
      OLD.hand_id, OLD.player_id, OLD.waited_ms USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.showed IS NOT NULL AND NEW.showed IS DISTINCT FROM OLD.showed THEN
    RAISE EXCEPTION 'LIGHTNING_SHOWDOWN_IS_FINAL: hand % player % showed % at settlement and it may not be rewritten',
      OLD.hand_id, OLD.player_id, OLD.showed USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_lightning_hand_player_records_its_wait() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_hand_player_records_its_wait ON public.lightning_hand_player;
CREATE TRIGGER trg_hand_player_records_its_wait
  BEFORE INSERT OR UPDATE OF waited_ms, showed ON public.lightning_hand_player
  FOR EACH ROW EXECUTE FUNCTION public.fn_lightning_hand_player_records_its_wait();

-- The settlement writes the engine's showdown onto the hand row, in the same
-- statement as the outcome.
SELECT pg_temp.lp8_rewrite(
  'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)',
  'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)',
  'showed = (x ->> ''showed'')::boolean',
  ARRAY[$a$           net_result = (x ->> 'stack_after')::numeric - (x ->> 'stack_before')::numeric,
$a$],
  ARRAY[$b$           net_result = (x ->> 'stack_after')::numeric - (x ->> 'stack_before')::numeric,
           showed = (x ->> 'showed')::boolean,
$b$],
  ARRAY[1]);

-- ===========================================================================
-- 2. THE MULTI-TABLE LIMIT IS PER PLATFORM.
-- ===========================================================================
SELECT pg_temp.lp8_rewrite(
  'public.fn_lightning_config(uuid)',
  'public.fn_lightning_config(uuid)',
  '''multi_table_limit'', v_mtl_obj',
  ARRAY[$a1$  v_mtl      integer;
$a1$,
        $a2$  r := public.fn_lightning_config_number(v_cfg, 'multi_table_limit', 4, 1, 24, true);
  v_mtl := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
$a2$,
        $a3$    'multi_table_limit', v_mtl,
$a3$],
  ARRAY[$b1$  v_mtl      integer;
  v_mtl_cfg  jsonb;
  v_mtl_obj  jsonb := '{}'::jsonb;
  v_mtl_p    text;
$b1$,
        $b2$  -- LIGHTNING PHASE 8 (20261007212735): THE LIMIT IS PER PLATFORM, an
  -- object {desktop, tablet, mobile}, defaults 4, 3 and 2, each 1..8. The old
  -- scalar is still read: a number is the limit of every platform.
  v_mtl_cfg := v_cfg -> 'multi_table_limit';
  IF v_mtl_cfg IS NOT NULL AND jsonb_typeof(v_mtl_cfg) = 'number' THEN
    r := public.fn_lightning_config_number(v_cfg, 'multi_table_limit', 4, 1, 8, true);
    v_mtl := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
    v_mtl_obj := jsonb_build_object('desktop', v_mtl, 'tablet', v_mtl, 'mobile', v_mtl);
  ELSE
    IF v_mtl_cfg IS NOT NULL AND jsonb_typeof(v_mtl_cfg) NOT IN ('object', 'null') THEN
      v_inv := v_inv || jsonb_build_object('key', 'multi_table_limit', 'given', v_mtl_cfg, 'reason', 'wrong_type',
                                           'used', jsonb_build_object('desktop', 4, 'tablet', 3, 'mobile', 2));
    END IF;
    IF v_mtl_cfg IS NULL OR jsonb_typeof(v_mtl_cfg) IS DISTINCT FROM 'object' THEN
      v_mtl_cfg := '{}'::jsonb;
    END IF;
    FOREACH v_mtl_p IN ARRAY ARRAY['desktop', 'tablet', 'mobile'] LOOP
      r := public.fn_lightning_config_number(v_mtl_cfg, v_mtl_p,
             CASE v_mtl_p WHEN 'desktop' THEN 4 WHEN 'tablet' THEN 3 ELSE 2 END, 1, 8, true);
      v_mtl_obj := v_mtl_obj || jsonb_build_object(v_mtl_p, (r ->> 'value')::integer);
      IF r ? 'invalid' THEN
        v_inv := v_inv || jsonb_set(r -> 'invalid', '{key}', to_jsonb('multi_table_limit.' || v_mtl_p));
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_mtl_cfg) k WHERE k NOT IN ('desktop', 'tablet', 'mobile')) THEN
      v_inv := v_inv || jsonb_build_object('key', 'multi_table_limit', 'given', v_mtl_cfg,
                                           'reason', 'unknown_platform', 'used', v_mtl_obj);
    END IF;
  END IF;
$b2$,
        $b3$    'multi_table_limit', v_mtl_obj,
$b3$],
  ARRAY[1, 1, 1]);

-- P0: the limit of the player's own platform.
SELECT pg_temp.lp8_rewrite(
  'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[])',
  'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)',
  'p_player_platforms ->> ps.player_id::text',
  ARRAY[$a1$public.fn_lightning_player_legality(p_cluster_id uuid, p_now timestamp with time zone, p_disconnected uuid[])$a1$,
        $a2$(public.fn_lightning_config(cg.id) ->> 'multi_table_limit')::integer AS multi_table_limit$a2$,
        $a3$g.restrictions_enforced, g.multi_table_limit,$a3$,
        $a4$'multi_table_limit', c.multi_table_limit,$a4$],
  ARRAY[$b1$public.fn_lightning_player_legality(p_cluster_id uuid, p_now timestamp with time zone, p_disconnected uuid[], p_player_platforms jsonb DEFAULT NULL::jsonb)$b1$,
        $b2$public.fn_lightning_config(cg.id) -> 'multi_table_limit' AS multi_table_limits$b2$,
        $b3$g.restrictions_enforced,
           -- LIGHTNING PHASE 8 (20261007212735): the caller names each player's
           -- platform; missing or anything else is desktop.
           CASE WHEN (p_player_platforms ->> ps.player_id::text) IN ('desktop', 'tablet', 'mobile')
                THEN p_player_platforms ->> ps.player_id::text ELSE 'desktop' END AS platform,
           coalesce((g.multi_table_limits ->> CASE WHEN (p_player_platforms ->> ps.player_id::text) IN ('desktop', 'tablet', 'mobile')
                                                    THEN p_player_platforms ->> ps.player_id::text ELSE 'desktop' END)::integer,
                    4) AS multi_table_limit,$b3$,
        $b4$'multi_table_limit', c.multi_table_limit, 'platform', c.platform,$b4$],
  ARRAY[1, 1, 1, 1]);

SELECT pg_temp.lp8_rewrite(
  'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer)',
  'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)',
  'p_disconnected, p_player_platforms)',
  ARRAY[$a1$public.fn_lightning_match_plan(p_cluster_id uuid, p_now timestamp with time zone, p_disconnected uuid[], p_matcher_version text, p_max_groups integer)$a1$,
        $a2$public.fn_lightning_player_legality(p_cluster_id, v_now, p_disconnected)$a2$],
  ARRAY[$b1$public.fn_lightning_match_plan(p_cluster_id uuid, p_now timestamp with time zone, p_disconnected uuid[], p_matcher_version text, p_max_groups integer, p_player_platforms jsonb DEFAULT NULL::jsonb)$b1$,
        $b2$public.fn_lightning_player_legality(p_cluster_id, v_now, p_disconnected, p_player_platforms)$b2$],
  ARRAY[1, 2]);

SELECT pg_temp.lp8_rewrite(
  'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text)',
  'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text,jsonb)',
  'p_matcher_version, NULL, p_player_platforms)',
  ARRAY[$a1$public.fn_lightning_match(p_cluster_id uuid, p_now timestamp with time zone, p_disconnected uuid[], p_matcher_version text)$a1$,
        $a2$fn_lightning_match_plan(p_cluster_id, p_now, p_disconnected, p_matcher_version, NULL)$a2$],
  ARRAY[$b1$public.fn_lightning_match(p_cluster_id uuid, p_now timestamp with time zone, p_disconnected uuid[], p_matcher_version text, p_player_platforms jsonb DEFAULT NULL::jsonb)$b1$,
        $b2$fn_lightning_match_plan(p_cluster_id, p_now, p_disconnected, p_matcher_version, NULL, p_player_platforms)$b2$],
  ARRAY[1, 1]);

SELECT pg_temp.lp8_rewrite(
  'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid)',
  'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)',
  'v_max_hands - v_formed, p_player_platforms)',
  ARRAY[$a1$public.fn_lightning_match_and_form(p_cluster_id uuid, p_now timestamp with time zone, p_disconnected uuid[], p_max_hands integer, p_request_id uuid)$a1$,
        $a2$public.fn_lightning_match_plan(p_cluster_id, v_now, p_disconnected, v_version, v_max_hands - v_formed)$a2$],
  ARRAY[$b1$public.fn_lightning_match_and_form(p_cluster_id uuid, p_now timestamp with time zone, p_disconnected uuid[], p_max_hands integer, p_request_id uuid, p_player_platforms jsonb DEFAULT NULL::jsonb)$b1$,
        $b2$public.fn_lightning_match_plan(p_cluster_id, v_now, p_disconnected, v_version, v_max_hands - v_formed, p_player_platforms)$b2$],
  ARRAY[1, 1]);

-- ===========================================================================
-- 3. SESSION STATISTICS. One pool session, from its settled hand rows.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.fn_lightning_session_stats(p_pool_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), '') = 'service_role';
  s         record;
  h         record;
  v_end     timestamptz;
  v_dur     bigint;
  v_stack   numeric;
BEGIN
  IF p_pool_session_id IS NULL OR (v_uid IS NULL AND NOT v_service) THEN
    RETURN NULL;
  END IF;
  SELECT ps.id, ps.cluster_id, ps.player_id, ps.entered_at, ps.exited_at, ps.starting_stack,
         ps.ending_stack, ps.net_result, cg.bb
    INTO s
    FROM public.lightning_pool_session ps
    JOIN public.cash_games cg ON cg.id = ps.cluster_id
   WHERE ps.id = p_pool_session_id;
  -- Somebody else's session is answered exactly as one that does not exist.
  IF NOT FOUND OR (NOT v_service AND s.player_id IS DISTINCT FROM v_uid) THEN
    RETURN NULL;
  END IF;

  -- THE SETTLED HANDS OF THE SESSION, as the settlement recorded them: the
  -- hand row, its hand_history row and, for VPIP and PFR, the per-hand facts
  -- the cash statistics already read.
  SELECT count(*)::integer                                              AS hands,
         coalesce(sum(hp.net_result), 0)                                 AS net,
         count(*) FILTER (WHERE hp.fold_type = 'fast')::integer          AS fast_folds,
         count(*) FILTER (WHERE hp.fold_type = 'normal')::integer        AS normal_folds,
         count(*) FILTER (WHERE hp.fold_type = 'fold_watch')::integer    AS fold_and_watch,
         count(*) FILTER (WHERE hp.showed)::integer                      AS showdowns,
         round(avg(hh.pot_size), 2)                                      AS avg_pot,
         round(avg(hp.waited_ms))::integer                               AS avg_wait_ms,
         percentile_disc(0.95) WITHIN GROUP (ORDER BY hp.waited_ms)      AS p95_wait_ms,
         percentile_disc(0.99) WITHIN GROUP (ORDER BY hp.waited_ms)      AS p99_wait_ms,
         count(f.hand_id)::integer                                       AS fact_hands,
         count(*) FILTER (WHERE f.vpip)::integer                         AS vpip_hands,
         count(*) FILTER (WHERE f.pfr)::integer                          AS pfr_hands
    INTO h
    FROM public.lightning_pool_slot sl
    JOIN public.lightning_hand_player hp ON hp.pool_slot_id = sl.id
    JOIN public.lightning_hand lh ON lh.hand_id = hp.hand_id
    LEFT JOIN public.hand_history hh ON hh.id = lh.hand_history_id
    LEFT JOIN public.ca_hand_facts f ON f.hand_id = lh.hand_history_id AND f.user_id = hp.player_id
   WHERE sl.pool_session_id = s.id
     AND lh.settled_at IS NOT NULL;

  v_end := coalesce(s.exited_at, clock_timestamp());
  v_dur := GREATEST(floor(extract(epoch FROM (v_end - s.entered_at))), 0)::bigint;
  v_stack := CASE WHEN s.exited_at IS NULL THEN public.fn_lightning_pool_stack(s.id)
                  ELSE coalesce(s.ending_stack, s.starting_stack + s.net_result) END;

  RETURN jsonb_build_object(
    'pool_session_id', s.id,
    'cluster_id',      s.cluster_id,
    'started_at',      s.entered_at,
    'ended_at',        s.exited_at,
    'duration_s',      v_dur,
    'hands',           h.hands,
    'hands_per_hour',  CASE WHEN v_dur > 0 THEN round(h.hands * 3600.0 / v_dur, 2) END,
    'starting_stack',  s.starting_stack,
    'current_stack',   v_stack,
    'net',             round(h.net, 2),
    'bb_per_100',      CASE WHEN h.hands > 0 AND s.bb > 0 THEN round(h.net / s.bb / h.hands * 100, 2) END,
    'vpip',            CASE WHEN h.fact_hands > 0 THEN round(100.0 * h.vpip_hands / h.fact_hands, 1) END,
    'pfr',             CASE WHEN h.fact_hands > 0 THEN round(100.0 * h.pfr_hands / h.fact_hands, 1) END,
    'avg_pot',         h.avg_pot,
    'showdowns',       h.showdowns,
    'fast_folds',      h.fast_folds,
    'normal_folds',    h.normal_folds,
    'fold_and_watch',  h.fold_and_watch,
    'avg_wait_ms',     h.avg_wait_ms,
    'p95_wait_ms',     h.p95_wait_ms,
    'p99_wait_ms',     h.p99_wait_ms);
END
$function$;

-- ===========================================================================
-- 4. THE SESSION SUMMARY: the statistics, and whether and why it ended.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.fn_lightning_session_summary(p_pool_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), '') = 'service_role';
  v_stats   jsonb;
  s         record;
BEGIN
  IF p_pool_session_id IS NULL OR (v_uid IS NULL AND NOT v_service) THEN
    RETURN NULL;
  END IF;
  -- The statistics ask the same question of the caller.
  v_stats := public.fn_lightning_session_stats(p_pool_session_id);
  IF v_stats IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT ps.exited_at, ps.exit_reason INTO s
    FROM public.lightning_pool_session ps WHERE ps.id = p_pool_session_id;
  RETURN v_stats || jsonb_build_object('ended', s.exited_at IS NOT NULL, 'exit_reason', s.exit_reason);
END
$function$;

-- ===========================================================================
-- 5. MY SESSIONS: the caller's open pool sessions in every Cluster.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.fn_lightning_my_sessions()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;
  RETURN (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'pool_session_id', ps.id,
             'cluster_id',      ps.cluster_id,
             'name',            cg.name,
             'stakes',          jsonb_build_object('sb', cg.sb, 'bb', cg.bb),
             'variant',         cg.variant,
             'stack',           public.fn_lightning_pool_stack(ps.id),
             'in_hand',         public.fn_lightning_player_in_hand(ps.player_id, ps.cluster_id))
             ORDER BY ps.entered_at, ps.id), '[]'::jsonb)
      FROM public.lightning_pool_session ps
      JOIN public.cash_games cg ON cg.id = ps.cluster_id
     WHERE ps.player_id = v_uid AND ps.exited_at IS NULL);
END
$function$;

-- ===========================================================================
-- 6. POOL STATUS FOR PLAYERS: four words, never the matcher's internals.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.fn_lightning_pool_status(p_cluster_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), '') = 'service_role';
  g         record;
  v_health  jsonb;
  v_cfg     jsonb;
  v_live    integer;
  v_status  text;
BEGIN
  IF p_cluster_id IS NULL OR (v_uid IS NULL AND NOT v_service) THEN
    RETURN NULL;
  END IF;
  -- THE LOBBY'S OWN RULE (policy cash_games_read): visible unless the
  -- ruleset marks it private, and a private Cluster to members of its club.
  SELECT cg.id, cg.cluster_mode INTO g
    FROM public.cash_games cg
   WHERE cg.id = p_cluster_id
     AND (v_service
          OR NOT coalesce(((cg.ruleset_snapshot -> 'options') ->> 'is_private')::boolean, false)
          OR EXISTS (SELECT 1 FROM public.club_members cm
                      WHERE cm.club_id = cg.club_id AND cm.user_id = v_uid));
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_health := public.fn_cash_cluster_pool_health(p_cluster_id, clock_timestamp());
  v_live := CASE WHEN coalesce((v_health ->> 'ok')::boolean, false)
                 THEN coalesce((v_health ->> 'live_eligible')::integer, 0) ELSE 0 END;
  v_cfg := public.fn_lightning_config(p_cluster_id);
  v_status := CASE
    WHEN g.cluster_mode = 'pending_off' THEN 'THIN'
    WHEN g.cluster_mode IS DISTINCT FROM 'lightning' THEN 'BUILDING'
    WHEN v_live >= (v_cfg ->> 'diversity_large_min')::integer THEN 'HOT'
    WHEN v_live >= (v_cfg ->> 'diversity_medium_min')::integer THEN 'ACTIVE'
    ELSE 'THIN' END;
  RETURN jsonb_build_object('cluster_mode', g.cluster_mode, 'players', v_live, 'status', v_status);
END
$function$;

-- ===========================================================================
-- 7. RECENT HANDS: the caller's own last fifty, newest first.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.fn_lightning_recent_hands(p_limit integer DEFAULT 50,
                                                            p_pool_session_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 50), 0), 50);
BEGIN
  IF v_uid IS NULL OR v_limit = 0 THEN
    RETURN '[]'::jsonb;
  END IF;
  -- A session filter names one of the caller's own sessions, or nothing.
  IF p_pool_session_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.lightning_pool_session ps
                      WHERE ps.id = p_pool_session_id AND ps.player_id = v_uid) THEN
    RETURN '[]'::jsonb;
  END IF;
  RETURN (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'hand_id',         q.hand_id,
             'hand_history_id', q.hand_history_id,
             'hand_number',     q.hand_number,
             'played_at',       q.played_at,
             'cluster_id',      q.cluster_id,
             'small_blind',     q.small_blind,
             'big_blind',       q.big_blind,
             'position',        q.position,
             'stack_before',    q.stack_before,
             'stack_after',     q.stack_after,
             'net',             q.net,
             'pot',             q.pot,
             'fold_type',       q.fold_type,
             'showdown',        q.showdown,
             'result',          q.result)
             ORDER BY q.played_at DESC, q.hand_number DESC), '[]'::jsonb)
      FROM (
        SELECT lh.hand_id, lh.hand_history_id, lh.hand_number, lh.settled_at AS played_at, lh.cluster_id,
               coalesce(hh.small_blind, cg.sb) AS small_blind,
               coalesce(hh.big_blind, cg.bb) AS big_blind,
               hp.position, hp.stack_before, hp.stack_after, hp.net_result AS net,
               hh.pot_size AS pot, hp.fold_type, coalesce(hp.showed, false) AS showdown,
               CASE
                 WHEN hp.fold_type <> 'none' THEN 'folded'
                 WHEN w.mine AND w.shared THEN 'split'
                 WHEN w.mine THEN 'won'
                 WHEN hp.net_result > 0 THEN 'won'
                 WHEN hp.net_result = 0 AND NOT w.listed THEN 'split'
                 ELSE 'lost' END AS result
          FROM public.lightning_hand_player hp
          JOIN public.lightning_hand lh ON lh.hand_id = hp.hand_id
          JOIN public.lightning_pool_slot sl ON sl.id = hp.pool_slot_id
          JOIN public.cash_games cg ON cg.id = lh.cluster_id
          LEFT JOIN public.hand_history hh ON hh.id = lh.hand_history_id
          -- THE WINNERS THE ENGINE RECORDED: [{userId, amount, potIndex}].
          -- Shared when another player won a pot this player also won.
          CROSS JOIN LATERAL (
            SELECT coalesce(bool_or(x.uid = hp.player_id::text), false) AS mine,
                   coalesce(bool_or(x.uid = hp.player_id::text AND EXISTS (
                     SELECT 1 FROM jsonb_array_elements(
                              CASE WHEN jsonb_typeof(hh.winners) = 'array' THEN hh.winners ELSE '[]'::jsonb END) y
                      WHERE y ->> 'userId' IS DISTINCT FROM hp.player_id::text
                        AND coalesce(y ->> 'potIndex', '0') = x.pot)), false) AS shared,
                   count(*) > 0 AS listed
              FROM (SELECT e ->> 'userId' AS uid, coalesce(e ->> 'potIndex', '0') AS pot
                      FROM jsonb_array_elements(
                             CASE WHEN jsonb_typeof(hh.winners) = 'array' THEN hh.winners ELSE '[]'::jsonb END) e) x
          ) w
         WHERE hp.player_id = v_uid
           AND lh.settled_at IS NOT NULL
           AND (p_pool_session_id IS NULL OR sl.pool_session_id = p_pool_session_id)
         ORDER BY lh.settled_at DESC, lh.hand_number DESC
         LIMIT v_limit) q);
END
$function$;

-- ===========================================================================
-- 8. GRANTS AND COMMENTS.
-- ===========================================================================
REVOKE ALL ON FUNCTION public.fn_lightning_session_stats(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_lightning_session_summary(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_lightning_my_sessions() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_lightning_pool_status(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_lightning_recent_hands(integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_lightning_session_stats(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_session_summary(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_my_sessions() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pool_status(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_recent_hands(integer, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_lightning_session_stats(uuid) IS
  'Lightning Phase 8. One pool session''s statistics from its settled hand rows: hands, hands per hour, duration, starting and current stack, net, BB/100, VPIP and PFR from ca_hand_facts (null until projected), average pot, showdowns, fold counts and the average, P95 and P99 formation wait. The owner, or service_role; anyone else gets NULL.';
COMMENT ON FUNCTION public.fn_lightning_session_summary(uuid) IS
  'Lightning Phase 8. fn_lightning_session_stats plus ended and exit_reason, for an open or exited pool session of the caller.';
COMMENT ON FUNCTION public.fn_lightning_my_sessions() IS
  'Lightning Phase 8. The caller''s open pool sessions in every Cluster: pool_session_id, cluster_id, name, stakes {sb, bb}, variant, stack, in_hand. No instance id.';
COMMENT ON FUNCTION public.fn_lightning_pool_status(uuid) IS
  'Lightning Phase 8. Player-facing pool status {cluster_mode, players, status}: lightning at or above the large diversity band HOT, at or above the medium band ACTIVE, below it or pending_off THIN, every other mode BUILDING; players is the live eligible count. Visible to whoever the lobby policy cash_games_read shows the Cluster to.';
COMMENT ON FUNCTION public.fn_lightning_recent_hands(integer, uuid) IS
  'Lightning Phase 8. The caller''s own last settled Lightning hands (at most 50), newest first, optionally one of their sessions: hand and history ids, number, time, Cluster, blinds, position, stacks, net, pot, fold type, showdown and result (won, lost, folded, split). Read-only.';
COMMENT ON FUNCTION public.fn_lightning_hand_player_records_its_wait() IS
  'Lightning Phase 8. Sets lightning_hand_player.waited_ms at formation from the slot''s idle_since to the hand''s formed_at; the wait, and a settled showdown, are final.';

-- ===========================================================================
-- 9. READ BACK.
-- ===========================================================================
DO $readback$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(q.what, '; ') INTO v_bad FROM (VALUES
    ('the old matcher signatures are gone', (SELECT bool_and(to_regprocedure(f) IS NULL) FROM unnest(ARRAY[
       'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[])',
       'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer)',
       'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text)',
       'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid)']) f)),
    ('service_role alone runs the matcher', (SELECT bool_and(has_function_privilege('service_role', f::regprocedure, 'EXECUTE')
       AND NOT has_function_privilege('anon', f::regprocedure, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', f::regprocedure, 'EXECUTE')) FROM unnest(ARRAY[
       'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)',
       'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)',
       'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text,jsonb)',
       'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)']) f)),
    ('the browser doors', (SELECT bool_and(p.prosecdef AND p.proconfig::text ~ 'search_path'
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
       FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_session_stats(uuid)'::regprocedure,
         'public.fn_lightning_session_summary(uuid)'::regprocedure, 'public.fn_lightning_my_sessions()'::regprocedure,
         'public.fn_lightning_pool_status(uuid)'::regprocedure, 'public.fn_lightning_recent_hands(integer,uuid)'::regprocedure))),
    ('the default limits', (SELECT public.fn_lightning_config(NULL) -> 'multi_table_limit' = '{"desktop": 4, "tablet": 3, "mobile": 2}'::jsonb)),
    ('the wait trigger', (SELECT count(*) = 1 FROM pg_trigger t WHERE t.tgrelid = 'public.lightning_hand_player'::regclass
       AND t.tgname = 'trg_hand_player_records_its_wait' AND t.tgenabled = 'O'))
  ) q(what, ok) WHERE q.ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIGHTNING_PHASE_8_READBACK: the catalogue does not carry: %', v_bad;
  END IF;
END
$readback$;

COMMIT;
