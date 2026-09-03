-- ═══════════════════════════════════════════════════════════════════════════════
-- Walkthrough Round 19 — RPC param sig mismatch fixes (continuation of Round 18).
--
-- All FE caller fixes (drop unused extras / rename mismatched names) are
-- in src/services/* and src/pages/* TS commits — no SQL needed.
--
-- One RPC needed extending in Postgres because the caller's extra params
-- carry real audit value:
--
--   process_tournament_rebuy
--     was: (p_tournament_id, p_user_id, p_cost, p_chips) → void
--     now: (p_tournament_id, p_user_id, p_cost, p_chips,
--           p_rebuy_type DEFAULT 'rebuy', p_current_level DEFAULT NULL) → jsonb
--
--   The TournamentService caller wraps three flows (rebuy, addon, reentry)
--   into the same RPC and tracks current level for end-of-tournament
--   accounting. PostgREST 404'd because the params didn't exist in prod.
--   Extended with optional defaults (back-compat) + a best-effort audit
--   row in tournament_player_actions if that table exists.
--
-- FE caller fixes shipped alongside:
--   add_chips                  drop p_reason
--   add_to_promo_wallet        drop p_description (3 callers)
--   fn_add_diamonds            drop p_reason
--   fn_check_level_advancement drop p_target_level
--   fn_purchase_feature        drop p_quantity (kept void in TS for caller API)
--   fn_discover_clubs          radius/lat/lng → search/limit/offset (location
--                              discover doesn't exist in prod; falls back to
--                              search-based until PostGIS upgrade)
--   increment_member_count     club_id → p_club_id, add p_delta: 1
--   process_tournament_rebuy   p_player_id → p_user_id (3 callers)
--
-- Applied to production via Supabase MCP migration
-- x19_extend_process_tournament_rebuy_2026_04_29.
-- ═══════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.process_tournament_rebuy(uuid, uuid, numeric, integer);

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

REVOKE EXECUTE ON FUNCTION public.process_tournament_rebuy(uuid, uuid, numeric, integer, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_tournament_rebuy(uuid, uuid, numeric, integer, text, integer)
  TO service_role;
