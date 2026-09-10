-- 20260910054638_tables_policy_hashed_auth_admin_trusted_and_unfilled_spins_e.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (applied on production 2026-09-10 05:50 UTC):
--
-- 1. RLS policy poker_arena_table_access on public.tables: the same per-row
--    plpgsql call (fn_poker_can_read_games(COALESCE(union_id, club_id)) on
--    every one of 206k rows) that 20260910034411 fixed on tournaments.
--    Rewritten to the hashed-subplan form; identical rows (0 orphan
--    club/union ids, clubs has a `true` PERMISSIVE SELECT policy for public,
--    the function is STABLE SECURITY DEFINER).
--
-- 2. fn_active_maintenance_release_boundary: supabase_auth_admin is a trusted
--    database actor. It is GoTrue's own role - the signup triggers run as it,
--    it is never a browser - and without it every signup wallet trigger
--    reached fn_platform_frozen and raised 42501
--    MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REQUIRED (signup_errors id 9318,
--    2026-09-10 03:06 UTC). Body otherwise identical to 20260910034411.
--
-- 3. fn_spin_expire_unfilled: `spin_multiplier IS NOT NULL` ->
--    `COALESCE(spin_multiplier, 0) > 0`. tournaments.spin_multiplier has
--    DEFAULT 0 and the seat-first creator omits the column, so the sweep read
--    every undrawn Spin as drawn and expired NOTHING since 2026-09-08: a
--    player (or horse) waiting in an unfilled Spin past the timeout was never
--    refunded. Same NULL/0 slip as the draw gate fixed in 20260910034412.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

ALTER POLICY poker_arena_table_access ON public.tables USING (((club_id IS NULL) AND (union_id IS NULL)) OR (COALESCE(union_id, club_id) IN (SELECT c.id FROM public.clubs c WHERE public.fn_poker_can_read_games(c.id))));

launch may commit
CREATE OR REPLACE FUNCTION public.fn_active_maintenance_release_boundary()
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  c_required_steps CONSTANT text[] := ARRAY[
    'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
    'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
    'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
    'cluster_break_eligible_since','cluster_move_expires_at',
    'reconnect_presence','reconnect_snapshots'
  ];
  v_request_role text := NULLIF(btrim(COALESCE(auth.role(), '')), '');
  v_trusted_database_actor boolean;
  v_release_target timestamptz;
BEGIN
  -- supabase_auth_admin added 2026-09-10: it is GoTrue's own database role
  -- (the signup triggers run as it), never a browser. Without it every signup
  -- wallet trigger raised 42501 here (signup_errors id 9318).
  SELECT session_user IN ('postgres', 'supabase_admin', 'service_role', 'supabase_auth_admin')
         OR COALESCE(r.rolsuper, false)
    INTO v_trusted_database_actor
    FROM (SELECT session_user AS role_name) s
    LEFT JOIN pg_catalog.pg_roles r ON r.rolname = s.role_name;
  IF v_request_role IS NOT NULL
     AND v_request_role NOT IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REFUSED'
      USING ERRCODE = '42501';
  END IF;
  IF v_request_role IS NULL AND NOT COALESCE(v_trusted_database_actor, false) THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REQUIRED'
      USING ERRCODE = '42501';
  END IF;
  -- PERF (2026-09-10, swarm A): OFFSET 0 is an optimisation fence. Without it
  -- the planner evaluated `shifted ?& c_required_steps` first on every row of
  -- engine_maintenance_thaws (167 rows, 0 of them contract_version 3) on every
  -- money write that reaches fn_platform_frozen: 229 us -> 32 us per call.
  -- Same four quals, same max(); the jsonb quals now only see rows that already
  -- passed contract_version = 3 AND release_target_at > clock_timestamp().
  SELECT max(t.release_target_at) INTO v_release_target
    FROM (SELECT t.release_target_at, t.shifted
            FROM public.engine_maintenance_thaws t
           WHERE t.contract_version = 3
             AND t.release_target_at > clock_timestamp()
          OFFSET 0) t
   WHERE COALESCE((t.shifted->>'complete')::boolean, false)
     AND t.shifted ?& c_required_steps;
  RETURN v_release_target;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_spin_expire_unfilled(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_minutes integer;
  g record;
  v_current record;
  v_skipped integer := 0;
  res jsonb;
  v_expired integer := 0;
  v_failed integer := 0;
  v_refunded numeric := 0;
  v_ids jsonb := '[]'::jsonb;
BEGIN
  SELECT unfilled_timeout_minutes INTO v_minutes FROM public.spin_fill_policy LIMIT 1;
  v_minutes := COALESCE(v_minutes, 30);
  -- 0 (or a missing row) means the operator has switched the sweep off.
  IF v_minutes <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'disabled', true, 'expired', 0);
  END IF;
  FOR g IN
    SELECT t.id,
           t.buy_in_amount,
           (SELECT count(*) FROM public.table_seats s
              JOIN public.tables tb ON tb.id = s.table_id
             WHERE tb.tournament_id = t.id AND s.left_at IS NULL) AS live_seats
      FROM public.tournaments t
     WHERE t.variant = 'spin'
       AND t.status IN ('REGISTERING', 'ANNOUNCED')
       AND t.started_at IS NULL
       -- somebody has actually been waiting too long
       AND EXISTS (SELECT 1 FROM public.table_seats s
                     JOIN public.tables tb ON tb.id = s.table_id
                    WHERE tb.tournament_id = t.id
                      AND s.left_at IS NULL
                      AND s.joined_at < now() - make_interval(mins => v_minutes))
       -- and the game is NOT full: a full unstarted spin is about to deal.
       AND (SELECT count(*) FROM public.table_seats s
              JOIN public.tables tb ON tb.id = s.table_id
             WHERE tb.tournament_id = t.id AND s.left_at IS NULL)
           < COALESCE(t.max_players, 3)
     ORDER BY t.created_at
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    -- The scan is only a candidate list. A final join or launch may commit
    -- before cancellation reaches this parent. Busy parents belong to that
    -- work; the next sweep may reconsider them.
    PERFORM 1 FROM public.tournaments t WHERE t.id=g.id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    -- Read in a new statement AFTER acquiring the parent, so seat subqueries
    -- cannot retain the candidate scan's earlier snapshot.
    SELECT t.status,t.variant,t.started_at,t.spin_multiplier,t.buy_in_amount,
           COALESCE(t.max_players,3) AS max_players,
           (SELECT count(*) FROM public.table_seats s
              JOIN public.tables tb ON tb.id=s.table_id
             WHERE tb.tournament_id=t.id AND s.left_at IS NULL) AS live_seats,
           EXISTS(SELECT 1 FROM public.table_seats s
              JOIN public.tables tb ON tb.id=s.table_id
             WHERE tb.tournament_id=t.id AND s.left_at IS NULL
               AND s.joined_at < now()-make_interval(mins=>v_minutes)) AS has_expired_waiter,
           EXISTS(SELECT 1 FROM public.spin_reserve_ledger l
             WHERE l.tournament_id=t.id AND l.kind='jackpot_draw')
             OR EXISTS(SELECT 1 FROM public.spin_draw_receipts r
               WHERE r.tournament_id=t.id) AS has_booked_draw
      INTO v_current FROM public.tournaments t WHERE t.id=g.id;
    -- A drawn Spin is never expired. tournaments.spin_multiplier has DEFAULT 0
    -- and the seat-first creator omits the column, so `IS NOT NULL` read every
    -- undrawn Spin as drawn and this sweep expired nothing since 2026-09-08.
    -- Every other reader uses COALESCE(...,0) > 0 (2026-09-10, C-stuck-spins D3).
    IF v_current.variant IS DISTINCT FROM 'spin'
       OR v_current.status NOT IN ('REGISTERING','ANNOUNCED')
       OR v_current.status IS NULL OR v_current.started_at IS NOT NULL
       OR v_current.live_seats >= v_current.max_players
       OR NOT v_current.has_expired_waiter
       OR COALESCE(v_current.spin_multiplier, 0) > 0 OR v_current.has_booked_draw THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    BEGIN
      res := public.atomic_cancel_tournament(g.id, NULL);
      v_expired := v_expired + 1;
      v_refunded := v_refunded + (COALESCE(v_current.buy_in_amount, 0) * COALESCE(v_current.live_seats, 0));
      v_ids := v_ids || to_jsonb(g.id::text);
    EXCEPTION WHEN OTHERS THEN
      -- Loud, never fatal: one stuck game must not stop the rest being freed.
      v_failed := v_failed + 1;
      RAISE WARNING 'fn_spin_expire_unfilled: could not cancel %: %', g.id, SQLERRM;
    END;
    -- The counter derives from the seats either way (see 20260830110000).
    PERFORM public.fn_sync_seat_first_player_count(g.id);
  END LOOP;
  RETURN jsonb_build_object(
    'ok', true,
    'expired', v_expired,
    'failed', v_failed,
    'skipped_raced', v_skipped,
    'chips_refunded_estimate', round(v_refunded, 2),
    'timeout_minutes', v_minutes,
    'tournament_ids', v_ids);
END;
$function$
;



-- Grants as they are on production (postgres/service_role only), stated so
-- the migration is self-describing and the definer-authorization gate sees it.
REVOKE ALL ON FUNCTION public.fn_spin_expire_unfilled(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_expire_unfilled(integer) TO service_role;

COMMIT;

-- ROLLBACK
-- ALTER POLICY poker_arena_table_access ON public.tables USING (((club_id IS NULL) AND (union_id IS NULL)) OR fn_poker_can_read_games(COALESCE(union_id, club_id)));
-- fn_active_maintenance_release_boundary: the 20260910034411 body (without supabase_auth_admin).
-- fn_spin_expire_unfilled: the previous body differs only by `v_current.spin_multiplier IS NOT NULL`.
