-- ============================================================================
-- THE PLAY-STATE COLUMN LIST FIXES ITS SEARCH PATH
-- ============================================================================
-- fn_poker_diamond_play_state_columns (Phase 8) is a pure SQL helper the arena
-- structure guard reads; it was created without SET search_path, which the
-- security linter reports as a role-mutable search path. It references no
-- relation, so nothing could have resolved differently, but the estate's rule
-- is that every function pins its path. Applied once to kuklfnapbkmacvwxktbh.
-- ============================================================================
ALTER FUNCTION public.fn_poker_diamond_play_state_columns(text) SET search_path = public, pg_temp;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
                  AND p.proname='fn_poker_diamond_play_state_columns'
                  AND p.proconfig::text ~ 'search_path') THEN
    RAISE EXCEPTION 'fn_poker_diamond_play_state_columns still has no search_path';
  END IF;
  IF public.fn_poker_diamond_play_state_columns('tournaments') <> ARRAY['current_players','prize_pool','bounty_pool','total_rake','entry_contract_locked','updated_at'] THEN
    RAISE EXCEPTION 'the tournament play-state column list changed';
  END IF;
END $do$;
