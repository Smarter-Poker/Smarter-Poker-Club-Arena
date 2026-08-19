-- Harden the leaderboard loss-accumulation gate inside promo_apply_playthrough.
--
-- Previous gate (20260819g): auth.role() = 'service_role' OR session_user = 'postgres'.
-- Correct in production (PostgREST connects as `authenticator`, never `postgres`,
-- so an authenticated client could not reach the write), but the session_user
-- clause makes the DENY path impossible to prove from an admin SQL session,
-- where session_user IS postgres. A security control that cannot be tested is a
-- security control nobody can trust.
--
-- New gate is fail-closed on the caller's JWT role and never consults
-- session_user, so "authenticated cannot write stats" is directly testable:
--   allow when  auth.role() = 'service_role'             (the game engine)
--          or   auth.role() IS NULL AND current_user IN (postgres, supabase_admin)
--                                                        (migrations / backfill)
--   deny  for   authenticated, anon, and anything else.
--
-- Verified after apply (2026-08-19): an authenticated-claims call with
-- p_wagered = 999,999,999 moved total_losses by 0.00, while the engine's
-- service_role writes continued (winnings +4,313.27 / losses +4,409.31 over a
-- 25s window, difference = rake). Promo money logic below the gate is
-- byte-identical to 20260819g.
--
-- ROLLBACK: restore the definition from 20260819g_leaderboard_real_profit_pipeline.sql (section 3).
CREATE OR REPLACE FUNCTION public.promo_apply_playthrough(p_club_id uuid, p_user_id uuid, p_wagered numeric)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_promo    numeric;
  v_required numeric;
  v_wagered  numeric;
  v_released numeric := 0;
  v_caller   text := COALESCE(auth.role(), '');
BEGIN
  IF p_wagered IS NULL OR p_wagered <= 0 THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_wager');
  END IF;

  -- Leaderboard loss accumulation (fail-closed). Engine (service_role) or
  -- trusted admin/migration context only; never reachable by authenticated or
  -- anon. Exception-safe: a stats failure must never affect the promo money path.
  IF v_caller = 'service_role'
     OR (v_caller = '' AND current_user IN ('postgres', 'supabase_admin')) THEN
    BEGIN
      INSERT INTO player_stats (id, user_id, club_id, total_losses, updated_at)
      VALUES (gen_random_uuid(), p_user_id, p_club_id, p_wagered, now())
      ON CONFLICT (user_id, club_id) DO UPDATE
         SET total_losses = player_stats.total_losses + EXCLUDED.total_losses,
             updated_at   = now();
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  SELECT COALESCE(promo_balance, 0), COALESCE(promo_playthrough_required, 0), COALESCE(promo_wagered, 0)
    INTO v_promo, v_required, v_wagered
    FROM club_members
   WHERE club_id = p_club_id AND user_id = p_user_id
   FOR UPDATE;

  IF v_promo IS NULL OR v_promo <= 0 OR v_required <= 0 THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_outstanding_promo');
  END IF;

  v_wagered := v_wagered + p_wagered;

  IF v_wagered >= v_required THEN
    v_released := v_promo;
    UPDATE club_members
       SET chip_balance               = COALESCE(chip_balance, 0) + v_promo::integer,
           promo_balance              = 0,
           promo_playthrough_required = 0,
           promo_wagered              = 0,
           updated_at                 = NOW()
     WHERE club_id = p_club_id AND user_id = p_user_id;

    INSERT INTO chip_transactions (id, club_id, to_user_id, amount, transaction_type, notes, created_at)
    VALUES (gen_random_uuid(), p_club_id, p_user_id, v_released, 'promo_released',
            'Promo bonus released to cashable balance after playthrough met', NOW());
  ELSE
    UPDATE club_members
       SET promo_wagered = v_wagered, updated_at = NOW()
     WHERE club_id = p_club_id AND user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object('applied', true, 'released', v_released,
                            'wagered', v_wagered, 'required', v_required);
END;
$function$;
