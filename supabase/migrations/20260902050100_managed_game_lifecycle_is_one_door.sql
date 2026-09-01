-- Phase 1: every operator lifecycle command goes through one authoritative door.
-- Version 20260902050100 is intentionally unique; 20260902050000 belongs to
-- daily_mission_realtime_publication_refresh and would make one migration skip.
-- Browser RLS used to let club admins reproduce the old direct soft-delete and
-- cancellation writes even after the management UI moved to guarded RPCs.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_guard_managed_game_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_engine boolean := COALESCE(auth.role(), '') = 'service_role';
  v_managed_command boolean :=
    COALESCE(current_setting('app.managed_game_lifecycle', true), '') = 'on';
  v_protected_tournament_keys text[] := ARRAY[
    'name', 'start_time', 'max_players', 'buy_in_amount', 'buy_in_fee',
    'guaranteed_prize', 'late_reg_mins', 'starting_chips', 'blind_structure',
    'payout_structure', 'game_type', 'variant', 'tournament_type', 'is_rebuy',
    'rebuy_cost', 'rebuy_chips', 'rebuy_levels', 'add_on_available',
    'addon_cost', 'addon_chips', 'is_bounty', 'bounty_amount', 'is_pko',
    'is_mystery_bounty', 'mystery_bounty_min', 'mystery_bounty_max',
    'description', 'short_description', 'min_players', 'late_reg_levels',
    'is_reentry', 'max_rebuys', 'max_reentries', 'addon_levels',
    'addon_break_minutes', 'is_private', 'is_vip_only', 'ban_chat',
    'all_in_or_fold', 'label_as_new', 'hide_club_name', 'is_pinned',
    'action_time_seconds', 'table_size', 'accelerated_mtt', 'big_blind_ante',
    'authorized_to_register', 'early_bird_enabled', 'early_bird_chips',
    'bubble_protection', 'final_table_deal_enabled', 'restart_every_minutes',
    'synchronized_breaks', 'is_multi_day', 'total_days', 'is_xmtt',
    'union_id', 'satellite_target_id', 'satellite_seats', 'spin_type',
    'mystery_bounty_profile', 'mystery_bounty_activation',
    'mystery_bounty_activation_value', 'mystery_bounty_pool_percent',
    'mystery_bounty_top_percent', 'settings'
  ];
  v_key text;
BEGIN
  IF TG_TABLE_NAME = 'tables' THEN
    IF lower(COALESCE(NEW.status, '')) IN ('closed', 'deleted')
       AND lower(COALESCE(OLD.status, '')) NOT IN ('closed', 'deleted')
       AND EXISTS (
         SELECT 1
         FROM public.table_seats ts
         WHERE ts.table_id = NEW.id
           AND ts.left_at IS NULL
       ) THEN
      RAISE EXCEPTION 'This table cannot be closed while players are seated'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT v_is_engine
       AND NOT v_managed_command
       AND (
         lower(COALESCE(NEW.status, '')) = 'deleted'
         AND lower(COALESCE(OLD.status, '')) <> 'deleted'
         OR COALESCE(NEW.is_deleted, false) AND NOT COALESCE(OLD.is_deleted, false)
       ) THEN
      RAISE EXCEPTION 'Table lifecycle changes must use fn_close_managed_game'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'tournaments'
     AND EXISTS (
       SELECT 1
       FROM public.tournament_players tp
       WHERE tp.tournament_id = NEW.id
     ) THEN
    IF NOT v_is_engine
       AND upper(COALESCE(NEW.status, '')) IN ('CANCELLED', 'CANCELED')
       AND upper(COALESCE(OLD.status, '')) NOT IN ('CANCELLED', 'CANCELED') THEN
      RAISE EXCEPTION 'This tournament cannot be cancelled after a player has registered'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT v_is_engine THEN
      FOREACH v_key IN ARRAY v_protected_tournament_keys LOOP
        IF (to_jsonb(NEW) -> v_key) IS DISTINCT FROM (to_jsonb(OLD) -> v_key) THEN
          RAISE EXCEPTION 'This tournament cannot be modified after a player has registered'
            USING ERRCODE = 'P0001';
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF NOT v_is_engine
     AND NOT v_managed_command
     AND upper(COALESCE(NEW.status, '')) IN ('CANCELLED', 'CANCELED')
     AND upper(COALESCE(OLD.status, '')) NOT IN ('CANCELLED', 'CANCELED') THEN
    RAISE EXCEPTION 'Tournament lifecycle changes must use fn_close_managed_game'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_tables_managed_lifecycle_guard ON public.tables;
CREATE TRIGGER trg_tables_managed_lifecycle_guard
BEFORE UPDATE OF status, is_deleted ON public.tables
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_managed_game_lifecycle();

DROP TRIGGER IF EXISTS trg_tournaments_managed_lifecycle_guard ON public.tournaments;
CREATE TRIGGER trg_tournaments_managed_lifecycle_guard
BEFORE UPDATE ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_managed_game_lifecycle();

-- UPDATE guards are not DELETE guards. Keep this separate so OLD is always
-- available and no DELETE execution can accidentally dereference NEW.
CREATE OR REPLACE FUNCTION public.fn_guard_managed_game_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_engine boolean := COALESCE(auth.role(), '') = 'service_role';
BEGIN
  IF TG_TABLE_NAME = 'tables' THEN
    IF EXISTS (
      SELECT 1 FROM public.table_seats ts
       WHERE ts.table_id = OLD.id AND ts.left_at IS NULL
    ) THEN
      RAISE EXCEPTION 'This table cannot be deleted while players are seated'
        USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_is_engine THEN
      RAISE EXCEPTION 'Tables are closed through fn_close_managed_game, never deleted'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'This tournament cannot be deleted after a player has registered'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT v_is_engine THEN
    RAISE EXCEPTION 'Tournaments are cancelled through fn_close_managed_game, never deleted'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS trg_tables_managed_delete_guard ON public.tables;
CREATE TRIGGER trg_tables_managed_delete_guard
BEFORE DELETE ON public.tables
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_managed_game_delete();

DROP TRIGGER IF EXISTS trg_tournaments_managed_delete_guard ON public.tournaments;
CREATE TRIGGER trg_tournaments_managed_delete_guard
BEFORE DELETE ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_managed_game_delete();

CREATE OR REPLACE FUNCTION public.fn_update_managed_game(
  p_kind text,
  p_game_id uuid,
  p_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
  v_players int;
  v_status text;
  v_name text;
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
      UPDATE public.tables SET name = v_name, updated_at = now() WHERE id = p_game_id;
    ELSE
      IF (p_patch ->> 'small_blind')::numeric <= 0
         OR (p_patch ->> 'big_blind')::numeric < (p_patch ->> 'small_blind')::numeric
         OR (p_patch ->> 'min_buy_in')::numeric <= 0
         OR (p_patch ->> 'max_buy_in')::numeric < (p_patch ->> 'min_buy_in')::numeric THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'invalid_table_limits');
      END IF;
      UPDATE public.tables
         SET name = v_name,
             small_blind = (p_patch ->> 'small_blind')::numeric,
             big_blind = (p_patch ->> 'big_blind')::numeric,
             min_buy_in = (p_patch ->> 'min_buy_in')::numeric,
             max_buy_in = (p_patch ->> 'max_buy_in')::numeric,
             max_players = LEAST(10, GREATEST(2, (p_patch ->> 'max_players')::int)),
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
           max_players = GREATEST(2, (p_patch ->> 'max_players')::int),
           start_time = COALESCE((p_patch ->> 'start_time')::timestamptz, start_time),
           updated_at = now()
     WHERE id = p_game_id;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_close_managed_game(
  p_kind text,
  p_game_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
  v_status text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_kind = 'table' THEN
    SELECT club_id, status
      INTO v_club, v_status
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

    PERFORM set_config('app.managed_game_lifecycle', 'on', true);
    UPDATE public.tables
       SET status = 'closed', current_players = 0, updated_at = now()
     WHERE id = p_game_id;
    PERFORM set_config('app.managed_game_lifecycle', '', true);
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

    PERFORM set_config('app.managed_game_lifecycle', 'on', true);
    UPDATE public.tournaments
       SET status = 'CANCELLED', ended_at = now(), updated_at = now()
     WHERE id = p_game_id;
    UPDATE public.tables
       SET status = 'closed', current_players = 0
     WHERE tournament_id = p_game_id;
    PERFORM set_config('app.managed_game_lifecycle', '', true);
    RETURN jsonb_build_object('ok', true);
  END IF;

  RETURN jsonb_build_object('ok', false, 'reason', 'invalid_game_kind');
END;
$function$;

-- Refund cancellation is an integrity-recovery primitive, not an operator API.
-- The browser uses fn_close_managed_game, which refuses after any registration.
REVOKE ALL ON FUNCTION public.atomic_cancel_tournament(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_cancel_tournament(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_guard_managed_game_lifecycle() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_guard_managed_game_lifecycle() TO service_role;
REVOKE ALL ON FUNCTION public.fn_guard_managed_game_delete() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_guard_managed_game_delete() TO service_role;

COMMIT;
