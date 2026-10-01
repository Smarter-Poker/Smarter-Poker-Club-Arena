-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429115837 "x19_extend_process_tournament_rebuy_2026_04_29"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 82997d328f42dadb7da8c2cbed03edbf of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 19 — extend process_tournament_rebuy to accept p_rebuy_type +
-- p_current_level so callers (TournamentService rebuy/addon/reentry paths)
-- can attribute correctly. Caller passes these as audit info; production
-- signature didn't take them so PostgREST 404'd.
--
-- Also keep RPC backward-compatible by setting both new params to DEFAULTs.
-- Caller still must rename p_player_id → p_user_id (FE-side fix in
-- TournamentService.ts).

CREATE OR REPLACE FUNCTION public.process_tournament_rebuy(
  p_tournament_id  uuid,
  p_user_id        uuid,
  p_cost           numeric,
  p_chips          integer,
  p_rebuy_type     text    DEFAULT 'rebuy',
  p_current_level  integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_new_chips integer;
BEGIN
  IF p_cost > 0 THEN PERFORM public.deduct_player_wallet(p_user_id, p_cost); END IF;

  UPDATE public.tournament_players
     SET chips = chips + p_chips
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id
  RETURNING chips INTO v_new_chips;

  UPDATE public.tournaments
     SET prize_pool = prize_pool + p_cost
   WHERE id = p_tournament_id;

  -- Best-effort accounting row; ignore if the audit table doesn't exist.
  BEGIN
    INSERT INTO public.tournament_player_actions
      (tournament_id, user_id, action, amount, level_idx, notes)
    VALUES (p_tournament_id, p_user_id, p_rebuy_type, p_cost, p_current_level,
            'process_tournament_rebuy');
  EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'tournament_id', p_tournament_id,
    'user_id', p_user_id,
    'rebuy_type', p_rebuy_type,
    'cost', p_cost,
    'chips_added', p_chips,
    'new_chip_total', v_new_chips,
    'level_idx', p_current_level
  );
END $function$;

-- Drop the old void-returning overload so the new jsonb-returning one is the
-- only callable form; otherwise PostgREST will pick by exact arg-name match
-- and we want the new signature to be preferred.
DROP FUNCTION IF EXISTS public.process_tournament_rebuy(uuid, uuid, numeric, integer);

REVOKE EXECUTE ON FUNCTION public.process_tournament_rebuy(uuid, uuid, numeric, integer, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_tournament_rebuy(uuid, uuid, numeric, integer, text, integer)
  TO service_role;
