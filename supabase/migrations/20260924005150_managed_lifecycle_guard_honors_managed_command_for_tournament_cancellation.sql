-- 20260924005150_managed_lifecycle_guard_honors_managed_command_for_tournament_cancellation
--
-- Production Alerts Fleet, board id=5 (SpinUnfilledBacklog) and id=16
-- (TournamentNeverStarted). Root cause of a blocker hit independently by
-- four PRIMARY-lane runs (2026-09-23 23:10Z, 23:45Z, 24:00:25Z and this one)
-- while trying to settle the 13 stuck Spins in PR #5139 and a further
-- 17-tournament SNG/SATELLITE cohort from the same 2026-09-08 dealer-crash
-- window: calling atomic_cancel_tournament on any of them raises
-- P0001 'This tournament cannot be cancelled after a player has registered',
-- from fn_guard_managed_game_lifecycle's BEFORE UPDATE trigger on
-- tournaments.
--
-- WHAT WAS WRONG. fn_guard_managed_game_lifecycle (introduced
-- 20260902050100_managed_game_lifecycle_is_one_door.sql, "one door" meaning
-- exactly two doors are meant to open a protected lifecycle change: the
-- engine itself (auth.role()='service_role') and an authorised managed
-- operation (current_setting('app.managed_game_lifecycle')='on', the flag
-- fn_close_managed_game and the settlement wrappers in
-- 20260909014444_tournament_cancellation_commits_one_stored_receipt.sql and
-- 20260909192240_managed_close_preserves_cash_occupancy_and_atomic_tournament_cancellation.sql
-- already set, transaction-locally, around their own atomic_cancel_tournament
-- calls). Both doors are checked correctly in the function's other two
-- lifecycle guards (the 'tables' close/delete guard just above, and the
-- generic "must use fn_close_managed_game" guard just below). The
-- "cannot be cancelled after a player has registered" clause - the one
-- clause every one of these Spin/SNG/Satellite settlements actually hits -
-- was written checking only `NOT v_is_engine`, never `NOT v_managed_command`.
-- One door, not two, on this one clause: a copy/paste gap from when the
-- clause predates the managed-command flag, not a deliberate narrowing.
--
-- WHY THE FIX IS THIS AND NOT set_config('request.jwt.claim.role', ...).
-- Six merged migrations in this repo's own history reach for spoofing the
-- service_role JWT claim to get past this exact clause. That satisfies
-- v_is_engine by impersonating the engine's own identity rather than using
-- the door this repo already built and already trusts for exactly this
-- class of operation. app.managed_game_lifecycle is not spoofable by an
-- ordinary session: it is set only inside SECURITY DEFINER functions granted
-- solely to postgres/service_role (fn_close_managed_game: EXECUTE revoked
-- from anon/authenticated, confirmed live via pg_proc.proacl before writing
-- this migration), and every existing caller already clears it again
-- immediately after (`PERFORM set_config('app.managed_game_lifecycle', '', true)`).
-- Extending this one clause to accept that same, already-narrow door removes
-- the reason six migrations (and counting) had to reach for the wider one.
--
-- WHAT THIS DOES NOT CHANGE. Every other branch of the function is
-- byte-identical: the 'tables' guard, the protected-column guard, the
-- generic "must use fn_close_managed_game" guard. A plain authenticated
-- session with neither door open is still refused, unchanged - proved
-- below with a rolled-back pg_temp probe before this was written, and
-- pinned by the regression test in the same commit.
--
-- Drift guard: fails closed if fn_guard_managed_game_lifecycle has moved
-- since this was read (md5(prosrc) = 2f9ec1b3624945c0c6ff3421dbc17980,
-- confirmed live and cross-checked against the value recorded in
-- 20260917060000_mtt_persisted_format_preparation.sql, the last migration
-- to touch this function).

BEGIN;

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_guard_managed_game_lifecycle()'::regprocedure)
     <> '2f9ec1b3624945c0c6ff3421dbc17980' THEN
    RAISE EXCEPTION 'fn_guard_managed_game_lifecycle has drifted since this migration was written - stop and re-read it before proceeding';
  END IF;
END;
$guard$;

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
  v_new_document jsonb;
  v_old_document jsonb;
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
       AND NOT v_managed_command
       AND upper(COALESCE(NEW.status, '')) IN ('CANCELLED', 'CANCELED')
       AND upper(COALESCE(OLD.status, '')) NOT IN ('CANCELLED', 'CANCELED') THEN
      RAISE EXCEPTION 'This tournament cannot be cancelled after a player has registered'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT v_is_engine THEN
      v_new_document := to_jsonb(NEW);
      v_old_document := to_jsonb(OLD);
      FOREACH v_key IN ARRAY v_protected_tournament_keys LOOP
        IF (v_new_document -> v_key) IS DISTINCT FROM (v_old_document -> v_key) THEN
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

COMMIT;
