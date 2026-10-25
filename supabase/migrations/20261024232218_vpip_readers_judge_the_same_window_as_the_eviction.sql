-- 20261024232218_vpip_readers_judge_the_same_window_as_the_eviction.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- @live-proof: position('fn_nit_sitting_since' in pg_get_functiondef('public.fn_nit_check(uuid,uuid,timestamptz)'::regprocedure))>0 AND position('fn_nit_sitting_since' in pg_get_functiondef('public.fn_nit_status(uuid)'::regprocedure))>0 AND position('fn_nit_sitting_since' in pg_get_functiondef('public.fn_cash_vpip_status(uuid)'::regprocedure))>0 AND position('cash_game_roster' in pg_get_functiondef('public.fn_nit_status(uuid)'::regprocedure))=0 AND position('cash_game_roster' in pg_get_functiondef('public.fn_cash_vpip_status(uuid)'::regprocedure))=0
--
-- THREE READERS OF ONE RULE, AND ONLY ONE WAS TOLD THE RULE CHANGED.
--
-- The maintain-VPIP floor has one enforcer and two readers:
--   fn_nit_check         - what stands a seat up (via fn_nit_evictions);
--   fn_nit_status        - the figure every horse steers by (HorseLogic's
--                          ownVpip / vpipFloorMul), "the same numbers the
--                          eviction reads";
--   fn_cash_vpip_status  - the player's own VPIP tracker on the felt
--                          (HeroVpipTracker), "the number the rule judges".
-- Each carried its OWN copy of the sample window: the sitting in the game
-- (cash_game_roster.joined_at) on a cluster table, the chair elsewhere.
--
-- 20261024213131 (PLO5/PLO6 Classic, 50% and a BB ante) turned the floor on
-- mid-sitting and, correctly, made the window start at the later of the join
-- and the game's vpip_floor_since - but only inside fn_nit_check. Measured on
-- production at 23:20 UTC: on five live Midway tables fn_nit_status reported
-- 20 seated players at 31-49% over up to 850 hands and flagged each for
-- eviction, while fn_nit_check judged the same players on the hands since
-- 21:33 (one of them: 850 by the reader, 310 by the enforcer) and evicted
-- nobody. So horses were widening toward a floor they already met, on hands
-- from before the floor existed, and a human's tracker would have shown
-- "below the floor" while the rule said they were fine.
--
-- THE FIX AT THE ROOT: the window is computed in ONE place,
-- fn_nit_sitting_since(game, user, fallback), and all three call it. The
-- readers stop carrying a copy, so the next change to the window reaches all
-- three or none. fn_nit_check is patched by anchor (its career block is
-- pinned verbatim by tests/three-slow-paths-do-only-the-work-they-act-on);
-- the two readers are replaced whole with bodies identical to the live ones
-- except for the window. Every function is md5-guarded.
--
-- Same rule for every player, horses included (CLAUDE.md 10.5). Reads only:
-- no wallet, seat, hand or payout writes, and no table locks.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.fn_nit_check(uuid,uuid,timestamptz)'::regprocedure))
     <> '9b00a65ac960a5918c9f2632164fa02a' THEN
    RAISE EXCEPTION 'fn_nit_check changed since this migration was written; requalify';
  END IF;
  IF md5(pg_get_functiondef('public.fn_nit_status(uuid)'::regprocedure))
     <> '836cbf38580d1ced2cf3e59f7e172e18' THEN
    RAISE EXCEPTION 'fn_nit_status changed since this migration was written; requalify';
  END IF;
  IF md5(pg_get_functiondef('public.fn_cash_vpip_status(uuid)'::regprocedure))
     <> 'e791519877d80561dbfbfbbbd5060b91' THEN
    RAISE EXCEPTION 'fn_cash_vpip_status changed since this migration was written; requalify';
  END IF;
END $guard$;

-- The one definition of the maintain window on a cluster (must-move) game:
-- the player's open sitting in the game, else the caller's fallback (the
-- chair), and never earlier than the instant the game's floor was turned on.
-- GREATEST ignores NULL, so a game whose floor has always been on, or a
-- player with no roster row, falls back exactly as before.
CREATE OR REPLACE FUNCTION public.fn_nit_sitting_since(p_game_id uuid, p_user_id uuid, p_fallback timestamptz)
 RETURNS timestamptz
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT GREATEST(
           coalesce((SELECT r.joined_at
                       FROM public.cash_game_roster r
                      WHERE r.game_id = p_game_id AND r.user_id = p_user_id AND r.left_at IS NULL
                      ORDER BY r.joined_at DESC
                      LIMIT 1),
                    p_fallback),
           (SELECT (g.ruleset_snapshot->>'vpip_floor_since')::timestamptz
              FROM public.cash_games g WHERE g.id = p_game_id));
$function$;

REVOKE ALL ON FUNCTION public.fn_nit_sitting_since(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_nit_sitting_since(uuid, uuid, timestamptz) TO service_role;

-- The enforcer, by anchor: the roster lookup and the floor_since line become
-- one call. Nothing else in the function moves.
DO $nit_check$
DECLARE s text; n text;
BEGIN
  s := pg_get_functiondef('public.fn_nit_check(uuid,uuid,timestamptz)'::regprocedure);
  n := replace(s,
$a$      SELECT r.joined_at INTO v_since
        FROM public.cash_game_roster r
       WHERE r.game_id = v_game AND r.user_id = p_user_id AND r.left_at IS NULL
       ORDER BY r.joined_at DESC
       LIMIT 1;
      IF NOT FOUND THEN v_since := p_since; END IF;
      -- A FLOOR TURNED ON MID-SITTING JUDGES ONLY WHAT FOLLOWS IT (2026-10-24).
      v_since := GREATEST(v_since, (SELECT (g.ruleset_snapshot->>'vpip_floor_since')::timestamptz
                                      FROM public.cash_games g WHERE g.id = v_game));$a$,
$b$      -- The one window definition, shared with fn_nit_status and
      -- fn_cash_vpip_status (2026-10-24): the sitting in the game, never
      -- earlier than the instant the floor was turned on.
      v_since := public.fn_nit_sitting_since(v_game, p_user_id, p_since);$b$);
  IF n = s OR position('fn_nit_sitting_since' in n) = 0 OR position('cash_game_roster' in n) > 0 THEN
    RAISE EXCEPTION 'fn_nit_check window anchor changed; requalify';
  END IF;
  EXECUTE n;
END $nit_check$;

-- The horses' reader. Identical to the live body except the window.
CREATE OR REPLACE FUNCTION public.fn_nit_status(p_table_id uuid)
 RETURNS TABLE(user_id uuid, hands integer, vpip numeric, required integer, window_hands integer, evict boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_on    boolean;
  v_min   integer;
  v_n     integer;
  v_game  uuid;
  v_since timestamptz;
  r       record;
BEGIN
  SELECT COALESCE(t.nit_game, false),
         GREATEST(COALESCE(t.maintain_percent_min, 0), 0),
         GREATEST(COALESCE(t.maintain_hands, 10), 1),
         t.cluster_id
    INTO v_on, v_min, v_n, v_game
    FROM public.tables t WHERE t.id = p_table_id LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  FOR r IN
    SELECT ts.user_id AS uid, ts.joined_at
      FROM public.table_seats ts
     WHERE ts.table_id = p_table_id
       AND ts.left_at IS NULL
  LOOP
    -- Same sample fn_nit_check judges: the sitting in the game on a cluster
    -- table, the chair elsewhere (2026-09-09). The window comes from
    -- fn_nit_sitting_since, the one definition all three readers share.
    v_since := r.joined_at;
    IF v_game IS NOT NULL THEN
      v_since := public.fn_nit_sitting_since(v_game, r.uid, r.joined_at);

      SELECT count(*)::int,
             CASE WHEN count(*) = 0 THEN NULL
                  ELSE round(100.0 * avg(CASE WHEN f.vpip THEN 1 ELSE 0 END), 1) END
        INTO hands, vpip
        FROM public.ca_hand_facts f
       WHERE f.user_id = r.uid
         AND (v_since IS NULL OR f.played_at >= v_since)
         AND f.table_id IN (SELECT t2.id FROM public.tables t2 WHERE t2.cluster_id = v_game);
    ELSE
      SELECT count(*)::int,
             CASE WHEN count(*) = 0 THEN NULL
                  ELSE round(100.0 * avg(CASE WHEN f.vpip THEN 1 ELSE 0 END), 1) END
        INTO hands, vpip
        FROM public.ca_hand_facts f
       WHERE f.table_id = p_table_id
         AND f.user_id = r.uid
         AND (v_since IS NULL OR f.played_at >= v_since);
    END IF;
    user_id      := r.uid;
    required     := CASE WHEN v_on THEN v_min ELSE 0 END;
    window_hands := v_n;
    evict        := v_on AND v_min > 0 AND hands >= v_n AND vpip IS NOT NULL AND vpip < v_min;
    RETURN NEXT;
  END LOOP;
END;
$function$;

-- The player's own tracker. Identical to the live body except the window.
CREATE OR REPLACE FUNCTION public.fn_cash_vpip_status(p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_on     boolean;
  v_min    integer;
  v_n      integer;
  v_game   uuid;
  v_joined timestamptz;
  v_since  timestamptz;
  v_hands  integer;
  v_vpip   numeric;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  END IF;

  SELECT COALESCE(t.nit_game, false),
         GREATEST(COALESCE(t.maintain_percent_min, 0), 0),
         GREATEST(COALESCE(t.maintain_hands, 10), 1),
         t.cluster_id
    INTO v_on, v_min, v_n, v_game
    FROM public.tables t WHERE t.id = p_table_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  SELECT ts.joined_at INTO v_joined
    FROM public.table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL
   ORDER BY ts.joined_at DESC NULLS LAST
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'seated', false,
      'nit_game', v_on, 'required', CASE WHEN v_on THEN v_min ELSE 0 END, 'window', v_n);
  END IF;

  -- The number the rule judges (fn_nit_check): the sitting in the GAME on a
  -- cluster table, the chair elsewhere (2026-09-09), from the one shared
  -- window definition (fn_nit_sitting_since, 2026-10-24).
  v_since := v_joined;
  IF v_game IS NOT NULL THEN
    v_since := public.fn_nit_sitting_since(v_game, v_uid, v_joined);

    SELECT count(*)::int,
           CASE WHEN count(*) = 0 THEN NULL
                ELSE round(100.0 * avg(CASE WHEN f.vpip THEN 1 ELSE 0 END), 1) END
      INTO v_hands, v_vpip
      FROM public.ca_hand_facts f
     WHERE f.user_id = v_uid
       AND (v_since IS NULL OR f.played_at >= v_since)
       AND f.table_id IN (SELECT t2.id FROM public.tables t2 WHERE t2.cluster_id = v_game);
  ELSE
    SELECT count(*)::int,
           CASE WHEN count(*) = 0 THEN NULL
                ELSE round(100.0 * avg(CASE WHEN f.vpip THEN 1 ELSE 0 END), 1) END
      INTO v_hands, v_vpip
      FROM public.ca_hand_facts f
     WHERE f.table_id = p_table_id
       AND f.user_id = v_uid
       AND (v_since IS NULL OR f.played_at >= v_since);
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'seated', true,
    'nit_game', v_on,
    'required', CASE WHEN v_on THEN v_min ELSE 0 END,
    'window', v_n,
    'hands', v_hands,
    'vpip', v_vpip,
    'since', v_since);
END;
$function$;

-- The grants each function already holds, stated so they cannot drift:
-- the horses' reader is engine-only, the tracker is a signed-in player's.
REVOKE ALL ON FUNCTION public.fn_nit_status(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_nit_status(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_vpip_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_vpip_status(uuid) TO authenticated, service_role;

-- The readers and the enforcer now agree on live floored tables: a seat the
-- reader flags is exactly a seat the enforcer would stand up. A smoke test
-- on the tables where the window actually moves, not the proof - the proof is
-- that the window is now one function. Six tables, the floored-mid-sitting
-- ones first: an independent review measured twelve at 7.1 s cold against
-- this transaction's 8 s statement budget. Only tables with no career rule
-- (fn_nit_evictions reports maintain_vpip alone, so a career failure would
-- read as a disagreement) and only seats with a profile row (the eviction
-- query joins profiles; the reader does not).
DO $agree$
DECLARE
  t record;
  v_disagree integer := 0;
BEGIN
  FOR t IN
    SELECT tb.id FROM public.tables tb
      JOIN public.cash_games g ON g.id = tb.cluster_id
     WHERE tb.nit_game AND tb.maintain_percent_min > 0
       AND coalesce(tb.career_percent_min, 0) = 0
       AND tb.lifecycle <> 'closed' AND NOT coalesce(tb.is_deleted, false)
       AND EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id = tb.id AND s.left_at IS NULL)
     ORDER BY (g.ruleset_snapshot ? 'vpip_floor_since') DESC, tb.id
     LIMIT 6
  LOOP
    SELECT v_disagree + count(*) INTO v_disagree
      FROM (SELECT st.* FROM public.fn_nit_status(t.id) st
             WHERE EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = st.user_id)) st
      FULL JOIN public.fn_nit_evictions(t.id) ev ON ev.user_id = st.user_id
     WHERE coalesce(st.evict, false) IS DISTINCT FROM (ev.user_id IS NOT NULL);
  END LOOP;
  IF v_disagree > 0 THEN
    RAISE EXCEPTION '% seat(s) where the VPIP reader and the eviction still disagree', v_disagree;
  END IF;
END $agree$;

COMMIT;
