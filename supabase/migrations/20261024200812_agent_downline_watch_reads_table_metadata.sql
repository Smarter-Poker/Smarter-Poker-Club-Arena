-- @live-proof: (to_regprocedure('public.fn_agent_watch_table_metadata(uuid)') IS NOT NULL AND NOT has_function_privilege('anon','public.fn_agent_watch_table_metadata(uuid)','EXECUTE') AND has_function_privilege('authenticated','public.fn_agent_watch_table_metadata(uuid)','EXECUTE'))
-- Owner 2026-10-24: every agent can watch their downlines on any table.
-- TablePage builds the felt from the public.tables row. For a downline at a
-- table in a club the agent does not belong to, the RESTRICTIVE
-- poker_arena_table_access policy hides that row, so a permissive policy
-- (the queued 20261024020328 one) cannot reveal it. This read-only definer
-- returns the same bootstrap columns only when fn_agent_can_watch_table
-- allows the signed-in viewer. Function only: no relation lock, no break.
-- Observation does not grant seating, money operations or private cards.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_agent_watch_table_metadata(p_table_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_row jsonb;
BEGIN
  IF v_uid IS NULL OR p_table_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT coalesce(public.fn_agent_can_watch_table(p_table_id, v_uid), false) THEN
    RETURN NULL;
  END IF;

  SELECT (
           SELECT jsonb_object_agg(e.key, e.value)
             FROM jsonb_each(to_jsonb(t)) e
            WHERE e.key = ANY (ARRAY[
              'id', 'union_id', 'name', 'game_variant', 'game_type', 'tournament_id',
              'stakes', 'small_blind', 'big_blind', 'max_players', 'club_id', 'settings',
              'min_buy_in', 'max_buy_in', 'straddle_enabled', 'bomb_pot_enabled',
              'bomb_pot_frequency', 'bomb_pot_ante_multiplier', 'bomb_pot_double_board',
              'bomb_pot_board_count', 'bomb_pot_trigger_mode', 'bomb_pot_interval_seconds',
              'bomb_pot_variant', 'bomb_pot_announce_seconds', 'bomb_pot_ante_fixed',
              'bomb_pot_min_players', 'bomb_pot_button_policy', 'cluster_id', 'nit_game',
              'maintain_percent_min', 'maintain_hands'
            ])
         ) || jsonb_build_object(
           'arena',
           (SELECT jsonb_object_agg(e.key, e.value)
              FROM public.clubs c, jsonb_each(to_jsonb(c)) e
             WHERE c.id = t.club_id
               AND e.key = ANY (ARRAY['id', 'asset', 'is_platform', 'union_id']))
         )
    INTO v_row
    FROM public.tables t
   WHERE t.id = p_table_id
     AND coalesce(t.is_deleted, false) = false;

  RETURN v_row;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_agent_watch_table_metadata(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_agent_watch_table_metadata(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_agent_watch_table_metadata(uuid) IS
  'TablePage bootstrap columns for a table the signed-in agent may observe because an active recursive downline is playing there (fn_agent_can_watch_table). Read only; NULL otherwise.';

COMMIT;
