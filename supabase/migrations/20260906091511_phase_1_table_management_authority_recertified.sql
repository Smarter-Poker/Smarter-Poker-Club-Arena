-- Phase 1 table-management authority, recertified after later cash-game work.
--
-- The original lifecycle migration counted every occupied seat and every
-- tournament entry. Later CREATE OR REPLACE migrations accidentally restored
-- `user_id IS NOT NULL` inside the private update/close helpers. The row-level
-- lifecycle triggers still stopped the final destructive write, but the
-- supported command door returned `command_failed` instead of the precise
-- `players_seated` / `players_registered` refusal for a nullable system or
-- horse row. That broke the operator notification contract and left the
-- helper's own safety weaker than the trigger protecting it.
--
-- The newer cash-game creator also admitted
-- `fn_can_create_games(...) OR is_club_admin(...)`. The second leg bypasses
-- union governance: a club admin remains a club admin after the club joins a
-- union, even though only the union console may create games from then on.
-- Keep the mature creator body as a private implementation and restore its
-- public signature as a union-aware wrapper. Existing callers do not change.
--
-- All changes are one transaction. No table rewrite or long-lived table lock
-- is required; CREATE OR REPLACE and function ACL changes are safe under live
-- traffic.

BEGIN;

-- Direct inserts must ask the same union-aware question as every governed
-- creator. The old private-table exception let an affiliated club admin write
-- a table even though fn_can_create_games correctly said only the union may.
DROP POLICY IF EXISTS tables_insert_owner_or_admin ON public.tables;
CREATE POLICY tables_insert_owner_or_admin
  ON public.tables
  FOR INSERT
  TO authenticated
  WITH CHECK (public.fn_can_create_games(club_id, (SELECT auth.uid())));

-- A table is a durable game record. Operators close it through the command
-- gateway; they never DELETE it. service_role bypasses RLS for accountable
-- recovery and the Phase 1 delete trigger remains the final row guard.
DROP POLICY IF EXISTS tables_delete ON public.tables;

-- The implementation remains intact, including the cluster writer introduced
-- by Operation Table Stakes. Only this wrapper and service-role recovery can
-- reach it after the rename.
ALTER FUNCTION public.fn_cash_game_create(
  uuid, text, text, numeric, numeric, integer, jsonb, text, boolean
) RENAME TO fn_cash_game_create_impl_20260905;

REVOKE ALL ON FUNCTION public.fn_cash_game_create_impl_20260905(
  uuid, text, text, numeric, numeric, integer, jsonb, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_create_impl_20260905(
  uuid, text, text, numeric, numeric, integer, jsonb, text, boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_cash_game_create(
  p_club_id uuid,
  p_template text,
  p_variant text,
  p_sb numeric,
  p_bb numeric,
  p_handedness integer DEFAULT NULL,
  p_overrides jsonb DEFAULT '{}'::jsonb,
  p_name text DEFAULT NULL,
  p_must_move boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_cash_game_create requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF p_club_id IS NULL THEN
    RAISE EXCEPTION 'CLUB_REQUIRED';
  END IF;
  IF NOT public.fn_can_create_games(p_club_id, v_uid) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: this club is managed by its union';
  END IF;

  RETURN public.fn_cash_game_create_impl_20260905(
    p_club_id, p_template, p_variant, p_sb, p_bb, p_handedness,
    p_overrides, p_name, p_must_move
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_cash_game_create(
  uuid, text, text, numeric, numeric, integer, jsonb, text, boolean
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_create(
  uuid, text, text, numeric, numeric, integer, jsonb, text, boolean
) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_cash_game_create(
  uuid, text, text, numeric, numeric, integer, jsonb, text, boolean
) IS 'Union-aware cash-game creation door. Affiliated club staff cannot bypass fn_can_create_games.';

-- Preserve the omitted-field correction from 20260902212622 while restoring
-- the Phase 1 rule that any registration row locks the tournament contract.
CREATE OR REPLACE FUNCTION public.fn_update_managed_game(
  p_kind text,
  p_game_id uuid,
  p_patch jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
  v_players integer;
  v_status text;
  v_name text;
  v_sb numeric;
  v_bb numeric;
  v_min numeric;
  v_max numeric;
  v_seats integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_kind = 'table' THEN
    SELECT club_id, current_players, status
      INTO v_club, v_players, v_status
      FROM public.tables
     WHERE id = p_game_id
     FOR UPDATE;
  ELSIF p_kind = 'tournament' THEN
    SELECT club_id, current_players, status
      INTO v_club, v_players, v_status
      FROM public.tournaments
     WHERE id = p_game_id
     FOR UPDATE;
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_game_kind');
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
  END IF;
  IF NOT public.fn_can_create_games(v_club, v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  v_name := left(regexp_replace(COALESCE(p_patch ->> 'name', ''), '\s+', ' ', 'g'), 80);
  IF length(trim(v_name)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'name_required');
  END IF;

  IF p_kind = 'table' THEN
    IF v_players > 0 OR lower(v_status) IN ('running', 'active') THEN
      UPDATE public.tables
         SET name = v_name, updated_at = now()
       WHERE id = p_game_id;
    ELSE
      SELECT COALESCE((p_patch ->> 'small_blind')::numeric, t.small_blind),
             COALESCE((p_patch ->> 'big_blind')::numeric, t.big_blind),
             COALESCE((p_patch ->> 'min_buy_in')::numeric, t.min_buy_in),
             COALESCE((p_patch ->> 'max_buy_in')::numeric, t.max_buy_in),
             COALESCE((p_patch ->> 'max_players')::integer, t.max_players)
        INTO v_sb, v_bb, v_min, v_max, v_seats
        FROM public.tables t
       WHERE t.id = p_game_id;

      IF v_sb IS NULL OR v_bb IS NULL OR v_min IS NULL OR v_max IS NULL OR v_seats IS NULL
         OR v_sb <= 0 OR v_bb < v_sb OR v_min <= 0 OR v_max < v_min THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'invalid_table_limits');
      END IF;

      UPDATE public.tables
         SET name = v_name,
             small_blind = v_sb,
             big_blind = v_bb,
             min_buy_in = v_min,
             max_buy_in = v_max,
             max_players = LEAST(10, GREATEST(2, v_seats)),
             updated_at = now()
       WHERE id = p_game_id;
    END IF;
  ELSE
    PERFORM 1
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_game_id
     FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'players_registered');
    END IF;
    IF upper(v_status) NOT IN ('ANNOUNCED', 'REGISTERING', 'SCHEDULED') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_started');
    END IF;

    UPDATE public.tournaments
       SET name = v_name,
           max_players = GREATEST(
             2,
             COALESCE((p_patch ->> 'max_players')::integer, max_players)
           ),
           start_time = COALESCE((p_patch ->> 'start_time')::timestamptz, start_time),
           updated_at = now()
     WHERE id = p_game_id;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- Preserve the cash-game cluster shutdown added on 2026-09-04. The only
-- semantic change is that every active seat/entry row is counted, regardless
-- of whether the participant has a conventional auth user id.
CREATE OR REPLACE FUNCTION public.fn_close_managed_game(
  p_kind text,
  p_game_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
  v_status text;
  v_cluster uuid;
  v_role text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_kind = 'table' THEN
    SELECT club_id, status, cluster_id, role
      INTO v_club, v_status, v_cluster, v_role
      FROM public.tables
     WHERE id = p_game_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
    END IF;
    IF NOT public.fn_can_create_games(v_club, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
    IF lower(COALESCE(v_status, '')) IN ('closed', 'completed', 'cancelled', 'finished') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_closed');
    END IF;

    PERFORM 1
      FROM public.table_seats ts
     WHERE ts.table_id = p_game_id
       AND ts.left_at IS NULL
     FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'players_seated');
    END IF;

    UPDATE public.tables
       SET status = 'closed', current_players = 0, updated_at = now()
     WHERE id = p_game_id;

    IF v_cluster IS NOT NULL AND v_role = 'main' THEN
      UPDATE public.cash_games
         SET enabled = false,
             state = 'dormant',
             closed_at = now(),
             closed_by = v_uid,
             updated_at = now()
       WHERE id = v_cluster
         AND enabled;
    END IF;
    RETURN jsonb_build_object('ok', true);
  ELSIF p_kind = 'tournament' THEN
    SELECT club_id, status
      INTO v_club, v_status
      FROM public.tournaments
     WHERE id = p_game_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
    END IF;
    IF NOT public.fn_can_create_games(v_club, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
    IF upper(COALESCE(v_status, '')) IN ('COMPLETED', 'CANCELLED', 'CANCELED', 'COMPLETING') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_closed');
    END IF;

    PERFORM 1
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_game_id
     FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'players_registered');
    END IF;

    UPDATE public.tournaments
       SET status = 'CANCELLED', ended_at = now(), updated_at = now()
     WHERE id = p_game_id;
    UPDATE public.tables
       SET status = 'closed', current_players = 0
     WHERE tournament_id = p_game_id;
    RETURN jsonb_build_object('ok', true);
  END IF;

  RETURN jsonb_build_object('ok', false, 'reason', 'invalid_game_kind');
END;
$function$;

-- Both helpers are private implementation details behind the durable command
-- gateway. Restate the ACL because CREATE OR REPLACE preserves whatever was
-- present, and the migration is also the schema-rebuild record.
REVOKE ALL ON FUNCTION public.fn_update_managed_game(text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_update_managed_game(text, uuid, jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_close_managed_game(text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_close_managed_game(text, uuid)
  TO service_role;

DO $assert$
DECLARE
  v_cash text;
  v_update text;
  v_close text;
BEGIN
  SELECT p.prosrc INTO v_cash
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.oid = 'public.fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)'::regprocedure;
  SELECT p.prosrc INTO v_update
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.oid = 'public.fn_update_managed_game(text,uuid,jsonb)'::regprocedure;
  SELECT p.prosrc INTO v_close
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.oid = 'public.fn_close_managed_game(text,uuid)'::regprocedure;

  IF position('is_club_admin' in v_cash) > 0
     OR position('fn_can_create_games' in v_cash) = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: cash-game creation bypasses union governance';
  END IF;
  IF position('tp.user_id IS NOT NULL' in v_update) > 0
     OR position('tp.user_id IS NOT NULL' in v_close) > 0
     OR position('ts.user_id IS NOT NULL' in v_close) > 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: lifecycle helpers exclude a nullable participant';
  END IF;
  IF has_function_privilege(
       'authenticated',
       'public.fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'ASSERT FAILED: authenticated can reach the private cash-game implementation';
  END IF;
  IF has_function_privilege(
       'authenticated',
       'public.fn_close_managed_game(text,uuid)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public.fn_update_managed_game(text,uuid,jsonb)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'ASSERT FAILED: authenticated can bypass the command gateway';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'tables'
       AND cmd = 'INSERT'
       AND COALESCE(with_check, '') <> 'fn_can_create_games(club_id, ( SELECT auth.uid() AS uid))'
  ) THEN
    RAISE EXCEPTION 'ASSERT FAILED: a tables INSERT policy bypasses union governance';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'tables'
       AND cmd = 'DELETE'
  ) THEN
    RAISE EXCEPTION 'ASSERT FAILED: a direct table DELETE policy survived';
  END IF;
END;
$assert$;

COMMIT;
