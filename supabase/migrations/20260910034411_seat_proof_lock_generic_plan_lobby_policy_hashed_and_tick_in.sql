-- 20260910034411_seat_proof_lock_generic_plan_lobby_policy_hashed_and_tick_in.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (swarm workstreams A, B, E, 2026-09-10; full
-- evidence in docs/changelog/2026-09-10-swarm-per-hand-cost.md):
--
-- 1. trg_lock_and_validate_tournament_live_seat (B): the proof-open EXISTS used
--    `t.id = ANY(v_ids)`. With an array parameter PL/pgSQL never adopts the
--    generic plan and re-plans the statement on EVERY tournament seat write:
--    0.83-0.99 ms measured, 55-60% of all trigger time on a tournament seat
--    stack write in steady state. `(t.id = v_old OR t.id = v_new)` returns
--    the same rows (the unassigned side is NULL and matches nothing in either
--    form) and adopts the generic plan: 0.026 ms. v_ids, the lock helper and
--    every branch are unchanged. ~-0.85 ms per tournament seat write, ~-4.9 ms
--    per tournament hand at 5.7 seats.
--
-- 2. fn_active_maintenance_release_boundary (A): behind fn_platform_frozen()
--    on every non-exempt money write and every fn_entry_purchases_frozen()
--    call. The planner ran `shifted ?& <14 keys>` first over all 167
--    engine_maintenance_thaws rows (0 are contract_version 3). An OFFSET 0
--    fence makes the two scalar quals run first: 229 us -> 32 us per call,
--    same four ANDed quals, same max(). Note from A: the requested
--    "frozen-check-first" reorder of fn_refuse_while_frozen is NOT applied -
--    measured, it would cost engine (service_role) writes 0.06 -> 0.35 ms.
--
-- 3. RLS policy poker_arena_tournament_access on tournaments (E): a RESTRICTIVE
--    policy calling plpgsql fn_poker_can_read_games(COALESCE(union_id, club_id))
--    PER ROW. The operations lobby query (club_id = ANY, status = ANY, ORDER BY
--    updated_at DESC LIMIT 80, includes COMPLETED) scanned 135,616 rows for a
--    union member: 66.7 s measured, and 148 statement timeouts (8 s) in 70 min
--    that never reach pg_stat_statements. Rewritten as
--    `COALESCE(union_id, club_id) IN (SELECT c.id FROM clubs c WHERE fn(c.id))`:
--    the function runs once per club (5) in a hashed subplan, each row is a
--    hash probe. Identical rows: every COALESCE(union_id, club_id) value exists
--    in clubs (0 orphans, checked), clubs has a `true` PERMISSIVE SELECT policy
--    for public, and the function is STABLE SECURITY DEFINER. 66,700 ms -> 340 ms,
--    -> ~14 ms with the updated_at index (4). The same per-row pattern exists on
--    `tables` (poker_arena_table_access); deliberately not changed here.
--
-- 4. Indexes (E), in this transaction (plain CREATE INDEX: sub-second builds on
--    24 MB / 148 MB tables, one reload for the whole batch instead of one per
--    CONCURRENTLY statement):
--    - cash_seat_moves (player_id, created_at) WHERE state='cancelled': the
--      60-second back-off test in fn_cash_clusters_tick_all / balance / break /
--      seat-change planning was a 110k-row seq scan PER CANDIDATE SEAT
--      (496 ms, 88k buffers for one open seat on the biggest game).
--    - tables (cluster_id, role, main_index, created_at) WHERE lifecycle<>'closed':
--      137 rows qualify; every per-cluster statement walked tables_cluster_id_idx
--      and discarded ~97% closed tables; fn_cash_clusters_to_tick's EXISTS
--      seq-scanned all 206k rows (78 ms) per pass.
--    - tables (cluster_id) WHERE lifecycle='closed' AND status<>'closed': the
--      status_followed_lifecycle repair UPDATE, every tick, every game.
--    tournaments (updated_at DESC) is built CONCURRENTLY outside this file's
--    transaction (see the note at the bottom) because 264 MB is long enough to
--    hold tournament writes past the engine's 8 s timeout.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_lock_and_validate_tournament_live_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_ids uuid[];
  v_is_live_acquisition boolean := false;
  v_proof_open boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.seat_number IS NOT DISTINCT FROM OLD.seat_number
     AND NEW.stack IS NOT DISTINCT FROM OLD.stack
     AND NEW.left_at IS NOT DISTINCT FROM OLD.left_at THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    SELECT t.tournament_id INTO v_old_tournament_id
      FROM public.tables t
     WHERE t.id = OLD.table_id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id THEN
    -- Same table on both sides: one lookup answers for both (2026-09-10).
    v_new_tournament_id := v_old_tournament_id;
  ELSIF TG_OP <> 'DELETE' THEN
    SELECT t.tournament_id INTO v_new_tournament_id
      FROM public.tables t
     WHERE t.id = NEW.table_id;
  END IF;

  -- A CASH SEAT HAS NO LAUNCH PROOF TO LOCK (2026-09-10). With both ids NULL
  -- the body below cannot lock, refuse or require anything: v_ids would be
  -- {NULL,NULL}, the proof-open test is false, the lock helper returns on an
  -- empty set, and the roster check needs a tournament. Measured 6.4 ms per
  -- seat write on a cash table for that no-op; see the migration header.
  IF v_old_tournament_id IS NULL AND v_new_tournament_id IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_ids := CASE
    WHEN TG_OP = 'INSERT' THEN ARRAY[v_new_tournament_id]
    WHEN TG_OP = 'DELETE' THEN ARRAY[v_old_tournament_id]
    ELSE ARRAY[v_old_tournament_id, v_new_tournament_id]
  END;

  IF TG_OP = 'INSERT' THEN
    v_is_live_acquisition := NEW.left_at IS NULL AND NEW.user_id IS NOT NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    v_is_live_acquisition := NEW.left_at IS NULL
      AND NEW.user_id IS NOT NULL
      AND (
        OLD.left_at IS NOT NULL
        OR OLD.user_id IS DISTINCT FROM NEW.user_id
        OR OLD.table_id IS DISTINCT FROM NEW.table_id
      );
  END IF;

  IF NOT v_is_live_acquisition THEN
    -- THE SAME ROWS AS `t.id = ANY(v_ids)`, WITHOUT A RE-PLAN PER CALL
    -- (2026-09-10). v_ids is {new} / {old} / {old,new} for INSERT / DELETE /
    -- UPDATE, and the side that is not assigned is NULL, which matches nothing
    -- in either form. With an array parameter PL/pgSQL keeps a custom plan and
    -- re-plans this statement on every seat write (0.83-0.99 ms measured);
    -- with two scalar parameters it adopts the generic plan (0.026 ms).
    SELECT EXISTS (
      SELECT 1
        FROM public.tournaments t
        LEFT JOIN public.tournament_launch_receipts r
          ON r.tournament_id = t.id
       WHERE (t.id = v_old_tournament_id OR t.id = v_new_tournament_id)
         AND (upper(t.status::text) = 'REGISTERING' OR r.completed_at IS NULL)
         AND (upper(t.status::text) = 'REGISTERING' OR r.tournament_id IS NOT NULL)
    ) INTO v_proof_open;
    IF NOT v_proof_open THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  END IF;

  PERFORM *
    FROM public.fn_lock_tournament_launch_proof_parents(v_ids);

  IF TG_OP <> 'DELETE'
     AND NEW.left_at IS NULL
     AND NEW.user_id IS NOT NULL
     AND v_new_tournament_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = v_new_tournament_id
          AND p.user_id = NEW.user_id
          AND p.status IN ('registered', 'playing')
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ROSTER_REQUIRED: live seat user % has no active roster in tournament %',
      NEW.user_id, v_new_tournament_id
      USING ERRCODE = '23514';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

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
  SELECT session_user IN ('postgres', 'supabase_admin', 'service_role')
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
$function$;

ALTER POLICY poker_arena_tournament_access ON public.tournaments USING (((club_id IS NULL) AND (union_id IS NULL)) OR (COALESCE(union_id, club_id) IN (SELECT c.id FROM public.clubs c WHERE public.fn_poker_can_read_games(c.id))));

CREATE INDEX IF NOT EXISTS idx_cash_seat_moves_cancelled_player ON public.cash_seat_moves (player_id, created_at) WHERE state = 'cancelled';
CREATE INDEX IF NOT EXISTS idx_tables_cluster_open ON public.tables (cluster_id, role, main_index, created_at) WHERE lifecycle <> 'closed';
CREATE INDEX IF NOT EXISTS idx_tables_cluster_closed_status_drift ON public.tables (cluster_id) WHERE lifecycle = 'closed' AND status <> 'closed';

COMMIT;

-- Applied on production 2026-09-10 with CREATE INDEX CONCURRENTLY, outside the
-- transaction (cannot run inside one). Plain form here for branches/local.
CREATE INDEX IF NOT EXISTS idx_tournaments_updated_at ON public.tournaments (updated_at DESC);

-- ROLLBACK
-- ALTER POLICY poker_arena_tournament_access ON public.tournaments USING (((club_id IS NULL) AND (union_id IS NULL)) OR fn_poker_can_read_games(COALESCE(union_id, club_id)));
-- DROP INDEX IF EXISTS idx_cash_seat_moves_cancelled_player, idx_tables_cluster_open, idx_tables_cluster_closed_status_drift, idx_tournaments_updated_at;
-- Previous function bodies: git history of 20260910020459 (trg_lock_and_validate_tournament_live_seat,
-- differs only by `t.id = ANY(v_ids)`), and the ROLLBACK block of
-- /docs/changelog/2026-09-10-swarm-per-hand-cost.md for fn_active_maintenance_release_boundary.
